import { Router, Request, Response } from "express";
import { storeWebhookEvent } from "../services/event-store";
import { logger } from "../utils/logger";

export const heyreachRouter = Router();

// HeyReach sends webhooks for LinkedIn events:
// - connection_accepted: prospect accepted connection request
// - message_received: prospect sent a LinkedIn message
// - reply_received: prospect replied to a message
heyreachRouter.post("/", async (req: Request, res: Response) => {
  try {
    const payload = req.body;
    const eventType =
      payload.event || payload.event_type || payload.webhook_event || "linkedin_event";

    logger.info("Received HeyReach webhook", { eventType });

    const eventId = await storeWebhookEvent("heyreach", eventType, payload);

    res.status(200).json({ received: true, event_id: eventId });
  } catch (err) {
    logger.error("HeyReach webhook error", { error: String(err) });
    res.status(500).json({ error: "Internal server error" });
  }
});
