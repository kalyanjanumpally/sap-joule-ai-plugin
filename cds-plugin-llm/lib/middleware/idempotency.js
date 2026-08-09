// Idempotency middleware. Dedupes duplicate LLM requests over a
// short TTL window — protects against client retries on flaky
// networks that would otherwise double-bill for the same logical
// call.
//
// Different from `responseCache` (long-lived intentional cache) and
// `retryOnRateLimit` (which IS the retry — this handles the mirror
// case of client-side retries):
//
//   responseCache : "make this call cheap when repeated" (hours/days)
//   idempotency   : "collapse accidental dupes" (seconds/minutes)
//   retryOnRateLimit : "auto-retry when the server throttles us"
//
// Two duplicate modes:
//
//   IN-FLIGHT (original call still running):
//     'coalesce' (default) — subsequent calls await the SAME promise.
//                             Only one provider call happens.
//     'reject'             — throws IdempotencyInFlightError immediately.
//
//   COMPLETED (original call finished within ttlMs):
//     'return' (default)   — subsequent calls receive the cached result.
//     'reject'             — throws IdempotencyInFlightError with completed:true.
//
// Failed calls are NEVER cached — a retry on error legitimately re-runs
// the LLM.
//
// Streams are NOT deduplicated (each caller must own its iterator).
// Stream requests always pass through with a stats.streamsBypassed++.
//
// Usage:
//
//   const { idempotency } = require('@saptarishi/cds-plugin-llm');
//
//   llm.use(idempotency({
//     ttlMs:   60_000,          // completed-window: 60s
//     maxSize: 1000,            // LRU eviction
//     keyFrom: (ctx) => ctx.raw?.headers?.['idempotency-key'],  // stripe-style
//   }));
//
// Placement in chain: OUTER of usageMetering / costBudget (dedupes DON'T
// re-bill), INNER of promptInjectionGuard / guardrails (still validate
// each caller's input, but the LLM call itself is deduped).

const { createHash } = require('node:crypto');
const { LLMError } = require('../errors');

// ---- Error class -----------------------------------------------------

class IdempotencyInFlightError extends LLMError {
  constructor(key, completed) {
    super(
      completed
        ? `idempotency: duplicate request rejected — original completed recently (key=${key.slice(0, 16)}...)`
        : `idempotency: duplicate request rejected — original still in flight (key=${key.slice(0, 16)}...)`,
      'IDEMPOTENCY_IN_FLIGHT',
    );
    this.key = key;
    this.completed = completed;
  }
}

// ---- Default hasher --------------------------------------------------

const HASHED_FIELDS = ['model', 'messages', 'input', 'system', 'maxTokens', 'temperature', 'format', 'tools', 'seed'];

function defaultHashOf(ctx) {
  const req = ctx?.request ?? ctx?.raw ?? {};
  const shape = { method: ctx?.method ?? 'unknown' };
  for (const f of HASHED_FIELDS) {
    if (req[f] !== undefined) shape[f] = req[f];
  }
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex');
}

// ---- Main middleware -------------------------------------------------

