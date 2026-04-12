/**
 * Fast CI checks: no API keys. Rule logic + duration normalization.
 */
const assert = require("assert");
const { ruleBasedMeetingClassification, CLASSIFICATION_RULES } = require("../lib/meetingRules");
const { meetingDurationMinutes } = require("../lib/duration");

assert.strictEqual(
  ruleBasedMeetingClassification({
    sentenceCount: 100,
    durationMinutes: 30,
    speakerNames: ["A", "B"],
  }),
  "COMPLETED",
);

assert.strictEqual(
  ruleBasedMeetingClassification({
    sentenceCount: 5,
    durationMinutes: 30,
    speakerNames: ["A", "B"],
  }),
  "NO_SHOW",
);

const minSc = CLASSIFICATION_RULES.minSentencesForCompleted;
assert.strictEqual(
  ruleBasedMeetingClassification({
    sentenceCount: minSc,
    durationMinutes: 3,
    speakerNames: ["A", "B"],
  }),
  "COMPLETED",
);

assert.ok(
  meetingDurationMinutes({ duration: 10.93, sentences: new Array(50) }) >= 10,
  "long transcript + small duration should infer minutes",
);

console.log("ci-rule-tests: OK");
