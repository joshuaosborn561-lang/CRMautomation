import { getSupabase } from "../utils/supabase";
import { logger } from "../utils/logger";
import { getConfig } from "../config";
import { storeWebhookEvent } from "../services/event-store";
import { processEventQueue } from "../processors/event-pipeline";
import * as gmailService from "../services/gmail";
import * as zoomService from "../services/zoom";
import Anthropic from "@anthropic-ai/sdk";

/**
 * One-time startup backfill.
 * Runs on boot if:
 *   - RUN_STARTUP_BACKFILL env var is "true", OR
 *   - There are 0 interaction_log entries (nothing has ever been processed successfully)
 *
 * Clears old broken events, pulls fresh from all sources, and processes immediately.
 */
export async function runStartupBackfill(): Promise<void> {
  const config = getConfig();
  const supabase = getSupabase();

  // Check if we should run
  const forceRun = process.env.RUN_STARTUP_BACKFILL === "true";

  const { count: interactionCount } = await supabase
    .from("interaction_log")
    .select("*", { count: "exact", head: true });

  if (!forceRun && (interactionCount || 0) > 0) {
    logger.info("Startup backfill: skipping — interactions already exist", {
      count: interactionCount,
    });
    return;
  }

  logger.info("=== STARTUP BACKFILL: Beginning one-time data pull ===");

  // Step 1: Clear all old events (they're from failed credential attempts)
  logger.info("Step 1: Clearing old events...");
  await clearAllEvents(supabase);

  // Step 2: Pull from all sources
  const results: Record<string, unknown> = {};

  // SmartLead
  try {
    logger.info("Step 2a: Pulling SmartLead leads...");
    results.smartlead = await pullSmartLead();
    logger.info("SmartLead backfill done", results.smartlead);
  } catch (err) {
    logger.error("SmartLead backfill failed", { error: String(err) });
    results.smartlead = { error: String(err) };
  }

  // HeyReach
  try {
    logger.info("Step 2b: Pulling HeyReach leads...");
    results.heyreach = await pullHeyReach(config);
    logger.info("HeyReach backfill done", results.heyreach);
  } catch (err) {
    logger.error("HeyReach backfill failed", { error: String(err) });
    results.heyreach = { error: String(err) };
  }

  // Zoom
  try {
    logger.info("Step 2c: Pulling Zoom meetings...");
    results.zoom = await pullZoom(config);
    logger.info("Zoom backfill done", results.zoom);
  } catch (err) {
    logger.error("Zoom backfill failed", { error: String(err) });
    results.zoom = { error: String(err) };
  }

  // Gmail (last — most expensive due to AI classification)
  try {
    logger.info("Step 2d: Pulling Gmail emails...");
    results.gmail = await pullGmail(config);
    logger.info("Gmail backfill done", results.gmail);
  } catch (err) {
    logger.error("Gmail backfill failed", { error: String(err) });
    results.gmail = { error: String(err) };
  }

  // Step 3: Process all events immediately (don't wait for cron)
  logger.info("Step 3: Processing all events through AI pipeline...");

  // Process in batches until queue is empty
  let totalProcessed = 0;
  let batchCount = 0;
  const MAX_BATCHES = 50; // safety limit (50 batches × 50 events = 2500 max)

  while (batchCount < MAX_BATCHES) {
    const { count: remaining } = await supabase
      .from("webhook_events")
      .select("*", { count: "exact", head: true })
      .eq("processed", false);

    if (!remaining || remaining === 0) break;

    logger.info(`Processing batch ${batchCount + 1}... (${remaining} events remaining)`);

    try {
      await processEventQueue();
    } catch (err) {
      logger.error("Batch processing error", { error: String(err) });
    }

    batchCount++;
    totalProcessed += Math.min(remaining, 50);

    // Brief pause between batches to avoid overwhelming APIs
    await new Promise((r) => setTimeout(r, 2000));
  }

  logger.info("=== STARTUP BACKFILL COMPLETE ===", {
    results,
    batches_processed: batchCount,
    approximate_events_processed: totalProcessed,
  });
}

// --- Clear all old events ---

async function clearAllEvents(supabase: ReturnType<typeof getSupabase>): Promise<void> {
  // Delete in order: review_queue → interaction_log → webhook_events
  // Use gte on created_at/received_at to match all rows (Supabase requires a filter for delete)
  await supabase.from("review_queue").delete().gte("created_at", "2000-01-01");
  await supabase.from("interaction_log").delete().gte("occurred_at", "2000-01-01");
  await supabase.from("webhook_events").delete().gte("received_at", "2000-01-01");

  logger.info("Cleared all old events, interactions, and reviews");
}

// --- Pull SmartLead ---

