const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_fd__';
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
  fuzzyDedup,
  inMemoryFuzzyStore,
  jaccardTrigram,
  normalizedLevenshtein,
  levenshteinDistance,
  trigrams,
  SIMILARITY_KINDS,
} = require('../lib/middleware/fuzzyDedup');

function ctxWith(prompt) { return { request: { prompt } }; }

// ---- Similarity helpers -----------------------------------------

test('SIMILARITY_KINDS frozen', () => {
  assert.ok(Object.isFrozen(SIMILARITY_KINDS));
  assert.deepEqual([...SIMILARITY_KINDS], ['jaccard-trigram', 'levenshtein']);
});

test('trigrams: hello has 7 padded trigrams', () => {
  const t = trigrams('hello');
  // "  hello  " → "  h", " he", "hel", "ell", "llo", "lo ", "o  "
  assert.equal(t.size, 7);
});

test('jaccardTrigram: identical → 1', () => {
  assert.equal(jaccardTrigram('same string', 'same string'), 1);
});

test('jaccardTrigram: totally different → low', () => {
  const sim = jaccardTrigram('abc def ghi', 'xyz uvw rst');
  assert.ok(sim < 0.2);
});

test('jaccardTrigram: near-duplicate (typo) → high', () => {
  const sim = jaccardTrigram('how do I reset my password', 'how do i reset my password');
  assert.ok(sim > 0.9);
});

test('jaccardTrigram: slight rewording → moderate', () => {
  const sim = jaccardTrigram(
    'how do I cancel my subscription?',
    'How can I cancel my subscription',
  );
  // Rewording ("do I" → "can I", trailing ? removed) → around 0.65-0.75.
  assert.ok(sim > 0.6, `got ${sim}`);
  assert.ok(sim < 0.95);
});

test('jaccardTrigram: both empty → 1', () => {
  assert.equal(jaccardTrigram('', ''), 1);
});

test('jaccardTrigram: one empty → 0', () => {
  assert.equal(jaccardTrigram('', 'hello'), 0);
});

test('normalizedLevenshtein: identical → 1', () => {
  assert.equal(normalizedLevenshtein('abc', 'abc'), 1);
});

test('normalizedLevenshtein: one edit → ~0.67', () => {
  const s = normalizedLevenshtein('abc', 'abd');
  assert.ok(s > 0.6 && s < 0.75);
});

test('normalizedLevenshtein: totally different → 0', () => {
  assert.ok(normalizedLevenshtein('abc', 'xyz') < 0.4);
});

test('levenshteinDistance: basic edits', () => {
  assert.equal(levenshteinDistance('cat', 'bat'), 1);
  assert.equal(levenshteinDistance('cat', 'cats'), 1);
  assert.equal(levenshteinDistance('hello', 'hallo'), 1);
});

// ---- inMemoryFuzzyStore -----------------------------------

test('inMemoryFuzzyStore: validates maxEntries', () => {
  assert.throws(() => inMemoryFuzzyStore({ maxEntries: 0 }), /maxEntries/);
});
test('inMemoryFuzzyStore: put + get exact match', async () => {
  const s = inMemoryFuzzyStore();
  await s.put('foo', 'bar');
  const e = await s.get('foo');
  assert.equal(e.value, 'bar');
});
test('inMemoryFuzzyStore: findSimilar returns best match above threshold', async () => {
  const s = inMemoryFuzzyStore();
  await s.put('reset my password', 'ANS1');
  await s.put('how do I login', 'ANS2');
  const hit = await s.findSimilar('reset my passwoord', 0.8, jaccardTrigram);
  assert.equal(hit.value, 'ANS1');
  assert.ok(hit.similarity > 0.8);
});
test('inMemoryFuzzyStore: findSimilar returns null below threshold', async () => {
  const s = inMemoryFuzzyStore();
  await s.put('reset my password', 'ANS1');
  const hit = await s.findSimilar('unrelated topic here', 0.8, jaccardTrigram);
  assert.equal(hit, null);
});
test('inMemoryFuzzyStore: TTL expires', async () => {
  let t = 0;
  const s = inMemoryFuzzyStore({ ttlMs: 100, now: () => t });
  await s.put('k', 'v');
  t = 50; assert.ok(await s.get('k'));
  t = 200; assert.equal(await s.get('k'), null);
});
test('inMemoryFuzzyStore: maxEntries evicts oldest', async () => {
  const s = inMemoryFuzzyStore({ maxEntries: 2 });
  await s.put('a', 1);
  await s.put('b', 2);
  await s.put('c', 3);
  assert.equal(await s.get('a'), null);
});

// ---- Middleware validation ---------------------

