// Embedding dedup cache — content-addressable cache for
// llm.embed({ input }) calls. Normalizes each text, hashes it,
// looks up the vector. Same text → same vector, no re-embedding.
//
// Distinct from siblings:
//   responseCache    — caches WHOLE requests (whole embed response as one blob)
//   responseCache(semantic) — fuzzy lookup by cosine over a stored embedding
//   embeddingDedup   — caches INDIVIDUAL texts within an embed call
//
// The last one is the big saver for RAG pipelines: if you index
// 10,000 chunks today and re-index tomorrow with 100 new chunks
// added, only the 100 hit the provider. Same for query expansion,
// re-ranking, and any pipeline that re-embeds text over time.
//
//   const { embeddingDedup } = require('@saptarishi/cds-plugin-llm');
//
//   llm.use(embeddingDedup({
//     maxEntries:    10_000,
//     maxTextLength: 100_000,
//   }));
//
//   await llm.embed({ input: ['a', 'b', 'c'] });  // 3 calls
//   await llm.embed({ input: ['b', 'c', 'd'] });  // only 'd' hits provider
//
// Non-destructive to ctx.request — mutates for the inner next()
// call only, restores in a finally block.
//
// Only intercepts method === 'embed'. All other methods pass
// through untouched.

const { createHash } = require('node:crypto');

// ---- Default normalize + hash -----------------------------------------

function defaultNormalize(text) {
  return text.trim().replace(/\s+/g, ' ');
}

function defaultHash(text) {
  return createHash('sha256').update(text).digest('hex');
}

// ---- Minimal LRU (internal default store) ------------------------------

class EmbeddingLRU {
  constructor(maxEntries) {
    this.max = maxEntries;
    this.map = new Map();
  }
  get(key) {
    if (!this.map.has(key)) return undefined;
    // Refresh recency: delete + re-set moves to end.
    const v = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }
  set(key, value) {
    while (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    this.map.set(key, value);
  }
  has(key) { return this.map.has(key); }
  delete(key) { this.map.delete(key); }
  clear() { this.map.clear(); }
  get size() { return this.map.size; }
}

// ---- Main middleware --------------------------------------------------

function embeddingDedup(options = {}) {
  const {
    maxEntries     = 10_000,
    maxTextLength  = 100_000,
    normalize      = defaultNormalize,
    hash           = defaultHash,
    store          = null,
  } = options;

  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error(`embeddingDedup: maxEntries must be a positive integer (got ${maxEntries}).`);
  }
  if (!Number.isInteger(maxTextLength) || maxTextLength < 1) {
    throw new Error(`embeddingDedup: maxTextLength must be a positive integer (got ${maxTextLength}).`);
  }
  if (typeof normalize !== 'function') {
    throw new Error('embeddingDedup: normalize must be a function.');
  }
  if (typeof hash !== 'function') {
    throw new Error('embeddingDedup: hash must be a function.');
  }

  const _store = store ?? new EmbeddingLRU(maxEntries);
  if (typeof _store.get !== 'function' || typeof _store.set !== 'function') {
    throw new Error('embeddingDedup: store must expose { get, set } methods.');
  }

  const stats = {
    totalRequests:   0,
    totalTexts:      0,
    hits:            0,
    misses:          0,
    allHitRequests:  0,
    skippedTooLong:  0,
  };

  function keyFor(text) {
    return hash(normalize(text));
  }

  const mw = async (ctx, next) => {
    stats.totalRequests++;
    if (ctx?.method !== 'embed' || !ctx.request) return next();

    const rawInput = ctx.request.input;
    if (rawInput == null) return next();

    // Normalize input shape: single string ↔ array of strings.
    const wasArray = Array.isArray(rawInput);
    const inputs = wasArray ? rawInput : [rawInput];
    if (inputs.length === 0) return next();

    // Look up each text.
    const results = new Array(inputs.length);
    const missTexts = [];
    const missIdx = [];

    for (let i = 0; i < inputs.length; i++) {
      const text = inputs[i];
      stats.totalTexts++;
      if (typeof text !== 'string') {
        // Non-string input (unknown provider extension) — pass through to provider.
        missTexts.push(text);
        missIdx.push(i);
        continue;
      }
      if (text.length > maxTextLength) {
        stats.skippedTooLong++;
        missTexts.push(text);
        missIdx.push(i);
        continue;
      }
      const key = keyFor(text);
      const cached = await _store.get(key);
      if (cached !== undefined && cached !== null) {
        results[i] = cached;
        stats.hits++;
      } else {
        missTexts.push(text);
        missIdx.push(i);
        stats.misses++;
      }
    }

    // All hits — synthesize response without touching the provider.
    if (missTexts.length === 0) {
      stats.allHitRequests++;
      return {
        embeddings: wasArray ? results : results[0],
        model:      ctx.request.model ?? null,
        usage:      { input_tokens: 0, output_tokens: 0 },
        cached:     true,
      };
    }

    // Partial or full miss — call provider with only the misses.
    const original = ctx.request;
    const patched = { ...original, input: missTexts };
    ctx.request = patched;

    let providerResult;
    try {
      providerResult = await next();
    } finally {
      ctx.request = original;
    }

    // Merge fresh embeddings back into results by original position.
    const fresh = providerResult?.embeddings;
    if (!Array.isArray(fresh)) return providerResult;   // unexpected provider shape

    // Provider may return a single vector when input was a single string;
    // normalize to an array before merging.
    const freshArr = wasArray || Array.isArray(fresh[0]) || fresh.length === missTexts.length
      ? fresh
      : [fresh];

    for (let j = 0; j < missIdx.length; j++) {
      const i = missIdx[j];
      const v = freshArr[j];
      results[i] = v;
      // Cache only strings within the length cap.
      if (typeof inputs[i] === 'string' && inputs[i].length <= maxTextLength) {
        await _store.set(keyFor(inputs[i]), v);
      }
    }

    return {
      ...providerResult,
      embeddings: wasArray ? results : results[0],
    };
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.totalRequests = stats.totalTexts = 0;
    stats.hits = stats.misses = stats.allHitRequests = stats.skippedTooLong = 0;
  };
  mw.size = () => (typeof _store.size === 'function' ? _store.size() : _store.size);
  mw.clear = () => (typeof _store.clear === 'function' ? _store.clear() : null);
  mw.has = (text) => {
    if (typeof text !== 'string') return false;
    const key = keyFor(text);
    return typeof _store.has === 'function' ? _store.has(key) : (_store.get(key) !== undefined);
  };

  mw.asMcpResource = () => ({
    uri: 'config://embedding-dedup',
    name: 'Embedding dedup cache',
    description: 'Content-addressable cache for embed() texts — same input string → same vector, no re-embedding.',
    mimeType: 'application/json',
    handler: () => ({
      maxEntries,
      maxTextLength,
      currentSize: typeof _store.size === 'function' ? _store.size() : _store.size,
      hitRate: (stats.hits + stats.misses) > 0
        ? +(stats.hits / (stats.hits + stats.misses)).toFixed(4)
        : 0,
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  embeddingDedup,
  EmbeddingLRU,
  defaultNormalize,
  defaultHash,
};
