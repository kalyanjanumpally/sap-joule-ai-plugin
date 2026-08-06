// Rate-limit-driven retry middleware for llm.use(). Reads
// `err.retryAfterSec` on caught throttling errors (populated by the
// providers' throwFromResponse path in lib/util.js), waits + retries
// automatically. Complements usageMetering's `_rateLimit` tracking
// (1.38.0-1.45.0) with automated recovery.
//
//   const retry = retryOnRateLimit({
//     maxAttempts:     3,        // default 3
//     fallbackWaitMs:  5000,     // when no retryAfter header: wait this
//     jitterMs:        250,      // random 0..jitterMs added to each wait
//     retryOnStatuses: [429, 503],  // default; add 500 etc. if you want
//     onRetry:  (info) => cds.log('llm:retry').warn(info),
//     onGiveUp: (info) => cds.log('llm:retry').error(info),
//   });
//   llm.use(retry);
//
// Recommended chain (top = OUTER):
//   promptInjectionGuard → guardrails → costBudget → retryOnRateLimit →
//   usageMetering → responseCache → provider
//
// Placing it OUTER of usageMetering ensures retries don't inflate the
// metering counter (each retry is a fresh chat call from the provider's
// perspective, but from the CALLER's perspective it's one logical request).
// INNER of costBudget so a budget-exhausted-then-retry pattern still trips
// the budget check on the second attempt.

class RateLimitGiveUpError extends Error {
  constructor(finalError, attempts) {
    super(`retryOnRateLimit: gave up after ${attempts.length} attempts. Last error: ${finalError.message}`);
    this.name = 'RateLimitGiveUpError';
    this.code = 'RATE_LIMIT_GIVE_UP';
    this.attempts = attempts;
    this.cause = finalError;
  }
}

const DEFAULT_RETRY_STATUSES = new Set([429, 503]);

function retryOnRateLimit(options = {}) {
  const {
    maxAttempts     = 3,
    fallbackWaitMs  = 5000,
    jitterMs        = 250,
    retryOnStatuses = null,
    onRetry         = null,
    onGiveUp        = null,
  } = options;

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`retryOnRateLimit: maxAttempts must be a positive integer (got ${maxAttempts}).`);
  }
  if (!Number.isFinite(fallbackWaitMs) || fallbackWaitMs < 0) {
    throw new Error(`retryOnRateLimit: fallbackWaitMs must be a non-negative number (got ${fallbackWaitMs}).`);
  }
  if (!Number.isFinite(jitterMs) || jitterMs < 0) {
    throw new Error(`retryOnRateLimit: jitterMs must be a non-negative number (got ${jitterMs}).`);
  }
  const statusesSet = retryOnStatuses
    ? new Set(retryOnStatuses)
    : DEFAULT_RETRY_STATUSES;

  const stats = {
    requests:        0,
    retriedRequests: 0,
    totalRetries:    0,
    givenUp:         0,
    totalWaitMs:     0,
  };

  const mw = async (ctx, next) => {
    stats.requests++;
    const attempts = [];
    for (let i = 0; i < maxAttempts; i++) {
      try {
        return await next();
      } catch (err) {
        const status = err?.status ?? err?.statusCode;
        const hasRetryHint = typeof err?.retryAfterSec === 'number';
        const isRetryLimit = err?.name === 'RetryableError'
          || (status != null && statusesSet.has(status))
          || hasRetryHint;

        if (!isRetryLimit || i === maxAttempts - 1) {
          // Not retryable OR final attempt — surface with history when present.
          if (attempts.length > 0) {
            stats.givenUp++;
            if (onGiveUp) {
              try { onGiveUp({ ctx, attempts, finalError: err, method: ctx.method }); }
              catch { /* swallow */ }
            }
            throw new RateLimitGiveUpError(err, attempts);
          }
          throw err;
        }

        const rawWait = hasRetryHint
          ? Math.round(err.retryAfterSec * 1000)
          : fallbackWaitMs;
        const jitter = jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0;
        const waitMs = rawWait + jitter;

        if (i === 0) stats.retriedRequests++;
        stats.totalRetries++;
        stats.totalWaitMs += waitMs;

        const attempt = { attempt: i + 1, waitMs, status: status ?? null, error: err.message };
        attempts.push(attempt);
        if (onRetry) {
          try { onRetry({ ctx, ...attempt, error: err, method: ctx.method }); }
          catch { /* swallow */ }
        }
        if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    // Should be unreachable — the loop always either returns or throws.
    // Defensive throw in case someone tweaks the loop.
    throw new Error('retryOnRateLimit: exhausted attempts without result');
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.requests = stats.retriedRequests = stats.totalRetries = stats.givenUp = stats.totalWaitMs = 0;
  };
  mw.asMcpResource = () => ({
    uri: 'config://rate-limit-retry',
    name: 'Rate-limit retry middleware',
    description: 'Counters showing how many requests hit throttling + total wait time absorbed.',
    mimeType: 'application/json',
    handler: () => ({
      maxAttempts, fallbackWaitMs, jitterMs,
      retryOnStatuses: [...statusesSet],
      ...stats,
    }),
  });
  return mw;
}

module.exports = { retryOnRateLimit, RateLimitGiveUpError };
