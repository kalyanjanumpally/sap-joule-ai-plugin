// Batch aggregator. Coalesces N concurrent individual LLM calls into a
// single upstream call using caller-supplied aggregation + splitting
// logic. Wait up to `batchWindowMs` for a batch to fill (or hit
// `maxBatchSize`), fire once, split the response back to individual
// callers.
//
// Useful for high-throughput fan-out patterns with uniform structure —
// classification, embedding, translation — where the batch pattern
// works: N similar prompts can be concatenated into 1 with clear
// delimiters, and the model returns an ordered array we can split.
//
// Distinct from the shipped primitives:
//   * `requestCoalescer` (2.8)  — deduplicates IDENTICAL requests
//   * `runBatch` / `waitForBatch` (1.79) — offline batch-API workflows
//   * `batchAggregator` (this)   — ONLINE pooling of DIFFERENT requests
//                                  across a short window
//
//   const { batchAggregator } = require('@saptarishi/cds-plugin-llm');
//
//   llm.use(batchAggregator({
//     batchWindowMs:   50,
//     maxBatchSize:    10,
//     batchable:       (ctx) => ctx.request.batchKey === 'classify-support-ticket',
//     aggregateRequests: (batch) => ({
//       messages: [{ role: 'user', content:
//         'Classify each of these support tickets (respond with a JSON array of labels):\n' +
//         batch.map((b, i) => `${i+1}. ${b.ctx.request.messages[0].content}`).join('\n')
//       }],
//       format: { type: 'array', items: { enum: ['billing', 'bug', 'question'] } },
//     }),
//     splitResponse:   (result, batch) => {
//       const labels = result.data;
//       return batch.map((b, i) => ({ ...result, data: labels[i], text: labels[i] }));
//     },
//     onBatch: (i) => cds.log('llm:batch').info('flushed', i),
//   }));
//
// Placement: OUTSIDE cache / coalescer — batching only happens on
// cache misses. INSIDE bulkhead — one batch = one slot.

const { LLMError } = require('../errors');

class BatchAggregationError extends LLMError {
  constructor({ batchSize, cause }) {
    super(
      `batchAggregator: batch of ${batchSize} failed — ${cause?.message ?? cause}.`,
      'BATCH_AGGREGATION_FAILED',
    );
    this.batchSize = batchSize;
    this.cause = cause;
  }
}

