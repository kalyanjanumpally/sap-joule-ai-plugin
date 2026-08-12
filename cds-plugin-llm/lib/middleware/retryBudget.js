// Retry budget cap. Google-SRE-style global cap on the retry-to-request
// ratio across all in-flight requests. Prevents retry storms during
// partial outages: with `retryOnRateLimit` + `regionFailover` +
// `speculativeHedge` + `costAwareRouter`'s escalate-on-error combined,
// one call can trigger up to N×M×K upstream attempts — during an
// outage, 10k concurrent requests each retrying 5x can DoS the
// upstream you're trying to reach.
//
//   const { retryBudget, retryOnRateLimit } = require('@saptarishi/cds-plugin-llm');
//
//   const budget = retryBudget({
//     retryRatio:  0.10,     // max 10% retries (SRE-canonical)
//     windowMs:    60_000,
//     onExhausted: (i) => cds.log('llm:budget').warn('exhausted', i),
//   });
//
//   llm.use(retryOnRateLimit());   // OUTSIDE the budget — retries re-enter budget
//   llm.use(budget);                // budget sits INSIDE retry primitives
//
// How the ratio is measured
// -------------------------
// The middleware tracks two rolling counters in a sliding window:
//   * requests — one per unique ctx first seen
//   * retries  — every subsequent invocation with the SAME ctx (i.e.,
//                a retry-loop primitive is re-calling next())
//
// A WeakMap keyed by ctx distinguishes "first pass" from "repeat pass."
// This works because retry primitives (retryOnRateLimit, autoRetry,
// regionFailover, costAwareRouter's escalation) re-invoke next() with
// the SAME ctx reference. Middlewares that create fresh ctx objects
// per attempt (e.g. `speculativeHedge`'s per-hedge context) look like
// separate requests — which is correct: each hedge IS a separate
// upstream call, and its retries beneath count against the same budget.
//
// The budget refuses further retries when:
//   retries / max(requests, minSampleSize) > retryRatio

const { LLMError } = require('../errors');

class RetryBudgetExhaustedError extends LLMError {
  constructor({ retryRatio, currentRatio, requests, retries, windowMs }) {
    super(
      `retryBudget: retry ratio ${(currentRatio * 100).toFixed(1)}% exceeds cap ${(retryRatio * 100).toFixed(1)}% ` +
      `(${retries} retries / ${requests} requests in ${windowMs}ms).`,
      'RETRY_BUDGET_EXHAUSTED',
    );
    this.retryRatio    = retryRatio;
    this.currentRatio  = currentRatio;
    this.requests      = requests;
    this.retries       = retries;
    this.windowMs      = windowMs;
  }
}

