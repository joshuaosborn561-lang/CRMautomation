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
} from "../services/identity";
import { classifyEvent, extractContactFromEvent } from "../services/rules";
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
  contacts: ProjectedContact[];
  deals: ProjectedDeal[];
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

  // Group events by identity_key
  interface Group {
    key: string;
    events: typeof rows;
    sources: Set<string>;
  }
  const groups = new Map<string, Group>();

  for (const row of rows) {
    eventsBySource[row.source] = (eventsBySource[row.source] || 0) + 1;
    const key = computeIdentityKey(row.source, row.payload);
    if (!key) {
      unresolved.push({
        event_id: row.id,
        source: row.source,
        event_type: row.event_type,
        reason: reasonForNoKey(row.source),
      });
      continue;
    }
    const group = groups.get(key) || { key, events: [], sources: new Set<string>() };
    group.events.push(row);
    group.sources.add(row.source);
    groups.set(key, group);
  }

  const contacts: ProjectedContact[] = [];
  const deals: ProjectedDeal[] = [];
  let fromCache = 0;
  let freshlyEnriched = 0;

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

    // Cache-first: resolveOrCreateIdentity then getOrEnrichIdentity.
    // This CREATES the identity_map row if missing — which is fine for
    // dry-run because replay will just read the same row.
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
    unresolved_events: unresolved,
    enrichment_summary: {
      from_cache: fromCache,
      freshly_enriched: freshlyEnriched,
      cache_miss_api_calls: freshlyEnriched,
    },
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

  // Re-tag webhook_events with identity_key before the pipeline consumes them.
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
      const key = computeIdentityKey(row.source, row.payload);
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
    // Gmail quota hygiene — tiny pause between events.
    await sleep(50);
  }

  // Now actually run the pipeline to push events into Attio.
  const { processEventQueue } = await import("../processors/event-pipeline");
  await processEventQueue();

  logger.warn("FULL REBUILD — REPLAY complete", { ...report });
  return report;
}

// Exposed as unused-event WebhookEvent helper for type compat
export type { WebhookEvent };
