const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_bh__';
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

const { bulkhead, BulkheadFullError, BulkheadTimeoutError } = require('../lib/middleware/bulkhead');

// Deferred-next factory — lets tests hold in-flight calls in place so the
// bucket saturates. Returns { next, release, release_reject }.
function heldNext() {
  let resolveNext, rejectNext;
  const promise = new Promise((r, rj) => { resolveNext = r; rejectNext = rj; });
  return {
    next: () => promise,
    release: (val = { text: 'ok' }) => resolveNext(val),
    release_reject: (err) => rejectNext(err),
  };
}

function invoke(mw, { serviceName = 'llm', next = async () => ({ text: 'ok' }) } = {}) {
  const ctx = { service: { name: serviceName }, method: 'chat' };
  return mw(ctx, next);
}

// ---- Input validation --------------------------------------------------

test('bulkhead: rejects non-positive maxConcurrent', () => {
  assert.throws(() => bulkhead({ maxConcurrent: 0 }), /maxConcurrent/);
  assert.throws(() => bulkhead({ maxConcurrent: -1 }), /maxConcurrent/);
  assert.throws(() => bulkhead({ maxConcurrent: 1.5 }), /maxConcurrent/);
});

test('bulkhead: rejects negative maxQueued', () => {
  assert.throws(() => bulkhead({ maxQueued: -1 }), /maxQueued/);
});

test('bulkhead: rejects negative queueTimeoutMs', () => {
  assert.throws(() => bulkhead({ queueTimeoutMs: -1 }), /queueTimeoutMs/);
});

// ---- Fast path (under capacity) ---------------------------------------

test('bulkhead: calls under maxConcurrent execute immediately in parallel', async () => {
  const bh = bulkhead({ maxConcurrent: 3 });
  const h1 = heldNext(); const h2 = heldNext(); const h3 = heldNext();
  const p1 = invoke(bh, { next: h1.next });
  const p2 = invoke(bh, { next: h2.next });
  const p3 = invoke(bh, { next: h3.next });
  // Yield so the middleware advances
  await new Promise((r) => setImmediate(r));
  assert.equal(bh.state('llm').inFlight, 3);
  assert.equal(bh.state('llm').queued, 0);
  h1.release(); h2.release(); h3.release();
  await Promise.all([p1, p2, p3]);
  assert.equal(bh.state('llm').inFlight, 0);
  assert.equal(bh.stats.admitted, 3);
  assert.equal(bh.stats.queued,   0);
});

// ---- Queueing ---------------------------------------------------------

test('bulkhead: excess calls queue when maxConcurrent reached', async () => {
  const bh = bulkhead({ maxConcurrent: 1, maxQueued: 2 });
  const h1 = heldNext();
  const p1 = invoke(bh, { next: h1.next });
  await new Promise((r) => setImmediate(r));
  // Two queued
  const p2 = invoke(bh);   // will queue
  const p3 = invoke(bh);   // will queue
  await new Promise((r) => setImmediate(r));
  assert.equal(bh.state('llm').inFlight, 1);
  assert.equal(bh.state('llm').queued,   2);
  assert.equal(bh.stats.queued, 2);
  h1.release();
  await Promise.all([p1, p2, p3]);
  assert.equal(bh.state('llm').inFlight, 0);
  assert.equal(bh.state('llm').queued,   0);
});

