const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_ufa__';
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
  userFeedbackAggregator,
  normalizeBinary,
  normalizeScale,
} = require('../lib/middleware/userFeedbackAggregator');

function ctxWith(dimensions = {}) { return { request: {}, meta: dimensions }; }

// ---- normalizeBinary --------------------------------------

test('normalizeBinary: various positive inputs', () => {
  assert.equal(normalizeBinary('up'), 1);
  assert.equal(normalizeBinary(1), 1);
  assert.equal(normalizeBinary(true), 1);
});
test('normalizeBinary: various negative inputs', () => {
  assert.equal(normalizeBinary('down'), -1);
  assert.equal(normalizeBinary(-1), -1);
  assert.equal(normalizeBinary(false), -1);
});
test('normalizeBinary: neutral', () => {
  assert.equal(normalizeBinary(0), 0);
  assert.equal(normalizeBinary('neutral'), 0);
});
test('normalizeBinary: invalid → null', () => {
  assert.equal(normalizeBinary('maybe'), null);
  assert.equal(normalizeBinary(null), null);
});

// ---- normalizeScale --------------------

test('normalizeScale: in-range → same value', () => {
  assert.equal(normalizeScale(3, 1, 5), 3);
});
test('normalizeScale: out-of-range → null', () => {
  assert.equal(normalizeScale(0, 1, 5), null);
  assert.equal(normalizeScale(6, 1, 5), null);
});
test('normalizeScale: non-number → null', () => {
  assert.equal(normalizeScale('4', 1, 5), null);
});

// ---- Validation ------------------------------------

test('userFeedbackAggregator: throws on unknown ratingKind', () => {
  assert.throws(() => userFeedbackAggregator({ ratingKind: 'bogus' }), /ratingKind/);
});
test('userFeedbackAggregator: throws on non-function dimensionsOf', () => {
  assert.throws(() => userFeedbackAggregator({ dimensionsOf: 'x' }), /dimensionsOf/);
});
test('userFeedbackAggregator: scale requires valid min/max', () => {
  assert.throws(() => userFeedbackAggregator({
    ratingKind: 'scale', scaleMin: 5, scaleMax: 1,
  }), /scaleMin/);
});
test('userFeedbackAggregator: scale positivityThreshold in range', () => {
  assert.throws(() => userFeedbackAggregator({
    ratingKind: 'scale', scaleMin: 1, scaleMax: 5, positivityThreshold: 10,
  }), /positivityThreshold/);
});
test('userFeedbackAggregator: custom requires positivityOf', () => {
  assert.throws(() => userFeedbackAggregator({ ratingKind: 'custom' }), /positivityOf/);
});
test('userFeedbackAggregator: throws on tiny windowMs', () => {
  assert.throws(() => userFeedbackAggregator({ windowMs: 500 }), /windowMs/);
});
test('userFeedbackAggregator: throws on empty attachIdAs', () => {
  assert.throws(() => userFeedbackAggregator({ attachIdAs: '' }), /attachIdAs/);
});
test('userFeedbackAggregator: throws on non-function callback', () => {
  assert.throws(() => userFeedbackAggregator({ onFeedback: 'x' }), /callbacks/);
});

// ---- Middleware attaches feedback ID -----------------

test('userFeedbackAggregator: attaches feedbackId to result', async () => {
  const mw = userFeedbackAggregator();
  const r = await mw(ctxWith(), async () => ({ text: 'ok' }));
  assert.ok(typeof r.feedbackId === 'string');
  assert.ok(r.feedbackId.startsWith('fb-'));
});

test('userFeedbackAggregator: custom attachIdAs field', async () => {
  const mw = userFeedbackAggregator({ attachIdAs: 'ratingKey' });
  const r = await mw(ctxWith(), async () => ({ text: 'ok' }));
  assert.equal(r.feedbackId, undefined);
  assert.ok(r.ratingKey);
});

test('userFeedbackAggregator: non-object result skipped', async () => {
  const mw = userFeedbackAggregator();
  const r = await mw(ctxWith(), async () => 'plain string');
  assert.equal(r, 'plain string');
});

test('userFeedbackAggregator: unique IDs per call', async () => {
  const mw = userFeedbackAggregator();
  const ids = new Set();
  for (let i = 0; i < 100; i++) {
    const r = await mw(ctxWith(), async () => ({}));
    ids.add(r.feedbackId);
  }
  assert.equal(ids.size, 100);
});

// ---- Binary rating flow --------------------

test('userFeedbackAggregator: binary submitFeedback records positive', async () => {
  const mw = userFeedbackAggregator();
  const r = await mw(ctxWith(), async () => ({ text: 'ok' }));
  const s = mw.submitFeedback(r.feedbackId, 'up');
  assert.equal(s.accepted, true);
  assert.equal(mw.stats.positiveFeedback, 1);
});

