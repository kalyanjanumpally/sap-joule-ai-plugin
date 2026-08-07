const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_amt__';
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

const { adaptiveMaxTokens, AdaptiveMaxTokensBlockedError } = require('../lib/middleware/adaptiveMaxTokens');
const { LLMError } = require('../lib/errors');

// Fake budget with configurable limits + spent
function fakeBudget({ limit = null, spent = 0, scope = 'total' } = {}) {
  return {
    limitFor: (s, _k) => (s === scope ? limit : null),
    snapshot: async () => {
      if (scope === 'total')     return { total: spent, perTenant: {}, perModel: {} };
      if (scope === 'perTenant') return { total: 0, perTenant: { default: spent }, perModel: {} };
      return { total: 0, perTenant: {}, perModel: { 'gpt-4o': spent } };
    },
  };
}

function invoke(mw, opts = {}) {
  const {
    method    = 'chat',
    model     = 'gpt-4o',
    messages  = [{ role: 'user', content: 'Hello world.' }],
    maxTokens = 500,
    raw       = null,
    next      = async () => ({ text: 'ok' }),
  } = opts;
  const ctx = {
    method,
    request: { model, messages, maxTokens },
    raw:     raw ?? { model, messages, maxTokens },
    meta:    {},
  };
  return { ctx, promise: mw(ctx, next) };
}

// ---- Input validation --------------------------------------------------

test('adaptiveMaxTokens: throws when budget missing / malformed', () => {
  assert.throws(() => adaptiveMaxTokens({}), /budget must be a costBudget/);
  assert.throws(() => adaptiveMaxTokens({ budget: {} }), /budget must be a costBudget/);
});

test('adaptiveMaxTokens: throws on invalid scope', () => {
  assert.throws(
    () => adaptiveMaxTokens({ budget: fakeBudget(), scope: 'invalid' }),
    /scope must be/,
  );
});

test('adaptiveMaxTokens: throws on invalid safetyFactor', () => {
  const b = fakeBudget();
  assert.throws(() => adaptiveMaxTokens({ budget: b, safetyFactor: 0 }),   /safetyFactor/);
  assert.throws(() => adaptiveMaxTokens({ budget: b, safetyFactor: 1.5 }), /safetyFactor/);
  assert.throws(() => adaptiveMaxTokens({ budget: b, safetyFactor: -0.1 }),/safetyFactor/);
});

test('adaptiveMaxTokens: throws on invalid minTokens / maxTokens', () => {
  const b = fakeBudget();
  assert.throws(() => adaptiveMaxTokens({ budget: b, minTokens: 0 }),                        /minTokens/);
  assert.throws(() => adaptiveMaxTokens({ budget: b, minTokens: 100, maxTokens: 50 }),        /maxTokens/);
});

// ---- Skip paths -------------------------------------------------------

test('adaptiveMaxTokens: skips embed method (default applyTo)', async () => {
  const mw = adaptiveMaxTokens({ budget: fakeBudget({ limit: 100, spent: 99 }) });
  const { ctx, promise } = invoke(mw, { method: 'embed', maxTokens: 10_000 });
  await promise;
  assert.equal(mw.stats.skipped, 1);
  assert.equal(ctx.request.maxTokens, 10_000);   // unchanged
});

test('adaptiveMaxTokens: skips when model missing', async () => {
  const mw = adaptiveMaxTokens({ budget: fakeBudget({ limit: 100, spent: 99 }) });
  const { ctx, promise } = invoke(mw, { model: null, maxTokens: 10_000 });
  await promise;
  assert.equal(mw.stats.skipped, 1);
});

test('adaptiveMaxTokens: skips when model unknown (no pricing)', async () => {
  const mw = adaptiveMaxTokens({ budget: fakeBudget({ limit: 100, spent: 99 }) });
  const { ctx, promise } = invoke(mw, { model: 'made-up-model' });
  await promise;
  assert.equal(mw.stats.skipped, 1);
});

test('adaptiveMaxTokens: skips when no budget limit configured', async () => {
  const mw = adaptiveMaxTokens({ budget: fakeBudget({ limit: null }) });
  const { promise } = invoke(mw);
  await promise;
  assert.equal(mw.stats.skipped, 1);
});

// ---- Adjustment path --------------------------------------------------

