import { Router, Request, Response } from "express";
import { storeWebhookEvent } from "../services/event-store";
import { verifyZoomWebhook, handleZoomChallenge } from "../services/zoom";
import * as zoomService from "../services/zoom";
import { enrichContact } from "../services/leadmagic";
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

        // --- LEADMAGIC ENRICHMENT: Match phone number to lead ---
        const externalNumber = getExternalPhoneNumber(callDetails, payload);
        const externalName = getExternalCallerName(callDetails, payload);
        if (externalNumber || externalName) {
          // Use whatever we have from Zoom to enrich via LeadMagic
          const enriched = await enrichContact({
            phone: externalNumber || undefined,
            first_name: externalName ? externalName.split(" ")[0] : undefined,
            last_name: externalName ? externalName.split(" ").slice(1).join(" ") : undefined,
          });
          if (enriched.enriched) {
            enrichedPayload.enriched_contact = {
              email: enriched.email,
              first_name: enriched.first_name,
              last_name: enriched.last_name,
              company: enriched.company,
              title: enriched.title,
              linkedin_url: enriched.linkedin_url,
              phone: externalNumber,
              industry: enriched.industry,
              company_size: enriched.company_size,
            };
            logger.info("Enriched Zoom phone call with LeadMagic data", {
              callId,
              phone: externalNumber,
              name: `${enriched.first_name} ${enriched.last_name}`,
              email: enriched.email,
              company: enriched.company,
            });
          }
        }
      }
    }

    if (
      eventType === "meeting.ended" ||
      eventType === "recording.completed" ||
      eventType === "recording.transcript_completed"
    ) {
      const meetingId =
        payload.payload?.object?.id || payload.payload?.object?.uuid;
      if (meetingId) {
        // Fetch transcript and AI summary in parallel
        const [transcript, aiSummary] = await Promise.all([
          zoomService.getMeetingTranscript(String(meetingId)),
          zoomService.getMeetingSummary(String(meetingId)),
        ]);
        if (transcript) enrichedPayload.transcript = transcript;
        if (aiSummary?.summary_url) enrichedPayload.zoom_ai_summary_url = aiSummary.summary_url;
        if (aiSummary?.summary) enrichedPayload.zoom_ai_summary = aiSummary.summary;
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
 * Determine the external (non-you) phone number and name from a call.
 * Uses extension_type to distinguish internal users from external PSTN callers.
 * Zoom payload structure: object.caller = { phone_number, name, extension_type }
 */
function getExternalPhoneNumber(
  callDetails: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown>
): string | null {
  const obj = (payload.payload as Record<string, unknown>)?.object as Record<string, unknown> | undefined;
  const caller = obj?.caller as Record<string, unknown> | undefined;
  const callee = obj?.callee as Record<string, unknown> | undefined;

  // First try call details from Zoom API (flat structure)
  if (callDetails) {
    const direction = (callDetails.direction || "") as string;
    const callerNumber = (callDetails.caller_number || "") as string;
    const calleeNumber = (callDetails.callee_number || "") as string;
    if (direction === "outbound" && calleeNumber) return calleeNumber;
    if (direction === "inbound" && callerNumber) return callerNumber;
  }

  // Then use webhook payload (nested structure: caller/callee objects)
  // External party has extension_type "pstn", internal has "user"
  if (callee?.extension_type === "pstn" && callee?.phone_number) {
    return callee.phone_number as string;
  }
  if (caller?.extension_type === "pstn" && caller?.phone_number) {
    return caller.phone_number as string;
  }

  // Fallback: return whichever has a real phone number (10+ digits)
  const calleeNum = (callee?.phone_number || "") as string;
  const callerNum = (caller?.phone_number || "") as string;
  if (calleeNum.length > 6) return calleeNum;
  if (callerNum.length > 6) return callerNum;

  return null;
}

/**
 * Get the external party's name from the call.
 */
function getExternalCallerName(
  callDetails: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown>
): string {
  const obj = (payload.payload as Record<string, unknown>)?.object as Record<string, unknown> | undefined;
  const caller = obj?.caller as Record<string, unknown> | undefined;
  const callee = obj?.callee as Record<string, unknown> | undefined;

  if (callDetails) {
    const direction = (callDetails.direction || "") as string;
    if (direction === "outbound") return (callDetails.callee_name || "") as string;
    if (direction === "inbound") return (callDetails.caller_name || "") as string;
  }

  // External party has extension_type "pstn"
  if (callee?.extension_type === "pstn" && callee?.name) return callee.name as string;
  if (caller?.extension_type === "pstn" && caller?.name) return caller.name as string;

  return "";
}
