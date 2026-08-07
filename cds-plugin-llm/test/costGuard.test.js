const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_cg__';
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

const { costGuard, CostGuardBlockedError } = require('../lib/middleware/costGuard');

// Directly invoke the middleware with a simulated ctx + next.
function invoke(mw, opts = {}) {
  const {
    method   = 'chat',
    model    = 'gpt-4o-mini',
    messages = [{ role: 'user', content: 'Hello' }],
    system   = null,
    maxTokens = 100,
    raw      = null,   // raw request (for costGuard: 'skip' opt-out)
    next     = async () => ({ text: 'ok' }),
  } = opts;
  const ctx = {
    method,
    request: { model, messages, system, maxTokens },
    raw:     raw ?? { model, messages, system, maxTokens },
    meta:    {},
  };
  return { ctx, promise: mw(ctx, next) };
}

// ---- Input validation --------------------------------------------------

test('costGuard: throws on missing maxPerCallUsd', () => {
  assert.throws(() => costGuard({}), /maxPerCallUsd/);
});

test('costGuard: throws on non-positive maxPerCallUsd', () => {
  assert.throws(() => costGuard({ maxPerCallUsd: 0 }),  /maxPerCallUsd/);
  assert.throws(() => costGuard({ maxPerCallUsd: -1 }), /maxPerCallUsd/);
});

test('costGuard: throws when warnAtUsd exceeds maxPerCallUsd', () => {
  assert.throws(() => costGuard({ maxPerCallUsd: 1, warnAtUsd: 5 }), /cannot exceed/);
});

test('costGuard: throws when applyTo is not an array', () => {
  assert.throws(() => costGuard({ maxPerCallUsd: 1, applyTo: 'chat' }), /applyTo must be an array/);
});

// ---- Fast path (under ceiling) ----------------------------------------

test('costGuard: cheap request passes through and increments checked', async () => {
  const g = costGuard({ maxPerCallUsd: 1.00 });
  const { ctx, promise } = invoke(g);
  const res = await promise;
  assert.deepEqual(res, { text: 'ok' });
  assert.equal(g.stats.requests, 1);
  assert.equal(g.stats.checked, 1);
  assert.equal(g.stats.blocked, 0);
  assert.ok(g.stats.estimatedUsdTotal > 0);
  // Estimate is stashed on ctx.meta for downstream
  assert.ok(ctx.meta.costEstimate);
  assert.ok(ctx.meta.costEstimate.tokensIn > 0);
});

// ---- Blocking (over ceiling) ------------------------------------------

test('costGuard: request exceeding ceiling throws CostGuardBlockedError WITHOUT calling next', async () => {
  const g = costGuard({ maxPerCallUsd: 0.000001 });   // absurdly tight
  let nextCalled = false;
  const { promise } = invoke(g, {
    model:    'gpt-4o-mini',
    maxTokens: 5000,   // pushes est past $0.000001
    next: async () => { nextCalled = true; return { text: 'never' }; },
  });
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof CostGuardBlockedError);
    assert.equal(err.code, 'COST_GUARD_BLOCKED');
    assert.equal(err.model, 'gpt-4o-mini');
    assert.ok(err.estimatedUsd > err.limitUsd);
    return true;
  });
  assert.equal(nextCalled, false, 'provider must not be called when ceiling exceeded');
  assert.equal(g.stats.blocked, 1);
});

test('costGuard: onExceeded callback fires with detailed info on block', async () => {
  const events = [];
  const g = costGuard({
    maxPerCallUsd: 0.000001,
    onExceeded: (info) => events.push(info),
  });
  const { promise } = invoke(g, { maxTokens: 5000 });
  await assert.rejects(promise, CostGuardBlockedError);
  assert.equal(events.length, 1);
  assert.equal(events[0].model, 'gpt-4o-mini');
  assert.equal(events[0].limitUsd, 0.000001);
  assert.ok(events[0].estimatedUsd > events[0].limitUsd);
  assert.equal(events[0].method, 'chat');
});

// ---- Warning tier ------------------------------------------------------

