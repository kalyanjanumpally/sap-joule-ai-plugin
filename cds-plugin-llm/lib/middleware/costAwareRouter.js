// Cost-aware model router. Try a cheap model first; if the response
// scores below a quality threshold, escalate to the next-tier model.
// Ties together `modelRouter` (1.x — static routing rules),
// `scoreResponse` (2.4 — mechanical response scoring), and
// `costForecast` (2.1 — budget projection). Real economic win for
// repetitive tasks with a quality floor: most calls run on the cheap
// model; only the hard ones escalate.
//
//   const { costAwareRouter, scoreResponse } = require('@saptarishi/cds-plugin-llm');
//
//   llm.use(costAwareRouter({
//     tiers: [
//       { model: 'gpt-4o-mini', pricePerMtokIn: 0.15, pricePerMtokOut: 0.60 },
//       { model: 'gpt-4o',      pricePerMtokIn: 2.50, pricePerMtokOut: 10.00 },
//     ],
//     scorer:         (result) => scoreResponse(result, { rubric }).score,
//     scoreThreshold: 0.75,
//     onEscalate: (i) => cds.log('llm:router').info('escalate', i),
//   }));
//
// Placement in the chain: OUTSIDE any middleware that reads
// `request.model` (retry, bulkhead, providers). The router mutates
// `request.model` per attempt so downstream sees each tier as a fresh
// call. Escalations are counted separately from `retry` — this is a
// *quality-driven* re-attempt, not a *transport-error* re-attempt.

// Kept small so users can grep the ordering without loading the whole
// module.
const TIER_LABEL_BY_INDEX = ['tier0', 'tier1', 'tier2', 'tier3', 'tier4', 'tier5'];

function labelForTier(i) { return TIER_LABEL_BY_INDEX[i] ?? `tier${i}`; }

