import { Router, Request, Response } from "express";
import {
  getPendingNurtures,
  approveNurture,
  rejectNurture,
  markNurturePushed,
} from "../services/event-store";
import { executeNurture } from "../jobs/nurture-engine";
import { getConfig } from "../config";
import { logger } from "../utils/logger";

export const nurtureRouter = Router();

// GET /api/nurture - List prospects queued for nurture (awaiting your approval)
nurtureRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const pending = await getPendingNurtures();
    res.json({
      count: pending.length,
      prospects: pending.map((n) => ({
        id: n.id,
        contact_email: n.contact_email,
        deal_id: n.deal_id,
        days_silent: n.days_silent,
        last_positive_summary: n.last_positive_summary,
        last_positive_source: n.last_positive_source,
        last_positive_at: n.last_positive_at,
        nurture_reason: n.nurture_reason,
        created_at: n.created_at,
      })),
    });
  } catch (err) {
    logger.error("Failed to get nurture queue", { error: String(err) });
    res.status(500).json({ error: "Failed to get nurture queue" });
  }
});

// GET /api/nurture/:id/approve - Approve via email link click
nurtureRouter.get("/:id/approve", async (req: Request, res: Response) => {
  try {
    const config = getConfig();
    const campaignId = config.SMARTLEAD_NURTURE_CAMPAIGN_ID
      ? parseInt(config.SMARTLEAD_NURTURE_CAMPAIGN_ID, 10)
      : null;

    if (!campaignId) {
      return res.send("<h2>Error: No SmartLead nurture campaign ID configured.</h2>");
    }

    const nurtureItem = await approveNurture(String(req.params.id));
    await executeNurture(nurtureItem, campaignId);
    await markNurturePushed(String(req.params.id));

    logger.info("Nurture approved via email link", {
      nurtureId: req.params.id,
      email: nurtureItem.contact_email,
    });

    res.send(`
      <div style="font-family: -apple-system, sans-serif; max-width: 500px; margin: 80px auto; text-align: center;">
        <h2 style="color: #22c55e;">Approved!</h2>
        <p><strong>${nurtureItem.contact_email}</strong> has been pushed to your SmartLead nurture campaign.</p>
        <p>Deal stage updated to Nurture in Attio.</p>
      </div>
    `);
  } catch (err) {
    logger.error("Failed to approve nurture via link", { error: String(err) });
    res.send(`<h2 style="color: red;">Error: ${String(err)}</h2>`);
  }
});

// GET /api/nurture/:id/reject - Reject via email link click
nurtureRouter.get("/:id/reject", async (req: Request, res: Response) => {
  try {
    await rejectNurture(String(req.params.id));
    logger.info("Nurture rejected via email link", { nurtureId: req.params.id });

    res.send(`
      <div style="font-family: -apple-system, sans-serif; max-width: 500px; margin: 80px auto; text-align: center;">
        <h2 style="color: #ef4444;">Rejected</h2>
        <p>This prospect will not be added to the nurture sequence.</p>
      </div>
    `);
  } catch (err) {
    logger.error("Failed to reject nurture via link", { error: String(err) });
    res.send(`<h2 style="color: red;">Error: ${String(err)}</h2>`);
  }
});

// POST /api/nurture/:id/approve - Approve and push to SmartLead nurture sequence
// Body: { campaign_id: number } (optional — falls back to SMARTLEAD_NURTURE_CAMPAIGN_ID env var)
nurtureRouter.post("/:id/approve", async (req: Request, res: Response) => {
  try {
    const config = getConfig();
    const campaignId =
      req.body.campaign_id ||
      (config.SMARTLEAD_NURTURE_CAMPAIGN_ID
        ? parseInt(config.SMARTLEAD_NURTURE_CAMPAIGN_ID, 10)
        : null);

    if (!campaignId) {
      return res.status(400).json({
        error:
          "No SmartLead campaign ID provided. Pass campaign_id in the request body or set SMARTLEAD_NURTURE_CAMPAIGN_ID env var.",
      });
    }

    const nurtureItem = await approveNurture(req.params.id);

    // Push to SmartLead and update Attio
    await executeNurture(nurtureItem, campaignId);
    await markNurturePushed(req.params.id);

    logger.info("Nurture approved and pushed to SmartLead", {
      nurtureId: req.params.id,
      campaignId,
      email: nurtureItem.contact_email,
    });

    res.json({
      status: "approved",
      pushed_to_smartlead: true,
      campaign_id: campaignId,
      email: nurtureItem.contact_email,
    });
  } catch (err) {
    logger.error("Failed to approve nurture", { error: String(err) });
    res.status(500).json({ error: "Failed to approve nurture" });
  }
});

// POST /api/nurture/:id/reject - Reject (don't nurture this prospect)
nurtureRouter.post("/:id/reject", async (req: Request, res: Response) => {
  try {
    await rejectNurture(req.params.id);
    logger.info("Nurture rejected", { nurtureId: req.params.id });
    res.json({ status: "rejected" });
  } catch (err) {
    logger.error("Failed to reject nurture", { error: String(err) });
    res.status(500).json({ error: "Failed to reject nurture" });
  }
});
