import { getConfig } from "../config";
import { logger } from "../utils/logger";
import { processEvent } from "./ai-processor";
import {
  getUnprocessedEvents,
  markEventProcessed,
  addToReviewQueue,
  logInteraction,
} from "../services/event-store";
import {
  findContact,
  findOrCreateContact,
  findDealByContact,
  createDeal,
  updateDealStage,
  createNote,
  createTask,
} from "../services/attio";
import { enrichContact } from "../services/leadmagic";
import type { AIProcessingResult, WebhookEvent, EventSource } from "@crm-autopilot/shared";

// Sources that CREATE new contacts (outbound-first channels)
const LEAD_SOURCES: EventSource[] = ["smartlead", "heyreach", "zoom_phone"];

// Sources that only ENRICH existing contacts (don't create new ones)
const ENRICHMENT_ONLY_SOURCES: EventSource[] = ["gmail"];

// Zoom meetings: enrich existing contacts by default, but CREATE new contact
// if the transcript clearly shows it's a real sales meeting
const CONDITIONAL_LEAD_SOURCES: EventSource[] = ["zoom_meeting"];

// Process all unprocessed events in the queue
export async function processEventQueue(): Promise<void> {
  const events = await getUnprocessedEvents();
  if (events.length === 0) return;

  logger.info(`Processing ${events.length} queued events`);

  for (const event of events) {
    try {
      await processSingleEvent(event);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error("Failed to process event", { eventId: event.id, error: errMsg });

      // If AI fails (rate limit, bad response, etc), mark as processed with error
      // so it doesn't retry forever and burn money
      const retryCount = ((event.payload as any)?._retry_count || 0) + 1;
      if (retryCount >= 3) {
        logger.warn("Event failed 3 times, marking as processed to stop retries", {
          eventId: event.id,
          source: event.source,
        });
        await markEventProcessed(event.id);
      } else {
        // Increment retry count in payload
        const { getSupabase } = await import("../utils/supabase");
        await getSupabase()
          .from("webhook_events")
          .update({ payload: { ...event.payload, _retry_count: retryCount } })
          .eq("id", event.id);
      }
    }
  }
}

async function processSingleEvent(event: WebhookEvent): Promise<void> {
  const config = getConfig();

  // Step 1: AI interprets the event
  logger.info("AI processing event", { eventId: event.id, source: event.source });
  const result = await processEvent(event);

  // Step 2: Log the interaction in our timeline
  await logInteraction({
    contact_email: result.contact.email || "unknown",
    source: event.source,
    event_type: event.event_type,
    summary: result.note.summary,
    sentiment: result.note.sentiment,
    raw_event_id: event.id,
    occurred_at: event.received_at,
  });

  // Step 3: Either queue for review or apply directly
  if (config.REVIEW_MODE) {
    await addToReviewQueue(event.id, event.source, result);
    logger.info("Event queued for review", { eventId: event.id });
  } else {
    await applyToAttio(result, event.source);
  }

  // Mark the raw event as processed
  await markEventProcessed(event.id);
}

