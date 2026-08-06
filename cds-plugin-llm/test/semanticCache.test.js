const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_semcache__';
require.cache[STUB_PATH] = {
  exports: {
    Service: class { constructor(name, model, options) { this.options = options ?? {}; } async init() {} },
    log: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  },
  loaded: true,
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function(request, ...rest) {
  if (request === '@sap/cds') return STUB_PATH;
  return origResolve.call(this, request, ...rest);
};

const LLMService = require('../lib/LLMService');
const { responseCache, cosine } = require('../lib/middleware/responseCache');

class Stub extends LLMService {
  async init() { await super.init(); this.calls = 0; }
  async _chat(params) {
    this.calls++;
    // Encode the input into the answer so the test can tell which upstream
    // call it was served from (in the non-cached path).
    const text = `answer[${this.calls}]`;
    return { text, model: params.model, usage: { input_tokens: 5, output_tokens: 5 }, stopReason: 'end_turn' };
  }
}

function makeSvc() { return new Stub('llm', null, { modelId: 'claude-opus-4-7', maxTokens: 100 }); }

// A tiny hand-rolled embedder — deterministic + easy to reason about.
// For each phrase it hashes a small set of tokens into a fixed-length
// vector so semantically similar phrases share components. Not
// linguistically real; enough to prove threshold behavior.
function makeToyEmbedder(dim = 32) {
  return async (text) => {
    const vec = new Array(dim).fill(0);
    const tokens = String(text).toLowerCase().match(/[a-z]+/g) || [];
    for (const t of tokens) {
      let h = 0;
      for (const c of t) h = ((h << 5) - h + c.charCodeAt(0)) | 0;
      const i = Math.abs(h) % dim;
      vec[i] += 1;
    }
    // Normalize so cosine is stable
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map((v) => v / norm);
  };
}

// ---- cosine --------------------------------------------------------

test('cosine: identical vectors → 1.0', () => {
  assert.ok(Math.abs(cosine([1, 0, 0], [1, 0, 0]) - 1.0) < 1e-9);
});
test('cosine: orthogonal → 0.0', () => {
  assert.ok(Math.abs(cosine([1, 0, 0], [0, 1, 0]) - 0.0) < 1e-9);
});
test('cosine: opposite → -1.0', () => {
  assert.ok(Math.abs(cosine([1, 0, 0], [-1, 0, 0]) + 1.0) < 1e-9);
});
test('cosine: zero-length vectors → 0 (safe)', () => {
  assert.equal(cosine([0, 0, 0], [0, 0, 0]), 0);
});

// ---- Validation ----------------------------------------------------

test('responseCache.semantic: rejects non-function embedder', () => {
  assert.throws(() => responseCache({ semantic: { embedder: 'nope' } }), /embedder/);
});
test('responseCache.semantic: rejects bogus threshold', () => {
  assert.throws(() => responseCache({ semantic: { embedder: async () => [1], threshold: 0 } }),   /threshold/);
  assert.throws(() => responseCache({ semantic: { embedder: async () => [1], threshold: 1.5 } }), /threshold/);
});
test('responseCache.semantic: rejects non-positive maxScan', () => {
  assert.throws(() => responseCache({ semantic: { embedder: async () => [1], maxScan: 0 } }),  /maxScan/);
  assert.throws(() => responseCache({ semantic: { embedder: async () => [1], maxScan: -1 } }), /maxScan/);
});

// ---- Semantic hit path --------------------------------------------

test('semantic: near-identical phrasing → semantic hit; upstream called once', async () => {
  const svc = makeSvc(); await svc.init();
  const cache = responseCache({
    semantic: { embedder: makeToyEmbedder(), threshold: 0.6 },
  });
  svc.use(cache);
  const first = await svc.chat({
    messages: [{ role: 'user', content: 'summarize the quarterly financial report' }],
  });
  // Different wording but overlapping tokens → high cosine
  const second = await svc.chat({
    messages: [{ role: 'user', content: 'please summarize the quarterly financial report now' }],
  });
  assert.equal(svc.calls, 1, 'semantic hit should NOT invoke upstream');
  assert.equal(second.text, first.text);
  assert.equal(second.cached, true);
  assert.equal(second.semantic, true);
  assert.ok(second.similarity >= 0.6);
  assert.ok(typeof second.semanticMatchKey === 'string');
  assert.equal(cache.stats.semanticHits, 1);
});

test('semantic: unrelated queries → miss; upstream called twice', async () => {
  const svc = makeSvc(); await svc.init();
  const cache = responseCache({
    // Tighter threshold here so the second (unrelated) query definitely misses
    semantic: { embedder: makeToyEmbedder(), threshold: 0.6 },
  });
  svc.use(cache);
  await svc.chat({ messages: [{ role: 'user', content: 'summarize the quarterly financial report' }] });
  await svc.chat({ messages: [{ role: 'user', content: 'reboot the mars rover software update' }] });
  assert.equal(svc.calls, 2, 'unrelated queries should each hit upstream');
  // First call: cold index → no semantic miss counted
  // Second call: index has 1 candidate, cosine ~0.2 < 0.6 → semanticMisses++
  assert.equal(cache.stats.semanticMisses, 1);
});

test('semantic: threshold too strict → miss even on very similar phrasing', async () => {
  const svc = makeSvc(); await svc.init();
  const cache = responseCache({
    semantic: { embedder: makeToyEmbedder(), threshold: 0.999 },
  });
  svc.use(cache);
  await svc.chat({ messages: [{ role: 'user', content: 'summarize the quarterly financial report' }] });
  await svc.chat({ messages: [{ role: 'user', content: 'please summarize the quarterly financial report now' }] });
  assert.equal(svc.calls, 2);
  assert.equal(cache.stats.semanticHits, 0);
});

// ---- Exact hit takes precedence over semantic ---------------------

test('semantic: identical request still uses the exact fast path (no embed cost)', async () => {
  const svc = makeSvc(); await svc.init();
  let embedCalls = 0;
  const cache = responseCache({
    semantic: {
      embedder: async (t) => { embedCalls++; return (await makeToyEmbedder()(t)); },
      threshold: 0.6,
    },
  });
  svc.use(cache);
  const q = 'please repeat back the exact test question phrase';
  await svc.chat({ messages: [{ role: 'user', content: q }] });
  // Same request → exact hit; embedder must NOT run
  await svc.chat({ messages: [{ role: 'user', content: q }] });
  assert.equal(svc.calls, 1);
  assert.equal(cache.stats.hits, 1, 'exact hit');
  assert.equal(cache.stats.semanticHits, 0);
  assert.equal(embedCalls, 1, 'embedder ran once (on the initial miss) — not on the exact-match repeat');
});

// ---- Eligibility filters ------------------------------------------

test('semantic: skipped when request has tools', async () => {
  const svc = makeSvc(); await svc.init();
  let embedCalls = 0;
  const cache = responseCache({
    semantic: {
      embedder: async (t) => { embedCalls++; return (await makeToyEmbedder()(t)); },
      threshold: 0.5,
    },
  });
  svc.use(cache);
  const tool = { name: 't', description: 'x', input_schema: { type: 'object', properties: {} }, run: async () => 'ok' };
  await svc.chat({ tools: [tool], messages: [{ role: 'user', content: 'tool-using query' }] });
  await svc.chat({ tools: [tool], messages: [{ role: 'user', content: 'tool-using query slightly reworded' }] });
  assert.equal(embedCalls, 0, 'semantic path should be skipped for tool requests');
});

test('semantic: skipped when text below minTextLength', async () => {
  const svc = makeSvc(); await svc.init();
  let embedCalls = 0;
  const cache = responseCache({
    semantic: {
      embedder: async (t) => { embedCalls++; return (await makeToyEmbedder()(t)); },
      threshold: 0.5,
      minTextLength: 30,
    },
  });
  svc.use(cache);
  await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });     // < 30 chars
  await svc.chat({ messages: [{ role: 'user', content: 'hello' }] });  // < 30 chars
  assert.equal(embedCalls, 0);
});

