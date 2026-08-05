// Response cache middleware for llm.use(). Memoizes identical chat() calls
// keyed by (model, system, messages, tools, format, maxTokens) via SHA-256.
//
//   const cache = responseCache({ ttl: 3_600_000 });
//   llm.use(cache);
//   llm.use(usageMetering());  // sees `cached: true` on hits; charges $0.
//
// Streams and embeddings are NOT cached (streams are hard to replay safely;
// embeddings are usually cheap enough that caching adds more risk than
// value). Tool-call responses (result.toolCalls) are ALSO not cached — a
// second turn will legitimately produce a different tool call.
//
// Skip cache per-call: pass `cache: false` on the chat request.
//
// Pluggable backends: pass any `store` with { get, set, delete?, clear?, size?, has? }.
// The default is a tiny in-memory LRU (evicts oldest on maxEntries overflow;
// respects per-entry TTL). Redis / HANA cache tables plug in cleanly.

const crypto = require('node:crypto');

const DEFAULT_TTL_MS = 3_600_000; // 1 hour
const DEFAULT_MAX_ENTRIES = 10_000;

function responseCache(options = {}) {
  const {
    store: userStore,
    ttl = DEFAULT_TTL_MS,
    keyFn = defaultKeyFn,
    maxEntries = DEFAULT_MAX_ENTRIES,
    onHit = null,
    onMiss = null,
  } = options;

  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new Error(`responseCache: ttl must be a positive number of ms (got ${ttl}).`);
  }
  if (typeof keyFn !== 'function') {
    throw new Error('responseCache: keyFn must be a function (ctx) => string.');
  }

  const store = userStore ?? new InMemoryLRU({ maxEntries });
  const stats = {
    hits: 0,
    misses: 0,
    skips: 0,  // requests that opted out via cache:false or non-chat method
  };

  const mw = async (ctx, next) => {
    // Only wrap chat. Streams + embeddings + batches skip the cache.
    if (ctx.method !== 'chat') { stats.skips++; return next(); }
    // Consumer opt-out per call.
    if (ctx.raw?.cache === false) { stats.skips++; return next(); }

    let key;
    try {
      key = await keyFn(ctx);
    } catch {
      // If the caller's keyFn throws, don't crash the request — fall through
      // to a live LLM call. Broken key gen shouldn't take down chat().
      stats.skips++;
      return next();
    }
    if (typeof key !== 'string' || key.length === 0) { stats.skips++; return next(); }

    const cached = await store.get(key);
    if (cached) {
      stats.hits++;
      if (onHit) {
        try { onHit(ctx, cached); } catch { /* swallow */ }
      }
      // Return a shallow clone with the cache marker so downstream
      // middleware (usageMetering) can detect the hit. The `cacheKey` field
      // is exposed on the response so consumers can invalidate a single
      // cached entry via `cache.delete(response.cacheKey)`.
      return { ...cached, cached: true, cacheKey: key };
    }
    stats.misses++;
    if (onMiss) {
      try { onMiss(ctx); } catch { /* swallow */ }
    }

    const result = await next();
    // Don't cache tool-call turns — they're intermediate steps in an agent
    // loop. The tool response next turn is a different request anyway.
    // Also don't cache falsy responses (upstream may have short-circuited).
    if (result && !result.toolCalls) {
      try { await store.set(key, result, ttl); }
      catch { /* swallow persistence errors — the request already succeeded */ }
    }
    return result;
  };

  mw.stats = stats;
  mw.store = store;
  mw.clear = async () => { if (store.clear) await store.clear(); };
  mw.delete = async (key) => { if (store.delete) await store.delete(key); };
  mw.size = () => (store.size ? store.size() : null);
  mw.hitRate = () => {
    const total = stats.hits + stats.misses;
    return total === 0 ? 0 : stats.hits / total;
  };
  // Ready-to-register MCP resource dumping the cache stats — mirrors the
  // pattern in usageMetering.asMcpResource().
  mw.asMcpResource = () => ({
    uri: 'config://cache',
    name: 'LLM response cache',
    description: 'Cache hit rate + size since process (or clear) start.',
    mimeType: 'application/json',
    handler: () => ({
      hits:    stats.hits,
      misses:  stats.misses,
      skips:   stats.skips,
      hitRate: mw.hitRate(),
      size:    mw.size(),
    }),
  });

  return mw;
}

// ---- default key derivation --------------------------------------------

function defaultKeyFn(ctx) {
  const req = ctx.request;
  // Deterministic JSON: same shape → same key. Object key ordering: since
  // we control what goes in, stringify's default field order is stable
  // enough here. Users needing insertion-order-agnostic keys can pass
  // their own keyFn.
  const material = JSON.stringify({
    model:     req.model,
    system:    req.system ?? null,
    messages:  req.messages,
    tools:     req.tools ?? null,
    format:    req.format ?? null,
    maxTokens: req.maxTokens,
  });
  return crypto.createHash('sha256').update(material).digest('hex');
}

// ---- in-memory LRU with TTL --------------------------------------------

class InMemoryLRU {
  constructor({ maxEntries }) {
    this.max = maxEntries;
    this.map = new Map(); // key -> { value, expiresAt }
  }
  get(key) {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.map.delete(key);
      return null;
    }
    // Refresh recency — Maps preserve insertion order, so delete + re-add.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }
  set(key, value, ttl) {
    // Evict oldest until we're under the cap. Simple LRU — Map keys are
    // ordered by insertion; oldest = first.
    while (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAt: Date.now() + ttl });
  }
  delete(key) { this.map.delete(key); }
  clear() { this.map.clear(); }
  size() { return this.map.size; }
  has(key) {
    const entry = this.map.get(key);
    return !!entry && entry.expiresAt >= Date.now();
  }
}

module.exports = { responseCache, InMemoryLRU, defaultKeyFn };
