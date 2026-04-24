/** Keep in sync with Gemini prompt in server.js (buildClassificationPrompt). */
const CLASSIFICATION_RULES = {
  minSentencesForCompleted: 10,
  minMinutesForCompleted: 3,
};

/**
 * Deterministic NO_SHOW / COMPLETED from the same thresholds described to Gemini.
 * Returns null when metrics are incomplete so the model can decide.
 *
 * If Fireflies omits speaker diarization (0 speakers) but sentence count and duration
 * clearly indicate a real conversation, we still classify COMPLETED so good meetings
 * are not pushed to the No show stage on a bad or overcautious model answer.
 */
function ruleBasedMeetingClassification(extracted) {
  if (!extracted || typeof extracted !== "object") return null;

  const minSc = CLASSIFICATION_RULES.minSentencesForCompleted;
  const minDm = CLASSIFICATION_RULES.minMinutesForCompleted;

  const sc = extracted.sentenceCount;
  const dm = extracted.durationMinutes;
  const names = extracted.speakerNames;
  const speakerCount = Array.isArray(names) ? names.filter(Boolean).length : 0;

  const hasSc = Number.isFinite(sc);
  const hasDm = Number.isFinite(dm);

  if (hasSc && sc < minSc) return "NO_SHOW";
  if (hasDm && dm < minDm) return "NO_SHOW";
  if (speakerCount === 1) return "NO_SHOW";

  if (hasSc && hasDm && sc >= minSc && dm >= minDm) {
    if (speakerCount >= 2) return "COMPLETED";
    if (speakerCount === 0) return "COMPLETED";
  }

  return null;
}

module.exports = { ruleBasedMeetingClassification, CLASSIFICATION_RULES };
