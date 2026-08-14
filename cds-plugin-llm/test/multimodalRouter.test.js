const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_mm__';
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
  multimodalRouter,
  KNOWN_TYPES,
  defaultDetectAttachments,
  defaultApplyRoute,
  keyFor,
} = require('../lib/middleware/multimodalRouter');

// ---- Helpers ----------------------------------------------------------

function ctxWith(request) { return { request }; }
function userText(t)  { return { role: 'user', content: t }; }
function userBlocks(...blocks) { return { role: 'user', content: blocks }; }

const ROUTES = {
  'text':         { model: 'gpt-4o-mini' },
  'vision':       { model: 'gpt-4o' },
  'text+vision':  { model: 'gpt-4o' },
  'pdf':          { model: 'claude-opus' },
  'audio':        { model: 'whisper-1' },
  'pdf+vision':   { model: 'claude-opus-multi' },
};

// ---- KNOWN_TYPES ----------------------------------------------------

test('KNOWN_TYPES is frozen', () => {
  assert.ok(Object.isFrozen(KNOWN_TYPES));
  assert.deepEqual([...KNOWN_TYPES], ['text', 'vision', 'pdf', 'audio', 'video']);
});

// ---- keyFor --------------------------------------------------

test('keyFor: single type', () => {
  assert.equal(keyFor(new Set(['text'])), 'text');
});
test('keyFor: multi type sorted', () => {
  assert.equal(keyFor(new Set(['vision', 'pdf'])), 'pdf+vision');
});

// ---- defaultDetectAttachments -----------------------

test('defaultDetectAttachments: text prompt only', () => {
  const t = defaultDetectAttachments({ prompt: 'hi' });
  assert.deepEqual([...t].sort(), ['text']);
});

test('defaultDetectAttachments: string content messages → text', () => {
  const t = defaultDetectAttachments({ messages: [userText('hi')] });
  assert.deepEqual([...t].sort(), ['text']);
});

test('defaultDetectAttachments: image block → vision', () => {
  const t = defaultDetectAttachments({ messages: [
    userBlocks({ type: 'text', text: 'what is this?' }, { type: 'image', source: {} }),
  ]});
  assert.ok(t.has('vision'));
});

test('defaultDetectAttachments: image_url block → vision', () => {
  const t = defaultDetectAttachments({ messages: [
    userBlocks({ type: 'image_url', image_url: 'https://...' }),
  ]});
  assert.ok(t.has('vision'));
});

test('defaultDetectAttachments: pdf via document + mimeType → pdf', () => {
  const t = defaultDetectAttachments({ messages: [
    userBlocks({ type: 'document', mimeType: 'application/pdf' }),
  ]});
  assert.ok(t.has('pdf'));
});

test('defaultDetectAttachments: pdf via type: pdf → pdf', () => {
  const t = defaultDetectAttachments({ messages: [
    userBlocks({ type: 'pdf', source: {} }),
  ]});
  assert.ok(t.has('pdf'));
});

test('defaultDetectAttachments: audio block → audio', () => {
  const t = defaultDetectAttachments({ messages: [
    userBlocks({ type: 'audio', data: '...' }),
  ]});
  assert.ok(t.has('audio'));
});

test('defaultDetectAttachments: video block → video', () => {
  const t = defaultDetectAttachments({ messages: [
    userBlocks({ type: 'video', src: '...' }),
  ]});
  assert.ok(t.has('video'));
});

test('defaultDetectAttachments: combined vision + pdf', () => {
  const t = defaultDetectAttachments({ messages: [
    userBlocks(
      { type: 'text', text: 'ok' },
      { type: 'image', source: {} },
      { type: 'document', mimeType: 'application/pdf' },
    ),
  ]});
  assert.deepEqual([...t].sort(), ['pdf', 'text', 'vision']);
});

test('defaultDetectAttachments: image mime under document → vision', () => {
  const t = defaultDetectAttachments({ messages: [
    userBlocks({ type: 'document', mimeType: 'image/png' }),
  ]});
  assert.ok(t.has('vision'));
});

test('defaultDetectAttachments: null request → text only', () => {
  const t = defaultDetectAttachments(null);
  assert.deepEqual([...t], ['text']);
});

// ---- defaultApplyRoute ----------------------------

test('defaultApplyRoute: overrides model/system/temperature/maxTokens', () => {
  const r = defaultApplyRoute({ prompt: 'x' }, {
    model: 'M', system: 'S', temperature: 0.5, maxTokens: 100,
  });
  assert.equal(r.model, 'M');
  assert.equal(r.system, 'S');
  assert.equal(r.temperature, 0.5);
  assert.equal(r.maxTokens, 100);
  assert.equal(r.prompt, 'x');
});

// ---- Validation ------------------------------

