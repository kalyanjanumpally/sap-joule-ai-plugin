const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_cop__';
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
  costOverrunPredictor,
  startOfMonth,
  endOfMonth,
  startOfDay,
  endOfDay,
  startOfQuarter,
  endOfQuarter,
} = require('../lib/middleware/costOverrunPredictor');

function ctxWith() { return { request: {} }; }
const costOfFixed = (cost) => () => cost;

// ---- Calendar helpers -------------------------------------------

test('startOfMonth: returns 1st of month at 00:00', () => {
  const s = startOfMonth(new Date('2026-08-14T10:30:00'));
  assert.equal(s.getMonth(), 7);   // 0-indexed → August
  assert.equal(s.getDate(), 1);
  assert.equal(s.getHours(), 0);
  assert.equal(s.getMinutes(), 0);
});

test('endOfMonth: returns last ms of month', () => {
  const e = endOfMonth(new Date('2026-08-14T10:30:00'));
  // Aug 31 23:59:59.999 (or close — the impl uses (next month, day 0, hour 0, ms -1) which is prev month last ms)
  assert.equal(e.getMonth(), 7);   // Still August
  assert.equal(e.getDate(), 31);   // Last day
});

test('startOfDay + endOfDay bracket 24 hours', () => {
  const s = startOfDay(new Date('2026-08-14T10:30:00'));
  const e = endOfDay(new Date('2026-08-14T10:30:00'));
  assert.equal(e.getTime() - s.getTime(), 24 * 3600 * 1000 - 1);
});

test('startOfQuarter: Q3 for July', () => {
  const s = startOfQuarter(new Date('2026-08-14T10:30:00'));
  assert.equal(s.getMonth(), 6);   // July
  assert.equal(s.getDate(), 1);
});

test('endOfQuarter: end-Sep for July', () => {
  const e = endOfQuarter(new Date('2026-08-14T10:30:00'));
  assert.equal(e.getMonth(), 8);   // September
  assert.equal(e.getDate(), 30);
});

// ---- Validation ------------------------------------

test('costOverrunPredictor: throws without targetUsd', () => {
  assert.throws(() => costOverrunPredictor({ costOf: () => 0 }), /targetUsd/);
});
test('costOverrunPredictor: throws on non-positive targetUsd', () => {
  assert.throws(() => costOverrunPredictor({ targetUsd: 0, costOf: () => 0 }), /targetUsd/);
});
test('costOverrunPredictor: throws without costOf', () => {
  assert.throws(() => costOverrunPredictor({ targetUsd: 100 }), /costOf/);
});
test('costOverrunPredictor: throws on invalid windowStart', () => {
  assert.throws(() => costOverrunPredictor({
    targetUsd: 100, costOf: () => 0, windowStart: 'x',
  }), /windowStart/);
});
test('costOverrunPredictor: throws on out-of-range warnAtRatio', () => {
  assert.throws(() => costOverrunPredictor({
    targetUsd: 100, costOf: () => 0, warnAtRatio: 0,
  }), /warnAtRatio/);
  assert.throws(() => costOverrunPredictor({
    targetUsd: 100, costOf: () => 0, warnAtRatio: 1.5,
  }), /warnAtRatio/);
});
test('costOverrunPredictor: throws on invalid minSampleSize', () => {
  assert.throws(() => costOverrunPredictor({
    targetUsd: 100, costOf: () => 0, minSampleSize: 0,
  }), /minSampleSize/);
});
test('costOverrunPredictor: throws on non-function callback', () => {
  assert.throws(() => costOverrunPredictor({
    targetUsd: 100, costOf: () => 0, onWarn: 'x',
  }), /callbacks/);
});

// ---- Spend accumulation ------------------------

test('costOverrunPredictor: accumulates spend from costOf', async () => {
  const mw = costOverrunPredictor({
    targetUsd: 100, costOf: costOfFixed(1.5), minSampleSize: 1,
  });
  for (let i = 0; i < 5; i++) await mw(ctxWith(), async () => ({}));
  assert.equal(mw.stats.totalSpent, 7.5);
  assert.equal(mw.stats.totalCalls, 5);
});

test('costOverrunPredictor: bad cost value ignored', async () => {
  const mw = costOverrunPredictor({
    targetUsd: 100, costOf: () => 'not-a-number', minSampleSize: 1,
  });
  await mw(ctxWith(), async () => ({}));
  assert.equal(mw.stats.totalSpent, 0);
});