test('adaptiveMaxTokens: shrinks maxTokens when it would exceed safe budget', async () => {
  // gpt-4o output: $20/M. Remaining $10, safetyFactor 0.5 → safe $5
  // safeOutputTokens ≈ $5 / ($20/1M) = 250_000 → but requested only 300_000
  // Actually let's pick numbers that force a shrink:
  // Remaining $0.01, safety 0.5 → safe $0.005; 4o output at $20/M → 250 tokens
  const mw = adaptiveMaxTokens({
    budget: fakeBudget({ limit: 0.01, spent: 0 }),
    safetyFactor: 0.5,
  });
  const { ctx, promise } = invoke(mw, { model: 'gpt-4o', maxTokens: 5000 });
  await promise;
  assert.equal(mw.stats.adjusted, 1);
  assert.ok(ctx.request.maxTokens < 5000, `expected shrink, got ${ctx.request.maxTokens}`);
  assert.ok(ctx.request.maxTokens >= 50, 'shrunk value at or above minTokens floor');
  // Meta should carry the adjustment
  assert.ok(ctx.meta.adaptiveMaxTokens);
  assert.equal(ctx.meta.adaptiveMaxTokens.requested, 5000);
});

test('adaptiveMaxTokens: leaves maxTokens unchanged when budget has plenty', async () => {
  // gpt-4o-mini output: $0.60/M. Remaining $500, safety 0.5 → safe $250
  // safeOutputTokens = ~416M tokens — way above requested 500
  const mw = adaptiveMaxTokens({
    budget: fakeBudget({ limit: 500, spent: 0 }),
    safetyFactor: 0.5,
  });
  const { ctx, promise } = invoke(mw, { model: 'gpt-4o-mini', maxTokens: 500 });
  await promise;
  assert.equal(mw.stats.unchanged, 1);
  assert.equal(mw.stats.adjusted, 0);
  assert.equal(ctx.request.maxTokens, 500);   // unchanged
});

test('adaptiveMaxTokens: totalSavedTokens accumulates shrinkage', async () => {
  const mw = adaptiveMaxTokens({
    budget: fakeBudget({ limit: 0.01, spent: 0 }),
    safetyFactor: 0.5,
  });
  const first = invoke(mw, { model: 'gpt-4o', maxTokens: 5000 });
  await first.promise;
  const shrink1 = 5000 - first.ctx.request.maxTokens;
  const second = invoke(mw, { model: 'gpt-4o', maxTokens: 5000 });
  await second.promise;
  const shrink2 = 5000 - second.ctx.request.maxTokens;
  assert.equal(mw.stats.adjusted, 2);
  assert.equal(mw.stats.totalSavedTokens, shrink1 + shrink2);
});

// ---- Rejection path (budget too tight) --------------------------------

test('adaptiveMaxTokens: throws AdaptiveMaxTokensBlockedError when safe output < minTokens', async () => {
  // Remaining $0.000001 → safe $0.0000005 → gpt-4o output at $20/M means
  // only ~0.025 output tokens can fit; below minTokens=50 → throw
  const mw = adaptiveMaxTokens({
    budget:       fakeBudget({ limit: 0.000001, spent: 0 }),
    safetyFactor: 0.5,
    minTokens:    50,
  });
  await assert.rejects(
    invoke(mw, { model: 'gpt-4o', maxTokens: 500 }).promise,
    (err) => {
      assert.ok(err instanceof AdaptiveMaxTokensBlockedError);
      assert.ok(err instanceof LLMError);
      assert.equal(err.code, 'BUDGET_TOO_TIGHT');
      assert.equal(err.httpStatus, 402);
      assert.equal(err.retriable, false);
      assert.equal(err.minTokens, 50);
      assert.equal(err.model, 'gpt-4o');
      return true;
    },
  );
  assert.equal(mw.stats.rejected, 1);
});

test('adaptiveMaxTokens: throws when safe budget cannot even fit input tokens', async () => {
  // Input tokens cost more than safe budget → immediate reject
  const mw = adaptiveMaxTokens({
    budget:       fakeBudget({ limit: 0.0000001, spent: 0 }),   // tiny
    safetyFactor: 0.5,
    minTokens:    50,
  });
  await assert.rejects(
    invoke(mw, {
      model:    'gpt-4o',
      messages: [{ role: 'user', content: 'x'.repeat(10_000) }],  // heavy input
      maxTokens: 100,
    }).promise,
    AdaptiveMaxTokensBlockedError,
  );
});

// ---- onAdjust / onBlock callbacks -------------------------------------

