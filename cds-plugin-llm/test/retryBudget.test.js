const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_rb__';
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
  retryBudget,
  RetryBudgetExhaustedError,
} = require('../lib/middleware/retryBudget');

// ---- Helpers ---------------------------------------------------------

function makeCtx() { return { request: {}, meta: {} }; }

// Simulate a retry primitive that re-invokes the SAME ctx N times.
async function withRetries(mw, ctx, upstream, times) {
  for (let i = 0; i < times; i++) {
    try { return await mw(ctx, upstream); }
    catch (err) {
      if (err.code === 'RETRY_BUDGET_EXHAUSTED') throw err;
      if (i === times - 1) throw err;
      // Otherwise, retry (same ctx).
    }
  }
}

// ---- Validation -------------------------------------------------------

test('retryBudget: throws on out-of-range retryRatio', () => {
  assert.throws(() => retryBudget({ retryRatio: 0 }), /retryRatio/);
  assert.throws(() => retryBudget({ retryRatio: 1 }), /retryRatio/);
  assert.throws(() => retryBudget({ retryRatio: -0.1 }), /retryRatio/);
});
test('retryBudget: throws on tiny windowMs', () => {
  assert.throws(() => retryBudget({ windowMs: 50 }), /windowMs/);
});
test('retryBudget: throws on non-integer minSampleSize', () => {
  assert.throws(() => retryBudget({ minSampleSize: 0 }), /minSampleSize/);
});
test('retryBudget: throws on non-function onExhausted', () => {
  assert.throws(() => retryBudget({ onExhausted: 'x' }), /callbacks/);
});
test('retryBudget: throws on out-of-range lowBudgetLevels', () => {
  assert.throws(() => retryBudget({ lowBudgetLevels: [1.5] }), /lowBudgetLevels/);
});
test('retryBudget: throws on non-array lowBudgetLevels', () => {
  assert.throws(() => retryBudget({ lowBudgetLevels: 'x' }), /lowBudgetLevels/);
});

// ---- First attempts always allowed ---------------------------------

test('retryBudget: first attempt always allowed regardless of budget state', async () => {
  const mw = retryBudget({ retryRatio: 0.01, minSampleSize: 1 });
  for (let i = 0; i < 20; i++) {
    const r = await mw(makeCtx(), async () => 'ok');
    assert.equal(r, 'ok');
  }
  assert.equal(mw.stats.firstAttempts, 20);
  assert.equal(mw.stats.retryAttempts, 0);
});

// ---- Retries counted correctly ------------------------------------

test('retryBudget: repeat ctx counts as retry', async () => {
  const mw = retryBudget({ retryRatio: 0.9, minSampleSize: 100 });
  const ctx = makeCtx();
  await mw(ctx, async () => 'r1');
  await mw(ctx, async () => 'r2');
  await mw(ctx, async () => 'r3');
  assert.equal(mw.stats.firstAttempts, 1);
  assert.equal(mw.stats.retryAttempts, 2);
});

// ---- Budget exhaustion ------------------------------------------

test('retryBudget: exceeding retryRatio throws RetryBudgetExhaustedError', async () => {
  // With 100 requests and 10 allowed, the 11th retry should be refused.
  const mw = retryBudget({ retryRatio: 0.10, minSampleSize: 100 });
  // Prime the window with 100 unique-ctx requests (baseline).
  for (let i = 0; i < 100; i++) {
    await mw(makeCtx(), async () => 'ok');
  }
  // Now retry within budget (10 allowed).
  const ctx = makeCtx();
  await mw(ctx, async () => 'r0');   // first attempt of new ctx
  for (let i = 0; i < 10; i++) {
    await mw(ctx, async () => 'retry');   // 10 retries
  }
  // 11th retry should be refused.
  await assert.rejects(
    mw(ctx, async () => 'over'),
    RetryBudgetExhaustedError,
  );
  assert.equal(mw.stats.rejectedRetries, 1);
});

test('retryBudget: rejection carries ratio + counts', async () => {
  const mw = retryBudget({ retryRatio: 0.10, minSampleSize: 100 });
  for (let i = 0; i < 100; i++) await mw(makeCtx(), async () => 'ok');
  const ctx = makeCtx();
  await mw(ctx, async () => 'ok');
  for (let i = 0; i < 10; i++) await mw(ctx, async () => 'ok');
  try {
    await mw(ctx, async () => 'over');
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.code, 'RETRY_BUDGET_EXHAUSTED');
    assert.ok(err.currentRatio > 0.10);
    assert.equal(err.retryRatio, 0.10);
    assert.equal(err.retries, 10);
  }
});

