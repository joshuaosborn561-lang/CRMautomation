import { logger } from "../utils/logger";
import { getSupabase } from "../utils/supabase";
import {
  getInteractionsByContact,
  logInteraction,
  addToNurtureQueue,
} from "../services/event-store";
import {
  findContact,
  findDealByContact,
  updateDealStage,
  createNote,
} from "../services/attio";
import { sendNurtureApprovalEmail } from "../services/notifications";

const SILENCE_THRESHOLD_DAYS = 2;

// Nurture rules:
// A deal is eligible for nurture ONLY if the prospect showed genuine interest
// first, then went silent for 2+ days. Someone who never responded is NOT a nurture.
//
// Specific triggers:
// 1. Replied positively to cold email -> we followed up -> silent 2 days
// 2. Booked meeting -> no-showed -> no follow-up response after 2 days
// 3. Cold call -> agreed to next steps -> never replied to follow-up email after 2 days
// 4. LinkedIn message expressing interest -> we replied -> silent 2 days
//
// When detected, the system:
// 1. Queues the prospect for YOUR APPROVAL in the nurture queue
// 2. When you approve, pushes them into your SmartLead nurture campaign
// 3. Updates the deal stage to Nurture in Attio with full context

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

  // Check if there have been any positive interactions after the last one
  const interactionsAfterPositive = interactions.filter((i) => {
    const iDate = new Date(i.occurred_at);
    return iDate > lastPositiveDate && i.sentiment === "positive";
  });

  // If they've had subsequent positive interactions, they're not silent
  if (interactionsAfterPositive.length > 0) return;

  // Check if they're already in nurture or closed
  const contact = await findContact(email);
  if (!contact) return;

  const deal = await findDealByContact(contact.id);
  if (!deal) return;

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

  const sourceLabel = getSourceLabel(lastPositive.source);
  const nurtureReason = buildNurtureReason(lastPositive, daysSilent);

  logger.info("Queueing prospect for nurture approval", {
    email,
    dealId: deal.id,
    daysSilent,
  });

  // Queue for approval — don't auto-push
  const nurtureId = await addToNurtureQueue({
    contact_email: email,
    contact_first_name: undefined,
    contact_last_name: undefined,
    contact_company: undefined,
    deal_id: deal.id,
    nurture_reason: nurtureReason,
    last_positive_summary: lastPositive.summary,
    last_positive_source: lastPositive.source,
    last_positive_at: lastPositive.occurred_at,
    days_silent: daysSilent,
  });

  // Email you for approval instead of relying on the web UI
  try {
    await sendNurtureApprovalEmail({
      id: nurtureId,
      contact_email: email,
      nurture_reason: nurtureReason,
      days_silent: daysSilent,
      last_positive_summary: lastPositive.summary,
    });
  } catch (err) {
    logger.warn("Failed to send nurture email notification", { error: String(err) });
  }
}

// Called when you approve a nurture — pushes to SmartLead and updates Attio
export async function executeNurture(
  nurtureItem: {
    contact_email: string;
    contact_first_name?: string;
    contact_last_name?: string;
    contact_company?: string;
    deal_id: string;
    nurture_reason: string;
    days_silent: number;
    last_positive_summary: string;
    last_positive_source: string;
  },
  smartleadCampaignId: number
): Promise<void> {
  const { addLeadToCampaign } = await import("../services/smartlead");

  // 1. Push lead into SmartLead nurture campaign
  await addLeadToCampaign(smartleadCampaignId, {
    email: nurtureItem.contact_email,
    first_name: nurtureItem.contact_first_name,
    last_name: nurtureItem.contact_last_name,
    company: nurtureItem.contact_company,
    custom_fields: {
      nurture_reason: nurtureItem.nurture_reason,
      last_interaction: nurtureItem.last_positive_summary,
    },
  });

  // 2. Move deal to Nurture in Attio
  await updateDealStage(nurtureItem.deal_id, "nurture");

  // 3. Log a note on the deal
  await createNote({
    parent_object: "deals",
    parent_id: nurtureItem.deal_id,
    title: `Moved to Nurture — ${nurtureItem.days_silent} days silent — added to SmartLead sequence`,
    content: `${nurtureItem.nurture_reason}\n\nACTION TAKEN: Added to SmartLead nurture campaign #${smartleadCampaignId}`,
  });

  // 4. Log the interaction
  await logInteraction({
    contact_email: nurtureItem.contact_email,
    deal_id: nurtureItem.deal_id,
    source: nurtureItem.last_positive_source as any,
    event_type: "nurture_sequence_started",
    summary: `Approved for nurture. Added to SmartLead campaign #${smartleadCampaignId} after ${nurtureItem.days_silent} days of silence.`,
    sentiment: "neutral",
    raw_event_id: "",
    occurred_at: new Date().toISOString(),
  });

  logger.info("Nurture executed — lead pushed to SmartLead", {
    email: nurtureItem.contact_email,
    campaignId: smartleadCampaignId,
  });
}

function getSourceLabel(source: string): string {
  switch (source) {
    case "smartlead": return "cold email reply";
    case "heyreach": return "LinkedIn message";
    case "zoom_phone": return "phone call";
    case "zoom_meeting": return "meeting";
    case "gmail": return "email";
    default: return "interaction";
  }
}

function buildNurtureReason(
  lastPositive: { summary: string; source: string; occurred_at: string },
  daysSilent: number
): string {
  const sourceLabel = getSourceLabel(lastPositive.source);

  return `WHY NURTURE:
This prospect engaged via ${sourceLabel} on ${new Date(lastPositive.occurred_at).toLocaleDateString()} and then went silent for ${daysSilent} days.

LAST POSITIVE INTERACTION:
${lastPositive.summary}

SOURCE: ${lastPositive.source}
DATE: ${new Date(lastPositive.occurred_at).toLocaleString()}

CONTEXT FOR RE-ENGAGEMENT:
They originally showed interest through a ${sourceLabel}. Your SmartLead nurture sequence should reference what they responded to and provide additional value.`;
}
