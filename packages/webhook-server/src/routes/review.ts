import { Router, Request, Response } from "express";
import { getSupabase } from "../utils/supabase";
import { logger } from "../utils/logger";

export const reviewRouter = Router();

// GET /api/review-queue — list unresolved identity-resolution failures.
reviewRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("review_queue")
      .select("id, event_id, reason, identity_hint, assigned_identity_key, created_at")
      .eq("resolved", false)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw error;
    res.json({ count: (data || []).length, reviews: data || [] });
  } catch (err) {
    logger.error("Failed to list review queue", { error: String(err) });
    res.status(500).json({ error: "Failed to list reviews" });
  }
});

// POST /api/review-queue/:id/assign — assign an identity_key and re-queue the event.
// Body: { identity_key: "email:foo@bar.com" }
reviewRouter.post("/:id/assign", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const identityKey = String(req.body?.identity_key || "").trim();
    if (!identityKey || !/^(email|phone|linkedin):/.test(identityKey)) {
      return res.status(400).json({
        error: "identity_key must start with email:, phone:, or linkedin:",
      });
    }

    const supabase = getSupabase();

    const { data: row, error: rowErr } = await supabase
      .from("review_queue")
      .select("id, event_id")
      .eq("id", id)
      .single();
    if (rowErr || !row) return res.status(404).json({ error: "review row not found" });

    // Tag the webhook_event so the pipeline re-processes it.
    await supabase
      .from("webhook_events")
      .update({
        identity_key: identityKey,
        identity_resolved_at: new Date().toISOString(),
        processed: false,
      })
      .eq("id", row.event_id);

    await supabase
      .from("review_queue")
      .update({
        assigned_identity_key: identityKey,
        resolved: true,
        resolved_at: new Date().toISOString(),
        status: "approved",
      })
      .eq("id", id);

    logger.info("Review queue row assigned identity", { id, eventId: row.event_id, identityKey });
    res.json({ status: "assigned", identity_key: identityKey });
  } catch (err) {
    logger.error("Failed to assign review row", { error: String(err) });
    res.status(500).json({ error: "Failed to assign identity" });
  }
});

// POST /api/review-queue/:id/reject — drop a row without assigning.
reviewRouter.post("/:id/reject", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const supabase = getSupabase();
    await supabase
      .from("review_queue")
      .update({
        resolved: true,
        resolved_at: new Date().toISOString(),
        status: "rejected",
      })
      .eq("id", id);
    res.json({ status: "rejected" });
  } catch (err) {
    logger.error("Failed to reject review row", { error: String(err) });
    res.status(500).json({ error: "Failed to reject" });
  }
});
