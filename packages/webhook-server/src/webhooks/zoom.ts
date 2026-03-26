import { Router, Request, Response } from "express";
import { storeWebhookEvent } from "../services/event-store";
import { verifyZoomWebhook, handleZoomChallenge } from "../services/zoom";
import * as zoomService from "../services/zoom";
import { logger } from "../utils/logger";

export const zoomRouter = Router();

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
