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

// --- One-time startup backfill ---
// Pulls leads from all sources, processes them through AI, and pushes to Attio.
// Only runs if there are 0 interaction_log entries (first boot) or RUN_STARTUP_BACKFILL=true.
// Runs in background so it doesn't block the server from starting.
setTimeout(() => {
  runStartupBackfill().catch((err) =>
    logger.error("Startup backfill failed", { error: String(err) })
  );
}, 5000); // 5 second delay to let server fully initialize

// --- Background Jobs ---

// Process event queue every 30 seconds
cron.schedule("*/30 * * * * *", async () => {
  try {
    await processEventQueue();
  } catch (err) {
    logger.error("Event queue processing failed", { error: String(err) });
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
