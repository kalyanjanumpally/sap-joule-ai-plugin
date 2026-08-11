// Cost forecasting middleware. Tracks rolling spend in a sliding
// window and projects the end-of-window total based on the current
// burn rate. Emits WARN / CRITICAL events when the projection
// exceeds configured thresholds — the "you'll hit the limit at
// 2:47pm" companion to costBudget (hard ceiling) and costGuard
// (per-call limit).
//
// Records cost by reading result.usage + a pricing table, same way
// usageMetering does. Standalone — doesn't require usageMetering
// to be in the chain, but composes cleanly with it.
//
//   const { costForecast } = require('@saptarishi/cds-plugin-llm');
//
//   llm.use(costForecast({
//     windowMs:      60 * 60_000,      // 1-hour window
//     targetUsd:     50.00,             // budget for the window
//     warnAtRatio:   0.80,              // warn at 80% of projected spend
//     criticalAtRatio: 1.00,            // critical at 100%+
//     minSampleSize: 20,                // don't project until 20 calls seen
//     onWarn:  (info) => cds.log('llm:cost').warn(info),
//     onCritical: (info) => cds.log('llm:cost').error(info),
//   }));
//
//   // Projection formula:
//   //   projectedUsd = (spentInWindowUsd / elapsedInWindowMs) × windowMs
//   //
//   // Fires 'warn' when projectedUsd >= targetUsd × warnAtRatio,
//   // fires 'critical' when projectedUsd >= targetUsd × criticalAtRatio.

const { DEFAULT_PRICING } = require('../pricing');

const LEVEL_ORDER = { ok: 0, warn: 1, critical: 2 };

// ---- Pricing math (mirrors usageMetering) ----------------------------

function computeCost(usage, model, pricing) {
  if (!model || !usage) return { inputCost: 0, outputCost: 0, totalCost: 0, priced: false };
  const p = pricing[model];
  if (!p) return { inputCost: 0, outputCost: 0, totalCost: 0, priced: false };
  const iTok = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const oTok = usage.output_tokens ?? usage.completion_tokens ?? 0;
  const inputCost  = (iTok * (p.input  ?? 0)) / 1_000_000;
  const outputCost = (oTok * (p.output ?? 0)) / 1_000_000;
  return { inputCost, outputCost, totalCost: inputCost + outputCost, priced: true };
}

// ---- Main middleware -------------------------------------------------

