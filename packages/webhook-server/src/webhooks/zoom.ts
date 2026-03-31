import { Router, Request, Response } from "express";
import { storeWebhookEvent } from "../services/event-store";
import { verifyZoomWebhook, handleZoomChallenge } from "../services/zoom";
import * as zoomService from "../services/zoom";
import { findContactByPhone } from "../services/apollo";
import { getSupabase } from "../utils/supabase";
import { logger } from "../utils/logger";

export const zoomRouter = Router();

// In-memory dedup for Zoom scheduler notifications.
// Key = meeting ID, value = timestamp of first notification.
// Entries expire after 5 minutes.
const recentMeetingEvents = new Map<string, number>();
const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

function isDuplicateMeetingEvent(meetingId: string, eventType: string): boolean {
  const key = `${meetingId}:${eventType}`;
  const now = Date.now();

  // Prune stale entries
  for (const [k, ts] of recentMeetingEvents) {
    if (now - ts > DEDUP_WINDOW_MS) recentMeetingEvents.delete(k);
  }

  if (recentMeetingEvents.has(key)) {
    logger.info("Duplicate Zoom meeting event suppressed", { meetingId, eventType });
    return true;
  }

  recentMeetingEvents.set(key, now);
  return false;
}

/**
 * Also check Supabase for persistent dedup — in case the server restarted
 * between duplicate notifications.
 */
async function isDuplicateInDb(meetingId: string, eventType: string): Promise<boolean> {
  try {
    const supabase = getSupabase();
    const fiveMinAgo = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString();

    const { data } = await supabase
      .from("webhook_events")
      .select("id")
      .eq("source", "zoom_meeting")
      .eq("event_type", eventType)
      .gte("received_at", fiveMinAgo)
      .limit(10);

    // Check if any existing event has the same meeting ID in payload
    if (data && data.length > 0) {
      // Quick check — if we already stored one for this event type recently, it's a dup
      // We do a more precise check by looking at the payload
      const { data: matchingEvents } = await supabase
        .from("webhook_events")
        .select("id, payload")
        .eq("source", "zoom_meeting")
        .eq("event_type", eventType)
        .gte("received_at", fiveMinAgo);

      if (matchingEvents) {
        for (const evt of matchingEvents) {
          const p = evt.payload as Record<string, unknown>;
          const obj = (p?.payload as Record<string, unknown>)?.object as Record<string, unknown>;
          if (obj && String(obj.id) === String(meetingId)) {
            logger.info("Duplicate Zoom meeting event found in DB", { meetingId, eventType });
            return true;
          }
        }
      }
    }
    return false;
  } catch (err) {
    logger.warn("Dedup DB check failed, proceeding", { error: String(err) });
    return false;
  }
}

// Zoom sends webhooks for phone calls, meetings, and recordings
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

    // Determine if this is a phone or meeting event
    let source: "zoom_phone" | "zoom_meeting" = "zoom_meeting";
    if (eventType.startsWith("phone.")) {
      source = "zoom_phone";
    }

    // --- DEDUP: Suppress duplicate Zoom scheduler / meeting notifications ---
    if (source === "zoom_meeting") {
      const meetingId =
        payload.payload?.object?.id || payload.payload?.object?.uuid;
      if (meetingId) {
        // In-memory dedup first (fast)
        if (isDuplicateMeetingEvent(String(meetingId), eventType)) {
          return res.status(200).json({ received: true, deduplicated: true });
        }
        // DB dedup as backup (covers server restarts)
        if (await isDuplicateInDb(String(meetingId), eventType)) {
          return res.status(200).json({ received: true, deduplicated: true });
        }
      }
    }

    // For call/meeting ended events, try to fetch the transcript
    const enrichedPayload = { ...payload };

    if (
      eventType === "phone.callee_ended" ||
      eventType === "phone.caller_ended" ||
      eventType === "phone.call_end"
    ) {
      const callId =
        payload.payload?.object?.call_id || payload.payload?.object?.id;
      if (callId) {
        // Fetch transcript and call details in parallel
        const [transcript, callDetails] = await Promise.all([
          zoomService.getPhoneCallTranscript(callId),
          zoomService.getPhoneCallDetails(callId),
        ]);
        if (transcript) enrichedPayload.transcript = transcript;
        if (callDetails) enrichedPayload.call_details = callDetails;

        // --- APOLLO LOOKUP: Match phone number to lead ---
        const externalNumber = getExternalPhoneNumber(callDetails, payload);
        if (externalNumber) {
          const apolloContact = await findContactByPhone(externalNumber);
          if (apolloContact) {
            enrichedPayload.apollo_contact = {
              email: apolloContact.email,
              first_name: apolloContact.first_name,
              last_name: apolloContact.last_name,
              name: apolloContact.name,
              company: apolloContact.organization_name,
              title: apolloContact.title,
              linkedin_url: apolloContact.linkedin_url,
              phone: externalNumber,
            };
            logger.info("Enriched Zoom phone call with Apollo data", {
              callId,
              phone: externalNumber,
              name: apolloContact.name,
              email: apolloContact.email,
            });
          }
        }
      }
    }

    if (
      eventType === "meeting.ended" ||
      eventType === "recording.completed"
    ) {
      const meetingId =
        payload.payload?.object?.id || payload.payload?.object?.uuid;
      if (meetingId) {
        const transcript = await zoomService.getMeetingTranscript(
          String(meetingId)
        );
        if (transcript) enrichedPayload.transcript = transcript;
      }
    }

    const eventId = await storeWebhookEvent(source, eventType, enrichedPayload);

    res.status(200).json({ received: true, event_id: eventId });
  } catch (err) {
    logger.error("Zoom webhook error", { error: String(err) });
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Determine the external (non-you) phone number from a call.
 * For outbound calls, it's the callee. For inbound, it's the caller.
 */
function getExternalPhoneNumber(
  callDetails: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown>
): string | null {
  const details = callDetails || {};
  const obj = (payload.payload as Record<string, unknown>)?.object as Record<string, unknown> | undefined;

  const direction = (details.direction || obj?.direction || "") as string;
  const callerNumber = (details.caller_number || obj?.caller_number || "") as string;
  const calleeNumber = (details.callee_number || obj?.callee_number || "") as string;

  if (direction === "outbound") {
    return calleeNumber || null;
  } else if (direction === "inbound") {
    return callerNumber || null;
  }

  // If direction unknown, return whichever number looks like an external number
  // (not a Zoom extension — extensions are usually short)
  if (calleeNumber && calleeNumber.length > 6) return calleeNumber;
  if (callerNumber && callerNumber.length > 6) return callerNumber;

  return null;
}
