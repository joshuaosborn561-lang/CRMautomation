import { Router, Request, Response } from "express";
import { storeWebhookEvent, addIdentityReviewRow } from "../services/event-store";
import { computeIdentityKey, buildIdentityHint } from "../services/identity";
import { logger } from "../utils/logger";

export const smartleadRouter = Router();

// SmartLead sends webhooks when leads reply, open emails, click links, etc.
smartleadRouter.post("/", async (req: Request, res: Response) => {
  try {
    const payload = req.body;
    const eventType = payload.event || payload.event_type || "reply";

    logger.info("Received SmartLead webhook", { eventType });

    const identityKey = computeIdentityKey("smartlead", payload);
    const eventId = await storeWebhookEvent("smartlead", eventType, payload, identityKey);

    if (!identityKey) {
      await addIdentityReviewRow(
        eventId,
        "smartlead_no_email",
        buildIdentityHint({
          id: eventId,
          source: "smartlead",
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
    logger.error("SmartLead webhook error", { error: String(err) });
    res.status(500).json({ error: "Internal server error" });
  }
});
