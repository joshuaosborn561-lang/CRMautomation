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
import { computeIdentityKey } from "../services/identity";
import type { EventSource, WebhookEvent } from "@crm-autopilot/shared";

// ============================================================
// Three-phase full rebuild: dry-run → wipe → replay.
// Each endpoint is independent — never auto-chained.
// ============================================================

export interface DryRunReport {
  total_events: number;
  projected_person_count: number;
  events_by_source: Record<string, number>;
  unresolved_events: Array<{ event_id: string; source: string; reason: string }>;
  identity_key_histogram: Array<{ identity_key: string; count: number; sources: string[] }>;
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

  const histogram = new Map<string, { count: number; sources: Set<string> }>();
  const eventsBySource: Record<string, number> = {};
  const unresolved: Array<{ event_id: string; source: string; reason: string }> = [];

  for (const row of rows) {
    eventsBySource[row.source] = (eventsBySource[row.source] || 0) + 1;
    const key = computeIdentityKey(row.source, row.payload);
    if (!key) {
      unresolved.push({
        event_id: row.id,
        source: row.source,
        reason: reasonForNoKey(row.source),
      });
      continue;
    }
    const entry = histogram.get(key) || { count: 0, sources: new Set<string>() };
    entry.count += 1;
    entry.sources.add(row.source);
    histogram.set(key, entry);
  }

  const report: DryRunReport = {
    total_events: rows.length,
    projected_person_count: histogram.size,
    events_by_source: eventsBySource,
    unresolved_events: unresolved,
    identity_key_histogram: Array.from(histogram.entries())
      .map(([k, v]) => ({ identity_key: k, count: v.count, sources: Array.from(v.sources) }))
      .sort((a, b) => b.count - a.count),
  };

  logger.info("Dry-run complete", {
    total: report.total_events,
    projected: report.projected_person_count,
    unresolved: report.unresolved_events.length,
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
  const { error: idErr } = await supabase.from("identity_map").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  if (idErr) logger.warn("identity_map truncate failed", { error: idErr.message });

  await supabase.from("identity_aliases").delete().neq("alias_key", "");
  await supabase.from("meeting_links").delete().neq("zoom_meeting_id", "");
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
