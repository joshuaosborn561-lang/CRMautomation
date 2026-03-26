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
- Be specific in your summaries - include key details from the conversation
- Suggest concrete next actions when creating tasks
- Determine sentiment: positive (interested, engaged), neutral (noncommittal), negative (objection, not interested)

Respond with valid JSON matching the AIProcessingResult schema.`;

export async function processEvent(event: WebhookEvent): Promise<AIProcessingResult> {
  const client = getAnthropicClient();

  const userPrompt = buildPrompt(event);

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
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
    case "zoom_mail":
      context = buildZoomMailContext(payload);
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
    "stage_reason": "string - why this stage was chosen"
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
  return `Zoom Phone Call Event:
- Caller: ${obj?.caller_number || "unknown"} (${obj?.caller_name || "unknown"})
- Callee: ${obj?.callee_number || "unknown"} (${obj?.callee_name || "unknown"})
- Direction: ${obj?.direction || "unknown"}
- Duration: ${obj?.duration || "unknown"} seconds
- Date/Time: ${obj?.date_time || "unknown"}
- Transcript: ${(payload as Record<string, unknown>).transcript || "Not available"}`;
}

function buildZoomMeetingContext(payload: Record<string, unknown>): string {
  const p = payload.payload as Record<string, unknown> | undefined;
  const obj = p?.object as Record<string, unknown> | undefined;
  return `Zoom Meeting Event:
- Meeting Topic: ${obj?.topic || "unknown"}
- Meeting ID: ${obj?.id || "unknown"}
- Host: ${obj?.host_email || "unknown"}
- Duration: ${obj?.duration || "unknown"} minutes
- Participants: ${JSON.stringify((obj as Record<string, unknown>)?.participants || [])}
- Start Time: ${obj?.start_time || "unknown"}
- Transcript: ${(payload as Record<string, unknown>).transcript || "Not available"}
- AI Summary: ${(payload as Record<string, unknown>).ai_summary || "Not available"}`;
}

function buildZoomMailContext(payload: Record<string, unknown>): string {
  return `Zoom Mail Event:
- From: ${payload.from || "unknown"}
- To: ${payload.to || "unknown"}
- Subject: ${payload.subject || "unknown"}
- Body Preview: ${payload.body || payload.text || "Not available"}
- Date: ${payload.date || "unknown"}`;
}

// --- Query Processing ---

export async function processQuery(
  query: string,
  pipelineData: string
): Promise<string> {
  const client = getAnthropicClient();

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
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
