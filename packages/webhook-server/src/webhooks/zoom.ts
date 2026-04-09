import { Router, Request, Response } from "express";
import { storeWebhookEvent, addIdentityReviewRow } from "../services/event-store";
import { verifyZoomWebhook, handleZoomChallenge } from "../services/zoom";
import * as zoomService from "../services/zoom";
import * as gmailService from "../services/gmail";
import {
  computeIdentityKey,
  emailKey,
  lookupMeetingLink,
  buildIdentityHint,
} from "../services/identity";
import { logger } from "../utils/logger";

export const zoomRouter = Router();

// Zoom sends webhooks for phone calls, meetings, and recordings.
// All dedup now happens at the DB via identity_key — no in-memory Maps.
zoomRouter.post("/", async (req: Request, res: Response) => {
  try {
    const payload = req.body;

    // Handle Zoom URL validation challenge
    if (payload.event === "endpoint.url_validation") {
      const challenge = handleZoomChallenge(payload.payload.plainToken);
      return res.status(200).json(challenge);
    }

    // Verify webhook signature
    const signature = req.headers["x-zm-signature"] as string;
    const timestamp = req.headers["x-zm-request-timestamp"] as string;

    if (signature && timestamp) {
      const rawBody = JSON.stringify(req.body);
      if (!verifyZoomWebhook(rawBody, timestamp, signature)) {
        logger.warn("Invalid Zoom webhook signature");
        return res.status(401).json({ error: "Invalid signature" });
      }
    }

    const eventType = payload.event || "unknown";
    logger.info("Received Zoom webhook", { eventType });

    const isPhone = eventType.startsWith("phone.");
    const source: "zoom_phone" | "zoom_meeting" = isPhone ? "zoom_phone" : "zoom_meeting";

    // Skip noisy non-actionable meeting events. Only `recording.transcript_completed`
    // carries the data we need for the pipeline.
    if (
      source === "zoom_meeting" &&
      eventType !== "recording.transcript_completed"
    ) {
      logger.info("Skipping non-actionable Zoom meeting event", { eventType });
      return res.status(200).json({ received: true, skipped: true });
    }

    const enrichedPayload: Record<string, unknown> = { ...payload };

    // ============================================================
    // PHONE CALL BRANCH
    // ============================================================
    if (isPhone) {
      const callId =
        payload.payload?.object?.call_id || payload.payload?.object?.id;
      if (callId) {
        const [transcript, callDetails] = await Promise.all([
          zoomService.getPhoneCallTranscript(callId),
          zoomService.getPhoneCallDetails(callId),
        ]);
        if (transcript) enrichedPayload.transcript = transcript;
        if (callDetails) enrichedPayload.call_details = callDetails;
      }

      const identityKey = computeIdentityKey("zoom_phone", enrichedPayload);
      if (!identityKey) {
        const eventId = await storeWebhookEvent("zoom_phone", eventType, enrichedPayload, null);
        await addIdentityReviewRow(
          eventId,
          "zoom_phone_no_external_number",
          buildIdentityHint({
            id: eventId,
            source: "zoom_phone",
            event_type: eventType,
            payload: enrichedPayload,
            received_at: new Date().toISOString(),
            processed: false,
          })
        );
        return res.status(200).json({ received: true, queued_for_review: true });
      }

      const eventId = await storeWebhookEvent("zoom_phone", eventType, enrichedPayload, identityKey);
      return res.status(200).json({ received: true, event_id: eventId });
    }

    // ============================================================
    // MEETING BRANCH (recording.transcript_completed only)
    // ============================================================
    const meetingIdRaw =
      payload.payload?.object?.id || payload.payload?.object?.uuid;
    const meetingId = meetingIdRaw ? String(meetingIdRaw) : null;
    const meetingTopic = (payload.payload?.object?.topic as string | undefined) || null;

    if (!meetingId) {
      logger.warn("Zoom meeting webhook has no meeting id", { eventType });
      return res.status(200).json({ received: true, skipped: "no_meeting_id" });
    }

    // Pull transcript + AI summary
    const [transcript, aiSummary] = await Promise.all([
      zoomService.getMeetingTranscript(meetingId),
      zoomService.getMeetingSummary(meetingId),
    ]);
    if (transcript) enrichedPayload.transcript = transcript;
    if (aiSummary?.summary_url) enrichedPayload.zoom_ai_summary_url = aiSummary.summary_url;
    if (aiSummary?.summary) enrichedPayload.zoom_ai_summary = aiSummary.summary;

    // ---- Identity cascade ----
    let attendeeEmail: string | null = null;
    let resolvedVia: string | null = null;
    let gmailMessageId: string | null = null;

    // 1. meeting_links cache
    const cached = await lookupMeetingLink(meetingId);
    if (cached?.attendee_email) {
      attendeeEmail = cached.attendee_email;
      gmailMessageId = cached.gmail_message_id;
      resolvedVia = "meeting_links_cache";
    }

    // 2. Gmail search — Zoom sends the user a confirmation email whose body
    //    contains the invitee's address. Try a few query variants.
    if (!attendeeEmail) {
      const queries = [
        `from:zoom.us ${meetingId}`,
        `(from:zoom.us OR from:no-reply@zoom.us) ${meetingId}`,
        `from:no-reply@zoom.us ${meetingId}`,
        `"${meetingId}"`,
      ];
      for (const q of queries) {
        if (attendeeEmail) break;
        try {
          const hits = await gmailService.searchMessages(q, 5);
          for (const hit of hits) {
            const email = await gmailService.extractAttendeeEmailFromMessage(hit.id);
            if (email) {
              attendeeEmail = email;
              gmailMessageId = hit.id;
              resolvedVia = `gmail_search:${q}`;
              break;
            }
          }
        } catch (err) {
          logger.warn("Gmail lookup failed", { meetingId, q, error: String(err) });
        }
      }
    }

    // 3. Zoom meeting settings (meeting_invitees)
    if (!attendeeEmail) {
      try {
        const settings = await zoomService.getMeetingSettings(meetingId);
        const ownDomain = (process.env.OWN_EMAIL_DOMAIN || "salesglidergrowth.com").toLowerCase();
        const firstExternal = settings?.invitees.find(
          (i) => i.email && !i.email.toLowerCase().endsWith(`@${ownDomain}`)
        );
        if (firstExternal?.email) {
          attendeeEmail = firstExternal.email.toLowerCase();
          resolvedVia = "zoom_meeting_settings";
        }
      } catch (err) {
        logger.warn("Zoom getMeetingSettings failed", { meetingId, error: String(err) });
      }
    }

    // 3b. Zoom participants fallback. For completed meetings this is often
    // the most reliable source of attendee email when invitees[] is empty.
    if (!attendeeEmail) {
      try {
        const participants = await zoomService.getMeetingParticipants(meetingId);
        const uuid = (payload.payload?.object?.uuid as string | undefined) || "";
        const participantsWithFallback =
          participants.length === 0 && uuid && uuid !== meetingId
            ? await zoomService.getMeetingParticipants(uuid)
            : participants;
        const ownDomain = (process.env.OWN_EMAIL_DOMAIN || "salesglidergrowth.com").toLowerCase();
        const firstExternal = participantsWithFallback.find((p) => {
          const addr = String(p.email || p.user_email || "").toLowerCase();
          return Boolean(
            addr &&
              !addr.endsWith(`@${ownDomain}`) &&
              !addr.endsWith("@zoom.us")
          );
        });
        const participantEmail = String(
          firstExternal?.email || firstExternal?.user_email || ""
        ).toLowerCase();
        if (participantEmail) {
          attendeeEmail = participantEmail;
          resolvedVia = "zoom_participants";
        }
      } catch (err) {
        logger.warn("Zoom getMeetingParticipants failed", { meetingId, error: String(err) });
      }
    }

    // 4. Transcript "my email is" regex
    if (!attendeeEmail && transcript) {
      const ownDomain = (process.env.OWN_EMAIL_DOMAIN || "salesglidergrowth.com").toLowerCase();
      const re = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
      const matches = Array.from(new Set((transcript.match(re) || []).map((e) => e.toLowerCase())));
      const external = matches.find(
        (e) => !e.endsWith(`@${ownDomain}`) && !e.includes("@zoom.us") && !e.includes("calendar-notification@google.com")
      );
      if (external) {
        attendeeEmail = external;
        resolvedVia = "transcript_regex";
      }
    }

    // 5. Fail to review queue
    if (!attendeeEmail) {
      const eventId = await storeWebhookEvent("zoom_meeting", eventType, enrichedPayload, null);
      await addIdentityReviewRow(eventId, "zoom_meeting_no_attendee_email", {
        first_name: meetingTopic || undefined,
      });
      logger.warn("Zoom meeting identity cascade exhausted", { meetingId, meetingTopic });
      return res.status(200).json({ received: true, queued_for_review: true });
    }

    // Stash resolved attendee for downstream consumers
    enrichedPayload.resolved_attendee_email = attendeeEmail;
    enrichedPayload.resolved_via = resolvedVia;
    enrichedPayload.gmail_invite_message_id = gmailMessageId;

    // Populate meeting_links cache for future events on this meeting id
    if (resolvedVia !== "meeting_links_cache") {
      const { upsertMeetingLink } = await import("../services/identity");
      await upsertMeetingLink({
        zoom_meeting_id: meetingId,
        attendee_email: attendeeEmail,
        gmail_message_id: gmailMessageId,
        meeting_topic: meetingTopic,
      });
    }

    const identityKey = emailKey(attendeeEmail);
    const eventId = await storeWebhookEvent("zoom_meeting", eventType, enrichedPayload, identityKey);
    logger.info("Zoom meeting identity resolved", {
      meetingId,
      attendeeEmail,
      resolvedVia,
      identityKey,
    });
    return res.status(200).json({ received: true, event_id: eventId, identity_key: identityKey });
  } catch (err) {
    logger.error("Zoom webhook error", { error: String(err) });
    res.status(500).json({ error: "Internal server error" });
  }
});