// Apply an AI processing result to Attio CRM
export async function applyToAttio(
  result: AIProcessingResult,
  source?: EventSource
): Promise<void> {
  const contact = result.contact;

  if (!contact.email) {
    logger.warn("No email found in event, skipping Attio update", {
      eventId: result.event_id,
    });
    return;
  }

  // --- SOURCE-BASED LOGIC ---
  // Lead sources (SmartLead, HeyReach, Zoom Phone): CREATE new contacts
  // Gmail: ONLY update existing contacts (pure enrichment)
  // Zoom Meeting: enrich existing contacts, OR create new if transcript shows real sales meeting
  const isEnrichmentOnly = source && ENRICHMENT_ONLY_SOURCES.includes(source);
  const isConditionalLead = source && CONDITIONAL_LEAD_SOURCES.includes(source);

  if (isEnrichmentOnly || isConditionalLead) {
    // Check if contact already exists in Attio
    const existingContact = await findContact(contact.email);

    if (!existingContact) {
      // For Zoom meetings: create new contact if AI determined it's a real sales meeting
      // (positive sentiment = engaged prospect, or stage beyond initial reply = real deal activity)
      const isSalesMeeting =
        isConditionalLead &&
        (result.note.sentiment === "positive" ||
          ["discovery_completed", "proposal_sent", "negotiating", "closed_won"].includes(
            result.deal.stage
          ));

      if (isSalesMeeting) {
        logger.info("Zoom meeting identified as sales meeting — creating new contact", {
          email: contact.email,
          sentiment: result.note.sentiment,
          stage: result.deal.stage,
        });
        // Fall through to the lead source path below to create contact + deal
      } else {
        logger.info("Skipping enrichment-only event — contact not in CRM", {
          email: contact.email,
          source,
          eventId: result.event_id,
        });
        return;
      }
    } else {
      // Contact exists — enrich and update their deal
      const contactId = existingContact.id;

      // Enrich with LeadMagic
      try {
        const enriched = await enrichContact({
          email: contact.email,
          first_name: contact.first_name,
          last_name: contact.last_name,
          company: contact.company,
          linkedin_url: contact.linkedin_url,
          phone: contact.phone,
        });
        if (enriched.enriched) {
          contact.first_name = contact.first_name || enriched.first_name;
          contact.last_name = contact.last_name || enriched.last_name;
          contact.company = contact.company || enriched.company;
          contact.linkedin_url = contact.linkedin_url || enriched.linkedin_url;
          contact.phone = contact.phone || enriched.phone;
        }
      } catch (err) {
        logger.warn("LeadMagic enrichment failed", { error: String(err) });
      }

      // Find existing deal and update it
      const existingDeal = await findDealByContact(contactId);
      if (existingDeal) {
        await updateDealStage(existingDeal.id, result.deal.stage);
        await createNote({
          parent_object: "deals",
          parent_id: existingDeal.id,
          title: `[${result.note.sentiment.toUpperCase()}] ${result.deal.stage_reason}`,
          content: buildNoteContent(result),
        });
        if (result.task) {
          await createTask({
            title: result.task.title,
            description: result.task.description,
            linked_deal_id: existingDeal.id,
            due_date: result.task.due_date,
          });
        }
        logger.info("Enriched existing contact from " + source, {
          email: contact.email,
          dealId: existingDeal.id,
        });
      } else {
        logger.info("Contact exists but no deal — skipping enrichment", {
          email: contact.email,
          source,
        });
      }
      return;
    }
  }

  // --- LEAD SOURCE: Create new contacts and deals ---

  // Enrich contact with LeadMagic before pushing to Attio
  try {
    const enriched = await enrichContact({
      email: contact.email,
      first_name: contact.first_name,
      last_name: contact.last_name,
      company: contact.company,
      linkedin_url: contact.linkedin_url,
      phone: contact.phone,
    });

    if (enriched.enriched) {
      contact.first_name = contact.first_name || enriched.first_name;
      contact.last_name = contact.last_name || enriched.last_name;
      contact.company = contact.company || enriched.company;
      contact.linkedin_url = contact.linkedin_url || enriched.linkedin_url;
      contact.phone = contact.phone || enriched.phone;

      logger.info("Contact enriched via LeadMagic", {
        email: contact.email,
        company: contact.company,
      });
    }
  } catch (err) {
    logger.warn("LeadMagic enrichment failed, proceeding without", { error: String(err) });
  }

  // 1. Find or create the contact in Attio
  const contactId = await findOrCreateContact({
    email: contact.email,
    first_name: contact.first_name,
    last_name: contact.last_name,
    company: contact.company,
    phone: contact.phone,
    linkedin_url: contact.linkedin_url,
  });

  // 2. Find or create the deal
  const existingDeal = await findDealByContact(contactId);

  let dealId: string;
  if (existingDeal) {
    dealId = existingDeal.id;
    await updateDealStage(dealId, result.deal.stage);
  } else {
    dealId = await createDeal({
      name: result.deal.title,
      stage: result.deal.stage,
      contact_id: contactId,
      company: contact.company,
      value: result.deal.value,
      term_months: result.deal.term_months,
    });
  }

  // 3. Log a note on the deal
  await createNote({
    parent_object: "deals",
    parent_id: dealId,
    title: `[${result.note.sentiment.toUpperCase()}] ${result.deal.stage_reason}`,
    content: buildNoteContent(result),
  });

  // 4. Create a follow-up task if warranted
  if (result.task) {
    await createTask({
      title: result.task.title,
      description: result.task.description,
      linked_deal_id: dealId,
      due_date: result.task.due_date,
    });
  }

  logger.info("Applied event to Attio", {
    eventId: result.event_id,
    contactEmail: contact.email,
    dealId,
    stage: result.deal.stage,
  });
}

function buildNoteContent(result: AIProcessingResult): string {
  let content = result.note.summary;

  if (result.note.pricing_discussed) {
    content += "\n\n💰 Pricing was discussed in this interaction.";
    if (result.deal.value) {
      content += ` Deal value: $${result.deal.value.toLocaleString()}/mo`;
      if (result.deal.term_months) {
        content += ` × ${result.deal.term_months} months ($${(result.deal.value * result.deal.term_months).toLocaleString()} total)`;
      }
    }
  }

  if (result.note.next_steps) {
    content += `\n\nNext Steps: ${result.note.next_steps}`;
  }

  if (result.nurture_context) {
    content += `\n\n--- Nurture Context ---`;
    content += `\nLast positive interaction: ${result.nurture_context.last_positive_interaction}`;
    content += `\nWhat was said: ${result.nurture_context.what_was_said}`;
    content += `\nDays since engagement: ${result.nurture_context.days_since_engagement}`;
  }

  return content;
}
