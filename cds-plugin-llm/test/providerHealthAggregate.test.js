const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_pha__';
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
  providerHealthAggregate,
  percentile,
} = require('../lib/middleware/providerHealthAggregate');

// ---- Helpers ---------------------------------------------------------

function ctxWith(provider = 'openai') { return { request: { provider } }; }

// ---- percentile helper ----------------------------------------------

test('percentile: empty → 0', () => {
  assert.equal(percentile([], 95), 0);
});
test('percentile: single value', () => {
  assert.equal(percentile([10], 95), 10);
});
test('percentile: p50 median', () => {
  assert.equal(percentile([10, 20, 30], 50), 20);
});
test('percentile: p95 of [1..100]', () => {
  const arr = Array.from({ length: 100 }, (_, i) => i + 1);
  const p = percentile(arr, 95);
  // Linear-interp p95 of 1..100 → ~95.05.
  assert.ok(p >= 94 && p <= 96, `got ${p}`);
});

// ---- Validation ------------------------------------------------------

test('providerHealthAggregate: throws without providerOf', () => {
  assert.throws(() => providerHealthAggregate({}), /providerOf/);
});
test('providerHealthAggregate: throws on tiny windowMs', () => {
  assert.throws(() => providerHealthAggregate({ providerOf: () => 'x', windowMs: 50 }), /windowMs/);
});
test('providerHealthAggregate: throws on invalid errorRateThreshold', () => {
  assert.throws(() => providerHealthAggregate({ providerOf: () => 'x', errorRateThreshold: 0 }), /errorRateThreshold/);
  assert.throws(() => providerHealthAggregate({ providerOf: () => 'x', errorRateThreshold: 1.5 }), /errorRateThreshold/);
});
test('providerHealthAggregate: throws on non-positive latencyP95Threshold', () => {
  assert.throws(() => providerHealthAggregate({ providerOf: () => 'x', latencyP95Threshold: 0 }), /latencyP95Threshold/);
});
test('providerHealthAggregate: throws on invalid minSampleSize', () => {
  assert.throws(() => providerHealthAggregate({ providerOf: () => 'x', minSampleSize: 0 }), /minSampleSize/);
});
test('providerHealthAggregate: throws on non-object scoreWeights', () => {
  assert.throws(() => providerHealthAggregate({ providerOf: () => 'x', scoreWeights: 'x' }), /scoreWeights/);
});
test('providerHealthAggregate: throws on non-function breakerFor', () => {
  assert.throws(() => providerHealthAggregate({ providerOf: () => 'x', breakerFor: 'x' }), /breakerFor/);
});
test('providerHealthAggregate: throws on non-function callback', () => {
  assert.throws(() => providerHealthAggregate({ providerOf: () => 'x', onDegraded: 'x' }), /callbacks/);
});

// ---- Basic sample tracking ---------------------------------

test('providerHealthAggregate: successful call records sample', async () => {
  const mw = providerHealthAggregate({ providerOf: () => 'openai' });
  await mw(ctxWith(), async () => ({ text: 'ok' }));
  const h = mw.getHealth('openai');
  assert.equal(h.samples, 1);
  assert.equal(h.totalCalls, 1);
  assert.equal(h.totalErrors, 0);
});

test('providerHealthAggregate: failed call recorded as error', async () => {
  const mw = providerHealthAggregate({ providerOf: () => 'openai' });
  await assert.rejects(mw(ctxWith(), async () => { throw new Error('down'); }));
  const h = mw.getHealth('openai');
  assert.equal(h.totalCalls, 1);
  assert.equal(h.totalErrors, 1);
});

test('providerHealthAggregate: multiple providers tracked independently', async () => {
  let call = 0;
  const providers = ['openai', 'anthropic', 'openai'];
  const mw = providerHealthAggregate({ providerOf: () => providers[call++] });
  await mw(ctxWith(), async () => ({}));
  await mw(ctxWith(), async () => ({}));
  await mw(ctxWith(), async () => ({}));
  assert.equal(mw.getHealth('openai').totalCalls, 2);
  assert.equal(mw.getHealth('anthropic').totalCalls, 1);
  assert.deepEqual(mw.listProviders().sort(), ['anthropic', 'openai']);
});

// ---- Health scoring ------------------------------------

test('providerHealthAggregate: all-success → score = 1', async () => {
  const mw = providerHealthAggregate({
    providerOf: () => 'openai', minSampleSize: 1,
  });
  for (let i = 0; i < 20; i++) {
    await mw(ctxWith(), async () => ({}));
  }
  const h = mw.getHealth('openai');
  assert.equal(h.errorRate, 0);
  assert.ok(h.score >= 0.9);   // some latency penalty possible from Date.now() jitter
  assert.equal(h.healthy, true);
});

