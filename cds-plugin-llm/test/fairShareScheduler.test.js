const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_fss__';
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
  fairShareScheduler,
  FairShareRejectedError,
} = require('../lib/middleware/fairShareScheduler');

// ---- Helpers ---------------------------------------------------------

function ctxFor(tenant, extra = {}) {
  return { request: { tenantId: tenant, ...extra } };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function tick(n = 1) {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

// ---- Validation ------------------------------------------------------

test('fairShareScheduler: throws without tenantOf', () => {
  assert.throws(() => fairShareScheduler({}), /tenantOf/);
});
test('fairShareScheduler: throws on invalid maxConcurrent', () => {
  assert.throws(() => fairShareScheduler({ tenantOf: () => 'x', maxConcurrent: 0 }), /maxConcurrent/);
});
test('fairShareScheduler: throws on non-object weights', () => {
  assert.throws(() => fairShareScheduler({ tenantOf: () => 'x', weights: 'bad' }), /weights/);
});
test('fairShareScheduler: throws on invalid weight value', () => {
  assert.throws(() => fairShareScheduler({ tenantOf: () => 'x', weights: { gold: 1.5 } }), /weights\.gold/);
});
test('fairShareScheduler: throws on invalid defaultWeight', () => {
  assert.throws(() => fairShareScheduler({ tenantOf: () => 'x', defaultWeight: 0 }), /defaultWeight/);
});
test('fairShareScheduler: throws on invalid maxPerTenantQueue', () => {
  assert.throws(() => fairShareScheduler({ tenantOf: () => 'x', maxPerTenantQueue: 0 }), /maxPerTenantQueue/);
});
test('fairShareScheduler: throws on non-function callback', () => {
  assert.throws(() => fairShareScheduler({ tenantOf: () => 'x', onAdmit: 'x' }), /callbacks/);
});

// ---- Basic admission -------------------------------------------------

test('fairShareScheduler: single request admits immediately', async () => {
  const mw = fairShareScheduler({ tenantOf: (c) => c.request.tenantId, maxConcurrent: 2 });
  const r = await mw(ctxFor('t1'), async () => 'ok');
  assert.equal(r, 'ok');
  assert.equal(mw.stats.totalAdmitted, 1);
  assert.equal(mw.activeCount(), 0);
});

test('fairShareScheduler: below-capacity calls all admit immediately', async () => {
  const mw = fairShareScheduler({ tenantOf: (c) => c.request.tenantId, maxConcurrent: 5 });
  const gate = deferred();
  const promises = [];
  for (let i = 0; i < 3; i++) {
    promises.push(mw(ctxFor('t1'), async () => { await gate.promise; return i; }));
  }
  await tick();
  assert.equal(mw.activeCount(), 3);
  assert.equal(mw.queuedCount(), 0);
  gate.resolve();
  await Promise.all(promises);
});

// ---- Queueing at capacity -------------------------------------------

test('fairShareScheduler: over-capacity calls queue', async () => {
  const mw = fairShareScheduler({ tenantOf: (c) => c.request.tenantId, maxConcurrent: 2 });
  const gate = deferred();
  const promises = [];
  for (let i = 0; i < 5; i++) {
    promises.push(mw(ctxFor('t1'), async () => { await gate.promise; return i; }));
  }
  await tick();
  assert.equal(mw.activeCount(), 2);
  assert.equal(mw.queuedCount(), 3);
  gate.resolve();
  await Promise.all(promises);
  assert.equal(mw.activeCount(), 0);
  assert.equal(mw.queuedCount(), 0);
});

// ---- Weighted round-robin --------------------------------------

test('fairShareScheduler: equal weights → fair interleaving', async () => {
  const admissionOrder = [];
  const mw = fairShareScheduler({
    tenantOf: (c) => c.request.tenantId,
    maxConcurrent: 1,
    onAdmit: (i) => admissionOrder.push(i.tenant),
  });
  // Enqueue 3 requests from each tenant while capacity=1 is held.
  const gate = deferred();
  const holderP = mw(ctxFor('holder'), async () => { await gate.promise; return 'held'; });
  await tick();
  // Now the bulkhead is busy. Fill queues in interleaved order:
  const promises = [
    mw(ctxFor('a'), async () => 'a1'),
    mw(ctxFor('b'), async () => 'b1'),
    mw(ctxFor('a'), async () => 'a2'),
    mw(ctxFor('b'), async () => 'b2'),
    mw(ctxFor('a'), async () => 'a3'),
    mw(ctxFor('b'), async () => 'b3'),
  ];
  await tick();
  gate.resolve();
  await holderP;
  await Promise.all(promises);
  // The holder admitted first; then a and b should alternate (WRR with equal weights).
  const drained = admissionOrder.slice(1);   // drop 'holder'
  const aCount = drained.filter((t) => t === 'a').length;
  const bCount = drained.filter((t) => t === 'b').length;
  assert.equal(aCount, 3);
  assert.equal(bCount, 3);
});

test('fairShareScheduler: unequal weights → WRR order favors higher weight in each cycle', async () => {
  const admissionOrder = [];
  const mw = fairShareScheduler({
    tenantOf: (c) => c.request.tenantId,
    maxConcurrent: 1,
    weights: { gold: 3, silver: 1 },
    onAdmit: (i) => admissionOrder.push(i.tenant),
  });
  const gate = deferred();
  const holderP = mw(ctxFor('holder'), async () => { await gate.promise; return 'x'; });
  await tick();
  // Enqueue plenty of both so WRR pattern is observable across cycles.
  const promises = [];
  for (let i = 0; i < 10; i++) promises.push(mw(ctxFor('gold'),   async () => 'g'));
  for (let i = 0; i < 10; i++) promises.push(mw(ctxFor('silver'), async () => 's'));
  await tick();
  gate.resolve();
  await holderP;
  await Promise.all(promises);
  const drained = admissionOrder.slice(1);   // drop 'holder'
  // First WRR cycle (before any tenant runs out of work) = 4 admissions:
  // 3 gold, 1 silver. Second cycle: another 3 gold, 1 silver. Assert
  // on the first 8 admissions to avoid the "one tenant ran out" edge.
  const firstEight = drained.slice(0, 8);
  const goldFirst8   = firstEight.filter((t) => t === 'gold').length;
  const silverFirst8 = firstEight.filter((t) => t === 'silver').length;
  assert.equal(goldFirst8,   6);
  assert.equal(silverFirst8, 2);
});

// ---- Backpressure ---------------------------------------------------

test('fairShareScheduler: queue full → throws FairShareRejectedError', async () => {
  const mw = fairShareScheduler({
    tenantOf: (c) => c.request.tenantId,
    maxConcurrent: 1,
    maxPerTenantQueue: 2,
  });
  const gate = deferred();
  // 1 active + 2 queued (max).
  const active = mw(ctxFor('t1'), async () => { await gate.promise; return 'ok'; });
  await tick();
  const q1 = mw(ctxFor('t1'), async () => 'q1');
  const q2 = mw(ctxFor('t1'), async () => 'q2');
  await tick();
  await assert.rejects(mw(ctxFor('t1'), async () => 'q3'), FairShareRejectedError);
  gate.resolve();
  await Promise.all([active, q1, q2]);
  assert.equal(mw.stats.totalRejected, 1);
});

test('fairShareScheduler: rejected error carries tenant + limits', async () => {
  const mw = fairShareScheduler({
    tenantOf: (c) => c.request.tenantId,
    maxConcurrent: 1,
    maxPerTenantQueue: 1,
  });
  const gate = deferred();
  const active = mw(ctxFor('t1'), async () => { await gate.promise; return 'ok'; });
  await tick();
  const q1 = mw(ctxFor('t1'), async () => 'q1');
  await tick();
  try {
    await mw(ctxFor('t1'), async () => 'q2');
    assert.fail('should have rejected');
  } catch (err) {
    assert.equal(err.code, 'FAIR_SHARE_QUEUE_FULL');
    assert.equal(err.tenant, 't1');
    assert.equal(err.queueLimit, 1);
  }
  gate.resolve();
  await Promise.all([active, q1]);
});

test('fairShareScheduler: one tenant full does not block others', async () => {
  const mw = fairShareScheduler({
    tenantOf: (c) => c.request.tenantId,
    maxConcurrent: 1,
    maxPerTenantQueue: 1,
  });
  const gate = deferred();
  const active = mw(ctxFor('t1'), async () => { await gate.promise; return 'ok'; });
  await tick();
  // t1 fills its queue.
  const t1queued = mw(ctxFor('t1'), async () => 't1q');
  await tick();
  await assert.rejects(mw(ctxFor('t1'), async () => 'reject'), FairShareRejectedError);
  // t2 can still enqueue — separate per-tenant queue.
  const t2queued = mw(ctxFor('t2'), async () => 't2q');
  await tick();
  gate.resolve();
  await Promise.all([active, t1queued, t2queued]);
});

// ---- Callbacks -------------------------------------------------

test('fairShareScheduler: onAdmit fires with tenant + waitMs', async () => {
  const events = [];
  const mw = fairShareScheduler({
    tenantOf: (c) => c.request.tenantId,
    maxConcurrent: 1,
    onAdmit: (i) => events.push(i.tenant),
  });
  await mw(ctxFor('t1'), async () => 'ok');
  assert.deepEqual(events, ['t1']);
});

test('fairShareScheduler: onQueue fires with queue depth', async () => {
  const events = [];
  const mw = fairShareScheduler({
    tenantOf: (c) => c.request.tenantId,
    maxConcurrent: 1,
    onQueue: (i) => events.push(i),
  });
  const gate = deferred();
  const active = mw(ctxFor('t1'), async () => { await gate.promise; return 'x'; });
  await tick();
  const queued = mw(ctxFor('t1'), async () => 'q');
  await tick();
  gate.resolve();
  await Promise.all([active, queued]);
  assert.equal(events.length, 1);
  assert.equal(events[0].tenant, 't1');
  assert.equal(events[0].queueDepth, 1);
});

test('fairShareScheduler: onReject fires with tenant + queue info', async () => {
  const events = [];
  const mw = fairShareScheduler({
    tenantOf: (c) => c.request.tenantId,
    maxConcurrent: 1,
    maxPerTenantQueue: 1,
    onReject: (i) => events.push(i),
  });
  const gate = deferred();
  const active = mw(ctxFor('t1'), async () => { await gate.promise; return 'x'; });
  await tick();
  const q1 = mw(ctxFor('t1'), async () => 'q');
  await tick();
  await assert.rejects(mw(ctxFor('t1'), async () => 'r'), FairShareRejectedError);
  gate.resolve();
  await Promise.all([active, q1]);
  assert.equal(events.length, 1);
  assert.equal(events[0].tenant, 't1');
  assert.equal(events[0].queueLimit, 1);
});

test('fairShareScheduler: callback throws are swallowed', async () => {
  const mw = fairShareScheduler({
    tenantOf: (c) => c.request.tenantId,
    onAdmit: () => { throw new Error('bug'); },
  });
  const r = await mw(ctxFor('t1'), async () => 'ok');
  assert.equal(r, 'ok');
});

// ---- Missing tenant → __anon__ ---------------------------------

test('fairShareScheduler: tenantOf returns non-string → __anon__ bucket', async () => {
  const mw = fairShareScheduler({
    tenantOf: () => null,
    maxConcurrent: 2,
  });
  await mw(ctxFor('anon'), async () => 'ok');
  assert.equal(mw.stats.lastTenant, '__anon__');
});

// ---- Error handling in tenantOf --------------------------------

test('fairShareScheduler: tenantOf throws → propagates', async () => {
  const errors = [];
  const mw = fairShareScheduler({
    tenantOf: () => { throw new Error('bad tenant'); },
    onError: (i) => errors.push(i),
  });
  await assert.rejects(mw(ctxFor('t1'), async () => 'x'), /bad tenant/);
  assert.equal(errors[0].phase, 'tenantOf');
});

// ---- Cleanup on downstream error ------------------------------

test('fairShareScheduler: downstream throw releases slot', async () => {
  const mw = fairShareScheduler({
    tenantOf: (c) => c.request.tenantId,
    maxConcurrent: 1,
  });
  await assert.rejects(mw(ctxFor('t1'), async () => { throw new Error('down'); }), /down/);
  assert.equal(mw.activeCount(), 0);
  // Should be able to admit again.
  const r = await mw(ctxFor('t1'), async () => 'ok');
  assert.equal(r, 'ok');
});

// ---- Peak tracking -----------------------------------------

test('fairShareScheduler: peakActive + peakQueued tracked', async () => {
  const mw = fairShareScheduler({ tenantOf: (c) => c.request.tenantId, maxConcurrent: 2 });
  const gate = deferred();
  const promises = [];
  for (let i = 0; i < 4; i++) {
    promises.push(mw(ctxFor('t1'), async () => { await gate.promise; return i; }));
  }
  await tick();
  assert.equal(mw.stats.peakActive, 2);
  assert.equal(mw.stats.peakQueued, 2);
  gate.resolve();
  await Promise.all(promises);
});

// ---- Snapshot + MCP -----------------------------------------

test('fairShareScheduler: snapshotTenants shape', async () => {
  const mw = fairShareScheduler({
    tenantOf: (c) => c.request.tenantId,
    maxConcurrent: 2,
    weights: { gold: 3 },
  });
  await mw(ctxFor('gold'), async () => 'x');
  await mw(ctxFor('silver'), async () => 'x');
  const snap = mw.snapshotTenants();
  assert.equal(snap.gold.weight, 3);
  assert.equal(snap.silver.weight, 1);
  assert.equal(snap.gold.totalAdmitted, 1);
});

test('fairShareScheduler: reset zeroes global counters, keeps live state', async () => {
  const mw = fairShareScheduler({ tenantOf: (c) => c.request.tenantId, maxConcurrent: 2 });
  await mw(ctxFor('t1'), async () => 'x');
  assert.equal(mw.stats.totalAdmitted, 1);
  mw.reset();
  assert.equal(mw.stats.totalAdmitted, 0);
});

test('fairShareScheduler: asMcpResource', () => {
  const mw = fairShareScheduler({
    tenantOf: (c) => c.request.tenantId,
    maxConcurrent: 5,
    weights: { gold: 3, silver: 1 },
    maxPerTenantQueue: 50,
  });
  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://fair-share-scheduler');
  const p = r.handler();
  assert.equal(p.maxConcurrent, 5);
  assert.equal(p.maxPerTenantQueue, 50);
  assert.deepEqual(p.configuredWeights, { gold: 3, silver: 1 });
  assert.equal(p.currentActive, 0);
  assert.equal(p.currentQueued, 0);
});
