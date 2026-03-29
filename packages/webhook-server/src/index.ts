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

// Background jobs
import { processEventQueue } from "./processors/event-pipeline";
import { runNurtureCheck } from "./jobs/nurture-engine";
import { setupGmailWatch } from "./services/gmail";

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

// Status endpoint — overview of system state
app.get("/api/status", async (_req, res) => {
  const config = getConfig();
  res.json({
    review_mode: config.REVIEW_MODE,
    environment: config.NODE_ENV,
    uptime: process.uptime(),
  });
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
