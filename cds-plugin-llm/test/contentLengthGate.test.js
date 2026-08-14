const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_clg__';
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
  contentLengthGate,
  ContentLengthExceededError,
  defaultTokenEstimator,
  defaultExtractText,
  OVERAGE_MODES,
} = require('../lib/middleware/contentLengthGate');

function ctxWith(request) { return { request }; }

// ---- Helpers exports ------------------

test('OVERAGE_MODES frozen', () => {
  assert.ok(Object.isFrozen(OVERAGE_MODES));
  assert.deepEqual([...OVERAGE_MODES], ['throw', 'truncate-oldest', 'log']);
});

test('defaultTokenEstimator: 4 chars ≈ 1 token', () => {
  assert.equal(defaultTokenEstimator('a'.repeat(40)), 10);
  assert.equal(defaultTokenEstimator(''), 0);
  assert.equal(defaultTokenEstimator(null), 0);
});

test('defaultExtractText: prompt', () => {
  const entries = defaultExtractText({ prompt: 'hi' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, 'hi');
});

test('defaultExtractText: system + messages[]', () => {
  const entries = defaultExtractText({
    system: 'sys',
    messages: [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ],
  });
  assert.equal(entries.length, 3);
});

test('defaultExtractText: text-content blocks extracted', () => {
  const entries = defaultExtractText({
    messages: [
      { role: 'user', content: [
        { type: 'text', text: 'hello' },
        { type: 'image', source: {} },
      ]},
    ],
  });
  // Only the text block counted.
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, 'hello');
});

// ---- Validation ---------------------

test('contentLengthGate: throws on non-object modelLimits', () => {
  assert.throws(() => contentLengthGate({ modelLimits: 'x' }), /modelLimits/);
});
test('contentLengthGate: throws on invalid limit value', () => {
  assert.throws(() => contentLengthGate({ modelLimits: { 'x': -1 } }), /modelLimits\.x/);
});
test('contentLengthGate: throws on non-function modelOf', () => {
  assert.throws(() => contentLengthGate({ modelOf: 'x' }), /modelOf/);
});
test('contentLengthGate: throws on non-function tokenEstimator', () => {
  assert.throws(() => contentLengthGate({ tokenEstimator: 'x' }), /tokenEstimator/);
});
test('contentLengthGate: throws on unknown overageMode', () => {
  assert.throws(() => contentLengthGate({ overageMode: 'bogus' }), /overageMode/);
});
test('contentLengthGate: throws on non-function callback', () => {
  assert.throws(() => contentLengthGate({ onOverage: 'x' }), /callbacks/);
});

// ---- Under limit passthrough --------------

test('contentLengthGate: under limit → passthrough', async () => {
  const mw = contentLengthGate({
    modelLimits: { default: 1000 },
  });
  const r = await mw(ctxWith({ prompt: 'hi', model: 'unknown' }), async () => ({ text: 'ok' }));
  assert.equal(r.text, 'ok');
  assert.equal(mw.stats.underLimit, 1);
  assert.equal(mw.stats.overageCount, 0);
});

test('contentLengthGate: unknown model + no default → passthrough', async () => {
  const mw = contentLengthGate({ modelLimits: { 'gpt-4o': 128_000 } });
  const r = await mw(ctxWith({ prompt: 'x', model: 'unknown' }), async () => 'ok');
  assert.equal(mw.stats.unknownModelCount, 1);
});

// ---- Overage: throw -----------------

test('contentLengthGate: overage with throw mode raises ContentLengthExceededError', async () => {
  const mw = contentLengthGate({
    modelLimits: { default: 10 },   // 10 tokens = 40 chars
    overageMode: 'throw',
  });
  const bigPrompt = 'x'.repeat(200);
  await assert.rejects(mw(ctxWith({ prompt: bigPrompt }), async () => 'ok'), ContentLengthExceededError);
  assert.equal(mw.stats.thrownCount, 1);
});

test('contentLengthGate: ContentLengthExceededError carries fields', async () => {
  const mw = contentLengthGate({
    modelLimits: { 'gpt-4o': 10 },
    overageMode: 'throw',
  });
  try {
    await mw(ctxWith({ model: 'gpt-4o', prompt: 'x'.repeat(200) }), async () => 'ok');
    assert.fail('should throw');
  } catch (err) {
    assert.equal(err.code, 'CONTENT_LENGTH_EXCEEDED');
    assert.equal(err.limitTokens, 10);
    assert.equal(err.model, 'gpt-4o');
    assert.ok(err.tokens > 10);
    assert.ok(err.chars >= 200);
  }
});

