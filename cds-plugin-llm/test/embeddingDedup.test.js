const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_ed__';
require.cache[STUB_PATH] = {
  exports: {
    Service: class { constructor(name, model, options) { this.options = options ?? {}; } async init() {} },
    log: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} }),
  },
  loaded: true,
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function(request, ...rest) {
  if (request === '@sap/cds') return STUB_PATH;
  return origResolve.call(this, request, ...rest);
};

const {
  embeddingDedup,
  EmbeddingLRU,
  defaultNormalize,
  defaultHash,
} = require('../lib/middleware/embeddingDedup');

// ---- Input validation --------------------------------------------------

test('embeddingDedup: throws on non-positive maxEntries', () => {
  assert.throws(() => embeddingDedup({ maxEntries: 0 }), /maxEntries must be/);
});
test('embeddingDedup: throws on non-positive maxTextLength', () => {
  assert.throws(() => embeddingDedup({ maxTextLength: 0 }), /maxTextLength must be/);
});
test('embeddingDedup: throws on non-function normalize', () => {
  assert.throws(() => embeddingDedup({ normalize: 'nope' }), /normalize must be/);
});
test('embeddingDedup: throws on non-function hash', () => {
  assert.throws(() => embeddingDedup({ hash: 'nope' }), /hash must be/);
});
test('embeddingDedup: throws on store without get/set', () => {
  assert.throws(() => embeddingDedup({ store: {} }), /store must expose/);
});

// ---- Defaults ---------------------------------------------------------

test('defaultNormalize: trims + collapses whitespace', () => {
  assert.equal(defaultNormalize('  hello   world  '), 'hello world');
  assert.equal(defaultNormalize('hello\n\tworld'), 'hello world');
});
test('defaultHash: deterministic sha256', () => {
  assert.equal(defaultHash('abc'), defaultHash('abc'));
  assert.notEqual(defaultHash('abc'), defaultHash('abd'));
  assert.equal(defaultHash('abc').length, 64);   // sha256 hex
});

// ---- EmbeddingLRU ----------------------------------------------------

test('EmbeddingLRU: get/set/has', () => {
  const lru = new EmbeddingLRU(3);
  assert.equal(lru.get('x'), undefined);
  lru.set('x', [1, 2]);
  assert.deepEqual(lru.get('x'), [1, 2]);
  assert.equal(lru.has('x'), true);
});
test('EmbeddingLRU: evicts oldest when at capacity', () => {
  const lru = new EmbeddingLRU(2);
  lru.set('a', [1]); lru.set('b', [2]); lru.set('c', [3]);
  assert.equal(lru.has('a'), false);
  assert.equal(lru.has('b'), true);
  assert.equal(lru.has('c'), true);
});
test('EmbeddingLRU: touching an entry moves it to end', () => {
  const lru = new EmbeddingLRU(2);
  lru.set('a', [1]); lru.set('b', [2]);
  lru.get('a');                     // touch a → b becomes oldest
  lru.set('c', [3]);                // evicts b
  assert.equal(lru.has('a'), true);
  assert.equal(lru.has('b'), false);
});

// ---- Pass-through ---------------------------------------------------

test('embeddingDedup: passes non-embed methods through', async () => {
  const mw = embeddingDedup();
  let called = false;
  const result = await mw(
    { method: 'chat', request: { model: 'x', messages: [] } },
    async () => { called = true; return { text: 'ok' }; },
  );
  assert.equal(called, true);
  assert.equal(result.text, 'ok');
});

test('embeddingDedup: passes empty input array through', async () => {
  const mw = embeddingDedup();
  let called = false;
  await mw(
    { method: 'embed', request: { model: 'x', input: [] } },
    async () => { called = true; return { embeddings: [] }; },
  );
  assert.equal(called, true);
});

test('embeddingDedup: passes when input is null/undefined', async () => {
  const mw = embeddingDedup();
  let called = false;
  await mw(
    { method: 'embed', request: { model: 'x' } },
    async () => { called = true; return { embeddings: [] }; },
  );
  assert.equal(called, true);
});

// ---- Cache miss then hit --------------------------------------------

