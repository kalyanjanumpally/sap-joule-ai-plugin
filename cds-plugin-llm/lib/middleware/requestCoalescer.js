// Request coalescer. When N concurrent identical requests are in flight,
// only ONE upstream call is made — all N callers await the same Promise
// and receive the same result. Fixes the classic "cache stampede" on
// cold `semanticCache` / `responseCache` state: the first miss triggers
// N parallel misses, all of which race to populate the cache.
//
//   const { requestCoalescer, semanticCache } = require('@saptarishi/cds-plugin-llm');
//
//   llm.use(requestCoalescer({
//     ttlMs: 500,       // also coalesce briefly-following requests
//     onCoalesce: (i) => cds.log('llm:coalesce').info(i),
//   }));
//   llm.use(semanticCache({ embedder, store }));
//
// Composition:
//   * Wrap requestCoalescer OUTSIDE semanticCache / responseCache to
//     absorb the burst on a cold key before it hits the cache.
//   * Wrap requestCoalescer OUTSIDE bulkhead / retry — one shared upstream
//     call should only consume one slot / retry budget, not N.
//   * Streaming methods are skipped by default (consumed streams can't be
//     fanned out); overridable via `skipMethods`.

const DEFAULT_SKIP_METHODS = new Set(['stream', 'streamCompletion']);

// Serialize a value into a stable string. `JSON.stringify` isn't
// deterministic across key orders, so this walks objects in sorted-key
// order. Functions/undefined are ignored (like JSON.stringify).
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  const parts = [];
  for (const k of keys) {
    if (v[k] === undefined || typeof v[k] === 'function') continue;
    parts.push(JSON.stringify(k) + ':' + stableStringify(v[k]));
  }
  return '{' + parts.join(',') + '}';
}

// Default key extractor: hash request fields that would meaningfully
// alter the response. Caller can pass a narrower `keyOf` for e.g. tenant
// isolation or intentionally-coarser grouping.
function defaultKeyOf(ctx) {
  const req = ctx?.request ?? ctx ?? null;
  if (!req) return null;
  const parts = {
    m: req.model,
    s: req.system,
    p: req.prompt,
    msgs: Array.isArray(req.messages) ? req.messages : undefined,
    fmt: req.format,
    tools: Array.isArray(req.tools) ? req.tools.map((t) => t.name).sort() : undefined,
    temp: req.temperature,
    tk: req.maxTokens,
  };
  // If literally nothing identifies the request, opt out of coalescing.
  const anyContent = parts.p != null || parts.msgs != null;
  if (!anyContent) return null;
  return stableStringify(parts);
}

