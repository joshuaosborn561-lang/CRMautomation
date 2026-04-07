import { getConfig } from "../config";
import { logger } from "../utils/logger";
import { processEvent } from "./ai-processor";
import { enrichPerson as apolloEnrich, searchPeopleGlobal, searchContactByPhone } from "../services/apollo";
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
  setPersonDescription,
  setDealDescription,
} from "../services/attio";
import { enrichContact } from "../services/leadmagic";
import type { AIProcessingResult, WebhookEvent, EventSource } from "@crm-autopilot/shared";

// Sources that CREATE new contacts (outbound-first channels)
const LEAD_SOURCES: EventSource[] = ["smartlead", "heyreach", "zoom_phone", "zoom_meeting"];

// Sources that only ENRICH existing contacts (don't create new ones)
const ENRICHMENT_ONLY_SOURCES: EventSource[] = ["gmail"];

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

  // Step 1.5: Merge enriched_contact data (from Apollo/LeadMagic) into AI result
  // The AI doesn't see this data, so we overlay it here
  const enriched = event.payload?.enriched_contact as Record<string, string> | undefined;
  if (enriched) {
    if (enriched.email && enriched.email.includes("@")) {
      result.contact.email = enriched.email;
    }
    if (enriched.first_name) result.contact.first_name = result.contact.first_name || enriched.first_name;
    if (enriched.last_name) result.contact.last_name = result.contact.last_name || enriched.last_name;
    if (enriched.company) result.contact.company = result.contact.company || enriched.company;
    if (enriched.title) result.contact.title = result.contact.title || enriched.title;
    if (enriched.linkedin_url) result.contact.linkedin_url = result.contact.linkedin_url || enriched.linkedin_url;
    if (enriched.phone) result.contact.phone = result.contact.phone || enriched.phone;
    logger.info("Merged enriched_contact into AI result", {
      email: result.contact.email,
      name: `${result.contact.first_name} ${result.contact.last_name}`,
      company: result.contact.company,
    });
  }

  // Step 1.6: For zoom events, extract phone/name from raw payload if AI missed them
  if (event.source === "zoom_phone") {
    const obj = (event.payload?.payload as Record<string, unknown>)?.object as Record<string, unknown> | undefined;
    const caller = obj?.caller as Record<string, unknown> | undefined;
    const callee = obj?.callee as Record<string, unknown> | undefined;
    const external = callee?.extension_type === "pstn" ? callee : (caller?.extension_type === "pstn" ? caller : null);
    if (external && !result.contact.phone) {
      result.contact.phone = (external.phone_number || "") as string;
    }
    if (external?.name && (!result.contact.first_name || result.contact.first_name === "unknown")) {
      const parts = ((external.name as string) || "").split(" ");
      result.contact.first_name = parts[0] || undefined;
      result.contact.last_name = parts.slice(1).join(" ") || undefined;
    }
  }
  // Use any emails we extracted from the Zoom meeting payload (attendees/description/transcript)
  const extractedEmails = event.payload?.extracted_emails as string[] | undefined;
  if (extractedEmails && extractedEmails.length > 0 && (!result.contact.email || result.contact.email === "unknown")) {
    result.contact.email = extractedEmails[0];
    logger.info("Using extracted email from Zoom payload", { email: extractedEmails[0] });
  }

  if (event.source === "zoom_meeting") {
    const obj = (event.payload?.payload as Record<string, unknown>)?.object as Record<string, unknown> | undefined;
    const topic = (obj?.topic || "") as string;
    // Extract prospect name from meeting topic if AI missed it
    if (!result.contact.first_name || result.contact.first_name === "unknown") {
      const nameMatch = topic.match(/- (.+?) and Joshua/i) || topic.match(/- (.+?) and Josh/i);
      if (nameMatch) {
        const parts = nameMatch[1].trim().split(" ");
        result.contact.first_name = parts[0];
        result.contact.last_name = parts.slice(1).join(" ");
      }
    }
  }

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
    await applyToAttio(result, event.source, event.payload);
  }

  // Mark the raw event as processed
  await markEventProcessed(event.id);
}

// Check if an email is valid (not fabricated or placeholder)
function isValidEmail(email: string): boolean {
  if (!email || email === "unknown" || email === "none" || email === "n/a") return false;
  // Skip internal team members
  if (email === "skip_internal") return false;
  // Reject fabricated emails with "unknown" in the domain
  if (email.includes("unknown")) return false;
  // Reject obviously fake patterns
  if (email.includes("example.com") || email.includes("test.com")) return false;
  // Must look like an email
  if (!email.includes("@") || !email.includes(".")) return false;
  // Skip anyone from SalesGlider
  if (email.toLowerCase().includes("salesglidergrowth.com")) return false;
  return true;
}

