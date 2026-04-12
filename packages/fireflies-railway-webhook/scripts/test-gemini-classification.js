/**
 * Verifies rule-based classification and Gemini for "real meeting" payloads.
 * Run: railway run node scripts/test-gemini-classification.js
 */
require("dotenv").config();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { ruleBasedMeetingClassification, CLASSIFICATION_RULES } = require("../lib/meetingRules");

function safeJsonStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return String(obj);
  }
}

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

async function classifyWithGeminiOnly(extracted) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: { maxOutputTokens: 100 },
  });
  const minSc = CLASSIFICATION_RULES.minSentencesForCompleted;
  const minDm = CLASSIFICATION_RULES.minMinutesForCompleted;
  const prompt =
    "Based on the following meeting data, classify this meeting as either COMPLETED or NO_SHOW. " +
    "Return only one word: COMPLETED or NO_SHOW. " +
    `A meeting is a NO_SHOW if any of these are true: sentence count is less than ${minSc}, duration is less than ${minDm} minutes, or only 1 speaker was detected. ` +
    `If sentenceCount is at least ${minSc}, durationMinutes is at least ${minDm}, and at least two distinct names appear in speakerNames, you MUST answer COMPLETED. ` +
    `Meeting data: ${safeJsonStringify(extracted)}`;

  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 100 },
  });
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
  throw new Error(`Unexpected Gemini output: ${text.slice(0, 120)}`);
}

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error("Set GEMINI_API_KEY or run: railway run node scripts/test-gemini-classification.js");
    process.exit(1);
  }

  const ruleCases = [
    {
      name: "clear attended (rules → COMPLETED)",
      extracted: {
        meetingId: "test",
        sentenceCount: 420,
        durationMinutes: 38.5,
        speakerNames: ["Josh Osborn", "Alex Rivera"],
        overview: "Discovery call covering pricing and timeline.",
        attendees: [],
        prospectEmail: "alex@example.com",
      },
      expect: "COMPLETED",
    },
    {
      name: "too few sentences",
      extracted: {
        meetingId: "test",
        sentenceCount: 9,
        durationMinutes: 30,
        speakerNames: ["A", "B"],
        overview: "",
        attendees: [],
        prospectEmail: "a@b.com",
      },
      expect: "NO_SHOW",
    },
    {
      name: "too short duration",
      extracted: {
        meetingId: "test",
        sentenceCount: 200,
        durationMinutes: 2.9,
        speakerNames: ["A", "B"],
        overview: "",
        attendees: [],
        prospectEmail: "a@b.com",
      },
      expect: "NO_SHOW",
    },
    {
      name: "only one speaker",
      extracted: {
        meetingId: "test",
        sentenceCount: 200,
        durationMinutes: 30,
        speakerNames: ["Solo"],
        overview: "",
        attendees: [],
        prospectEmail: "a@b.com",
      },
      expect: "NO_SHOW",
    },
    {
      name: "boundary 10 sentences 3 minutes 2 speakers → COMPLETED",
      extracted: {
        meetingId: "test",
        sentenceCount: 10,
        durationMinutes: 3,
        speakerNames: ["Host", "Guest"],
        overview: "",
        attendees: [],
        prospectEmail: "guest@x.com",
      },
      expect: "COMPLETED",
    },
    {
      name: "missing speaker diarization but transcript + duration show real call",
      extracted: {
        meetingId: "test",
        sentenceCount: 80,
        durationMinutes: 22,
        speakerNames: [],
        overview: "",
        attendees: [],
        prospectEmail: "a@b.com",
      },
      expect: "COMPLETED",
    },
  ];

  console.log("--- Rule-based checks (same logic as production) ---\n");
  for (const c of ruleCases) {
    const got = ruleBasedMeetingClassification(c.extracted);
    assert(got === c.expect, `${c.name}: expected ${c.expect}, got ${got}`);
    console.log("OK", c.name, "→", got);
  }

  const attendedFixture = {
    meetingId: "gemini-test-1",
    sentenceCount: 156,
    durationMinutes: 27,
    speakerNames: ["Joshua Osborn", "Jamie Lee"],
    overview:
      "Discovery call: prospect described current roofing workflow, asked about integration timeline, agreed to a follow-up proposal review next week.",
    attendees: [
      { email: "jamie@exampleco.com", name: "Jamie Lee" },
      { email: "joshua@salesglidergrowth.com", name: "Joshua Osborn" },
    ],
    prospectEmail: "jamie@exampleco.com",
  };
  assert(
    ruleBasedMeetingClassification(attendedFixture) === "COMPLETED",
    "realistic attended meeting must be COMPLETED via rules (no erroneous Nurture)",
  );
  console.log("OK realistic attended meeting → COMPLETED (rules, no Gemini needed)");

  console.log("\n--- Gemini: partial metrics (duration unknown, model decides) ---\n");
  const geminiPartial = {
    meetingId: "gemini-test-2b",
    sentenceCount: 95,
    durationMinutes: undefined,
    speakerNames: ["Host", "Guest"],
    overview: "Full discovery: requirements, budget, stakeholders, and agreed next steps.",
    attendees: [],
    prospectEmail: "guest@example.com",
  };
  assert(ruleBasedMeetingClassification(geminiPartial) === null, "partial metrics should use Gemini");
  const g1 = await classifyWithGeminiOnly(geminiPartial);
  assert(g1 === "COMPLETED", `Gemini should classify substantial meeting as COMPLETED, got ${g1}`);
  console.log("OK Gemini partial metrics attended meeting →", g1);

  console.log("\n--- Gemini: obvious no-show (model only) ---\n");
  const g2 = await classifyWithGeminiOnly({
    meetingId: "gemini-test-3",
    sentenceCount: 3,
    durationMinutes: 1,
    speakerNames: ["Host Only"],
    overview: "",
    attendees: [],
    prospectEmail: "p@q.com",
  });
  assert(g2 === "NO_SHOW", `Gemini should classify short empty meeting as NO_SHOW, got ${g2}`);
  console.log("OK Gemini trivial no-show →", g2);

  console.log("\nAll classification tests passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
