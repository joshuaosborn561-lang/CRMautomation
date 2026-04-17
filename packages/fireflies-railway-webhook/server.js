require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const fetch = require("node-fetch");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { ruleBasedMeetingClassification, CLASSIFICATION_RULES } = require("./lib/meetingRules");
const { meetingDurationMinutes } = require("./lib/duration");
const { retryWithBackoff, parseRetryAfterMs } = require("./lib/retry");
const {
  shouldSkipProcessing,
  recordSuccessfulCompletion,
  getCompletionRow,
} = require("./lib/idempotency");

const {
  FIREFLIES_API_KEY,
  GEMINI_API_KEY,
  HUBSPOT_ACCESS_TOKEN,
  HUBSPOT_PIPELINE_ID,
  HUBSPOT_STAGE_DISCOVERY_COMPLETED,
  HUBSPOT_STAGE_NURTURE,
  SLACK_WEBHOOK_URL,
  HUBSPOT_STAGE_DISCOVERY_SCHEDULED,
} = process.env;

const FIREFLIES_INITIAL_WAIT_MS = Number(process.env.FIREFLIES_INITIAL_WAIT_MS || 15000);
const FIREFLIES_RETRY_WAIT_MS = Number(process.env.FIREFLIES_RETRY_WAIT_MS || 30000);
const FIREFLIES_MAX_RETRIES = Number(process.env.FIREFLIES_MAX_RETRIES || 4);
const HUBSPOT_MAX_RETRIES = Number(process.env.HUBSPOT_MAX_RETRIES || 5);
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 45000);
const GEMINI_MAX_RETRIES = Number(process.env.GEMINI_MAX_RETRIES || 3);
const STARTUP_VALIDATE_HUBSPOT = String(process.env.STARTUP_VALIDATE_HUBSPOT || "true").toLowerCase() !== "false";
const STARTUP_VALIDATE_FIREFLIES = String(process.env.STARTUP_VALIDATE_FIREFLIES || "false").toLowerCase() === "true";

function requireEnv(name) {
  if (!process.env[name]) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJsonStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return String(obj);
  }
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function pickMeetingId(payload) {
  if (!payload || typeof payload !== "object") return null;
  return (
    payload.meetingId ||
    payload.meeting_id ||
    payload.meetingID ||
    payload.id ||
    payload.meeting?.id ||
    payload.meeting?.meetingId ||
    null
  );
}

function uniqNonEmpty(arr) {
  return Array.from(
    new Set((arr || []).map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean)),
  );
}

function extractAttendees(transcript) {
  const attendees =
    transcript?.attendees ||
    transcript?.meeting_attendees ||
    transcript?.meetingAttendees ||
    transcript?.participants;
  if (!Array.isArray(attendees)) return [];

  return attendees
    .map((a) => {
      const email = a?.email || a?.mail || a?.user?.email || a?.attendee?.email || null;
      const name =
        a?.name ||
        a?.displayName ||
        a?.display_name ||
        a?.full_name ||
        a?.fullName ||
        a?.user?.name ||
        a?.attendee?.name ||
        null;
      return {
        email: typeof email === "string" ? email.trim().toLowerCase() : null,
        name: typeof name === "string" ? name.trim() : null,
      };
    })
    .filter((a) => a.email || a.name);
}

function extractSpeakerNames(transcript) {
  const speakers =
    transcript?.speakerNames ||
    transcript?.speakers ||
    transcript?.speaker_labels ||
    transcript?.speakerLabels ||
    transcript?.sentences?.map?.((s) => s?.speaker_name || s?.speaker) ||
    [];

  if (Array.isArray(speakers)) {
    return uniqNonEmpty(
      speakers.map((s) => {
        if (typeof s === "string") return s;
        return s?.name || s?.speaker || s?.label || "";
      }),
    );
  }

  return [];
}

function extractOverview(transcript) {
  const summary = transcript?.summary;
  return (
    (typeof summary === "object" && summary
      ? summary.overview || summary.short_overview || summary.short_summary || summary.gist || ""
      : "") ||
    transcript?.overview ||
    (typeof transcript?.summary === "string" ? transcript.summary : "") ||
    transcript?.meetingOverview ||
    transcript?.meeting?.overview ||
    transcript?.meeting?.summary ||
    ""
  );
}

