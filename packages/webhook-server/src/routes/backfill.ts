import { Router, Request, Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { storeWebhookEvent } from "../services/event-store";
import * as gmailService from "../services/gmail";
import * as zoomService from "../services/zoom";
import { getConfig } from "../config";
import { logger } from "../utils/logger";
import { getSupabase } from "../utils/supabase";

export const backfillRouter = Router();

// DELETE /api/backfill/clear - Purge all backfill events from queues
// Also clears old events that used "email_received" (before _backfill tagging was added)
// Supports ?pending_only=true to only clear pending review queue items
backfillRouter.delete("/clear", async (_req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    const pendingOnly = _req.query.pending_only === "true";

    // Find backfill events by: event_type contains "_backfill" OR payload has backfill:true
    const { data: taggedEvents } = await supabase
      .from("webhook_events")
      .select("id")
      .like("event_type", "%_backfill");

    // Also find events where payload contains backfill flag (old-style events)
    const { data: flaggedEvents } = await supabase
      .from("webhook_events")
      .select("id")
      .contains("payload", { backfill: true });

    // Merge and deduplicate
    const allIds = new Set<string>();
    for (const e of taggedEvents || []) allIds.add(e.id);
    for (const e of flaggedEvents || []) allIds.add(e.id);
    const backfillEventIds = Array.from(allIds);

    let reviewsDeleted = 0;
    let eventsDeleted = 0;
    let interactionsDeleted = 0;

    if (backfillEventIds.length > 0) {
      // Delete review queue items linked to backfill events
      // Supabase .in() has a limit, so batch in chunks of 200
      for (let i = 0; i < backfillEventIds.length; i += 200) {
        const chunk = backfillEventIds.slice(i, i + 200);

        let reviewQuery = supabase
          .from("review_queue")
          .delete({ count: "exact" })
          .in("event_id", chunk);
        if (pendingOnly) reviewQuery = reviewQuery.eq("status", "pending");
        const { count: rc } = await reviewQuery;
        reviewsDeleted += rc || 0;

        const { count: ic } = await supabase
          .from("interaction_log")
          .delete({ count: "exact" })
          .in("event_id", chunk);
        interactionsDeleted += ic || 0;

        const { count: ec } = await supabase
          .from("webhook_events")
          .delete({ count: "exact" })
          .in("id", chunk);
        eventsDeleted += ec || 0;
      }
    }

    // Fallback: also clear any pending review queue items from gmail source
    // that don't have a matching backfill event (covers edge cases)
    if (!pendingOnly) {
      const { count: extraReviews } = await supabase
        .from("review_queue")
        .delete({ count: "exact" })
        .eq("source", "gmail")
        .eq("status", "pending");
      reviewsDeleted += extraReviews || 0;
    }

    logger.info("Backfill cleared", { reviewsDeleted, eventsDeleted, interactionsDeleted });

    res.json({
      status: "cleared",
      backfill_events_found: backfillEventIds.length,
      reviews_deleted: reviewsDeleted,
      events_deleted: eventsDeleted,
      interactions_deleted: interactionsDeleted,
    });
  } catch (err) {
    logger.error("Failed to clear backfill", { error: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/backfill/gmail - Pull recent Gmail emails and feed them into the pipeline
// Body: { days?: number, max_results?: number, query?: string }
backfillRouter.post("/gmail", async (req: Request, res: Response) => {
  try {
    const days = req.body.days || 30;
    const maxResults = req.body.max_results || 100;
    const customQuery = req.body.query || "";

    const afterDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const afterEpoch = Math.floor(afterDate.getTime() / 1000);

    // Search for emails — exclude newsletters, notifications, etc.
    const query = customQuery || `after:${afterEpoch} -category:promotions -category:social -category:updates -category:forums`;

    logger.info("Starting Gmail backfill", { days, maxResults, query });

    const messages = await listGmailMessages(query, maxResults);

    let processed = 0;
    let skipped = 0;
    const errors: string[] = [];

    // Batch emails and use Claude to pre-filter for sales relevance
    const emailBatch: Array<{ msgRef: { id: string; threadId: string }; message: any }> = [];

    for (const msgRef of messages) {
      try {
        const message = await gmailService.getMessage(msgRef.id);

        // Skip emails from yourself / automated senders
        if (isAutomatedSender(message.from.toLowerCase())) {
          skipped++;
          continue;
        }

        emailBatch.push({ msgRef, message });

        // Rate limit Gmail reads
        if (emailBatch.length % 10 === 0) {
          await new Promise((r) => setTimeout(r, 500));
        }
      } catch (err) {
        errors.push(`${msgRef.id}: ${String(err)}`);
      }
    }

    logger.info("Gmail backfill: fetched emails, now filtering with AI", {
      total: messages.length,
      afterSkip: emailBatch.length,
      skipped,
    });

    // Use Claude to classify emails in batches of 10
    const BATCH_SIZE = 10;
    for (let i = 0; i < emailBatch.length; i += BATCH_SIZE) {
      const batch = emailBatch.slice(i, i + BATCH_SIZE);

      try {
        const salesRelevant = await classifyEmailBatch(batch.map((b) => ({
          id: b.msgRef.id,
          from: b.message.from,
          to: b.message.to,
          subject: b.message.subject,
          snippet: b.message.snippet || b.message.body?.substring(0, 300) || "",
        })));

        for (const item of batch) {
          if (salesRelevant.has(item.msgRef.id)) {
            await storeWebhookEvent("gmail", "email_received_backfill", {
              message_id: item.message.id,
              thread_id: item.message.threadId,
              from: item.message.from,
              to: item.message.to,
              subject: item.message.subject,
              date: item.message.date,
              body: item.message.body?.substring(0, 5000) || "",
              snippet: item.message.snippet,
              backfill: true,
            });
            processed++;
          } else {
            skipped++;
          }
        }
      } catch (err) {
        // If AI classification fails, skip the whole batch rather than flooding queue
        logger.warn("AI classification failed for batch, skipping", { error: String(err) });
        skipped += batch.length;
      }

      // Rate limit between batches
      if (i + BATCH_SIZE < emailBatch.length) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    logger.info("Gmail backfill complete", { processed, skipped, errors: errors.length });

    res.json({
      status: "done",
      total_found: messages.length,
      processed,
      skipped,
      errors: errors.length,
      error_details: errors.slice(0, 10),
      note: "Events are now in the queue. They will be processed by the AI pipeline every 30 seconds and appear in the Review Queue.",
    });
  } catch (err) {
    logger.error("Gmail backfill failed", { error: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/backfill/zoom - Pull recent Zoom meeting recordings and feed them into the pipeline
// Body: { days?: number }
backfillRouter.post("/zoom", async (req: Request, res: Response) => {
  try {
    const days = req.body.days || 30;

    const fromDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const fromStr = fromDate.toISOString().split("T")[0]; // YYYY-MM-DD
    const toStr = new Date().toISOString().split("T")[0];

    logger.info("Starting Zoom backfill", { days, from: fromStr, to: toStr });

    const meetings = await listZoomRecordings(fromStr, toStr);

    let processed = 0;
    const errors: string[] = [];

    for (const meeting of meetings) {
      try {
        // Try to get the transcript
        let transcript: string | null = null;
        if (meeting.id) {
          transcript = await zoomService.getMeetingTranscript(String(meeting.id));
        }

        await storeWebhookEvent("zoom_meeting", "meeting.ended_backfill", {
          payload: {
            object: {
              id: meeting.id,
              uuid: meeting.uuid,
              topic: meeting.topic,
              host_email: meeting.host_email,
              start_time: meeting.start_time,
              duration: meeting.duration,
              participants: meeting.participants || [],
            },
          },
          transcript: transcript || undefined,
          backfill: true,
        });

        processed++;

        // Rate limit
        if (processed % 5 === 0) {
          await new Promise((r) => setTimeout(r, 2000));
        }
      } catch (err) {
        errors.push(`${meeting.topic || meeting.id}: ${String(err)}`);
      }
    }

    logger.info("Zoom backfill complete", { processed, errors: errors.length });

    res.json({
      status: "done",
      total_found: meetings.length,
      processed,
      errors: errors.length,
      error_details: errors.slice(0, 10),
      note: "Events are now in the queue. They will be processed by the AI pipeline every 30 seconds and appear in the Review Queue.",
    });
  } catch (err) {
    logger.error("Zoom backfill failed", { error: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/backfill/all - Run both Gmail and Zoom backfill
backfillRouter.post("/all", async (req: Request, res: Response) => {
  try {
    const days = req.body.days || 30;

    logger.info("Starting full backfill", { days });

    // Run both sequentially to avoid rate limits
    const gmailResult = await runGmailBackfill(days, 100);
    const zoomResult = await runZoomBackfill(days);

    res.json({
      status: "done",
      gmail: gmailResult,
      zoom: zoomResult,
      note: "All events are now in the queue. They will be processed by the AI pipeline every 30 seconds and appear in the Review Queue.",
    });
  } catch (err) {
    logger.error("Full backfill failed", { error: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

// --- Helper: List Gmail messages ---

async function listGmailMessages(
  query: string,
  maxResults: number
): Promise<Array<{ id: string; threadId: string }>> {
  // We need to use the Gmail API directly since our service doesn't have a list method
  const config = (await import("../config")).getConfig();

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.GOOGLE_CLIENT_ID,
      client_secret: config.GOOGLE_CLIENT_SECRET,
      refresh_token: config.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });

  const tokenData = (await tokenResponse.json()) as { access_token: string };
  const userId = config.GMAIL_USER_EMAIL || "me";

  const allMessages: Array<{ id: string; threadId: string }> = [];
  let pageToken: string | undefined;

  while (allMessages.length < maxResults) {
    const params = new URLSearchParams({
      q: query,
      maxResults: String(Math.min(50, maxResults - allMessages.length)),
    });
    if (pageToken) params.set("pageToken", pageToken);

    const response = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/${userId}/messages?${params}`,
      {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      }
    );

    if (!response.ok) break;

    const data = (await response.json()) as {
      messages?: Array<{ id: string; threadId: string }>;
      nextPageToken?: string;
    };

    if (!data.messages || data.messages.length === 0) break;

    allMessages.push(...data.messages);
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }

  return allMessages;
}

// --- Helper: List Zoom recordings ---

async function listZoomRecordings(
  from: string,
  to: string
): Promise<
  Array<{
    id: number;
    uuid: string;
    topic: string;
    host_email: string;
    start_time: string;
    duration: number;
    participants?: Array<{ email: string; name: string }>;
  }>
> {
  const config = (await import("../config")).getConfig();

  const credentials = Buffer.from(
    `${config.ZOOM_CLIENT_ID}:${config.ZOOM_CLIENT_SECRET}`
  ).toString("base64");

  const tokenResponse = await fetch("https://zoom.us/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "account_credentials",
      account_id: config.ZOOM_ACCOUNT_ID,
    }),
  });

  const tokenData = (await tokenResponse.json()) as { access_token: string };

  // Get all recordings in the date range
  const response = await fetch(
    `https://api.zoom.us/v2/users/me/recordings?from=${from}&to=${to}&page_size=100`,
    {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Zoom API error: ${response.status} ${body}`);
  }

  const data = (await response.json()) as {
    meetings: Array<{
      id: number;
      uuid: string;
      topic: string;
      host_email: string;
      start_time: string;
      duration: number;
    }>;
  };

  return data.meetings || [];
}

// --- Internal helpers for /all endpoint ---

async function runGmailBackfill(days: number, maxResults: number) {
  const afterDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const afterEpoch = Math.floor(afterDate.getTime() / 1000);
  const query = `after:${afterEpoch} -category:promotions -category:social -category:updates -category:forums`;

  const messages = await listGmailMessages(query, maxResults);
  let processed = 0;
  let skipped = 0;

  // Fetch all messages and apply sender filter
  const emailBatch: Array<{ msgRef: { id: string; threadId: string }; message: any }> = [];
  for (const msgRef of messages) {
    try {
      const message = await gmailService.getMessage(msgRef.id);
      const fromLower = message.from.toLowerCase();
      if (isAutomatedSender(fromLower)) {
        skipped++;
        continue;
      }
      emailBatch.push({ msgRef, message });
      if (emailBatch.length % 10 === 0) await new Promise((r) => setTimeout(r, 500));
    } catch {
      // skip
    }
  }

  // AI classify in batches
  const BATCH_SIZE = 10;
  for (let i = 0; i < emailBatch.length; i += BATCH_SIZE) {
    const batch = emailBatch.slice(i, i + BATCH_SIZE);
    try {
      const salesRelevant = await classifyEmailBatch(batch.map((b) => ({
        id: b.msgRef.id,
        from: b.message.from,
        to: b.message.to,
        subject: b.message.subject,
        snippet: b.message.snippet || b.message.body?.substring(0, 300) || "",
      })));

      for (const item of batch) {
        if (salesRelevant.has(item.msgRef.id)) {
          await storeWebhookEvent("gmail", "email_received_backfill", {
            message_id: item.message.id,
            thread_id: item.message.threadId,
            from: item.message.from,
            to: item.message.to,
            subject: item.message.subject,
            date: item.message.date,
            body: item.message.body?.substring(0, 5000) || "",
            snippet: item.message.snippet,
            backfill: true,
          });
          processed++;
        } else {
          skipped++;
        }
      }
    } catch {
      skipped += batch.length;
    }
    if (i + BATCH_SIZE < emailBatch.length) await new Promise((r) => setTimeout(r, 1000));
  }

  return { total_found: messages.length, processed, skipped };
}

async function runZoomBackfill(days: number) {
  const fromDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const fromStr = fromDate.toISOString().split("T")[0];
  const toStr = new Date().toISOString().split("T")[0];

  const meetings = await listZoomRecordings(fromStr, toStr);
  let processed = 0;

  for (const meeting of meetings) {
    try {
      let transcript: string | null = null;
      if (meeting.id) {
        transcript = await zoomService.getMeetingTranscript(String(meeting.id));
      }

      await storeWebhookEvent("zoom_meeting", "meeting.ended_backfill", {
        payload: {
          object: {
            id: meeting.id,
            uuid: meeting.uuid,
            topic: meeting.topic,
            host_email: meeting.host_email,
            start_time: meeting.start_time,
            duration: meeting.duration,
          },
        },
        transcript: transcript || undefined,
        backfill: true,
      });
      processed++;

      if (processed % 5 === 0) await new Promise((r) => setTimeout(r, 2000));
    } catch {
      // skip individual errors
    }
  }

  return { total_found: meetings.length, processed };
}

// --- Sender skip list ---

function isAutomatedSender(fromLower: string): boolean {
  const skipPatterns = [
    "joshuaosborn561", "joshua@jmosolutions",
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
  return skipPatterns.some((p) => fromLower.includes(p));
}

// --- Claude AI email classifier ---

async function classifyEmailBatch(
  emails: Array<{ id: string; from: string; to: string; subject: string; snippet: string }>
): Promise<Set<string>> {
  const config = getConfig();
  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

  const emailList = emails
    .map(
      (e, i) =>
        `[${i + 1}] ID: ${e.id}\n  From: ${e.from}\n  To: ${e.to}\n  Subject: ${e.subject}\n  Preview: ${e.snippet.substring(0, 200)}`
    )
    .join("\n\n");

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 500,
    messages: [
      {
        role: "user",
        content: `You are filtering emails for a B2B outbound sales agency founder's CRM. Only keep emails that are SALES-RELEVANT — meaning they are from or about a real prospect, lead, or client discussing business, meetings, proposals, interest, or deals.

REJECT emails that are:
- SaaS product notifications, billing, receipts
- Internal team/tool notifications
- Marketing newsletters or promotional content
- Automated alerts, CI/CD, deployment notices
- Personal/social emails unrelated to sales
- Vendor/service provider communications (unless they are a prospect)
- Calendar invites from tools (not from a real person scheduling a sales meeting)

Here are the emails. Return ONLY the IDs of sales-relevant emails as a JSON array. If none are relevant, return [].

${emailList}

Respond with ONLY a JSON array of ID strings, nothing else. Example: ["abc123", "def456"]`,
      },
    ],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "[]";

  try {
    // Extract JSON array from response
    const match = text.match(/\[.*\]/s);
    if (!match) return new Set();
    const ids: string[] = JSON.parse(match[0]);
    return new Set(ids);
  } catch {
    logger.warn("Failed to parse AI classification response", { text });
    return new Set();
  }
}