test('retryBudget: retries allowed while under sample size', async () => {
  const mw = retryBudget({ retryRatio: 0.01, minSampleSize: 1000 });
  const ctx = makeCtx();
  // Would blow the ratio, but sample size is far too small to trip.
  await mw(ctx, async () => 'r0');
  for (let i = 0; i < 50; i++) {
    await mw(ctx, async () => 'r');
  }
  assert.equal(mw.stats.rejectedRetries, 0);
});

// ---- Sliding window -------------------------------------------

test('retryBudget: old entries pruned from window', async () => {
  let t = 1000;
  const mw = retryBudget({
    retryRatio: 0.50, windowMs: 1000, minSampleSize: 100,
    now: () => t,
  });
  // Prime with 20 requests + 5 retries within window.
  for (let i = 0; i < 20; i++) await mw(makeCtx(), async () => 'r');
  const ctx1 = makeCtx();
  await mw(ctx1, async () => 'r');
  for (let i = 0; i < 5; i++) await mw(ctx1, async () => 'r');
  let counts = mw.currentCounts();
  assert.equal(counts.requests, 21);
  assert.equal(counts.retries, 5);
  // Advance clock past window; new call should see empty counts.
  t = 5000;
  await mw(makeCtx(), async () => 'r');
  counts = mw.currentCounts();
  assert.equal(counts.requests, 1);
  assert.equal(counts.retries, 0);
});

test('retryBudget: after window expiry, retries allowed again', async () => {
  let t = 1000;
  const mw = retryBudget({
    retryRatio: 0.10, windowMs: 1000, minSampleSize: 100,
    now: () => t,
  });
  // Prime with 100 requests, then trip via retries.
  for (let i = 0; i < 100; i++) await mw(makeCtx(), async () => 'r');
  const ctx1 = makeCtx();
  await mw(ctx1, async () => 'r');
  for (let i = 0; i < 10; i++) await mw(ctx1, async () => 'r');
  await assert.rejects(mw(ctx1, async () => 'over'), RetryBudgetExhaustedError);
  // Advance past window — budget resets naturally via pruning.
  t = 5000;
  // Prime again + retry.
  for (let i = 0; i < 100; i++) await mw(makeCtx(), async () => 'r');
  const ctx2 = makeCtx();
  await mw(ctx2, async () => 'r');
  await mw(ctx2, async () => 'r');   // should succeed — budget freshly refilled
});

// ---- Ratio computation ---------------------------------------

test('retryBudget: currentRatio() reflects live state', async () => {
  // High minSampleSize so we can observe ratio without tripping the cap.
  const mw = retryBudget({ retryRatio: 0.9, minSampleSize: 100 });
  await mw(makeCtx(), async () => 'r');
  const ctx = makeCtx();
  await mw(ctx, async () => 'r');
  await mw(ctx, async () => 'r');
  // 2 requests, 1 retry → ratio uses max(requests, minSampleSize) = 100 → 0.01
  const counts = mw.currentCounts();
  assert.equal(counts.requests, 2);
  assert.equal(counts.retries, 1);
  assert.equal(mw.currentRatio(), 1 / 100);
});

// ---- Callbacks -------------------------------------------

test('retryBudget: onExhausted fires when budget exceeded', async () => {
  const events = [];
  const mw = retryBudget({
    retryRatio: 0.10, minSampleSize: 10,
    onExhausted: (i) => events.push(i),
  });
  for (let i = 0; i < 10; i++) await mw(makeCtx(), async () => 'r');
  const ctx = makeCtx();
  await mw(ctx, async () => 'r');
  await mw(ctx, async () => 'r');
  try { await mw(ctx, async () => 'r'); } catch { /* expected */ }
  assert.equal(events.length, 1);
  assert.equal(events[0].retryRatio, 0.10);
  assert.ok(events[0].currentRatio > 0.10);
});

test('retryBudget: onLowBudget fires at threshold levels', async () => {
  const events = [];
  const mw = retryBudget({
    retryRatio: 0.10, minSampleSize: 100,
    lowBudgetLevels: [0.5, 0.8],
    onLowBudget: (i) => events.push(i.level),
  });
  // Prime with 100 requests.
  for (let i = 0; i < 100; i++) await mw(makeCtx(), async () => 'r');
  // Consume retries gradually.
  const ctx = makeCtx();
  await mw(ctx, async () => 'r');
  for (let i = 0; i < 6; i++) await mw(ctx, async () => 'r');
  // 6 retries / 101 requests ≈ 0.059; budget fraction = 0.59 → fires 0.5 level.
  assert.ok(events.includes(0.5));
});

