import { Router, Request, Response } from "express";
import { storeWebhookEvent } from "../services/event-store";
import { logger } from "../utils/logger";

export const smartleadRouter = Router();

// SmartLead sends webhooks when leads reply, open emails, click links, etc.
// We care most about replies (positive signals).
smartleadRouter.post("/", async (req: Request, res: Response) => {
  try {
    const payload = req.body;
    const eventType = payload.event || payload.event_type || "reply";

    logger.info("Received SmartLead webhook", { eventType });

    // Store raw event for processing
    const eventId = await storeWebhookEvent("smartlead", eventType, payload);

    res.status(200).json({ received: true, event_id: eventId });
  } catch (err) {
    logger.error("SmartLead webhook error", { error: String(err) });
    res.status(500).json({ error: "Internal server error" });
  }
});