function extractSentenceCount(transcript) {
  const count =
    transcript?.sentenceCount ||
    transcript?.sentence_count ||
    transcript?.sentences?.length ||
    transcript?.transcript?.sentences?.length ||
    null;

  return Number.isFinite(count) ? count : count == null ? null : Number(count);
}

function buildFirefliesSummaryNote(extracted, classification, label, dateStr) {
  const lines = [];
  lines.push(`Meeting classified as ${classification} by ${label} on ${dateStr}`);
  if (extracted.durationMinutes != null) {
    lines.push(`Duration: ${extracted.durationMinutes} minutes`);
  }
  if (extracted.sentenceCount != null) {
    lines.push(`Sentence count: ${extracted.sentenceCount}`);
  }
  const speakerCount = Array.isArray(extracted.speakerNames)
    ? extracted.speakerNames.filter(Boolean).length
    : 0;
  if (speakerCount > 0) {
    lines.push(`Speakers: ${speakerCount}`);
  }
  const overview =
    typeof extracted.overview === "string" ? extracted.overview.trim() : "";
  if (overview) {
    lines.push("");
    lines.push(overview);
  }
  return lines.join("\n");
}

function pickProspectEmail(attendees, webhookPayload) {
  const lower = (s) => (typeof s === "string" ? s.trim().toLowerCase() : "");
  const possibleMyEmail =
    lower(webhookPayload?.hostEmail) ||
    lower(webhookPayload?.host_email) ||
    lower(webhookPayload?.organizerEmail) ||
    lower(webhookPayload?.organizer_email) ||
    lower(webhookPayload?.user?.email) ||
    lower(webhookPayload?.owner?.email) ||
    "";

  const emails = uniqNonEmpty(attendees.map((a) => a.email).filter(Boolean)).map((e) => e.toLowerCase());

  const firstNonMine = emails.find((e) => (possibleMyEmail ? e !== possibleMyEmail : true));
  return firstNonMine || emails[0] || null;
}

function logLine(cid, level, code, message, extra) {
  const base = `[cid=${cid}] [${code}] ${message}`;
  if (extra != null) {
    const suffix = typeof extra === "string" ? extra : safeJsonStringify(extra).slice(0, 1500);
    if (level === "error") console.error(base, suffix);
    else if (level === "warn") console.warn(base, suffix);
    else console.log(base, suffix);
  } else if (level === "error") {
    console.error(base);
  } else if (level === "warn") {
    console.warn(base);
  } else {
    console.log(base);
  }
}

function buildClassificationPrompt(extracted) {
  const minSc = CLASSIFICATION_RULES.minSentencesForCompleted;
  const minDm = CLASSIFICATION_RULES.minMinutesForCompleted;
  return (
    "Based on the following meeting data, classify this meeting as either COMPLETED or NO_SHOW. " +
    "Return only one word: COMPLETED or NO_SHOW. " +
    `A meeting is a NO_SHOW if any of these are true: sentence count is less than ${minSc}, duration is less than ${minDm} minutes, or only 1 speaker was detected. ` +
    `If sentenceCount is at least ${minSc}, durationMinutes is at least ${minDm}, and at least two distinct names appear in speakerNames, you MUST answer COMPLETED. ` +
    `Meeting data: ${safeJsonStringify(extracted)}`
  );
}

async function firefliesGraphQL(query, variables) {
  requireEnv("FIREFLIES_API_KEY");

  return retryWithBackoff({
    label: "fireflies",
    maxAttempts: FIREFLIES_MAX_RETRIES,
    shouldRetry: (err) => {
      const msg = err?.message || String(err);
      if (/object_not_found|GRAPHQL_VALIDATION|GRAPHQL_PARSE|non-JSON/i.test(msg)) return false;
      if (/HTTP (429|502|503|504)\b|ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed/i.test(msg)) return true;
      if (/Fireflies GraphQL HTTP 5/.test(msg)) return true;
      return false;
    },
    fn: async () => {
      const res = await fetch("https://api.fireflies.ai/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${FIREFLIES_API_KEY}`,
        },
        body: JSON.stringify({ query, variables }),
      });

      const ra = parseRetryAfterMs(res);
      if (ra) await sleep(ra);

      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`Fireflies GraphQL non-JSON response (${res.status}): ${text.slice(0, 500)}`);
      }

      if (!res.ok) {
        throw new Error(
          `Fireflies GraphQL HTTP ${res.status}: ${safeJsonStringify(json).slice(0, 1000)}`,
        );
      }
      if (json.errors?.length) {
        throw new Error(`Fireflies GraphQL errors: ${safeJsonStringify(json.errors).slice(0, 1000)}`);
      }
      return json.data;
    },
  });
}

