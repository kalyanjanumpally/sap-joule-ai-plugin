const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_ba__';
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
  batchAggregator,
  BatchAggregationError,
} = require('../lib/middleware/batchAggregator');

// ---- Helpers ----------------------------------------------------------

function ctxWith(item, extra = {}) {
  return { request: { prompt: item, ...extra } };
}

// Classification-style aggregation: N prompts → 1 aggregated
// request; response splits back to N results.
function classifyAggregate(batch) {
  return {
    prompt: 'Classify:\n' + batch.map((b, i) => `${i + 1}. ${b.ctx.request.prompt}`).join('\n'),
    __batchSize: batch.length,
  };
}
function classifySplit(result, batch) {
  // The downstream should have returned an array of labels.
  const labels = Array.isArray(result?.labels) ? result.labels : [];
  return batch.map((b, i) => ({ label: labels[i] ?? null, item: b.ctx.request.prompt }));
}

// ---- Validation ------------------------------------------------------

test('batchAggregator: throws on non-integer batchWindowMs', () => {
  assert.throws(() => batchAggregator({
    batchWindowMs: -1, aggregateRequests: () => ({}), splitResponse: () => [],
  }), /batchWindowMs/);
});
test('batchAggregator: throws on tiny maxBatchSize', () => {
  assert.throws(() => batchAggregator({
    maxBatchSize: 1, aggregateRequests: () => ({}), splitResponse: () => [],
  }), /maxBatchSize/);
});
test('batchAggregator: throws without aggregateRequests', () => {
  assert.throws(() => batchAggregator({
    splitResponse: () => [],
  }), /aggregateRequests/);
});
test('batchAggregator: throws without splitResponse', () => {
  assert.throws(() => batchAggregator({
    aggregateRequests: () => ({}),
  }), /splitResponse/);
});
test('batchAggregator: throws on non-function batchable', () => {
  assert.throws(() => batchAggregator({
    aggregateRequests: () => ({}), splitResponse: () => [], batchable: 'x',
  }), /batchable/);
});
test('batchAggregator: throws on non-function batchKeyOf', () => {
  assert.throws(() => batchAggregator({
    aggregateRequests: () => ({}), splitResponse: () => [], batchKeyOf: 'x',
  }), /batchKeyOf/);
});
test('batchAggregator: throws on non-function callback', () => {
  assert.throws(() => batchAggregator({
    aggregateRequests: () => ({}), splitResponse: () => [], onBatch: 'x',
  }), /callbacks/);
});

// ---- Basic batching ------------------------------------------

test('batchAggregator: 3 concurrent calls coalesced into 1 upstream call', async () => {
  let upstreamCalls = 0;
  const mw = batchAggregator({
    batchWindowMs: 30,
    aggregateRequests: classifyAggregate,
    splitResponse:     classifySplit,
  });
  const results = await Promise.all([
    mw(ctxWith('ticket-1'), async () => { upstreamCalls++; return { labels: ['billing'] }; }),
    mw(ctxWith('ticket-2'), async () => { upstreamCalls++; return { labels: ['bug'] }; }),
    mw(ctxWith('ticket-3'), async () => { upstreamCalls++; return { labels: ['question'] }; }),
  ]);
  // Only ONE upstream call.
  assert.equal(upstreamCalls, 1);
  // 3 individual results split from a single upstream response.
  assert.equal(results.length, 3);
  assert.equal(mw.stats.batchesFlushed, 1);
  assert.equal(mw.stats.batched, 3);
});

test('batchAggregator: split correctly delivers per-caller results', async () => {
  const mw = batchAggregator({
    batchWindowMs: 30,
    aggregateRequests: classifyAggregate,
    splitResponse:     classifySplit,
  });
  // Downstream returns labels for all 3 items in order.
  const [r1, r2, r3] = await Promise.all([
    mw(ctxWith('a'), async () => ({ labels: ['A', 'B', 'C'] })),
    mw(ctxWith('b'), async () => ({ labels: ['A', 'B', 'C'] })),
    mw(ctxWith('c'), async () => ({ labels: ['A', 'B', 'C'] })),
  ]);
  assert.equal(r1.label, 'A');
  assert.equal(r2.label, 'B');
  assert.equal(r3.label, 'C');
});

// ---- maxBatchSize triggers immediate flush ----------------

test('batchAggregator: maxBatchSize triggers immediate flush', async () => {
  const mw = batchAggregator({
    batchWindowMs: 10_000,   // long window
    maxBatchSize: 3,          // but hit size cap first
    aggregateRequests: (b) => ({ __size: b.length }),
    splitResponse:     (_r, b) => b.map(() => ({ ok: true })),
  });
  const startedAt = Date.now();
  await Promise.all([
    mw(ctxWith('a'), async (arg) => ({ ok: true })),
    mw(ctxWith('b'), async (arg) => ({ ok: true })),
    mw(ctxWith('c'), async (arg) => ({ ok: true })),
  ]);
  const elapsed = Date.now() - startedAt;
  // Should flush at 3, way before the 10s window.
  assert.ok(elapsed < 1000, `expected fast flush (got ${elapsed}ms)`);
  assert.equal(mw.stats.fullBatches, 1);
  assert.equal(mw.stats.windowFlushes, 0);
});