test('userFeedbackAggregator: binary submitFeedback records negative', async () => {
  const mw = userFeedbackAggregator();
  const r = await mw(ctxWith(), async () => ({ text: 'ok' }));
  mw.submitFeedback(r.feedbackId, 'down');
  assert.equal(mw.stats.negativeFeedback, 1);
});

test('userFeedbackAggregator: unknown feedbackId rejected', () => {
  const mw = userFeedbackAggregator();
  const s = mw.submitFeedback('bogus-id', 'up');
  assert.equal(s.accepted, false);
  assert.equal(s.reason, 'unknown-id');
  assert.equal(mw.stats.unknownIds, 1);
});

test('userFeedbackAggregator: invalid rating rejected', async () => {
  const mw = userFeedbackAggregator();
  const r = await mw(ctxWith(), async () => ({}));
  const s = mw.submitFeedback(r.feedbackId, 'maybe');
  assert.equal(s.accepted, false);
  assert.equal(s.reason, 'invalid-rating');
  assert.equal(mw.stats.invalidRatings, 1);
});

test('userFeedbackAggregator: multiple ratings per response allowed', async () => {
  const mw = userFeedbackAggregator();
  const r = await mw(ctxWith(), async () => ({}));
  mw.submitFeedback(r.feedbackId, 'up');
  mw.submitFeedback(r.feedbackId, 'down');
  assert.equal(mw.stats.totalFeedback, 2);
});

// ---- Scale ratings --------------------

test('userFeedbackAggregator: scale rating 4/5 → positive', async () => {
  const mw = userFeedbackAggregator({ ratingKind: 'scale', scaleMin: 1, scaleMax: 5, positivityThreshold: 4 });
  const r = await mw(ctxWith(), async () => ({}));
  mw.submitFeedback(r.feedbackId, 4);
  assert.equal(mw.stats.positiveFeedback, 1);
});

test('userFeedbackAggregator: scale rating 3/5 → negative (below threshold)', async () => {
  const mw = userFeedbackAggregator({ ratingKind: 'scale', scaleMin: 1, scaleMax: 5, positivityThreshold: 4 });
  const r = await mw(ctxWith(), async () => ({}));
  mw.submitFeedback(r.feedbackId, 3);
  assert.equal(mw.stats.negativeFeedback, 1);
});

test('userFeedbackAggregator: scale out-of-range rejected', async () => {
  const mw = userFeedbackAggregator({ ratingKind: 'scale', scaleMin: 1, scaleMax: 5 });
  const r = await mw(ctxWith(), async () => ({}));
  const s = mw.submitFeedback(r.feedbackId, 10);
  assert.equal(s.accepted, false);
  assert.equal(s.reason, 'invalid-rating');
});

// ---- Custom ratings ------------------

test('userFeedbackAggregator: custom positivityOf', async () => {
  const mw = userFeedbackAggregator({
    ratingKind: 'custom',
    positivityOf: (r) => r > 0.7,
  });
  const r = await mw(ctxWith(), async () => ({}));
  mw.submitFeedback(r.feedbackId, 0.9);
  assert.equal(mw.stats.positiveFeedback, 1);
  const r2 = await mw(ctxWith(), async () => ({}));
  mw.submitFeedback(r2.feedbackId, 0.3);
  assert.equal(mw.stats.negativeFeedback, 1);
});

test('userFeedbackAggregator: custom rejects non-number', async () => {
  const mw = userFeedbackAggregator({
    ratingKind: 'custom',
    positivityOf: () => true,
  });
  const r = await mw(ctxWith(), async () => ({}));
  const s = mw.submitFeedback(r.feedbackId, 'high');
  assert.equal(s.accepted, false);
});

// ---- Dimensions + aggregation ---------

test('userFeedbackAggregator: dimensions attached to entries', async () => {
  const mw = userFeedbackAggregator({
    dimensionsOf: (ctx) => ({ template: ctx.request.template, model: ctx.request.model }),
  });
  const ctx = { request: { template: 'summarize', model: 'gpt-4o' } };
  const r = await mw(ctx, async () => ({}));
  mw.submitFeedback(r.feedbackId, 'up');
  const agg = mw.getAggregate({ template: 'summarize' });
  assert.equal(agg.totalRatings, 1);
  assert.equal(agg.positive, 1);
  assert.equal(agg.positiveRate, 1);
});

test('userFeedbackAggregator: getAggregate filters correctly', async () => {
  const mw = userFeedbackAggregator({
    dimensionsOf: (ctx) => ({ template: ctx.request.template }),
  });
  const rA = await mw({ request: { template: 'A' } }, async () => ({}));
  const rB = await mw({ request: { template: 'B' } }, async () => ({}));
  mw.submitFeedback(rA.feedbackId, 'up');
  mw.submitFeedback(rB.feedbackId, 'down');
  const aggA = mw.getAggregate({ template: 'A' });
  const aggB = mw.getAggregate({ template: 'B' });
  assert.equal(aggA.positive, 1);
  assert.equal(aggA.negative, 0);
  assert.equal(aggB.positive, 0);
  assert.equal(aggB.negative, 1);
});

