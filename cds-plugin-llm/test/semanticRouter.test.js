const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_sr__';
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
  semanticRouter,
  averageVectors,
  defaultExtractKey,
  defaultApplyRoute,
} = require('../lib/middleware/semanticRouter');

// ---- Helpers -----------------------------------------------------------

function ctxWith(prompt) { return { request: { prompt } }; }

// Fake embedder: hardcoded 3-D vectors keyed by first-word intent
// (deterministic, easy to reason about, no dependencies).
const VECS = {
  'code:':        [1, 0, 0],
  'procurement:': [0, 1, 0],
  'chit-chat:':   [0, 0, 1],
};
async function fakeEmbedder(text) {
  for (const [prefix, vec] of Object.entries(VECS)) {
    if (text.startsWith(prefix)) return vec;
  }
  // Off-manifold texts get a mixed vector far from any centroid.
  return [0.3, 0.3, 0.3];
}

function makeRoutes() {
  return [
    {
      name:     'code',
      model:    'anthropic/code',
      system:   'You are an expert engineer.',
      examples: ['code: write a python func', 'code: debug this', 'code: refactor'],
    },
    {
      name:     'procurement',
      model:    'openai/gpt-4o',
      system:   'You are a procurement analyst.',
      examples: ['procurement: analyze this quote', 'procurement: draft PO'],
    },
    {
      name:     'chit-chat',
      model:    'openai/gpt-4o-mini',
      temperature: 0.9,
      examples: ['chit-chat: hi', 'chit-chat: how are you'],
    },
  ];
}

// ---- averageVectors ---------------------------------------------------

test('averageVectors: single vector → itself', () => {
  assert.deepEqual(averageVectors([[1, 2, 3]]), [1, 2, 3]);
});
test('averageVectors: multiple → element-wise mean', () => {
  assert.deepEqual(averageVectors([[1, 0, 0], [0, 1, 0]]), [0.5, 0.5, 0]);
});
test('averageVectors: empty → null', () => {
  assert.equal(averageVectors([]), null);
});
test('averageVectors: skips mismatched dims', () => {
  const r = averageVectors([[1, 0, 0], [1, 1]]);   // mismatched skipped
  assert.deepEqual(r, [0.5, 0, 0]);
});

// ---- defaultExtractKey -----------------------------------------------

test('defaultExtractKey: prompt', () => {
  assert.equal(defaultExtractKey(ctxWith('hi')), 'hi');
});
test('defaultExtractKey: latest user message from messages[]', () => {
  const ctx = { request: { messages: [
    { role: 'system', content: 'you are helpful' },
    { role: 'user',   content: 'first' },
    { role: 'assistant', content: 'ok' },
    { role: 'user',   content: 'second' },
  ]}};
  assert.equal(defaultExtractKey(ctx), 'second');
});
test('defaultExtractKey: nothing → null', () => {
  assert.equal(defaultExtractKey({ request: {} }), null);
});

// ---- defaultApplyRoute ----------------------------------------------

test('defaultApplyRoute: overrides model + system + temperature', () => {
  const out = defaultApplyRoute({ prompt: 'x' }, {
    name: 'r', model: 'M', system: 'SYS', temperature: 0.5, maxTokens: 100,
  });
  assert.equal(out.model, 'M');
  assert.equal(out.system, 'SYS');
  assert.equal(out.temperature, 0.5);
  assert.equal(out.maxTokens, 100);
  assert.equal(out.prompt, 'x');
});
test('defaultApplyRoute: skips undefined fields', () => {
  const out = defaultApplyRoute({ prompt: 'x', model: 'orig' }, { name: 'r' });
  assert.equal(out.model, 'orig');   // unchanged
});

// ---- Validation ------------------------------------------------------