function requestCoalescer(options = {}) {
  const {
    keyOf              = defaultKeyOf,
    ttlMs              = 0,
    maxInFlightKeys    = null,
    skipMethods        = null,
    cloneResult        = false,
    keyPrefix          = '',
    onCoalesce         = null,
    onLead             = null,
    onSettle           = null,
    onError            = null,
    now                = () => Date.now(),
  } = options;

  if (typeof keyOf !== 'function') {
    throw new Error('requestCoalescer: keyOf must be a function.');
  }
  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new Error(`requestCoalescer: ttlMs must be >= 0 (got ${ttlMs}).`);
  }
  if (maxInFlightKeys != null && (!Number.isInteger(maxInFlightKeys) || maxInFlightKeys < 1)) {
    throw new Error(`requestCoalescer: maxInFlightKeys must be a positive integer or null (got ${maxInFlightKeys}).`);
  }
  if (typeof keyPrefix !== 'string') {
    throw new Error('requestCoalescer: keyPrefix must be a string.');
  }
  for (const [name, cb] of [['onCoalesce', onCoalesce], ['onLead', onLead], ['onSettle', onSettle], ['onError', onError]]) {
    if (cb != null && typeof cb !== 'function') {
      throw new Error(`requestCoalescer: ${name} must be a function or null.`);
    }
  }

  const skipSet = skipMethods == null
    ? DEFAULT_SKIP_METHODS
    : new Set(skipMethods);

  // key -> { promise, waiters, startedAt, leaderCtx }
  const inFlight = new Map();
  // key -> { result, settledAt, error } — post-settle TTL cache for
  // absorbing briefly-following requests. Only populated when ttlMs > 0.
  const recentlySettled = new Map();

  const stats = {
    totalCalls:      0,
    leads:           0,       // upstream calls actually made
    coalesced:       0,       // callers that piggybacked
    ttlHits:         0,       // callers served from post-settle window
    errors:          0,
    keyErrors:       0,
    skippedByMethod: 0,
    dropped:         0,       // requests forced through because maxInFlightKeys was hit
    peakInFlight:    0,
    lastKey:         null,
  };

  function callHook(hook, arg) {
    if (!hook) return;
    try { const r = hook(arg); if (r && typeof r.then === 'function') r.catch(() => {}); }
    catch { /* swallow */ }
  }

  function scheduleTtlCleanup(key) {
    if (ttlMs <= 0) return;
    setTimeout(() => {
      const rec = recentlySettled.get(key);
      if (rec && (now() - rec.settledAt) >= ttlMs) {
        recentlySettled.delete(key);
      }
    }, ttlMs + 5).unref?.();
  }

  const mw = async (ctx, next) => {
    stats.totalCalls++;

    // Skip streaming (consumed streams can't be fanned out).
    if (ctx?.method && skipSet.has(ctx.method)) {
      stats.skippedByMethod++;
      return next();
    }

    // Extract key.
    let rawKey;
    try { rawKey = keyOf(ctx); }
    catch (err) {
      stats.keyErrors++;
      callHook(onError, { phase: 'keyOf', error: err });
      return next();
    }
    if (typeof rawKey !== 'string' || rawKey.length === 0) return next();
    const key = keyPrefix + rawKey;
    stats.lastKey = key;

    // TTL-cached recent result?
    if (ttlMs > 0) {
      const rec = recentlySettled.get(key);
      if (rec && (now() - rec.settledAt) < ttlMs) {
        if (rec.error) throw rec.error;
        stats.ttlHits++;
        callHook(onCoalesce, { key, source: 'ttl', waiters: null });
        return cloneResult ? structuredClone(rec.result) : rec.result;
      } else if (rec) {
        recentlySettled.delete(key);
      }
    }

    // In-flight? Piggyback on the leader.
    const existing = inFlight.get(key);
    if (existing) {
      existing.waiters++;
      stats.coalesced++;
      callHook(onCoalesce, { key, source: 'inflight', waiters: existing.waiters });
      const shared = await existing.promise;
      return cloneResult ? structuredClone(shared) : shared;
    }

    // Safety cap — if too many distinct keys are already in-flight,
    // don't add another entry. Just pass through (correct but no
    // coalescing benefit for this call).
    if (maxInFlightKeys != null && inFlight.size >= maxInFlightKeys) {
      stats.dropped++;
      return next();
    }

    // Lead: fire upstream, register in the in-flight map so
    // strictly-concurrent callers can piggyback.
    stats.leads++;
    const startedAt = now();
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    // Prevent an "unhandledRejection" when the leader errors with no
    // piggybackers attached. Piggybackers that DO await `entry.promise`
    // still receive the rejection normally.
    promise.catch(() => {});
    const entry = { promise, waiters: 1, startedAt };
    inFlight.set(key, entry);
    if (inFlight.size > stats.peakInFlight) stats.peakInFlight = inFlight.size;
    callHook(onLead, { key, startedAt });

    let result, thrown;
    try {
      result = await next();
      resolve(result);
    } catch (err) {
      thrown = err;
      stats.errors++;
      callHook(onError, { phase: 'next', error: err });
      reject(err);
    } finally {
      inFlight.delete(key);
      if (ttlMs > 0) {
        recentlySettled.set(key, { result, error: thrown, settledAt: now() });
        scheduleTtlCleanup(key);
      }
      const durationMs = now() - startedAt;
      callHook(onSettle, {
        key, durationMs, waiters: entry.waiters,
        outcome: thrown ? 'error' : 'ok',
      });
    }
    if (thrown) throw thrown;
    return cloneResult ? structuredClone(result) : result;
  };

  mw.stats = stats;
  mw.inFlightCount = () => inFlight.size;
  mw.recentlySettledCount = () => recentlySettled.size;
  mw.savingsRatio = () => {
    const denom = stats.leads + stats.coalesced + stats.ttlHits;
    return denom === 0 ? 0 : (stats.coalesced + stats.ttlHits) / denom;
  };
  mw.reset = () => {
    stats.totalCalls = stats.leads = stats.coalesced = 0;
    stats.ttlHits = stats.errors = stats.keyErrors = 0;
    stats.skippedByMethod = stats.dropped = stats.peakInFlight = 0;
    stats.lastKey = null;
    // Don't clear inFlight — those Promises are already awaited by callers.
    recentlySettled.clear();
  };
  mw.asMcpResource = () => ({
    uri: 'config://request-coalescer',
    name: 'Request coalescer',
    description: 'Deduplicates concurrent identical LLM calls to a single upstream fetch. Streaming methods skipped.',
    mimeType: 'application/json',
    handler: () => ({
      ttlMs,
      keyPrefix,
      maxInFlightKeys,
      skipMethods: Array.from(skipSet),
      cloneResult,
      inFlightCount: inFlight.size,
      recentlySettledCount: recentlySettled.size,
      savingsRatio: mw.savingsRatio(),
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  requestCoalescer,
  defaultKeyOf,
  stableStringify,
  DEFAULT_SKIP_METHODS: Array.from(DEFAULT_SKIP_METHODS),
};
