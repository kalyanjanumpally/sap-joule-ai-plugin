// Deadline / timeout middleware. Hard cap on total request time,
// including retries, bulkhead queue waits, and the provider call itself.
// Uses an AbortController per request; provider implementations that
// respect ctx.signal (or forward it into fetch) will cancel in-flight
// HTTP calls when the deadline expires.
//
// Composes as the OUTERMOST middleware:
//   deadline → promptInjectionGuard → guardrails → costBudget →
//   circuitBreaker → bulkhead → retryOnRateLimit → provider
//
// Rationale: putting deadline OUTER means retries, queue-waits, and
// provider calls all share ONE deadline budget. If deadline were
// INNER of retry, each retry would get a fresh deadline — defeating
// the "total time budget" contract.
//
//   const dl = deadline({
//     timeoutMs: 30_000,
//     perMethod: { chat: 30_000, embed: 5_000, stream: 60_000 },
//     onExpired: (info) => cds.log('llm:deadline').warn('expired', info),
//   });
//   llm.use(dl);

const { LLMError } = require('../errors');

class DeadlineExceededError extends LLMError {
  constructor(timeoutMs, method) {
    super(`deadline: ${method} exceeded ${timeoutMs}ms budget.`, 'DEADLINE_EXCEEDED');
    this.timeoutMs = timeoutMs;
    this.method = method;
  }
}

function deadline(options = {}) {
  const {
    timeoutMs = 30_000,
    perMethod = null,
    onExpired = null,
  } = options;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`deadline: timeoutMs must be a positive number (got ${timeoutMs}).`);
  }
  if (perMethod != null && typeof perMethod !== 'object') {
    throw new Error('deadline: perMethod must be an object mapping method name to ms.');
  }
  if (perMethod) {
    for (const [k, v] of Object.entries(perMethod)) {
      if (!Number.isFinite(v) || v <= 0) {
        throw new Error(`deadline: perMethod.${k} must be a positive number (got ${v}).`);
      }
    }
  }

  const stats = {
    requests:    0,
    expired:     0,
    activeCount: 0,
  };

  const mw = async (ctx, next) => {
    stats.requests++;
    const budget = (perMethod && perMethod[ctx?.method]) ?? timeoutMs;

    // Wire up abort controller. Preserve any existing ctx.signal by
    // linking it: if the caller-supplied signal aborts, we abort ours too.
    const controller = new AbortController();
    const existing = ctx.signal;
    ctx.signal = controller.signal;
    let existingAbortHandler;
    if (existing && !existing.aborted) {
      existingAbortHandler = () => controller.abort(existing.reason);
      existing.addEventListener('abort', existingAbortHandler, { once: true });
    } else if (existing?.aborted) {
      controller.abort(existing.reason);
    }

    stats.activeCount++;
    const startedAt = Date.now();
    let timeoutId;

    try {
      // Race the wrapped call against the deadline timer.
      const result = await new Promise((resolve, reject) => {
        timeoutId = setTimeout(() => {
          const err = new DeadlineExceededError(budget, ctx?.method);
          if (onExpired) {
            try { onExpired({ method: ctx?.method, timeoutMs: budget, elapsedMs: Date.now() - startedAt }); }
            catch { /* swallow */ }
          }
          controller.abort(err);
          stats.expired++;
          reject(err);
        }, budget);

        Promise.resolve()
          .then(() => next())
          .then(resolve, reject);
      });

      // Restore original signal for callers looking at ctx after next()
      if (existing) ctx.signal = existing;
      return result;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (existing && existingAbortHandler) existing.removeEventListener('abort', existingAbortHandler);
      stats.activeCount--;
    }
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.requests = stats.expired = 0;
    // activeCount is NOT reset — it reflects real in-flight state.
  };
  mw.asMcpResource = () => ({
    uri: 'config://deadline',
    name: 'Deadline middleware',
    description: 'Per-request time-budget counters + current active-count.',
    mimeType: 'application/json',
    handler: () => ({
      timeoutMs,
      perMethod: perMethod ?? null,
      ...stats,
    }),
  });
  return mw;
}

module.exports = { deadline, DeadlineExceededError };