test('adaptiveMaxTokens: onAdjust callback fires with details when shrinking', async () => {
  const events = [];
  const mw = adaptiveMaxTokens({
    budget:       fakeBudget({ limit: 0.01, spent: 0 }),
    safetyFactor: 0.5,
    onAdjust:     (info) => events.push(info),
  });
  await invoke(mw, { model: 'gpt-4o', maxTokens: 5000 }).promise;
  assert.equal(events.length, 1);
  assert.equal(events[0].requested, 5000);
  assert.ok(events[0].adjusted < 5000);
  assert.equal(events[0].model, 'gpt-4o');
});

test('adaptiveMaxTokens: onBlock callback fires when rejecting', async () => {
  const events = [];
  const mw = adaptiveMaxTokens({
    budget:       fakeBudget({ limit: 0.0000001, spent: 0 }),
    safetyFactor: 0.5,
    onBlock:      (info) => events.push(info),
  });
  await invoke(mw, {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'x'.repeat(10_000) }],
  }).promise.catch(() => {});
  assert.equal(events.length, 1);
  assert.equal(events[0].model, 'gpt-4o');
});

test('adaptiveMaxTokens: callback exceptions are swallowed', async () => {
  const mw = adaptiveMaxTokens({
    budget:       fakeBudget({ limit: 0.01, spent: 0 }),
    safetyFactor: 0.5,
    onAdjust:     () => { throw new Error('handler broken'); },
  });
  await invoke(mw, { model: 'gpt-4o', maxTokens: 5000 }).promise;   // should NOT throw
  assert.equal(mw.stats.adjusted, 1);
});

// ---- Scope + tenant / model resolution -------------------------------

test('adaptiveMaxTokens: perTenant scope uses tenantOf', async () => {
  const budget = fakeBudget({ limit: 500, spent: 0, scope: 'perTenant' });
  const mw = adaptiveMaxTokens({
    budget,
    scope:    'perTenant',
    tenantOf: (ctx) => ctx?.raw?.tenant ?? 'default',
    safetyFactor: 0.5,
  });
  const { ctx, promise } = invoke(mw, { model: 'gpt-4o-mini', maxTokens: 500 });
  await promise;
  // Plenty of budget for tenant 'default' → unchanged
  assert.equal(mw.stats.unchanged, 1);
});

test('adaptiveMaxTokens: perModel scope uses modelOf', async () => {
  const budget = fakeBudget({ limit: 500, spent: 0, scope: 'perModel' });
  const mw = adaptiveMaxTokens({
    budget,
    scope:    'perModel',
    modelOf:  (ctx) => ctx?.request?.model,
    safetyFactor: 0.5,
  });
  const { promise } = invoke(mw, { model: 'gpt-4o', maxTokens: 500 });
  await promise;
  assert.equal(mw.stats.unchanged, 1);
});

// ---- Uses maxTokens option as fallback --------------------------------

test('adaptiveMaxTokens: uses maxTokens option when caller supplies none', async () => {
  const mw = adaptiveMaxTokens({
    budget:    fakeBudget({ limit: 0.01, spent: 0 }),
    safetyFactor: 0.5,
    maxTokens: 2000,
  });
  const { ctx, promise } = invoke(mw, { model: 'gpt-4o', maxTokens: null });
  await promise;
  // Should shrink from the middleware default (2000) to whatever fits
  assert.equal(mw.stats.adjusted, 1);
  assert.ok(ctx.request.maxTokens < 2000);
});

// ---- Stats + MCP resource --------------------------------------------

test('adaptiveMaxTokens: reset() clears stats', async () => {
  const mw = adaptiveMaxTokens({ budget: fakeBudget({ limit: 500, spent: 0 }) });
  await invoke(mw).promise;
  assert.equal(mw.stats.requests, 1);
  mw.reset();
  assert.equal(mw.stats.requests, 0);
  assert.equal(mw.stats.totalSavedTokens, 0);
});

test('adaptiveMaxTokens: asMcpResource() returns config://adaptive-max-tokens', async () => {
  const mw = adaptiveMaxTokens({
    budget: fakeBudget({ limit: 500, spent: 0 }),
    scope: 'perTenant',
    safetyFactor: 0.6,
    minTokens: 100,
    maxTokens: 3000,
  });
  await invoke(mw).promise;
  const res = mw.asMcpResource();
  assert.equal(res.uri, 'config://adaptive-max-tokens');
  assert.equal(res.mimeType, 'application/json');
  const snap = res.handler();
  assert.equal(snap.scope, 'perTenant');
  assert.equal(snap.safetyFactor, 0.6);
  assert.equal(snap.minTokens, 100);
  assert.equal(snap.maxTokens, 3000);
  assert.equal(snap.requests, 1);
});
