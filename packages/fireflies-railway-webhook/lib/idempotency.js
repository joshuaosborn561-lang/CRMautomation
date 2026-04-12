/**
 * In-process idempotency for webhook runs (same meetingId within TTL).
 * For multiple Railway instances, replace with Redis or similar.
 */
const TTL_MS = Number(process.env.WEBHOOK_IDEMPOTENCY_TTL_MS || 7 * 24 * 60 * 60 * 1000);
const MAX_ENTRIES = Number(process.env.WEBHOOK_IDEMPOTENCY_MAX || 2000);

/** @type {Map<string, { classification: string, ts: number }>} */
const completed = new Map();

function prune() {
  const now = Date.now();
  for (const [k, v] of completed) {
    if (now - v.ts > TTL_MS) completed.delete(k);
  }
  while (completed.size > MAX_ENTRIES) {
    const oldest = completed.keys().next().value;
    if (oldest == null) break;
    completed.delete(oldest);
  }
}

function shouldSkipProcessing(meetingId, forceReplay) {
  if (forceReplay) return false;
  prune();
  const row = completed.get(String(meetingId));
  if (!row) return false;
  if (Date.now() - row.ts > TTL_MS) {
    completed.delete(String(meetingId));
    return false;
  }
  return true;
}

function getCompletionRow(meetingId) {
  return completed.get(String(meetingId)) || null;
}

function recordSuccessfulCompletion(meetingId, classification) {
  completed.set(String(meetingId), { classification: String(classification), ts: Date.now() });
  prune();
}

module.exports = {
  shouldSkipProcessing,
  recordSuccessfulCompletion,
  getCompletionRow,
};
