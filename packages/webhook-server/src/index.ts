import express from "express";
import cron from "node-cron";
import { getConfig } from "./config";
import { logger } from "./utils/logger";

// Webhook handlers
import { smartleadRouter } from "./webhooks/smartlead";
import { heyreachRouter } from "./webhooks/heyreach";
import { zoomRouter } from "./webhooks/zoom";
import { gmailRouter } from "./webhooks/gmail";

// API routes
import { reviewRouter } from "./routes/review";
import { nurtureRouter } from "./routes/nurture";
import { queryRouter } from "./routes/query";
import { backfillRouter } from "./routes/backfill";

// Background jobs
import { processEventQueue } from "./processors/event-pipeline";
import { runNurtureCheck } from "./jobs/nurture-engine";
import { setupGmailWatch } from "./services/gmail";
import { runStartupBackfill } from "./jobs/startup-backfill";

const app = express();

// Middleware
app.use(express.json({ limit: "10mb" }));

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Webhook endpoints
app.use("/webhooks/smartlead", smartleadRouter);
app.use("/webhooks/heyreach", heyreachRouter);
app.use("/webhooks/zoom", zoomRouter);
app.use("/webhooks/gmail", gmailRouter);

// API endpoints
app.use("/api/review", reviewRouter);
app.use("/api/nurture", nurtureRouter);
app.use("/api/query", queryRouter);
app.use("/api/backfill", backfillRouter);

