// User feedback aggregator. Collect human ratings (thumbs up/down or
// 1-5 stars) per response, aggregate by dimensions (prompt template,
// model, tenant), and expose per-dimension pass rates for real-time
// dashboards. Distinct from:
//   * `scoreResponse` (2.4)   — MECHANICAL rubric scoring
//   * `llmJudge` (1.84)        — LLM-as-judge scoring
//   * `userFeedbackAggregator` (this) — HUMAN feedback aggregation
//
// Two-part primitive:
//   1. Middleware attaches `feedbackId` to each result for later
//      attribution.
//   2. `submitFeedback(id, rating, meta?)` records the human rating
//      once the user actually reacts (thumbs / star).
//
//   const { userFeedbackAggregator } = require('@saptarishi/cds-plugin-llm');
//
//   const feedback = userFeedbackAggregator({
//     dimensionsOf: (ctx, result) => ({
//       template: ctx.meta?.promptVersion?.name,
//       model:    result?.model,
//       tenant:   ctx.request.tenantId,
//     }),
//     ratingKind:   'binary',        // 'binary' | 'scale' | 'custom'
//     windowMs:     7 * 24 * 3600_000,   // 7 days
//   });
//   llm.use(feedback);
//
//   // Later, when the user clicks 👍:
//   feedback.submitFeedback(response.feedbackId, 'up');
//
//   // Dashboard query:
//   feedback.getAggregate({ template: 'summarize' });
//   // → { totalRatings: 145, positiveRatings: 123, positiveRate: 0.848, breakdown: {...} }

// ---- Rating normalization -----------------------------------------

function normalizeBinary(rating) {
  if (rating === 'up' || rating === 1 || rating === true) return 1;
  if (rating === 'down' || rating === -1 || rating === false) return -1;
  if (rating === 0 || rating === 'neutral') return 0;
  return null;
}

function normalizeScale(rating, min, max) {
  if (typeof rating !== 'number' || !Number.isFinite(rating)) return null;
  if (rating < min || rating > max) return null;
  return rating;
}

function isPositive(rating, ratingKind, positivityThreshold) {
  if (ratingKind === 'binary') return rating > 0;
  if (ratingKind === 'scale')  return rating >= positivityThreshold;
  return rating > 0;   // custom fallback: >0 counts as positive
}

// ---- ID generation ----------------------------------------------