test('providerHealthAggregate: high error rate flips healthy → degraded', async () => {
  const events = [];
  const mw = providerHealthAggregate({
    providerOf: () => 'openai',
    minSampleSize: 10, errorRateThreshold: 0.10,
    latencyP95Threshold: 1e9,   // effectively disable latency check
    onDegraded: (i) => events.push(i),
  });
  // 8 successes + 4 errors → 33% error rate, above 10% threshold.
  for (let i = 0; i < 8; i++) await mw(ctxWith(), async () => ({}));
  for (let i = 0; i < 4; i++) {
    await assert.rejects(mw(ctxWith(), async () => { throw new Error('e'); }));
  }
  const h = mw.getHealth('openai');
  assert.equal(h.healthy, false);
  assert.equal(events.length, 1);
  assert.ok(events[0].errorRate > 0.10);
});

test('providerHealthAggregate: recovery fires onRecovered', async () => {
  const events = [];
  const mw = providerHealthAggregate({
    providerOf: () => 'openai',
    minSampleSize: 5, errorRateThreshold: 0.10,
    latencyP95Threshold: 1e9,
    onRecovered: (i) => events.push(i),
  });
  // Degrade first.
  for (let i = 0; i < 5; i++) {
    await assert.rejects(mw(ctxWith(), async () => { throw new Error('e'); }));
  }
  assert.equal(mw.getHealth('openai').healthy, false);
  // Now flood with successes to push error rate down.
  for (let i = 0; i < 100; i++) {
    await mw(ctxWith(), async () => ({}));
  }
  assert.equal(mw.getHealth('openai').healthy, true);
  assert.equal(events.length, 1);
});

// ---- Sample size gate ------------------------

test('providerHealthAggregate: minSampleSize gate prevents early degrade', async () => {
  const events = [];
  const mw = providerHealthAggregate({
    providerOf: () => 'openai',
    minSampleSize: 20, errorRateThreshold: 0.10,
    latencyP95Threshold: 1e9,
    onDegraded: (i) => events.push(i),
  });
  // 5 errors — 100% error rate BUT below sample threshold.
  for (let i = 0; i < 5; i++) {
    await assert.rejects(mw(ctxWith(), async () => { throw new Error('e'); }));
  }
  // Should NOT have degraded yet.
  assert.equal(events.length, 0);
  assert.equal(mw.getHealth('openai').healthy, true);
});

// ---- Window pruning ------------------------

test('providerHealthAggregate: old samples pruned', async () => {
  let t = 1000;
  const mw = providerHealthAggregate({
    providerOf: () => 'openai',
    windowMs: 1000, minSampleSize: 1,
    now: () => t,
  });
  await mw(ctxWith(), async () => ({}));
  assert.equal(mw.getHealth('openai').samples, 1);
  t = 5000;
  const h = mw.getHealth('openai');
  assert.equal(h.samples, 0);
});

// ---- Provider extraction ----------------

test('providerHealthAggregate: providerOf can inspect result', async () => {
  const mw = providerHealthAggregate({
    providerOf: (_ctx, result) => result?.provider ?? 'unknown',
    minSampleSize: 1,
  });
  await mw(ctxWith(), async () => ({ provider: 'anthropic', text: 'ok' }));
  assert.equal(mw.getHealth('anthropic').totalCalls, 1);
});

test('providerHealthAggregate: providerOf returns non-string → skips tracking', async () => {
  const mw = providerHealthAggregate({ providerOf: () => null });
  await mw(ctxWith(), async () => ({}));
  assert.equal(mw.listProviders().length, 0);
});

test('providerHealthAggregate: providerOf throws → error captured, call still succeeds', async () => {
  const errors = [];
  const mw = providerHealthAggregate({
    providerOf: () => { throw new Error('extract failed'); },
    onError: (i) => errors.push(i),
  });
  const r = await mw(ctxWith(), async () => ({ text: 'ok' }));
  assert.equal(r.text, 'ok');
  assert.equal(errors[0].phase, 'providerOf');
});

// ---- breakerFor integration -------------