// ---- Overage: log --------------

test('contentLengthGate: overage with log mode passes through (provider decides)', async () => {
  const events = [];
  const mw = contentLengthGate({
    modelLimits: { default: 10 },
    overageMode: 'log',
    onOverage: (i) => events.push(i),
  });
  const r = await mw(ctxWith({ prompt: 'x'.repeat(200) }), async () => 'ok');
  assert.equal(r, 'ok');
  assert.equal(events.length, 1);
  assert.equal(events[0].mode, 'log');
  assert.equal(mw.stats.loggedCount, 1);
});

// ---- Overage: truncate-oldest ----------

test('contentLengthGate: truncate-oldest drops oldest messages until under limit', async () => {
  const mw = contentLengthGate({
    modelLimits: { default: 10 },   // 40 chars
    overageMode: 'truncate-oldest',
  });
  // Build 5 messages, each 30 chars.
  const messages = [
    { role: 'system', content: 'x'.repeat(30) },
    { role: 'user', content: 'x'.repeat(30) },
    { role: 'assistant', content: 'x'.repeat(30) },
    { role: 'user', content: 'x'.repeat(30) },
    { role: 'user', content: 'x'.repeat(30) },   // latest user
  ];
  const ctx = ctxWith({ messages });
  let seenLen;
  await mw(ctx, async () => { seenLen = ctx.request.messages.length; return 'ok'; });
  // Should preserve system (index 0) + latest user (index 4). Drop others.
  assert.ok(seenLen <= 5);
  assert.ok(seenLen >= 2);   // at least system + latest user
  assert.equal(mw.stats.truncatedCount, 1);
});

test('contentLengthGate: truncation preserves system message', async () => {
  const mw = contentLengthGate({
    modelLimits: { default: 15 },   // 60 chars
    overageMode: 'truncate-oldest',
  });
  const messages = [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'x'.repeat(100) },
    { role: 'assistant', content: 'x'.repeat(100) },
    { role: 'user', content: 'LATEST' },
  ];
  const ctx = ctxWith({ messages });
  let seen;
  await mw(ctx, async () => { seen = ctx.request.messages; return 'ok'; });
  const roles = seen.map((m) => m.role);
  assert.ok(roles.includes('system'));
  // The 'SYS' text should be present.
  assert.ok(seen.some((m) => m.content === 'SYS'));
});

test('contentLengthGate: truncation preserves latest user message', async () => {
  const mw = contentLengthGate({
    modelLimits: { default: 15 },
    overageMode: 'truncate-oldest',
  });
  const messages = [
    { role: 'user', content: 'FIRST' },
    { role: 'assistant', content: 'x'.repeat(100) },
    { role: 'user', content: 'x'.repeat(100) },
    { role: 'user', content: 'LATEST' },
  ];
  const ctx = ctxWith({ messages });
  let seen;
  await mw(ctx, async () => { seen = ctx.request.messages; return 'ok'; });
  assert.ok(seen.some((m) => m.content === 'LATEST' && m.role === 'user'));
});

test('contentLengthGate: preserveSystem=false → system may be dropped', async () => {
  const mw = contentLengthGate({
    modelLimits: { default: 8 },   // very tight, ~32 chars
    overageMode: 'truncate-oldest',
    preserveSystem: false,
  });
  const messages = [
    { role: 'system', content: 'x'.repeat(50) },
    { role: 'user', content: 'small' },
  ];
  const ctx = ctxWith({ messages });
  let seen;
  await mw(ctx, async () => { seen = ctx.request.messages; return 'ok'; });
  // System should be dropped since it's too big and not preserved.
  assert.ok(!seen.some((m) => m.role === 'system'));
});

test('contentLengthGate: restores original request after call', async () => {
  const mw = contentLengthGate({
    modelLimits: { default: 5 },
    overageMode: 'truncate-oldest',
  });
  const ctx = ctxWith({ messages: [
    { role: 'user', content: 'x'.repeat(100) },
    { role: 'user', content: 'LATEST' },
  ]});
  const original = ctx.request;
  await mw(ctx, async () => 'ok');
  assert.equal(ctx.request, original);
});

// ---- Per-model limits + fallback --------------

test('contentLengthGate: uses per-model limit', async () => {
  const mw = contentLengthGate({
    modelLimits: {
      'small-model': 10,
      'big-model':   1_000_000,
      default:       100,
    },
    overageMode: 'throw',
  });
  // 200 chars ≈ 50 tokens. Over small-model limit (10) but under big-model + default (100/1M).
  const prompt = 'x'.repeat(200);
  await assert.rejects(mw(ctxWith({ model: 'small-model', prompt }), async () => 'ok'), ContentLengthExceededError);
  await mw(ctxWith({ model: 'big-model', prompt }), async () => 'ok');
});