async function fetchFirefliesTranscript(meetingId) {
  const query = `
    query GetTranscript($id: String!) {
      transcript(id: $id) {
        id
        duration
        summary {
          overview
          short_overview
          short_summary
          gist
        }
        meeting_attendees {
          name
          displayName
          email
        }
        speakers {
          id
          name
        }
        sentences {
          index
        }
      }
    }
  `;

  const data = await firefliesGraphQL(query, { id: String(meetingId) });
  return data?.transcript || null;
}

async function fetchTranscriptWithRetry(meetingId, cid) {
  await sleep(FIREFLIES_INITIAL_WAIT_MS);
  try {
    const t1 = await fetchFirefliesTranscript(meetingId);
    if (!t1) throw new Error("Transcript not found in Fireflies response");
    return t1;
  } catch (err) {
    logLine(cid, "warn", "FIREFLIES_RETRY", `fetch failed, retrying once in ${FIREFLIES_RETRY_WAIT_MS}ms`, err?.message || err);
    await sleep(FIREFLIES_RETRY_WAIT_MS);
    const t2 = await fetchFirefliesTranscript(meetingId);
    if (!t2) throw new Error("Transcript not found in Fireflies response (after retry)");
    return t2;
  }
}

async function classifyMeetingWithGemini(extracted) {
  requireEnv("GEMINI_API_KEY");
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {
      maxOutputTokens: 100,
    },
  });

  const prompt = buildClassificationPrompt(extracted);
  let lastErr;

  for (let attempt = 1; attempt <= GEMINI_MAX_RETRIES; attempt++) {
    try {
      const result = await withTimeout(
        model.generateContent({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 100 },
        }),
        GEMINI_TIMEOUT_MS,
        "Gemini generateContent",
      );

      const text = (await result.response.text()).trim().toUpperCase();
      if (
        text.includes("NO_SHOW") ||
        text.includes("NO-SHOW") ||
        text.includes("NO SHOW") ||
        text === "NO" ||
        text.startsWith("NO_") ||
        /^NO[_\s-]*SHOW/.test(text)
      ) {
        return "NO_SHOW";
      }
      if (/\bCOMPLETED\b/.test(text)) return "COMPLETED";
      throw new Error(`Unexpected Gemini classification output: ${text.slice(0, 100)}`);
    } catch (err) {
      lastErr = err;
      if (attempt >= GEMINI_MAX_RETRIES) break;
      const delay = 800 * 2 ** (attempt - 1) + Math.floor(Math.random() * 400);
      console.warn(`[gemini] attempt ${attempt} failed, retry in ${delay}ms:`, err?.message || err);
      await sleep(delay);
    }
  }
  throw lastErr;
}

async function classifyMeeting(extracted) {
  const rule = ruleBasedMeetingClassification(extracted);
  if (rule) {
    console.log(
      `[classify] rule-based ${rule} (sentences=${extracted.sentenceCount}, durationMin=${extracted.durationMinutes}, speakerCount=${Array.isArray(extracted.speakerNames) ? extracted.speakerNames.filter(Boolean).length : 0})`,
    );
    return { classification: rule, label: "meeting metrics" };
  }
  const classification = await classifyMeetingWithGemini(extracted);
  return { classification, label: "Gemini AI" };
}