function batchAggregator(options = {}) {
  const {
    batchWindowMs        = 50,
    maxBatchSize         = 20,
    batchable,
    aggregateRequests,
    splitResponse,
    batchKeyOf,                       // (ctx) => string; separate windows per key
    onBatch              = null,
    onFlush              = null,
    onError              = null,
    now                  = () => Date.now(),
    setTimer             = (fn, ms) => setTimeout(fn, ms),
    clearTimer           = (h) => clearTimeout(h),
  } = options;

  if (!Number.isInteger(batchWindowMs) || batchWindowMs < 0) {
    throw new Error(`batchAggregator: batchWindowMs must be an integer >= 0 (got ${batchWindowMs}).`);
  }
  if (!Number.isInteger(maxBatchSize) || maxBatchSize < 2) {
    throw new Error(`batchAggregator: maxBatchSize must be an integer >= 2 (got ${maxBatchSize}).`);
  }
  if (batchable != null && typeof batchable !== 'function') {
    throw new Error('batchAggregator: batchable must be a function or null.');
  }
  if (typeof aggregateRequests !== 'function') {
    throw new Error('batchAggregator: aggregateRequests(batch) is required.');
  }
  if (typeof splitResponse !== 'function') {
    throw new Error('batchAggregator: splitResponse(result, batch) is required.');
  }
  if (batchKeyOf != null && typeof batchKeyOf !== 'function') {
    throw new Error('batchAggregator: batchKeyOf must be a function or null.');
  }
  for (const cb of [onBatch, onFlush, onError]) {
    if (cb != null && typeof cb !== 'function') {
      throw new Error('batchAggregator: callbacks must be functions or null.');
    }
  }

  // Per-key pending batches. Each entry:
  //   { members: [{ ctx, resolve, reject, enqueuedAt }], timer: TimerHandle | null }
  const pending = new Map();

  const stats = {
    totalCalls:       0,
    batched:          0,       // callers whose call was folded into a batch
    unbatched:        0,       // callers who bypassed
    batchesFlushed:   0,
    fullBatches:      0,       // flushed because they hit maxBatchSize
    windowFlushes:    0,       // flushed because the window timer fired
    failedBatches:    0,
    totalMembersFlushed: 0,    // for avgBatchSize
    lastBatchSize:    null,
  };

  function callHook(hook, arg) {
    if (!hook) return;
    try { const r = hook(arg); if (r && typeof r.then === 'function') r.catch(() => {}); }
    catch { /* swallow */ }
  }

  function keyFor(ctx) {
    if (batchKeyOf) {
      try { const k = batchKeyOf(ctx); return typeof k === 'string' && k.length > 0 ? k : '__default__'; }
      catch { return '__default__'; }
    }
    return '__default__';
  }

  async function flushBatch(key, reason) {
    const entry = pending.get(key);
    if (!entry || entry.members.length === 0) return;
    pending.delete(key);
    if (entry.timer) clearTimer(entry.timer);

    const batch = entry.members;
    stats.batchesFlushed++;
    if (reason === 'window') stats.windowFlushes++;
    else if (reason === 'full') stats.fullBatches++;
    stats.totalMembersFlushed += batch.length;
    stats.lastBatchSize = batch.length;
    callHook(onFlush, { key, size: batch.length, reason });

    // Build aggregated request. Use the first member's ctx as the
    // canonical downstream ctx; overwrite its request with the aggregate.
    const canonicalCtx = batch[0].ctx;
    const originalRequest = canonicalCtx.request;
    let aggregatedRequest;
    try {
      aggregatedRequest = aggregateRequests(batch);
    } catch (err) {
      // Aggregation itself broke — fail all members.
      stats.failedBatches++;
      callHook(onError, { phase: 'aggregateRequests', error: err, batchSize: batch.length });
      const wrapped = new BatchAggregationError({ batchSize: batch.length, cause: err });
      for (const m of batch) m.reject(wrapped);
      return;
    }
    canonicalCtx.request = aggregatedRequest;

    let aggregatedResult;
    try {
      aggregatedResult = await batch[0].next();
    } catch (err) {
      stats.failedBatches++;
      canonicalCtx.request = originalRequest;
      callHook(onError, { phase: 'next', error: err, batchSize: batch.length });
      const wrapped = new BatchAggregationError({ batchSize: batch.length, cause: err });
      for (const m of batch) m.reject(wrapped);
      return;
    }
    canonicalCtx.request = originalRequest;

    // Split the aggregated result back to individual callers.
    let individualResults;
    try {
      individualResults = splitResponse(aggregatedResult, batch);
      if (!Array.isArray(individualResults) || individualResults.length !== batch.length) {
        throw new Error(`splitResponse returned ${Array.isArray(individualResults) ? individualResults.length : typeof individualResults} results, expected ${batch.length}`);
      }
    } catch (err) {
      stats.failedBatches++;
      callHook(onError, { phase: 'splitResponse', error: err, batchSize: batch.length });
      const wrapped = new BatchAggregationError({ batchSize: batch.length, cause: err });
      for (const m of batch) m.reject(wrapped);
      return;
    }

    callHook(onBatch, {
      key, size: batch.length, reason,
      totalLatencyMs: now() - batch[0].enqueuedAt,
    });

    for (let i = 0; i < batch.length; i++) {
      batch[i].resolve(individualResults[i]);
    }
  }

  const mw = async (ctx, next) => {
    stats.totalCalls++;

    if (batchable && !batchable(ctx)) {
      stats.unbatched++;
      return next();
    }

    const key = keyFor(ctx);
    let entry = pending.get(key);
    if (!entry) {
      entry = { members: [], timer: null };
      pending.set(key, entry);
    }

    return new Promise((resolve, reject) => {
      entry.members.push({ ctx, next, resolve, reject, enqueuedAt: now() });
      stats.batched++;

      if (entry.members.length >= maxBatchSize) {
        // Flush immediately.
        flushBatch(key, 'full');
      } else if (entry.timer == null) {
        // Start the window timer. Do NOT unref — the timer must be
        // able to fire to deliver results to the queued callers; the
        // event loop should stay open until then.
        entry.timer = setTimer(() => { flushBatch(key, 'window'); }, batchWindowMs);
      }
    });
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.totalCalls = stats.batched = stats.unbatched = 0;
    stats.batchesFlushed = stats.fullBatches = stats.windowFlushes = 0;
    stats.failedBatches = stats.totalMembersFlushed = 0;
    stats.lastBatchSize = null;
  };
  mw.avgBatchSize = () => {
    return stats.batchesFlushed === 0 ? 0 : stats.totalMembersFlushed / stats.batchesFlushed;
  };
  mw.pendingCount = () => {
    let n = 0;
    for (const e of pending.values()) n += e.members.length;
    return n;
  };
  mw.pendingKeys = () => Array.from(pending.keys());
  mw.asMcpResource = () => ({
    uri: 'config://batch-aggregator',
    name: 'Batch aggregator',
    description: 'Windowed pooling of concurrent LLM calls. Aggregates N similar requests into 1 upstream call and splits results back.',
    mimeType: 'application/json',
    handler: () => ({
      batchWindowMs,
      maxBatchSize,
      avgBatchSize: mw.avgBatchSize(),
      pendingCount: mw.pendingCount(),
      pendingKeys:  mw.pendingKeys(),
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  batchAggregator,
  BatchAggregationError,
};
