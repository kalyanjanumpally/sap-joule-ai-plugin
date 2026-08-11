// Adaptive rate-limit tuner. Watches provider rate-limit headers
// (1.38+ parsers) and dynamically shrinks/grows the bulkhead's
// maxConcurrent to stay within the remaining quota. Reduces
// surprise 429s in bursty traffic without pinning concurrency to
// a conservative worst-case number.
//
// Complements:
//   * bulkhead (1.51)        — static concurrency ceiling
//   * adaptiveBulkhead (1.61) — LATENCY-driven adaptation (AIMD on p95)
//   * this middleware         — QUOTA-driven adaptation (headroom
//                               against remaining requests/tokens)
//
// The three compose cleanly: bulkhead provides the ceiling, and
// EITHER adaptive tuner can call setMaxConcurrent(). Using both
// together is fine — they'll settle on the more conservative value
// naturally.
//
//   const { adaptiveRateLimit, bulkhead } = require('@saptarishi/cds-plugin-llm');
//
//   const bh = bulkhead({ maxConcurrent: 20 });
//   llm.use(bh);
//   llm.use(adaptiveRateLimit({
//     bulkhead:  bh,
//     headroom:  0.20,           // stay 20% below remaining quota
//     minConcurrent: 2,
//     maxConcurrent: 50,
//     onAdjust: (info) => cds.log('llm:adaptive-rate-limit').info(info),
//   }));
//
// How it works
// ------------
// Every response carries rate-limit headers (parsed by the shipped
// providers into result._rateLimit — 1.38+). After each successful
// call, we read `remaining / limit` and compute a target concurrency
// that leaves `headroom` fraction as buffer:
//
//   targetC = (remainingRatio - headroom) × maxConcurrent
//
// The tuner smooths this via EMA (alpha=0.3 default) so a single
// noisy sample doesn't cause big swings. If we ever observe a 429,
// we HALVE the current concurrency immediately (respect + retreat).

const {
  parseOpenAIRateLimit,
  parseAnthropicRateLimit,
  parseGeminiRateLimit,
  parseBedrockRateLimit,
} = require('../rateLimits');

const DEFAULT_PARSERS = {
  openai:    parseOpenAIRateLimit,
  anthropic: parseAnthropicRateLimit,
  gemini:    parseGeminiRateLimit,
  bedrock:   parseBedrockRateLimit,
};

// Same signature-heuristic as retryAfterPropagation (1.94).
function detectProvider(headersOrErr) {
  const headers = headersOrErr?.headers ?? headersOrErr?.response?.headers ?? headersOrErr ?? null;
  if (!headers) return null;
  const read = (n) => typeof headers.get === 'function'
    ? headers.get(n) ?? headers.get(n.toLowerCase())
    : headers[n] ?? headers[n.toLowerCase()];
  if (read('anthropic-ratelimit-tokens-remaining') != null
      || read('anthropic-ratelimit-requests-remaining') != null) return 'anthropic';
  if (read('x-goog-quota-remaining') != null || read('x-goog-request-id') != null) return 'gemini';
  if (read('x-ratelimit-limit-requests') != null
      || read('x-ratelimit-remaining-requests') != null
      || read('x-ratelimit-limit-tokens') != null) return 'openai';
  return null;
}

