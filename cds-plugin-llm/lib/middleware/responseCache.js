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
//
// SEMANTIC MATCHING (new in 1.32.0)
// ---------------------------------
//   const cache = responseCache({
//     ttl: 3_600_000,
//     semantic: {
//       embedder:      async (text) => (await llm.embed({ input: [text] })).embeddings[0],
//       threshold:     0.92,      // cosine — higher = stricter
//       maxScan:       200,       // # of recent entries to compare against
//       minTextLength: 20,        // skip super-short queries
//     },
//   });
//
// On an EXACT miss, the middleware embeds the user text and does a linear
// cosine-similarity scan over the semantic index. If any recent entry
// matches at >= threshold, that entry's cached response is returned. The
// result carries `{ cached: true, semantic: true, similarity: 0.94,
// cacheKey: <original> }` so downstream layers can distinguish semantic
// hits from exact hits.
//
// The semantic index is IN-PROCESS regardless of `store` — multi-instance
// deployments converge as each replica warms its own index. Semantic hits
// are approximate by nature; if strict per-tenant isolation matters, use
// a `keyFn` that prefixes the tenant or set `semantic.filter` to exclude
// cross-tenant matches (roadmap).

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
    semantic = null,
  } = options;

  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new Error(`responseCache: ttl must be a positive number of ms (got ${ttl}).`);
  }
  if (typeof keyFn !== 'function') {
    throw new Error('responseCache: keyFn must be a function (ctx) => string.');
  }

  // ---- Semantic config validation ----
  let semanticCfg = null;
  if (semantic) {
    if (typeof semantic.embedder !== 'function') {
      throw new Error('responseCache: semantic.embedder must be an async function (text) => number[].');
    }
    const threshold = semantic.threshold ?? 0.92;
    if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
      throw new Error(`responseCache: semantic.threshold must be in (0, 1] (got ${threshold}).`);
    }
    const maxScan = semantic.maxScan ?? 200;
    if (!Number.isInteger(maxScan) || maxScan <= 0) {
      throw new Error(`responseCache: semantic.maxScan must be a positive integer (got ${maxScan}).`);
    }
    semanticCfg = {
      embedder:      semantic.embedder,
      threshold,
      maxScan,
      minTextLength: semantic.minTextLength ?? 20,
    };
  }

  const store = userStore ?? new InMemoryLRU({ maxEntries });
  const stats = {
    hits: 0,
    misses: 0,
    skips: 0,        // requests that opted out via cache:false or non-chat method
    semanticHits:   0,
    semanticMisses: 0,
    embedderErrors: 0,
  };

  // Semantic index: cacheKey → { embedding, semanticText, ts }.
  // In-process regardless of `store` — each replica warms independently.
  // Bounded by semantic.maxScan (LRU by insertion order).
  const semanticIndex = new Map();

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

    // ---- 1. Exact-match fast path ----
    const cached = await store.get(key);
    if (cached) {
      stats.hits++;
      if (onHit) {
        try { onHit(ctx, cached); } catch { /* swallow */ }
      }
      return { ...cached, cached: true, cacheKey: key };
    }

    // ---- 2. Semantic match (only if enabled + eligible request) ----
    if (semanticCfg && isSemanticEligible(ctx)) {
      const text = extractUserText(ctx.request);
      if (text && text.length >= semanticCfg.minTextLength) {
        try {
          const emb = await semanticCfg.embedder(text);
          if (Array.isArray(emb) && emb.length > 0) {
            const match = await findSemanticMatch(
              semanticIndex, store, emb, semanticCfg.threshold, semanticCfg.maxScan,
            );
            if (match) {
              stats.semanticHits++;
              if (onHit) {
                try { onHit(ctx, match.value); } catch { /* swallow */ }
              }
              return {
                ...match.value,
                cached: true,
                cacheKey: key,
                semantic: true,
                similarity: match.similarity,
                semanticMatchKey: match.key,
              };
            }
            // Only count as "semantic miss" if there were candidates to
            // compare against. Cold-index attempts are noise, not signal —
            // and this makes the metric useful for threshold tuning.
            if (semanticIndex.size > 0) stats.semanticMisses++;
            // Remember embedding for THIS request so it participates in
            // future semantic lookups once we've written the response.
            ctx._pendingSemanticEmb = emb;
            ctx._pendingSemanticText = text;
          }
        } catch {
          // Embedder failure is non-fatal — fall through to live call.
          // Common causes: rate limit, network blip, or a provider that
          // doesn't support embeddings. We count these to make the failure
          // rate visible without breaking chat().
          stats.embedderErrors++;
        }
      }
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

      // Register into semantic index. Cheap even when unused (~200 entries max).
      if (ctx._pendingSemanticEmb) {
        pushSemanticIndex(
          semanticIndex,
          key,
          ctx._pendingSemanticEmb,
          ctx._pendingSemanticText,
          semanticCfg?.maxScan ?? 200,
        );
      }
    }
    return result;
  };

  mw.stats = stats;
  mw.store = store;
  mw.semanticIndex = semanticIndex;   // exposed for tests / manual eviction
  mw.clear = async () => {
    if (store.clear) await store.clear();
    semanticIndex.clear();
  };
  mw.delete = async (key) => {
    if (store.delete) await store.delete(key);
    semanticIndex.delete(key);
  };
  mw.size = () => (store.size ? store.size() : null);
  mw.hitRate = () => {
    const total = stats.hits + stats.semanticHits + stats.misses;
    return total === 0 ? 0 : (stats.hits + stats.semanticHits) / total;
  };
  // Ready-to-register MCP resource dumping the cache stats — mirrors the
  // pattern in usageMetering.asMcpResource().
  mw.asMcpResource = () => ({
    uri: 'config://cache',
    name: 'LLM response cache',
    description: 'Cache hit rate + size since process (or clear) start.',
    mimeType: 'application/json',
    handler: () => ({
      hits:           stats.hits,
      misses:         stats.misses,
      skips:          stats.skips,
      semanticHits:   stats.semanticHits,
      semanticMisses: stats.semanticMisses,
      embedderErrors: stats.embedderErrors,
      hitRate:        mw.hitRate(),
      size:           mw.size(),
      semanticIndexSize: semanticIndex.size,
    }),
  });

  return mw;
}