test('providerHealthAggregate: breaker in "open" state adds penalty', async () => {
  const breaker = { state: 'open' };
  const mw = providerHealthAggregate({
    providerOf: () => 'openai', minSampleSize: 1,
    breakerFor: () => breaker,
    scoreWeights: { errorRate: 0.5, latencyP95: 0.3, breakerState: 0.2 },
  });
  await mw(ctxWith(), async () => ({}));
  const h = mw.getHealth('openai');
  // Open breaker → penalty added → score < 1.
  assert.ok(h.score < 1);
});

test('providerHealthAggregate: breakerFor error captured', async () => {
  const errors = [];
  const mw = providerHealthAggregate({
    providerOf: () => 'openai', minSampleSize: 1,
    breakerFor: () => { throw new Error('breaker down'); },
    scoreWeights: { errorRate: 0.5, latencyP95: 0.3, breakerState: 0.2 },
    onError: (i) => errors.push(i),
  });
  await mw(ctxWith(), async () => ({}));
  // Reading health triggers computeMetrics which invokes breakerFor.
  mw.getHealth('openai');
  assert.ok(errors.some((e) => e.phase === 'breakerFor'));
});

// ---- Callbacks ---------------

test('providerHealthAggregate: onSample fires per call', async () => {
  const events = [];
  const mw = providerHealthAggregate({
    providerOf: () => 'openai',
    onSample: (i) => events.push(i),
  });
  await mw(ctxWith(), async () => ({}));
  await assert.rejects(mw(ctxWith(), async () => { throw new Error('e'); }));
  assert.equal(events.length, 2);
  assert.equal(events[0].ok, true);
  assert.equal(events[1].ok, false);
});

test('providerHealthAggregate: callback throws swallowed', async () => {
  const mw = providerHealthAggregate({
    providerOf: () => 'openai',
    minSampleSize: 1, errorRateThreshold: 0.5,
    latencyP95Threshold: 1e9,
    onSample: () => { throw new Error('x'); },
    onDegraded: () => { throw new Error('x'); },
  });
  await mw(ctxWith(), async () => ({}));
  for (let i = 0; i < 5; i++) {
    await assert.rejects(mw(ctxWith(), async () => { throw new Error('e'); }));
  }
});

// ---- getHealth returns default for unknown ----

test('providerHealthAggregate: getHealth for unknown provider returns healthy default', () => {
  const mw = providerHealthAggregate({ providerOf: () => 'openai' });
  const h = mw.getHealth('nonexistent');
  assert.equal(h.healthy, true);
  assert.equal(h.score, 1);
  assert.equal(h.samples, 0);
});

// ---- snapshotAll -------------

test('providerHealthAggregate: snapshotAll shape', async () => {
  let call = 0;
  const providers = ['a', 'b', 'a'];
  const mw = providerHealthAggregate({ providerOf: () => providers[call++] });
  await mw(ctxWith(), async () => ({}));
  await mw(ctxWith(), async () => ({}));
  await mw(ctxWith(), async () => ({}));
  const snap = mw.snapshotAll();
  assert.ok(snap.a && snap.b);
  assert.equal(snap.a.totalCalls, 2);
  assert.equal(snap.b.totalCalls, 1);
});

// ---- Stats + MCP + reset --------

test('providerHealthAggregate: transitions counter tracked', async () => {
  const mw = providerHealthAggregate({
    providerOf: () => 'openai',
    minSampleSize: 5, errorRateThreshold: 0.10,
    latencyP95Threshold: 1e9,
  });
  for (let i = 0; i < 5; i++) {
    await assert.rejects(mw(ctxWith(), async () => { throw new Error('e'); }));
  }
  assert.equal(mw.stats.degradedTransitions, 1);
  for (let i = 0; i < 100; i++) await mw(ctxWith(), async () => ({}));
  assert.equal(mw.stats.recoveredTransitions, 1);
});

test('providerHealthAggregate: reset clears state', async () => {
  const mw = providerHealthAggregate({ providerOf: () => 'openai' });
  await mw(ctxWith(), async () => ({}));
  assert.equal(mw.stats.totalCalls, 1);
  mw.reset();
  assert.equal(mw.stats.totalCalls, 0);
  assert.equal(mw.listProviders().length, 0);
});

test('providerHealthAggregate: asMcpResource', () => {
  const mw = providerHealthAggregate({
    providerOf: () => 'openai',
    windowMs: 30_000, errorRateThreshold: 0.05, latencyP95Threshold: 5000,
  });
  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://provider-health-aggregate');
  const p = r.handler();
  assert.equal(p.windowMs, 30_000);
  assert.equal(p.errorRateThreshold, 0.05);
  assert.equal(p.latencyP95Threshold, 5000);
});