function adaptiveRateLimit(options = {}) {
  const {
    bulkhead,
    parsers          = DEFAULT_PARSERS,
    headroom         = 0.20,
    alpha            = 0.30,
    minConcurrent    = 1,
    maxConcurrent    = null,
    onAdjust         = null,
    on429            = null,
    provider         = null,   // manual override
    now              = () => Date.now(),
  } = options;

  if (!bulkhead || typeof bulkhead.setMaxConcurrent !== 'function'
      || typeof bulkhead.getMaxConcurrent !== 'function') {
    throw new Error('adaptiveRateLimit: bulkhead must be a bulkhead middleware instance with setMaxConcurrent/getMaxConcurrent.');
  }
  if (!Number.isFinite(headroom) || headroom < 0 || headroom >= 1) {
    throw new Error(`adaptiveRateLimit: headroom must be in [0, 1) (got ${headroom}).`);
  }
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha > 1) {
    throw new Error(`adaptiveRateLimit: alpha must be in (0, 1] (got ${alpha}).`);
  }
  if (!Number.isInteger(minConcurrent) || minConcurrent < 1) {
    throw new Error(`adaptiveRateLimit: minConcurrent must be a positive integer (got ${minConcurrent}).`);
  }
  if (maxConcurrent != null && (!Number.isInteger(maxConcurrent) || maxConcurrent < minConcurrent)) {
    throw new Error(`adaptiveRateLimit: maxConcurrent must be an integer >= minConcurrent (got ${maxConcurrent}).`);
  }
  if (typeof parsers !== 'object' || parsers === null) {
    throw new Error('adaptiveRateLimit: parsers must be an object.');
  }
  for (const cb of [onAdjust, on429]) {
    if (cb != null && typeof cb !== 'function') {
      throw new Error('adaptiveRateLimit: callbacks must be functions or null.');
    }
  }

  // Smoothed remaining-ratio state. Range [0, 1]; higher = more headroom.
  let smoothedRatio = 1.0;

  const stats = {
    totalCalls:       0,
    samples:          0,
    adjustments:      0,
    grows:            0,
    shrinks:          0,
    on429Adjustments: 0,
    lastRatio:        null,
    lastTarget:       null,
    lastReason:       null,
    byProvider:       {},
  };

  // ---- Sampling from headers -------------------------------------

  function parseFromResult(result) {
    // Prefer the shipped providers' pre-parsed _rateLimit envelope (1.38+).
    if (result && result._rateLimit && typeof result._rateLimit === 'object') {
      return { parsed: result._rateLimit, source: 'result._rateLimit' };
    }
    const headers = result?.headers ?? result?.response?.headers;
    if (!headers) return null;
    const detected = provider ?? detectProvider({ headers });
    if (!detected) return null;
    const fn = parsers[detected];
    if (typeof fn !== 'function') return null;
    let parsed;
    try {
      parsed = detected === 'bedrock' ? fn(result.response ?? result, result?.status) : fn(headers, result?.status);
    } catch { return null; }
    if (!parsed) return null;
    return { parsed, source: detected };
  }

  function parseFromError(err) {
    const detected = provider ?? detectProvider(err);
    if (!detected) return null;
    const fn = parsers[detected];
    if (typeof fn !== 'function') return null;
    const headers = err.headers ?? err.response?.headers ?? null;
    const status = err.status ?? err.statusCode ?? err.response?.status;
    let parsed;
    try {
      parsed = detected === 'bedrock' ? fn(err.response ?? err, status) : fn(headers, status);
    } catch { return null; }
    return parsed ? { parsed, source: detected } : null;
  }

  // ---- Adjustment logic ------------------------------------------

  function updateSmoothed(remainingRatio) {
    smoothedRatio = alpha * remainingRatio + (1 - alpha) * smoothedRatio;
    return smoothedRatio;
  }

  function computeTarget(smoothed, currentCeiling) {
    // Ceiling for our tuner: caller-provided maxConcurrent, or the
    // bulkhead's current ceiling doubled (grow room).
    const upperBound = maxConcurrent ?? Math.max(currentCeiling * 2, currentCeiling);
    // Scale from remaining-ratio minus headroom, clamped to [0, 1].
    const availabilityFactor = Math.max(0, Math.min(1, smoothed - headroom));
    const raw = Math.round(availabilityFactor * upperBound);
    return Math.max(minConcurrent, Math.min(upperBound, raw));
  }

  function applyAdjustment(target, reason, providerName) {
    const before = bulkhead.getMaxConcurrent();
    if (target === before) {
      stats.lastTarget = target;
      stats.lastReason = reason;
      return { adjusted: false, before, after: before };
    }
    try { bulkhead.setMaxConcurrent(target); }
    catch { return { adjusted: false, before, after: before, err: 'setMaxConcurrent failed' }; }
    stats.adjustments++;
    if (target > before) stats.grows++;
    else stats.shrinks++;
    stats.lastTarget = target;
    stats.lastReason = reason;
    if (providerName) stats.byProvider[providerName] = (stats.byProvider[providerName] ?? 0) + 1;
    if (onAdjust) {
      try {
        onAdjust({
          reason, providerName,
          from: before, to: target,
          smoothedRatio,
          lastRatio: stats.lastRatio,
        });
      } catch { /* swallow */ }
    }
    return { adjusted: true, before, after: target };
  }

  function halveOnThrottle(providerName) {
    const before = bulkhead.getMaxConcurrent();
    const after = Math.max(minConcurrent, Math.floor(before / 2));
    if (after < before) {
      try { bulkhead.setMaxConcurrent(after); }
      catch { return; }
      stats.adjustments++;
      stats.shrinks++;
      stats.on429Adjustments++;
      stats.lastTarget = after;
      stats.lastReason = '429-halve';
      // Also reflect this in the smoothed state so we don't
      // immediately re-grow on the next successful sample.
      smoothedRatio = Math.max(0, smoothedRatio * 0.5);
      if (providerName) stats.byProvider[providerName] = (stats.byProvider[providerName] ?? 0) + 1;
      if (onAdjust) {
        try { onAdjust({ reason: '429-halve', providerName, from: before, to: after, smoothedRatio }); }
        catch { /* swallow */ }
      }
    }
    if (on429) {
      try { on429({ providerName, before, after }); }
      catch { /* swallow */ }
    }
  }

  // ---- Middleware body -------------------------------------------

  const mw = async (ctx, next) => {
    stats.totalCalls++;
    let result;
    try {
      result = await next();
    } catch (err) {
      const status = err?.status ?? err?.statusCode;
      // 429 → halve immediately.
      if (status === 429 || err?.code === 'RATE_LIMIT_GIVE_UP') {
        const info = parseFromError(err);
        halveOnThrottle(info?.source ?? null);
      } else if (status === 503) {
        // Some providers return 503 for throttling — also halve.
        halveOnThrottle(null);
      } else {
        // Non-throttle error may still have rate-limit headers on the response.
        const info = parseFromError(err);
        if (info) samplePost(info);
      }
      throw err;
    }

    // Success — sample rate-limit headers.
    const info = parseFromResult(result);
    if (info) samplePost(info);
    return result;
  };

  function samplePost(info) {
    const parsed = info.parsed;
    // Compute a remaining-ratio; prefer whichever axis is TIGHTER
    // (requests vs tokens) since 429s can come from either.
    const ratios = [];
    if (parsed.requestsLimit != null && parsed.requestsRemaining != null && parsed.requestsLimit > 0) {
      ratios.push(parsed.requestsRemaining / parsed.requestsLimit);
    }
    if (parsed.tokensLimit != null && parsed.tokensRemaining != null && parsed.tokensLimit > 0) {
      ratios.push(parsed.tokensRemaining / parsed.tokensLimit);
    }
    if (ratios.length === 0) return;

    const remainingRatio = Math.max(0, Math.min(1, Math.min(...ratios)));
    stats.samples++;
    stats.lastRatio = remainingRatio;

    const smoothed = updateSmoothed(remainingRatio);
    const currentCeiling = bulkhead.getMaxConcurrent();
    const target = computeTarget(smoothed, currentCeiling);
    applyAdjustment(target, remainingRatio < 0.2 ? 'low-remaining' : 'sample', info.source);
  }

  mw.stats = stats;
  mw.reset = () => {
    stats.totalCalls = stats.samples = stats.adjustments = 0;
    stats.grows = stats.shrinks = stats.on429Adjustments = 0;
    stats.lastRatio = stats.lastTarget = stats.lastReason = null;
    for (const k of Object.keys(stats.byProvider)) delete stats.byProvider[k];
    smoothedRatio = 1.0;
  };
  mw.asMcpResource = () => ({
    uri: 'config://adaptive-rate-limit',
    name: 'Adaptive rate-limit tuner',
    description: 'Watches provider rate-limit headers and adjusts bulkhead concurrency to stay within remaining quota.',
    mimeType: 'application/json',
    handler: () => ({
      headroom, alpha, minConcurrent,
      maxConcurrentCap: maxConcurrent,
      currentBulkheadMax: bulkhead.getMaxConcurrent(),
      smoothedRatio,
      supportedProviders: Object.keys(parsers),
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  adaptiveRateLimit,
  DEFAULT_PARSERS,
  // Exposed for tests + composition.
  detectProvider,
};