async function pullSmartLead(): Promise<{ campaigns: number; leads: number }> {
  const { listCampaigns, getCampaignLeadsWithReplies } = await import("../services/smartlead");

  const campaigns = await listCampaigns();
  let leads = 0;

  for (const campaign of campaigns) {
    try {
      const replied = await getCampaignLeadsWithReplies(campaign.id);
      for (const lead of replied) {
        await storeWebhookEvent("smartlead", "reply_backfill", {
          email: lead.email,
          lead_email: lead.email,
          name: `${lead.first_name || ""} ${lead.last_name || ""}`.trim(),
          lead_name: `${lead.first_name || ""} ${lead.last_name || ""}`.trim(),
          company: lead.company_name,
          company_name: lead.company_name,
          campaign_name: campaign.name,
          campaign_id: campaign.id,
          reply: lead.reply || "",
          message: lead.reply || "",
          category: lead.reply_category || lead.status,
          reply_category: lead.reply_category || lead.status,
          replied_at: lead.replied_at,
          backfill: true,
        });
        leads++;
      }
      await new Promise((r) => setTimeout(r, 1000));
    } catch (err) {
      logger.warn(`SmartLead campaign ${campaign.name} failed`, { error: String(err) });
    }
  }

  return { campaigns: campaigns.length, leads };
}

// --- Pull HeyReach ---

async function pullHeyReach(config: ReturnType<typeof getConfig>): Promise<{ campaigns: number; leads: number }> {
  const campaignsResp = await fetch("https://api.heyreach.io/api/public/campaign/GetAll", {
    method: "POST",
    headers: {
      "X-API-KEY": config.HEYREACH_API_KEY,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ offset: 0, limit: 100 }),
  });

  if (!campaignsResp.ok) {
    const body = await campaignsResp.text();
    throw new Error(`HeyReach API error: ${campaignsResp.status} ${body}`);
  }

  const campaignsJson = (await campaignsResp.json()) as {
    data?: Array<{ id: string; name: string }>;
  };
  const campaigns = campaignsJson.data || [];
  let leads = 0;

  for (const campaign of campaigns) {
    try {
      const leadsResp = await fetch("https://api.heyreach.io/api/public/campaign/GetLeads", {
        method: "POST",
        headers: {
          "X-API-KEY": config.HEYREACH_API_KEY,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ campaignId: campaign.id, page: 1, limit: 100 }),
      });

      if (!leadsResp.ok) continue;

      const leadsJson = (await leadsResp.json()) as {
        data?: Array<{
          firstName?: string;
          lastName?: string;
          email?: string;
          companyName?: string;
          linkedinUrl?: string;
          status?: string;
          lastMessage?: string;
        }>;
      };

      const engaged = (leadsJson.data || []).filter(
        (l) => l.status === "replied" || l.status === "connected"
      );

      for (const lead of engaged) {
        await storeWebhookEvent("heyreach", "reply_received_backfill", {
          contact_name: `${lead.firstName || ""} ${lead.lastName || ""}`.trim(),
          name: `${lead.firstName || ""} ${lead.lastName || ""}`.trim(),
          email: lead.email || "",
          company: lead.companyName || "",
          linkedin_url: lead.linkedinUrl || "",
          profile_url: lead.linkedinUrl || "",
          event_type: "reply_received",
          action: "reply_received",
          message: lead.lastMessage || "",
          text: lead.lastMessage || "",
          campaign_name: campaign.name,
          backfill: true,
        });
        leads++;
      }
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      logger.warn(`HeyReach campaign ${campaign.name} failed`, { error: String(err) });
    }
  }

  return { campaigns: campaigns.length, leads };
}

// --- Pull Zoom ---

async function pullZoom(config: ReturnType<typeof getConfig>): Promise<{ meetings: number; processed: number }> {
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

  const fromDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const fromStr = fromDate.toISOString().split("T")[0];
  const toStr = new Date().toISOString().split("T")[0];

  const response = await fetch(
    `https://api.zoom.us/v2/users/me/recordings?from=${fromStr}&to=${toStr}&page_size=100`,
    { headers: { Authorization: `Bearer ${tokenData.access_token}` } }
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

  const meetings = data.meetings || [];
  let processed = 0;

  for (const meeting of meetings) {
    try {
      let transcript: string | null = null;
      try {
        transcript = await zoomService.getMeetingTranscript(String(meeting.id));
      } catch {
        // no transcript available
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
            participants: [],
          },
        },
        transcript: transcript || undefined,
        backfill: true,
      });
      processed++;

      if (processed % 5 === 0) await new Promise((r) => setTimeout(r, 2000));
    } catch (err) {
      logger.warn(`Zoom meeting ${meeting.topic} failed`, { error: String(err) });
    }
  }

  return { meetings: meetings.length, processed };
}

