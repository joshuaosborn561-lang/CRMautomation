import { getSupabase } from "../utils/supabase";
import { logger } from "../utils/logger";
import type { EventSource, WebhookEvent } from "@crm-autopilot/shared";

// ============================================================
// Identity resolution — single dedup enforcement point.
// ============================================================

export type IdentityHint = {
  email?: string;
  first_name?: string;
  last_name?: string;
  company?: string;
  phone?: string;
  linkedin_url?: string;
  title?: string;
  lead_source?: string;
};

/**
 * Compute a durable identity key for a webhook event payload.
 *
 * Keys are source-prefixed:
 *   email:<lowercased_email>
 *   phone:<e164>
 *   linkedin:<normalized_url>
 *
 * Returns null when no reliable identifier is present — the caller
 * should route the event to the review queue instead of Attio.
 */
export function computeIdentityKey(
  source: EventSource,
  payload: Record<string, unknown>
): string | null {
  switch (source) {
    case "smartlead": {
      const email =
        (payload.lead_email as string | undefined) ||
        (payload.email as string | undefined);
      return email ? emailKey(email) : null;
    }

    case "heyreach": {
      const linkedin =
        (payload.linkedin_url as string | undefined) ||
        (payload.profile_url as string | undefined);
      if (linkedin) return linkedinKey(linkedin);
      const email = payload.email as string | undefined;
      return email ? emailKey(email) : null;
    }

    case "gmail": {
      // Use the non-own-domain address. If the user sent it, identity
      // is the recipient; if they received it, identity is the sender.
      const ownDomain = (process.env.OWN_EMAIL_DOMAIN || "salesglidergrowth.com").toLowerCase();
      const from = (payload.from as string | undefined) || "";
      const to = (payload.to as string | undefined) || "";
      const fromAddr = extractEmailAddress(from);
      const toAddr = extractEmailAddress(to);
      const fromIsOwn = fromAddr ? fromAddr.toLowerCase().endsWith(`@${ownDomain}`) : true;
      const counterparty = fromIsOwn ? toAddr : fromAddr;
      return counterparty ? emailKey(counterparty) : null;
    }

    case "zoom_phone": {
      const obj = (payload.payload as Record<string, unknown> | undefined)?.object as
        | Record<string, unknown>
        | undefined;
      const caller = obj?.caller as Record<string, unknown> | undefined;
      const callee = obj?.callee as Record<string, unknown> | undefined;
      // External party is the pstn participant; internal is "user".
      const external =
        caller?.extension_type === "pstn"
          ? caller
          : callee?.extension_type === "pstn"
            ? callee
            : null;
      const phone = (external?.phone_number as string | undefined) || null;
      return phone ? phoneKey(phone) : null;
    }

    case "zoom_meeting": {
      // Zoom webhooks don't include attendee emails. The caller
      // (webhooks/zoom.ts) must run the Gmail-invite cascade and
      // stash the resolved email under `resolved_attendee_email`
      // before the payload reaches this function.
      const resolved = payload.resolved_attendee_email as string | undefined;
      return resolved ? emailKey(resolved) : null;
    }
  }
}

/** email:<lowercased> */
export function emailKey(email: string): string {
  return `email:${email.trim().toLowerCase()}`;
}

/** phone:<digits-only with leading +1 if US 10-digit> */
export function phoneKey(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (!digits) return `phone:${phone}`;
  // Normalize 10-digit US numbers to E.164
  const e164 = digits.length === 10 ? `+1${digits}` : digits.startsWith("1") && digits.length === 11 ? `+${digits}` : `+${digits}`;
  return `phone:${e164}`;
}

/** linkedin:<path-only, lowercased, trailing slash stripped> */
export function linkedinKey(url: string): string {
  const normalized = url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?linkedin\.com\//, "")
    .replace(/\/+$/, "")
    .replace(/\?.*$/, "");
  return `linkedin:${normalized}`;
}

/** Extract "foo@bar.com" from "Foo Bar <foo@bar.com>" or just "foo@bar.com". */
export function extractEmailAddress(header: string): string | null {
  if (!header) return null;
  const match = header.match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/);
  return match ? match[0] : null;
}

// ============================================================
// Resolve-or-create against identity_map.
// Uses the Postgres RPC resolve_or_create_identity() which
// holds an advisory lock so parallel webhook deliveries for
// the same key serialize at the DB layer.
// ============================================================

export interface ResolvedIdentity {
  id: string;
  attio_person_id: string | null;
  attio_deal_id: string | null;
  attio_company_id: string | null;
  is_new: boolean;
}

export async function findIdentity(identityKey: string): Promise<ResolvedIdentity | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("identity_map")
    .select("id, attio_person_id, attio_deal_id, attio_company_id")
    .eq("identity_key", identityKey)
    .maybeSingle();
  if (error || !data) return null;
  return {
    id: data.id,
    attio_person_id: data.attio_person_id,
    attio_deal_id: data.attio_deal_id,
    attio_company_id: data.attio_company_id,
    is_new: false,
  };
}