async function hubspotFetch(path, options = {}) {
  requireEnv("HUBSPOT_ACCESS_TOKEN");
  const method = (options.method || "GET").toUpperCase();
  const url = `https://api.hubapi.com${path}`;
  const body = options.body;

  return retryWithBackoff({
    label: "hubspot",
    maxAttempts: HUBSPOT_MAX_RETRIES,
    shouldRetry: (err) => {
      const m = err?.message || String(err);
      return /HubSpot HTTP (429|502|503|504)\b/.test(m);
    },
    fn: async () => {
      const headers = {
        Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
      };
      if (method !== "GET" && method !== "HEAD") {
        headers["Content-Type"] = "application/json";
      }

      const res = await fetch(url, {
        method,
        headers: { ...headers, ...(options.headers || {}) },
        body: method === "GET" || method === "HEAD" ? undefined : body,
      });

      const ra = parseRetryAfterMs(res);
      if (ra) await sleep(ra);

      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        // ignore
      }

      if ([429, 502, 503, 504].includes(res.status)) {
        throw new Error(`HubSpot HTTP ${res.status} ${path}: ${text.slice(0, 500)}`);
      }
      if (!res.ok) {
        throw new Error(`HubSpot HTTP ${res.status} ${path}: ${text.slice(0, 1000)}`);
      }
      return json;
    },
  });
}

async function findHubSpotContactByEmail(email) {
  const body = {
    filterGroups: [
      {
        filters: [
          {
            propertyName: "email",
            operator: "EQ",
            value: email,
          },
        ],
      },
    ],
    properties: ["firstname", "lastname", "company", "hubspot_owner_id", "email"],
    limit: 1,
  };

  const json = await hubspotFetch("/crm/v3/objects/contacts/search", {
    method: "POST",
    body: JSON.stringify(body),
  });

  const contact = json?.results?.[0] || null;
  return contact;
}

async function getDealsAssociatedToContact(contactId) {
  const json = await hubspotFetch(`/crm/v4/objects/contacts/${contactId}/associations/deals?limit=500`, {
    method: "GET",
  });
  const dealIds = (json?.results || []).map((r) => r?.toObjectId).filter(Boolean);
  return uniqNonEmpty(dealIds.map(String));
}

async function batchReadDeals(dealIds) {
  if (!dealIds.length) return [];
  const json = await hubspotFetch("/crm/v3/objects/deals/batch/read", {
    method: "POST",
    body: JSON.stringify({
      properties: ["dealstage", "pipeline", "dealname"],
      inputs: dealIds.map((id) => ({ id })),
    }),
  });
  return json?.results || [];
}

async function findTargetDealForUpdate(contactId) {
  requireEnv("HUBSPOT_PIPELINE_ID");
  const dealIds = await getDealsAssociatedToContact(contactId);
  if (!dealIds.length) return null;

  const deals = await batchReadDeals(dealIds);

  const desiredStage = HUBSPOT_STAGE_DISCOVERY_SCHEDULED || null;

  const candidates = deals.filter((d) => {
    const pipeline = d?.properties?.pipeline || null;
    const stage = d?.properties?.dealstage || null;
    if (pipeline !== HUBSPOT_PIPELINE_ID) return false;
    if (desiredStage) return stage === desiredStage;
    return true;
  });

  if (!candidates.length) return null;
  if (!desiredStage) {
    console.warn(
      "[hubspot] HUBSPOT_STAGE_DISCOVERY_SCHEDULED not set; using first deal in pipeline as fallback",
    );
  }
  return candidates[0];
}

async function updateDealStage(dealId, newStage) {
  await hubspotFetch(`/crm/v3/objects/deals/${dealId}`, {
    method: "PATCH",
    body: JSON.stringify({
      properties: {
        dealstage: newStage,
      },
    }),
  });
}

async function createContactNote(contactId, bodyText) {
  const json = await hubspotFetch("/crm/v3/objects/notes", {
    method: "POST",
    body: JSON.stringify({
      properties: {
        hs_note_body: bodyText,
        hs_timestamp: String(Date.now()),
      },
      associations: [
        {
          to: { id: String(contactId) },
          types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }],
        },
      ],
    }),
  });
  return json;
}

async function createFollowupTaskOnContact(contactId, ownerId, subject, dueDateMs) {
  const properties = {
    hs_task_subject: subject,
    hs_timestamp: String(dueDateMs),
  };
  if (ownerId) properties.hubspot_owner_id = String(ownerId);

  const json = await hubspotFetch("/crm/v3/objects/tasks", {
    method: "POST",
    body: JSON.stringify({
      properties,
      associations: [
        {
          to: { id: String(contactId) },
          types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 204 }],
        },
      ],
    }),
  });
  return json;
}