// ---- Window timer flushes small batches ------------

test('batchAggregator: window timer flushes small batches', async () => {
  const mw = batchAggregator({
    batchWindowMs: 20,
    maxBatchSize: 100,
    aggregateRequests: (b) => ({ __size: b.length }),
    splitResponse:     (_r, b) => b.map(() => ({ ok: true })),
  });
  const startedAt = Date.now();
  await mw(ctxWith('solo'), async () => ({ ok: true }));
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 15, `expected >= 15ms (got ${elapsed})`);
  assert.equal(mw.stats.windowFlushes, 1);
});

// ---- batchable predicate ------------------------

test('batchAggregator: batchable=false passes through unbatched', async () => {
  const mw = batchAggregator({
    batchWindowMs: 30,
    batchable: (ctx) => ctx.request.prompt.startsWith('batch:'),
    aggregateRequests: (b) => ({ __size: b.length }),
    splitResponse:     (_r, b) => b.map(() => ({ ok: true })),
  });
  const r = await mw(ctxWith('single'), async () => ({ text: 'ok' }));
  assert.deepEqual(r, { text: 'ok' });
  assert.equal(mw.stats.unbatched, 1);
  assert.equal(mw.stats.batched, 0);
  assert.equal(mw.stats.batchesFlushed, 0);
});

test('batchAggregator: batchable mix — batchable batched, non-batchable straight through', async () => {
  let upstream = 0;
  const mw = batchAggregator({
    batchWindowMs: 20,
    batchable: (ctx) => ctx.request.prompt.startsWith('batch:'),
    aggregateRequests: (b) => ({ __size: b.length }),
    splitResponse:     (_r, b) => b.map((m) => ({ item: m.ctx.request.prompt })),
  });
  const [r1, r2, r3] = await Promise.all([
    mw(ctxWith('single-1'), async () => { upstream++; return { text: 'S1' }; }),
    mw(ctxWith('batch:a'),  async () => { upstream++; return { text: 'B' }; }),
    mw(ctxWith('batch:b'),  async () => { upstream++; return { text: 'B' }; }),
  ]);
  assert.equal(upstream, 2);   // 1 unbatched + 1 batch upstream call
  assert.equal(r1.text, 'S1');
  assert.equal(r2.item, 'batch:a');
  assert.equal(r3.item, 'batch:b');
});

// ---- batchKeyOf isolation --------------------

test('batchAggregator: batchKeyOf isolates batches per key', async () => {
  let upstream = 0;
  const mw = batchAggregator({
    batchWindowMs: 20,
    batchKeyOf: (ctx) => ctx.request.model,
    aggregateRequests: (b) => ({ __size: b.length, __model: b[0].ctx.request.model }),
    splitResponse:     (_r, b) => b.map((m) => ({ model: m.ctx.request.model })),
  });
  const [r1, r2, r3, r4] = await Promise.all([
    mw(ctxWith('a', { model: 'M1' }), async () => { upstream++; return {}; }),
    mw(ctxWith('b', { model: 'M2' }), async () => { upstream++; return {}; }),
    mw(ctxWith('c', { model: 'M1' }), async () => { upstream++; return {}; }),
    mw(ctxWith('d', { model: 'M2' }), async () => { upstream++; return {}; }),
  ]);
  // 2 upstream calls: one for M1, one for M2.
  assert.equal(upstream, 2);
  assert.equal(mw.stats.batchesFlushed, 2);
});

// ---- Error handling ----------------------

test('batchAggregator: aggregateRequests throws → all members fail', async () => {
  const errors = [];
  const mw = batchAggregator({
    batchWindowMs: 20,
    aggregateRequests: () => { throw new Error('agg-broke'); },
    splitResponse:     () => [],
    onError: (i) => errors.push(i),
  });
  const results = await Promise.allSettled([
    mw(ctxWith('a'), async () => ({})),
    mw(ctxWith('b'), async () => ({})),
  ]);
  for (const r of results) {
    assert.equal(r.status, 'rejected');
    assert.ok(r.reason instanceof BatchAggregationError);
    assert.equal(r.reason.code, 'BATCH_AGGREGATION_FAILED');
  }
  assert.equal(mw.stats.failedBatches, 1);
  assert.equal(errors[0].phase, 'aggregateRequests');
});