test('semanticRouter: throws on empty routes', () => {
  assert.throws(() => semanticRouter({ routes: [], embedder: fakeEmbedder }), /non-empty/);
});
test('semanticRouter: throws on route without name', () => {
  assert.throws(() => semanticRouter({ routes: [{ examples: ['x'] }], embedder: fakeEmbedder }), /name: string/);
});
test('semanticRouter: throws on route without examples or centroid', () => {
  assert.throws(() => semanticRouter({ routes: [{ name: 'x' }], embedder: fakeEmbedder }), /examples/);
});
test('semanticRouter: throws on non-numeric centroid', () => {
  assert.throws(() => semanticRouter({ routes: [{ name: 'x', centroid: 'bad' }], embedder: fakeEmbedder }), /centroid/);
});
test('semanticRouter: throws without embedder', () => {
  assert.throws(() => semanticRouter({ routes: makeRoutes() }), /embedder/);
});
test('semanticRouter: throws on threshold out of range', () => {
  assert.throws(() => semanticRouter({ routes: makeRoutes(), embedder: fakeEmbedder, threshold: 0 }), /threshold/);
  assert.throws(() => semanticRouter({ routes: makeRoutes(), embedder: fakeEmbedder, threshold: 1.5 }), /threshold/);
});
test('semanticRouter: throws when defaultRoute not in routes', () => {
  assert.throws(() => semanticRouter({
    routes: makeRoutes(), embedder: fakeEmbedder, defaultRoute: 'nonexistent',
  }), /not found/);
});
test('semanticRouter: throws on non-function callback', () => {
  assert.throws(() => semanticRouter({
    routes: makeRoutes(), embedder: fakeEmbedder, onRoute: 'x',
  }), /callbacks/);
});

// ---- Routing correctness --------------------------------------

test('semanticRouter: code query routes to code model', async () => {
  const mw = semanticRouter({
    routes: makeRoutes(), embedder: fakeEmbedder,
    threshold: 0.5,
  });
  const ctx = ctxWith('code: fix this bug');
  let seenModel;
  await mw(ctx, async () => { seenModel = ctx.request.model; return { text: 'ok' }; });
  assert.equal(seenModel, 'anthropic/code');
  assert.equal(mw.stats.lastRoute, 'code');
});

test('semanticRouter: procurement query routes to procurement model', async () => {
  const mw = semanticRouter({
    routes: makeRoutes(), embedder: fakeEmbedder,
    threshold: 0.5,
  });
  const ctx = ctxWith('procurement: approve this vendor');
  let seenModel, seenSystem;
  await mw(ctx, async () => {
    seenModel  = ctx.request.model;
    seenSystem = ctx.request.system;
    return { text: 'ok' };
  });
  assert.equal(seenModel, 'openai/gpt-4o');
  assert.equal(seenSystem, 'You are a procurement analyst.');
});

test('semanticRouter: chit-chat query routes to chit-chat model + temperature', async () => {
  const mw = semanticRouter({
    routes: makeRoutes(), embedder: fakeEmbedder,
    threshold: 0.5,
  });
  const ctx = ctxWith('chit-chat: how are you');
  let seenTemp;
  await mw(ctx, async () => { seenTemp = ctx.request.temperature; return { text: 'ok' }; });
  assert.equal(seenTemp, 0.9);
});

// ---- Below-threshold behavior ----------------------------

test('semanticRouter: below threshold + defaultRoute → fallback', async () => {
  const mw = semanticRouter({
    routes: makeRoutes(), embedder: fakeEmbedder,
    threshold: 0.99,
    defaultRoute: 'chit-chat',
  });
  const ctx = ctxWith('something totally off-manifold');
  let seenModel;
  await mw(ctx, async () => { seenModel = ctx.request.model; return 'ok'; });
  assert.equal(seenModel, 'openai/gpt-4o-mini');
  assert.equal(mw.stats.fallbacks, 1);
  assert.equal(mw.stats.lastRoute, 'chit-chat');
});

