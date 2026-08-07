// autoRetry — wraps any async function in a retry loop that respects
// the 1.57 LLMError.retriable field. Callers get automatic recovery from
// transient failures WITHOUT hand-writing per-error retry code.
//
// Retriable (from errorRegistry):
//   CIRCUIT_OPEN       — waits err.cooldownRemainingMs; the breaker's own
//                        half-open probe will decide if it's back up
//   BULKHEAD_FULL      — waits + retries; slot may free up in the meantime
//   BULKHEAD_TIMEOUT   — same
//
// Non-retriable (immediate throw):
//   DEADLINE_EXCEEDED  — caller's budget consumed; retrying wastes more time
//   COST_GUARD_BLOCKED — same request will always exceed the ceiling
//   BUDGET_EXCEEDED    — same request will always be over budget
//   PROMPT_INJECTION   — caller's input triggered the filter
//   GUARDRAIL_BLOCKED  — same
//   RATE_LIMIT_GIVE_UP — retryOnRateLimit already gave up
//   ALL_PROVIDERS_FAILED — every provider tried
//
// Usage — wrap once, call many times:
//
//   const { autoRetry } = require('@saptarishi/cds-plugin-llm');
//
//   const chat = autoRetry(llm.chat.bind(llm), {
//     maxAttempts:  3,
//     backoffMs:    500,       // base exp-backoff
//     jitterMs:     200,        // random 0..jitter added
//     maxBackoffMs: 30_000,     // cap on any single wait
//     onRetry:  (info) => cds.log('llm:auto-retry').warn(info),
//     onGiveUp: (info) => cds.log('llm:auto-retry').error(info),
//   });
//   const result = await chat({ messages: [...] });
//
// Or as a one-shot:
//   const result = await autoRetry(() => llm.chat({...}), { maxAttempts: 3 })();
//
// Backoff semantics:
//   - CIRCUIT_OPEN → uses err.cooldownRemainingMs directly (capped at maxBackoffMs)
//   - Others       → backoffMs * 2^(attempt-1) + random(0, jitterMs), capped
//
// The final thrown error is the ORIGINAL one from the last attempt (preserves
// stack, code, subclass identity). We also attach `err.autoRetryAttempts` with
// the retry history so callers can inspect what was tried.

function autoRetry(fn, options = {}) {
  if (typeof fn !== 'function') {
    throw new Error('autoRetry: first arg must be a function.');
  }
  const {
    maxAttempts   = 3,
    backoffMs     = 500,
    jitterMs      = 200,
    maxBackoffMs  = 30_000,
    retryOn       = defaultRetryOn,
    onRetry       = null,
    onGiveUp      = null,
  } = options;

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`autoRetry: maxAttempts must be a positive integer (got ${maxAttempts}).`);
  }
  if (!Number.isFinite(backoffMs) || backoffMs < 0) {
    throw new Error(`autoRetry: backoffMs must be a non-negative number (got ${backoffMs}).`);
  }
  if (!Number.isFinite(jitterMs) || jitterMs < 0) {
    throw new Error(`autoRetry: jitterMs must be a non-negative number (got ${jitterMs}).`);
  }
  if (!Number.isFinite(maxBackoffMs) || maxBackoffMs < 0) {
    throw new Error(`autoRetry: maxBackoffMs must be a non-negative number (got ${maxBackoffMs}).`);
  }

  const stats = {
    calls:           0,
    retriedCalls:    0,
    totalRetries:    0,
    givenUp:         0,
    totalWaitMs:     0,
  };

  const wrapped = async function (...args) {
    stats.calls++;
    const attempts = [];
    for (let i = 0; i < maxAttempts; i++) {
      try {
        return await fn.apply(this, args);
      } catch (err) {
        const isFinal   = i === maxAttempts - 1;
        const shouldRetry = !isFinal && retryOn(err);
        if (!shouldRetry) {
          // Final attempt OR non-retriable. Surface original error.
          if (attempts.length > 0) {
            stats.givenUp++;
            err.autoRetryAttempts = attempts;
            if (onGiveUp) {
              try { onGiveUp({ attempts, finalError: err }); }
              catch { /* swallow */ }
            }
          }
          throw err;
        }

        // Compute wait. CIRCUIT_OPEN carries a specific cooldown hint.
        const waitMs = computeWait(err, i, backoffMs, jitterMs, maxBackoffMs);
        stats.totalWaitMs += waitMs;
        if (i === 0) stats.retriedCalls++;
        stats.totalRetries++;

        const attempt = {
          attempt: i + 1,
          waitMs,
          code:    err?.code ?? null,
          error:   err?.message ?? String(err),
        };
        attempts.push(attempt);
        if (onRetry) {
          try { onRetry({ ctx: attempt, error: err }); }
          catch { /* swallow */ }
        }
        if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    // Unreachable — loop always returns or throws.
    throw new Error('autoRetry: exhausted attempts without result');
  };

  wrapped.stats = stats;
  wrapped.reset = () => {
    stats.calls = stats.retriedCalls = stats.totalRetries = stats.givenUp = stats.totalWaitMs = 0;
  };
  return wrapped;
}

// Default: retry any error whose `.retriable === true` (LLMError 1.57
// taxonomy). Consumers can override with a custom predicate that inspects
// error codes, HTTP status from provider errors, etc.
function defaultRetryOn(err) {
  return err?.retriable === true;
}

function computeWait(err, attemptIdx, backoffMs, jitterMs, maxBackoffMs) {
  // CIRCUIT_OPEN: honour the breaker's cooldownRemainingMs directly.
  if (err?.code === 'CIRCUIT_OPEN' && typeof err.cooldownRemainingMs === 'number' && err.cooldownRemainingMs > 0) {
    const jitter = jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0;
    return Math.min(maxBackoffMs, err.cooldownRemainingMs + jitter);
  }
  // Exponential backoff: backoffMs * 2^attemptIdx, plus jitter, capped
  const exp    = backoffMs * Math.pow(2, attemptIdx);
  const jitter = jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0;
  return Math.min(maxBackoffMs, exp + jitter);
}

module.exports = { autoRetry, defaultRetryOn };
