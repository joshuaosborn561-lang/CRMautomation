import { logger } from "../utils/logger";
import { enrichPerson as apolloEnrich } from "../services/apollo";
import { enrichContact, enrichByLinkedIn } from "../services/leadmagic";
import {
  getUnprocessedEvents,
  markEventProcessed,
  logInteraction,
} from "../services/event-store";
import {
  findContact,
  createContact,
  updateExistingContact,
  findDealByContact,
  createDeal,
  updateDealStage,
  createNote,
  createTask,
  setPersonDescription,
  setDealDescription,
} from "../services/attio";
import {
  resolveOrCreateIdentity,
  updateIdentityAttioIds,
} from "../services/identity";
import {
  classifyEvent,
  extractContactFromEvent,
  buildNoteBody,
  type ExtractedContact,
} from "../services/rules";
import type { WebhookEvent } from "@crm-autopilot/shared";

// ============================================================
// Event pipeline — rule-based, identity-first.
// No Gemini. No Node-level dedup. No Apollo cascade.
// ============================================================

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

      const retryCount = ((event.payload as any)?._retry_count || 0) + 1;
      if (retryCount >= 3) {
        logger.warn("Event failed 3 times, marking processed to stop retries", {
          eventId: event.id,
          source: event.source,
        });
        await markEventProcessed(event.id);
      } else {
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
  // Events without an identity key are already in review_queue — nothing to do here.
  const identityKey = (event as unknown as { identity_key?: string | null }).identity_key;
  if (!identityKey) {
    logger.info("Skipping event with no identity_key (already in review queue)", {
      eventId: event.id,
      source: event.source,
    });
    await markEventProcessed(event.id);
    return;
  }

  // 1. Rule-based classification (no LLM).
  const classification = classifyEvent(event);
  const contact = extractContactFromEvent(event);

  // 2. Fill gaps in contact fields via LeadMagic, then Apollo email fallback.
  await enrichContactFields(contact);

  // 3. Resolve-or-create identity row (atomic, DB-serialized).
  const identity = await resolveOrCreateIdentity(identityKey, event.source);
  logger.info("Identity resolved", {
    identityKey,
    identityId: identity.id,
    existingAttioPerson: identity.attio_person_id,
  });

  // 4. Ensure Attio person exists.
  let attioPersonId = identity.attio_person_id;
  if (attioPersonId) {
    // Refresh with any new fields.
    await updateExistingContact(attioPersonId, {
      email: contact.email || "",
      first_name: contact.first_name,
      last_name: contact.last_name,
      company: contact.company,
      phone: contact.phone,
      linkedin_url: contact.linkedin_url,
      title: contact.title,
      lead_source: event.source,
    });
  } else {
    // Check Attio directly by email in case we wiped identity_map but kept Attio.
    if (contact.email) {
      const existing = await findContact(contact.email);
      if (existing) {
        attioPersonId = existing.id;
        await updateExistingContact(existing.id, {
          email: contact.email,
          first_name: contact.first_name,
          last_name: contact.last_name,
          company: contact.company,
          phone: contact.phone,
          linkedin_url: contact.linkedin_url,
          title: contact.title,
          lead_source: event.source,
        });
      }
    }
    if (!attioPersonId) {
      attioPersonId = await createContact({
        email: contact.email || "",
        first_name: contact.first_name,
        last_name: contact.last_name,
        company: contact.company,
        phone: contact.phone,
        linkedin_url: contact.linkedin_url,
        title: contact.title,
        lead_source: event.source,
      });
    }
    await updateIdentityAttioIds(identity.id, { attio_person_id: attioPersonId });
  }

  // 5. Find-or-create deal.
  let attioDealId = identity.attio_deal_id;
  if (!attioDealId) {
    const existingDeal = await findDealByContact(attioPersonId);
    if (existingDeal) {
      attioDealId = existingDeal.id;
      await updateDealStage(attioDealId, classification.deal_stage);
    } else {
      try {
        attioDealId = await createDeal({
          name: classification.deal_title,
          stage: classification.deal_stage,
          contact_id: attioPersonId,
          company: contact.company,
          value: classification.deal_value,
          term_months: classification.term_months,
        });
      } catch (err) {
        logger.error("Deal creation failed", {
          contactId: attioPersonId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (attioDealId) {
      await updateIdentityAttioIds(identity.id, { attio_deal_id: attioDealId });
    }
  } else {
    await updateDealStage(attioDealId, classification.deal_stage);
  }

  // 6. Build verbatim note and write it to both deal and person.
  const noteTitle = `[${classification.sentiment.toUpperCase()}] ${classification.deal_stage_reason}`;
  const noteBody = buildNoteBody(event);

  if (attioDealId) {
    try {
      await createNote({
        parent_object: "deals",
        parent_id: attioDealId,
        title: noteTitle,
        content: noteBody,
      });
    } catch (err) {
      logger.warn("Deal note creation failed", { attioDealId, error: String(err) });
    }
  }
  try {
    await createNote({
      parent_object: "people",
      parent_id: attioPersonId,
      title: noteTitle,
      content: noteBody,
    });
  } catch (err) {
    logger.warn("Person note creation failed", { attioPersonId, error: String(err) });
  }

  const descriptionText = `${noteTitle}\n\n${noteBody}`.slice(0, 4000);
  await setPersonDescription(attioPersonId, descriptionText);
  if (attioDealId) await setDealDescription(attioDealId, descriptionText);

  // 7. Log interaction for nurture tracking.
  await logInteraction({
    contact_email: contact.email || identityKey,
    source: event.source,
    event_type: event.event_type,
    summary: noteBody.slice(0, 500),
    sentiment: classification.sentiment,
    raw_event_id: event.id,
    occurred_at: event.received_at,
  });

  await markEventProcessed(event.id);

  logger.info("Applied event to Attio", {
    eventId: event.id,
    identityKey,
    attioPersonId,
    attioDealId,
    stage: classification.deal_stage,
  });
}

/**
 * Fill missing contact fields. Order of preference:
 *   1. LeadMagic by email
 *   2. LeadMagic by LinkedIn
 *   3. Apollo /people/match by email
 */
async function enrichContactFields(contact: ExtractedContact): Promise<void> {
  const missingAny =
    !contact.phone || !contact.linkedin_url || !contact.title || !contact.company;
  if (!missingAny) return;

  try {
    if (contact.email) {
      const lm = await enrichContact({
        email: contact.email,
        first_name: contact.first_name,
        last_name: contact.last_name,
        company: contact.company,
        linkedin_url: contact.linkedin_url,
        phone: contact.phone,
      });
      if (lm.enriched) {
        contact.first_name = contact.first_name || lm.first_name;
        contact.last_name = contact.last_name || lm.last_name;
        contact.company = contact.company || lm.company;
        contact.title = contact.title || lm.title;
        contact.linkedin_url = contact.linkedin_url || lm.linkedin_url;
        contact.phone = contact.phone || lm.phone;
      }
    } else if (contact.linkedin_url) {
      const lm = await enrichByLinkedIn(contact.linkedin_url);
      if (lm) {
        contact.email = contact.email || lm.email;
        contact.first_name = contact.first_name || lm.first_name;
        contact.last_name = contact.last_name || lm.last_name;
        contact.company = contact.company || lm.company_name;
        contact.title = contact.title || lm.professional_title;
        contact.phone = contact.phone || lm.mobile_number;
      }
    }
  } catch (err) {
    logger.warn("LeadMagic enrichment failed", { error: String(err) });
  }

  // Apollo fallback — email-only
  if ((!contact.phone || !contact.linkedin_url || !contact.title) && contact.email) {
    try {
      const ap = await apolloEnrich({ email: contact.email });
      if (ap) {
        contact.phone = contact.phone || ap.phone;
        contact.linkedin_url = contact.linkedin_url || ap.linkedin_url;
        contact.title = contact.title || ap.title;
        contact.company = contact.company || ap.company;
      }
    } catch (err) {
      logger.warn("Apollo enrichment failed", { error: String(err) });
    }
  }
}