test('fuzzyDedup: throws without store', () => {
  assert.throws(() => fuzzyDedup({}), /store/);
});
test('fuzzyDedup: throws on incomplete store', () => {
  assert.throws(() => fuzzyDedup({ store: { get: async () => null } }), /store/);
});
test('fuzzyDedup: throws on unknown similarityKind', () => {
  assert.throws(() => fuzzyDedup({ store: inMemoryFuzzyStore(), similarityKind: 'bogus' }), /similarityKind/);
});
test('fuzzyDedup: throws on out-of-range threshold', () => {
  assert.throws(() => fuzzyDedup({ store: inMemoryFuzzyStore(), threshold: 0 }), /threshold/);
  assert.throws(() => fuzzyDedup({ store: inMemoryFuzzyStore(), threshold: 1.5 }), /threshold/);
});
test('fuzzyDedup: throws on non-string keyPrefix', () => {
  assert.throws(() => fuzzyDedup({ store: inMemoryFuzzyStore(), keyPrefix: 1 }), /keyPrefix/);
});
test('fuzzyDedup: throws on negative minKeyLength', () => {
  assert.throws(() => fuzzyDedup({ store: inMemoryFuzzyStore(), minKeyLength: -1 }), /minKeyLength/);
});
test('fuzzyDedup: throws on non-function callback', () => {
  assert.throws(() => fuzzyDedup({ store: inMemoryFuzzyStore(), onHit: 'x' }), /onHit/);
});

// ---- Exact match hit (fast path) --------------------

test('fuzzyDedup: byte-identical prompt → exact hit skips next()', async () => {
  const store = inMemoryFuzzyStore();
  const mw = fuzzyDedup({ store });
  let calls = 0;
  const answer = { text: 'cached answer' };
  await mw(ctxWith('how do I reset password'), async () => { calls++; return answer; });
  const r = await mw(ctxWith('how do I reset password'), async () => { calls++; return { text: 'different' }; });
  assert.equal(r, answer);
  assert.equal(calls, 1);
  assert.equal(mw.stats.exactHits, 1);
});

// ---- Fuzzy match ---------------------------

test('fuzzyDedup: near-duplicate prompt → fuzzy hit', async () => {
  const store = inMemoryFuzzyStore();
  const mw = fuzzyDedup({ store, threshold: 0.7 });
  let calls = 0;
  const answer = { text: 'cached answer' };
  await mw(ctxWith('how do I reset my password'), async () => { calls++; return answer; });
  // Typo version — should hit via fuzzy match.
  const r = await mw(ctxWith('how do I reset my passwoord'), async () => { calls++; return { text: 'diff' }; });
  assert.equal(r, answer);
  assert.equal(calls, 1);
  assert.equal(mw.stats.fuzzyHits, 1);
  assert.ok(mw.stats.lastSimilarity > 0.7);
});

test('fuzzyDedup: dissimilar prompt → miss', async () => {
  const store = inMemoryFuzzyStore();
  const mw = fuzzyDedup({ store, threshold: 0.85 });
  let calls = 0;
  await mw(ctxWith('what is the weather today'), async () => { calls++; return 'A'; });
  await mw(ctxWith('recommend a good book'), async () => { calls++; return 'B'; });
  assert.equal(calls, 2);
  assert.equal(mw.stats.misses, 2);
});

// ---- Similarity kind selection ------------------------

test('fuzzyDedup: levenshtein kind used when configured', async () => {
  const store = inMemoryFuzzyStore();
  const mw = fuzzyDedup({ store, similarityKind: 'levenshtein', threshold: 0.85 });
  const answer = { text: 'cached' };
  await mw(ctxWith('cancel subscription'), async () => answer);
  const r = await mw(ctxWith('cancel subscriptiion'), async () => 'DIFF');   // 1-edit typo
  assert.equal(r, answer);
});

// ---- minKeyLength gate ----------------

test('fuzzyDedup: keys below minKeyLength → passthrough', async () => {
  const store = inMemoryFuzzyStore();
  const mw = fuzzyDedup({ store, minKeyLength: 20 });
  let calls = 0;
  await mw(ctxWith('short'), async () => { calls++; return 'A'; });
  await mw(ctxWith('short'), async () => { calls++; return 'B'; });
  assert.equal(calls, 2);
  assert.equal(mw.stats.tooShort, 2);
  assert.equal(mw.stats.hits, 0);
});

// ---- shouldCache ---------

test('fuzzyDedup: shouldCache=false skips store.put', async () => {
  const store = inMemoryFuzzyStore();
  const mw = fuzzyDedup({
    store,
    shouldCache: (_ctx, result) => result?.status !== 'error',
  });
  await mw(ctxWith('some question with enough length'), async () => ({ status: 'error' }));
  const size = await store.size();
  assert.equal(size, 0);
  assert.equal(mw.stats.stores, 0);
});

// ---- keyPrefix isolates tenants -----------

test('fuzzyDedup: keyPrefix isolates near-duplicates across tenants', async () => {
  const store = inMemoryFuzzyStore();
  const mwA = fuzzyDedup({ store, keyPrefix: 'A:', threshold: 0.7 });
  const mwB = fuzzyDedup({ store, keyPrefix: 'B:', threshold: 0.7 });
  const answerA = { text: 'tenantA answer' };
  await mwA(ctxWith('how do I reset password'), async () => answerA);
  let called = false;
  const r = await mwB(ctxWith('how do I reset password'), async () => { called = true; return 'tenantB'; });
  assert.equal(r, 'tenantB');   // NOT tenantA's cached answer
  assert.equal(called, true);
});

