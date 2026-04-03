import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "../config";
import { logger } from "../utils/logger";
import type {
  AIProcessingResult,
  EventSource,
  WebhookEvent,
} from "@crm-autopilot/shared";

let _client: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (!_client) {
    const config = getConfig();
    _client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  }
  return _client;
}

const SYSTEM_PROMPT = `You are an AI assistant for a B2B outbound agency founder's CRM automation system.
Your job is to analyze sales interaction events and determine:

1. Contact information (extract from the event data)
2. Deal stage (where this prospect is in the pipeline)
3. A human-readable note summarizing what happened
4. Whether a follow-up task should be created

Deal stages (in order of progression):
- replied_showed_interest: First positive reply from cold email, LinkedIn accept/reply, or cold call interest
- call_meeting_booked: Calendar invite sent or meeting scheduled
- discovery_completed: Discovery call/meeting completed
- proposal_sent: Proposal/pricing discussed or sent
- negotiating: Back-and-forth on terms
- closed_won: Deal signed
- closed_lost: Explicit rejection or disqualification
- nurture: Engaged then went silent 5+ days (you won't set this - the nurture engine handles it)

Rules:
- Only advance the deal stage, never move it backwards (unless to closed_lost or nurture)
- If pricing/budget was discussed, mark pricing_discussed as true
- IMPORTANT: Extract the deal value (monthly price) and term length (in months) when mentioned.
  The founder almost always states the price and term length during calls. Look for dollar amounts,
  monthly/annual pricing, and contract duration (e.g. "3 months at $2,500/month" → value: 2500, term_months: 3).
  If only a total is mentioned (e.g. "$15,000 for 6 months"), calculate the monthly rate (value: 2500, term_months: 6).
- Be specific in your summaries - include key details from the conversation
- Suggest concrete next actions when creating tasks
- Determine sentiment: positive (interested, engaged), neutral (noncommittal), negative (objection, not interested)

Respond with valid JSON matching the AIProcessingResult schema.`;

export async function processEvent(event: WebhookEvent): Promise<AIProcessingResult> {
  const client = getAnthropicClient();

  const userPrompt = buildPrompt(event);

  const model = "claude-haiku-4-5-20251001";

  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: userPrompt,
      },
    ],
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  // Extract JSON from response (handle markdown code blocks)
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    logger.error("Failed to parse AI response as JSON", { text });
    throw new Error("AI response was not valid JSON");
  }

  const jsonStr = jsonMatch[1] || jsonMatch[0];
  const result = JSON.parse(jsonStr) as AIProcessingResult;
  result.event_id = event.id;

  logger.info("AI processed event", {
    eventId: event.id,
    source: event.source,
    stage: result.deal.stage,
    sentiment: result.note.sentiment,
  });

  return result;
}

function buildPrompt(event: WebhookEvent): string {
  const source = event.source;
  const payload = event.payload;

  let context = "";

  switch (source) {
    case "smartlead":
      context = buildSmartLeadContext(payload);
      break;
    case "heyreach":
      context = buildHeyReachContext(payload);
      break;
    case "zoom_phone":
      context = buildZoomPhoneContext(payload);
      break;
    case "zoom_meeting":
      context = buildZoomMeetingContext(payload);
      break;
    case "gmail":
      context = buildGmailContext(payload);
      break;
    default:
      context = `Unknown source: ${source}\n${JSON.stringify(payload, null, 2)}`;
  }

  return `Analyze this sales interaction event and provide the structured result.

Source: ${source}
Event Type: ${event.event_type}
Received: ${event.received_at}

${context}

Respond with a JSON object matching this schema:
{
  "event_id": "${event.id}",
  "contact": {
    "email": "string (required)",
    "first_name": "string (optional)",
    "last_name": "string (optional)",
    "company": "string (optional)",
    "linkedin_url": "string (optional)",
    "phone": "string (optional)"
  },
  "deal": {
    "title": "string - name for this deal, typically 'Company Name - Service'",
    "stage": "one of the deal stages",
    "stage_reason": "string - why this stage was chosen",
    "value": "number (optional) - monthly price in USD if mentioned (e.g. 2500 for $2,500/mo)",
    "term_months": "number (optional) - contract term length in months if mentioned"
  },
  "note": {
    "summary": "string - human-readable summary of the interaction",
    "sentiment": "positive | neutral | negative",
    "pricing_discussed": false,
    "next_steps": "string (optional) - suggested next action"
  },
  "task": {
    "title": "string - follow-up task title (optional, only if warranted)",
    "description": "string - task details",
    "due_date": "ISO date string (optional)"
  }
}`;
}

function buildSmartLeadContext(payload: Record<string, unknown>): string {
  return `SmartLead Email Reply Event:
- Lead Email: ${payload.email || payload.lead_email || "unknown"}
- Lead Name: ${payload.name || payload.lead_name || "unknown"}
- Company: ${payload.company || payload.company_name || "unknown"}
- Campaign: ${payload.campaign_name || payload.campaign_id || "unknown"}
- Reply Text: ${payload.reply || payload.message || payload.text || JSON.stringify(payload)}
- Category: ${payload.category || payload.reply_category || "unknown"}`;
}

function buildHeyReachContext(payload: Record<string, unknown>): string {
  return `HeyReach LinkedIn Event:
- Contact Name: ${payload.contact_name || payload.name || "unknown"}
- LinkedIn URL: ${payload.linkedin_url || payload.profile_url || "unknown"}
- Email: ${payload.email || "unknown"}
- Company: ${payload.company || "unknown"}
- Event: ${payload.event_type || payload.action || "unknown"}
- Message: ${payload.message || payload.text || "N/A"}`;
}

