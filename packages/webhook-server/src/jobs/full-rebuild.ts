import { logger } from "../utils/logger";
import { getSupabase } from "../utils/supabase";
import {
  listAllPeople,
  listAllDealRecords,
  listAllCompanies,
  deletePerson,
  deleteDeal,
  deleteCompany,
} from "../services/attio";
import {
  computeIdentityKey,
  resolveOrCreateIdentity,
  getOrEnrichIdentity,
  emailKey,
  upsertMeetingLink,
  lookupMeetingLink,
} from "../services/identity";
import { classifyEvent, extractContactFromEvent } from "../services/rules";
import * as gmailService from "../services/gmail";
import * as zoomService from "../services/zoom";
import type { EventSource, WebhookEvent } from "@crm-autopilot/shared";

// ============================================================
// Three-phase full rebuild: dry-run → wipe → replay.
// Each endpoint is independent — never auto-chained.
// ============================================================

export interface ProjectedContact {
  identity_key: string;
  event_count: number;
  sources: string[];
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
  company: string | null;
  title: string | null;
  enrichment_source: string | null;
  enrichment_from_cache: boolean;
}

export interface ProjectedDeal {
  identity_key: string;
  title: string;
  stage: string;
  sentiment: string;
  pricing_discussed: boolean;
  latest_event_source: string;
  latest_event_type: string;
  latest_event_at: string;
}

export interface DryRunReport {
  total_events: number;
  projected_person_count: number;
  events_by_source: Record<string, number>;
  events_skipped_noise: number;
  contacts_skipped_unenrichable: {
    zoom_phone_no_email: number;
    empty_ghost: number;
    total: number;
  };
  unresolved_events: Array<{
    event_id: string;
    source: string;
    event_type: string;
    reason: string;
  }>;
  enrichment_summary: {
    from_cache: number;
    freshly_enriched: number;
    cache_miss_api_calls: number;
  };
  meeting_resolution_summary: {
    meetings_checked: number;
    resolved_via_cache: number;
    resolved_via_gmail: number;
    resolved_via_zoom_settings: number;
    resolved_via_zoom_participants: number;
    resolved_via_transcript: number;
    still_unresolved: number;
  };
  contacts: ProjectedContact[];
  deals: ProjectedDeal[];
}

/**
 * Only event types that should actually produce contacts+deals.
 * All other zoom_meeting event types (meeting.started, meeting.ended,
 * recording.completed, meeting.ended_backfill) are ingestion noise —
 * only transcript_completed carries the data we care about.
 */
const ACTIONABLE_EVENT_TYPES: Record<string, Set<string>> = {
  zoom_meeting: new Set(["recording.transcript_completed"]),
  // All other sources: every event type is actionable by default.
};

function isActionable(source: EventSource, eventType: string): boolean {
  const actionable = ACTIONABLE_EVENT_TYPES[source];
  return !actionable || actionable.has(eventType);
}

type GmailSearchQuery = {
  q: string;
  maxResults: number;
};