test('bulkhead: queued calls run in FIFO order as slots free up', async () => {
  const bh = bulkhead({ maxConcurrent: 1, maxQueued: 5 });
  const order = [];
  const h1 = heldNext();
  const p1 = invoke(bh, { next: async () => { order.push(1); return h1.next(); } });
  await new Promise((r) => setImmediate(r));
  const p2 = invoke(bh, { next: async () => { order.push(2); return { text: 'ok' }; } });
  const p3 = invoke(bh, { next: async () => { order.push(3); return { text: 'ok' }; } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, [1]);  // Only in-flight one ran
  h1.release();
  await Promise.all([p1, p2, p3]);
  assert.deepEqual(order, [1, 2, 3]);
});

// ---- Rejection (queue full) --------------------------------------------

test('bulkhead: BulkheadFullError when queue exceeds maxQueued', async () => {
  const bh = bulkhead({ maxConcurrent: 1, maxQueued: 1 });
  const h1 = heldNext();
  const p1 = invoke(bh, { next: h1.next });
  await new Promise((r) => setImmediate(r));
  const p2 = invoke(bh);   // queued
  await new Promise((r) => setImmediate(r));
  // Third call: queue-full → immediate rejection
  await assert.rejects(() => invoke(bh), (err) => {
    assert.ok(err instanceof BulkheadFullError);
    assert.equal(err.code, 'BULKHEAD_FULL');
    assert.equal(err.provider, 'llm');
    assert.equal(err.maxQueued, 1);
    return true;
  });
  assert.equal(bh.stats.rejected, 1);
  h1.release();
  await Promise.all([p1, p2]);
});

test('bulkhead: maxQueued=0 (default) rejects any excess immediately', async () => {
  const bh = bulkhead({ maxConcurrent: 1 });   // maxQueued: 0 default
  const h1 = heldNext();
  const p1 = invoke(bh, { next: h1.next });
  await new Promise((r) => setImmediate(r));
  await assert.rejects(() => invoke(bh), BulkheadFullError);
  h1.release();
  await p1;
});

// ---- Queue timeout ----------------------------------------------------

test('bulkhead: BulkheadTimeoutError fires when queueTimeoutMs elapses', async () => {
  const bh = bulkhead({ maxConcurrent: 1, maxQueued: 5, queueTimeoutMs: 30 });
  const h1 = heldNext();
  const p1 = invoke(bh, { next: h1.next });
  await new Promise((r) => setImmediate(r));
  const p2 = invoke(bh);   // will queue then timeout
  await assert.rejects(p2, (err) => {
    assert.ok(err instanceof BulkheadTimeoutError);
    assert.equal(err.code, 'BULKHEAD_TIMEOUT');
    assert.equal(err.queueTimeoutMs, 30);
    return true;
  });
  assert.equal(bh.stats.timedOut, 1);
  h1.release();
  await p1;
});

test('bulkhead: queueTimeoutMs=0 disables the timer (waiters wait indefinitely)', async () => {
  const bh = bulkhead({ maxConcurrent: 1, maxQueued: 5 });   // timeout: 0 default
  const h1 = heldNext();
  const p1 = invoke(bh, { next: h1.next });
  await new Promise((r) => setImmediate(r));
  const p2 = invoke(bh);
  // Wait a bit — no timeout should fire
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(bh.state('llm').queued, 1);
  h1.release();
  await Promise.all([p1, p2]);
});

// ---- Per-provider bucketing --------------------------------------------

test('bulkhead: perProvider=true isolates buckets — one saturated bucket does not block another', async () => {
  const bh = bulkhead({ maxConcurrent: 1, maxQueued: 0, perProvider: true });
  const h1 = heldNext();
  const openaiP = invoke(bh, { serviceName: 'openai', next: h1.next });
  await new Promise((r) => setImmediate(r));
  // openai is saturated. anthropic should run freely
  const anthropicResult = await invoke(bh, { serviceName: 'anthropic' });
  assert.deepEqual(anthropicResult, { text: 'ok' });
  h1.release();
  await openaiP;
});

test('bulkhead: perProvider=false shares one global bucket', async () => {
  const bh = bulkhead({ maxConcurrent: 1, maxQueued: 0, perProvider: false });
  const h1 = heldNext();
  const openaiP = invoke(bh, { serviceName: 'openai', next: h1.next });
  await new Promise((r) => setImmediate(r));
  // Global bucket saturated → anthropic call rejected
  await assert.rejects(() => invoke(bh, { serviceName: 'anthropic' }), BulkheadFullError);
  h1.release();
  await openaiP;
});

// ---- Slot released on failure -----------------------------------------

test('bulkhead: slot is released when the wrapped call throws', async () => {
  const bh = bulkhead({ maxConcurrent: 1, maxQueued: 0 });
  await assert.rejects(() => invoke(bh, { next: async () => { throw new Error('boom'); } }), /boom/);
  assert.equal(bh.state('llm').inFlight, 0);
  // Bucket ready for the next call
  const res = await invoke(bh);
  assert.deepEqual(res, { text: 'ok' });
});

// ---- Callbacks --------------------------------------------------------

test('bulkhead: onQueue callback fires when a call is queued', async () => {
  const events = [];
  const bh = bulkhead({
    maxConcurrent: 1, maxQueued: 5,
    onQueue: (info) => events.push({ event: 'queue', ...info }),
  });
  const h1 = heldNext();
  const p1 = invoke(bh, { next: h1.next });
  await new Promise((r) => setImmediate(r));
  const p2 = invoke(bh);
  await new Promise((r) => setImmediate(r));
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'queue');
  assert.equal(events[0].provider, 'llm');
  h1.release();
  await Promise.all([p1, p2]);
});