/**
 * Create an identity_map row (or return existing), keyed on identity_key.
 * Relies on the UNIQUE(identity_key) constraint + upsert to serialize.
 */
export async function resolveOrCreateIdentity(
  identityKey: string,
  source: EventSource
): Promise<ResolvedIdentity> {
  const supabase = getSupabase();

  // Try to read first — fast path for already-known identities.
  const existing = await findIdentity(identityKey);
  if (existing) return existing;

  // Upsert so concurrent callers for the same key don't both insert.
  const { data, error } = await supabase
    .from("identity_map")
    .upsert(
      { identity_key: identityKey, source },
      { onConflict: "identity_key", ignoreDuplicates: false }
    )
    .select("id, attio_person_id, attio_deal_id, attio_company_id")
    .single();

  if (error || !data) {
    // Race: another call inserted between our SELECT and UPSERT — re-read.
    const again = await findIdentity(identityKey);
    if (again) return again;
    throw new Error(`resolveOrCreateIdentity failed for ${identityKey}: ${error?.message || "unknown"}`);
  }

  return {
    id: data.id,
    attio_person_id: data.attio_person_id,
    attio_deal_id: data.attio_deal_id,
    attio_company_id: data.attio_company_id,
    is_new: !data.attio_person_id,
  };
}

export async function updateIdentityAttioIds(
  identityId: string,
  ids: { attio_person_id?: string | null; attio_deal_id?: string | null; attio_company_id?: string | null }
): Promise<void> {
  const supabase = getSupabase();
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (ids.attio_person_id !== undefined) patch.attio_person_id = ids.attio_person_id;
  if (ids.attio_deal_id !== undefined) patch.attio_deal_id = ids.attio_deal_id;
  if (ids.attio_company_id !== undefined) patch.attio_company_id = ids.attio_company_id;
  const { error } = await supabase.from("identity_map").update(patch).eq("id", identityId);
  if (error) logger.warn("Failed to update identity_map Attio ids", { identityId, error: error.message });
}

export async function addAlias(
  canonicalId: string,
  aliasKey: string,
  source: EventSource
): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from("identity_aliases")
    .upsert({ alias_key: aliasKey, canonical_id: canonicalId, source }, { onConflict: "alias_key" });
  if (error) logger.warn("Failed to add identity alias", { aliasKey, error: error.message });
}

// ============================================================
// Meeting-links cache — Zoom meeting id → attendee email,
// populated from Gmail messages containing zoom.us/j/ URLs.
// ============================================================

export async function lookupMeetingLink(
  zoomMeetingId: string
): Promise<{ attendee_email: string; gmail_message_id: string | null } | null> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from("meeting_links")
    .select("attendee_email, gmail_message_id")
    .eq("zoom_meeting_id", zoomMeetingId)
    .maybeSingle();
  return data ? { attendee_email: data.attendee_email, gmail_message_id: data.gmail_message_id } : null;
}

export async function upsertMeetingLink(link: {
  zoom_meeting_id: string;
  attendee_email: string;
  gmail_message_id?: string | null;
  meeting_topic?: string | null;
}): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from("meeting_links")
    .upsert(
      {
        zoom_meeting_id: link.zoom_meeting_id,
        attendee_email: link.attendee_email.toLowerCase(),
        gmail_message_id: link.gmail_message_id || null,
        meeting_topic: link.meeting_topic || null,
      },
      { onConflict: "zoom_meeting_id" }
    );
  if (error) logger.warn("Failed to upsert meeting_link", { link, error: error.message });
}

/**
 * Extract Zoom meeting IDs from an arbitrary text blob (email body).
 * Matches https://*.zoom.us/j/{digits}, common in Gmail invite bodies.
 */
export function extractZoomMeetingIds(text: string): string[] {
  if (!text) return [];
  const matches = text.matchAll(/https?:\/\/[a-z0-9.\-]*zoom\.us\/j\/(\d+)/gi);
  const ids = new Set<string>();
  for (const m of matches) ids.add(m[1]);
  return Array.from(ids);
}

/** Convenience: hint derived from a WebhookEvent payload for review_queue rows. */
export function buildIdentityHint(event: WebhookEvent): IdentityHint {
  const p = event.payload || {};
  const hint: IdentityHint = {};
  if (p.email || p.lead_email) hint.email = (p.email || p.lead_email) as string;
  if (p.name || p.lead_name || p.contact_name) hint.first_name = (p.name || p.lead_name || p.contact_name) as string;
  if (p.company || p.company_name) hint.company = (p.company || p.company_name) as string;
  if (p.linkedin_url || p.profile_url) hint.linkedin_url = (p.linkedin_url || p.profile_url) as string;
  if (event.source === "zoom_meeting") {
    const obj = (p.payload as Record<string, unknown> | undefined)?.object as Record<string, unknown> | undefined;
    if (obj?.topic) hint.first_name = hint.first_name || (obj.topic as string);
  }
  return hint;
}