test('costGuard: warnAtUsd fires callback but passes through', async () => {
  const events = [];
  const g = costGuard({
    maxPerCallUsd: 10,
    warnAtUsd:     0.0000001,   // very low, will fire on almost anything
    onWarn: (info) => events.push(info),
  });
  const { promise } = invoke(g, { maxTokens: 500 });
  const res = await promise;
  assert.deepEqual(res, { text: 'ok' });
  assert.equal(g.stats.warned, 1);
  assert.equal(g.stats.blocked, 0);
  assert.equal(events.length, 1);
  assert.ok(events[0].estimatedUsd > events[0].warnAtUsd);
});

test('costGuard: warnAtUsd=null disables the warning tier', async () => {
  const events = [];
  const g = costGuard({
    maxPerCallUsd: 10,
    warnAtUsd:     null,
    onWarn: (info) => events.push(info),
  });
  const { promise } = invoke(g);
  await promise;
  assert.equal(g.stats.warned, 0);
  assert.equal(events.length, 0);
});

// ---- applyTo filter ---------------------------------------------------

test('costGuard: default applyTo skips embed method', async () => {
  const g = costGuard({ maxPerCallUsd: 0.000001 });
  const { promise } = invoke(g, { method: 'embed', maxTokens: 999_999 });
  const res = await promise;
  assert.deepEqual(res, { text: 'ok' });
  assert.equal(g.stats.skipped, 1);
  assert.equal(g.stats.blocked, 0);
});

test('costGuard: custom applyTo can include embed', async () => {
  const g = costGuard({ maxPerCallUsd: 0.000001, applyTo: ['embed', 'chat'] });
  const { promise } = invoke(g, { method: 'embed', maxTokens: 999_999 });
  await assert.rejects(promise, CostGuardBlockedError);
});

test('costGuard: stream method is checked by default', async () => {
  const g = costGuard({ maxPerCallUsd: 0.000001 });
  const { promise } = invoke(g, { method: 'stream', maxTokens: 999_999 });
  await assert.rejects(promise, CostGuardBlockedError);
});

// ---- Opt-out per request ----------------------------------------------

test('costGuard: raw.costGuard=skip bypasses the check', async () => {
  const g = costGuard({ maxPerCallUsd: 0.000001 });
  const { promise } = invoke(g, {
    maxTokens: 999_999,
    raw: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Hi' }], costGuard: 'skip' },
  });
  const res = await promise;
  assert.deepEqual(res, { text: 'ok' });
  assert.equal(g.stats.skipped, 1);
});

// ---- Missing model / messages ----------------------------------------

test('costGuard: missing model passes through (nothing to estimate)', async () => {
  const g = costGuard({ maxPerCallUsd: 1 });
  const { promise } = invoke(g, { model: null });
  const res = await promise;
  assert.deepEqual(res, { text: 'ok' });
  assert.equal(g.stats.skipped, 1);
});

// ---- Unknown model (priced=false) ------------------------------------

test('costGuard: unknown model has priced=false → estimate=0 → passes through', async () => {
  const g = costGuard({ maxPerCallUsd: 0.000001 });
  const { promise } = invoke(g, { model: 'made-up-model-v99' });
  const res = await promise;
  // Estimate for unknown model is $0, which passes any positive ceiling.
  assert.deepEqual(res, { text: 'ok' });
  assert.equal(g.stats.checked, 1);
  assert.equal(g.stats.blocked, 0);
});

// ---- Stats + MCP resource --------------------------------------------

test('costGuard: reset() clears counters', async () => {
  const g = costGuard({ maxPerCallUsd: 1 });
  await invoke(g).promise;
  assert.equal(g.stats.requests, 1);
  g.reset();
  assert.equal(g.stats.requests, 0);
  assert.equal(g.stats.checked, 0);
  assert.equal(g.stats.estimatedUsdTotal, 0);
});

test('costGuard: asMcpResource() returns config://cost-guard snapshot', async () => {
  const g = costGuard({ maxPerCallUsd: 2.5, warnAtUsd: 0.5 });
  await invoke(g).promise;
  const res = g.asMcpResource();
  assert.equal(res.uri, 'config://cost-guard');
  assert.equal(res.mimeType, 'application/json');
  const snap = res.handler();
  assert.equal(snap.maxPerCallUsd, 2.5);
  assert.equal(snap.warnAtUsd, 0.5);
  assert.deepEqual([...snap.applyTo].sort(), ['chat', 'stream']);
  assert.equal(snap.requests, 1);
});
