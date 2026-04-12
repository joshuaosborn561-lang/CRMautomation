/**
 * Generic async retry with exponential backoff + optional jitter.
 * @param {object} opts
 * @param {() => Promise<T>} opts.fn
 * @param {(err: unknown, attempt: number) => boolean} opts.shouldRetry
 * @param {number} [opts.maxAttempts=4]
 * @param {number} [opts.baseDelayMs=800]
 * @param {string} [opts.label='']
 * @returns {Promise<T>}
 */
async function retryWithBackoff(opts) {
  const { fn, shouldRetry, maxAttempts = 4, baseDelayMs = 800, label = "" } = opts;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retry = shouldRetry(err, attempt);
      if (!retry || attempt >= maxAttempts) throw err;
      const jitter = Math.floor(Math.random() * 400);
      const delay = baseDelayMs * 2 ** (attempt - 1) + jitter;
      const tag = label ? `[${label}] ` : "";
      console.warn(`${tag}retry ${attempt}/${maxAttempts - 1} in ${delay}ms: ${err?.message || err}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

function parseRetryAfterMs(res) {
  const raw = res.headers?.get?.("retry-after");
  if (!raw) return null;
  const sec = Number(raw);
  if (Number.isFinite(sec) && sec > 0 && sec < 3600) return sec * 1000;
  return null;
}

module.exports = { retryWithBackoff, parseRetryAfterMs };
