// Semantic response cache. Reuse previous answers for prompts that are
// SEMANTICALLY similar (not just byte-identical). Users bring their own
// embedder + vector store; an in-memory linear-scan store is provided as
// the default so a working cache costs zero infrastructure to try out.
//
//   const { semanticCache, inMemorySemanticStore } = require('@saptarishi/cds-plugin-llm');
//
//   llm.use(semanticCache({
//     embedder: async (text) => (await llm.embed({ input: text })).vector,
//     store:    inMemorySemanticStore({ maxEntries: 1000, ttlMs: 3600_000 }),
//     threshold: 0.92,     // cosine similarity to count as a hit
//     onHit: (info) => cds.log('llm:cache').info('hit', info),
//   }));
//
// Fail-open policy: any exception from `embedder` or `store` is logged
// via `onError` and the call proceeds to `next()`. A broken cache must
// NEVER take the request path down.
//
// Composition:
//   * Wrap this OUTSIDE bulkhead/retry — cache hits should not consume
//     upstream concurrency slots or retry budget.
//   * INSIDE guardrails/promptInjection — you don't want to cache
//     answers whose inputs were rejected.

function defaultExtractKey(ctx) {
  const req = ctx?.request ?? ctx ?? {};
  if (typeof req.prompt === 'string') return req.prompt;
  if (Array.isArray(req.messages)) {
    return req.messages
      .map((m) => (typeof m?.content === 'string' ? `${m.role || 'user'}: ${m.content}` : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof req.input === 'string') return req.input;
  return null;
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    dot += x * y;
    na  += x * x;
    nb  += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

// ---- In-memory store ---------------------------------------------------

function inMemorySemanticStore(options = {}) {
  const {
    maxEntries = 1000,
    ttlMs      = null,
    now        = () => Date.now(),
  } = options;

  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error(`inMemorySemanticStore: maxEntries must be a positive integer (got ${maxEntries}).`);
  }
  if (ttlMs != null && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
    throw new Error(`inMemorySemanticStore: ttlMs must be null or > 0 (got ${ttlMs}).`);
  }

  // Map preserves insertion order — cheapest FIFO/LRU-ish eviction we
  // can do without extra bookkeeping.
  const entries = new Map();

  function isExpired(entry) {
    return ttlMs != null && (now() - entry.ts) > ttlMs;
  }

  return {
    async get(key) {
      const e = entries.get(key);
      if (!e) return null;
      if (isExpired(e)) { entries.delete(key); return null; }
      // Refresh insertion order → cheap LRU.
      entries.delete(key); entries.set(key, e);
      return e;
    },
    async put(key, entry) {
      if (entries.has(key)) entries.delete(key);
      if (entries.size >= maxEntries) {
        const oldestKey = entries.keys().next().value;
        entries.delete(oldestKey);
      }
      entries.set(key, entry);
    },
    async findSimilar(embedding, threshold, options = {}) {
      if (!Array.isArray(embedding) || embedding.length === 0) return null;
      const prefix = typeof options.keyPrefix === 'string' ? options.keyPrefix : null;
      let best = null;
      for (const [key, entry] of entries) {
        if (isExpired(entry)) { entries.delete(key); continue; }
        if (prefix && !key.startsWith(prefix)) continue;
        const sim = cosineSimilarity(embedding, entry.embedding);
        if (sim >= threshold && (best === null || sim > best.similarity)) {
          best = { key, similarity: sim, entry };
        }
      }
      return best;
    },
    async size() { return entries.size; },
    async clear() { entries.clear(); },
    // Test seam.
    _entries: entries,
  };
}

// ---- Middleware --------------------------------------------------------

function semanticCache(options = {}) {
  const {
    embedder,
    store,
    threshold    = 0.92,
    extractKey   = defaultExtractKey,
    keyPrefix    = '',
    shouldCache  = null,     // (ctx, result) => boolean; default = cache everything
    onHit        = null,
    onMiss       = null,
    onStore      = null,
    onError      = null,
  } = options;

  if (typeof embedder !== 'function') {
    throw new Error('semanticCache: embedder must be an async function (text) => number[].');
  }
  if (!store || typeof store.get !== 'function' || typeof store.put !== 'function'
      || typeof store.findSimilar !== 'function') {
    throw new Error('semanticCache: store must implement { get, put, findSimilar }.');
  }
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    throw new Error(`semanticCache: threshold must be in (0, 1] (got ${threshold}).`);
  }
  if (typeof extractKey !== 'function') {
    throw new Error('semanticCache: extractKey must be a function.');
  }
  if (typeof keyPrefix !== 'string') {
    throw new Error('semanticCache: keyPrefix must be a string.');
  }
  for (const [name, cb] of [['shouldCache', shouldCache], ['onHit', onHit], ['onMiss', onMiss], ['onStore', onStore], ['onError', onError]]) {
    if (cb != null && typeof cb !== 'function') {
      throw new Error(`semanticCache: ${name} must be a function or null.`);
    }
  }

  const stats = {
    totalCalls:   0,
    hits:         0,
    misses:       0,
    stores:       0,
    errors:       0,
    embedderErrors: 0,
    storeErrors:  0,
    lastSimilarity: null,
    lastKey:      null,
  };

  function callHook(hook, arg) {
    if (!hook) return;
    try { const r = hook(arg); if (r && typeof r.then === 'function') r.catch(() => {}); }
    catch { /* swallow */ }
  }

  function reportError(phase, err) {
    stats.errors++;
    if (phase === 'embedder') stats.embedderErrors++;
    else if (phase === 'store') stats.storeErrors++;
    callHook(onError, { phase, error: err });
  }

  const mw = async (ctx, next) => {
    stats.totalCalls++;

    // 1. Extract cache key from request.
    let rawKey;
    try { rawKey = extractKey(ctx); }
    catch (err) { reportError('extractKey', err); return next(); }
    if (typeof rawKey !== 'string' || rawKey.length === 0) return next();
    const key = keyPrefix + rawKey;

    // 2. Try exact-key hit first (cheap path — skips the embedder).
    let exact = null;
    try { exact = await store.get(key); }
    catch (err) { reportError('store', err); }
    if (exact) {
      stats.hits++;
      stats.lastSimilarity = 1.0;
      stats.lastKey = key;
      callHook(onHit, { key, similarity: 1.0, exactMatch: true, value: exact.value });
      return exact.value;
    }

    // 3. Embed the key and look for a semantically-similar entry.
    let embedding;
    try { embedding = await embedder(rawKey); }
    catch (err) { reportError('embedder', err); return next(); }
    if (!Array.isArray(embedding) || embedding.length === 0) {
      // Bad embedder output — don't cache-poison. Just miss.
      return next();
    }

    let similar = null;
    try { similar = await store.findSimilar(embedding, threshold, { keyPrefix }); }
    catch (err) { reportError('store', err); }
    // Post-filter: even if the store returned a match, ensure it belongs
    // to the caller's namespace. Stores that don't understand `keyPrefix`
    // will still be correct thanks to this check.
    if (similar && keyPrefix && !String(similar.key).startsWith(keyPrefix)) {
      similar = null;
    }
    if (similar) {
      stats.hits++;
      stats.lastSimilarity = similar.similarity;
      stats.lastKey = similar.key;
      callHook(onHit, {
        key: similar.key,
        similarity: similar.similarity,
        exactMatch: false,
        value: similar.entry.value,
      });
      return similar.entry.value;
    }

    stats.misses++;
    callHook(onMiss, { key });

    // 4. Miss — call downstream, then store.
    const result = await next();
    let shouldStoreThis = true;
    if (shouldCache) {
      try { shouldStoreThis = shouldCache(ctx, result) !== false; }
      catch (err) { reportError('shouldCache', err); shouldStoreThis = false; }
    }
    if (shouldStoreThis && result !== undefined) {
      try {
        await store.put(key, { embedding, value: result, ts: Date.now() });
        stats.stores++;
        stats.lastKey = key;
        callHook(onStore, { key, value: result });
      } catch (err) { reportError('store', err); }
    }
    return result;
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.totalCalls = stats.hits = stats.misses = stats.stores = stats.errors = 0;
    stats.embedderErrors = stats.storeErrors = 0;
    stats.lastSimilarity = stats.lastKey = null;
  };
  mw.hitRate = () => {
    const denom = stats.hits + stats.misses;
    return denom === 0 ? 0 : stats.hits / denom;
  };
  mw.asMcpResource = () => ({
    uri: 'config://semantic-cache',
    name: 'Semantic response cache',
    description: 'Reuses cached LLM responses for semantically-similar prompts. Fails open on embedder/store errors.',
    mimeType: 'application/json',
    handler: () => ({
      threshold,
      keyPrefix,
      hitRate: mw.hitRate(),
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  semanticCache,
  inMemorySemanticStore,
  cosineSimilarity,
};