function buildGmailQueriesForMeeting(meetingId: string, topic?: string): GmailSearchQuery[] {
  const meetingIdDigits = meetingId.replace(/\D/g, "");
  const formattedDigits = new Set<string>([meetingIdDigits]);
  if (meetingIdDigits.length === 11) {
    formattedDigits.add(
      `${meetingIdDigits.slice(0, 3)} ${meetingIdDigits.slice(3, 7)} ${meetingIdDigits.slice(7)}`
    );
    formattedDigits.add(
      `${meetingIdDigits.slice(0, 3)}-${meetingIdDigits.slice(3, 7)}-${meetingIdDigits.slice(7)}`
    );
  } else if (meetingIdDigits.length === 10) {
    formattedDigits.add(
      `${meetingIdDigits.slice(0, 3)} ${meetingIdDigits.slice(3, 6)} ${meetingIdDigits.slice(6)}`
    );
    formattedDigits.add(
      `${meetingIdDigits.slice(0, 3)}-${meetingIdDigits.slice(3, 6)}-${meetingIdDigits.slice(6)}`
    );
  }
  const idVariants = Array.from(new Set([meetingId, ...formattedDigits].filter(Boolean)));

  const topicHints = new Set<string>();
  if (topic) {
    const clean = topic.replace(/\s+/g, " ").trim();
    if (clean.length > 4) topicHints.add(clean);
    const dashParts = clean.split(" - ").map((p) => p.trim()).filter(Boolean);
    if (dashParts.length > 1) topicHints.add(dashParts.slice(1).join(" - "));
  }

  const out: GmailSearchQuery[] = [];
  const seen = new Set<string>();
  const push = (q: string, maxResults: number) => {
    if (!q || seen.has(q)) return;
    seen.add(q);
    out.push({ q, maxResults });
  };

  for (const id of idVariants) {
    push(`from:zoom.us ${id}`, 8);
    push(`from:*.zoom.us ${id}`, 8);
    push(`from:no-reply@zoom.us ${id}`, 8);
    push(`"${id}"`, 8);
  }
  if (meetingIdDigits) {
    push(`from:zoom.us "zoom.us/j/${meetingIdDigits}"`, 8);
    push(`from:no-reply@zoom.us "zoom.us/j/${meetingIdDigits}"`, 8);
    push(`"zoom.us/j/${meetingIdDigits}"`, 8);
  }
  for (const hint of topicHints) {
    push(`from:zoom.us "${hint}"`, 5);
    push(`from:no-reply@zoom.us "${hint}"`, 5);
  }
  return out;
}

function extractFirstExternalEmail(
  text: string | null | undefined,
  ownDomain: string
): string | null {
  if (!text) return null;
  const re = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
  const matches = Array.from(new Set((text.match(re) || []).map((e) => e.toLowerCase())));
  const external = matches.find(
    (e) =>
      !e.endsWith(`@${ownDomain}`) &&
      !e.endsWith("@zoom.us") &&
      !e.includes("calendar-notification@google.com")
  );
  return external || null;
}

/**
 * Re-run the Gmail identity cascade for a zoom_meeting payload whose stored
 * row pre-dates the cascade logic. Writes the resolved email back into
 * webhook_events.payload so subsequent calls see it. Non-destructive to Attio.
 */