test('semantic: skipped when cache: false opt-out is set', async () => {
  const svc = makeSvc(); await svc.init();
  let embedCalls = 0;
  const cache = responseCache({
    semantic: {
      embedder: async (t) => { embedCalls++; return (await makeToyEmbedder()(t)); },
      threshold: 0.85,
    },
  });
  svc.use(cache);
  await svc.chat({ messages: [{ role: 'user', content: 'summarize the quarterly report' }] });
  await svc.chat({ cache: false, messages: [{ role: 'user', content: 'summarize the quarterly report' }] });
  assert.equal(embedCalls, 1, 'second call opted out — embedder must not run');
});

// ---- Embedder failure is non-fatal ---------------------------------

test('semantic: embedder failure → fall through to live call (counted)', async () => {
  const svc = makeSvc(); await svc.init();
  const cache = responseCache({
    semantic: {
      embedder: async () => { throw new Error('rate limit'); },
      threshold: 0.85,
    },
  });
  svc.use(cache);
  const res = await svc.chat({ messages: [{ role: 'user', content: 'summarize the quarterly financial report' }] });
  assert.equal(res.text, 'answer[1]', 'live call still succeeds');
  assert.equal(cache.stats.embedderErrors, 1);
});

// ---- Stats + snapshot -----------------------------------------------