test('batchAggregator: downstream throws → all members fail', async () => {
  const mw = batchAggregator({
    batchWindowMs: 20,
    aggregateRequests: (b) => ({ __size: b.length }),
    splitResponse:     () => [],
  });
  const results = await Promise.allSettled([
    mw(ctxWith('a'), async () => { throw new Error('provider down'); }),
    mw(ctxWith('b'), async () => { throw new Error('provider down'); }),
  ]);
  for (const r of results) {
    assert.equal(r.status, 'rejected');
    assert.equal(r.reason.code, 'BATCH_AGGREGATION_FAILED');
    assert.equal(r.reason.cause.message, 'provider down');
  }
});

test('batchAggregator: splitResponse returns wrong count → all members fail', async () => {
  const mw = batchAggregator({
    batchWindowMs: 20,
    aggregateRequests: (b) => ({ __size: b.length }),
    splitResponse:     (_r, b) => [{ ok: true }],   // returns only 1 for a batch of 3
  });
  const results = await Promise.allSettled([
    mw(ctxWith('a'), async () => ({})),
    mw(ctxWith('b'), async () => ({})),
    mw(ctxWith('c'), async () => ({})),
  ]);
  for (const r of results) {
    assert.equal(r.status, 'rejected');
    assert.equal(r.reason.code, 'BATCH_AGGREGATION_FAILED');
  }
});

test('batchAggregator: splitResponse returns non-array → all members fail', async () => {
  const mw = batchAggregator({
    batchWindowMs: 20,
    aggregateRequests: (b) => ({ __size: b.length }),
    splitResponse:     () => 'not-an-array',
  });
  const results = await Promise.allSettled([
    mw(ctxWith('a'), async () => ({})),
    mw(ctxWith('b'), async () => ({})),
  ]);
  for (const r of results) {
    assert.equal(r.status, 'rejected');
  }
});

// ---- Callbacks ----------------

test('batchAggregator: onFlush fires per batch with reason', async () => {
  const events = [];
  const mw = batchAggregator({
    batchWindowMs: 20, maxBatchSize: 2,
    aggregateRequests: (b) => ({ __size: b.length }),
    splitResponse:     (_r, b) => b.map(() => ({ ok: true })),
    onFlush: (i) => events.push(i),
  });
  await Promise.all([
    mw(ctxWith('a'), async () => ({})),
    mw(ctxWith('b'), async () => ({})),
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].size, 2);
  assert.equal(events[0].reason, 'full');
});

test('batchAggregator: onBatch fires after split completes', async () => {
  const events = [];
  const mw = batchAggregator({
    batchWindowMs: 20,
    aggregateRequests: (b) => ({ __size: b.length }),
    splitResponse:     (_r, b) => b.map(() => ({ ok: true })),
    onBatch: (i) => events.push(i),
  });
  await Promise.all([mw(ctxWith('a'), async () => ({})), mw(ctxWith('b'), async () => ({}))]);
  assert.equal(events.length, 1);
  assert.equal(events[0].size, 2);
});

test('batchAggregator: callback throws swallowed', async () => {
  const mw = batchAggregator({
    batchWindowMs: 20,
    aggregateRequests: (b) => ({ __size: b.length }),
    splitResponse:     (_r, b) => b.map(() => ({ ok: true })),
    onBatch: () => { throw new Error('x'); },
    onFlush: () => { throw new Error('x'); },
  });
  const results = await Promise.all([
    mw(ctxWith('a'), async () => ({})),
    mw(ctxWith('b'), async () => ({})),
  ]);
  assert.equal(results.length, 2);
});

// ---- Stats + MCP + reset -----------

test('batchAggregator: avgBatchSize', async () => {
  const mw = batchAggregator({
    batchWindowMs: 20,
    aggregateRequests: (b) => ({ __size: b.length }),
    splitResponse:     (_r, b) => b.map(() => ({ ok: true })),
  });
  await Promise.all([
    mw(ctxWith('a'), async () => ({})),
    mw(ctxWith('b'), async () => ({})),
    mw(ctxWith('c'), async () => ({})),
  ]);
  await mw(ctxWith('d'), async () => ({}));
  // Two batches: size 3 and size 1. Avg = 2.
  assert.equal(mw.avgBatchSize(), 2);
});

test('batchAggregator: reset zeroes counters', async () => {
  const mw = batchAggregator({
    batchWindowMs: 20,
    aggregateRequests: (b) => ({ __size: b.length }),
    splitResponse:     (_r, b) => b.map(() => ({ ok: true })),
  });
  await Promise.all([
    mw(ctxWith('a'), async () => ({})),
    mw(ctxWith('b'), async () => ({})),
  ]);
  assert.ok(mw.stats.batchesFlushed > 0);
  mw.reset();
  assert.equal(mw.stats.batchesFlushed, 0);
});

test('batchAggregator: asMcpResource', () => {
  const mw = batchAggregator({
    batchWindowMs: 100, maxBatchSize: 25,
    aggregateRequests: () => ({}), splitResponse: () => [],
  });
  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://batch-aggregator');
  const p = r.handler();
  assert.equal(p.batchWindowMs, 100);
  assert.equal(p.maxBatchSize, 25);
});