async function resolveZoomMeetingAttendee(row: {
  id: string;
  payload: Record<string, unknown>;
}): Promise<{
  email: string | null;
  via: string | null;
  updated_payload: Record<string, unknown>;
}> {
  let payload = row.payload;
  if (payload.resolved_attendee_email) {
    return {
      email: payload.resolved_attendee_email as string,
      via: (payload.resolved_via as string) || "pre_resolved",
      updated_payload: payload,
    };
  }

  const obj = (payload.payload as Record<string, unknown> | undefined)?.object as
    | Record<string, unknown>
    | undefined;
  const meetingId = obj?.id ? String(obj.id) : null;
  const meetingUuid = obj?.uuid ? String(obj.uuid) : null;
  if (!meetingId) return { email: null, via: null, updated_payload: payload };

  const ownDomain = (process.env.OWN_EMAIL_DOMAIN || "salesglidergrowth.com").toLowerCase();

  let attendeeEmail: string | null = null;
  let resolvedVia: string | null = null;

  // 1. meeting_links cache
  const cached = await lookupMeetingLink(meetingId);
  if (cached?.attendee_email) {
    attendeeEmail = cached.attendee_email;
    resolvedVia = "meeting_links_cache";
  }

  // 2. Gmail inbox search — Zoom confirmation email from no-reply@zoom.us
  if (!attendeeEmail) {
    const queries = buildGmailQueriesForMeeting(
      meetingId,
      typeof obj?.topic === "string" ? obj.topic : undefined
    );
    for (const { q, maxResults } of queries) {
      if (attendeeEmail) break;
      try {
        const hits = await gmailService.searchMessages(q, maxResults);
        for (const hit of hits) {
          const email = await gmailService.extractAttendeeEmailFromMessage(hit.id);
          if (email) {
            attendeeEmail = email;
            resolvedVia = `gmail_search:${q}`;
            await upsertMeetingLink({
              zoom_meeting_id: meetingId,
              attendee_email: email,
              gmail_message_id: hit.id,
              meeting_topic: obj?.topic as string | undefined,
            });
            break;
          }
        }
      } catch (err) {
        logger.warn("Dry-run Gmail search failed", { meetingId, q, error: String(err) });
      }
    }
  }

  // 3. Zoom meeting settings fallback
  if (!attendeeEmail) {
    try {
      const settings = await zoomService.getMeetingSettings(meetingId);
      const firstExternal = settings?.invitees.find(
        (i) => i.email && !i.email.toLowerCase().endsWith(`@${ownDomain}`)
      );
      if (firstExternal?.email) {
        attendeeEmail = firstExternal.email.toLowerCase();
        resolvedVia = "zoom_meeting_settings";
      }
    } catch (err) {
      logger.warn("Dry-run Zoom settings failed", { meetingId, error: String(err) });
    }
  }

  // 3b. Zoom participants fallback for completed meetings.
  if (!attendeeEmail) {
    try {
      const idsToTry = Array.from(new Set([meetingId, meetingUuid].filter(Boolean))) as string[];
      let participantsWithFallback: Array<{
        id?: string;
        name?: string;
        user_email?: string;
        email?: string;
      }> = [];
      for (const id of idsToTry) {
        const got = await zoomService.getMeetingParticipants(id);
        if (got.length > 0) {
          participantsWithFallback = got;
          break;
        }
      }

      const firstExternal = participantsWithFallback.find(
        (p) =>
          (p.email || p.user_email) &&
          !String(p.email || p.user_email).toLowerCase().endsWith(`@${ownDomain}`) &&
          !String(p.email || p.user_email).toLowerCase().endsWith("@zoom.us")
      );
      if (firstExternal) {
        attendeeEmail = String(firstExternal.email || firstExternal.user_email).toLowerCase();
        resolvedVia = "zoom_participants";
      }
    } catch (err) {
      logger.warn("Dry-run Zoom participants failed", { meetingId, error: String(err) });
    }
  }

  // 4. Transcript regex: stored transcript, then live Zoom transcript fetch.
  if (!attendeeEmail) {
    const fromPayload = extractFirstExternalEmail(String(payload.transcript || ""), ownDomain);
    if (fromPayload) {
      attendeeEmail = fromPayload;
      resolvedVia = "transcript_regex";
    } else {
      const idsToTry = Array.from(new Set([meetingUuid, meetingId].filter(Boolean))) as string[];
      for (const id of idsToTry) {
        const transcript = await zoomService.getMeetingTranscript(id);
        const extracted = extractFirstExternalEmail(transcript, ownDomain);
        if (extracted) {
          attendeeEmail = extracted;
          resolvedVia = "transcript_regex";
          payload = { ...payload, transcript };
          break;
        }
      }
    }
  }

  if (attendeeEmail) {
    payload = { ...payload, resolved_attendee_email: attendeeEmail, resolved_via: resolvedVia };
    // Persist back to webhook_events so subsequent reads are instant.
    const supabase = getSupabase();
    await supabase.from("webhook_events").update({ payload }).eq("id", row.id);
  }

  return { email: attendeeEmail, via: resolvedVia, updated_payload: payload };
}