test('retryBudget: callback throws swallowed', async () => {
  const mw = retryBudget({
    retryRatio: 0.10, minSampleSize: 10,
    onExhausted: () => { throw new Error('x'); },
    onLowBudget: () => { throw new Error('x'); },
  });
  for (let i = 0; i < 10; i++) await mw(makeCtx(), async () => 'r');
  const ctx = makeCtx();
  await mw(ctx, async () => 'r');
  await mw(ctx, async () => 'r');
  try { await mw(ctx, async () => 'r'); } catch { /* expected */ }
});

// ---- Stats + MCP + reset -----------------------------------

test('retryBudget: reset clears window + counters', async () => {
  const mw = retryBudget({ retryRatio: 0.9, minSampleSize: 100 });
  const ctx = makeCtx();
  await mw(ctx, async () => 'r');
  await mw(ctx, async () => 'r');
  assert.equal(mw.stats.retryAttempts, 1);
  mw.reset();
  assert.equal(mw.stats.retryAttempts, 0);
  const counts = mw.currentCounts();
  assert.equal(counts.requests, 0);
  assert.equal(counts.retries, 0);
});

test('retryBudget: asMcpResource', () => {
  const mw = retryBudget({
    retryRatio: 0.15, windowMs: 30_000, minSampleSize: 50,
    lowBudgetLevels: [0.6, 0.9],
  });
  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://retry-budget');
  const p = r.handler();
  assert.equal(p.retryRatio, 0.15);
  assert.equal(p.windowMs, 30_000);
  assert.equal(p.minSampleSize, 50);
  assert.deepEqual(p.lowBudgetLevels, [0.6, 0.9]);
  assert.equal(p.currentRequests, 0);
  assert.equal(p.currentRetries, 0);
});

// ---- Integration with a real retry loop ---------------

test('retryBudget: retry loop stops when budget exhausted', async () => {
  const mw = retryBudget({ retryRatio: 0.10, minSampleSize: 10 });
  // Prime baseline.
  for (let i = 0; i < 10; i++) await mw(makeCtx(), async () => 'ok');
  // Consume the retry budget.
  const ctx1 = makeCtx();
  await mw(ctx1, async () => 'ok');
  await mw(ctx1, async () => 'ok');
  // 1 retry / 11 baseline = 0.09; budget=0.10; next retry pushes to 0.18. Rejected.

  const ctx2 = makeCtx();
  await mw(ctx2, async () => 'ok');
  await assert.rejects(mw(ctx2, async () => 'ok'), RetryBudgetExhaustedError);
});

test('retryBudget: downstream errors do not consume budget', async () => {
  const mw = retryBudget({ retryRatio: 0.10, minSampleSize: 1 });
  // A downstream throw shouldn't affect our accounting.
  await assert.rejects(
    mw(makeCtx(), async () => { throw new Error('provider down'); }),
    /provider down/,
  );
  assert.equal(mw.stats.firstAttempts, 1);
  assert.equal(mw.stats.retryAttempts, 0);
});

// ---- Ratio recovery after burst -----------------------

test('retryBudget: low-budget level resets when ratio recovers', async () => {
  const events = [];
  let t = 1000;
  const mw = retryBudget({
    retryRatio: 0.10, minSampleSize: 100, windowMs: 1000,
    lowBudgetLevels: [0.5],
    onLowBudget: () => events.push(t),
    now: () => t,
  });
  // Prime with 100 requests + 1 first-attempt for ctx = 101 requests.
  // Then N retries. budget_fraction = (N/101) / 0.10.
  // Need N/101 >= 0.05 → N >= 5.05 → 6 retries.
  for (let i = 0; i < 100; i++) await mw(makeCtx(), async () => 'r');
  const ctx = makeCtx();
  await mw(ctx, async () => 'r');
  for (let i = 0; i < 6; i++) await mw(ctx, async () => 'r');   // 6 retries → 6/101 ≈ 0.059 ≥ 0.05
  assert.equal(events.length, 1);
  // Now advance past window — everything ages out.
  t = 5000;
  for (let i = 0; i < 100; i++) await mw(makeCtx(), async () => 'r');
  // No new fires yet.
  assert.equal(events.length, 1);
  // Consume 6 more retries — should re-fire the level.
  const ctx2 = makeCtx();
  await mw(ctx2, async () => 'r');
  for (let i = 0; i < 6; i++) await mw(ctx2, async () => 'r');
  assert.equal(events.length, 2);
});
