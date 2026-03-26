import { Router, Request, Response } from "express";
import { storeWebhookEvent } from "../services/event-store";
import * as gmailService from "../services/gmail";
import { getSupabase } from "../utils/supabase";
import { logger } from "../utils/logger";

export const gmailRouter = Router();

// Google Pub/Sub sends push notifications here when new emails arrive.
// The payload is a base64-encoded JSON with the user's email and historyId.
gmailRouter.post("/", async (req: Request, res: Response) => {
  try {
    const pubsubMessage = req.body?.message;
    if (!pubsubMessage?.data) {
      return res.status(400).json({ error: "Invalid Pub/Sub message" });
    }

    // Decode the Pub/Sub payload
    const decoded = JSON.parse(
      Buffer.from(pubsubMessage.data, "base64").toString("utf-8")
    ) as { emailAddress: string; historyId: string };

    logger.info("Received Gmail push notification", {
      email: decoded.emailAddress,
      historyId: decoded.historyId,
    });

    // Get our last known historyId from Supabase
    const supabase = getSupabase();
    const { data: stateRow } = await supabase
      .from("gmail_sync_state")
      .select("history_id")
      .eq("email", decoded.emailAddress)
      .single();

    const lastHistoryId = stateRow?.history_id || decoded.historyId;

    // Fetch what changed since our last sync
    const changes = await gmailService.getHistoryChanges(lastHistoryId);

    for (const change of changes) {
      if (change.action === "added") {
        // Fetch the full message
        const message = await gmailService.getMessage(change.messageId);

        // Store as a webhook event for AI processing
        await storeWebhookEvent("gmail", "email_received", {
          message_id: message.id,
          thread_id: message.threadId,
          from: message.from,
          to: message.to,
          subject: message.subject,
          date: message.date,
          body: message.body.substring(0, 5000), // Cap body size
          snippet: message.snippet,
        });
      }
    }

    // Update our sync state
    await supabase
      .from("gmail_sync_state")
      .upsert({
        email: decoded.emailAddress,
        history_id: decoded.historyId,
        updated_at: new Date().toISOString(),
      });

    res.status(200).json({ received: true, processed: changes.length });
  } catch (err) {
    logger.error("Gmail webhook error", { error: String(err) });
    // Always return 200 to Pub/Sub to prevent retries on our errors
    res.status(200).json({ error: "Processing error" });
  }
});
