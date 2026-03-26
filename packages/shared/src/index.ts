// ============================================================
// CRM Autopilot - Shared Types & Constants
// ============================================================

// --- Deal Stages ---

export const DEAL_STAGES = [
  "replied_showed_interest",
  "call_meeting_booked",
  "discovery_completed",
  "proposal_sent",
  "negotiating",
  "closed_won",
  "closed_lost",
  "nurture",
] as const;

export type DealStage = (typeof DEAL_STAGES)[number];

export const DEAL_STAGE_LABELS: Record<DealStage, string> = {
  replied_showed_interest: "Replied / Showed Interest",
  call_meeting_booked: "Call or Meeting Booked",
  discovery_completed: "Discovery Completed",
  proposal_sent: "Proposal Sent",
  negotiating: "Negotiating",
  closed_won: "Closed Won",
  closed_lost: "Closed Lost",
  nurture: "Nurture",
};

// --- Event Sources ---

export const EVENT_SOURCES = [
  "smartlead",
  "heyreach",
  "zoom_phone",
  "zoom_meeting",
  "zoom_mail",
] as const;

export type EventSource = (typeof EVENT_SOURCES)[number];

// --- Webhook Event (raw, stored in Supabase) ---

export interface WebhookEvent {
  id: string;
  source: EventSource;
  event_type: string;
  payload: Record<string, unknown>;
  received_at: string;
  processed: boolean;
  processed_at?: string;
}

// --- AI Processing Result ---

export interface AIProcessingResult {
  event_id: string;
  contact: {
    email?: string;
    first_name?: string;
    last_name?: string;
    company?: string;
    linkedin_url?: string;
    phone?: string;
  };
  deal: {
    title: string;
    stage: DealStage;
    stage_reason: string;
  };
  note: {
    summary: string;
    sentiment: "positive" | "neutral" | "negative";
    pricing_discussed: boolean;
    next_steps?: string;
  };
  task?: {
    title: string;
    description: string;
    due_date?: string;
  };
  nurture_context?: {
    last_positive_interaction: string;
    what_was_said: string;
    days_since_engagement: number;
  };
}

// --- Review Queue Item ---

export interface ReviewQueueItem {
  id: string;
  event_id: string;
  source: EventSource;
  proposed_action: AIProcessingResult;
  status: "pending" | "approved" | "rejected" | "auto_applied";
  created_at: string;
  reviewed_at?: string;
  reviewer_notes?: string;
}

// --- Interaction Log (timeline per deal) ---

export interface InteractionLog {
  id: string;
  deal_id?: string;
  contact_email: string;
  source: EventSource;
  event_type: string;
  summary: string;
  sentiment: "positive" | "neutral" | "negative";
  raw_event_id: string;
  occurred_at: string;
}

// --- Nurture Tracking ---

export interface NurtureCandidate {
  deal_id: string;
  contact_email: string;
  last_positive_interaction_at: string;
  last_positive_interaction_summary: string;
  last_outbound_at: string;
  days_silent: number;
  nurture_reason: string;
}

// --- Attio Types ---

export interface AttioContact {
  id?: string;
  email: string;
  first_name?: string;
  last_name?: string;
  company?: string;
  phone?: string;
  linkedin_url?: string;
}

export interface AttioDeal {
  id?: string;
  name: string;
  stage: DealStage;
  contact_id: string;
  company?: string;
  value?: number;
}

export interface AttioNote {
  parent_object: "deals" | "contacts";
  parent_id: string;
  title: string;
  content: string;
}

export interface AttioTask {
  title: string;
  description: string;
  linked_deal_id?: string;
  due_date?: string;
}
