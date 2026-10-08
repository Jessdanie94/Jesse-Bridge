const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Transient: no response (timeout/network), 5xx, 408, 429. Everything else (4xx) is permanent.
function isTransientError(err) {
  const status = err?.response?.status;
  if (!status) return true;
  return status >= 500 || status === 408 || status === 429;
}

// `fn` performs one attempt and throws on failure.
// Returns { success, attempts, retryCount, data?, error?, permanent? }
async function withRetry(fn, { maxAttempts = 5, baseDelayMs = 1000, maxDelayMs = 30000, sleep = defaultSleep, onFailure } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const data = await fn(attempt);
      return { success: true, attempts: attempt, retryCount: attempt - 1, data };
    } catch (err) {
      lastError = err;
      const permanent = !isTransientError(err);
      const willRetry = !permanent && attempt < maxAttempts;
      if (onFailure) await onFailure({ attempt, err, permanent, willRetry });
      if (!willRetry) {
        return { success: false, attempts: attempt, retryCount: attempt - 1, error: err, permanent };
      }
      await sleep(Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs));
    }
  }
  return { success: false, attempts: maxAttempts, retryCount: maxAttempts - 1, error: lastError, permanent: false };
}

module.exports = { withRetry, isTransientError };