let idCounter = 0;
function generateFeedbackId(now) {
  return `fb-${now()}-${(++idCounter).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---- Middleware ------------------------------------------------

function userFeedbackAggregator(options = {}) {
  const {
    dimensionsOf         = () => ({}),
    ratingKind           = 'binary',       // 'binary' | 'scale' | 'custom'
    scaleMin             = 1,
    scaleMax             = 5,
    positivityThreshold  = 4,               // rating >= this = positive (for scale)
    positivityOf         = null,            // custom: (rating) => bool
    windowMs             = 30 * 24 * 3600_000,
    attachIdAs           = 'feedbackId',
    onFeedback           = null,
    onError              = null,
    now                  = () => Date.now(),
  } = options;

  if (!['binary', 'scale', 'custom'].includes(ratingKind)) {
    throw new Error(`userFeedbackAggregator: ratingKind must be 'binary' | 'scale' | 'custom' (got ${JSON.stringify(ratingKind)}).`);
  }
  if (typeof dimensionsOf !== 'function') {
    throw new Error('userFeedbackAggregator: dimensionsOf must be a function.');
  }
  if (ratingKind === 'scale') {
    if (!Number.isInteger(scaleMin) || !Number.isInteger(scaleMax) || scaleMin >= scaleMax) {
      throw new Error(`userFeedbackAggregator: scaleMin (${scaleMin}) must be < scaleMax (${scaleMax}), both integers.`);
    }
    if (!Number.isFinite(positivityThreshold) || positivityThreshold < scaleMin || positivityThreshold > scaleMax) {
      throw new Error(`userFeedbackAggregator: positivityThreshold must be within [${scaleMin}, ${scaleMax}].`);
    }
  }
  if (ratingKind === 'custom' && typeof positivityOf !== 'function') {
    throw new Error('userFeedbackAggregator: ratingKind=custom requires positivityOf(rating) function.');
  }
  if (!Number.isInteger(windowMs) || windowMs < 1000) {
    throw new Error(`userFeedbackAggregator: windowMs must be an integer >= 1000 (got ${windowMs}).`);
  }
  if (typeof attachIdAs !== 'string' || attachIdAs.length === 0) {
    throw new Error('userFeedbackAggregator: attachIdAs must be a non-empty string.');
  }
  for (const cb of [onFeedback, onError]) {
    if (cb != null && typeof cb !== 'function') {
      throw new Error('userFeedbackAggregator: callbacks must be functions or null.');
    }
  }

  // Map<feedbackId, { dimensions, respondedAt, ratings: [{ts, rating, meta}] }>
  const entries = new Map();

  const stats = {
    totalResponses:   0,
    totalFeedback:    0,
    positiveFeedback: 0,
    negativeFeedback: 0,
    neutralFeedback:  0,
    invalidRatings:   0,
    dimensionErrors:  0,
    unknownIds:       0,
    prunedEntries:    0,
  };

  function callHook(hook, arg) {
    if (!hook) return;
    try { const r = hook(arg); if (r && typeof r.then === 'function') r.catch(() => {}); }
    catch { /* swallow */ }
  }

  function pruneOld() {
    const cutoff = now() - windowMs;
    for (const [id, entry] of entries.entries()) {
      if (entry.respondedAt < cutoff) {
        entries.delete(id);
        stats.prunedEntries++;
      }
    }
  }

  function matchesFilter(dimensions, filter) {
    if (!filter) return true;
    for (const [k, v] of Object.entries(filter)) {
      if (dimensions?.[k] !== v) return false;
    }
    return true;
  }

  function ratingPositivity(normalized) {
    if (ratingKind === 'custom') {
      try { return positivityOf(normalized) ? 1 : normalized === 0 ? 0 : -1; }
      catch { return 0; }
    }
    if (ratingKind === 'binary') return normalized;
    // scale
    return normalized >= positivityThreshold ? 1 : -1;
  }

  const mw = async (ctx, next) => {
    stats.totalResponses++;
    const result = await next();
    if (!result || typeof result !== 'object') return result;

    let dimensions = {};
    try { dimensions = dimensionsOf(ctx, result) ?? {}; }
    catch (err) {
      stats.dimensionErrors++;
      callHook(onError, { phase: 'dimensionsOf', error: err });
    }

    const id = generateFeedbackId(now);
    entries.set(id, {
      dimensions:   dimensions ?? {},
      respondedAt:  now(),
      ratings:      [],
    });
    result[attachIdAs] = id;
    return result;
  };

  mw.submitFeedback = (feedbackId, rating, meta = {}) => {
    const entry = entries.get(feedbackId);
    if (!entry) {
      stats.unknownIds++;
      return { accepted: false, reason: 'unknown-id' };
    }

    let normalized;
    if (ratingKind === 'binary') {
      normalized = normalizeBinary(rating);
    } else if (ratingKind === 'scale') {
      normalized = normalizeScale(rating, scaleMin, scaleMax);
    } else {
      // custom — pass through numeric values only.
      normalized = typeof rating === 'number' && Number.isFinite(rating) ? rating : null;
    }
    if (normalized === null) {
      stats.invalidRatings++;
      return { accepted: false, reason: 'invalid-rating' };
    }

    entry.ratings.push({ ts: now(), rating: normalized, meta });
    stats.totalFeedback++;

    const positivity = ratingPositivity(normalized);
    if (positivity > 0) stats.positiveFeedback++;
    else if (positivity < 0) stats.negativeFeedback++;
    else stats.neutralFeedback++;

    callHook(onFeedback, {
      feedbackId, rating: normalized, meta,
      dimensions: entry.dimensions, positive: positivity > 0,
    });

    return { accepted: true, reason: null };
  };

  mw.getAggregate = (filter = null) => {
    pruneOld();
    let totalRatings = 0;
    let positive = 0;
    let negative = 0;
    let neutral = 0;
    for (const entry of entries.values()) {
      if (!matchesFilter(entry.dimensions, filter)) continue;
      for (const r of entry.ratings) {
        totalRatings++;
        const p = ratingPositivity(r.rating);
        if (p > 0) positive++;
        else if (p < 0) negative++;
        else neutral++;
      }
    }
    const positiveRate = totalRatings === 0 ? 0 : positive / totalRatings;
    return { totalRatings, positive, negative, neutral, positiveRate };
  };

  mw.snapshotByDimension = (dimensionName) => {
    pruneOld();
    // groupKey → { positive, negative, neutral, total }
    const groups = {};
    for (const entry of entries.values()) {
      const key = String(entry.dimensions?.[dimensionName] ?? '__none__');
      let g = groups[key];
      if (!g) { g = { positive: 0, negative: 0, neutral: 0, total: 0 }; groups[key] = g; }
      for (const r of entry.ratings) {
        g.total++;
        const p = ratingPositivity(r.rating);
        if (p > 0) g.positive++;
        else if (p < 0) g.negative++;
        else g.neutral++;
      }
    }
    // Attach positive rate to each group.
    for (const key of Object.keys(groups)) {
      const g = groups[key];
      g.positiveRate = g.total === 0 ? 0 : g.positive / g.total;
    }
    return groups;
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.totalResponses = stats.totalFeedback = 0;
    stats.positiveFeedback = stats.negativeFeedback = stats.neutralFeedback = 0;
    stats.invalidRatings = stats.dimensionErrors = stats.unknownIds = stats.prunedEntries = 0;
    entries.clear();
  };
  mw.pendingCount = () => entries.size;
  mw.asMcpResource = () => ({
    uri: 'config://user-feedback',
    name: 'User feedback aggregator',
    description: 'Collect human ratings + aggregate per-dimension (template/model/tenant). Companion to mechanical scoring.',
    mimeType: 'application/json',
    handler: () => ({
      ratingKind,
      scaleMin: ratingKind === 'scale' ? scaleMin : undefined,
      scaleMax: ratingKind === 'scale' ? scaleMax : undefined,
      positivityThreshold: ratingKind === 'scale' ? positivityThreshold : undefined,
      windowMs, attachIdAs,
      aggregate: mw.getAggregate(),
      pendingCount: entries.size,
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  userFeedbackAggregator,
  normalizeBinary,
  normalizeScale,
};
