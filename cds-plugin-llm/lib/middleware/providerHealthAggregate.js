// Provider health aggregate. Combines multiple signals into a single
// unified health score per provider — error rate over a rolling window,
// p95 latency, optional circuit-breaker state — so routing decisions
// can consult ONE metric instead of stitching together five.
//
// Complements:
//   * `providerHealthProbe` (1.62)   — PROACTIVE liveness pings
//   * `circuitBreaker` (1.x)          — REACTIVE per-error trip
//   * `adaptiveBulkhead` (1.61)       — latency-driven concurrency tuner
//   * `providerHealthAggregate` (this) — UNIFIED score across all signals
//
//   const { providerHealthAggregate } = require('@saptarishi/cds-plugin-llm');
//
//   const health = providerHealthAggregate({
//     providerOf: (ctx, result) => result?.model?.split('/')[0] ?? 'unknown',
//     windowMs: 60_000,
//     errorRateThreshold:  0.10,   // >10% errors → degraded
//     latencyP95Threshold: 15_000, // >15s p95 → degraded
//     onDegraded:  (i) => cds.log('llm:health').error('degraded', i),
//     onRecovered: (i) => cds.log('llm:health').info('recovered', i),
//   });
//   llm.use(health);
//
//   // Later, in routing logic:
//   const s = health.getHealth('openai');
//   //  → { healthy: true, score: 0.92, errorRate: 0.02, latencyP95Ms: 3200, samples: 145 }

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const rank = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  const frac = rank - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

