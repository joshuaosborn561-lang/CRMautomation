import { Router, Request, Response } from "express";
import { storeWebhookEvent } from "../services/event-store";
import * as gmailService from "../services/gmail";
import * as zoomService from "../services/zoom";
import { logger } from "../utils/logger";

export const backfillRouter = Router();

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

    for (const msgRef of messages) {
      try {
        const message = await gmailService.getMessage(msgRef.id);

        // Skip emails from yourself (we want inbound from prospects)
        const fromLower = message.from.toLowerCase();
        if (
          fromLower.includes("joshuaosborn561") ||
          fromLower.includes("joshua@jmosolutions") ||
          fromLower.includes("noreply") ||
          fromLower.includes("no-reply") ||
          fromLower.includes("notifications") ||
          fromLower.includes("mailer-daemon")
        ) {
          skipped++;
          continue;
        }

        await storeWebhookEvent("gmail", "email_received_backfill", {
          message_id: message.id,
          thread_id: message.threadId,
          from: message.from,
          to: message.to,
          subject: message.subject,
          date: message.date,
          body: message.body.substring(0, 5000),
          snippet: message.snippet,
          backfill: true,
        });

        processed++;

        // Rate limit — don't hammer the APIs
        if (processed % 10 === 0) {
          await new Promise((r) => setTimeout(r, 1000));
        }
      } catch (err) {
        errors.push(`${msgRef.id}: ${String(err)}`);
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

  for (const msgRef of messages) {
    try {
      const message = await gmailService.getMessage(msgRef.id);
      const fromLower = message.from.toLowerCase();
      if (
        fromLower.includes("joshuaosborn561") ||
        fromLower.includes("joshua@jmosolutions") ||
        fromLower.includes("noreply") ||
        fromLower.includes("no-reply") ||
        fromLower.includes("notifications") ||
        fromLower.includes("mailer-daemon")
      ) {
        skipped++;
        continue;
      }

      await storeWebhookEvent("gmail", "email_received_backfill", {
        message_id: message.id,
        thread_id: message.threadId,
        from: message.from,
        to: message.to,
        subject: message.subject,
        date: message.date,
        body: message.body.substring(0, 5000),
        snippet: message.snippet,
        backfill: true,
      });
      processed++;

      if (processed % 10 === 0) await new Promise((r) => setTimeout(r, 1000));
    } catch {
      // skip individual errors
    }
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