function costAwareRouter(options = {}) {
  const {
    tiers,
    scorer,
    scoreThreshold  = 0.7,
    maxEscalations  = null,   // null = escalate through all tiers
    escalateOnError = true,   // downstream throw on a lower tier → try next tier
    applyModel      = (request, model) => ({ ...request, model }),
    tierName,                 // (tier, index) => string; default labelForTier(i)
    onEscalate      = null,
    onFinal         = null,
    onError         = null,
  } = options;

  if (!Array.isArray(tiers) || tiers.length < 2) {
    throw new Error('costAwareRouter: tiers must be an array of at least 2 entries.');
  }
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    if (!t || typeof t !== 'object' || typeof t.model !== 'string') {
      throw new Error(`costAwareRouter: tiers[${i}] must be { model: string, ... }.`);
    }
  }
  if (typeof scorer !== 'function') {
    throw new Error('costAwareRouter: scorer must be a function (result, ctx) => number in [0, 1].');
  }
  if (!Number.isFinite(scoreThreshold) || scoreThreshold < 0 || scoreThreshold > 1) {
    throw new Error(`costAwareRouter: scoreThreshold must be in [0, 1] (got ${scoreThreshold}).`);
  }
  if (maxEscalations != null && (!Number.isInteger(maxEscalations) || maxEscalations < 0)) {
    throw new Error(`costAwareRouter: maxEscalations must be a non-negative integer or null (got ${maxEscalations}).`);
  }
  if (typeof applyModel !== 'function') {
    throw new Error('costAwareRouter: applyModel must be a function.');
  }
  if (tierName != null && typeof tierName !== 'function') {
    throw new Error('costAwareRouter: tierName must be a function or null.');
  }
  for (const cb of [onEscalate, onFinal, onError]) {
    if (cb != null && typeof cb !== 'function') {
      throw new Error('costAwareRouter: callbacks must be functions or null.');
    }
  }

  const nameOf = tierName ?? ((_t, i) => labelForTier(i));

  // Estimate USD cost of a single completion. Best-effort: needs the
  // shipped `result.usage.{input_tokens, output_tokens}` shape from
  // 1.x. Missing pricing or usage → returns null (excluded from
  // savings stats).
  function estimateCostUsd(tier, result) {
    const usage = result?.usage;
    if (!usage) return null;
    const inTok  = usage.input_tokens  ?? usage.prompt_tokens     ?? 0;
    const outTok = usage.output_tokens ?? usage.completion_tokens ?? 0;
    if (typeof tier.pricePerMtokIn !== 'number' || typeof tier.pricePerMtokOut !== 'number') return null;
    return (inTok / 1e6) * tier.pricePerMtokIn + (outTok / 1e6) * tier.pricePerMtokOut;
  }

  const stats = {
    totalCalls:       0,
    resolvedByTier:   {},        // tier name -> count
    escalations:      0,
    escalationsByFromTier: {},
    scoreExceptions:  0,
    downstreamErrors: 0,
    givenUp:          0,         // exhausted tiers with score still below threshold
    tokensSavedUsd:   0,         // estimated $ saved vs. always-premium
    tokensSpentUsd:   0,         // estimated $ actually spent
    lastTier:         null,
    lastScore:        null,
  };
  for (let i = 0; i < tiers.length; i++) {
    stats.resolvedByTier[nameOf(tiers[i], i)] = 0;
    stats.escalationsByFromTier[nameOf(tiers[i], i)] = 0;
  }

  function callHook(hook, arg) {
    if (!hook) return;
    try { const r = hook(arg); if (r && typeof r.then === 'function') r.catch(() => {}); }
    catch { /* swallow */ }
  }

  function safeScore(result, ctx) {
    try {
      const s = scorer(result, ctx);
      if (typeof s === 'number' && Number.isFinite(s)) return s;
      return -Infinity;   // non-numeric → treat as failing
    } catch (err) {
      stats.scoreExceptions++;
      callHook(onError, { phase: 'scorer', error: err });
      return -Infinity;
    }
  }

  const mw = async (ctx, next) => {
    stats.totalCalls++;
    const originalRequest = ctx.request;
    const upperBound = maxEscalations == null ? tiers.length : Math.min(tiers.length, maxEscalations + 1);

    let lastResult = null;
    let lastError  = null;

    for (let i = 0; i < upperBound; i++) {
      const tier      = tiers[i];
      const tierLabel = nameOf(tier, i);

      // Apply model override for this tier.
      ctx.request = applyModel(originalRequest, tier.model);

      let result;
      try {
        result = await next();
        lastResult = result;
        lastError  = null;
      } catch (err) {
        stats.downstreamErrors++;
        lastError = err;
        callHook(onError, { phase: 'downstream', tier: tierLabel, tierIndex: i, error: err });
        if (escalateOnError && i < upperBound - 1) {
          stats.escalations++;
          stats.escalationsByFromTier[tierLabel] = (stats.escalationsByFromTier[tierLabel] ?? 0) + 1;
          callHook(onEscalate, {
            fromTier: tierLabel, fromIndex: i,
            toTier: nameOf(tiers[i + 1], i + 1), toIndex: i + 1,
            reason: 'downstream-error', score: null, error: err,
          });
          continue;
        }
        // Not escalating on error, or already at the top tier.
        ctx.request = originalRequest;
        throw err;
      }

      // Score the tier's response.
      const score = safeScore(result, ctx);
      stats.lastScore = score;

      if (score >= scoreThreshold || i === upperBound - 1) {
        // Either the response is good enough OR we're at the top tier
        // and can't escalate further. Accept + return.
        ctx.request = originalRequest;
        stats.lastTier = tierLabel;
        stats.resolvedByTier[tierLabel] = (stats.resolvedByTier[tierLabel] ?? 0) + 1;
        if (score < scoreThreshold && i === upperBound - 1) stats.givenUp++;

        // Cost accounting: what we spent vs. what the top tier would have
        // cost. Only meaningful if we resolved on a cheaper tier.
        const spent = estimateCostUsd(tier, result);
        const wouldHaveSpent = estimateCostUsd(tiers[tiers.length - 1], result);
        if (spent != null) stats.tokensSpentUsd += spent;
        if (spent != null && wouldHaveSpent != null && i < tiers.length - 1) {
          stats.tokensSavedUsd += Math.max(0, wouldHaveSpent - spent);
        }

        callHook(onFinal, {
          tier: tierLabel, tierIndex: i, score,
          escalated: i > 0, aboveThreshold: score >= scoreThreshold,
        });
        return result;
      }

      // Below threshold — escalate.
      stats.escalations++;
      stats.escalationsByFromTier[tierLabel] = (stats.escalationsByFromTier[tierLabel] ?? 0) + 1;
      callHook(onEscalate, {
        fromTier: tierLabel, fromIndex: i,
        toTier: nameOf(tiers[i + 1], i + 1), toIndex: i + 1,
        reason: 'low-score', score,
      });
    }

    // Unreachable in the normal path (the loop always returns or throws).
    // Kept as a defensive rethrow for the escalateOnError=false + top-tier-error case.
    ctx.request = originalRequest;
    if (lastError) throw lastError;
    return lastResult;
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.totalCalls = stats.escalations = 0;
    stats.scoreExceptions = stats.downstreamErrors = stats.givenUp = 0;
    stats.tokensSavedUsd = stats.tokensSpentUsd = 0;
    stats.lastTier = stats.lastScore = null;
    for (const k of Object.keys(stats.resolvedByTier)) stats.resolvedByTier[k] = 0;
    for (const k of Object.keys(stats.escalationsByFromTier)) stats.escalationsByFromTier[k] = 0;
  };
  mw.escalationRate = () => {
    return stats.totalCalls === 0 ? 0 : stats.escalations / stats.totalCalls;
  };
  mw.savingsRatio = () => {
    const potentialTotal = stats.tokensSpentUsd + stats.tokensSavedUsd;
    return potentialTotal === 0 ? 0 : stats.tokensSavedUsd / potentialTotal;
  };
  mw.asMcpResource = () => ({
    uri: 'config://cost-aware-router',
    name: 'Cost-aware model router',
    description: 'Tries cheap tier first; escalates to premium tier when response scores below threshold.',
    mimeType: 'application/json',
    handler: () => ({
      tiers: tiers.map((t, i) => ({
        name: nameOf(t, i),
        model: t.model,
        pricePerMtokIn: t.pricePerMtokIn ?? null,
        pricePerMtokOut: t.pricePerMtokOut ?? null,
      })),
      scoreThreshold,
      maxEscalations,
      escalateOnError,
      escalationRate: mw.escalationRate(),
      savingsRatio:   mw.savingsRatio(),
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  costAwareRouter,
  // Exposed for tests + composition.
  labelForTier,
};