// ---- Semantic helpers --------------------------------------------------

function isSemanticEligible(ctx) {
  const req = ctx.request;
  // Skip semantic if the request has tools — tool-call routing must be
  // deterministic against the exact input, not a fuzzy neighbor. Same
  // reasoning for structured outputs: caller likely wants tight coupling
  // between prompt and shape.
  if (Array.isArray(req?.tools) && req.tools.length > 0) return false;
  return true;
}

function extractUserText(request) {
  if (!request?.messages) return '';
  const parts = [];
  for (const m of request.messages) {
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') parts.push(m.content);
    else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b && typeof b.text === 'string') parts.push(b.text);
      }
    }
  }
  return parts.join('\n');
}

function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    const av = a[i], bv = b[i];
    dot += av * bv;
    na  += av * av;
    nb  += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function findSemanticMatch(semanticIndex, store, queryEmb, threshold, maxScan) {
  // Walk newest → oldest (Map insertion order — reverse via a small array).
  // We compare up to `maxScan` entries. On a cosmetic ≥ threshold hit we
  // verify the store still has the entry (it may have expired or been
  // evicted). Return the BEST match, not just the first — a stricter
  // threshold means fewer false positives regardless.
  const keys = Array.from(semanticIndex.keys()).slice(-maxScan).reverse();
  let best = null;
  for (const k of keys) {
    const entry = semanticIndex.get(k);
    if (!entry) continue;
    const sim = cosine(queryEmb, entry.embedding);
    if (sim >= threshold && (!best || sim > best.similarity)) {
      best = { key: k, similarity: sim };
    }
  }
  if (!best) return null;
  const value = await store.get(best.key);
  if (!value) {
    // Stale index pointer — remove and give up (the caller falls through
    // to a live call and the response will refresh the index).
    semanticIndex.delete(best.key);
    return null;
  }
  return { key: best.key, similarity: best.similarity, value };
}

function pushSemanticIndex(index, key, embedding, text, cap) {
  // Delete + set to bump recency (Map preserves insertion order).
  if (index.has(key)) index.delete(key);
  index.set(key, { embedding, semanticText: text, ts: Date.now() });
  // Evict oldest until we're under the cap.
  while (index.size > cap) {
    const oldest = index.keys().next().value;
    if (oldest === undefined) break;
    index.delete(oldest);
  }
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

module.exports = { responseCache, InMemoryLRU, defaultKeyFn, cosine };
