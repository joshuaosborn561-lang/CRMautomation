import { Router, Request, Response } from "express";
import { processQuery } from "../processors/ai-processor";
import { getAllDeals } from "../services/attio";
import { getSupabase } from "../utils/supabase";
import { logger } from "../utils/logger";

export const queryRouter = Router();

// POST /api/query - Ask a natural language question about the pipeline
queryRouter.post("/", async (req: Request, res: Response) => {
  try {
    const { question } = req.body;
    if (!question || typeof question !== "string") {
      return res.status(400).json({ error: "Question is required" });
    }

    logger.info("Processing pipeline query", { question });

    // Gather pipeline data from multiple sources
    const pipelineData = await gatherPipelineData();

    // Let Claude answer the question conversationally
    const answer = await processQuery(question, pipelineData);

    res.json({ question, answer });
  } catch (err) {
    logger.error("Query processing failed", { error: String(err) });
    res.status(500).json({ error: "Failed to process query" });
  }
});

async function gatherPipelineData(): Promise<string> {
  const sections: string[] = [];

  // 1. Get all deals from Attio
  try {
    const deals = await getAllDeals();
    sections.push(
      `## Current Deals (${deals.length} total)\n` +
        deals
          .map(
            (d) =>
              `- ${JSON.stringify(d.values)} | Stage: ${d.current_status?.title || "unknown"}`
          )
          .join("\n")
    );
  } catch (err) {
    sections.push("## Deals: Could not fetch from Attio");
  }

  // 2. Get recent interactions from our log
  try {
    const supabase = getSupabase();
    const { data: recentInteractions } = await supabase
      .from("interaction_log")
      .select("*")
      .order("occurred_at", { ascending: false })
      .limit(50);

    if (recentInteractions && recentInteractions.length > 0) {
      sections.push(
        `## Recent Interactions (last ${recentInteractions.length})\n` +
          recentInteractions
            .map(
              (i: Record<string, unknown>) =>
                `- [${i.occurred_at}] ${i.source} | ${i.contact_email} | ${i.sentiment} | ${i.summary}`
            )
            .join("\n")
      );
    }
  } catch {
    sections.push("## Recent Interactions: Could not fetch");
  }

  // 3. Get pending reviews
  try {
    const supabase = getSupabase();
    const { data: pending, count } = await supabase
      .from("review_queue")
      .select("*", { count: "exact" })
      .eq("status", "pending");

    sections.push(`## Pending Reviews: ${count || 0}`);
  } catch {
    sections.push("## Pending Reviews: Could not fetch");
  }

  // 4. Basic stats
  try {
    const supabase = getSupabase();
    const { count: totalEvents } = await supabase
      .from("webhook_events")
      .select("*", { count: "exact", head: true });

    const { count: totalInteractions } = await supabase
      .from("interaction_log")
      .select("*", { count: "exact", head: true });

    sections.push(
      `## Stats\n- Total webhook events received: ${totalEvents || 0}\n- Total interactions logged: ${totalInteractions || 0}`
    );
  } catch {
    // Skip stats if unavailable
  }

  return sections.join("\n\n") || "No pipeline data available yet.";
}