test('multimodalRouter: throws on missing routes', () => {
  assert.throws(() => multimodalRouter({}), /routes/);
});
test('multimodalRouter: throws on empty routes', () => {
  assert.throws(() => multimodalRouter({ routes: {} }), /at least one/);
});
test('multimodalRouter: throws on non-object route entry', () => {
  assert.throws(() => multimodalRouter({ routes: { text: 'bad' } }), /must be an object/);
});
test('multimodalRouter: throws on unsorted route key', () => {
  assert.throws(() => multimodalRouter({
    routes: { 'vision+pdf': { model: 'x' }, text: { model: 't' } },
    fallbackKey: 'text',
  }), /must be sorted/);
});
test('multimodalRouter: throws on missing fallbackKey', () => {
  assert.throws(() => multimodalRouter({
    routes: { text: { model: 't' } },
    fallbackKey: 'nope',
  }), /fallbackKey/);
});
test('multimodalRouter: throws on non-function callback', () => {
  assert.throws(() => multimodalRouter({
    routes: { text: { model: 't' } },
    fallbackKey: 'text',
    onRoute: 'x',
  }), /callbacks/);
});

// ---- Basic routing --------------------

test('multimodalRouter: text prompt → text route', async () => {
  const mw = multimodalRouter({ routes: ROUTES, fallbackKey: 'text' });
  const ctx = ctxWith({ messages: [userText('hi')] });
  let seenModel;
  await mw(ctx, async () => { seenModel = ctx.request.model; return {}; });
  assert.equal(seenModel, 'gpt-4o-mini');
  assert.equal(mw.stats.lastKey, 'text');
});

test('multimodalRouter: image + text block → text+vision route', async () => {
  const mw = multimodalRouter({ routes: ROUTES, fallbackKey: 'text' });
  const ctx = ctxWith({ messages: [
    userBlocks({ type: 'text', text: 'what is this?' }, { type: 'image', source: {} }),
  ]});
  let seenModel;
  await mw(ctx, async () => { seenModel = ctx.request.model; return {}; });
  assert.equal(seenModel, 'gpt-4o');
  assert.equal(mw.stats.lastKey, 'text+vision');
});

test('multimodalRouter: exact match vision-only', async () => {
  const routesNoText = {
    'text':   { model: 'gpt-4o-mini' },
    'vision': { model: 'gpt-4o' },
  };
  const mw = multimodalRouter({ routes: routesNoText, fallbackKey: 'text' });
  const ctx = ctxWith({ messages: [
    userBlocks({ type: 'image', source: {} }),   // no text block
  ]});
  let seenModel;
  await mw(ctx, async () => { seenModel = ctx.request.model; return {}; });
  // No text block → detected = {vision}. Sorted key: 'vision'. Exact match.
  assert.equal(seenModel, 'gpt-4o');
  assert.equal(mw.stats.routedByKey.vision, 1);
});

test('multimodalRouter: combined pdf+vision routes to combined key', async () => {
  const mw = multimodalRouter({ routes: ROUTES, fallbackKey: 'text' });
  const ctx = ctxWith({ messages: [
    userBlocks({ type: 'image', source: {} }, { type: 'pdf', source: {} }),
  ]});
  let seenModel;
  await mw(ctx, async () => { seenModel = ctx.request.model; return {}; });
  // Detected: {vision, pdf} → key 'pdf+vision' → exact match.
  assert.equal(seenModel, 'claude-opus-multi');
});

test('multimodalRouter: audio → audio route', async () => {
  const mw = multimodalRouter({ routes: ROUTES, fallbackKey: 'text' });
  const ctx = ctxWith({ messages: [
    userBlocks({ type: 'audio', data: 'base64...' }),
  ]});
  let seenModel;
  await mw(ctx, async () => { seenModel = ctx.request.model; return {}; });
  assert.equal(seenModel, 'whisper-1');
});

// ---- Fallback -------------------------

test('multimodalRouter: unknown combo → falls back', async () => {
  const mw = multimodalRouter({ routes: ROUTES, fallbackKey: 'text' });
  const ctx = ctxWith({ messages: [
    userBlocks({ type: 'video', src: 'x' }),
  ]});
  let seenModel;
  await mw(ctx, async () => { seenModel = ctx.request.model; return {}; });
  // Detected: {video} → no route → fallback to text.
  assert.equal(seenModel, 'gpt-4o-mini');
  assert.equal(mw.stats.fallbacks, 1);
});

test('multimodalRouter: onFallback fires with detected key', async () => {
  const events = [];
  const mw = multimodalRouter({
    routes: ROUTES, fallbackKey: 'text',
    onFallback: (i) => events.push(i),
  });
  await mw(ctxWith({ messages: [userBlocks({ type: 'video', src: 'x' })] }), async () => ({}));
  assert.equal(events.length, 1);
  assert.equal(events[0].detectedKey, 'video');
  assert.equal(events[0].fallbackKey, 'text');
});

// ---- Original request restored --------

test('multimodalRouter: restores ctx.request after call', async () => {
  const mw = multimodalRouter({ routes: ROUTES, fallbackKey: 'text' });
  const ctx = ctxWith({ messages: [userText('hi')] });
  const original = ctx.request;
  await mw(ctx, async () => ({}));
  assert.equal(ctx.request, original);
});

