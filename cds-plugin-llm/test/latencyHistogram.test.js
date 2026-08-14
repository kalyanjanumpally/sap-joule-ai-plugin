const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_lh__';
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
  latencyHistogram,
  DEFAULT_BUCKETS_MS,
} = require('../lib/middleware/latencyHistogram');

function ctxWith(dims = {}) { return { request: dims }; }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Exports ------------------------------------------------

test('DEFAULT_BUCKETS_MS is frozen + Prometheus-canonical', () => {
  assert.ok(Object.isFrozen(DEFAULT_BUCKETS_MS));
  assert.deepEqual([...DEFAULT_BUCKETS_MS], [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]);
});

// ---- Validation ------------------------------

test('latencyHistogram: throws on non-function dimensionsOf', () => {
  assert.throws(() => latencyHistogram({ dimensionsOf: 'x' }), /dimensionsOf/);
});
test('latencyHistogram: throws on empty buckets', () => {
  assert.throws(() => latencyHistogram({ buckets: [] }), /buckets/);
});
test('latencyHistogram: throws on non-positive bucket', () => {
  assert.throws(() => latencyHistogram({ buckets: [10, 0, 100] }), /must be > 0/);
});
test('latencyHistogram: throws on non-positive overThresholdMs', () => {
  assert.throws(() => latencyHistogram({ overThresholdMs: 0 }), /overThresholdMs/);
});
test('latencyHistogram: throws on out-of-range percentile', () => {
  assert.throws(() => latencyHistogram({ overThresholdMs: 100, overThresholdPercentile: 100 }), /overThresholdPercentile/);
});
test('latencyHistogram: throws on non-function callback', () => {
  assert.throws(() => latencyHistogram({ onOverThreshold: 'x' }), /callbacks/);
});

// ---- Basic instrumentation ------------------

test('latencyHistogram: records latency per call', async () => {
  const mw = latencyHistogram();
  for (let i = 0; i < 5; i++) await mw(ctxWith(), async () => 'ok');
  assert.equal(mw.stats.totalCalls, 5);
});

test('latencyHistogram: dimensions extracted + bucketed', async () => {
  const mw = latencyHistogram({
    dimensionsOf: (ctx) => ({ model: ctx.request.model }),
  });
  for (let i = 0; i < 3; i++) await mw(ctxWith({ model: 'gpt-4o' }), async () => 'ok');
  for (let i = 0; i < 2; i++) await mw(ctxWith({ model: 'claude' }), async () => 'ok');
  const snap = mw.snapshot();
  const keys = Object.keys(snap);
  assert.equal(keys.length, 2);
  assert.equal(snap['model=gpt-4o'].count, 3);
  assert.equal(snap['model=claude'].count, 2);
});

test('latencyHistogram: same dimensions merge into one bucket', async () => {
  const mw = latencyHistogram({
    dimensionsOf: () => ({ model: 'x' }),
  });
  for (let i = 0; i < 10; i++) await mw(ctxWith(), async () => 'ok');
  assert.equal(mw.stats.dimensionsCount, 1);
});

// ---- Percentiles -----------------------

test('latencyHistogram: p50 approximately matches sample distribution', async () => {
  const mw = latencyHistogram({
    dimensionsOf: () => ({}),
    buckets: [10, 50, 100, 500, 1000],
    // Use synthetic samples via direct call in test.
  });
  // 100 samples: all under 100ms latency (real timing).
  for (let i = 0; i < 100; i++) await mw(ctxWith(), async () => 'ok');
  const p = mw.getPercentiles();
  // All samples should be very fast — p50 should land in the 10ms bucket.
  assert.ok(p.p50 <= 50, `expected p50 <= 50ms, got ${p.p50}`);
  assert.equal(p.count, 100);
});

test('latencyHistogram: filter applies to matching dimensions only', async () => {
  const mw = latencyHistogram({
    dimensionsOf: (ctx) => ({ model: ctx.request.model }),
  });
  for (let i = 0; i < 3; i++) await mw(ctxWith({ model: 'a' }), async () => 'ok');
  for (let i = 0; i < 5; i++) await mw(ctxWith({ model: 'b' }), async () => 'ok');
  const pa = mw.getPercentiles({ model: 'a' });
  const pb = mw.getPercentiles({ model: 'b' });
  const pAll = mw.getPercentiles();
  assert.equal(pa.count, 3);
  assert.equal(pb.count, 5);
  assert.equal(pAll.count, 8);
});

test('latencyHistogram: custom percentiles requested', async () => {
  const mw = latencyHistogram();
  await mw(ctxWith(), async () => 'ok');
  const p = mw.getPercentiles(null, [10, 90, 99.9]);
  assert.ok('p10' in p);
  assert.ok('p90' in p);
  assert.ok('p99.9' in p);
});

// ---- Empty state ------------

test('latencyHistogram: getPercentiles with no data returns count 0', async () => {
  const mw = latencyHistogram();
  const p = mw.getPercentiles();
  assert.equal(p.count, 0);
  assert.equal(p.p95, 0);
});

// ---- Bucket assignment correctness ----------

test('latencyHistogram: slow call lands in appropriate bucket', async () => {
  const mw = latencyHistogram({ buckets: [10, 50, 100, 500] });
  // Force a real 60ms latency.
  await mw(ctxWith(), async () => { await wait(60); return 'slow'; });
  const p = mw.getPercentiles();
  // p95 of a single 60ms sample lands in the 100ms bucket.
  assert.ok(p.p95 >= 60);
  assert.ok(p.p95 <= 100);
});

test('latencyHistogram: sum + mean tracked', async () => {
  const mw = latencyHistogram();
  for (let i = 0; i < 3; i++) await mw(ctxWith(), async () => 'ok');
  const p = mw.getPercentiles();
  assert.ok(p.sum >= 0);
  assert.equal(p.mean, p.sum / 3);
});