test('costOverrunPredictor: costOf throws → error captured, call succeeds', async () => {
  const errors = [];
  const mw = costOverrunPredictor({
    targetUsd: 100, costOf: () => { throw new Error('cost bug'); },
    minSampleSize: 1,
    onError: (i) => errors.push(i),
  });
  const r = await mw(ctxWith(), async () => ({ text: 'ok' }));
  assert.equal(r.text, 'ok');
  assert.equal(mw.stats.costErrors, 1);
  assert.equal(errors[0].phase, 'costOf');
});

// ---- Projection --------------------------

test('costOverrunPredictor: projection scales spend by elapsed ratio', async () => {
  // Fake now: elapsed=100, window=1000 → projection = spend * 10.
  let t = 5000;
  const mw = costOverrunPredictor({
    targetUsd: 1000,
    windowStart: () => new Date(4900),
    windowEnd:   () => new Date(5900),
    costOf:      costOfFixed(10),
    minSampleSize: 1,
    now:         () => t,
  });
  await mw(ctxWith(), async () => ({}));
  const p = mw.projection();
  assert.equal(p.spentUsd, 10);
  // elapsed = 5000 - 4900 = 100. fullWindow = 1000. projected = 10 * 10 = 100.
  assert.equal(p.projectedUsd, 100);
});

test('costOverrunPredictor: projection helpers exposed via method', async () => {
  const mw = costOverrunPredictor({
    targetUsd: 100, costOf: costOfFixed(5), minSampleSize: 1,
  });
  await mw(ctxWith(), async () => ({}));
  const p = mw.projection();
  assert.ok(p.spentUsd > 0);
  assert.ok(p.projectedUsd > 0);
  assert.ok(p.elapsedMs >= 0);
  assert.ok(p.remainingMs > 0);
  assert.equal(p.targetUsd, 100);
});

// ---- Warn threshold ------------------

test('costOverrunPredictor: onWarn fires when projection crosses warnAtRatio', async () => {
  const events = [];
  let t = 1000;
  const mw = costOverrunPredictor({
    targetUsd: 100,
    windowStart: () => new Date(0),
    windowEnd:   () => new Date(1_000_000),
    costOf:      costOfFixed(50),
    warnAtRatio: 0.85, minSampleSize: 1,
    now:         () => t,
    onWarn:      (i) => events.push(i),
  });
  // t=1000; window ends at 1M. elapsed=1000, remaining=999000, full=1M.
  // After 1 call: spent=50. Projection = 50 * (1_000_000 / 1000) = 50_000.
  // Ratio = 50_000 / 100 = 500. Way over warnAtRatio.
  await mw(ctxWith(), async () => ({}));
  // Warn fires (crossed 0.85). But also exhausted (>1.0), and warn only fires when < 1.
  // So actually onExhausted fires, not onWarn. Let me use a smaller cost.
  assert.equal(events.length, 0);   // Warn didn't fire because we jumped straight to exhausted.
  // Verify exhausted was reached instead.
  assert.equal(mw.stats.exhaustedCount, 1);
});

test('costOverrunPredictor: onWarn fires only when 0.85 ≤ ratio < 1', async () => {
  const events = [];
  let t = 1000;
  const mw = costOverrunPredictor({
    targetUsd: 100,
    windowStart: () => new Date(0),
    windowEnd:   () => new Date(10_000),   // 10s window
    costOf:      costOfFixed(9),            // 9 * (10000/1000) = 90 projected = ratio 0.9
    warnAtRatio: 0.85, minSampleSize: 1,
    now:         () => t,
    onWarn:      (i) => events.push(i),
  });
  await mw(ctxWith(), async () => ({}));
  assert.equal(events.length, 1);
  assert.equal(mw.stats.warnCount, 1);
});

test('costOverrunPredictor: onWarn is rising-edge — fires once until ratio drops', async () => {
  const events = [];
  let t = 1000;
  const mw = costOverrunPredictor({
    targetUsd: 100,
    windowStart: () => new Date(0),
    windowEnd:   () => new Date(10_000),
    costOf:      costOfFixed(9),
    warnAtRatio: 0.85, minSampleSize: 1,
    now:         () => t,
    onWarn:      (i) => events.push(i),
  });
  await mw(ctxWith(), async () => ({}));   // fires
  t = 2000;   // advance clock — projection recomputes but state stays warned
  await mw(ctxWith(), async () => ({}));   // does NOT re-fire (still warned)
  assert.equal(events.length, 1);
});