// ---- Detection error → passthrough ---

test('multimodalRouter: detectAttachments throws → passthrough', async () => {
  const errors = [];
  const mw = multimodalRouter({
    routes: ROUTES, fallbackKey: 'text',
    detectAttachments: () => { throw new Error('bad'); },
    onError: (i) => errors.push(i),
  });
  const ctx = ctxWith({ messages: [userText('hi')] });
  const original = ctx.request;
  await mw(ctx, async () => ({}));
  assert.equal(mw.stats.detectErrors, 1);
  assert.equal(errors[0].phase, 'detectAttachments');
  assert.equal(ctx.request, original);   // unmodified
});

test('multimodalRouter: detectAttachments returns non-Set → passthrough', async () => {
  const errors = [];
  const mw = multimodalRouter({
    routes: ROUTES, fallbackKey: 'text',
    detectAttachments: () => ['text'],
    onError: (i) => errors.push(i),
  });
  await mw(ctxWith({ messages: [userText('hi')] }), async () => ({}));
  assert.equal(mw.stats.detectErrors, 1);
});

// ---- Callbacks ------------------

test('multimodalRouter: onRoute fires with detection info', async () => {
  const events = [];
  const mw = multimodalRouter({
    routes: ROUTES, fallbackKey: 'text',
    onRoute: (i) => events.push(i),
  });
  await mw(ctxWith({ messages: [userText('hi')] }), async () => ({}));
  assert.equal(events.length, 1);
  assert.equal(events[0].key, 'text');
  assert.deepEqual(events[0].detectedTypes.sort(), ['text']);
  assert.equal(events[0].usedFallback, false);
});

test('multimodalRouter: callback throws swallowed', async () => {
  const mw = multimodalRouter({
    routes: ROUTES, fallbackKey: 'text',
    onRoute: () => { throw new Error('x'); },
  });
  await mw(ctxWith({ messages: [userText('hi')] }), async () => ({}));
});

// ---- Custom applyRoute + detectAttachments -----

test('multimodalRouter: custom applyRoute is called', async () => {
  const mw = multimodalRouter({
    routes: ROUTES, fallbackKey: 'text',
    applyRoute: (req, r) => ({ ...req, __tag: r.model }),
  });
  const ctx = ctxWith({ messages: [userText('hi')] });
  let seenTag;
  await mw(ctx, async () => { seenTag = ctx.request.__tag; return {}; });
  assert.equal(seenTag, 'gpt-4o-mini');
});

test('multimodalRouter: custom detectAttachments overrides default', async () => {
  const mw = multimodalRouter({
    routes: ROUTES, fallbackKey: 'text',
    detectAttachments: () => new Set(['audio']),
  });
  const ctx = ctxWith({ messages: [userText('hi')] });   // would detect text
  let seenModel;
  await mw(ctx, async () => { seenModel = ctx.request.model; return {}; });
  assert.equal(seenModel, 'whisper-1');
});

// ---- Stats + MCP + reset ---------

test('multimodalRouter: routeDistribution', async () => {
  const mw = multimodalRouter({ routes: ROUTES, fallbackKey: 'text' });
  await mw(ctxWith({ messages: [userText('a')] }), async () => ({}));
  await mw(ctxWith({ messages: [userText('b')] }), async () => ({}));
  await mw(ctxWith({ messages: [userBlocks({ type: 'image', source: {} })] }), async () => ({}));
  const dist = mw.routeDistribution();
  // 3 total: 2 fallbacks (text+vision → text), 1 image-only → vision.
  // Wait — image-only test wraps in userBlocks with just one image block, no text.
  // detected = {vision}, key = 'vision', exact match.
  // First two: userText('a') → messages has string content → detected = {text}, key 'text', exact match.
  // Third: userBlocks(image) → messages has array content with only image → detected = {vision}, exact match.
  assert.equal(dist.text, 2/3);
  assert.equal(dist.vision, 1/3);
});

test('multimodalRouter: listRouteKeys', () => {
  const mw = multimodalRouter({ routes: ROUTES, fallbackKey: 'text' });
  assert.deepEqual(mw.listRouteKeys().sort(), ['audio', 'pdf', 'pdf+vision', 'text', 'text+vision', 'vision']);
});

test('multimodalRouter: reset clears counters', async () => {
  const mw = multimodalRouter({ routes: ROUTES, fallbackKey: 'text' });
  await mw(ctxWith({ messages: [userText('a')] }), async () => ({}));
  mw.reset();
  assert.equal(mw.stats.totalCalls, 0);
});

test('multimodalRouter: asMcpResource', () => {
  const mw = multimodalRouter({ routes: ROUTES, fallbackKey: 'text' });
  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://multimodal-router');
  const p = r.handler();
  assert.equal(p.fallbackKey, 'text');
  assert.equal(p.routes.text.model, 'gpt-4o-mini');
  assert.equal(p.routes['pdf+vision'].model, 'claude-opus-multi');
});
