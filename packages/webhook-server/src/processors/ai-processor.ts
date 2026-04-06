import { GoogleGenerativeAI } from "@google/generative-ai";
import { getConfig } from "../config";
import { logger } from "../utils/logger";
import type {
  AIProcessingResult,
  EventSource,
  WebhookEvent,
} from "@crm-autopilot/shared";

let _client: GoogleGenerativeAI | null = null;

function getGeminiClient(): GoogleGenerativeAI {
  if (!_client) {
    const config = getConfig();
    _client = new GoogleGenerativeAI(config.GEMINI_API_KEY);
  }
  return _client;
}

const SYSTEM_PROMPT = `You are an AI assistant for a B2B outbound agency founder's CRM automation system.
Your job is to analyze sales interaction events and extract structured data.

CRITICAL EMAIL RULES:
- ONLY use email addresses that are EXPLICITLY present in the event data.
- NEVER fabricate, guess, or construct email addresses. No "firstname@unknown.com" or "name@company.com" guesses.
- If no email address appears in the data, set email to "unknown".
- For Zoom calls: use the enriched_contact email if provided. Otherwise set email to "unknown".
- For Zoom meetings: extract emails from participant lists or host_email. If a participant has no email, set to "unknown".
- The founder's email is joshua@salesglidergrowth.com — SKIP this person, they are the owner not a lead.

CONTACT EXTRACTION:
- Extract the EXTERNAL person (the prospect/lead), not anyone on the SalesGlider team.
- Use enriched_contact data when available — it has the most accurate info.
- For phone calls: the external party has extension_type "pstn". SKIP anyone with extension_type "user" — they are internal team members.
- INTERNAL TEAM MEMBERS TO SKIP (these are NOT prospects):
  * Joshua Osborn (founder) — joshua@salesglidergrowth.com
  * Josiah Peterson (SDR)
  * Noah Brown (SDR)
  * Anyone with a @salesglidergrowth.com email
  * Anyone with extension_type "user" in Zoom data
- If the only people in an event are internal team members, set email to "skip_internal" so the pipeline knows to skip it.
- For meetings: extract the non-founder participant(s).

Deal stages (in order of progression):
- replied_showed_interest: First positive reply from cold email, LinkedIn accept/reply, or cold call pickup
- call_meeting_booked: Calendar invite sent or meeting scheduled
- discovery_completed: Discovery call/meeting completed (ANY completed call or meeting = at least this stage)
- proposal_sent: Proposal/pricing discussed or sent
- negotiating: Back-and-forth on terms
- closed_won: Deal signed
- closed_lost: Explicit rejection or disqualification
- nurture: Engaged then went silent 5+ days (you won't set this - the nurture engine handles it)

SENTIMENT RULES:
- positive: They picked up the phone, attended a meeting, replied with interest, or engaged in conversation
- neutral: No-show, voicemail, automated reply, or unclear intent
- negative: Explicit rejection, "not interested", hung up, asked to be removed
- IMPORTANT: If someone ATTENDED a Zoom meeting or ANSWERED a phone call, that is at minimum "positive" sentiment.
  A completed call or meeting means engagement happened.

DEAL STAGE RULES:
- A completed Zoom meeting = at minimum "discovery_completed"
- A completed phone call where they talked = at minimum "replied_showed_interest"
- If pricing/budget was discussed, mark pricing_discussed as true and stage should be at least "proposal_sent"
- Extract deal value (monthly price) and term length (months) when mentioned.
  Example: "3 months at $2,500/month" → value: 2500, term_months: 3
  Example: "$15,000 for 6 months" → value: 2500, term_months: 6

Respond with valid JSON matching the AIProcessingResult schema. Output ONLY the JSON object, no markdown or extra text.`;