test('userFeedbackAggregator: getAggregate with no filter → all data', async () => {
  const mw = userFeedbackAggregator();
  const r1 = await mw(ctxWith(), async () => ({}));
  const r2 = await mw(ctxWith(), async () => ({}));
  mw.submitFeedback(r1.feedbackId, 'up');
  mw.submitFeedback(r2.feedbackId, 'down');
  const agg = mw.getAggregate();
  assert.equal(agg.totalRatings, 2);
  assert.equal(agg.positive, 1);
  assert.equal(agg.negative, 1);
  assert.equal(agg.positiveRate, 0.5);
});

test('userFeedbackAggregator: snapshotByDimension groups by key', async () => {
  const mw = userFeedbackAggregator({
    dimensionsOf: (ctx) => ({ model: ctx.request.model }),
  });
  const r1 = await mw({ request: { model: 'gpt-4o' } }, async () => ({}));
  const r2 = await mw({ request: { model: 'gpt-4o' } }, async () => ({}));
  const r3 = await mw({ request: { model: 'claude' } }, async () => ({}));
  mw.submitFeedback(r1.feedbackId, 'up');
  mw.submitFeedback(r2.feedbackId, 'up');
  mw.submitFeedback(r3.feedbackId, 'down');
  const snap = mw.snapshotByDimension('model');
  assert.equal(snap['gpt-4o'].positive, 2);
  assert.equal(snap['gpt-4o'].positiveRate, 1);
  assert.equal(snap['claude'].positive, 0);
  assert.equal(snap['claude'].positiveRate, 0);
});

test('userFeedbackAggregator: snapshotByDimension missing dimension → __none__ bucket', async () => {
  const mw = userFeedbackAggregator();
  const r = await mw(ctxWith(), async () => ({}));
  mw.submitFeedback(r.feedbackId, 'up');
  const snap = mw.snapshotByDimension('nonexistent');
  assert.ok(snap.__none__);
  assert.equal(snap.__none__.total, 1);
});

// ---- Window pruning ---------

test('userFeedbackAggregator: old entries pruned on aggregate query', async () => {
  let t = 1000;
  const mw = userFeedbackAggregator({ windowMs: 1000, now: () => t });
  const r = await mw(ctxWith(), async () => ({}));
  mw.submitFeedback(r.feedbackId, 'up');
  t = 5000;
  const agg = mw.getAggregate();
  assert.equal(agg.totalRatings, 0);
  assert.ok(mw.stats.prunedEntries > 0);
});

// ---- Errors ------------------

test('userFeedbackAggregator: dimensionsOf throws → captured, response still attached', async () => {
  const errors = [];
  const mw = userFeedbackAggregator({
    dimensionsOf: () => { throw new Error('dim bug'); },
    onError: (i) => errors.push(i),
  });
  const r = await mw(ctxWith(), async () => ({}));
  assert.ok(r.feedbackId);
  assert.equal(mw.stats.dimensionErrors, 1);
  assert.equal(errors[0].phase, 'dimensionsOf');
});

// ---- Callbacks -------------

test('userFeedbackAggregator: onFeedback fires per submission', async () => {
  const events = [];
  const mw = userFeedbackAggregator({ onFeedback: (i) => events.push(i) });
  const r = await mw(ctxWith(), async () => ({}));
  mw.submitFeedback(r.feedbackId, 'up');
  assert.equal(events.length, 1);
  assert.equal(events[0].positive, true);
});

test('userFeedbackAggregator: callback throws swallowed', async () => {
  const mw = userFeedbackAggregator({
    onFeedback: () => { throw new Error('x'); },
  });
  const r = await mw(ctxWith(), async () => ({}));
  const s = mw.submitFeedback(r.feedbackId, 'up');
  assert.equal(s.accepted, true);
});

// ---- MCP + reset + pendingCount ----------

test('userFeedbackAggregator: pendingCount', async () => {
  const mw = userFeedbackAggregator();
  await mw(ctxWith(), async () => ({}));
  await mw(ctxWith(), async () => ({}));
  assert.equal(mw.pendingCount(), 2);
});

test('userFeedbackAggregator: reset clears state', async () => {
  const mw = userFeedbackAggregator();
  const r = await mw(ctxWith(), async () => ({}));
  mw.submitFeedback(r.feedbackId, 'up');
  mw.reset();
  assert.equal(mw.stats.totalFeedback, 0);
  assert.equal(mw.pendingCount(), 0);
});

test('userFeedbackAggregator: asMcpResource', () => {
  const mw = userFeedbackAggregator({
    ratingKind: 'scale', scaleMin: 1, scaleMax: 5, positivityThreshold: 4,
  });
  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://user-feedback');
  const p = r.handler();
  assert.equal(p.ratingKind, 'scale');
  assert.equal(p.scaleMin, 1);
  assert.equal(p.scaleMax, 5);
  assert.equal(p.positivityThreshold, 4);
});