test('embeddingDedup: first call is a miss, second is a hit', async () => {
  const mw = embeddingDedup();
  let calls = 0;
  const provider = async () => { calls++; return { embeddings: [[1, 2, 3]], model: 'm', usage: { input_tokens: 5 } }; };

  const ctx1 = { method: 'embed', request: { model: 'm', input: ['hello'] }, meta: {} };
  const r1 = await mw(ctx1, provider);
  assert.deepEqual(r1.embeddings, [[1, 2, 3]]);
  assert.equal(mw.stats.hits, 0);
  assert.equal(mw.stats.misses, 1);

  const ctx2 = { method: 'embed', request: { model: 'm', input: ['hello'] }, meta: {} };
  const r2 = await mw(ctx2, provider);
  assert.equal(calls, 1);                          // second call did NOT hit provider
  assert.deepEqual(r2.embeddings, [[1, 2, 3]]);
  assert.equal(r2.cached, true);
  assert.equal(mw.stats.hits, 1);
  assert.equal(mw.stats.allHitRequests, 1);
});

test('embeddingDedup: normalization — leading/trailing/multi whitespace same key', async () => {
  const mw = embeddingDedup();
  const provider = async () => ({ embeddings: [[9]], model: 'm' });

  await mw({ method: 'embed', request: { input: ['hello world'] }, meta: {} }, provider);
  const r2 = await mw({ method: 'embed', request: { input: ['  hello  world  '] }, meta: {} }, provider);
  assert.deepEqual(r2.embeddings, [[9]]);
  assert.equal(mw.stats.hits, 1);
});

test('embeddingDedup: custom normalize (lowercase)', async () => {
  const mw = embeddingDedup({ normalize: (t) => t.trim().toLowerCase() });
  const provider = async () => ({ embeddings: [[1]], model: 'm' });

  await mw({ method: 'embed', request: { input: ['Hello'] }, meta: {} }, provider);
  await mw({ method: 'embed', request: { input: ['HELLO'] }, meta: {} }, provider);
  assert.equal(mw.stats.hits, 1);
});

test('embeddingDedup: partial hit — only misses hit the provider', async () => {
  const mw = embeddingDedup();
  const provided = [];
  const provider = async (ctx) => {   // ctx unused; mw already set request
    return { embeddings: [[2], [3]], model: 'm' };
  };
  // Warm the cache with 'a'
  await mw(
    { method: 'embed', request: { input: ['a'] }, meta: {} },
    async () => ({ embeddings: [[1]] }),
  );

  // Now request ['a', 'b', 'c'] — only 'b','c' should hit provider.
  const ctx = { method: 'embed', request: { input: ['a', 'b', 'c'] }, meta: {} };
  let seenInput;
  const r = await mw(ctx, async () => {
    seenInput = ctx.request.input;
    return { embeddings: [[2], [3]], model: 'm' };
  });
  assert.deepEqual(seenInput, ['b', 'c']);
  assert.deepEqual(r.embeddings, [[1], [2], [3]]);
  assert.equal(mw.stats.hits, 1);       // 'a' hit once (in the 2nd call)
  assert.equal(mw.stats.misses, 3);     // 'a' warmed (miss), then 'b' + 'c' new
});

test('embeddingDedup: restores ctx.request after next()', async () => {
  const mw = embeddingDedup();
  const original = { model: 'm', input: ['a', 'b'] };
  const ctx = { method: 'embed', request: original, meta: {} };
  await mw(ctx, async () => ({ embeddings: [[1], [2]] }));
  assert.equal(ctx.request, original);
});