// ---- Over-threshold rising edge --------------

test('latencyHistogram: onOverThreshold fires when p95 exceeds', async () => {
  const events = [];
  const mw = latencyHistogram({
    dimensionsOf: () => ({}),
    buckets: [10, 50, 200, 500],
    overThresholdMs: 100,
    overThresholdPercentile: 95,
    onOverThreshold: (i) => events.push(i),
  });
  // Fire 20 slow calls (~200ms each) → p95 should be ≥ 200 > 100.
  for (let i = 0; i < 20; i++) {
    await mw(ctxWith(), async () => { await wait(150); return 'slow'; });
  }
  assert.ok(events.length >= 1, `expected fires, got ${events.length}`);
  assert.equal(events[0].percentile, 95);
  assert.ok(events[0].value > events[0].threshold);
});

test('latencyHistogram: onOverThreshold is rising-edge (fires once)', async () => {
  const events = [];
  const mw = latencyHistogram({
    buckets: [10, 50, 200, 500],
    overThresholdMs: 30,
    onOverThreshold: () => events.push(1),
  });
  // Force sustained breach.
  for (let i = 0; i < 20; i++) {
    await mw(ctxWith(), async () => { await wait(80); return 'slow'; });
  }
  // Should fire once at first breach, not repeatedly.
  assert.equal(events.length, 1);
});

// ---- Dimensions error -------------

test('latencyHistogram: dimensionsOf throws → captured, still records', async () => {
  const errors = [];
  const mw = latencyHistogram({
    dimensionsOf: () => { throw new Error('dim bug'); },
    onError: (i) => errors.push(i),
  });
  await mw(ctxWith(), async () => 'ok');
  assert.equal(mw.stats.dimensionErrors, 1);
  assert.equal(errors[0].phase, 'dimensionsOf');
  // Still recorded a sample under empty dims.
  const p = mw.getPercentiles();
  assert.equal(p.count, 1);
});

// ---- Downstream error --------

test('latencyHistogram: downstream throw → latency still recorded, error propagates', async () => {
  const mw = latencyHistogram();
  await assert.rejects(mw(ctxWith(), async () => { throw new Error('down'); }), /down/);
  const p = mw.getPercentiles();
  assert.equal(p.count, 1);
});

// ---- Callbacks ---------

test('latencyHistogram: callback throws swallowed', async () => {
  const mw = latencyHistogram({
    buckets: [10, 100],
    overThresholdMs: 30,
    onOverThreshold: () => { throw new Error('bug'); },
  });
  for (let i = 0; i < 20; i++) {
    await mw(ctxWith(), async () => { await wait(50); return 'slow'; });
  }
});

// ---- Prometheus export ----------

test('latencyHistogram: prometheusHistograms produces valid text format', async () => {
  const mw = latencyHistogram({
    dimensionsOf: (ctx) => ({ model: ctx.request.model }),
  });
  await mw(ctxWith({ model: 'gpt-4o' }), async () => 'ok');
  await mw(ctxWith({ model: 'gpt-4o' }), async () => 'ok');
  const text = mw.prometheusHistograms('llm_latency_ms');
  assert.ok(text.includes('# TYPE llm_latency_ms histogram'));
  assert.ok(text.includes('llm_latency_ms_bucket'));
  assert.ok(text.includes('model="gpt-4o"'));
  assert.ok(text.includes('llm_latency_ms_sum'));
  assert.ok(text.includes('llm_latency_ms_count'));
  assert.ok(text.includes('le="+Inf"'));
});

test('latencyHistogram: prometheus label quoting escapes double quotes', async () => {
  const mw = latencyHistogram({
    dimensionsOf: () => ({ tag: 'has"quote' }),
  });
  await mw(ctxWith(), async () => 'ok');
  const text = mw.prometheusHistograms();
  assert.ok(text.includes('tag="has\\"quote"'));
});

// ---- Custom buckets ----------

test('latencyHistogram: custom buckets used', async () => {
  const mw = latencyHistogram({ buckets: [100, 1000] });
  await mw(ctxWith(), async () => 'ok');
  const snap = mw.snapshot();
  const s = Object.values(snap)[0];
  // 3 buckets total: [<=100, <=1000, +Inf].
  assert.equal(s.p50, 100);   // fast sample → first bucket
});

// ---- Reset + MCP + snapshot -------

test('latencyHistogram: snapshot returns per-dimension breakdown', async () => {
  const mw = latencyHistogram({
    dimensionsOf: (ctx) => ({ model: ctx.request.model }),
  });
  await mw(ctxWith({ model: 'a' }), async () => 'ok');
  await mw(ctxWith({ model: 'b' }), async () => 'ok');
  const snap = mw.snapshot();
  assert.equal(Object.keys(snap).length, 2);
  for (const s of Object.values(snap)) {
    assert.ok('p50' in s && 'p95' in s && 'p99' in s);
  }
});

test('latencyHistogram: reset clears all data', async () => {
  const mw = latencyHistogram();
  await mw(ctxWith(), async () => 'ok');
  assert.equal(mw.stats.totalCalls, 1);
  mw.reset();
  assert.equal(mw.stats.totalCalls, 0);
  const p = mw.getPercentiles();
  assert.equal(p.count, 0);
});

test('latencyHistogram: asMcpResource', () => {
  const mw = latencyHistogram({
    buckets: [50, 100, 500],
    overThresholdMs: 200, overThresholdPercentile: 99,
  });
  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://latency-histogram');
  const p = r.handler();
  assert.deepEqual(p.buckets, [50, 100, 500]);
  assert.equal(p.overThresholdMs, 200);
  assert.equal(p.overThresholdPercentile, 99);
});
