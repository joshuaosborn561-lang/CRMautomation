import { Router, Request, Response } from "express";
import { storeWebhookEvent, addIdentityReviewRow } from "../services/event-store";
import { computeIdentityKey, buildIdentityHint } from "../services/identity";
import { logger } from "../utils/logger";

export const heyreachRouter = Router();

// HeyReach sends webhooks for LinkedIn events:
// - connection_accepted, message_received, reply_received
heyreachRouter.post("/", async (req: Request, res: Response) => {
  try {
    const payload = req.body;
    const eventType =
      payload.event || payload.event_type || payload.webhook_event || "linkedin_event";

    logger.info("Received HeyReach webhook", { eventType });

    const identityKey = computeIdentityKey("heyreach", payload);
    const eventId = await storeWebhookEvent("heyreach", eventType, payload, identityKey);

    if (!identityKey) {
      await addIdentityReviewRow(
        eventId,
        "heyreach_no_linkedin_or_email",
        buildIdentityHint({
          id: eventId,
          source: "heyreach",
          event_type: eventType,
          payload,
          received_at: new Date().toISOString(),
          processed: false,
        })
      );
      return res.status(200).json({ received: true, queued_for_review: true });
    }

    res.status(200).json({ received: true, event_id: eventId });
  } catch (err) {
    logger.error("HeyReach webhook error", { error: String(err) });
    res.status(500).json({ error: "Internal server error" });
  }
});
