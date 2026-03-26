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
  findOrCreateContact,
  findDealByContact,
  createDeal,
  updateDealStage,
  createNote,
  createTask,
} from "../services/attio";
import type { AIProcessingResult, WebhookEvent } from "@crm-autopilot/shared";

// Process all unprocessed events in the queue
export async function processEventQueue(): Promise<void> {
  const events = await getUnprocessedEvents();
  if (events.length === 0) return;

  logger.info(`Processing ${events.length} queued events`);

  for (const event of events) {
    try {
      await processSingleEvent(event);
    } catch (err) {
      logger.error("Failed to process event", {
        eventId: event.id,
        error: String(err),
      });
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
    await applyToAttio(result);
  }

  // Mark the raw event as processed
  await markEventProcessed(event.id);
}

// Apply an AI processing result to Attio CRM
export async function applyToAttio(result: AIProcessingResult): Promise<void> {
  const contact = result.contact;

  if (!contact.email) {
    logger.warn("No email found in event, skipping Attio update", {
      eventId: result.event_id,
    });
    return;
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
    // Update stage if it's progressing forward (or moving to closed/nurture)
    await updateDealStage(dealId, result.deal.stage);
  } else {
    dealId = await createDeal({
      name: result.deal.title,
      stage: result.deal.stage,
      contact_id: contactId,
      company: contact.company,
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