export async function processEvent(event: WebhookEvent): Promise<AIProcessingResult> {
  const client = getGeminiClient();
  const model = client.getGenerativeModel({ model: "gemini-2.5-flash" });

  const userPrompt = buildPrompt(event);

  const callGemini = async (prompt: string, tokens: number): Promise<string> => {
    const r = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      systemInstruction: { role: "model", parts: [{ text: SYSTEM_PROMPT }] },
      generationConfig: {
        maxOutputTokens: tokens,
        temperature: 0.1,
        responseMimeType: "application/json",
      },
    });
    return r.response.text();
  };

  const tryParse = (text: string): AIProcessingResult | null => {
    let jsonStr: string | null = null;
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch) jsonStr = codeBlockMatch[1];
    if (!jsonStr) {
      const objectMatch = text.match(/\{[\s\S]*\}/);
      if (objectMatch) jsonStr = objectMatch[0];
    }
    if (!jsonStr) return null;
    try {
      return JSON.parse(jsonStr) as AIProcessingResult;
    } catch {
      return null;
    }
  };

  // Attempt 1: normal call with 8192 token budget
  let text = await callGemini(userPrompt, 8192);
  logger.info("Raw Gemini response", { text: text.substring(0, 500) });
  let parsed = tryParse(text);

  // Attempt 2: JSON-repair pass
  if (!parsed) {
    logger.warn("Gemini returned unparseable JSON, attempting repair", { textHead: text.substring(0, 200) });
    const repairPrompt = `The following text should be a single JSON object matching the AIProcessingResult schema but is malformed or truncated. Return ONLY valid JSON with no commentary, no markdown fences. Fill any missing required fields with sensible defaults.\n\nBAD TEXT:\n${text}`;
    try {
      const repaired = await callGemini(repairPrompt, 8192);
      parsed = tryParse(repaired);
      if (parsed) logger.info("Gemini JSON repair succeeded", { eventId: event.id });
    } catch (err) {
      logger.warn("Gemini repair call failed", { error: String(err) });
    }
  }

  if (!parsed) {
    logger.error("Failed to parse AI response as JSON after repair", { eventId: event.id, text: text.substring(0, 1000) });
    throw new Error("AI response was not valid JSON");
  }

  parsed.event_id = event.id;

  logger.info("AI processed event", {
    eventId: event.id,
    source: event.source,
    stage: parsed.deal.stage,
    sentiment: parsed.note.sentiment,
  });

  return parsed;
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
  const caller = obj?.caller as Record<string, unknown> | undefined;
  const callee = obj?.callee as Record<string, unknown> | undefined;
  const callDetails = payload.call_details as Record<string, unknown> | undefined;
  const transcript = payload.transcript as string | undefined;
  const enrichedContact = (payload.enriched_contact || payload.apollo_contact) as Record<string, unknown> | undefined;

  // Determine internal vs external party using extension_type
  const isCallerExternal = caller?.extension_type === "pstn";
  const externalParty = isCallerExternal ? caller : callee;
  const internalParty = isCallerExternal ? callee : caller;

  let context = `Zoom Phone Call Event:
- Internal (team member): ${internalParty?.phone_number || "unknown"} (${internalParty?.name || "unknown"})
- External (prospect): ${externalParty?.phone_number || "unknown"} (${externalParty?.name || "unknown"})
- Direction: ${isCallerExternal ? "inbound" : "outbound"}
- Call ID: ${obj?.call_id || "unknown"}
- Call Result: ${obj?.handup_result || callDetails?.result || "unknown"}
- Call End Time: ${obj?.call_end_time || callDetails?.date_time || "unknown"}`;

  if (enrichedContact) {
    context += `

LEAD IDENTIFIED VIA LEADMAGIC (enriched contact data):
- Name: ${enrichedContact.first_name || ""} ${enrichedContact.last_name || ""} (${enrichedContact.name || ""})
- Email: ${enrichedContact.email || "unknown"}
- Company: ${enrichedContact.company || "unknown"}
- Title: ${enrichedContact.title || "unknown"}
- LinkedIn: ${enrichedContact.linkedin_url || "unknown"}
- Phone: ${enrichedContact.phone || "unknown"}

IMPORTANT: Use this enriched contact data for the contact fields in your response. The email from enriched_contact is the ONLY valid email — do not modify or fabricate it.`;
  } else {
    context += `

NOTE: No enrichment data found for this phone number. Set email to "unknown" — do NOT fabricate an email address.`;
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

  // Extract recording/share URLs for notes
  const shareUrl = obj?.share_url as string | undefined;
  const recordingFiles = obj?.recording_files as Array<Record<string, unknown>> | undefined;

  let context = `Zoom Meeting Event:
- Meeting Topic: ${obj?.topic || "unknown"}
- Meeting ID: ${obj?.id || "unknown"}
- Host: ${obj?.host_email || "unknown"} (this is the FOUNDER — do NOT use this as the contact email)
- Duration: ${obj?.duration || "unknown"} minutes
- Participants: ${JSON.stringify((obj as Record<string, unknown>)?.participants || [])}
- Start Time: ${obj?.start_time || "unknown"}

CONTACT EXTRACTION FOR MEETINGS:
- The meeting topic usually contains the prospect's name (e.g. "SalesGlider Followup - Ramon Guitard and Joshua Osborn")
- Extract the NON-FOUNDER name from the topic as first_name and last_name
- Joshua Osborn is the founder — skip him
- Set email to "unknown" if no participant email is available (do NOT fabricate)
- This was a real sales meeting — set sentiment to "positive" and stage to at minimum "discovery_completed"`;

  // Add enriched contact data if available (from Apollo)
  const enrichedContact = (payload.enriched_contact || payload.apollo_contact) as Record<string, unknown> | undefined;
  if (enrichedContact) {
    context += `

LEAD IDENTIFIED VIA APOLLO (enriched contact data):
- Name: ${enrichedContact.first_name || ""} ${enrichedContact.last_name || ""}
- Email: ${enrichedContact.email || "unknown"}
- Company: ${enrichedContact.company || "unknown"}
- Title: ${enrichedContact.title || "unknown"}
- LinkedIn: ${enrichedContact.linkedin_url || "unknown"}

IMPORTANT: Use this enriched contact data for the contact fields in your response. The email from enriched_contact is the ONLY valid email.`;
  }

  // Add Zoom AI Companion summary if available
  const zoomAiSummary = payload.zoom_ai_summary as string | undefined;
  if (zoomAiSummary) {
    context += `\n\nZOOM AI COMPANION SUMMARY:\n${zoomAiSummary}`;
  }

  if (shareUrl) {
    context += `\n- Recording Share URL: ${shareUrl}`;
  }
  if (recordingFiles && recordingFiles.length > 0) {
    context += `\n- Recording Files: ${recordingFiles.length} files available`;
  }

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
  const client = getGeminiClient();
  const model = client.getGenerativeModel({ model: "gemini-2.5-flash" });

  const result = await model.generateContent({
    contents: [
      {
        role: "user",
        parts: [{ text: `Here is the current pipeline data:\n\n${pipelineData}\n\nUser question: ${query}` }],
      },
    ],
    systemInstruction: {
      role: "model",
      parts: [{
        text: `You are a conversational sales pipeline assistant for a B2B outbound agency founder.
Answer questions about their pipeline, deals, and activity in a natural, conversational tone.
Don't dump raw data — interpret it and give actionable insights.
Be concise but thorough. Use specific numbers, names, and dates when available.
If you don't have enough data to answer, say so clearly.`,
      }],
    },
    generationConfig: {
      maxOutputTokens: 2048,
    },
  });

  return result.response.text();
}