test('bulkhead: onReject callback fires on queue-full', async () => {
  const events = [];
  const bh = bulkhead({
    maxConcurrent: 1, maxQueued: 0,
    onReject: (info) => events.push({ event: 'reject', ...info }),
  });
  const h1 = heldNext();
  const p1 = invoke(bh, { next: h1.next });
  await new Promise((r) => setImmediate(r));
  await assert.rejects(() => invoke(bh), BulkheadFullError);
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, 'queue-full');
  h1.release();
  await p1;
});

test('bulkhead: onReject callback fires on queue-timeout', async () => {
  const events = [];
  const bh = bulkhead({
    maxConcurrent: 1, maxQueued: 5, queueTimeoutMs: 30,
    onReject: (info) => events.push({ event: 'reject', ...info }),
  });
  const h1 = heldNext();
  const p1 = invoke(bh, { next: h1.next });
  await new Promise((r) => setImmediate(r));
  const p2 = invoke(bh);
  await assert.rejects(p2, BulkheadTimeoutError);
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, 'queue-timeout');
  h1.release();
  await p1;
});

test('bulkhead: onExecute callback fires when a call actually runs', async () => {
  const events = [];
  const bh = bulkhead({
    maxConcurrent: 2,
    onExecute: (info) => events.push({ event: 'exec', ...info }),
  });
  await invoke(bh);
  await invoke(bh);
  assert.equal(events.length, 2);
});

// ---- Reset ------------------------------------------------------------

test('bulkhead: reset() clears buckets + stats', async () => {
  const bh = bulkhead({ maxConcurrent: 1, maxQueued: 0 });
  const h1 = heldNext();
  const p1 = invoke(bh, { next: h1.next });
  await new Promise((r) => setImmediate(r));
  await assert.rejects(() => invoke(bh), BulkheadFullError);
  assert.equal(bh.stats.rejected, 1);
  bh.reset();
  assert.equal(bh.stats.rejected, 0);
  h1.release();
  await p1;
});

test('bulkhead: reset(provider) rejects queued waiters', async () => {
  const bh = bulkhead({ maxConcurrent: 1, maxQueued: 5 });
  const h1 = heldNext();
  const p1 = invoke(bh, { next: h1.next });
  await new Promise((r) => setImmediate(r));
  const p2 = invoke(bh);
  await new Promise((r) => setImmediate(r));
  bh.reset('llm');
  await assert.rejects(p2, BulkheadFullError);
  h1.release();
  await p1;
});

// ---- MCP resource ------------------------------------------------------

test('bulkhead: asMcpResource() returns config://bulkhead snapshot', async () => {
  const bh = bulkhead({ maxConcurrent: 5, maxQueued: 10, queueTimeoutMs: 1000 });
  await invoke(bh, { serviceName: 'openai' });
  const res = bh.asMcpResource();
  assert.equal(res.uri, 'config://bulkhead');
  assert.equal(res.mimeType, 'application/json');
  const snap = res.handler();
  assert.equal(snap.maxConcurrent, 5);
  assert.equal(snap.maxQueued, 10);
  assert.equal(snap.queueTimeoutMs, 1000);
  assert.ok('openai' in snap.buckets);
  assert.equal(snap.admitted, 1);
});