// --- Pull Gmail ---

async function pullGmail(config: ReturnType<typeof getConfig>): Promise<{ found: number; processed: number; skipped: number }> {
  // Get OAuth token
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

  if (!tokenResponse.ok) {
    const errBody = await tokenResponse.text();
    throw new Error(`Gmail OAuth error: ${tokenResponse.status} ${errBody}`);
  }

  const tokenData = (await tokenResponse.json()) as { access_token: string };
  const userId = config.GMAIL_USER_EMAIL || "me";

  // Search last 30 days
  const afterEpoch = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
  const query = `in:inbox after:${afterEpoch} -category:promotions -category:social -category:updates -category:forums`;

  // List messages (up to 500)
  const allMessages: Array<{ id: string; threadId: string }> = [];
  let pageToken: string | undefined;

  while (allMessages.length < 500) {
    const params = new URLSearchParams({
      q: query,
      maxResults: String(Math.min(50, 500 - allMessages.length)),
    });
    if (pageToken) params.set("pageToken", pageToken);

    const resp = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/${userId}/messages?${params}`,
      { headers: { Authorization: `Bearer ${tokenData.access_token}` } }
    );

    if (!resp.ok) {
      const errBody = await resp.text();
      throw new Error(`Gmail API error: ${resp.status} ${errBody}`);
    }

    const listData = (await resp.json()) as {
      messages?: Array<{ id: string; threadId: string }>;
      nextPageToken?: string;
    };

    if (!listData.messages || listData.messages.length === 0) break;
    allMessages.push(...listData.messages);
    pageToken = listData.nextPageToken;
    if (!pageToken) break;
  }

  // Sender skip patterns
  const skipPatterns = [
    "noreply@", "no-reply@", "donotreply@", "do-not-reply@",
    "mailer-daemon@", "postmaster@",
    "calendar-notification@", "notifications@google.com",
    "@linkedin.com", "@facebookmail.com",
    "notifications@github.com", "noreply@github.com",
    "@amazonses.com", "no-reply@accounts.google.com",
    "noreply@zoom.us", "noreply@stripe.com",
    "noreply@railway.app", "noreply@vercel.com",
    "noreply@supabase", "noreply@calendly.com",
    "noreply@mailchimp", "noreply@sendgrid",
  ];

  // Fetch and filter emails
  const emailBatch: Array<{ msgRef: { id: string; threadId: string }; message: Record<string, unknown> }> = [];
  let skipped = 0;

  for (const msgRef of allMessages) {
    try {
      const message = await gmailService.getMessage(msgRef.id);
      const fromLower = (message.from || "").toLowerCase();

      if (
        fromLower.includes("joshua@salesglidergrowth.com") ||
        fromLower.includes("joshuaosborn561") ||
        skipPatterns.some((p) => fromLower.includes(p))
      ) {
        skipped++;
        continue;
      }

      emailBatch.push({ msgRef, message: message as Record<string, unknown> });

      if (emailBatch.length % 10 === 0) await new Promise((r) => setTimeout(r, 500));
    } catch {
      skipped++;
    }
  }

  // AI classify in batches of 10 using Haiku
  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  let processed = 0;
  const BATCH_SIZE = 10;

  for (let i = 0; i < emailBatch.length; i += BATCH_SIZE) {
    const batch = emailBatch.slice(i, i + BATCH_SIZE);

    try {
      const emailList = batch
        .map(
          (b, idx) =>
            `[${idx + 1}] ID: ${b.msgRef.id}\n  From: ${b.message.from}\n  To: ${b.message.to}\n  Subject: ${b.message.subject}\n  Preview: ${String(b.message.snippet || b.message.body || "").substring(0, 200)}`
        )
        .join("\n\n");

      const response = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
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
      const match = text.match(/\[.*\]/s);
      const salesIds = new Set<string>(match ? JSON.parse(match[0]) : []);

      for (const item of batch) {
        if (salesIds.has(item.msgRef.id)) {
          await storeWebhookEvent("gmail", "email_received_backfill", {
            message_id: item.message.id,
            thread_id: item.message.threadId,
            from: item.message.from,
            to: item.message.to,
            subject: item.message.subject,
            date: item.message.date,
            body: String(item.message.body || "").substring(0, 5000),
            snippet: item.message.snippet,
            backfill: true,
          });
          processed++;
        } else {
          skipped++;
        }
      }
    } catch (err) {
      logger.warn("Gmail AI classification batch failed", { error: String(err) });
      skipped += batch.length;
    }

    if (i + BATCH_SIZE < emailBatch.length) await new Promise((r) => setTimeout(r, 1000));
  }

  return { found: allMessages.length, processed, skipped };
}