// Status endpoint — overview of system state
app.get("/api/status", async (_req, res) => {
  try {
    const config = getConfig();
    const { getSupabase } = await import("./utils/supabase");
    const supabase = getSupabase();

    // Count events by status
    const { count: totalEvents } = await supabase
      .from("webhook_events")
      .select("*", { count: "exact", head: true });
    const { count: unprocessed } = await supabase
      .from("webhook_events")
      .select("*", { count: "exact", head: true })
      .eq("processed", false);
    const { count: processed } = await supabase
      .from("webhook_events")
      .select("*", { count: "exact", head: true })
      .eq("processed", true);

    // Count by source
    const { data: sourceCounts } = await supabase
      .from("webhook_events")
      .select("source, processed");

    const bySource: Record<string, { total: number; processed: number; unprocessed: number }> = {};
    for (const row of sourceCounts || []) {
      if (!bySource[row.source]) bySource[row.source] = { total: 0, processed: 0, unprocessed: 0 };
      bySource[row.source].total++;
      if (row.processed) bySource[row.source].processed++;
      else bySource[row.source].unprocessed++;
    }

    // Recent interaction log entries (last 10)
    const { data: recentInteractions } = await supabase
      .from("interaction_log")
      .select("contact_email, source, event_type, sentiment, occurred_at")
      .order("occurred_at", { ascending: false })
      .limit(10);

    res.json({
      review_mode: config.REVIEW_MODE,
      environment: config.NODE_ENV,
      uptime: process.uptime(),
      events: { total: totalEvents, processed, unprocessed },
      by_source: bySource,
      recent_interactions: recentInteractions || [],
      credentials_set: {
        anthropic: !!config.ANTHROPIC_API_KEY && !config.ANTHROPIC_API_KEY.includes("your-"),
        attio: !!config.ATTIO_API_KEY && !config.ATTIO_API_KEY.includes("your-"),
        attio_pipeline: !!config.ATTIO_PIPELINE_ID && config.ATTIO_PIPELINE_ID.length > 0,
        supabase: !!config.SUPABASE_URL && !config.SUPABASE_URL.includes("your-"),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Diagnostic endpoint — test every external API connection
app.get("/api/diag", async (_req, res) => {
  const config = getConfig();
  const results: Record<string, unknown> = {};

  // Supabase
  try {
    const { getSupabase } = await import("./utils/supabase");
    const supabase = getSupabase();
    const { count, error } = await supabase
      .from("webhook_events")
      .select("*", { count: "exact", head: true });
    results.supabase = error ? { status: "FAIL", error: error.message } : { status: "OK", event_count: count };
  } catch (err) {
    results.supabase = { status: "FAIL", error: String(err) };
  }

  // Attio
  try {
    const resp = await fetch("https://api.attio.com/v2/self", {
      headers: { Authorization: `Bearer ${config.ATTIO_API_KEY}` },
    });
    const body = await resp.text();
    results.attio = resp.ok
      ? { status: "OK", response: JSON.parse(body) }
      : { status: "FAIL", http: resp.status, body };
  } catch (err) {
    results.attio = { status: "FAIL", error: String(err) };
  }

  // Attio pipeline
  try {
    if (config.ATTIO_PIPELINE_ID) {
      const resp = await fetch(`https://api.attio.com/v2/lists/${config.ATTIO_PIPELINE_ID}`, {
        headers: { Authorization: `Bearer ${config.ATTIO_API_KEY}` },
      });
      const body = await resp.text();
      results.attio_pipeline = resp.ok
        ? { status: "OK", pipeline: JSON.parse(body) }
        : { status: "FAIL", http: resp.status, body };
    } else {
      results.attio_pipeline = { status: "FAIL", error: "ATTIO_PIPELINE_ID not set" };
    }
  } catch (err) {
    results.attio_pipeline = { status: "FAIL", error: String(err) };
  }

  // Anthropic
  try {
    const keyPrefix = config.ANTHROPIC_API_KEY.substring(0, 10) + "...";
    results.anthropic = { status: "OK", key_prefix: keyPrefix };
  } catch (err) {
    results.anthropic = { status: "FAIL", error: String(err) };
  }

  // Config summary
  results.config = {
    review_mode: config.REVIEW_MODE,
    has_attio_key: !!config.ATTIO_API_KEY && config.ATTIO_API_KEY.length > 10,
    has_attio_pipeline: !!config.ATTIO_PIPELINE_ID && config.ATTIO_PIPELINE_ID.length > 5,
    has_anthropic_key: !!config.ANTHROPIC_API_KEY && config.ANTHROPIC_API_KEY.length > 10,
    has_smartlead_key: !!config.SMARTLEAD_API_KEY && config.SMARTLEAD_API_KEY.length > 5,
    has_heyreach_key: !!config.HEYREACH_API_KEY && config.HEYREACH_API_KEY.length > 5,
    has_zoom_creds: !!config.ZOOM_CLIENT_ID && !!config.ZOOM_CLIENT_SECRET,
    has_google_creds: !!config.GOOGLE_CLIENT_ID && !!config.GOOGLE_REFRESH_TOKEN,
    has_leadmagic_key: !!config.LEADMAGIC_API_KEY,
    run_startup_backfill: process.env.RUN_STARTUP_BACKFILL,
  };

  res.json(results);
});

// Clear events by source and reset others for reprocessing
app.all("/api/fix", async (_req, res) => {
  try {
    const { getSupabase } = await import("./utils/supabase");
    const supabase = getSupabase();
    const results: Record<string, unknown> = {};

    // 1. Delete all gmail events and their linked data
    const { data: gmailEvents } = await supabase
      .from("webhook_events")
      .select("id")
      .eq("source", "gmail");
    const gmailIds = (gmailEvents || []).map((e: { id: string }) => e.id);

    if (gmailIds.length > 0) {
      for (let i = 0; i < gmailIds.length; i += 200) {
        const chunk = gmailIds.slice(i, i + 200);
        await supabase.from("review_queue").delete().in("event_id", chunk);
        await supabase.from("interaction_log").delete().in("raw_event_id", chunk);
      }
      await supabase.from("webhook_events").delete().eq("source", "gmail");
    }
    results.gmail_deleted = gmailIds.length;

    // 2. Reset all non-gmail processed events to unprocessed (so they re-run with correct config)
    const { error: resetErr } = await supabase
      .from("webhook_events")
      .update({ processed: false, processed_at: null })
      .eq("processed", true);
    results.events_reset = resetErr ? `Error: ${resetErr.message}` : "OK";

    // 3. Clear interaction_log entries with "unknown" email (failed enrichment)
    const { error: clearErr } = await supabase
      .from("interaction_log")
      .delete()
      .eq("contact_email", "unknown");
    results.unknown_interactions_cleared = clearErr ? `Error: ${clearErr.message}` : "OK";

    // 3b. Delete events with empty payloads or "unknown" event types (broken events)
    const { error: emptyErr } = await supabase
      .from("webhook_events")
      .delete()
      .eq("event_type", "unknown");
    results.empty_events_deleted = emptyErr ? `Error: ${emptyErr.message}` : "OK";

    // 4. Show what's left
    const { count: remaining } = await supabase
      .from("webhook_events")
      .select("*", { count: "exact", head: true });
    results.remaining_events = remaining;

    // 5. Show Attio pipeline stages for debugging
    const config = getConfig();
    try {
      const pipelineResp = await fetch(
        `https://api.attio.com/v2/lists/${config.ATTIO_PIPELINE_ID}/attributes`,
        { headers: { Authorization: `Bearer ${config.ATTIO_API_KEY}` } }
      );
      if (pipelineResp.ok) {
        const pipelineData = await pipelineResp.json();
        results.attio_pipeline_stages = pipelineData;
      } else {
        results.attio_pipeline_stages = `Error: ${pipelineResp.status} ${await pipelineResp.text()}`;
      }
    } catch (err) {
      results.attio_pipeline_stages = `Error: ${String(err)}`;
    }

    // 6. Check LeadMagic key
    results.leadmagic_key_set = !!config.LEADMAGIC_API_KEY && config.LEADMAGIC_API_KEY.length > 5;
    results.leadmagic_action_needed = !results.leadmagic_key_set
      ? "SET LEADMAGIC_API_KEY in Railway env vars to: 43599068e8e9a1fdfad0046b44e2b7fb"
      : "Key is set";

    res.json({
      message: "Gmail events cleared, remaining events reset for reprocessing",
      ...results,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Test processing a single event end-to-end (dry run with full error details)
app.get("/api/debug/test-one", async (_req, res) => {
  try {
    const { getSupabase } = await import("./utils/supabase");
    const supabase = getSupabase();

    // Get one unprocessed non-gmail event that has actual payload data
    const { data: events } = await supabase
      .from("webhook_events")
      .select("*")
      .eq("processed", false)
      .neq("source", "gmail")
      .neq("payload", "{}")
      .neq("event_type", "unknown")
      .order("received_at", { ascending: true })
      .limit(5);

    if (!events || events.length === 0) {
      res.json({ message: "No unprocessed non-gmail events to test" });
      return;
    }

    // Pick first event with actual content
    const event = events.find((e: any) => e.payload && Object.keys(e.payload).length > 0) || events[0];
    const result: Record<string, unknown> = {
      event_id: event.id,
      source: event.source,
      event_type: event.event_type,
      payload_keys: Object.keys(event.payload || {}),
    };

    // Try AI processing
    try {
      const { processEvent } = await import("./processors/ai-processor");
      const aiResult = await processEvent(event);
      result.ai_result = aiResult;

      // Try applying to Attio
      try {
        const { applyToAttio } = await import("./processors/event-pipeline");
        await applyToAttio(aiResult, event.source);
        result.attio_result = "SUCCESS — check Attio!";
      } catch (attioErr) {
        result.attio_error = attioErr instanceof Error ? attioErr.message : String(attioErr);
        result.attio_stack = attioErr instanceof Error ? attioErr.stack : undefined;
      }
    } catch (aiErr) {
      result.ai_error = aiErr instanceof Error ? aiErr.message : String(aiErr);
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// One-time setup: create custom Attio pipeline attributes if they don't exist
app.get("/api/setup-attio-fields", async (_req, res) => {
  try {
    const config = getConfig();
    const pipelineId = config.ATTIO_PIPELINE_ID;
    const results: Record<string, unknown> = {};

    const fieldsToCreate = [
      {
        title: "Deal Name",
        api_slug: "deal_name",
        type: "text",
        description: "Name of the deal (e.g. Company - Service)",
        is_required: false,
        is_unique: false,
        is_multiselect: false,
        config: {},
      },
      {
        title: "Deal Value",
        api_slug: "deal_value",
        type: "currency",
        description: "Monthly deal value in USD",
        is_required: false,
        is_unique: false,
        is_multiselect: false,
        config: { currency: { default_currency_code: "USD", display_type: "symbol" } },
      },
      {
        title: "Term Length",
        api_slug: "term_length",
        type: "number",
        description: "Contract term in months",
        is_required: false,
        is_unique: false,
        is_multiselect: false,
        config: {},
      },
    ];

    for (const field of fieldsToCreate) {
      try {
        const resp = await fetch(
          `https://api.attio.com/v2/lists/${pipelineId}/attributes`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.ATTIO_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ data: field }),
          }
        );

        const body = await resp.text();
        if (resp.ok) {
          results[field.api_slug] = { status: "CREATED", response: JSON.parse(body) };
        } else if (resp.status === 409) {
          results[field.api_slug] = { status: "ALREADY_EXISTS" };
        } else {
          results[field.api_slug] = { status: "FAIL", http: resp.status, body };
        }
      } catch (err) {
        results[field.api_slug] = { status: "FAIL", error: String(err) };
      }
    }

    res.json({ message: "Attio field setup complete", fields: results });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Setup Attio pipeline stages
app.get("/api/setup-attio-stages", async (_req, res) => {
  try {
    const config = getConfig();
    const pipelineId = config.ATTIO_PIPELINE_ID;
    const results: Record<string, unknown> = {};

    // First, get existing statuses
    const listResp = await fetch(
      `https://api.attio.com/v2/lists/${pipelineId}`,
      { headers: { Authorization: `Bearer ${config.ATTIO_API_KEY}` } }
    );
    const listData = await listResp.json();
    results.existing_list = listData;

    // Try to get statuses
    const statusResp = await fetch(
      `https://api.attio.com/v2/lists/${pipelineId}/entries/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.ATTIO_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ filter: {}, limit: 1 }),
      }
    );
    const statusData = await statusResp.json();
    results.sample_entry = statusData;

    // Create each stage
    const stages = [
      "Replied / Showed Interest",
      "Call or Meeting Booked",
      "Discovery Completed",
      "Proposal Sent",
      "Negotiating",
      "Closed Won",
      "Closed Lost",
      "Nurture",
    ];

    const stageResults: Record<string, unknown> = {};
    for (const stage of stages) {
      try {
        const resp = await fetch(
          `https://api.attio.com/v2/lists/${pipelineId}/statuses`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.ATTIO_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ data: { title: stage } }),
          }
        );
        const body = await resp.text();
        stageResults[stage] = resp.ok
          ? { status: "CREATED" }
          : { status: resp.status, body };
      } catch (err) {
        stageResults[stage] = { error: String(err) };
      }
    }
    results.stages = stageResults;

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Reprocess events — reset processed events so the cron picks them up again
app.post("/api/reprocess", async (req, res) => {
  try {
    const { getSupabase } = await import("./utils/supabase");
    const supabase = getSupabase();
    const source = req.query.source as string | undefined;

    let query = supabase
      .from("webhook_events")
      .update({ processed: false, processed_at: null })
      .eq("processed", true);

    if (source) {
      query = query.eq("source", source);
    }

    const { error } = await query;
    if (error) throw error;

    res.json({
      message: `Reset events to unprocessed. The cron job will re-process them within 30 seconds.`,
      source: source || "all",
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Force process queue now (don't wait for cron)
app.post("/api/process-now", async (_req, res) => {
  try {
    await processEventQueue();
    res.json({ message: "Event queue processed" });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Start server
const config = getConfig();
const port = parseInt(config.PORT, 10);

app.listen(port, () => {
  logger.info(`CRM Autopilot webhook server running on port ${port}`);
  logger.info(`Review mode: ${config.REVIEW_MODE ? "ON" : "OFF"}`);
  logger.info("Webhook endpoints:");
  logger.info("  POST /webhooks/smartlead");
  logger.info("  POST /webhooks/heyreach");
  logger.info("  POST /webhooks/zoom");
  logger.info("  POST /webhooks/gmail");
  logger.info("API endpoints:");
  logger.info("  GET  /api/review");
  logger.info("  POST /api/review/:id/approve");
  logger.info("  POST /api/review/:id/reject");
  logger.info("  POST /api/review/approve-all");
  logger.info("  POST /api/query");
  logger.info("  GET  /api/status");
});

// --- Gmail Watch Setup ---
// Gmail push notifications expire every 7 days, so set up on boot and renew daily
setupGmailWatch().catch((err) =>
  logger.warn("Gmail watch setup failed (will retry via cron)", { error: String(err) })
);

// --- One-time startup backfill (DISABLED — use POST /api/backfill/all manually) ---
// Was burning too many API credits running automatically.
// To run manually: POST /api/backfill/all then POST /api/process-now
// setTimeout(() => {
//   runStartupBackfill().catch((err) =>
//     logger.error("Startup backfill failed", { error: String(err) })
//   );
// }, 5000);

// --- Background Jobs ---

// Process event queue every 30 seconds
// Tracks consecutive AI failures to back off when rate-limited
let consecutiveAiFailures = 0;
cron.schedule("*/30 * * * * *", async () => {
  // Back off if AI is rate-limited (exponential: 1 skip, 2 skips, 4 skips... up to 60 = ~30 min)
  if (consecutiveAiFailures > 0) {
    const skipCycles = Math.min(Math.pow(2, consecutiveAiFailures - 1), 60);
    consecutiveAiFailures++;
    if (consecutiveAiFailures % skipCycles !== 0) {
      return; // skip this cycle
    }
  }
  try {
    await processEventQueue();
    consecutiveAiFailures = 0; // reset on success
  } catch (err) {
    const errMsg = String(err);
    if (errMsg.includes("429") || errMsg.includes("quota") || errMsg.includes("rate")) {
      consecutiveAiFailures++;
      logger.warn("AI rate limited, backing off", { failures: consecutiveAiFailures });
    } else {
      logger.error("Event queue processing failed", { error: errMsg });
    }
  }
});

// Run nurture check every hour
cron.schedule("0 * * * *", async () => {
  try {
    await runNurtureCheck();
  } catch (err) {
    logger.error("Nurture check failed", { error: String(err) });
  }
});

// Renew Gmail watch daily (expires every 7 days)
cron.schedule("0 3 * * *", async () => {
  try {
    await setupGmailWatch();
    logger.info("Gmail watch renewed");
  } catch (err) {
    logger.error("Gmail watch renewal failed", { error: String(err) });
  }
});

logger.info("Background jobs scheduled:");
logger.info("  Event queue processing: every 30 seconds");
logger.info("  Nurture engine: every hour");
logger.info("  Gmail watch renewal: daily at 3 AM");
