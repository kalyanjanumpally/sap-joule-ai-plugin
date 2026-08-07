// Bulkhead / concurrency-limit middleware. Caps in-flight calls per
// bucket (default: per provider), queues excess up to `maxQueued`, times
// out waiting calls after `queueTimeoutMs`. Prevents one runaway tenant
// / agent loop from starving others.
//
// Completes the resilience quartet:
//   retry (transient)  →  breaker (sustained)  →
//   fallback (multi-provider)  →  bulkhead (isolation)
//
// Ordering:
//   costBudget  →  circuitBreaker  →  bulkhead  →  retryOnRateLimit  →  provider
//
//   - Bulkhead INNER of circuitBreaker: an open circuit doesn't hold a
//     slot in the bucket — reject-fast is preserved.
//   - Bulkhead INNER of costBudget: budget check completes without
//     waiting for a slot (better error prioritization for the caller).
//   - Bulkhead OUTER of retryOnRateLimit: retries HOLD their slot across
//     wait+retry. Prevents thundering-herd on the provider when a
//     backend just came back online.
//
//   const bh = bulkhead({
//     maxConcurrent:  10,
//     maxQueued:      50,
//     queueTimeoutMs: 5000,
//     perProvider:    true,
//     onQueue:   (info) => cds.log('llm:bulkhead').debug('queued',   info),
//     onReject:  (info) => cds.log('llm:bulkhead').warn ('rejected', info),
//     onExecute: (info) => cds.log('llm:bulkhead').trace('running',  info),
//   });
//   llm.use(bh);

const { LLMError } = require('../errors');

class BulkheadFullError extends LLMError {
  constructor(provider, maxQueued) {
    super(`bulkhead: queue is full for provider='${provider}' (maxQueued=${maxQueued}).`, 'BULKHEAD_FULL');
    this.provider = provider;
    this.maxQueued = maxQueued;
  }
}

class BulkheadTimeoutError extends LLMError {
  constructor(provider, queueTimeoutMs) {
    super(`bulkhead: request timed out in queue for provider='${provider}' after ${queueTimeoutMs}ms.`, 'BULKHEAD_TIMEOUT');
    this.provider = provider;
    this.queueTimeoutMs = queueTimeoutMs;
  }
}