async function sendSlackNoShowMessage(text) {
  if (!SLACK_WEBHOOK_URL) {
    console.warn("[slack] SLACK_WEBHOOK_URL not set; skipping Slack notification");
    return;
  }
  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Slack webhook HTTP ${res.status}: ${t.slice(0, 500)}`);
  }
}

async function validateHubSpotStagesAtStartup() {
  const json = await hubspotFetch("/crm/v3/pipelines/deals", { method: "GET" });
  const pipelines = json?.results || [];
  const pipe = pipelines.find((p) => p.id === HUBSPOT_PIPELINE_ID);
  if (!pipe) {
    throw new Error(
      `HUBSPOT_PIPELINE_ID "${HUBSPOT_PIPELINE_ID}" not found in HubSpot deal pipelines (found: ${pipelines.map((p) => p.id).join(", ")})`,
    );
  }
  const stageIds = new Set((pipe.stages || []).map((s) => s.id));
  const required = [
    ["HUBSPOT_STAGE_DISCOVERY_COMPLETED", HUBSPOT_STAGE_DISCOVERY_COMPLETED],
    ["HUBSPOT_STAGE_NURTURE", HUBSPOT_STAGE_NURTURE],
  ];
  if (HUBSPOT_STAGE_DISCOVERY_SCHEDULED) {
    required.push(["HUBSPOT_STAGE_DISCOVERY_SCHEDULED", HUBSPOT_STAGE_DISCOVERY_SCHEDULED]);
  }
  for (const [name, id] of required) {
    if (!id) continue;
    if (!stageIds.has(id)) {
      throw new Error(`HubSpot stage ${name}="${id}" not in pipeline "${pipe.label}" (${HUBSPOT_PIPELINE_ID})`);
    }
  }
  console.log(`[startup] HubSpot pipeline OK: ${pipe.label} (${pipe.id}), stages validated`);
}

async function validateFirefliesKeyAtStartup() {
  requireEnv("FIREFLIES_API_KEY");
  const data = await firefliesGraphQL(
    `query { transcripts(limit: 1) { id } }`,
    {},
  );
  if (!data) throw new Error("Fireflies introspection returned empty data");
  console.log("[startup] Fireflies API key OK (transcripts query)");
}

async function processWebhook(payload, ctx = {}) {
  const cid = ctx.correlationId || crypto.randomUUID();
  const forceReplay = Boolean(payload?.forceReplay);

  try {
    requireEnv("FIREFLIES_API_KEY");
    requireEnv("GEMINI_API_KEY");
    requireEnv("HUBSPOT_ACCESS_TOKEN");
    requireEnv("HUBSPOT_PIPELINE_ID");
    requireEnv("HUBSPOT_STAGE_DISCOVERY_COMPLETED");
    requireEnv("HUBSPOT_STAGE_NURTURE");

    const meetingId = pickMeetingId(payload);
    if (!meetingId) {
      logLine(cid, "error", "SKIP_NO_MEETING_ID", "Missing meeting ID in payload", payload);
      return;
    }

    if (shouldSkipProcessing(meetingId, forceReplay)) {
      const row = getCompletionRow(meetingId);
      logLine(cid, "warn", "SKIP_IDEMPOTENT", `Already processed meetingId=${meetingId}`, row);
      return;
    }

    const transcript = await fetchTranscriptWithRetry(meetingId, cid);

    const overview = extractOverview(transcript);
    const sentenceCount = extractSentenceCount(transcript);
    const durationMinutes = meetingDurationMinutes(transcript);
    const attendees = extractAttendees(transcript);
    const speakerNames = extractSpeakerNames(transcript);
    const prospectEmail = pickProspectEmail(attendees, payload);

    if (!possibleOrganizerInPayload(payload)) {
      logLine(cid, "warn", "ORGANIZER_EMAIL_MISSING", "No organizer/host email on payload; prospect pick may include host", {
        meetingId,
      });
    }

    const extracted = {
      meetingId: String(meetingId),
      overview,
      sentenceCount,
      durationMinutes,
      attendees,
      speakerNames,
      prospectEmail,
    };

    if (!prospectEmail) {
      logLine(cid, "error", "SKIP_NO_PROSPECT_EMAIL", "Could not determine prospect email", extracted);
      return;
    }

    const { classification, label } = await classifyMeeting(extracted);
    const dateStr = new Date().toISOString().slice(0, 10);

    const contact = await findHubSpotContactByEmail(prospectEmail);
    if (!contact) {
      logLine(cid, "error", "SKIP_NO_HUBSPOT_CONTACT", `No HubSpot contact for ${prospectEmail}`);
      return;
    }

    const deal = await findTargetDealForUpdate(contact.id);
    if (!deal) {
      logLine(
        cid,
        "error",
        "SKIP_NO_TARGET_DEAL",
        `No deal for contact ${contact.id} in pipeline ${HUBSPOT_PIPELINE_ID}` +
          (HUBSPOT_STAGE_DISCOVERY_SCHEDULED ? ` stage ${HUBSPOT_STAGE_DISCOVERY_SCHEDULED}` : ""),
      );
      return;
    }

    const noteBody = buildFirefliesSummaryNote(extracted, classification, label, dateStr);

    if (classification === "COMPLETED") {
      await createContactNote(contact.id, noteBody);
      await updateDealStage(deal.id, HUBSPOT_STAGE_DISCOVERY_COMPLETED);
      recordSuccessfulCompletion(meetingId, classification);
      logLine(cid, "info", "DONE_COMPLETED", `${prospectEmail} contact=${contact.id} deal=${deal.id}`);
      return;
    }

    await createContactNote(contact.id, noteBody);
    await updateDealStage(deal.id, HUBSPOT_STAGE_NURTURE);

    const props = contact.properties || {};
    const first = props.firstname || "";
    const last = props.lastname || "";
    const company = props.company || "";
    const ownerId = props.hubspot_owner_id || null;

    const contactRef = `HubSpot contact ID ${contact.id} (${props.email || prospectEmail})`;
    const slackText =
      `🚨 No-show: ${[first, last].filter(Boolean).join(" ")}${company ? ` from ${company}` : ""} did not join the discovery call. ` +
      `Their deal has been moved to Nurture. ${contactRef}`;

    try {
      await sendSlackNoShowMessage(slackText);
    } catch (slackErr) {
      logLine(cid, "warn", "SLACK_FAILED", slackErr?.message || slackErr);
    }

    const due = Date.now() + 2 * 24 * 60 * 60 * 1000;
    try {
      await createFollowupTaskOnContact(
        contact.id,
        ownerId,
        `Follow up call — ${[first, last].filter(Boolean).join(" ") || prospectEmail} no-showed discovery call`,
        due,
      );
    } catch (taskErr) {
      logLine(cid, "warn", "TASK_FAILED", taskErr?.message || taskErr);
    }

    recordSuccessfulCompletion(meetingId, classification);
    logLine(cid, "info", "DONE_NO_SHOW", `${prospectEmail} contact=${contact.id} deal=${deal.id}`);
  } catch (err) {
    logLine(cid, "error", "WEBHOOK_FAILED", err?.message || err, err?.stack);
  }
}

function possibleOrganizerInPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  return Boolean(
    payload.hostEmail ||
      payload.host_email ||
      payload.organizerEmail ||
      payload.organizer_email ||
      payload.user?.email ||
      payload.owner?.email,
  );
}

const app = express();
app.use(express.json({ limit: "2mb" }));

app.post("/fireflies-webhook", (req, res) => {
  res.status(200).send("OK");
  const correlationId = req.get("x-correlation-id") || crypto.randomUUID();
  const body = req.body && typeof req.body === "object" ? req.body : {};
  setImmediate(() => processWebhook(body, { correlationId }));
});

app.get("/healthz", (req, res) => res.status(200).send("ok"));

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Listening on port ${port}`);
  setImmediate(async () => {
    try {
      if (STARTUP_VALIDATE_HUBSPOT) {
        await validateHubSpotStagesAtStartup();
      } else {
        console.log("[startup] HubSpot pipeline validation skipped (STARTUP_VALIDATE_HUBSPOT=false)");
      }
      if (STARTUP_VALIDATE_FIREFLIES) {
        await validateFirefliesKeyAtStartup();
      }
    } catch (e) {
      console.error("[startup] validation failed:", e?.stack || e);
      process.exit(1);
    }
  });
});
