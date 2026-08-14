// Client-side rate limiter. Proactive N-per-window throttler that
// BLOCKS/QUEUES calls to stay under a configured rate — rather than
// letting the provider 429 you and relying on `retryOnRateLimit` +
// `adaptiveRateLimit` to recover after the fact.
//
// Distinct from the shipped rate-limit primitives:
//   * `retryOnRateLimit` (1.x)    — REACTS to 429 by waiting + retrying
//   * `adaptiveRateLimit` (2.6)   — REACTS to headers by shrinking bulkhead
//   * `clientSideRateLimit` (this) — PROACTIVELY shapes traffic to never
//                                    hit the provider's cap
//
// Two strategies:
//   * `'token-bucket'` — classic Nginx-style: refill at `rate` per
//     second up to `burst` capacity; consume 1 token per call. Best for
//     bursty traffic where you can absorb short spikes.
//   * `'sliding-window'` — strict N-per-windowMs count. Best when you
//     have a documented provider quota like "100 requests per minute"
//     and want exact enforcement.
//
//   const { clientSideRateLimit } = require('@saptarishi/cds-plugin-llm');
//
//   llm.use(clientSideRateLimit({
//     strategy: 'token-bucket',
//     rate:  10,          // requests per second
//     burst: 20,          // bucket size
//     queueTimeoutMs: 30_000,
//     onQueue:   (i) => cds.log('llm:rate').debug('queued', i),
//     onTimeout: (i) => cds.log('llm:rate').warn('timeout', i),
//   }));

const { LLMError } = require('../errors');

class RateLimitTimeoutError extends LLMError {
  constructor({ key, waitedMs, queueTimeoutMs }) {
    super(
      `clientSideRateLimit: waited ${waitedMs}ms in queue for key "${key}", exceeded queueTimeoutMs=${queueTimeoutMs}.`,
      'RATE_LIMIT_QUEUE_TIMEOUT',
    );
    this.rateLimitKey   = key;
    this.waitedMs       = waitedMs;
    this.queueTimeoutMs = queueTimeoutMs;
  }
}

const STRATEGIES = Object.freeze(['token-bucket', 'sliding-window']);

