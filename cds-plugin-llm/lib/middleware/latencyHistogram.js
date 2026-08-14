// Latency histogram. Tracks per-dimension latency distributions using
// Prometheus-style bucketed counts (bucket counts + sum + count — not
// raw samples). Reports p50/p95/p99 percentiles cheaply. Complements
// `providerHealthAggregate` (2.31) which reports a single p95 by
// giving the FULL percentile shape + exportable Prometheus format.
//
//   const { latencyHistogram } = require('@saptarishi/cds-plugin-llm');
//
//   const hist = latencyHistogram({
//     dimensionsOf:    (ctx, result) => ({ model: result?.model ?? 'unknown' }),
//     overThresholdMs: 15_000,             // p95 threshold
//     onOverThreshold: (i) => cds.log('llm:slo').warn('p95 breach', i),
//   });
//   llm.use(hist);
//
//   const p = hist.getPercentiles({ model: 'gpt-4o' });   // → { p50: 1200, p95: 4500, p99: 12000, count: 145 }
//   const prom = hist.prometheusHistograms('llm_latency_ms');   // scrape-ready text
//
// Bucket boundaries follow the Prometheus-canonical latency layout:
//   [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000] ms
// Users with different needs pass a custom `buckets` array.

const DEFAULT_BUCKETS_MS = Object.freeze([5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]);