export async function dryRun(): Promise<DryRunReport> {
  const supabase = getSupabase();
  const { data: events, error } = await supabase
    .from("webhook_events")
    .select("id, source, event_type, payload, received_at")
    .order("received_at", { ascending: true });

  if (error) throw error;

  const rows = (events || []) as Array<{
    id: string;
    source: EventSource;
    event_type: string;
    payload: Record<string, unknown>;
    received_at: string;
  }>;

  const eventsBySource: Record<string, number> = {};
  const unresolved: DryRunReport["unresolved_events"] = [];
  let skippedNoise = 0;

  const meetingSummary = {
    meetings_checked: 0,
    resolved_via_cache: 0,
    resolved_via_gmail: 0,
    resolved_via_zoom_settings: 0,
    resolved_via_zoom_participants: 0,
    resolved_via_transcript: 0,
    still_unresolved: 0,
  };

  // Group events by identity_key
  interface Group {
    key: string;
    events: typeof rows;
    sources: Set<string>;
  }
  const groups = new Map<string, Group>();

  for (const row of rows) {
    eventsBySource[row.source] = (eventsBySource[row.source] || 0) + 1;

    // Skip non-actionable event types (meeting lifecycle noise).
    if (!isActionable(row.source, row.event_type)) {
      skippedNoise += 1;
      continue;
    }

    // For zoom_meeting transcripts: run the identity cascade now so
    // historical events resolve. Writes back to webhook_events.payload.
    let effectivePayload = row.payload;
    if (row.source === "zoom_meeting") {
      meetingSummary.meetings_checked += 1;
      const resolution = await resolveZoomMeetingAttendee(row);
      effectivePayload = resolution.updated_payload;
      if (resolution.email) {
        if (resolution.via === "meeting_links_cache") meetingSummary.resolved_via_cache += 1;
        else if (resolution.via?.startsWith("gmail_search")) meetingSummary.resolved_via_gmail += 1;
        else if (resolution.via === "zoom_meeting_settings") meetingSummary.resolved_via_zoom_settings += 1;
        else if (resolution.via === "zoom_participants") meetingSummary.resolved_via_zoom_participants += 1;
        else if (resolution.via === "transcript_regex") meetingSummary.resolved_via_transcript += 1;
      } else {
        meetingSummary.still_unresolved += 1;
      }
    }

    const key = computeIdentityKey(row.source, effectivePayload);
    if (!key) {
      unresolved.push({
        event_id: row.id,
        source: row.source,
        event_type: row.event_type,
        reason: reasonForNoKey(row.source),
      });
      continue;
    }
    // Mutate the row so extractContactFromEvent sees the resolved payload.
    row.payload = effectivePayload;
    const group = groups.get(key) || { key, events: [], sources: new Set<string>() };
    group.events.push(row);
    group.sources.add(row.source);
    groups.set(key, group);
  }

  const contacts: ProjectedContact[] = [];
  const deals: ProjectedDeal[] = [];
  let fromCache = 0;
  let freshlyEnriched = 0;
  const skippedUnenrichable = {
    zoom_phone_no_email: 0,
    empty_ghost: 0,
    total: 0,
  };

  for (const group of groups.values()) {
    // Build a synthetic WebhookEvent from the most recent event in the group.
    // We use the latest event to derive deal stage/classification.
    const latest = group.events[group.events.length - 1];
    const latestEvent: WebhookEvent = {
      id: latest.id,
      source: latest.source,
      event_type: latest.event_type,
      payload: latest.payload,
      received_at: latest.received_at,
      processed: false,
    };

    // Collect seed fields from ALL events in the group (merge).
    const seed = {
      email: undefined as string | undefined,
      first_name: undefined as string | undefined,
      last_name: undefined as string | undefined,
      company: undefined as string | undefined,
      phone: undefined as string | undefined,
      linkedin_url: undefined as string | undefined,
      title: undefined as string | undefined,
    };
    for (const e of group.events) {
      const ext = extractContactFromEvent({
        id: e.id,
        source: e.source,
        event_type: e.event_type,
        payload: e.payload,
        received_at: e.received_at,
        processed: false,
      });
      seed.email = seed.email || ext.email;
      seed.first_name = seed.first_name || ext.first_name;
      seed.last_name = seed.last_name || ext.last_name;
      seed.company = seed.company || ext.company;
      seed.phone = seed.phone || ext.phone;
      seed.linkedin_url = seed.linkedin_url || ext.linkedin_url;
      seed.title = seed.title || ext.title;
    }

    // Cache-first source enrichment: resolveOrCreateIdentity then cache seed fields.
    const identity = await resolveOrCreateIdentity(group.key, latest.source);
    const enriched = await getOrEnrichIdentity(identity, {
      email: seed.email || null,
      first_name: seed.first_name || null,
      last_name: seed.last_name || null,
      company: seed.company || null,
      phone: seed.phone || null,
      linkedin_url: seed.linkedin_url || null,
      title: seed.title || null,
    });

    if (enriched.from_cache) fromCache += 1;
    else freshlyEnriched += 1;

    // Mirror the pipeline's skip gates. These contacts will never land
    // in Attio at replay time, so they must not show up in the dry-run
    // projection either.
    const hasAnyUsefulField = Boolean(
      enriched.email ||
        enriched.phone ||
        enriched.linkedin_url ||
        enriched.first_name ||
        enriched.last_name
    );
    const zoomPhoneUnenrichable = latest.source === "zoom_phone";
    if (zoomPhoneUnenrichable) {
      skippedUnenrichable.zoom_phone_no_email += 1;
      skippedUnenrichable.total += 1;
      continue;
    }
    if (!hasAnyUsefulField) {
      skippedUnenrichable.empty_ghost += 1;
      skippedUnenrichable.total += 1;
      continue;
    }

    contacts.push({
      identity_key: group.key,
      event_count: group.events.length,
      sources: Array.from(group.sources),
      first_name: enriched.first_name,
      last_name: enriched.last_name,
      email: enriched.email,
      phone: enriched.phone,
      linkedin_url: enriched.linkedin_url,
      company: enriched.company,
      title: enriched.title,
      enrichment_source: enriched.source,
      enrichment_from_cache: enriched.from_cache,
    });

    const classification = classifyEvent(latestEvent);
    deals.push({
      identity_key: group.key,
      title: classification.deal_title,
      stage: classification.deal_stage,
      sentiment: classification.sentiment,
      pricing_discussed: classification.pricing_discussed,
      latest_event_source: latest.source,
      latest_event_type: latest.event_type,
      latest_event_at: latest.received_at,
    });
  }

  // Sort for stable output
  contacts.sort((a, b) => (a.email || a.identity_key).localeCompare(b.email || b.identity_key));
  deals.sort((a, b) => a.identity_key.localeCompare(b.identity_key));

  const report: DryRunReport = {
    total_events: rows.length,
    projected_person_count: contacts.length,
    events_by_source: eventsBySource,
    events_skipped_noise: skippedNoise,
    contacts_skipped_unenrichable: skippedUnenrichable,
    unresolved_events: unresolved,
    enrichment_summary: {
      from_cache: fromCache,
      freshly_enriched: freshlyEnriched,
      cache_miss_api_calls: 0,
    },
    meeting_resolution_summary: meetingSummary,
    contacts,
    deals,
  };

  logger.info("Dry-run complete", {
    total: report.total_events,
    projected: report.projected_person_count,
    unresolved: report.unresolved_events.length,
    fromCache,
    freshlyEnriched,
  });

  return report;
}