test('embeddingDedup: restores ctx.request even on error', async () => {
  const mw = embeddingDedup();
  const original = { model: 'm', input: ['a'] };
  const ctx = { method: 'embed', request: original, meta: {} };
  await assert.rejects(mw(ctx, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(ctx.request, original);
});

// ---- Single-string input --------------------------------------------

test('embeddingDedup: single-string input returns single-vector shape', async () => {
  const mw = embeddingDedup();
  const provider = async () => ({ embeddings: [7, 8, 9], model: 'm' });   // provider returns flat vec
  const r = await mw({ method: 'embed', request: { input: 'hello' }, meta: {} }, provider);
  assert.deepEqual(r.embeddings, [7, 8, 9]);
});

test('embeddingDedup: single-string cache hit', async () => {
  const mw = embeddingDedup();
  const provider = async () => ({ embeddings: [7, 8, 9], model: 'm' });
  await mw({ method: 'embed', request: { input: 'hello' }, meta: {} }, provider);
  const r = await mw({ method: 'embed', request: { input: 'hello' }, meta: {} }, provider);
  assert.deepEqual(r.embeddings, [7, 8, 9]);
  assert.equal(r.cached, true);
});

// ---- Max text length ------------------------------------------------

test('embeddingDedup: skips caching for texts over maxTextLength', async () => {
  const mw = embeddingDedup({ maxTextLength: 10 });
  const big = 'x'.repeat(50);
  let calls = 0;
  const provider = async () => { calls++; return { embeddings: [[1]] }; };
  await mw({ method: 'embed', request: { input: [big] }, meta: {} }, provider);
  await mw({ method: 'embed', request: { input: [big] }, meta: {} }, provider);
  assert.equal(calls, 2);                 // no cache
  assert.equal(mw.stats.skippedTooLong, 2);
});

// ---- Store injection -------------------------------------------------

test('embeddingDedup: custom store (Map with adapter)', async () => {
  const map = new Map();
  const store = {
    get: (k) => map.get(k),
    set: (k, v) => { map.set(k, v); },
    has: (k) => map.has(k),
  };
  const mw = embeddingDedup({ store });
  await mw({ method: 'embed', request: { input: ['x'] }, meta: {} },
    async () => ({ embeddings: [[1, 2]] }));
  assert.equal(map.size, 1);
});

// ---- Non-string input ------------------------------------------------

test('embeddingDedup: non-string element passes to provider (not cached)', async () => {
  const mw = embeddingDedup();
  let seenInput;
  const provider = async () => { return { embeddings: [[9]] }; };
  const ctx = { method: 'embed', request: { input: [{ bytes: 'binary' }] }, meta: {} };
  await mw(ctx, async () => {
    seenInput = ctx.request.input;
    return { embeddings: [[9]] };
  });
  assert.deepEqual(seenInput, [{ bytes: 'binary' }]);
});

// ---- Stats + introspection ------------------------------------------

test('embeddingDedup: stats + hit rate in MCP resource', async () => {
  const mw = embeddingDedup();
  const provider = async () => ({ embeddings: [[1]], model: 'm' });
  await mw({ method: 'embed', request: { input: ['a'] }, meta: {} }, provider);
  await mw({ method: 'embed', request: { input: ['a'] }, meta: {} }, provider);
  await mw({ method: 'embed', request: { input: ['a'] }, meta: {} }, provider);

  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://embedding-dedup');
  const payload = r.handler();
  assert.equal(payload.hits, 2);
  assert.equal(payload.misses, 1);
  assert.equal(payload.hitRate, 0.6667);
  assert.equal(payload.currentSize, 1);
});

test('embeddingDedup: reset zeroes counters', async () => {
  const mw = embeddingDedup();
  await mw({ method: 'embed', request: { input: ['x'] }, meta: {} },
    async () => ({ embeddings: [[1]] }));
  assert.equal(mw.stats.misses, 1);
  mw.reset();
  assert.equal(mw.stats.misses, 0);
});

test('embeddingDedup: clear() empties store', async () => {
  const mw = embeddingDedup();
  await mw({ method: 'embed', request: { input: ['x'] }, meta: {} },
    async () => ({ embeddings: [[1]] }));
  assert.equal(mw.size(), 1);
  mw.clear();
  assert.equal(mw.size(), 0);
});

test('embeddingDedup: has(text) checks presence', async () => {
  const mw = embeddingDedup();
  await mw({ method: 'embed', request: { input: ['hello world'] }, meta: {} },
    async () => ({ embeddings: [[1]] }));
  assert.equal(mw.has('hello world'), true);
  assert.equal(mw.has('HELLO WORLD'), false);       // default normalize is case-preserving
  assert.equal(mw.has('other'), false);
});

// ---- End-to-end RAG re-index scenario -------------------------------

test('embeddingDedup: RAG re-index scenario — 90% cache hit rate on second pass', async () => {
  const mw = embeddingDedup();
  const provider = async (ctx) => {
    const n = ctx.request.input.length;
    return { embeddings: Array.from({ length: n }, (_, i) => [i]) };
  };

  // First pass: 10 chunks embedded fresh.
  const chunks1 = Array.from({ length: 10 }, (_, i) => `chunk-${i}`);
  const ctx1 = { method: 'embed', request: { input: chunks1 }, meta: {} };
  await mw(ctx1, async () => provider(ctx1));

  // Second pass: 9 same chunks + 1 new chunk. Only the new one hits provider.
  const chunks2 = [...chunks1.slice(0, 9), 'chunk-NEW'];
  const ctx2 = { method: 'embed', request: { input: chunks2 }, meta: {} };
  let seenLen;
  await mw(ctx2, async () => {
    seenLen = ctx2.request.input.length;
    return provider(ctx2);
  });

  assert.equal(seenLen, 1);
  assert.equal(mw.stats.hits, 9);
});