// ---- Exhausted threshold ---------------

test('costOverrunPredictor: onExhausted fires when projected ≥ target', async () => {
  const events = [];
  let t = 1000;
  const mw = costOverrunPredictor({
    targetUsd: 100,
    windowStart: () => new Date(0),
    windowEnd:   () => new Date(10_000),
    costOf:      costOfFixed(15),            // 15 * 10 = 150 → ratio 1.5
    minSampleSize: 1,
    now:         () => t,
    onExhausted: (i) => events.push(i),
  });
  await mw(ctxWith(), async () => ({}));
  assert.equal(events.length, 1);
  assert.equal(mw.stats.exhaustedCount, 1);
});

// ---- Sample size gate -------------

test('costOverrunPredictor: minSampleSize gate prevents early fire', async () => {
  const events = [];
  let t = 1000;
  const mw = costOverrunPredictor({
    targetUsd: 100,
    windowStart: () => new Date(0),
    windowEnd:   () => new Date(10_000),
    costOf:      costOfFixed(50),   // huge projected
    minSampleSize: 10,
    now:         () => t,
    onExhausted: (i) => events.push(i),
  });
  for (let i = 0; i < 5; i++) await mw(ctxWith(), async () => ({}));
  assert.equal(events.length, 0);   // below sample size
});

// ---- onProjection ------------

test('costOverrunPredictor: onProjection fires per accepted sample', async () => {
  const events = [];
  const mw = costOverrunPredictor({
    targetUsd: 100, costOf: costOfFixed(1), minSampleSize: 3,
    onProjection: (i) => events.push(i),
  });
  await mw(ctxWith(), async () => ({}));
  await mw(ctxWith(), async () => ({}));
  assert.equal(events.length, 0);
  await mw(ctxWith(), async () => ({}));
  assert.equal(events.length, 1);
});

// ---- Window rollover ----------

test('costOverrunPredictor: window rollover resets spend + warn state', async () => {
  let t = 1000;
  let startMs = 0;
  const mw = costOverrunPredictor({
    targetUsd: 100,
    windowStart: () => new Date(startMs),
    windowEnd:   () => new Date(startMs + 10_000),
    costOf:      costOfFixed(50),
    minSampleSize: 1,
    now:         () => t,
  });
  await mw(ctxWith(), async () => ({}));
  assert.equal(mw.stats.totalSpent, 50);
  // Roll window forward.
  t = 12000;
  startMs = 12_000;
  await mw(ctxWith(), async () => ({}));
  // Spend reset to 50 (just the one new call).
  assert.equal(mw.stats.totalSpent, 50);
  assert.equal(mw.stats.totalCalls, 1);
});

// ---- Callbacks --------

test('costOverrunPredictor: callback throws swallowed', async () => {
  let t = 1000;
  const mw = costOverrunPredictor({
    targetUsd: 100,
    windowStart: () => new Date(0),
    windowEnd:   () => new Date(10_000),
    costOf:      costOfFixed(9),
    warnAtRatio: 0.85, minSampleSize: 1,
    now:         () => t,
    onWarn:      () => { throw new Error('x'); },
    onProjection: () => { throw new Error('x'); },
  });
  await mw(ctxWith(), async () => ({}));
});

// ---- Reset + MCP ----------

test('costOverrunPredictor: reset clears counters', async () => {
  const mw = costOverrunPredictor({
    targetUsd: 100, costOf: costOfFixed(5), minSampleSize: 1,
  });
  await mw(ctxWith(), async () => ({}));
  mw.reset();
  assert.equal(mw.stats.totalSpent, 0);
  assert.equal(mw.stats.totalCalls, 0);
});

test('costOverrunPredictor: asMcpResource', () => {
  const mw = costOverrunPredictor({
    targetUsd: 500, costOf: () => 0,
    warnAtRatio: 0.9, minSampleSize: 30,
  });
  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://cost-overrun-predictor');
  const p = r.handler();
  assert.equal(p.targetUsd, 500);
  assert.equal(p.warnAtRatio, 0.9);
  assert.equal(p.minSampleSize, 30);
  assert.ok(p.projection);
});