function reasonForNoKey(source: EventSource): string {
  switch (source) {
    case "smartlead":
      return "smartlead_no_email";
    case "heyreach":
      return "heyreach_no_linkedin_or_email";
    case "gmail":
      return "gmail_no_counterparty_email";
    case "zoom_phone":
      return "zoom_phone_no_external_number";
    case "zoom_meeting":
      return "zoom_meeting_no_attendee_email";
  }
}

// ---- Phase B: WIPE ----

export interface WipeReport {
  attio_people_deleted: number;
  attio_deals_deleted: number;
  attio_companies_deleted: number;
  identity_map_cleared: boolean;
  review_queue_cleared: boolean;
  webhook_events_reset: number;
}

// Attio allows ~60 req/min. Batch + sleep to stay safely under.
const BATCH_SIZE = 50;
const SLEEP_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function deleteInBatches<T>(
  items: Array<{ id: string }>,
  deleter: (id: string) => Promise<void>,
  label: string
): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    for (const item of batch) {
      try {
        await deleter(item.id);
        deleted += 1;
      } catch (err) {
        logger.warn(`${label} delete failed`, { id: item.id, error: String(err) });
      }
    }
    logger.info(`${label}: deleted ${deleted}/${items.length}`);
    if (i + BATCH_SIZE < items.length) await sleep(SLEEP_MS);
  }
  return deleted;
}