// Apply an AI processing result to Attio CRM
export async function applyToAttio(
  result: AIProcessingResult,
  source?: EventSource,
  rawPayload?: Record<string, unknown>
): Promise<void> {
  const contact = result.contact;

  if (!isValidEmail(contact.email)) {
    // Must have at least a name to create a contact — no more unnamed records
    const hasName = contact.first_name && contact.first_name !== "unknown";
    if (!hasName) {
      logger.warn("No valid email or name — skipping Attio update (prevents unnamed contacts)", {
        eventId: result.event_id,
        email: contact.email,
        phone: contact.phone,
        source,
      });
      return;
    }

    // Has a name but no email — allow for phone calls and meetings
    if (contact.phone && source === "zoom_phone") {
      logger.info("No email but have name+phone, creating contact", {
        name: `${contact.first_name} ${contact.last_name}`,
        phone: contact.phone,
        eventId: result.event_id,
      });
    } else if (source === "zoom_meeting") {
      logger.info("No email but have name from meeting, creating contact", {
        name: `${contact.first_name} ${contact.last_name}`,
        eventId: result.event_id,
      });
    } else {
      logger.warn("No valid email — skipping Attio update", {
        eventId: result.event_id,
        email: contact.email,
        source,
      });
      return;
    }
  }

  // --- SOURCE-BASED LOGIC ---
  // Lead sources (SmartLead, HeyReach, Zoom Phone, Zoom Meeting): CREATE new contacts
  // Gmail: ONLY update existing contacts (pure enrichment)
  const isEnrichmentOnly = source && ENRICHMENT_ONLY_SOURCES.includes(source);

  if (isEnrichmentOnly) {
    // Check if contact already exists in Attio
    const existingContact = contact.email ? await findContact(contact.email) : null;

    if (!existingContact) {
      logger.info("Skipping enrichment-only event — contact not in CRM", {
        email: contact.email,
        source,
        eventId: result.event_id,
      });
      return;
    }

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
      const t = `[${result.note.sentiment.toUpperCase()}] ${result.deal.stage_reason}`;
      const b = buildNoteContent(result, rawPayload);
      await createNote({
        parent_object: "deals",
        parent_id: existingDeal.id,
        title: t,
        content: b,
      });
      try {
        await createNote({ parent_object: "people", parent_id: contactId, title: t, content: b });
      } catch (err) {
        logger.warn("Person note creation failed", { contactId, error: String(err) });
      }
      const descText = `${t}\n\n${b}`.slice(0, 4000);
      await setPersonDescription(contactId, descText);
      await setDealDescription(existingDeal.id, descText);
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

  // --- LEAD SOURCE: Create new contacts and deals ---

  // Apollo enrichment: try multiple strategies to find the person and backfill all fields.
  // Sanitize: don't let "unknown" or our own email leak into Apollo
  const ownDomain = (process.env.OWN_EMAIL_DOMAIN || "").toLowerCase();
  const validEmail = contact.email
    && contact.email !== "unknown"
    && contact.email.includes("@")
    && !(ownDomain && contact.email.toLowerCase().endsWith(`@${ownDomain}`))
    ? contact.email
    : undefined;
  if (!validEmail || !contact.phone || !contact.linkedin_url || !contact.title) {
    try {
      let apolloResult = null;
      const fullName = [contact.first_name, contact.last_name].filter(Boolean).join(" ").trim();
      const domain = validEmail?.split("@")[1];

      // Strategy 1: /people/match by email — highest match rate when we have one
      if (!apolloResult && validEmail) {
        apolloResult = await apolloEnrich({ email: validEmail });
      }
      // Strategy 2: /people/match by name + domain
      if (!apolloResult && contact.first_name && contact.last_name && domain) {
        apolloResult = await apolloEnrich({
          first_name: contact.first_name,
          last_name: contact.last_name,
          domain,
        });
      }
      // Strategy 3: /people/match by name + organization_name
      if (!apolloResult && contact.first_name && contact.last_name && contact.company) {
        apolloResult = await apolloEnrich({
          first_name: contact.first_name,
          last_name: contact.last_name,
          organization_name: contact.company,
        });
      }
      // Strategy 4: /people/match by linkedin_url
      if (!apolloResult && contact.linkedin_url) {
        apolloResult = await apolloEnrich({ linkedin_url: contact.linkedin_url });
      }
      // Strategy 5: /mixed_people/api_search with name + company (Apollo remembers unlocks against your account)
      if (!apolloResult && contact.first_name && contact.last_name) {
        apolloResult = await searchPeopleGlobal({
          first_name: contact.first_name,
          last_name: contact.last_name,
          organization_name: contact.company,
          organization_domain: domain,
        });
      }
      // Strategy 6: /mixed_people/api_search by email keyword
      if (!apolloResult && validEmail) {
        apolloResult = await searchPeopleGlobal({ email: validEmail });
      }
      // Strategy 7: phone-based global search
      if (!apolloResult && contact.phone) {
        const found = await searchContactByPhone(contact.phone);
        if (found) apolloResult = found;
      }
      if (apolloResult) {
        contact.email = contact.email || apolloResult.email;
        contact.phone = contact.phone || apolloResult.phone;
        contact.linkedin_url = contact.linkedin_url || apolloResult.linkedin_url;
        contact.title = contact.title || apolloResult.title;
        contact.company = contact.company || apolloResult.company;
        logger.info("Apollo enrichment applied", {
          name: `${contact.first_name} ${contact.last_name}`,
          gotEmail: !!apolloResult.email,
          gotPhone: !!apolloResult.phone,
          gotLinkedin: !!apolloResult.linkedin_url,
          gotTitle: !!apolloResult.title,
        });
      } else {
        logger.warn("Apollo found nothing for contact", {
          name: `${contact.first_name} ${contact.last_name}`,
          email: contact.email,
          phone: contact.phone,
          company: contact.company,
        });
      }
    } catch (err) {
      logger.warn("Apollo enrichment failed", { error: String(err) });
    }
  }

  // 1. Find or create the contact in Attio
  const contactId = await findOrCreateContact({
    email: contact.email,
    first_name: contact.first_name,
    last_name: contact.last_name,
    company: contact.company,
    phone: contact.phone,
    linkedin_url: contact.linkedin_url,
    title: contact.title,
    lead_source: source,
  });

  // 2. Find or create the deal (non-fatal — contact is more important)
  let dealId: string | null = null;
  try {
    const existingDeal = await findDealByContact(contactId);
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
  } catch (err) {
    logger.error("Deal creation failed — contact was created, deal was not", {
      contactId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 3. Log a note on BOTH the deal and the person (non-fatal)
  const noteTitle = `[${result.note.sentiment.toUpperCase()}] ${result.deal.stage_reason}`;
  const noteBody = buildNoteContent(result, rawPayload);
  if (dealId) {
    try {
      await createNote({
        parent_object: "deals",
        parent_id: dealId,
        title: noteTitle,
        content: noteBody,
      });
    } catch (err) {
      logger.warn("Deal note creation failed", { dealId, error: String(err) });
    }
  }
  try {
    await createNote({
      parent_object: "people",
      parent_id: contactId,
      title: noteTitle,
      content: noteBody,
    });
  } catch (err) {
    logger.warn("Person note creation failed", { contactId, error: String(err) });
  }

  // Also mirror the note into the Description field so it shows up in list/table views.
  const descriptionText = `${noteTitle}\n\n${noteBody}`.slice(0, 4000);
  await setPersonDescription(contactId, descriptionText);
  if (dealId) await setDealDescription(dealId, descriptionText);

  // 4. Create a follow-up task if warranted (non-fatal)
  if (result.task && dealId) {
    try {
      await createTask({
        title: result.task.title,
        description: result.task.description,
        linked_deal_id: dealId,
        due_date: result.task.due_date,
      });
    } catch (err) {
      logger.warn("Task creation failed", { dealId, error: String(err) });
    }
  }

  logger.info("Applied event to Attio", {
    eventId: result.event_id,
    contactEmail: contact.email,
    dealId,
    stage: result.deal.stage,
  });
}

function buildNoteContent(result: AIProcessingResult, rawPayload?: Record<string, unknown>): string {
  const parts: string[] = [];

  // Zoom AI Companion doc URL — the only Zoom link we want (not the meeting recording, not the join URL)
  if (rawPayload?.zoom_ai_summary_url) {
    parts.push(`Zoom AI Summary: ${rawPayload.zoom_ai_summary_url}`);
  }

  let content = parts.join("\n\n");

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