test('semanticRouter: below threshold + no defaultRoute → passthrough', async () => {
  const mw = semanticRouter({
    routes: makeRoutes(), embedder: fakeEmbedder,
    threshold: 0.99,
  });
  const ctx = ctxWith('off-manifold');
  const original = ctx.request;
  await mw(ctx, async () => 'ok');
  assert.equal(mw.stats.passthroughs, 1);
  assert.equal(ctx.request, original);
});

// ---- Restoration -------------------------------------------

test('semanticRouter: restores ctx.request after call', async () => {
  const mw = semanticRouter({
    routes: makeRoutes(), embedder: fakeEmbedder,
    threshold: 0.5,
  });
  const ctx = ctxWith('code: write foo');
  const original = ctx.request;
  await mw(ctx, async () => 'ok');
  assert.equal(ctx.request, original);
});

// ---- Precomputed centroids --------------------------------

test('semanticRouter: precomputed centroid used verbatim', async () => {
  let embedderCallCount = 0;
  const countingEmbedder = async (t) => { embedderCallCount++; return fakeEmbedder(t); };
  const routes = [
    { name: 'code', model: 'M-code', centroid: [1, 0, 0] },
    { name: 'chit', model: 'M-chit', centroid: [0, 0, 1] },
  ];
  const mw = semanticRouter({
    routes, embedder: countingEmbedder, threshold: 0.5,
  });
  const ctx = ctxWith('code: x');
  let seenModel;
  await mw(ctx, async () => { seenModel = ctx.request.model; return 'ok'; });
  assert.equal(seenModel, 'M-code');
  // Only the query was embedded — no example embeddings.
  assert.equal(embedderCallCount, 1);
});

// ---- Lazy centroid + warmup ------------------------------

test('semanticRouter: centroid computed lazily on first call', async () => {
  let embedderCalls = 0;
  const counter = async (t) => { embedderCalls++; return fakeEmbedder(t); };
  const mw = semanticRouter({
    routes: makeRoutes(), embedder: counter, threshold: 0.5,
  });
  // No embedder calls yet.
  assert.equal(embedderCalls, 0);
  await mw(ctxWith('code: write foo'), async () => 'ok');
  // 1 query + all example vectors embedded once.
  assert.ok(embedderCalls > 1);
  const afterFirst = embedderCalls;
  // Second call — only 1 more (the new query); centroids are cached.
  await mw(ctxWith('code: fix bar'), async () => 'ok');
  assert.equal(embedderCalls, afterFirst + 1);
});

test('semanticRouter: warmup precomputes all centroids', async () => {
  let embedderCalls = 0;
  const counter = async (t) => { embedderCalls++; return fakeEmbedder(t); };
  const mw = semanticRouter({
    routes: makeRoutes(), embedder: counter, threshold: 0.5,
  });
  await mw.warmup();
  const warmed = embedderCalls;
  assert.ok(warmed > 0);
  await mw(ctxWith('code: foo'), async () => 'ok');
  // Only 1 additional call (query), examples were pre-embedded.
  assert.equal(embedderCalls, warmed + 1);
});

// ---- Fail-safe behavior ------------------------------

test('semanticRouter: embedder throws → passthrough, no crash', async () => {
  const errors = [];
  const mw = semanticRouter({
    routes: makeRoutes(),
    embedder: async () => { throw new Error('embed-fail'); },
    onError: (i) => errors.push(i),
  });
  let ran = false;
  await mw(ctxWith('anything'), async () => { ran = true; return 'ok'; });
  assert.equal(ran, true);
  assert.equal(mw.stats.embedderErrors, 1);
  assert.equal(errors[0].phase, 'embedder');
});

test('semanticRouter: embedder returns non-array → passthrough', async () => {
  const mw = semanticRouter({
    routes: makeRoutes(),
    embedder: async () => null,
  });
  let ran = false;
  await mw(ctxWith('anything'), async () => { ran = true; return 'ok'; });
  assert.equal(ran, true);
  assert.equal(mw.stats.passthroughs, 1);
});

