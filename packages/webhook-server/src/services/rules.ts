import type { DealStage, EventSource, WebhookEvent } from "@crm-autopilot/shared";
import { extractEmailAddress } from "./identity";

// ============================================================
// Rule engine — replaces Gemini in the main pipeline.
//
// All classification is either:
//   (a) lifted directly from source data, or
//   (b) regex-based on body/subject/transcript.
// No LLM calls.
// ============================================================

export interface ClassificationResult {
  deal_title: string;
  deal_stage: DealStage;
  deal_stage_reason: string;
  sentiment: "positive" | "neutral" | "negative";
  pricing_discussed: boolean;
  deal_value?: number;
  term_months?: number;
}

export interface ExtractedContact {
  email?: string;
  first_name?: string;
  last_name?: string;
  company?: string;
  phone?: string;
  linkedin_url?: string;
  title?: string;
}

// ---- Regex rules ----

const NEGATIVE_RE = /\b(unsubscribe|not interested|no thanks|remove me|stop emailing|take me off|do not contact|please stop)\b/i;
const PRICING_RE = /\$[\d,]+(\.\d+)?|\b\d+\s*(dollars?|usd|per month|\/mo|monthly|retainer)\b/i;
const VALUE_CAPTURE_RE = /\$?\s*([\d,]+(?:\.\d+)?)\s*(?:\/\s*mo|per month|monthly|\/month)/i;
const TERM_CAPTURE_RE = /(\d{1,2})\s*(?:months?|mo\b)/i;

// ---- Entry point ----

export function classifyEvent(event: WebhookEvent): ClassificationResult {
  const contact = extractContactFromEvent(event);
  const body = getBodyText(event);
  const company = contact.company || deriveCompanyFromEmail(contact.email) || "Unknown";

  const pricing = PRICING_RE.test(body);
  const { value, term } = extractDealValue(body);
  const negative = NEGATIVE_RE.test(body);

  switch (event.source) {
    case "smartlead":
      return rulesSmartLead(event, company, body, negative, pricing, value, term);
    case "heyreach":
      return rulesHeyReach(event, company, body, negative, pricing, value, term);
    case "zoom_phone":
      return rulesZoomPhone(event, company, pricing, value, term);
    case "zoom_meeting":
      return rulesZoomMeeting(event, company, pricing, value, term);
    case "gmail":
      return rulesGmail(event, company, body, negative, pricing, value, term);
  }
}

// ---- Per-source rules ----

function rulesSmartLead(
  event: WebhookEvent,
  company: string,
  body: string,
  negative: boolean,
  pricing: boolean,
  value?: number,
  term?: number
): ClassificationResult {
  const category = ((event.payload.category || event.payload.reply_category) as string | undefined)?.toLowerCase() || "";
  const isNegative = negative || category.includes("not interested") || category.includes("unsubscribe");

  if (isNegative) {
    return {
      deal_title: `${company} - Outbound Reply`,
      deal_stage: "closed_lost",
      deal_stage_reason: "Negative reply detected",
      sentiment: "negative",
      pricing_discussed: false,
    };
  }

  return {
    deal_title: `${company} - Outbound Reply`,
    deal_stage: pricing ? "proposal_sent" : "replied_showed_interest",
    deal_stage_reason: pricing ? "Pricing discussed in reply" : "Positive SmartLead reply",
    sentiment: "positive",
    pricing_discussed: pricing,
    deal_value: value,
    term_months: term,
  };
}

function rulesHeyReach(
  event: WebhookEvent,
  company: string,
  body: string,
  negative: boolean,
  pricing: boolean,
  value?: number,
  term?: number
): ClassificationResult {
  if (negative) {
    return {
      deal_title: `${company} - LinkedIn`,
      deal_stage: "closed_lost",
      deal_stage_reason: "LinkedIn reply indicated not interested",
      sentiment: "negative",
      pricing_discussed: false,
    };
  }

  const eventType = (event.event_type || "").toLowerCase();
  const isReply = eventType.includes("reply") || eventType.includes("message_received");

  return {
    deal_title: `${company} - LinkedIn`,
    deal_stage: pricing ? "proposal_sent" : "replied_showed_interest",
    deal_stage_reason: isReply ? "LinkedIn reply" : "LinkedIn connection accepted",
    sentiment: "positive",
    pricing_discussed: pricing,
    deal_value: value,
    term_months: term,
  };
}

function rulesZoomPhone(
  event: WebhookEvent,
  company: string,
  pricing: boolean,
  value?: number,
  term?: number
): ClassificationResult {
  const obj = (event.payload.payload as Record<string, unknown> | undefined)?.object as Record<string, unknown> | undefined;
  const callDetails = event.payload.call_details as Record<string, unknown> | undefined;
  const duration = (obj?.duration as number | undefined) ?? (callDetails?.duration as number | undefined) ?? 0;
  const result = ((obj?.handup_result || callDetails?.result || "") as string).toLowerCase();
  const answered = duration >= 30 && !result.includes("voicemail") && !result.includes("no_answer");

  if (!answered) {
    return {
      deal_title: `${company} - Phone Call`,
      deal_stage: "replied_showed_interest",
      deal_stage_reason: "Outbound call, no answer or short duration",
      sentiment: "neutral",
      pricing_discussed: false,
    };
  }

  return {
    deal_title: `${company} - Phone Call`,
    deal_stage: pricing ? "proposal_sent" : "replied_showed_interest",
    deal_stage_reason: `Connected call, duration ${duration}s`,
    sentiment: "positive",
    pricing_discussed: pricing,
    deal_value: value,
    term_months: term,
  };
}

