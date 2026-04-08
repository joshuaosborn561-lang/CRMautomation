import { Router, Request, Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { storeWebhookEvent, addIdentityReviewRow } from "../services/event-store";
import * as gmailService from "../services/gmail";
import {
  computeIdentityKey,
  extractZoomMeetingIds,
  upsertMeetingLink,
  extractEmailAddress,
} from "../services/identity";
import { getConfig } from "../config";
import { getSupabase } from "../utils/supabase";
import { logger } from "../utils/logger";

export const gmailRouter = Router();

// Sender patterns that are never sales leads
const SKIP_SENDERS = [
  "noreply", "no-reply", "donotreply", "do-not-reply",
  "notifications", "mailer-daemon", "newsletter", "digest",
  "calendar-notification", "support@", "billing@", "info@",
  "team@", "hello@", "admin@", "ops@", "feedback@",
  "@linkedin.com", "@google.com", "@zoom.us", "@slack",
  "@stripe.com", "@github.com", "@notion.so", "@railway.app",
  "@vercel.com", "@supabase", "@calendly.com", "@hubspot",
  "@mailchimp", "@sendgrid", "@intercom", "@zendesk",
  "@atlassian", "@jira", "@confluence", "@asana",
  "@trello.com", "@figma.com", "@loom.com", "@dropbox.com",
  "@amazonses.com", "@aws.amazon.com", "@shopify.com",
];

function isAutomatedSender(fromLower: string): boolean {
  return SKIP_SENDERS.some((p) => fromLower.includes(p));
}

/**
 * Quick Claude classification: is this email a sales lead/prospect,
 * or is it a vendor/tool/personal/junk email?
 * Returns true only for sales-relevant emails.
 */
async function isLeadEmail(
  from: string,
  to: string,
  subject: string,
  snippet: string
): Promise<boolean> {
  try {
    const config = getConfig();
    const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 10,
      messages: [
        {
          role: "user",
          content: `You are a filter for a B2B outbound sales agency founder's inbox. Classify this email as either LEAD (from/about a real sales prospect, client, or someone relevant to a deal) or SKIP (vendor, SaaS tool, newsletter, personal, internal, automated, or anything not sales-related).

From: ${from}
To: ${to}
Subject: ${subject}
Preview: ${snippet.substring(0, 300)}

Reply with ONLY "LEAD" or "SKIP".`,
        },
      ],
    });

    const text = response.content[0].type === "text" ? response.content[0].text.trim().toUpperCase() : "SKIP";
    const isLead = text.includes("LEAD");

    logger.info("Gmail AI filter", { from, subject: subject.substring(0, 50), result: isLead ? "LEAD" : "SKIP" });
    return isLead;
  } catch (err) {
    // If AI fails, let it through to be safe — review mode will catch it
    logger.warn("Gmail AI filter failed, allowing through", { error: String(err) });
    return true;
  }
}

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

    let stored = 0;
    let skipped = 0;

    for (const change of changes) {
      if (change.action === "added") {
        // Fetch the full message
        const message = await gmailService.getMessage(change.messageId);

        // --- Opportunistically populate meeting_links cache ---
        // If the body contains a zoom.us/j/{id} URL, record the
        // meeting id → attendee email mapping for future Zoom webhooks.
        try {
          const zoomIds = extractZoomMeetingIds(
            `${message.body || ""} ${message.subject || ""}`
          );
          if (zoomIds.length > 0) {
            const ownDomain = (process.env.OWN_EMAIL_DOMAIN || "salesglidergrowth.com").toLowerCase();
            const fromAddr = extractEmailAddress(message.from)?.toLowerCase() || "";
            const toAddr = extractEmailAddress(message.to)?.toLowerCase() || "";
            const fromIsOwn = fromAddr.endsWith(`@${ownDomain}`);
            const attendee = fromIsOwn ? toAddr : fromAddr;
            if (attendee && !attendee.endsWith(`@${ownDomain}`)) {
              for (const zid of zoomIds) {
                await upsertMeetingLink({
                  zoom_meeting_id: zid,
                  attendee_email: attendee,
                  gmail_message_id: message.id,
                  meeting_topic: message.subject,
                });
              }
              logger.info("Gmail: cached meeting_links from body", {
                zoomIds,
                attendee,
              });
            }
          }
        } catch (err) {
          logger.warn("meeting_links cache population failed", { error: String(err) });
        }

        // --- FILTER LAYER 1: Skip known automated senders ---
        const fromLower = (message.from || "").toLowerCase();
        if (isAutomatedSender(fromLower)) {
          logger.info("Gmail: skipped automated sender", { from: message.from });
          skipped++;
          continue;
        }

        // Skip emails from yourself
        const config = getConfig();
        if (
          config.GMAIL_USER_EMAIL &&
          fromLower.includes(config.GMAIL_USER_EMAIL.toLowerCase())
        ) {
          skipped++;
          continue;
        }

        // --- FILTER LAYER 2: Claude AI classification ---
        const isLead = await isLeadEmail(
          message.from,
          message.to,
          message.subject,
          message.snippet || message.body?.substring(0, 300) || ""
        );

        if (!isLead) {
          skipped++;
          continue;
        }

        // --- Only store sales-relevant emails ---
        const gmailPayload: Record<string, unknown> = {
          message_id: message.id,
          thread_id: message.threadId,
          from: message.from,
          to: message.to,
          subject: message.subject,
          date: message.date,
          body: message.body?.substring(0, 5000) || "",
          snippet: message.snippet,
        };
        const identityKey = computeIdentityKey("gmail", gmailPayload);
        const eventId = await storeWebhookEvent(
          "gmail",
          "email_received",
          gmailPayload,
          identityKey
        );
        if (!identityKey) {
          await addIdentityReviewRow(eventId, "gmail_no_counterparty_email", {
            email: message.from,
          });
        }
        stored++;
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

    logger.info("Gmail sync complete", { stored, skipped, total: changes.length });

    res.status(200).json({ received: true, stored, skipped });
  } catch (err) {
    logger.error("Gmail webhook error", { error: String(err) });
    // Always return 200 to Pub/Sub to prevent retries on our errors
    res.status(200).json({ error: "Processing error" });
  }
});