function idempotency(options = {}) {
  const {
    ttlMs         = 60_000,
    maxSize       = 1000,
    hashOf        = defaultHashOf,
    keyFrom       = null,
    onInFlight    = 'coalesce',
    onDuplicate   = 'return',
    captureStreams = false,
    now           = () => Date.now(),
  } = options;

  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new Error(`idempotency: ttlMs must be a non-negative number (got ${ttlMs}).`);
  }
  if (!Number.isInteger(maxSize) || maxSize < 1) {
    throw new Error(`idempotency: maxSize must be a positive integer (got ${maxSize}).`);
  }
  if (typeof hashOf !== 'function') {
    throw new Error('idempotency: hashOf must be a function (ctx) => string.');
  }
  if (keyFrom !== null && typeof keyFrom !== 'function') {
    throw new Error('idempotency: keyFrom must be a function or null.');
  }
  if (onInFlight !== 'coalesce' && onInFlight !== 'reject') {
    throw new Error(`idempotency: onInFlight must be 'coalesce' or 'reject' (got ${JSON.stringify(onInFlight)}).`);
  }
  if (onDuplicate !== 'return' && onDuplicate !== 'reject') {
    throw new Error(`idempotency: onDuplicate must be 'return' or 'reject' (got ${JSON.stringify(onDuplicate)}).`);
  }

  // Map: key → { promise, result?, expiresAt? }
  // Insertion-order preserved → simple LRU by delete-then-set on touch.
  const store = new Map();

  const stats = {
    totalRequests:    0,
    hits:             0,   // completed-cache hits
    inFlightCoalesced: 0,  // in-flight coalesces
    misses:           0,   // fresh calls
    rejected:         0,   // onInFlight='reject' or onDuplicate='reject' rejects
    evictions:        0,
    streamsBypassed:  0,
    errorsBypassed:   0,   // failed original — subsequent got fresh call
  };

  function evictExpired() {
    const t = now();
    // Old entries live at the front (LRU touch reorders).
    for (const [k, entry] of store) {
      if (entry.expiresAt != null && entry.expiresAt <= t) {
        store.delete(k);
        stats.evictions++;
      } else {
        break;   // still fresh; remaining are newer.
      }
    }
  }

  function evictLruIfFull() {
    while (store.size >= maxSize) {
      const firstKey = store.keys().next().value;
      if (firstKey === undefined) return;
      store.delete(firstKey);
      stats.evictions++;
    }
  }

  function touch(key, entry) {
    // LRU touch — delete + re-set moves to end.
    store.delete(key);
    store.set(key, entry);
  }

  const mw = async (ctx, next) => {
    stats.totalRequests++;

    // Compute key: explicit keyFrom takes priority.
    let key = null;
    if (keyFrom) {
      try { key = keyFrom(ctx); } catch { /* fall through to hash */ }
    }
    if (!key) key = hashOf(ctx);
    if (typeof key !== 'string' || key.length === 0) {
      // Bad key → bypass.
      stats.misses++;
      return next();
    }

    evictExpired();
    const existing = store.get(key);

    if (existing) {
      // In-flight?
      if (existing.promise && existing.result === undefined) {
        if (onInFlight === 'reject') {
          stats.rejected++;
          throw new IdempotencyInFlightError(key, false);
        }
        stats.inFlightCoalesced++;
        touch(key, existing);
        return existing.promise;
      }
      // Completed within TTL.
      if (existing.result !== undefined) {
        if (onDuplicate === 'reject') {
          stats.rejected++;
          throw new IdempotencyInFlightError(key, true);
        }
        stats.hits++;
        touch(key, existing);
        return existing.result;
      }
    }

    // Miss — kick off the call, store the promise so concurrent
    // dupes can coalesce onto it.
    stats.misses++;
    evictLruIfFull();

    const entry = { promise: null, result: undefined, expiresAt: null };
    store.set(key, entry);

    const p = (async () => {
      let result;
      try {
        result = await next();
      } catch (err) {
        store.delete(key);
        stats.errorsBypassed++;
        throw err;
      }
      // Streams: don't cache/coalesce — each caller must own its iterator.
      if (!captureStreams) {
        const { hasStreamCompletion } = require('../streamCompletion');
        if (hasStreamCompletion(result)) {
          store.delete(key);
          stats.streamsBypassed++;
          return result;
        }
      }
      entry.result = result;
      entry.promise = null;
      entry.expiresAt = now() + ttlMs;
      return result;
    })();

    entry.promise = p;
    // Suppress unhandled-rejection warning when coalesced callers await
    // later. Awaiting callers still see the rejection normally.
    p.catch(() => {});
    return p;
  };

  mw.stats = stats;
  mw.reset = () => {
    store.clear();
    stats.totalRequests = stats.hits = stats.inFlightCoalesced = 0;
    stats.misses = stats.rejected = stats.evictions = 0;
    stats.streamsBypassed = stats.errorsBypassed = 0;
  };
  mw.size = () => store.size;
  mw.has = (key) => store.has(key);

  mw.asMcpResource = () => ({
    uri: 'config://idempotency',
    name: 'Idempotency middleware',
    description: 'Deduplicates duplicate LLM requests over a short TTL window. Counters + config.',
    mimeType: 'application/json',
    handler: () => ({
      ttlMs,
      maxSize,
      onInFlight,
      onDuplicate,
      current: store.size,
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  idempotency,
  IdempotencyInFlightError,
  defaultHashOf,
};
