/**
 * Fireflies `transcript.duration` is not always documented consistently across accounts.
 * If treating `duration` as seconds yields implausibly short meetings while the transcript
 * is long, assume `duration` is already in **minutes**.
 */
function meetingDurationMinutes(transcript) {
  const raw = transcript?.duration;
  if (!Number.isFinite(raw)) {
    const secs =
      transcript?.durationSeconds ||
      transcript?.duration_seconds ||
      transcript?.meeting?.duration ||
      transcript?.meeting?.durationSeconds ||
      null;
    if (!Number.isFinite(secs)) return null;
    return Math.round((secs / 60) * 10) / 10;
  }

  const sentenceCount =
    transcript?.sentenceCount ||
    transcript?.sentence_count ||
    transcript?.sentences?.length ||
    transcript?.transcript?.sentences?.length ||
    0;

  const asSecondsThenMinutes = Math.round((raw / 60) * 10) / 10;
  const asMinutes = Math.round(raw * 10) / 10;

  const longTranscript = sentenceCount >= 30;
  const secondsInterpretationImplausible = longTranscript && asSecondsThenMinutes < 3 && raw < 180;

  if (secondsInterpretationImplausible) {
    return asMinutes;
  }

  if (raw > 360) {
    return Math.round((raw / 60) * 10) / 10;
  }

  if (raw <= 360 && longTranscript && raw < 120) {
    return asMinutes;
  }

  return asSecondsThenMinutes;
}

module.exports = { meetingDurationMinutes };
