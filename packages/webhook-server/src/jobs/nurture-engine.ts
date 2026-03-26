import { logger } from "../utils/logger";
import { getSupabase } from "../utils/supabase";
import {
  getLastPositiveInteraction,
  getInteractionsByContact,
  logInteraction,
} from "../services/event-store";
import {
  findContact,
  findDealByContact,
  updateDealStage,
  createNote,
  createTask,
} from "../services/attio";
import { DEAL_STAGE_LABELS } from "@crm-autopilot/shared";

const SILENCE_THRESHOLD_DAYS = 5;

// Nurture rules:
// A deal moves to Nurture ONLY if the prospect showed genuine interest first,
// then went silent for 5+ days. Someone who never responded is NOT a nurture.
//
// Specific triggers:
// 1. Replied positively to cold email -> we followed up -> silent 5 days
// 2. Booked meeting -> no-showed -> no follow-up response after 5 days
// 3. Cold call -> agreed to next steps -> never replied to follow-up email after 5 days
// 4. LinkedIn message expressing interest -> we replied -> silent 5 days

export async function runNurtureCheck(): Promise<void> {
  logger.info("Running nurture engine check");

  const supabase = getSupabase();
  const now = new Date();
  const silenceThreshold = new Date(
    now.getTime() - SILENCE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000
  );

  // Get all contacts who have had at least one positive interaction
  const { data: candidates, error } = await supabase
    .from("interaction_log")
    .select("contact_email")
    .eq("sentiment", "positive")
    .order("occurred_at", { ascending: false });

  if (error) {
    logger.error("Nurture check failed: could not query interactions", {
      error: error.message,
    });
    return;
  }

  // Deduplicate contacts
  const uniqueEmails = [...new Set(candidates?.map((c) => c.contact_email) || [])];

  logger.info(`Checking ${uniqueEmails.length} contacts for nurture eligibility`);

  for (const email of uniqueEmails) {
    try {
      await checkContactForNurture(email, silenceThreshold);
    } catch (err) {
      logger.error("Nurture check failed for contact", {
        email,
        error: String(err),
      });
    }
  }

  logger.info("Nurture engine check complete");
}

async function checkContactForNurture(
  email: string,
  silenceThreshold: Date
): Promise<void> {
  // Get all interactions for this contact, most recent first
  const interactions = await getInteractionsByContact(email, 50);
  if (interactions.length === 0) return;

  // Find the most recent positive interaction
  const lastPositive = interactions.find((i) => i.sentiment === "positive");
  if (!lastPositive) return;

  const lastPositiveDate = new Date(lastPositive.occurred_at);

  // Check if the last positive interaction was before the silence threshold
  if (lastPositiveDate >= silenceThreshold) return;

  // Check if there have been any interactions (from them) after the positive one
  const interactionsAfterPositive = interactions.filter((i) => {
    const iDate = new Date(i.occurred_at);
    return iDate > lastPositiveDate && i.sentiment === "positive";
  });

  // If they've had subsequent positive interactions, they're not silent
  if (interactionsAfterPositive.length > 0) return;

  // This contact qualifies for nurture — check if they're already in nurture
  const contact = await findContact(email);
  if (!contact) return;

  const deal = await findDealByContact(contact.id);
  if (!deal) return;

  // Don't move closed deals to nurture
  if (
    deal.stage === "Closed Won" ||
    deal.stage === "Closed Lost" ||
    deal.stage === "Nurture"
  ) {
    return;
  }

  const daysSilent = Math.floor(
    (Date.now() - lastPositiveDate.getTime()) / (1000 * 60 * 60 * 24)
  );

  const nurtureReason = buildNurtureReason(lastPositive, daysSilent);

  logger.info("Moving deal to nurture", {
    email,
    dealId: deal.id,
    daysSilent,
    lastPositive: lastPositive.summary,
  });

  // Move to nurture
  await updateDealStage(deal.id, "nurture");

  // Log a detailed note with full context
  await createNote({
    parent_object: "deals",
    parent_id: deal.id,
    title: `Moved to Nurture — ${daysSilent} days silent`,
    content: nurtureReason,
  });

  // Create a re-engagement task with full context
  await createTask({
    title: `Re-engage: ${email}`,
    description: `This prospect went silent after showing interest.\n\n${nurtureReason}\n\nSuggested action: Reference their original interest and provide additional value.`,
    linked_deal_id: deal.id,
    due_date: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(), // 2 days from now
  });

  // Log this as an interaction
  await logInteraction({
    contact_email: email,
    source: lastPositive.source,
    event_type: "nurture_triggered",
    summary: `Automatically moved to Nurture after ${daysSilent} days of silence following positive engagement.`,
    sentiment: "neutral",
    raw_event_id: lastPositive.raw_event_id,
    occurred_at: new Date().toISOString(),
  });
}

function buildNurtureReason(
  lastPositive: { summary: string; source: string; occurred_at: string },
  daysSilent: number
): string {
  const sourceLabel =
    lastPositive.source === "smartlead"
      ? "cold email reply"
      : lastPositive.source === "heyreach"
        ? "LinkedIn message"
        : lastPositive.source === "zoom_phone"
          ? "phone call"
          : lastPositive.source === "zoom_meeting"
            ? "meeting"
            : "interaction";

  return `WHY NURTURE:
This prospect engaged via ${sourceLabel} on ${new Date(lastPositive.occurred_at).toLocaleDateString()} and then went silent.

LAST POSITIVE INTERACTION (${daysSilent} days ago):
${lastPositive.summary}

SOURCE: ${lastPositive.source}
DATE: ${new Date(lastPositive.occurred_at).toLocaleString()}

CONTEXT FOR RE-ENGAGEMENT:
They originally showed interest through a ${sourceLabel}. Reference what they responded to and provide additional value to re-engage.`;
}
