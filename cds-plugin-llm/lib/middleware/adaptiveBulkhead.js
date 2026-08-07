// Adaptive concurrency tuner for the 1.51 bulkhead. Observes each call's
// latency; on periodic tick, computes p95 over a sample window. If p95 is
// above target → shrink maxConcurrent (backpressure); if p95 is below
// target → grow maxConcurrent (headroom). Completes the auto-tuning
// story for the resilience quartet.
//
// Usage:
//
//   const bh    = bulkhead({ maxConcurrent: 10, maxQueued: 50, queueTimeoutMs: 5_000 });
//   const tuner = adaptiveBulkhead({
//     bulkhead:      bh,
//     p95TargetMs:   2000,
//     minConcurrent: 2,
//     maxConcurrent: 50,
//     adjustEveryMs: 10_000,
//     stepUp:        1,
//     stepDown:      2,
//     sampleWindow:  100,
//     onAdjust: (info) => cds.log('llm:tuner').info(info),
//   });
//   llm.use(bh);
//   tuner.start();          // begin ticking
//
// When shutting down:
//   tuner.stop();           // stop the interval + unsubscribe
//
// Semantics:
//   - stepUp is smaller than stepDown by design — grow slowly (probe
//     for headroom), shrink aggressively (backpressure fast when latency
//     spikes). Classic AIMD (additive-increase, multiplicative-decrease)
//     philosophy applied to concurrency.
//   - Samples that occurred DURING queue wait are included in the p95 —
//     the tuner wants to know total user-observed latency, not just
//     provider RTT.
//   - Sample window is a rolling buffer of the last N durations across
//     ALL provider buckets. Ideal for demos + typical workloads; for
//     per-provider tuning, instantiate multiple tuners each pointed at
//     the same bulkhead with a `filterProvider` predicate.

function adaptiveBulkhead(options = {}) {
  const {
    bulkhead,
    p95TargetMs,
    minConcurrent  = 1,
    maxConcurrent  = 100,
    adjustEveryMs  = 10_000,
    stepUp         = 1,
    stepDown       = 2,
    sampleWindow   = 100,
    filterProvider = null,        // (provider) => bool; null = all
    onAdjust       = null,
    onSample       = null,
  } = options;

  if (!bulkhead || typeof bulkhead.setMaxConcurrent !== 'function' || typeof bulkhead.subscribe !== 'function') {
    throw new Error('adaptiveBulkhead: bulkhead must be a bulkhead middleware (v1.61+ with .setMaxConcurrent + .subscribe).');
  }
  if (!Number.isFinite(p95TargetMs) || p95TargetMs <= 0) {
    throw new Error(`adaptiveBulkhead: p95TargetMs must be a positive number (got ${p95TargetMs}).`);
  }
  if (!Number.isInteger(minConcurrent) || minConcurrent < 1) {
    throw new Error(`adaptiveBulkhead: minConcurrent must be a positive integer (got ${minConcurrent}).`);
  }
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < minConcurrent) {
    throw new Error(`adaptiveBulkhead: maxConcurrent must be an integer >= minConcurrent (got ${maxConcurrent}).`);
  }
  if (!Number.isFinite(adjustEveryMs) || adjustEveryMs < 100) {
    throw new Error(`adaptiveBulkhead: adjustEveryMs must be >= 100ms (got ${adjustEveryMs}).`);
  }
  if (!Number.isInteger(stepUp)   || stepUp   < 1) throw new Error(`adaptiveBulkhead: stepUp must be a positive integer (got ${stepUp}).`);
  if (!Number.isInteger(stepDown) || stepDown < 1) throw new Error(`adaptiveBulkhead: stepDown must be a positive integer (got ${stepDown}).`);
  if (!Number.isInteger(sampleWindow) || sampleWindow < 5) {
    throw new Error(`adaptiveBulkhead: sampleWindow must be a positive integer >= 5 (got ${sampleWindow}).`);
  }

  // Rolling latency buffer (circular). Cheap and allocation-free.
  const samples = new Array(sampleWindow);
  let sampleIdx = 0;
  let sampleCount = 0;

  const stats = {
    ticks:         0,   // number of adjustment ticks fired
    adjustments:   0,   // ticks that actually changed maxConcurrent
    grows:         0,
    shrinks:       0,
    lastP95Ms:     null,
    lastAction:    'none',   // 'grow' | 'shrink' | 'noop'
    lastMaxConcurrent: bulkhead.getMaxConcurrent(),
  };

  let unsubscribe = null;
  let timer = null;

  function observer(info) {
    if (filterProvider && !filterProvider(info.provider)) return;
    samples[sampleIdx % sampleWindow] = info.durationMs;
    sampleIdx++;
    sampleCount = Math.min(sampleCount + 1, sampleWindow);
    if (onSample) {
      try { onSample(info); } catch { /* swallow */ }
    }
  }

  function computeP95() {
    if (sampleCount === 0) return null;
    const buf = samples.slice(0, sampleCount).sort((a, b) => a - b);
    const idx = Math.min(buf.length - 1, Math.floor(buf.length * 0.95));
    return buf[idx];
  }

  function tick() {
    stats.ticks++;
    const p95 = computeP95();
    stats.lastP95Ms = p95;
    if (p95 == null) {
      stats.lastAction = 'noop-no-samples';
      return;
    }
    const current = bulkhead.getMaxConcurrent();
    let action = 'noop';
    let next = current;
    if (p95 > p95TargetMs && current > minConcurrent) {
      // Latency too high → shrink concurrency to reduce load on provider
      next = Math.max(minConcurrent, current - stepDown);
      action = 'shrink';
    } else if (p95 < p95TargetMs && current < maxConcurrent) {
      // Latency headroom → grow concurrency to increase throughput
      next = Math.min(maxConcurrent, current + stepUp);
      action = 'grow';
    }
    if (next !== current) {
      bulkhead.setMaxConcurrent(next);
      stats.adjustments++;
      if (action === 'grow')   stats.grows++;
      if (action === 'shrink') stats.shrinks++;
      stats.lastMaxConcurrent = next;
    }
    stats.lastAction = action;
    if (onAdjust) {
      try {
        onAdjust({
          action,
          p95Ms:            p95,
          targetMs:         p95TargetMs,
          prevMaxConcurrent: current,
          newMaxConcurrent:  next,
          sampleCount:       sampleCount,
        });
      } catch { /* swallow */ }
    }
  }

  return {
    start() {
      if (timer) return;   // idempotent
      unsubscribe = bulkhead.subscribe(observer);
      timer = setInterval(tick, adjustEveryMs);
      if (typeof timer.unref === 'function') timer.unref();   // don't hold event loop open
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    },
    /** Fire the tick logic immediately — useful for tests + manual adjustment. */
    tickNow() { tick(); },
    stats,
    asMcpResource() {
      return {
        uri: 'config://adaptive-bulkhead',
        name: 'Adaptive bulkhead tuner',
        description: 'Rolling p95 latency + AIMD tuner state for the bulkhead maxConcurrent.',
        mimeType: 'application/json',
        handler: () => ({
          p95TargetMs, minConcurrent, maxConcurrent,
          adjustEveryMs, stepUp, stepDown, sampleWindow,
          currentMaxConcurrent: bulkhead.getMaxConcurrent(),
          sampleCount,
          running: timer != null,
          ...stats,
        }),
      };
    },
  };
}

module.exports = { adaptiveBulkhead };