export async function wipe(): Promise<WipeReport> {
  logger.warn("FULL REBUILD — WIPE starting");

  const people = await listAllPeople();
  const deals = await listAllDealRecords();
  const companies = await listAllCompanies();
  logger.info("Attio counts before wipe", {
    people: people.length,
    deals: deals.length,
    companies: companies.length,
  });

  // Delete deals first (reference people), then people, then companies.
  const dealsDeleted = await deleteInBatches(deals, deleteDeal, "deals");
  const peopleDeleted = await deleteInBatches(people, deletePerson, "people");
  const companiesDeleted = await deleteInBatches(companies, deleteCompany, "companies");

  const supabase = getSupabase();

  // IMPORTANT: do NOT truncate identity_map.
  // We only null out the Attio foreign keys so the enrichment cache
  // (enriched_email/phone/linkedin/company/title) survives the wipe.
  // Next replay reads cached rows → zero LeadMagic calls.
  const { error: idErr } = await supabase
    .from("identity_map")
    .update({
      attio_person_id: null,
      attio_deal_id: null,
      attio_company_id: null,
      updated_at: new Date().toISOString(),
    })
    .neq("id", "00000000-0000-0000-0000-000000000000");
  if (idErr) logger.warn("identity_map attio-id reset failed", { error: idErr.message });

  // meeting_links cache and review_queue are also safe to preserve,
  // but review_queue we clear so old unresolved rows don't linger.
  await supabase.from("review_queue").delete().neq("id", "00000000-0000-0000-0000-000000000000");

  const { data: resetData, error: resetErr } = await supabase
    .from("webhook_events")
    .update({ processed: false, processed_at: null, identity_key: null, identity_resolved_at: null })
    .neq("id", "00000000-0000-0000-0000-000000000000")
    .select("id");
  if (resetErr) logger.warn("webhook_events reset failed", { error: resetErr.message });

  logger.warn("FULL REBUILD — WIPE complete");
  return {
    attio_people_deleted: peopleDeleted,
    attio_deals_deleted: dealsDeleted,
    attio_companies_deleted: companiesDeleted,
    identity_map_cleared: !idErr,
    review_queue_cleared: true,
    webhook_events_reset: (resetData || []).length,
  };
}

// ---- Phase C: REPLAY ----

export interface ReplayReport {
  total_events: number;
  resolved_events: number;
  unresolved_events: number;
  errors: number;
}

export async function replay(): Promise<ReplayReport> {
  logger.warn("FULL REBUILD — REPLAY starting");
  const supabase = getSupabase();

  const { data: events, error } = await supabase
    .from("webhook_events")
    .select("id, source, payload")
    .order("received_at", { ascending: true });
  if (error) throw error;

  const report: ReplayReport = {
    total_events: (events || []).length,
    resolved_events: 0,
    unresolved_events: 0,
    errors: 0,
  };

  for (const row of (events || []) as Array<{
    id: string;
    source: EventSource;
    payload: Record<string, unknown>;
  }>) {
    try {
      let payload = row.payload;

      // For zoom_meeting events stored before the cascade existed,
      // re-run the same robust resolver used by dry-run.
      if (row.source === "zoom_meeting" && !payload.resolved_attendee_email) {
        const resolution = await resolveZoomMeetingAttendee({ id: row.id, payload });
        payload = resolution.updated_payload;

        // Pace Gmail calls — stay well under quota.
        await sleep(300);
      }

      const key = computeIdentityKey(row.source, payload);
      await supabase
        .from("webhook_events")
        .update({
          identity_key: key,
          identity_resolved_at: key ? new Date().toISOString() : null,
          processed: false,
        })
        .eq("id", row.id);

      if (key) report.resolved_events += 1;
      else report.unresolved_events += 1;
    } catch (err) {
      report.errors += 1;
      logger.warn("Replay tag failed", { id: row.id, error: String(err) });
    }

    await sleep(50);
  }

  // Push tagged events through the pipeline to Attio.
  const { processEventQueue } = await import("../processors/event-pipeline");
  await processEventQueue();

  logger.warn("FULL REBUILD — REPLAY complete", { ...report });
  return report;
}

// Exposed as unused-event WebhookEvent helper for type compat
export type { WebhookEvent };