test('contentLengthGate: unknown model with default limit', async () => {
  const mw = contentLengthGate({
    modelLimits: { default: 5 },
    overageMode: 'throw',
  });
  await assert.rejects(mw(ctxWith({ model: 'unknown', prompt: 'x'.repeat(100) }), async () => 'ok'), ContentLengthExceededError);
});

// ---- Custom token estimator ------------

test('contentLengthGate: custom tokenEstimator used', async () => {
  const mw = contentLengthGate({
    modelLimits: { default: 100 },
    tokenEstimator: (text) => text.length,   // 1 char = 1 token
    overageMode: 'throw',
  });
  await assert.rejects(mw(ctxWith({ prompt: 'x'.repeat(200) }), async () => 'ok'), ContentLengthExceededError);
});

// ---- Custom extractText ----------

test('contentLengthGate: custom extractText overrides default', async () => {
  const mw = contentLengthGate({
    modelLimits: { default: 5 },
    extractText: (req) => [{ path: 'notes', text: req?.notes ?? '' }],
    overageMode: 'throw',
  });
  await assert.rejects(mw(ctxWith({ notes: 'x'.repeat(100) }), async () => 'ok'), ContentLengthExceededError);
});

// ---- Callbacks --------

test('contentLengthGate: onOverage fires with size info', async () => {
  const events = [];
  const mw = contentLengthGate({
    modelLimits: { default: 10 },
    overageMode: 'log',
    onOverage: (i) => events.push(i),
  });
  await mw(ctxWith({ prompt: 'x'.repeat(200) }), async () => 'ok');
  assert.equal(events.length, 1);
  assert.equal(events[0].limitTokens, 10);
  assert.ok(events[0].tokens > 10);
});

test('contentLengthGate: onTruncate fires with dropped count', async () => {
  const events = [];
  const mw = contentLengthGate({
    modelLimits: { default: 5 },
    overageMode: 'truncate-oldest',
    onTruncate: (i) => events.push(i),
  });
  await mw(ctxWith({ messages: [
    { role: 'user', content: 'x'.repeat(50) },
    { role: 'assistant', content: 'x'.repeat(50) },
    { role: 'user', content: 'LATEST' },
  ]}), async () => 'ok');
  assert.equal(events.length, 1);
  assert.ok(events[0].messagesDropped > 0);
});

test('contentLengthGate: callback throws swallowed', async () => {
  const mw = contentLengthGate({
    modelLimits: { default: 10 },
    overageMode: 'log',
    onOverage: () => { throw new Error('x'); },
  });
  await mw(ctxWith({ prompt: 'x'.repeat(200) }), async () => 'ok');
});

// ---- No messages → no truncation --------

test('contentLengthGate: over-limit prompt (no messages) with truncate mode does nothing', async () => {
  const mw = contentLengthGate({
    modelLimits: { default: 10 },
    overageMode: 'truncate-oldest',
  });
  // With just a prompt string, there's nothing to truncate.
  const r = await mw(ctxWith({ prompt: 'x'.repeat(200) }), async () => 'ok');
  assert.equal(r, 'ok');
  // No messages dropped.
  assert.equal(mw.stats.messagesDropped, 0);
});

// ---- Stats + MCP + reset -------

test('contentLengthGate: overageRate computed', async () => {
  const mw = contentLengthGate({ modelLimits: { default: 10 }, overageMode: 'log' });
  await mw(ctxWith({ prompt: 'hi' }), async () => 'ok');   // under
  await mw(ctxWith({ prompt: 'x'.repeat(200) }), async () => 'ok');   // over
  assert.equal(mw.overageRate(), 0.5);
});

test('contentLengthGate: reset clears counters', async () => {
  const mw = contentLengthGate({ modelLimits: { default: 100 } });
  await mw(ctxWith({ prompt: 'x' }), async () => 'ok');
  mw.reset();
  assert.equal(mw.stats.totalCalls, 0);
});

test('contentLengthGate: asMcpResource', () => {
  const mw = contentLengthGate({
    modelLimits: { default: 5000 },
    overageMode: 'truncate-oldest',
  });
  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://content-length-gate');
  const p = r.handler();
  assert.equal(p.overageMode, 'truncate-oldest');
  assert.equal(p.preserveSystem, true);
  assert.equal(p.modelLimits.default, 5000);
});
