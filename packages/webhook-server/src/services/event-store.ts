import { getSupabase } from "../utils/supabase";
import { logger } from "../utils/logger";
import type {
  WebhookEvent,
  EventSource,
  ReviewQueueItem,
  AIProcessingResult,
  InteractionLog,
} from "@crm-autopilot/shared";

// --- Webhook Events ---

export async function storeWebhookEvent(
  source: EventSource,
  eventType: string,
  payload: Record<string, unknown>
): Promise<string> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("webhook_events")
    .insert({
      source,
      event_type: eventType,
      payload,
      received_at: new Date().toISOString(),
      processed: false,
    })
    .select("id")
    .single();

  if (error) {
    logger.error("Failed to store webhook event", { error: error.message });
    throw error;
  }

  logger.info("Stored webhook event", { id: data.id, source, eventType });
  return data.id;
}

export async function markEventProcessed(eventId: string): Promise<void> {
  const supabase = getSupabase();
  await supabase
    .from("webhook_events")
    .update({
      processed: true,
      processed_at: new Date().toISOString(),
    })
    .eq("id", eventId);
}

export async function getUnprocessedEvents(): Promise<WebhookEvent[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("webhook_events")
    .select("*")
    .eq("processed", false)
    .order("received_at", { ascending: true })
    .limit(50);

  if (error) throw error;
  return (data || []) as WebhookEvent[];
}

// --- Review Queue ---

export async function addToReviewQueue(
  eventId: string,
  source: EventSource,
  proposedAction: AIProcessingResult
): Promise<string> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("review_queue")
    .insert({
      event_id: eventId,
      source,
      proposed_action: proposedAction,
      status: "pending",
      created_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error) throw error;
  logger.info("Added to review queue", { id: data.id, eventId });
  return data.id;
}

export async function getPendingReviews(): Promise<ReviewQueueItem[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("review_queue")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true });

  if (error) throw error;
  return (data || []) as ReviewQueueItem[];
}

export async function approveReview(reviewId: string): Promise<ReviewQueueItem> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("review_queue")
    .update({
      status: "approved",
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", reviewId)
    .select("*")
    .single();

  if (error) throw error;
  return data as ReviewQueueItem;
}

export async function rejectReview(reviewId: string, notes?: string): Promise<void> {
  const supabase = getSupabase();
  await supabase
    .from("review_queue")
    .update({
      status: "rejected",
      reviewed_at: new Date().toISOString(),
      reviewer_notes: notes,
    })
    .eq("id", reviewId);
}

// --- Interaction Log ---

export async function logInteraction(log: Omit<InteractionLog, "id">): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from("interaction_log").insert(log);
  if (error) {
    logger.error("Failed to log interaction", { error: error.message });
    throw error;
  }
}

export async function getInteractionsByContact(
  contactEmail: string,
  limit = 20
): Promise<InteractionLog[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("interaction_log")
    .select("*")
    .eq("contact_email", contactEmail)
    .order("occurred_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data || []) as InteractionLog[];
}

export async function getLastPositiveInteraction(
  contactEmail: string
): Promise<InteractionLog | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("interaction_log")
    .select("*")
    .eq("contact_email", contactEmail)
    .eq("sentiment", "positive")
    .order("occurred_at", { ascending: false })
    .limit(1);

  if (error) throw error;
  return (data?.[0] as InteractionLog) || null;
}

// --- Nurture Tracking ---

export async function getDealsForNurtureCheck(): Promise<
  Array<{
    deal_id: string;
    contact_email: string;
    last_interaction_at: string;
    last_interaction_summary: string;
    last_interaction_sentiment: string;
    last_outbound_at: string | null;
  }>
> {
  const supabase = getSupabase();

  // Get deals with their most recent interaction
  // We look for deals where:
  // 1. The last positive interaction was 5+ days ago
  // 2. There's been no subsequent positive response
  const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase.rpc("get_nurture_candidates", {
    silence_threshold: fiveDaysAgo,
  });

  if (error) {
    logger.error("Failed to get nurture candidates", { error: error.message });
    return [];
  }

  return data || [];
}
