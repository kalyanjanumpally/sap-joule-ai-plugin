// Fuzzy dedup. Near-duplicate detection via cheap text-similarity —
// Jaccard on character trigrams or normalized Levenshtein. Cache-like
// semantics: on near-duplicate, return the prior response without
// calling the provider.
//
// Fills the third slot in the dedup story:
//   * `requestCoalescer` (2.8)  — BYTE-IDENTICAL (in-flight)
//   * `responseCache` (0.9)      — BYTE-IDENTICAL (at-rest)
//   * `semanticCache` (2.7)      — EMBEDDING-SIMILAR (requires embedder)
//   * `fuzzyDedup` (this)        — CHARACTER-SIMILAR (no embedder — fast)
//
// Great for support-ticket deduplication + spam-prevention scenarios
// where users retype the same question with typos + slight wording
// changes.
//
//   const { fuzzyDedup, inMemoryFuzzyStore } = require('@saptarishi/cds-plugin-llm');
//
//   llm.use(fuzzyDedup({
//     similarityKind: 'jaccard-trigram',
//     threshold:      0.85,
//     store:          inMemoryFuzzyStore({ maxEntries: 1000, ttlMs: 3600_000 }),
//     onHit:          (i) => cds.log('llm:fuzzy').info('hit', i),
//   }));

// ---- Similarity algorithms ----------------------------------------