function retryBudget(options = {}) {
  const {
    retryRatio      = 0.10,
    windowMs        = 60_000,
    minSampleSize   = 100,
    onExhausted     = null,
    onLowBudget     = null,   // fired at 50%, 80% of threshold
    lowBudgetLevels = [0.5, 0.8],
    now             = () => Date.now(),
  } = options;

  if (!Number.isFinite(retryRatio) || retryRatio <= 0 || retryRatio >= 1) {
    throw new Error(`retryBudget: retryRatio must be in (0, 1) (got ${retryRatio}).`);
  }
  if (!Number.isInteger(windowMs) || windowMs < 100) {
    throw new Error(`retryBudget: windowMs must be an integer >= 100 (got ${windowMs}).`);
  }
  if (!Number.isInteger(minSampleSize) || minSampleSize < 1) {
    throw new Error(`retryBudget: minSampleSize must be a positive integer (got ${minSampleSize}).`);
  }
  for (const cb of [onExhausted, onLowBudget]) {
    if (cb != null && typeof cb !== 'function') {
      throw new Error('retryBudget: callbacks must be functions or null.');
    }
  }
  if (!Array.isArray(lowBudgetLevels)) {
    throw new Error('retryBudget: lowBudgetLevels must be an array.');
  }
  for (const l of lowBudgetLevels) {
    if (!Number.isFinite(l) || l <= 0 || l >= 1) {
      throw new Error(`retryBudget: lowBudgetLevels entries must be in (0, 1) (got ${l}).`);
    }
  }
  const sortedLevels = [...lowBudgetLevels].sort((a, b) => a - b);

  // Timestamped sliding windows. Keep them as arrays for simplicity;
  // 100k entries * 16 bytes each = 1.6MB, fine at web scale.
  const requestStamps = [];
  const retryStamps   = [];

  // Per-ctx call counts. WeakMap means we don't leak memory when the
  // ctx is garbage-collected after the call finishes.
  const seenCtx = new WeakMap();

  // Track which low-budget threshold we've already fired to avoid
  // spamming the callback every request once we cross a boundary.
  let highestLevelFired = -1;

  const stats = {
    totalCalls:       0,
    firstAttempts:    0,
    retryAttempts:    0,
    rejectedRetries:  0,
    lowBudgetFires:   0,
    lastRatio:        null,
    lastRejectedAt:   null,
  };

  function callHook(hook, arg) {
    if (!hook) return;
    try { const r = hook(arg); if (r && typeof r.then === 'function') r.catch(() => {}); }
    catch { /* swallow */ }
  }

  function pruneOlderThan(cutoff) {
    while (requestStamps.length > 0 && requestStamps[0] < cutoff) requestStamps.shift();
    while (retryStamps.length > 0 && retryStamps[0] < cutoff) retryStamps.shift();
  }

  function currentCounts() {
    const cutoff = now() - windowMs;
    pruneOlderThan(cutoff);
    return { requests: requestStamps.length, retries: retryStamps.length };
  }

  function currentRatio(requests, retries) {
    const denom = Math.max(requests, minSampleSize);
    return denom === 0 ? 0 : retries / denom;
  }

  const mw = async (ctx, next) => {
    stats.totalCalls++;

    const t = now();
    const attempt = (seenCtx.get(ctx) ?? 0) + 1;
    seenCtx.set(ctx, attempt);

    if (attempt === 1) {
      // First pass — always allowed. Just count it as a request.
      stats.firstAttempts++;
      requestStamps.push(t);
      return next();
    }

    // Retry pass — check budget BEFORE consuming.
    const { requests, retries } = currentCounts();
    const wouldBeRetries = retries + 1;
    const ratio = currentRatio(requests, wouldBeRetries);
    stats.lastRatio = ratio;

    if (ratio > retryRatio && requests >= minSampleSize) {
      // Refuse the retry.
      stats.rejectedRetries++;
      stats.lastRejectedAt = t;
      const err = new RetryBudgetExhaustedError({
        retryRatio, currentRatio: ratio, requests, retries, windowMs,
      });
      callHook(onExhausted, {
        currentRatio: ratio, retryRatio, requests, retries, windowMs,
      });
      throw err;
    }

    // Under budget — allow, count the retry.
    stats.retryAttempts++;
    retryStamps.push(t);

    // Low-budget warning ladder.
    const budgetFraction = ratio / retryRatio;
    for (let i = sortedLevels.length - 1; i >= 0; i--) {
      const level = sortedLevels[i];
      if (budgetFraction >= level && i > highestLevelFired) {
        highestLevelFired = i;
        stats.lowBudgetFires++;
        callHook(onLowBudget, {
          level, currentRatio: ratio, retryRatio, requests, retries: wouldBeRetries,
        });
        break;
      }
    }
    // Reset if ratio recovers.
    if (budgetFraction < sortedLevels[0]) highestLevelFired = -1;

    return next();
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.totalCalls = stats.firstAttempts = stats.retryAttempts = 0;
    stats.rejectedRetries = stats.lowBudgetFires = 0;
    stats.lastRatio = stats.lastRejectedAt = null;
    requestStamps.length = 0;
    retryStamps.length = 0;
    highestLevelFired = -1;
    // Don't clear seenCtx — that would let already-in-flight retries
    // sneak in as fresh requests.
  };
  mw.currentRatio = () => {
    const { requests, retries } = currentCounts();
    return currentRatio(requests, retries);
  };
  mw.currentCounts = () => currentCounts();
  mw.asMcpResource = () => ({
    uri: 'config://retry-budget',
    name: 'Retry budget',
    description: 'SRE-style cap on retries-to-requests ratio in a rolling window. Prevents retry storms.',
    mimeType: 'application/json',
    handler: () => {
      const { requests, retries } = currentCounts();
      return {
        retryRatio,
        windowMs,
        minSampleSize,
        lowBudgetLevels: sortedLevels,
        currentRequests: requests,
        currentRetries:  retries,
        currentRatio:    currentRatio(requests, retries),
        budgetFraction:  currentRatio(requests, retries) / retryRatio,
        ...stats,
      };
    },
  });

  return mw;
}

module.exports = {
  retryBudget,
  RetryBudgetExhaustedError,
};