function latencyHistogram(options = {}) {
  const {
    dimensionsOf            = () => ({}),
    buckets                 = DEFAULT_BUCKETS_MS,
    overThresholdMs         = null,
    overThresholdPercentile = 95,
    onOverThreshold         = null,
    onError                 = null,
    now                     = () => Date.now(),
  } = options;

  if (typeof dimensionsOf !== 'function') {
    throw new Error('latencyHistogram: dimensionsOf must be a function.');
  }
  if (!Array.isArray(buckets) || buckets.length < 1) {
    throw new Error('latencyHistogram: buckets must be a non-empty array of ms values.');
  }
  const sortedBuckets = [...buckets].sort((a, b) => a - b);
  for (let i = 0; i < sortedBuckets.length; i++) {
    if (!Number.isFinite(sortedBuckets[i]) || sortedBuckets[i] <= 0) {
      throw new Error(`latencyHistogram: buckets[${i}] must be > 0 (got ${sortedBuckets[i]}).`);
    }
  }
  if (overThresholdMs != null) {
    if (!Number.isFinite(overThresholdMs) || overThresholdMs <= 0) {
      throw new Error(`latencyHistogram: overThresholdMs must be > 0 (got ${overThresholdMs}).`);
    }
    if (!Number.isInteger(overThresholdPercentile) || overThresholdPercentile <= 0 || overThresholdPercentile >= 100) {
      throw new Error(`latencyHistogram: overThresholdPercentile must be in (0, 100) (got ${overThresholdPercentile}).`);
    }
  }
  for (const cb of [onOverThreshold, onError]) {
    if (cb != null && typeof cb !== 'function') {
      throw new Error('latencyHistogram: callbacks must be functions or null.');
    }
  }

  // Per-dimension-key state.
  //   dimKey → { dimensions, counts: number[len+1], count, sum, breachFired }
  const perKey = new Map();

  const stats = {
    totalCalls:          0,
    dimensionsCount:     0,
    overThresholdFires:  0,
    dimensionErrors:     0,
    lastLatencyMs:       null,
  };

  function callHook(hook, arg) {
    if (!hook) return;
    try { const r = hook(arg); if (r && typeof r.then === 'function') r.catch(() => {}); }
    catch { /* swallow */ }
  }

  function stableKey(dims) {
    if (!dims || typeof dims !== 'object') return '__none__';
    const keys = Object.keys(dims).sort();
    return keys.map((k) => `${k}=${dims[k]}`).join('|') || '__none__';
  }

  function bucketFor(sample) {
    for (let i = 0; i < sortedBuckets.length; i++) {
      if (sample <= sortedBuckets[i]) return i;
    }
    return sortedBuckets.length;   // +Inf bucket
  }

  function recordSample(dims, latencyMs) {
    const key = stableKey(dims);
    let s = perKey.get(key);
    if (!s) {
      s = {
        dimensions:   dims ?? {},
        counts:       new Array(sortedBuckets.length + 1).fill(0),
        count:        0,
        sum:          0,
        breachFired:  false,
      };
      perKey.set(key, s);
      stats.dimensionsCount = perKey.size;
    }
    const b = bucketFor(latencyMs);
    s.counts[b]++;
    s.count++;
    s.sum += latencyMs;

    // Over-threshold p-N check (rising edge).
    if (overThresholdMs != null && onOverThreshold) {
      const p = percentileFromCounts(s.counts, s.count, overThresholdPercentile);
      if (p > overThresholdMs && !s.breachFired) {
        s.breachFired = true;
        stats.overThresholdFires++;
        callHook(onOverThreshold, {
          dimensions: s.dimensions,
          percentile: overThresholdPercentile,
          value:      p,
          threshold:  overThresholdMs,
          count:      s.count,
        });
      } else if (p <= overThresholdMs && s.breachFired) {
        s.breachFired = false;   // rearm rising edge on recovery
      }
    }
  }

  // Estimate percentile from bucket counts. Returns the UPPER bound
  // of the bucket that contains the target rank (linear-interpolated
  // within the bucket would be smoother but adds complexity).
  function percentileFromCounts(counts, total, p) {
    if (total === 0) return 0;
    const targetRank = Math.ceil((p / 100) * total);
    let cum = 0;
    for (let i = 0; i < counts.length; i++) {
      cum += counts[i];
      if (cum >= targetRank) {
        // Return bucket upper bound; +Inf bucket returns the last real
        // bucket upper bound * 2 as a rough approximation.
        if (i < sortedBuckets.length) return sortedBuckets[i];
        return sortedBuckets[sortedBuckets.length - 1] * 2;
      }
    }
    return sortedBuckets[sortedBuckets.length - 1] * 2;
  }

  const mw = async (ctx, next) => {
    stats.totalCalls++;
    const startedAt = now();
    let result, threw;
    try { result = await next(); }
    catch (err) { threw = err; }
    const latencyMs = now() - startedAt;
    stats.lastLatencyMs = latencyMs;

    let dims;
    try { dims = dimensionsOf(ctx, result); }
    catch (err) {
      stats.dimensionErrors++;
      callHook(onError, { phase: 'dimensionsOf', error: err });
      dims = {};
    }

    recordSample(dims, latencyMs);

    if (threw) throw threw;
    return result;
  };

  function matchesFilter(dims, filter) {
    if (!filter) return true;
    for (const [k, v] of Object.entries(filter)) {
      if (dims?.[k] !== v) return false;
    }
    return true;
  }

  mw.stats = stats;
  mw.reset = () => {
    stats.totalCalls = stats.dimensionsCount = 0;
    stats.overThresholdFires = stats.dimensionErrors = 0;
    stats.lastLatencyMs = null;
    perKey.clear();
  };
  mw.getPercentiles = (filter = null, percentiles = [50, 95, 99]) => {
    // Aggregate matching keys' buckets first, then compute percentiles.
    const merged = new Array(sortedBuckets.length + 1).fill(0);
    let total = 0;
    let sum = 0;
    for (const s of perKey.values()) {
      if (!matchesFilter(s.dimensions, filter)) continue;
      for (let i = 0; i < merged.length; i++) merged[i] += s.counts[i];
      total += s.count;
      sum += s.sum;
    }
    const out = { count: total, sum, mean: total === 0 ? 0 : sum / total };
    for (const p of percentiles) {
      out[`p${p}`] = percentileFromCounts(merged, total, p);
    }
    return out;
  };
  mw.snapshot = () => {
    const out = {};
    for (const s of perKey.values()) {
      const key = stableKey(s.dimensions);
      out[key] = {
        dimensions: s.dimensions,
        count:      s.count,
        sum:        s.sum,
        mean:       s.count === 0 ? 0 : s.sum / s.count,
        p50:        percentileFromCounts(s.counts, s.count, 50),
        p95:        percentileFromCounts(s.counts, s.count, 95),
        p99:        percentileFromCounts(s.counts, s.count, 99),
      };
    }
    return out;
  };
  mw.prometheusHistograms = (metricName = 'llm_latency_ms') => {
    // Prometheus text exposition format.
    const lines = [];
    lines.push(`# TYPE ${metricName} histogram`);
    for (const s of perKey.values()) {
      const labels = Object.entries(s.dimensions)
        .map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`)
        .join(',');
      const labelPrefix = labels ? `{${labels},` : `{`;
      let cum = 0;
      for (let i = 0; i < sortedBuckets.length; i++) {
        cum += s.counts[i];
        lines.push(`${metricName}_bucket${labelPrefix}le="${sortedBuckets[i]}"} ${cum}`);
      }
      cum += s.counts[sortedBuckets.length];
      lines.push(`${metricName}_bucket${labelPrefix}le="+Inf"} ${cum}`);
      lines.push(`${metricName}_sum${labels ? `{${labels}}` : ''} ${s.sum}`);
      lines.push(`${metricName}_count${labels ? `{${labels}}` : ''} ${s.count}`);
    }
    return lines.join('\n');
  };
  mw.asMcpResource = () => ({
    uri: 'config://latency-histogram',
    name: 'Latency histogram',
    description: 'Per-dimension latency histograms with percentiles. Prometheus-exportable.',
    mimeType: 'application/json',
    handler: () => ({
      buckets:               sortedBuckets,
      overThresholdMs,
      overThresholdPercentile,
      dimensions:            mw.snapshot(),
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  latencyHistogram,
  DEFAULT_BUCKETS_MS,
};