test('semantic: hitRate counts both exact and semantic hits', async () => {
  const svc = makeSvc(); await svc.init();
  const cache = responseCache({
    semantic: { embedder: makeToyEmbedder(), threshold: 0.6 },
  });
  svc.use(cache);
  await svc.chat({ messages: [{ role: 'user', content: 'summarize the quarterly financial report' }] });          // miss
  await svc.chat({ messages: [{ role: 'user', content: 'summarize the quarterly financial report' }] });          // exact hit
  await svc.chat({ messages: [{ role: 'user', content: 'please summarize the quarterly financial report now' }] });// semantic hit
  await svc.chat({ messages: [{ role: 'user', content: 'reboot the mars rover software update' }] });             // miss
  const r = cache.hitRate();
  // total = misses (2) + hits (1) + semanticHits (1) = 4 → 2/4 = 0.5
  assert.ok(Math.abs(r - 0.5) < 1e-9, `expected 0.5, got ${r}`);
});

test('semantic: asMcpResource surfaces the semantic counters', async () => {
  const svc = makeSvc(); await svc.init();
  const cache = responseCache({
    semantic: { embedder: makeToyEmbedder(), threshold: 0.6 },
  });
  svc.use(cache);
  await svc.chat({ messages: [{ role: 'user', content: 'summarize the quarterly financial report' }] });
  await svc.chat({ messages: [{ role: 'user', content: 'please summarize the quarterly financial report now' }] });
  const p = cache.asMcpResource().handler();
  assert.equal(p.semanticHits, 1);
  assert.equal(p.semanticIndexSize, 1);
  assert.ok('embedderErrors' in p);
});

// ---- Index bounds --------------------------------------------------

test('semantic: index respects maxScan cap (oldest evicted)', async () => {
  const svc = makeSvc(); await svc.init();
  const cache = responseCache({
    semantic: { embedder: makeToyEmbedder(), threshold: 0.85, maxScan: 3 },
  });
  svc.use(cache);
  await svc.chat({ messages: [{ role: 'user', content: 'first distinct query about widgets and gadgets' }] });
  await svc.chat({ messages: [{ role: 'user', content: 'second unrelated question regarding planet mars exploration' }] });
  await svc.chat({ messages: [{ role: 'user', content: 'third topic covering kitchen recipes and cuisine' }] });
  await svc.chat({ messages: [{ role: 'user', content: 'fourth different subject about vintage automobile restoration' }] });
  assert.equal(cache.semanticIndex.size, 3, 'oldest entry should have been evicted');
});

test('semantic: clear() drops both the store and the semantic index', async () => {
  const svc = makeSvc(); await svc.init();
  const cache = responseCache({
    semantic: { embedder: makeToyEmbedder(), threshold: 0.6 },
  });
  svc.use(cache);
  await svc.chat({ messages: [{ role: 'user', content: 'summarize the quarterly financial report' }] });
  assert.ok(cache.semanticIndex.size > 0);
  await cache.clear();
  assert.equal(cache.semanticIndex.size, 0);
  assert.equal(cache.size(), 0);
});

// ---- Stale index pointer --------------------------------------------

test('semantic: stale index pointer (store evicted the value) → falls through cleanly', async () => {
  const svc = makeSvc(); await svc.init();
  const cache = responseCache({
    semantic: { embedder: makeToyEmbedder(), threshold: 0.6 },
  });
  svc.use(cache);
  await svc.chat({ messages: [{ role: 'user', content: 'summarize the quarterly financial report' }] });
  // Simulate store eviction — clear the store but leave the semantic index alone.
  await cache.store.clear();
  await svc.chat({ messages: [{ role: 'user', content: 'please summarize the quarterly financial report now' }] });
  // The stale pointer should have been removed, and the live call ran.
  assert.equal(svc.calls, 2);
  assert.equal(cache.semanticIndex.size, 1, 'stale entry pruned, new one added');
});