function costForecast(options = {}) {
  const {
    windowMs         = 60 * 60_000,      // 1h
    targetUsd,
    warnAtRatio      = 0.8,
    criticalAtRatio  = 1.0,
    minSampleSize    = 10,
    pricing          = DEFAULT_PRICING,
    currency         = 'USD',
    onWarn           = null,
    onCritical       = null,
    onSpend          = null,
    now              = () => Date.now(),
    skipMethods      = [],
  } = options;

  if (!Number.isFinite(windowMs) || windowMs < 1000) {
    throw new Error(`costForecast: windowMs must be >= 1000 (got ${windowMs}).`);
  }
  if (targetUsd == null) {
    throw new Error('costForecast: targetUsd is required.');
  }
  if (!Number.isFinite(targetUsd) || targetUsd <= 0) {
    throw new Error(`costForecast: targetUsd must be > 0 (got ${targetUsd}).`);
  }
  if (!Number.isFinite(warnAtRatio) || warnAtRatio <= 0 || warnAtRatio > 1) {
    throw new Error(`costForecast: warnAtRatio must be in (0, 1] (got ${warnAtRatio}).`);
  }
  if (!Number.isFinite(criticalAtRatio) || criticalAtRatio <= 0) {
    throw new Error(`costForecast: criticalAtRatio must be > 0 (got ${criticalAtRatio}).`);
  }
  if (criticalAtRatio < warnAtRatio) {
    throw new Error('costForecast: criticalAtRatio must be >= warnAtRatio.');
  }
  if (!Number.isInteger(minSampleSize) || minSampleSize < 1) {
    throw new Error(`costForecast: minSampleSize must be a positive integer (got ${minSampleSize}).`);
  }
  if (typeof pricing !== 'object' || pricing === null) {
    throw new Error('costForecast: pricing must be an object.');
  }
  if (!Array.isArray(skipMethods)) {
    throw new Error('costForecast: skipMethods must be an array.');
  }
  for (const cb of [onWarn, onCritical, onSpend]) {
    if (cb != null && typeof cb !== 'function') {
      throw new Error('costForecast: callbacks must be functions or null.');
    }
  }

  const skipSet = new Set(skipMethods);

  // Ring of { atMs, costUsd } — only entries within windowMs are counted.
  const samples = [];
  // Track window start so partial windows are handled correctly at cold start.
  let windowStartMs = now();

  const stats = {
    totalCalls:      0,
    totalUsd:        0,
    sampleCount:     0,
    lastProjection:  null,
    lastLevel:       'ok',
    warnFires:       0,
    criticalFires:   0,
    unpricedCalls:   0,
  };

  function pruneOldSamples(currentMs) {
    const cutoff = currentMs - windowMs;
    let firstFresh = 0;
    while (firstFresh < samples.length && samples[firstFresh].atMs < cutoff) firstFresh++;
    if (firstFresh > 0) samples.splice(0, firstFresh);
  }

  function computeProjection(currentMs) {
    pruneOldSamples(currentMs);
    if (samples.length === 0) return null;

    const spentInWindowUsd = samples.reduce((s, e) => s + e.costUsd, 0);
    // Elapsed = time from the OLDEST sample OR windowStartMs, whichever is more recent.
    // At cold start, elapsed grows toward windowMs; once warmed, we always use windowMs.
    const oldestSampleMs = samples[0].atMs;
    const windowSpanMs = Math.max(1, currentMs - Math.max(oldestSampleMs, windowStartMs));
    const projectionRatio = windowMs / windowSpanMs;
    const projectedUsd = spentInWindowUsd * projectionRatio;

    return {
      spentInWindowUsd,
      windowSpanMs,
      windowMs,
      projectedUsd,
      targetUsd,
      utilizationRatio:  projectedUsd / targetUsd,
      sampleCount:       samples.length,
      currency,
    };
  }

  function evaluateThresholds(projection) {
    if (projection == null) return { level: 'ok' };
    if (samples.length < minSampleSize) return { level: 'ok', reason: 'below-sample-size' };
    if (projection.utilizationRatio >= criticalAtRatio) return { level: 'critical' };
    if (projection.utilizationRatio >= warnAtRatio)     return { level: 'warn' };
    return { level: 'ok' };
  }

  function recordSpend(costUsd, tags = {}) {
    stats.totalCalls++;
    if (costUsd > 0) {
      const currentMs = now();
      samples.push({ atMs: currentMs, costUsd });
      stats.totalUsd += costUsd;

      // Prune stale samples via computeProjection, THEN sync sampleCount.
      const projection = computeProjection(currentMs);
      stats.sampleCount = samples.length;
      stats.lastProjection = projection;

      const evaluation = evaluateThresholds(projection);
      const prevLevel = stats.lastLevel;
      stats.lastLevel = evaluation.level;

      if (onSpend) {
        try { onSpend({ costUsd, ...tags, projection, level: evaluation.level }); }
        catch { /* swallow */ }
      }

      // Fire callbacks only on level transitions (rising edge) so consumers
      // aren't spammed by every call once we cross a threshold. Rising to
      // critical also fires warn — a hard jump straight to critical
      // shouldn't skip the warn notification.
      const rising = LEVEL_ORDER[evaluation.level] > LEVEL_ORDER[prevLevel];
      if (rising && evaluation.level !== 'ok') {
        if (LEVEL_ORDER[evaluation.level] >= LEVEL_ORDER.warn && LEVEL_ORDER[prevLevel] < LEVEL_ORDER.warn) {
          stats.warnFires++;
          if (onWarn) {
            try { onWarn({ projection, ...tags }); }
            catch { /* swallow */ }
          }
        }
        if (evaluation.level === 'critical' && prevLevel !== 'critical') {
          stats.criticalFires++;
          if (onCritical) {
            try { onCritical({ projection, ...tags }); }
            catch { /* swallow */ }
          }
        }
      }
    }
  }

  const mw = async (ctx, next) => {
    if (skipSet.has(ctx?.method)) return next();

    const result = await next();

    if (ctx?.method === 'stream') {
      // Streams: use the 1.72 completion tracker if available; else consume
      // usage from the result envelope (some providers set it on the stream
      // object).
      const { hasStreamCompletion } = require('../streamCompletion');
      if (hasStreamCompletion(result)) {
        result.onComplete((info) => {
          if (!info?.ok || !info.doneChunk) return;
          const model = info.doneChunk.model ?? ctx.request?.model;
          const cost = computeCost(info.doneChunk.usage, model, pricing);
          if (!cost.priced) { stats.unpricedCalls++; return; }
          recordSpend(cost.totalCost, {
            model,
            method:  ctx.method,
            tenant:  ctx.raw?.tenant ?? null,
          });
        });
      }
      return result;
    }

    const model = result?.model ?? ctx?.request?.model;
    const cost = computeCost(result?.usage, model, pricing);
    if (!cost.priced) stats.unpricedCalls++;
    else {
      recordSpend(cost.totalCost, {
        model,
        method:  ctx.method,
        tenant:  ctx.raw?.tenant ?? null,
      });
    }
    return result;
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.totalCalls = stats.sampleCount = stats.warnFires = stats.criticalFires = stats.unpricedCalls = 0;
    stats.totalUsd = 0;
    stats.lastProjection = null;
    stats.lastLevel = 'ok';
    samples.length = 0;
    windowStartMs = now();
  };
  mw.projection = () => computeProjection(now());
  mw.asMcpResource = () => ({
    uri: 'config://cost-forecast',
    name: 'Cost forecasting',
    description: 'Rolling-window spend + projected end-of-window total. Counters, current projection, threshold state.',
    mimeType: 'application/json',
    handler: () => ({
      windowMs,
      targetUsd,
      currency,
      warnAtRatio,
      criticalAtRatio,
      minSampleSize,
      currentLevel:   stats.lastLevel,
      projection:     mw.projection(),
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  costForecast,
  // Exposed for tests + composition.
  computeCost,
};
