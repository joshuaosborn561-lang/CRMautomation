import { Router, Request, Response } from "express";
import {
  getPendingReviews,
  approveReview,
  rejectReview,
} from "../services/event-store";
import { applyToAttio } from "../processors/event-pipeline";
import { logger } from "../utils/logger";

export const reviewRouter = Router();

// GET /api/review - List all pending reviews
reviewRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const pending = await getPendingReviews();
    res.json({
      count: pending.length,
      reviews: pending.map((r) => ({
        id: r.id,
        event_id: r.event_id,
        source: r.source,
        created_at: r.created_at,
        contact: r.proposed_action.contact,
        deal: r.proposed_action.deal,
        note: r.proposed_action.note,
        task: r.proposed_action.task,
      })),
    });
  } catch (err) {
    logger.error("Failed to get pending reviews", { error: String(err) });
    res.status(500).json({ error: "Failed to get reviews" });
  }
});

// POST /api/review/:id/approve - Approve and apply to Attio
reviewRouter.post("/:id/approve", async (req: Request, res: Response) => {
  try {
    const review = await approveReview(req.params.id);

    // Apply the approved action to Attio
    await applyToAttio(review.proposed_action);

    logger.info("Review approved and applied", { reviewId: req.params.id });
    res.json({ status: "approved", applied: true });
  } catch (err) {
    logger.error("Failed to approve review", { error: String(err) });
    res.status(500).json({ error: "Failed to approve review" });
  }
});

// POST /api/review/:id/reject - Reject a proposed action
reviewRouter.post("/:id/reject", async (req: Request, res: Response) => {
  try {
    const notes = req.body.notes || undefined;
    await rejectReview(req.params.id, notes);

    logger.info("Review rejected", { reviewId: req.params.id, notes });
    res.json({ status: "rejected" });
  } catch (err) {
    logger.error("Failed to reject review", { error: String(err) });
    res.status(500).json({ error: "Failed to reject review" });
  }
});

// POST /api/review/approve-all - Approve all pending reviews
reviewRouter.post("/approve-all", async (_req: Request, res: Response) => {
  try {
    const pending = await getPendingReviews();
    let applied = 0;
    let failed = 0;

    for (const review of pending) {
      try {
        const approved = await approveReview(review.id);
        await applyToAttio(approved.proposed_action);
        applied++;
      } catch (err) {
        logger.error("Failed to approve review item", {
          reviewId: review.id,
          error: String(err),
        });
        failed++;
      }
    }

    res.json({ status: "done", applied, failed, total: pending.length });
  } catch (err) {
    res.status(500).json({ error: "Failed to approve all reviews" });
  }
});
