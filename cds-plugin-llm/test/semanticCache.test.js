const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_semcache__';
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
  semanticCache,
  inMemorySemanticStore,
  cosineSimilarity,
} = require('../lib/middleware/semanticCache');

// ---- Helpers -----------------------------------------------------------

function makeCtx(prompt) { return { request: { prompt } }; }

function tinyEmbedder(text) {
  const v = new Array(8).fill(0);
  for (let i = 0; i < text.length; i++) {
    v[i % 8] += text.charCodeAt(i) / 128;
  }
  return v;
}

async function embedder(text) { return tinyEmbedder(text); }

// ---- cosineSimilarity --------------------------------------------------

test('cosineSimilarity: identical vectors → 1.0', () => {
  assert.equal(cosineSimilarity([1, 2, 3], [1, 2, 3]), 1);
});
test('cosineSimilarity: orthogonal → 0.0', () => {
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});
test('cosineSimilarity: opposite → -1.0', () => {
  assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
});
test('cosineSimilarity: length mismatch → 0', () => {
  assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0);
});
test('cosineSimilarity: NaN vector → 0', () => {
  assert.equal(cosineSimilarity([1, NaN], [1, 1]), 0);
});
test('cosineSimilarity: zero vector → 0', () => {
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
});

// ---- inMemorySemanticStore --------------------------------------------

test('inMemorySemanticStore: validates maxEntries', () => {
  assert.throws(() => inMemorySemanticStore({ maxEntries: 0 }), /maxEntries/);
});
test('inMemorySemanticStore: validates ttlMs', () => {
  assert.throws(() => inMemorySemanticStore({ ttlMs: -1 }), /ttlMs/);
});
test('inMemorySemanticStore: put + get', async () => {
  const store = inMemorySemanticStore();
  await store.put('k1', { embedding: [1, 0], value: 'v1', ts: 1 });
  const got = await store.get('k1');
  assert.equal(got.value, 'v1');
});
test('inMemorySemanticStore: TTL expires entries', async () => {
  let t = 0;
  const store = inMemorySemanticStore({ ttlMs: 100, now: () => t });
  await store.put('k', { embedding: [1], value: 'v', ts: 0 });
  t = 50;
  assert.equal((await store.get('k'))?.value, 'v');
  t = 200;
  assert.equal(await store.get('k'), null);
});
test('inMemorySemanticStore: maxEntries evicts oldest', async () => {
  const store = inMemorySemanticStore({ maxEntries: 2 });
  await store.put('a', { embedding: [1, 0], value: 'A', ts: 1 });
  await store.put('b', { embedding: [0, 1], value: 'B', ts: 2 });
  await store.put('c', { embedding: [1, 1], value: 'C', ts: 3 });
  assert.equal(await store.size(), 2);
  assert.equal(await store.get('a'), null);
  assert.equal((await store.get('c'))?.value, 'C');
});
test('inMemorySemanticStore: findSimilar returns best match above threshold', async () => {
  const store = inMemorySemanticStore();
  await store.put('a', { embedding: [1, 0, 0], value: 'A', ts: 1 });
  await store.put('b', { embedding: [0, 1, 0], value: 'B', ts: 2 });
  const hit = await store.findSimilar([0.99, 0.01, 0], 0.9);
  assert.equal(hit.key, 'a');
  assert.ok(hit.similarity > 0.99);
});
test('inMemorySemanticStore: findSimilar returns null below threshold', async () => {
  const store = inMemorySemanticStore();
  await store.put('a', { embedding: [1, 0], value: 'A', ts: 1 });
  const hit = await store.findSimilar([0, 1], 0.5);
  assert.equal(hit, null);
});
test('inMemorySemanticStore: findSimilar skips expired entries', async () => {
  let t = 0;
  const store = inMemorySemanticStore({ ttlMs: 100, now: () => t });
  await store.put('a', { embedding: [1, 0], value: 'A', ts: 0 });
  t = 200;
  const hit = await store.findSimilar([1, 0], 0.5);
  assert.equal(hit, null);
  assert.equal(await store.size(), 0);
});
test('inMemorySemanticStore: clear', async () => {
  const store = inMemorySemanticStore();
  await store.put('a', { embedding: [1], value: 'A', ts: 1 });
  await store.clear();
  assert.equal(await store.size(), 0);
});