function rulesZoomMeeting(
  event: WebhookEvent,
  company: string,
  pricing: boolean,
  value?: number,
  term?: number
): ClassificationResult {
  return {
    deal_title: `${company} - Discovery Call`,
    deal_stage: pricing ? "proposal_sent" : "discovery_completed",
    deal_stage_reason: pricing ? "Pricing discussed in meeting" : "Discovery meeting completed",
    sentiment: "positive",
    pricing_discussed: pricing,
    deal_value: value,
    term_months: term,
  };
}

function rulesGmail(
  event: WebhookEvent,
  company: string,
  body: string,
  negative: boolean,
  pricing: boolean,
  value?: number,
  term?: number
): ClassificationResult {
  if (negative) {
    return {
      deal_title: `${company} - Email Thread`,
      deal_stage: "closed_lost",
      deal_stage_reason: "Email contained unsubscribe/negative keywords",
      sentiment: "negative",
      pricing_discussed: false,
    };
  }

  return {
    deal_title: `${company} - Email Thread`,
    deal_stage: pricing ? "proposal_sent" : "replied_showed_interest",
    deal_stage_reason: pricing ? "Pricing discussed over email" : "Inbound email from prospect",
    sentiment: "positive",
    pricing_discussed: pricing,
    deal_value: value,
    term_months: term,
  };
}

// ---- Contact extraction from source payload ----

export function extractContactFromEvent(event: WebhookEvent): ExtractedContact {
  const p = event.payload || {};

  // If webhooks layer already attached enriched contact data, prefer it.
  const enriched = (p.enriched_contact || p.apollo_contact) as Record<string, unknown> | undefined;

  const contact: ExtractedContact = {};

  switch (event.source) {
    case "smartlead": {
      contact.email = (p.email || p.lead_email) as string | undefined;
      const name = ((p.name || p.lead_name) as string | undefined) || "";
      const parts = name.trim().split(/\s+/);
      if (parts.length > 0 && parts[0]) contact.first_name = parts[0];
      if (parts.length > 1) contact.last_name = parts.slice(1).join(" ");
      contact.company = (p.company || p.company_name) as string | undefined;
      break;
    }
    case "heyreach": {
      contact.email = p.email as string | undefined;
      const name = ((p.contact_name || p.name) as string | undefined) || "";
      const parts = name.trim().split(/\s+/);
      if (parts.length > 0 && parts[0]) contact.first_name = parts[0];
      if (parts.length > 1) contact.last_name = parts.slice(1).join(" ");
      contact.company = p.company as string | undefined;
      contact.linkedin_url = (p.linkedin_url || p.profile_url) as string | undefined;
      break;
    }
    case "gmail": {
      const ownDomain = (process.env.OWN_EMAIL_DOMAIN || "salesglidergrowth.com").toLowerCase();
      const from = (p.from as string | undefined) || "";
      const to = (p.to as string | undefined) || "";
      const fromAddr = extractEmailAddress(from);
      const toAddr = extractEmailAddress(to);
      const fromIsOwn = fromAddr ? fromAddr.toLowerCase().endsWith(`@${ownDomain}`) : true;
      const counterparty = fromIsOwn ? toAddr : fromAddr;
      const counterpartyHeader = fromIsOwn ? to : from;
      contact.email = counterparty || undefined;
      // Parse "Firstname Lastname <addr@x>" display name
      const displayMatch = counterpartyHeader.match(/^"?([^"<]+?)"?\s*<?[^<>]*>?$/);
      if (displayMatch) {
        const name = displayMatch[1].trim();
        if (name && !name.includes("@")) {
          const parts = name.split(/\s+/);
          if (parts[0]) contact.first_name = parts[0];
          if (parts.length > 1) contact.last_name = parts.slice(1).join(" ");
        }
      }
      break;
    }
    case "zoom_phone": {
      const obj = (p.payload as Record<string, unknown> | undefined)?.object as Record<string, unknown> | undefined;
      const caller = obj?.caller as Record<string, unknown> | undefined;
      const callee = obj?.callee as Record<string, unknown> | undefined;
      const external = caller?.extension_type === "pstn" ? caller : callee?.extension_type === "pstn" ? callee : null;
      if (external) {
        contact.phone = external.phone_number as string | undefined;
        const name = (external.name as string | undefined) || "";
        const parts = name.trim().split(/\s+/);
        if (parts[0]) contact.first_name = parts[0];
        if (parts.length > 1) contact.last_name = parts.slice(1).join(" ");
      }
      break;
    }
    case "zoom_meeting": {
      // For meetings, the identity layer already resolved the attendee email
      // (from Gmail invite cascade) and stashed it here.
      contact.email = p.resolved_attendee_email as string | undefined;
      const displayName = p.resolved_attendee_name as string | undefined;
      if (displayName) {
        const parts = displayName.trim().split(/\s+/);
        if (parts[0]) contact.first_name = parts[0];
        if (parts.length > 1) contact.last_name = parts.slice(1).join(" ");
      }
      break;
    }
  }

  // Overlay enriched data (from webhook-time enrichment like LeadMagic)
  if (enriched) {
    contact.email = (enriched.email as string | undefined) || contact.email;
    contact.first_name = (enriched.first_name as string | undefined) || contact.first_name;
    contact.last_name = (enriched.last_name as string | undefined) || contact.last_name;
    contact.company = (enriched.company as string | undefined) || contact.company;
    contact.title = (enriched.title as string | undefined) || contact.title;
    contact.linkedin_url = (enriched.linkedin_url as string | undefined) || contact.linkedin_url;
    contact.phone = (enriched.phone as string | undefined) || contact.phone;
  }

  return contact;
}