function buildZoomPhoneContext(payload: Record<string, unknown>): string {
  const p = payload.payload as Record<string, unknown> | undefined;
  const obj = p?.object as Record<string, unknown> | undefined;
  const callDetails = payload.call_details as Record<string, unknown> | undefined;
  const transcript = payload.transcript as string | undefined;
  const apolloContact = (payload.enriched_contact || payload.apollo_contact) as Record<string, unknown> | undefined;

  let context = `Zoom Phone Call Event:
- Caller: ${callDetails?.caller_number || obj?.caller_number || "unknown"} (${callDetails?.caller_name || obj?.caller_name || "unknown"})
- Callee: ${callDetails?.callee_number || obj?.callee_number || "unknown"} (${callDetails?.callee_name || obj?.callee_name || "unknown"})
- Direction: ${callDetails?.direction || obj?.direction || "unknown"}
- Duration: ${callDetails?.duration || obj?.duration || "unknown"} seconds
- Date/Time: ${callDetails?.date_time || obj?.date_time || "unknown"}
- Call Result: ${callDetails?.result || "unknown"}`;

  if (apolloContact) {
    context += `

LEAD IDENTIFIED VIA LEADMAGIC (enriched contact data):
- Name: ${apolloContact.first_name || ""} ${apolloContact.last_name || ""} (${apolloContact.name || ""})
- Email: ${apolloContact.email || "unknown"}
- Company: ${apolloContact.company || "unknown"}
- Title: ${apolloContact.title || "unknown"}
- LinkedIn: ${apolloContact.linkedin_url || "unknown"}
- Phone: ${apolloContact.phone || "unknown"}

IMPORTANT: Use this enriched contact data for the contact fields in your response. The email is the primary identifier for this lead.`;
  } else {
    context += `

NOTE: No enrichment data found for this phone number. The caller/callee info from Zoom is all we have. If you cannot determine an email address, use the phone number as the identifier and set email to "unknown".`;
  }

  if (transcript) {
    context += `

FULL CALL TRANSCRIPT:
${transcript}

IMPORTANT: You have the full transcript above. Please:
1. Summarize the key points of the conversation (not a verbatim recap — a concise executive summary)
2. Identify the prospect's level of interest and any objections raised
3. Note any specific commitments, next steps, or action items discussed
4. Flag if pricing, budget, timeline, or decision-makers were mentioned
5. Determine the appropriate deal stage based on what was discussed`;
  } else {
    context += `\n- Transcript: Not available (call may not have been recorded, or transcript is still processing)`;
  }

  return context;
}

function buildZoomMeetingContext(payload: Record<string, unknown>): string {
  const p = payload.payload as Record<string, unknown> | undefined;
  const obj = p?.object as Record<string, unknown> | undefined;
  const transcript = payload.transcript as string | undefined;

  let context = `Zoom Meeting Event:
- Meeting Topic: ${obj?.topic || "unknown"}
- Meeting ID: ${obj?.id || "unknown"}
- Host: ${obj?.host_email || "unknown"}
- Duration: ${obj?.duration || "unknown"} minutes
- Participants: ${JSON.stringify((obj as Record<string, unknown>)?.participants || [])}
- Start Time: ${obj?.start_time || "unknown"}`;

  if (transcript) {
    context += `

FULL MEETING TRANSCRIPT:
${transcript}

IMPORTANT: You have the full meeting transcript above. Please:
1. Provide a concise executive summary of the meeting (key discussion points, not verbatim)
2. Identify the prospect's interest level, concerns, and objections
3. Note any commitments, next steps, or action items agreed upon
4. Flag if pricing, budget, timeline, authority, or decision process were discussed
5. Determine the appropriate deal stage based on what was discussed
6. If this was a discovery call, capture the prospect's pain points and needs`;
  } else {
    context += `\n- Transcript: Not available (recording may still be processing — transcripts can take up to 2x the meeting duration)`;
  }

  return context;
}

function buildGmailContext(payload: Record<string, unknown>): string {
  return `Gmail Email Event:
- From: ${payload.from || "unknown"}
- To: ${payload.to || "unknown"}
- Subject: ${payload.subject || "unknown"}
- Date: ${payload.date || "unknown"}
- Thread ID: ${payload.thread_id || "unknown"}

Email Body:
${payload.body || payload.snippet || "Not available"}

IMPORTANT: Analyze this email in the context of a B2B sales pipeline. Determine:
1. Is this from a prospect or someone relevant to a deal?
2. What is the sentiment and intent of the email?
3. Were any commitments, next steps, or action items mentioned?
4. Was pricing, timeline, or decision-making discussed?
If this appears to be a non-sales email (newsletter, notification, internal), set sentiment to "neutral" and note it in the summary.`;
}

// --- Query Processing ---

export async function processQuery(
  query: string,
  pipelineData: string
): Promise<string> {
  const client = getAnthropicClient();

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2048,
    system: `You are a conversational sales pipeline assistant for a B2B outbound agency founder.
Answer questions about their pipeline, deals, and activity in a natural, conversational tone.
Don't dump raw data — interpret it and give actionable insights.
Be concise but thorough. Use specific numbers, names, and dates when available.
If you don't have enough data to answer, say so clearly.`,
    messages: [
      {
        role: "user",
        content: `Here is the current pipeline data:\n\n${pipelineData}\n\nUser question: ${query}`,
      },
    ],
  });

  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}