// ---- semanticCache: validation ----------------------------------------

test('semanticCache: throws without embedder', () => {
  assert.throws(() => semanticCache({ store: inMemorySemanticStore() }), /embedder/);
});
test('semanticCache: throws without store', () => {
  assert.throws(() => semanticCache({ embedder }), /store/);
});
test('semanticCache: throws on incomplete store', () => {
  assert.throws(() => semanticCache({ embedder, store: { get: async () => null } }), /store/);
});
test('semanticCache: throws on invalid threshold', () => {
  assert.throws(() => semanticCache({ embedder, store: inMemorySemanticStore(), threshold: 0 }), /threshold/);
  assert.throws(() => semanticCache({ embedder, store: inMemorySemanticStore(), threshold: 1.5 }), /threshold/);
});
test('semanticCache: throws on non-function extractKey', () => {
  assert.throws(() => semanticCache({ embedder, store: inMemorySemanticStore(), extractKey: 'x' }), /extractKey/);
});
test('semanticCache: throws on non-string keyPrefix', () => {
  assert.throws(() => semanticCache({ embedder, store: inMemorySemanticStore(), keyPrefix: 1 }), /keyPrefix/);
});
test('semanticCache: throws on non-function callbacks', () => {
  const base = { embedder, store: inMemorySemanticStore() };
  assert.throws(() => semanticCache({ ...base, onHit: 'x' }), /onHit/);
  assert.throws(() => semanticCache({ ...base, shouldCache: 1 }), /shouldCache/);
});

// ---- semanticCache: miss + store --------------------------------------

test('semanticCache: miss populates the store', async () => {
  const store = inMemorySemanticStore();
  const cache = semanticCache({ embedder, store });
  const r = await cache(makeCtx('what is CAP?'), async () => ({ text: 'CAP is...' }));
  assert.deepEqual(r, { text: 'CAP is...' });
  assert.equal(cache.stats.misses, 1);
  assert.equal(cache.stats.stores, 1);
  assert.equal(cache.stats.hits, 0);
  assert.equal(await store.size(), 1);
});

// ---- semanticCache: exact match --------------------------------------

test('semanticCache: exact-key hit skips embedder + next()', async () => {
  const store = inMemorySemanticStore();
  let embedderCalls = 0;
  const countingEmbedder = async (text) => { embedderCalls++; return tinyEmbedder(text); };
  const cache = semanticCache({ embedder: countingEmbedder, store });

  let downstream = 0;
  await cache(makeCtx('same prompt'), async () => { downstream++; return { text: 'answer' }; });
  const embedderCallsAfterMiss = embedderCalls;

  const r = await cache(makeCtx('same prompt'), async () => { downstream++; return { text: 'DIFFERENT' }; });
  assert.deepEqual(r, { text: 'answer' });
  assert.equal(downstream, 1);
  assert.equal(embedderCalls, embedderCallsAfterMiss);
  assert.equal(cache.stats.hits, 1);
  assert.equal(cache.stats.lastSimilarity, 1.0);
});

// ---- semanticCache: semantic (non-exact) hit -------------------------