function providerHealthAggregate(options = {}) {
  const {
    providerOf,
    windowMs             = 60_000,
    errorRateThreshold   = 0.10,
    latencyP95Threshold  = 15_000,
    minSampleSize        = 10,        // don't judge until we have enough data
    scoreWeights         = { errorRate: 0.6, latencyP95: 0.4 },
    breakerFor           = null,
    onDegraded           = null,
    onRecovered          = null,
    onSample             = null,
    onError              = null,
    now                  = () => Date.now(),
  } = options;

  if (typeof providerOf !== 'function') {
    throw new Error('providerHealthAggregate: providerOf(ctx, result?) must be a function.');
  }
  if (!Number.isInteger(windowMs) || windowMs < 100) {
    throw new Error(`providerHealthAggregate: windowMs must be an integer >= 100 (got ${windowMs}).`);
  }
  if (!Number.isFinite(errorRateThreshold) || errorRateThreshold <= 0 || errorRateThreshold > 1) {
    throw new Error(`providerHealthAggregate: errorRateThreshold must be in (0, 1] (got ${errorRateThreshold}).`);
  }
  if (!Number.isFinite(latencyP95Threshold) || latencyP95Threshold <= 0) {
    throw new Error(`providerHealthAggregate: latencyP95Threshold must be > 0 (got ${latencyP95Threshold}).`);
  }
  if (!Number.isInteger(minSampleSize) || minSampleSize < 1) {
    throw new Error(`providerHealthAggregate: minSampleSize must be a positive integer (got ${minSampleSize}).`);
  }
  if (scoreWeights == null || typeof scoreWeights !== 'object') {
    throw new Error('providerHealthAggregate: scoreWeights must be an object.');
  }
  if (breakerFor != null && typeof breakerFor !== 'function') {
    throw new Error('providerHealthAggregate: breakerFor must be a function or null.');
  }
  for (const cb of [onDegraded, onRecovered, onSample, onError]) {
    if (cb != null && typeof cb !== 'function') {
      throw new Error('providerHealthAggregate: callbacks must be functions or null.');
    }
  }

  // Per-provider state.
  //   name → { samples: [{ts, latencyMs, ok}], healthy, lastTransitionAt, lastScore, totalCalls, totalErrors }
  const state = new Map();

  const stats = {
    totalCalls:          0,
    totalErrors:         0,
    degradedTransitions: 0,
    recoveredTransitions: 0,
    providersTracked:    0,
    lastProvider:        null,
  };

  function callHook(hook, arg) {
    if (!hook) return;
    try { const r = hook(arg); if (r && typeof r.then === 'function') r.catch(() => {}); }
    catch { /* swallow */ }
  }

  function stateFor(name) {
    let s = state.get(name);
    if (!s) {
      s = {
        samples:          [],
        healthy:          true,
        lastTransitionAt: null,
        lastScore:        1,
        totalCalls:       0,
        totalErrors:      0,
      };
      state.set(name, s);
      stats.providersTracked = state.size;
    }
    return s;
  }

  function pruneOld(s, cutoff) {
    while (s.samples.length > 0 && s.samples[0].ts < cutoff) s.samples.shift();
  }

  function computeMetrics(s) {
    const cutoff = now() - windowMs;
    pruneOld(s, cutoff);
    const total = s.samples.length;
    if (total === 0) {
      return { samples: 0, errorRate: 0, latencyP95Ms: 0, score: 1 };
    }
    const errors = s.samples.filter((x) => !x.ok).length;
    const errorRate = errors / total;
    const sortedLatencies = s.samples.map((x) => x.latencyMs).sort((a, b) => a - b);
    const latencyP95Ms = percentile(sortedLatencies, 95);
    // Compute penalty score. 1 = fully healthy, 0 = fully degraded.
    const errorPenalty = Math.min(1, errorRate / errorRateThreshold);
    const latencyPenalty = Math.min(1, latencyP95Ms / latencyP95Threshold);
    let weightedPenalty = errorPenalty * (scoreWeights.errorRate ?? 0)
                        + latencyPenalty * (scoreWeights.latencyP95 ?? 0);
    // Optional breaker signal.
    if (breakerFor && (scoreWeights.breakerState ?? 0) > 0) {
      try {
        const b = breakerFor(s._name);
        if (b?.state === 'open') weightedPenalty += (scoreWeights.breakerState ?? 0);
      } catch (err) {
        callHook(onError, { phase: 'breakerFor', error: err });
      }
    }
    const totalWeight = (scoreWeights.errorRate ?? 0) + (scoreWeights.latencyP95 ?? 0) + (scoreWeights.breakerState ?? 0);
    const normalizedPenalty = totalWeight === 0 ? 0 : weightedPenalty / totalWeight;
    const score = Math.max(0, 1 - Math.min(1, normalizedPenalty));
    return { samples: total, errorRate, latencyP95Ms, score };
  }

  function evaluateHealth(name, s) {
    if (s.samples.length < minSampleSize) return;   // not enough data
    const m = computeMetrics(s);
    s.lastScore = m.score;
    const shouldBeHealthy = m.errorRate <= errorRateThreshold && m.latencyP95Ms <= latencyP95Threshold;
    if (s.healthy && !shouldBeHealthy) {
      s.healthy = false;
      s.lastTransitionAt = now();
      stats.degradedTransitions++;
      callHook(onDegraded, {
        provider: name, errorRate: m.errorRate, latencyP95Ms: m.latencyP95Ms,
        score: m.score, samples: m.samples,
      });
    } else if (!s.healthy && shouldBeHealthy) {
      s.healthy = true;
      s.lastTransitionAt = now();
      stats.recoveredTransitions++;
      callHook(onRecovered, {
        provider: name, errorRate: m.errorRate, latencyP95Ms: m.latencyP95Ms,
        score: m.score, samples: m.samples,
      });
    }
  }

  const mw = async (ctx, next) => {
    stats.totalCalls++;
    const startedAt = now();
    let result, threw;
    try {
      result = await next();
    } catch (err) {
      threw = err;
    }
    const latencyMs = now() - startedAt;

    let provider;
    try { provider = providerOf(ctx, result); }
    catch (err) {
      callHook(onError, { phase: 'providerOf', error: err });
      if (threw) throw threw;
      return result;
    }
    if (typeof provider !== 'string' || provider.length === 0) {
      if (threw) throw threw;
      return result;
    }
    stats.lastProvider = provider;

    const s = stateFor(provider);
    s._name = provider;
    s.samples.push({ ts: now(), latencyMs, ok: !threw });
    s.totalCalls++;
    if (threw) { s.totalErrors++; stats.totalErrors++; }
    callHook(onSample, {
      provider, latencyMs, ok: !threw,
      samples: s.samples.length,
    });
    evaluateHealth(provider, s);

    if (threw) throw threw;
    return result;
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.totalCalls = stats.totalErrors = 0;
    stats.degradedTransitions = stats.recoveredTransitions = 0;
    stats.lastProvider = null;
    state.clear();
    stats.providersTracked = 0;
  };
  mw.getHealth = (name) => {
    const s = state.get(name);
    if (!s) return { healthy: true, score: 1, errorRate: 0, latencyP95Ms: 0, samples: 0, totalCalls: 0, totalErrors: 0 };
    const m = computeMetrics(s);
    return {
      healthy:     s.healthy,
      score:       m.score,
      errorRate:   m.errorRate,
      latencyP95Ms: m.latencyP95Ms,
      samples:     m.samples,
      totalCalls:  s.totalCalls,
      totalErrors: s.totalErrors,
      lastTransitionAt: s.lastTransitionAt,
    };
  };
  mw.listProviders = () => Array.from(state.keys());
  mw.snapshotAll = () => {
    const out = {};
    for (const name of state.keys()) out[name] = mw.getHealth(name);
    return out;
  };
  mw.asMcpResource = () => ({
    uri: 'config://provider-health-aggregate',
    name: 'Provider health aggregate',
    description: 'Unified health score per provider from error rate + p95 latency + optional breaker state. onDegraded/onRecovered transitions.',
    mimeType: 'application/json',
    handler: () => ({
      windowMs, errorRateThreshold, latencyP95Threshold, minSampleSize,
      scoreWeights,
      providers: mw.snapshotAll(),
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  providerHealthAggregate,
  percentile,
};