test('semanticRouter: extractKey returns null → passthrough', async () => {
  const mw = semanticRouter({
    routes: makeRoutes(), embedder: fakeEmbedder,
    extractKey: () => null,
  });
  let ran = false;
  await mw(ctxWith('x'), async () => { ran = true; return 'ok'; });
  assert.equal(ran, true);
  assert.equal(mw.stats.passthroughs, 1);
});

// ---- Callbacks -----------------------------------------

test('semanticRouter: onRoute fires with route + score', async () => {
  const events = [];
  const mw = semanticRouter({
    routes: makeRoutes(), embedder: fakeEmbedder,
    threshold: 0.5,
    onRoute: (i) => events.push(i),
  });
  await mw(ctxWith('code: x'), async () => 'ok');
  assert.equal(events.length, 1);
  assert.equal(events[0].route, 'code');
  assert.equal(events[0].belowThreshold, false);
  assert.ok(typeof events[0].score === 'number');
});

test('semanticRouter: onFallback fires with best-but-below info', async () => {
  const events = [];
  const mw = semanticRouter({
    routes: makeRoutes(), embedder: fakeEmbedder,
    threshold: 0.99,
    defaultRoute: 'chit-chat',
    onFallback: (i) => events.push(i),
  });
  await mw(ctxWith('off-manifold'), async () => 'ok');
  assert.equal(events.length, 1);
  assert.equal(events[0].defaultRoute, 'chit-chat');
});

test('semanticRouter: callback throws swallowed', async () => {
  const mw = semanticRouter({
    routes: makeRoutes(), embedder: fakeEmbedder,
    threshold: 0.5,
    onRoute: () => { throw new Error('x'); },
  });
  const r = await mw(ctxWith('code: x'), async () => 'ok');
  assert.equal(r, 'ok');
});

// ---- Custom applyRoute ------------------------------

test('semanticRouter: custom applyRoute is called', async () => {
  const mw = semanticRouter({
    routes: makeRoutes(), embedder: fakeEmbedder,
    threshold: 0.5,
    applyRoute: (req, route) => ({ ...req, tag: `routed:${route.name}` }),
  });
  const ctx = ctxWith('code: x');
  let seenTag;
  await mw(ctx, async () => { seenTag = ctx.request.tag; return 'ok'; });
  assert.equal(seenTag, 'routed:code');
});

// ---- Stats + MCP ------------------------------------

test('semanticRouter: routeDistribution reflects usage', async () => {
  const mw = semanticRouter({
    routes: makeRoutes(), embedder: fakeEmbedder,
    threshold: 0.5,
  });
  await mw(ctxWith('code: a'), async () => 'ok');
  await mw(ctxWith('code: b'), async () => 'ok');
  await mw(ctxWith('procurement: c'), async () => 'ok');
  const dist = mw.routeDistribution();
  assert.equal(dist.code, 2/3);
  assert.equal(dist.procurement, 1/3);
});

test('semanticRouter: reset clears counters', async () => {
  const mw = semanticRouter({
    routes: makeRoutes(), embedder: fakeEmbedder,
    threshold: 0.5,
  });
  await mw(ctxWith('code: x'), async () => 'ok');
  mw.reset();
  assert.equal(mw.stats.totalCalls, 0);
  assert.equal(mw.stats.routedByName.code, 0);
});

test('semanticRouter: asMcpResource', async () => {
  const mw = semanticRouter({
    routes: makeRoutes(), embedder: fakeEmbedder,
    threshold: 0.75, defaultRoute: 'chit-chat',
  });
  await mw.warmup();
  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://semantic-router');
  const p = r.handler();
  assert.equal(p.threshold, 0.75);
  assert.equal(p.defaultRoute, 'chit-chat');
  assert.equal(p.routes.length, 3);
  assert.equal(p.routes[0].name, 'code');
  assert.equal(p.routes[0].centroidReady, true);
});