test('semanticCache: near-match returns cached answer', async () => {
  const store = inMemorySemanticStore();
  const cache = semanticCache({
    embedder: async (t) => tinyEmbedder(t),
    store,
    threshold: 0.99,
  });

  await cache(makeCtx('what is the capital of France?'),
              async () => ({ text: 'Paris' }));

  const perturbed = tinyEmbedder('what is the capital of France?').slice();
  perturbed[0] += 0.001;
  const cache2 = semanticCache({
    embedder: async () => perturbed,
    store,
    threshold: 0.999,
  });
  let downstream = 0;
  const r = await cache2(makeCtx('a totally different prompt string'),
                         async () => { downstream++; return { text: 'MISS' }; });
  assert.deepEqual(r, { text: 'Paris' });
  assert.equal(downstream, 0);
  assert.equal(cache2.stats.hits, 1);
  assert.ok(cache2.stats.lastSimilarity > 0.999);
});

// ---- semanticCache: below threshold → miss ---------------------------

test('semanticCache: dissimilar prompt → miss', async () => {
  const store = inMemorySemanticStore();
  const vectors = { one: [1, 0, 0], two: [0, 1, 0] };
  const cache = semanticCache({
    embedder: async (t) => vectors[t] ?? [0, 0, 1],
    store,
    threshold: 0.5,
  });
  await cache(makeCtx('one'), async () => ({ text: 'a-answer' }));
  const r = await cache(makeCtx('two'), async () => ({ text: 'z-answer' }));
  assert.deepEqual(r, { text: 'z-answer' });
  assert.equal(cache.stats.hits, 0);
  assert.equal(cache.stats.misses, 2);
  assert.equal(cache.stats.stores, 2);
});

// ---- semanticCache: fail-open ----------------------------------------

test('semanticCache: embedder throws → fall through', async () => {
  const store = inMemorySemanticStore();
  let downstream = 0;
  const cache = semanticCache({
    embedder: async () => { throw new Error('emb-fail'); },
    store,
  });
  const r = await cache(makeCtx('x'), async () => { downstream++; return 'ok'; });
  assert.equal(r, 'ok');
  assert.equal(downstream, 1);
  assert.equal(cache.stats.embedderErrors, 1);
  assert.equal(cache.stats.errors, 1);
});

test('semanticCache: store.findSimilar throws → still calls next', async () => {
  const badStore = {
    async get() { return null; },
    async put() {},
    async findSimilar() { throw new Error('store-fail'); },
  };
  const cache = semanticCache({ embedder, store: badStore });
  const r = await cache(makeCtx('anything'), async () => 'downstream');
  assert.equal(r, 'downstream');
  assert.equal(cache.stats.storeErrors, 1);
});

test('semanticCache: onError fires with phase tag', async () => {
  const errors = [];
  const cache = semanticCache({
    embedder: async () => { throw new Error('boom'); },
    store: inMemorySemanticStore(),
    onError: (info) => errors.push(info),
  });
  await cache(makeCtx('x'), async () => 'r');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].phase, 'embedder');
});

// ---- semanticCache: bad embedder output ------------------------------

test('semanticCache: embedder returns non-array → miss', async () => {
  const store = inMemorySemanticStore();
  const cache = semanticCache({
    embedder: async () => null,
    store,
  });
  let downstream = 0;
  const r = await cache(makeCtx('x'), async () => { downstream++; return 'ok'; });
  assert.equal(r, 'ok');
  assert.equal(downstream, 1);
  assert.equal(await store.size(), 0);
});

// ---- semanticCache: no key ------------------------------------------

test('semanticCache: extractKey returns null → straight through', async () => {
  const cache = semanticCache({
    embedder, store: inMemorySemanticStore(),
    extractKey: () => null,
  });
  const r = await cache(makeCtx('x'), async () => 'downstream');
  assert.equal(r, 'downstream');
  assert.equal(cache.stats.hits, 0);
  assert.equal(cache.stats.misses, 0);
});

test('semanticCache: extractKey throws → straight through', async () => {
  const errors = [];
  const cache = semanticCache({
    embedder, store: inMemorySemanticStore(),
    extractKey: () => { throw new Error('bad'); },
    onError: (info) => errors.push(info),
  });
  const r = await cache(makeCtx('x'), async () => 'downstream');
  assert.equal(r, 'downstream');
  assert.equal(errors[0].phase, 'extractKey');
});