// ---- Note body — verbatim, no LLM summarization ----

export function buildNoteBody(event: WebhookEvent): string {
  const p = event.payload || {};
  const parts: string[] = [];

  // Zoom AI Companion summary — verbatim, with share URL.
  if (p.zoom_ai_summary_url) parts.push(`Zoom AI Summary: ${p.zoom_ai_summary_url}`);
  if (p.zoom_ai_summary) parts.push(String(p.zoom_ai_summary));

  if (parts.length > 0) return parts.join("\n\n");

  // No Zoom summary — fall back to raw source content.
  switch (event.source) {
    case "smartlead": {
      const reply = (p.reply || p.message || p.text || "") as string;
      const category = (p.category || p.reply_category || "") as string;
      return [
        category ? `Category: ${category}` : null,
        reply ? `Reply:\n${reply}` : null,
      ]
        .filter(Boolean)
        .join("\n\n");
    }
    case "heyreach": {
      const msg = (p.message || p.text || "") as string;
      const event_type = (p.event_type || p.action || "") as string;
      return [
        event_type ? `LinkedIn: ${event_type}` : null,
        msg ? `Message:\n${msg}` : null,
      ]
        .filter(Boolean)
        .join("\n\n");
    }
    case "zoom_phone": {
      const transcript = (p.transcript as string | undefined) || "";
      const details = (p.call_details as Record<string, unknown> | undefined) || {};
      const direction = (details.direction as string | undefined) || "";
      const duration = (details.duration as number | undefined) || 0;
      const header = `${direction || "call"}, ${duration}s duration`;
      const body = transcript ? transcript.slice(0, 4000) : "No transcript available.";
      return `${header}\n\n${body}`;
    }
    case "zoom_meeting": {
      const transcript = (p.transcript as string | undefined) || "";
      return transcript ? transcript.slice(0, 4000) : "Zoom meeting completed (no transcript or AI summary available).";
    }
    case "gmail": {
      const body = (p.body || p.snippet || "") as string;
      const subject = (p.subject as string | undefined) || "";
      return `Subject: ${subject}\n\n${body}`;
    }
  }
}

// ---- Helpers ----

function getBodyText(event: WebhookEvent): string {
  const p = event.payload || {};
  const chunks: string[] = [];
  if (p.transcript) chunks.push(String(p.transcript));
  if (p.zoom_ai_summary) chunks.push(String(p.zoom_ai_summary));
  if (p.body) chunks.push(String(p.body));
  if (p.snippet) chunks.push(String(p.snippet));
  if (p.subject) chunks.push(String(p.subject));
  if (p.reply) chunks.push(String(p.reply));
  if (p.message) chunks.push(String(p.message));
  if (p.text) chunks.push(String(p.text));
  return chunks.join(" ");
}

function extractDealValue(body: string): { value?: number; term?: number } {
  const vMatch = body.match(VALUE_CAPTURE_RE);
  const tMatch = body.match(TERM_CAPTURE_RE);
  const result: { value?: number; term?: number } = {};
  if (vMatch) {
    const parsed = Number(vMatch[1].replace(/,/g, ""));
    if (!isNaN(parsed) && parsed > 100 && parsed < 1_000_000) result.value = parsed;
  }
  if (tMatch) {
    const parsed = Number(tMatch[1]);
    if (!isNaN(parsed) && parsed > 0 && parsed <= 60) result.term = parsed;
  }
  return result;
}

function deriveCompanyFromEmail(email?: string): string | null {
  if (!email || !email.includes("@")) return null;
  const domain = email.split("@")[1].toLowerCase();
  const free = ["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com", "proton.me", "protonmail.com"];
  if (free.includes(domain)) return null;
  // Strip TLD and title-case the remainder
  const name = domain.replace(/\.[^.]+$/, "").replace(/\.co$/, "");
  return name
    .split(/[.\-_]/)
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}