function bulkhead(options = {}) {
  const {
    maxConcurrent: initialMaxConcurrent = 10,
    maxQueued      = 0,
    queueTimeoutMs = 0,
    perProvider    = true,
    onQueue        = null,
    onReject       = null,
    onExecute      = null,
  } = options;

  if (!Number.isInteger(initialMaxConcurrent) || initialMaxConcurrent < 1) {
    throw new Error(`bulkhead: maxConcurrent must be a positive integer (got ${initialMaxConcurrent}).`);
  }
  if (!Number.isInteger(maxQueued) || maxQueued < 0) {
    throw new Error(`bulkhead: maxQueued must be a non-negative integer (got ${maxQueued}).`);
  }
  if (!Number.isFinite(queueTimeoutMs) || queueTimeoutMs < 0) {
    throw new Error(`bulkhead: queueTimeoutMs must be a non-negative number (got ${queueTimeoutMs}).`);
  }

  // Mutable so adaptiveBulkhead (1.61+) can tune it at runtime via
  // setMaxConcurrent(). Reads inside the fast path see the LATEST value.
  let maxConcurrent = initialMaxConcurrent;

  // Observer subscribers — invoked after each call completes (success or
  // failure). Used by adaptiveBulkhead to measure latency samples.
  const subscribers = new Set();
  function emit(info) {
    for (const fn of subscribers) {
      try { fn(info); } catch { /* swallow */ }
    }
  }

  const buckets = new Map();

  function bucketFor(ctx) {
    const key = perProvider ? (ctx?.service?.name || ctx?.provider || 'default') : 'default';
    let b = buckets.get(key);
    if (!b) {
      b = { inFlight: 0, queue: [] };
      buckets.set(key, b);
    }
    return { key, bucket: b };
  }

  const stats = {
    requests:        0,
    admitted:        0,
    queued:          0,
    rejected:        0,
    timedOut:        0,
  };

  // Drain the queue: called after each in-flight call finishes.
  function drain(bucket) {
    while (bucket.inFlight < maxConcurrent && bucket.queue.length > 0) {
      const waiter = bucket.queue.shift();
      if (waiter.timeoutId) clearTimeout(waiter.timeoutId);
      bucket.inFlight++;
      waiter.resolve();
    }
  }

  const mw = async (ctx, next) => {
    stats.requests++;
    const { key, bucket } = bucketFor(ctx);

    // Fast path — capacity available now.
    if (bucket.inFlight < maxConcurrent) {
      bucket.inFlight++;
      stats.admitted++;
      if (onExecute) {
        try { onExecute({ provider: key, inFlight: bucket.inFlight, queued: bucket.queue.length, method: ctx?.method }); }
        catch { /* swallow */ }
      }
      const startedAt = Date.now();
      let ok = true;
      try {
        return await next();
      } catch (e) {
        ok = false;
        throw e;
      } finally {
        emit({ provider: key, durationMs: Date.now() - startedAt, ok, method: ctx?.method });
        bucket.inFlight--;
        drain(bucket);
      }
    }

    // Slow path — queue the request if there's queue capacity.
    if (bucket.queue.length >= maxQueued) {
      stats.rejected++;
      if (onReject) {
        try { onReject({ provider: key, reason: 'queue-full', inFlight: bucket.inFlight, queued: bucket.queue.length, method: ctx?.method }); }
        catch { /* swallow */ }
      }
      throw new BulkheadFullError(key, maxQueued);
    }

    // Wait for a slot. Resolved by drain() when a slot opens, or
    // rejected with BulkheadTimeoutError if queueTimeoutMs elapses.
    stats.queued++;
    const enqueuedAt = Date.now();
    if (onQueue) {
      try { onQueue({ provider: key, inFlight: bucket.inFlight, queued: bucket.queue.length + 1, method: ctx?.method }); }
      catch { /* swallow */ }
    }

    await new Promise((resolve, reject) => {
      const waiter = { resolve, reject, enqueuedAt };
      if (queueTimeoutMs > 0) {
        waiter.timeoutId = setTimeout(() => {
          const idx = bucket.queue.indexOf(waiter);
          if (idx !== -1) bucket.queue.splice(idx, 1);
          stats.timedOut++;
          if (onReject) {
            try { onReject({ provider: key, reason: 'queue-timeout', inFlight: bucket.inFlight, queued: bucket.queue.length, method: ctx?.method }); }
            catch { /* swallow */ }
          }
          reject(new BulkheadTimeoutError(key, queueTimeoutMs));
        }, queueTimeoutMs);
      }
      bucket.queue.push(waiter);
    });

    stats.admitted++;
    if (onExecute) {
      try { onExecute({ provider: key, inFlight: bucket.inFlight, queued: bucket.queue.length, method: ctx?.method, waitedMs: Date.now() - enqueuedAt }); }
      catch { /* swallow */ }
    }
    const startedExecAt = Date.now();
    let ok = true;
    try {
      return await next();
    } catch (e) {
      ok = false;
      throw e;
    } finally {
      emit({ provider: key, durationMs: Date.now() - startedExecAt, ok, method: ctx?.method });
      bucket.inFlight--;
      drain(bucket);
    }
  };

  mw.stats = stats;
  /**
   * Runtime concurrency adjustment — used by adaptiveBulkhead (1.61+) to
   * tune the ceiling based on observed latency. In-flight calls above the
   * new limit are NOT interrupted; they finish naturally and new admits
   * respect the new limit.
   */
  mw.setMaxConcurrent = (n) => {
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`bulkhead.setMaxConcurrent: n must be a positive integer (got ${n}).`);
    }
    maxConcurrent = n;
    // Drain any buckets that now have headroom (increasing the limit).
    for (const b of buckets.values()) drain(b);
  };
  mw.getMaxConcurrent = () => maxConcurrent;
  /**
   * Observe every completed call. `fn` receives `{ provider, durationMs, ok,
   * method }` — including the queue wait for calls that queued before
   * executing. Returns an unsubscribe function.
   */
  mw.subscribe = (fn) => {
    if (typeof fn !== 'function') {
      throw new Error('bulkhead.subscribe: fn must be a function.');
    }
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  };
  mw.state = (provider) => {
    const key = perProvider ? (provider ?? 'default') : 'default';
    const b = buckets.get(key);
    if (!b) return { inFlight: 0, queued: 0 };
    return { inFlight: b.inFlight, queued: b.queue.length };
  };
  mw.reset = (provider) => {
    // Reject any waiters so they don't hang forever.
    const rejectAll = (b) => {
      while (b.queue.length > 0) {
        const w = b.queue.shift();
        if (w.timeoutId) clearTimeout(w.timeoutId);
        w.reject(new BulkheadFullError('reset', 0));
      }
      b.inFlight = 0;
    };
    if (provider) {
      const b = buckets.get(perProvider ? provider : 'default');
      if (b) rejectAll(b);
      buckets.delete(perProvider ? provider : 'default');
    } else {
      for (const b of buckets.values()) rejectAll(b);
      buckets.clear();
      stats.requests = stats.admitted = stats.queued = stats.rejected = stats.timedOut = 0;
    }
  };
  mw.asMcpResource = () => ({
    uri: 'config://bulkhead',
    name: 'Bulkhead middleware',
    description: 'Per-provider concurrency slots + queue depth counters.',
    mimeType: 'application/json',
    handler: () => {
      const bucketsSnap = {};
      for (const [k, b] of buckets.entries()) {
        bucketsSnap[k] = { inFlight: b.inFlight, queued: b.queue.length };
      }
      return {
        maxConcurrent, maxQueued, queueTimeoutMs, perProvider,
        buckets: bucketsSnap,
        ...stats,
      };
    },
  });
  return mw;
}

module.exports = { bulkhead, BulkheadFullError, BulkheadTimeoutError };