// ---- semanticCache: default extractKey pulls from messages ----------

test('semanticCache: default extractKey handles messages[]', async () => {
  const store = inMemorySemanticStore();
  const cache = semanticCache({ embedder, store });
  const ctx = { request: { messages: [
    { role: 'system', content: 'you are helpful' },
    { role: 'user',   content: 'hello' },
  ]}};
  await cache(ctx, async () => ({ text: 'greet' }));
  assert.equal(await store.size(), 1);
});

// ---- semanticCache: shouldCache gate --------------------------------

test('semanticCache: shouldCache=false prevents storage', async () => {
  const store = inMemorySemanticStore();
  const cache = semanticCache({
    embedder, store,
    shouldCache: (_ctx, result) => result?.status !== 'error',
  });
  await cache(makeCtx('x'), async () => ({ status: 'error' }));
  assert.equal(await store.size(), 0);
  assert.equal(cache.stats.stores, 0);
  await cache(makeCtx('y'), async () => ({ status: 'ok' }));
  assert.equal(await store.size(), 1);
});

// ---- semanticCache: onHit / onMiss / onStore hooks ------------------

test('semanticCache: hooks fire with expected payloads', async () => {
  const store = inMemorySemanticStore();
  const events = [];
  const cache = semanticCache({
    embedder, store,
    onHit:   (i) => events.push(['hit', i]),
    onMiss:  (i) => events.push(['miss', i]),
    onStore: (i) => events.push(['store', i]),
  });
  await cache(makeCtx('same'), async () => 'r1');
  await cache(makeCtx('same'), async () => 'r2');
  const kinds = events.map(([k]) => k);
  assert.deepEqual(kinds, ['miss', 'store', 'hit']);
  assert.equal(events[2][1].exactMatch, true);
});

test('semanticCache: hook throws are swallowed', async () => {
  const cache = semanticCache({
    embedder, store: inMemorySemanticStore(),
    onHit:   () => { throw new Error('x'); },
    onMiss:  () => { throw new Error('x'); },
    onStore: () => { throw new Error('x'); },
  });
  await cache(makeCtx('a'), async () => 'r1');
  const r = await cache(makeCtx('a'), async () => 'r2');
  assert.equal(r, 'r1');
});

// ---- semanticCache: keyPrefix namespaces caches ---------------------

test('semanticCache: keyPrefix isolates namespaces', async () => {
  const store = inMemorySemanticStore();
  const cacheA = semanticCache({ embedder, store, keyPrefix: 'tenantA:' });
  const cacheB = semanticCache({ embedder, store, keyPrefix: 'tenantB:' });
  await cacheA(makeCtx('hi'), async () => 'answerA');
  const r = await cacheB(makeCtx('hi'), async () => 'answerB');
  assert.equal(r, 'answerB');
  assert.equal(await store.size(), 2);
});

// ---- semanticCache: hitRate + reset ---------------------------------

test('semanticCache: hitRate + reset', async () => {
  const cache = semanticCache({ embedder, store: inMemorySemanticStore() });
  await cache(makeCtx('a'), async () => 'r');
  await cache(makeCtx('a'), async () => 'r');
  assert.equal(cache.hitRate(), 0.5);
  cache.reset();
  assert.equal(cache.stats.hits, 0);
  assert.equal(cache.stats.misses, 0);
  assert.equal(cache.hitRate(), 0);
});

// ---- semanticCache: MCP resource ------------------------------------

test('semanticCache: asMcpResource', async () => {
  const cache = semanticCache({
    embedder, store: inMemorySemanticStore(),
    threshold: 0.85, keyPrefix: 'ns:',
  });
  const r = cache.asMcpResource();
  assert.equal(r.uri, 'config://semantic-cache');
  const p = r.handler();
  assert.equal(p.threshold, 0.85);
  assert.equal(p.keyPrefix, 'ns:');
  assert.equal(p.hitRate, 0);
});