// ---- Extractor error → passthrough ----------

test('fuzzyDedup: extractKey throws → passthrough', async () => {
  const errors = [];
  const mw = fuzzyDedup({
    store: inMemoryFuzzyStore(),
    extractKey: () => { throw new Error('bad'); },
    onError: (i) => errors.push(i),
  });
  const r = await mw(ctxWith('anything'), async () => 'ok');
  assert.equal(r, 'ok');
  assert.equal(mw.stats.keyErrors, 1);
  assert.equal(errors[0].phase, 'extractKey');
});

test('fuzzyDedup: extractKey returns null → passthrough', async () => {
  const mw = fuzzyDedup({
    store: inMemoryFuzzyStore(),
    extractKey: () => null,
  });
  const r = await mw(ctxWith('anything'), async () => 'ok');
  assert.equal(r, 'ok');
});

// ---- Fail-open store error ------------

test('fuzzyDedup: store.get error → falls through to next()', async () => {
  const badStore = {
    async get() { throw new Error('down'); },
    async put() {},
    async findSimilar() { throw new Error('down'); },
  };
  const mw = fuzzyDedup({ store: badStore });
  const r = await mw(ctxWith('some question here'), async () => 'downstream');
  assert.equal(r, 'downstream');
  assert.ok(mw.stats.storeErrors >= 1);
});

// ---- Default extractor: messages[] -------

test('fuzzyDedup: default extractor pulls latest user message', async () => {
  const store = inMemoryFuzzyStore();
  const mw = fuzzyDedup({ store, threshold: 0.7 });
  let calls = 0;
  const ctx1 = { request: { messages: [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'How do I reset my password?' },
  ]}};
  const ctx2 = { request: { messages: [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'How do I reset my password' },   // no ?
  ]}};
  await mw(ctx1, async () => { calls++; return 'A'; });
  await mw(ctx2, async () => { calls++; return 'B'; });
  assert.equal(mw.stats.hits, 1);
  assert.equal(calls, 1);
});

// ---- Callbacks ------------

test('fuzzyDedup: onHit fires with exact flag', async () => {
  const events = [];
  const store = inMemoryFuzzyStore();
  const mw = fuzzyDedup({ store, threshold: 0.6, onHit: (i) => events.push(i) });
  await mw(ctxWith('some question here'), async () => 'A');
  await mw(ctxWith('some question here'), async () => 'B');   // exact hit
  await mw(ctxWith('some question heer'), async () => 'C');   // fuzzy hit (typo)
  assert.equal(events.length, 2);
  assert.equal(events[0].exact, true);
  assert.equal(events[1].exact, false);
});

test('fuzzyDedup: onMiss fires + onStore fires on cache write', async () => {
  const events = [];
  const store = inMemoryFuzzyStore();
  const mw = fuzzyDedup({
    store,
    onMiss: (i) => events.push(['miss', i.key]),
    onStore: (i) => events.push(['store', i.key]),
  });
  await mw(ctxWith('brand-new question here'), async () => 'ok');
  assert.equal(events.length, 2);
  assert.equal(events[0][0], 'miss');
  assert.equal(events[1][0], 'store');
});

test('fuzzyDedup: callback throws swallowed', async () => {
  const mw = fuzzyDedup({
    store: inMemoryFuzzyStore(),
    onHit: () => { throw new Error('x'); },
    onMiss: () => { throw new Error('x'); },
  });
  await mw(ctxWith('question one here'), async () => 'A');
  const r = await mw(ctxWith('question one here'), async () => 'B');
  assert.equal(r, 'A');
});

// ---- Stats + MCP + reset --------

test('fuzzyDedup: hitRate', async () => {
  const store = inMemoryFuzzyStore();
  const mw = fuzzyDedup({ store });
  await mw(ctxWith('some question here'), async () => 'A');   // miss
  await mw(ctxWith('some question here'), async () => 'B');   // hit
  assert.equal(mw.hitRate(), 0.5);
});

test('fuzzyDedup: reset clears counters', async () => {
  const mw = fuzzyDedup({ store: inMemoryFuzzyStore() });
  await mw(ctxWith('some question here'), async () => 'A');
  mw.reset();
  assert.equal(mw.stats.totalCalls, 0);
});

test('fuzzyDedup: asMcpResource', () => {
  const mw = fuzzyDedup({
    store: inMemoryFuzzyStore(),
    similarityKind: 'levenshtein', threshold: 0.9,
    keyPrefix: 'ns:', minKeyLength: 20,
  });
  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://fuzzy-dedup');
  const p = r.handler();
  assert.equal(p.similarityKind, 'levenshtein');
  assert.equal(p.threshold, 0.9);
  assert.equal(p.keyPrefix, 'ns:');
  assert.equal(p.minKeyLength, 20);
});