function normalize(text) {
  return String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Character trigrams: e.g., "hello" → {"  h", " he", "hel", "ell", "llo", "lo ", "o  "}.
// Pad with spaces so short strings don't degenerate to empty sets.
function trigrams(text) {
  const s = '  ' + normalize(text) + '  ';
  const set = new Set();
  if (s.length < 3) return set;
  for (let i = 0; i <= s.length - 3; i++) set.add(s.slice(i, i + 3));
  return set;
}

function jaccardTrigram(a, b) {
  const A = trigrams(a);
  const B = trigrams(b);
  if (A.size === 0 && B.size === 0) return 1;
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

// Standard iterative Levenshtein distance. O(a.length × b.length).
function levenshteinDistance(a, b) {
  a = normalize(a); b = normalize(b);
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function normalizedLevenshtein(a, b) {
  const na = normalize(a), nb = normalize(b);
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(na, nb) / maxLen;
}

const SIMILARITY_KINDS = Object.freeze(['jaccard-trigram', 'levenshtein']);

// ---- Default extractor ----------------------------------------------

function defaultExtractKey(ctx) {
  const req = ctx?.request ?? ctx ?? {};
  if (typeof req.prompt === 'string') return req.prompt;
  if (Array.isArray(req.messages)) {
    for (let i = req.messages.length - 1; i >= 0; i--) {
      const m = req.messages[i];
      if (m?.role === 'user' && typeof m.content === 'string') return m.content;
    }
    for (let i = req.messages.length - 1; i >= 0; i--) {
      if (typeof req.messages[i]?.content === 'string') return req.messages[i].content;
    }
  }
  if (typeof req.input === 'string') return req.input;
  return null;
}

// ---- In-memory store --------------------------------------------

function inMemoryFuzzyStore(options = {}) {
  const {
    maxEntries = 1000,
    ttlMs      = null,
    now        = () => Date.now(),
  } = options;

  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error(`inMemoryFuzzyStore: maxEntries must be a positive integer (got ${maxEntries}).`);
  }
  if (ttlMs != null && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
    throw new Error(`inMemoryFuzzyStore: ttlMs must be null or > 0 (got ${ttlMs}).`);
  }

  const entries = new Map();   // key → { value, ts }

  function isExpired(entry) {
    return ttlMs != null && (now() - entry.ts) > ttlMs;
  }

  return {
    async get(key) {
      const e = entries.get(key);
      if (!e) return null;
      if (isExpired(e)) { entries.delete(key); return null; }
      entries.delete(key); entries.set(key, e);
      return { value: e.value, ts: e.ts };
    },
    async findSimilar(text, threshold, similarityFn, options = {}) {
      const prefix = typeof options.keyPrefix === 'string' ? options.keyPrefix : null;
      let best = null;
      for (const [key, entry] of entries) {
        if (isExpired(entry)) { entries.delete(key); continue; }
        if (prefix && !key.startsWith(prefix)) continue;
        const sim = similarityFn(key, text);
        if (sim >= threshold && (best === null || sim > best.similarity)) {
          best = { key, similarity: sim, value: entry.value };
        }
      }
      return best;
    },
    async put(key, value) {
      if (entries.has(key)) entries.delete(key);
      if (entries.size >= maxEntries) {
        entries.delete(entries.keys().next().value);
      }
      entries.set(key, { value, ts: now() });
    },
    async size() { return entries.size; },
    async clear() { entries.clear(); },
    _entries: entries,
  };
}

// ---- Middleware -----------------------------------------------

function fuzzyDedup(options = {}) {
  const {
    extractKey        = defaultExtractKey,
    similarityKind    = 'jaccard-trigram',
    threshold         = 0.85,
    store,
    keyPrefix         = '',
    minKeyLength      = 8,     // don't dedupe trivially-short prompts
    shouldCache       = null,
    onHit             = null,
    onMiss            = null,
    onStore           = null,
    onError           = null,
  } = options;

  if (typeof extractKey !== 'function') {
    throw new Error('fuzzyDedup: extractKey must be a function.');
  }
  if (!SIMILARITY_KINDS.includes(similarityKind)) {
    throw new Error(`fuzzyDedup: similarityKind must be one of ${SIMILARITY_KINDS.join(', ')} (got ${JSON.stringify(similarityKind)}).`);
  }
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    throw new Error(`fuzzyDedup: threshold must be in (0, 1] (got ${threshold}).`);
  }
  if (!store || typeof store.get !== 'function' || typeof store.put !== 'function' || typeof store.findSimilar !== 'function') {
    throw new Error('fuzzyDedup: store must implement { get, put, findSimilar }.');
  }
  if (typeof keyPrefix !== 'string') {
    throw new Error('fuzzyDedup: keyPrefix must be a string.');
  }
  if (!Number.isInteger(minKeyLength) || minKeyLength < 0) {
    throw new Error(`fuzzyDedup: minKeyLength must be a non-negative integer (got ${minKeyLength}).`);
  }
  for (const [name, cb] of [['shouldCache', shouldCache], ['onHit', onHit], ['onMiss', onMiss], ['onStore', onStore], ['onError', onError]]) {
    if (cb != null && typeof cb !== 'function') {
      throw new Error(`fuzzyDedup: ${name} must be a function or null.`);
    }
  }

  const similarityFn = similarityKind === 'jaccard-trigram' ? jaccardTrigram : normalizedLevenshtein;

  const stats = {
    totalCalls:      0,
    hits:            0,
    misses:          0,
    exactHits:       0,     // key seen before (via store.get fast path)
    fuzzyHits:       0,     // near-duplicate found via findSimilar
    stores:          0,
    tooShort:        0,     // key below minKeyLength → passthrough
    storeErrors:     0,
    keyErrors:       0,
    lastSimilarity:  null,
    lastKey:         null,
  };

  function callHook(hook, arg) {
    if (!hook) return;
    try { const r = hook(arg); if (r && typeof r.then === 'function') r.catch(() => {}); }
    catch { /* swallow */ }
  }

  const mw = async (ctx, next) => {
    stats.totalCalls++;

    let rawKey;
    try { rawKey = extractKey(ctx); }
    catch (err) {
      stats.keyErrors++;
      callHook(onError, { phase: 'extractKey', error: err });
      return next();
    }
    if (typeof rawKey !== 'string' || rawKey.length === 0) return next();
    if (rawKey.length < minKeyLength) {
      stats.tooShort++;
      return next();
    }
    const key = keyPrefix + rawKey;

    // Exact-key hit — cheaper than fuzzy scan.
    let exact = null;
    try { exact = await store.get(key); }
    catch (err) {
      stats.storeErrors++;
      callHook(onError, { phase: 'store', error: err });
    }
    if (exact) {
      stats.hits++;
      stats.exactHits++;
      stats.lastSimilarity = 1;
      stats.lastKey = key;
      callHook(onHit, { key, similarity: 1, exact: true, value: exact.value });
      return exact.value;
    }

    // Fuzzy match.
    let similar = null;
    try {
      similar = await store.findSimilar(rawKey, threshold, similarityFn, { keyPrefix });
    } catch (err) {
      stats.storeErrors++;
      callHook(onError, { phase: 'store', error: err });
    }
    // Post-filter: enforce prefix isolation even if store ignored the hint.
    if (similar && keyPrefix && !String(similar.key).startsWith(keyPrefix)) {
      similar = null;
    }
    if (similar) {
      stats.hits++;
      stats.fuzzyHits++;
      stats.lastSimilarity = similar.similarity;
      stats.lastKey = similar.key;
      callHook(onHit, {
        key: similar.key,
        similarity: similar.similarity,
        exact: false,
        value: similar.value,
      });
      return similar.value;
    }

    stats.misses++;
    callHook(onMiss, { key });

    const result = await next();
    let doStore = true;
    if (shouldCache) {
      try { doStore = shouldCache(ctx, result) !== false; }
      catch (err) {
        callHook(onError, { phase: 'shouldCache', error: err });
        doStore = false;
      }
    }
    if (doStore && result !== undefined) {
      try {
        await store.put(key, result);
        stats.stores++;
        stats.lastKey = key;
        callHook(onStore, { key, value: result });
      } catch (err) {
        stats.storeErrors++;
        callHook(onError, { phase: 'store', error: err });
      }
    }
    return result;
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.totalCalls = stats.hits = stats.misses = 0;
    stats.exactHits = stats.fuzzyHits = stats.stores = 0;
    stats.tooShort = stats.storeErrors = stats.keyErrors = 0;
    stats.lastSimilarity = stats.lastKey = null;
  };
  mw.hitRate = () => {
    const denom = stats.hits + stats.misses;
    return denom === 0 ? 0 : stats.hits / denom;
  };
  mw.asMcpResource = () => ({
    uri: 'config://fuzzy-dedup',
    name: 'Fuzzy dedup',
    description: 'Near-duplicate detection via Jaccard-trigrams or Levenshtein. Cache-like semantics without an embedder.',
    mimeType: 'application/json',
    handler: () => ({
      similarityKind,
      threshold,
      keyPrefix,
      minKeyLength,
      hitRate: mw.hitRate(),
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  fuzzyDedup,
  inMemoryFuzzyStore,
  jaccardTrigram,
  normalizedLevenshtein,
  levenshteinDistance,
  trigrams,
  SIMILARITY_KINDS,
};