function clientSideRateLimit(options = {}) {
  const {
    strategy         = 'token-bucket',
    // token-bucket
    rate             = 10,
    burst            = null,           // defaults to rate
    // sliding-window
    limit            = 100,
    windowMs         = 60_000,
    // common
    keyOf            = () => 'global',
    queueTimeoutMs   = 30_000,
    onQueue          = null,
    onAdmit          = null,
    onTimeout        = null,
    onError          = null,
    now              = () => Date.now(),
    // Note: do NOT unref() the internal drain sleep — the drain loop
    // must be able to tick after the caller's promise resolves. Test
    // runners (and short-lived processes) will exit early otherwise.
    sleep            = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = options;

  if (!STRATEGIES.includes(strategy)) {
    throw new Error(`clientSideRateLimit: strategy must be one of ${STRATEGIES.join(', ')} (got ${JSON.stringify(strategy)}).`);
  }
  if (strategy === 'token-bucket') {
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(`clientSideRateLimit: rate must be > 0 (got ${rate}).`);
    }
    if (burst != null && (!Number.isFinite(burst) || burst < 1)) {
      throw new Error(`clientSideRateLimit: burst must be >= 1 (got ${burst}).`);
    }
  } else {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`clientSideRateLimit: limit must be a positive integer (got ${limit}).`);
    }
    if (!Number.isInteger(windowMs) || windowMs < 100) {
      throw new Error(`clientSideRateLimit: windowMs must be an integer >= 100 (got ${windowMs}).`);
    }
  }
  if (typeof keyOf !== 'function') {
    throw new Error('clientSideRateLimit: keyOf must be a function.');
  }
  if (!Number.isInteger(queueTimeoutMs) || queueTimeoutMs < 0) {
    throw new Error(`clientSideRateLimit: queueTimeoutMs must be >= 0 (got ${queueTimeoutMs}).`);
  }
  for (const cb of [onQueue, onAdmit, onTimeout, onError]) {
    if (cb != null && typeof cb !== 'function') {
      throw new Error('clientSideRateLimit: callbacks must be functions or null.');
    }
  }

  const effectiveBurst = burst ?? Math.max(1, Math.ceil(rate));

  // Per-key state (lazy-created).
  //   token-bucket:  { tokens: number, lastRefillMs: number, queue: [{ resolve, enqueuedAt }] }
  //   sliding-window: { timestamps: number[], queue: [{ resolve, enqueuedAt }] }
  const state = new Map();

  const stats = {
    totalCalls:           0,
    admittedImmediately:  0,
    queuedThenAdmitted:   0,
    timedOut:             0,
    keyErrors:            0,
    totalWaitMs:          0,     // for avgWaitMs
    peakQueueDepth:       0,
    lastKey:              null,
  };

  function callHook(hook, arg) {
    if (!hook) return;
    try { const r = hook(arg); if (r && typeof r.then === 'function') r.catch(() => {}); }
    catch { /* swallow */ }
  }

  function stateFor(key) {
    let s = state.get(key);
    if (!s) {
      s = strategy === 'token-bucket'
        ? { tokens: effectiveBurst, lastRefillMs: now(), queue: [] }
        : { timestamps: [], queue: [] };
      state.set(key, s);
    }
    return s;
  }

  // --- Token-bucket helpers -----------------------------------

  function refill(s) {
    const t = now();
    const elapsed = t - s.lastRefillMs;
    if (elapsed <= 0) return;
    const add = (elapsed / 1000) * rate;
    s.tokens = Math.min(effectiveBurst, s.tokens + add);
    s.lastRefillMs = t;
  }

  function tokenBucketTryAdmit(s) {
    refill(s);
    if (s.tokens >= 1) {
      s.tokens -= 1;
      return true;
    }
    return false;
  }

  function tokenBucketMsUntilAvailable(s) {
    refill(s);
    if (s.tokens >= 1) return 0;
    const missing = 1 - s.tokens;
    return Math.ceil((missing / rate) * 1000);
  }

  // --- Sliding-window helpers ---------------------------------

  function pruneOldStamps(s) {
    const cutoff = now() - windowMs;
    while (s.timestamps.length > 0 && s.timestamps[0] <= cutoff) s.timestamps.shift();
  }

  function slidingWindowTryAdmit(s) {
    pruneOldStamps(s);
    if (s.timestamps.length < limit) {
      s.timestamps.push(now());
      return true;
    }
    return false;
  }

  function slidingWindowMsUntilAvailable(s) {
    pruneOldStamps(s);
    if (s.timestamps.length < limit) return 0;
    const oldest = s.timestamps[0];
    return Math.max(0, (oldest + windowMs) - now());
  }

  // --- Core admission logic -----------------------------------

  async function acquire(key) {
    const s = stateFor(key);
    // Fast path: capacity available.
    const admitFn = strategy === 'token-bucket' ? tokenBucketTryAdmit : slidingWindowTryAdmit;
    const msFn    = strategy === 'token-bucket' ? tokenBucketMsUntilAvailable : slidingWindowMsUntilAvailable;
    if (s.queue.length === 0 && admitFn(s)) return { immediate: true, waitedMs: 0 };

    // Slow path: queue.
    const enqueuedAt = now();
    stats.peakQueueDepth = Math.max(stats.peakQueueDepth, s.queue.length + 1);
    callHook(onQueue, { key, queueDepth: s.queue.length + 1 });

    let resolveWait, rejectWait;
    const waitPromise = new Promise((resolve, reject) => { resolveWait = resolve; rejectWait = reject; });
    const waiter = { resolve: resolveWait, reject: rejectWait, enqueuedAt };
    s.queue.push(waiter);

    // Scheduler: kick a drainer for this key.
    scheduleDrain(key);

    // Race the wait against queueTimeoutMs.
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('queue-timeout')), queueTimeoutMs);
      timeoutId.unref?.();
    });
    try {
      await Promise.race([waitPromise, timeoutPromise]);
      clearTimeout(timeoutId);
      const waitedMs = now() - enqueuedAt;
      return { immediate: false, waitedMs };
    } catch (err) {
      clearTimeout(timeoutId);
      // Remove ourselves from the queue.
      const idx = s.queue.indexOf(waiter);
      if (idx !== -1) s.queue.splice(idx, 1);
      const waitedMs = now() - enqueuedAt;
      throw new RateLimitTimeoutError({ key, waitedMs, queueTimeoutMs });
    }
  }

  // One drain loop per key. Wakes up as tokens/window admit slots.
  const drainScheduled = new Set();
  function scheduleDrain(key) {
    if (drainScheduled.has(key)) return;
    drainScheduled.add(key);
    (async () => {
      try {
        const s = stateFor(key);
        const admitFn = strategy === 'token-bucket' ? tokenBucketTryAdmit : slidingWindowTryAdmit;
        const msFn    = strategy === 'token-bucket' ? tokenBucketMsUntilAvailable : slidingWindowMsUntilAvailable;
        while (s.queue.length > 0) {
          if (admitFn(s)) {
            const waiter = s.queue.shift();
            waiter.resolve();
            continue;
          }
          const ms = msFn(s);
          await sleep(Math.max(1, ms));
        }
      } finally {
        drainScheduled.delete(key);
      }
    })();
  }

  // --- Middleware ------------------------------------

  const mw = async (ctx, next) => {
    stats.totalCalls++;

    let key;
    try { key = keyOf(ctx); }
    catch (err) {
      stats.keyErrors++;
      callHook(onError, { phase: 'keyOf', error: err });
      throw err;
    }
    if (typeof key !== 'string' || key.length === 0) key = 'global';
    stats.lastKey = key;

    let admission;
    try {
      admission = await acquire(key);
    } catch (err) {
      if (err instanceof RateLimitTimeoutError) {
        stats.timedOut++;
        callHook(onTimeout, { key, waitedMs: err.waitedMs, queueTimeoutMs });
      }
      throw err;
    }

    if (admission.immediate) stats.admittedImmediately++;
    else {
      stats.queuedThenAdmitted++;
      stats.totalWaitMs += admission.waitedMs;
    }
    callHook(onAdmit, { key, immediate: admission.immediate, waitedMs: admission.waitedMs });

    return next();
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.totalCalls = stats.admittedImmediately = stats.queuedThenAdmitted = 0;
    stats.timedOut = stats.keyErrors = stats.totalWaitMs = stats.peakQueueDepth = 0;
    stats.lastKey = null;
    // Don't reset state — those are real in-flight quotas.
  };
  mw.avgWaitMs = () => {
    return stats.queuedThenAdmitted === 0 ? 0 : stats.totalWaitMs / stats.queuedThenAdmitted;
  };
  mw.snapshotKeys = () => {
    const out = {};
    for (const [k, s] of state.entries()) {
      out[k] = strategy === 'token-bucket'
        ? { tokens: Number(s.tokens.toFixed(3)), queued: s.queue.length }
        : { count: s.timestamps.length, queued: s.queue.length };
    }
    return out;
  };
  mw.asMcpResource = () => ({
    uri: 'config://client-rate-limit',
    name: 'Client-side rate limiter',
    description: 'Proactive N-per-window throttler. Token-bucket or sliding-window. Queues + times out rather than 429ing.',
    mimeType: 'application/json',
    handler: () => {
      const base = {
        strategy,
        queueTimeoutMs,
        avgWaitMs: mw.avgWaitMs(),
        keyCount: state.size,
        keys: mw.snapshotKeys(),
        ...stats,
      };
      if (strategy === 'token-bucket') {
        base.rate = rate;
        base.burst = effectiveBurst;
      } else {
        base.limit = limit;
        base.windowMs = windowMs;
      }
      return base;
    },
  });

  return mw;
}

module.exports = {
  clientSideRateLimit,
  RateLimitTimeoutError,
  CLIENT_RATE_LIMIT_STRATEGIES: STRATEGIES,
};
