const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_crl__';
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
  clientSideRateLimit,
  RateLimitTimeoutError,
  CLIENT_RATE_LIMIT_STRATEGIES,
} = require('../lib/middleware/clientSideRateLimit');

// ---- Helpers -----------------------------------------------------------

function ctxWith(key) { return { request: { key } }; }
async function tick(n = 1) { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); }

// ---- Strategy export --------------------------------------------------

test('CLIENT_RATE_LIMIT_STRATEGIES is frozen', () => {
  assert.ok(Object.isFrozen(CLIENT_RATE_LIMIT_STRATEGIES));
  assert.deepEqual([...CLIENT_RATE_LIMIT_STRATEGIES], ['token-bucket', 'sliding-window']);
});

// ---- Validation ------------------------------------------------------

test('clientSideRateLimit: throws on unknown strategy', () => {
  assert.throws(() => clientSideRateLimit({ strategy: 'bogus' }), /strategy/);
});
test('clientSideRateLimit: token-bucket throws on non-positive rate', () => {
  assert.throws(() => clientSideRateLimit({ strategy: 'token-bucket', rate: 0 }), /rate/);
});
test('clientSideRateLimit: token-bucket throws on invalid burst', () => {
  assert.throws(() => clientSideRateLimit({ strategy: 'token-bucket', rate: 1, burst: 0 }), /burst/);
});
test('clientSideRateLimit: sliding-window throws on invalid limit', () => {
  assert.throws(() => clientSideRateLimit({ strategy: 'sliding-window', limit: 0, windowMs: 1000 }), /limit/);
});
test('clientSideRateLimit: sliding-window throws on tiny windowMs', () => {
  assert.throws(() => clientSideRateLimit({ strategy: 'sliding-window', limit: 10, windowMs: 50 }), /windowMs/);
});
test('clientSideRateLimit: throws on non-function keyOf', () => {
  assert.throws(() => clientSideRateLimit({ keyOf: 'x' }), /keyOf/);
});
test('clientSideRateLimit: throws on negative queueTimeoutMs', () => {
  assert.throws(() => clientSideRateLimit({ queueTimeoutMs: -1 }), /queueTimeoutMs/);
});
test('clientSideRateLimit: throws on non-function callback', () => {
  assert.throws(() => clientSideRateLimit({ onQueue: 'x' }), /callbacks/);
});

// ---- Token-bucket: under capacity --------------------------

test('clientSideRateLimit: token-bucket admits below burst', async () => {
  const mw = clientSideRateLimit({ strategy: 'token-bucket', rate: 1, burst: 5 });
  for (let i = 0; i < 5; i++) {
    await mw(ctxWith(), async () => 'ok');
  }
  assert.equal(mw.stats.admittedImmediately, 5);
  assert.equal(mw.stats.queuedThenAdmitted, 0);
});

test('clientSideRateLimit: token-bucket queues when empty then admits after refill', async () => {
  // Real timers for this test — we need actual sleep to drain queue.
  const mw = clientSideRateLimit({
    strategy: 'token-bucket', rate: 100, burst: 2,   // 2 burst, 100/sec refill = 10ms/token
    queueTimeoutMs: 5000,
  });
  // Fire 5 calls at once. First 2 admit immediately; 3, 4, 5 queue.
  const startedAt = Date.now();
  const calls = [];
  for (let i = 0; i < 5; i++) {
    calls.push(mw(ctxWith(), async () => 'ok'));
  }
  await Promise.all(calls);
  assert.equal(mw.stats.admittedImmediately, 2);
  assert.equal(mw.stats.queuedThenAdmitted, 3);
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs >= 20, `expected >= 20ms elapsed (got ${elapsedMs})`);
});

// ---- Sliding-window --------------------------------

test('clientSideRateLimit: sliding-window admits below limit', async () => {
  const mw = clientSideRateLimit({ strategy: 'sliding-window', limit: 3, windowMs: 60_000 });
  for (let i = 0; i < 3; i++) await mw(ctxWith(), async () => 'ok');
  assert.equal(mw.stats.admittedImmediately, 3);
});

test('clientSideRateLimit: sliding-window queues when at cap, admits when oldest ages out', async () => {
  const mw = clientSideRateLimit({
    strategy: 'sliding-window', limit: 2, windowMs: 100,
    queueTimeoutMs: 5000,
  });
  // Fire 3 calls: first 2 admit, 3rd queues until oldest ages out (~100ms).
  const startedAt = Date.now();
  const calls = [];
  for (let i = 0; i < 3; i++) calls.push(mw(ctxWith(), async () => 'ok'));
  await Promise.all(calls);
  const elapsed = Date.now() - startedAt;
  assert.equal(mw.stats.admittedImmediately, 2);
  assert.equal(mw.stats.queuedThenAdmitted, 1);
  assert.ok(elapsed >= 95, `expected >= 95ms (got ${elapsed})`);
});

// ---- Queue timeout ---------------------

test('clientSideRateLimit: rejects with RateLimitTimeoutError after queueTimeoutMs', async () => {
  const mw = clientSideRateLimit({
    strategy: 'token-bucket', rate: 0.5, burst: 1,   // 1 slot, refills once per 2s
    queueTimeoutMs: 50,
  });
  // Consume the one slot.
  await mw(ctxWith(), async () => 'ok');
  // Next call queues and should time out.
  await assert.rejects(mw(ctxWith(), async () => 'ok'), RateLimitTimeoutError);
  assert.equal(mw.stats.timedOut, 1);
});

test('clientSideRateLimit: RateLimitTimeoutError carries context', async () => {
  const mw = clientSideRateLimit({
    strategy: 'token-bucket', rate: 0.5, burst: 1,
    keyOf: (c) => c.request.key,
    queueTimeoutMs: 30,
  });
  await mw(ctxWith('acme'), async () => 'ok');
  try {
    await mw(ctxWith('acme'), async () => 'ok');
    assert.fail('should throw');
  } catch (err) {
    assert.equal(err.code, 'RATE_LIMIT_QUEUE_TIMEOUT');
    assert.equal(err.rateLimitKey, 'acme');
    assert.equal(err.queueTimeoutMs, 30);
    assert.ok(err.waitedMs >= 30);
  }
});

// ---- Per-key isolation --------------------

test('clientSideRateLimit: per-key state isolates limits', async () => {
  const mw = clientSideRateLimit({
    strategy: 'token-bucket', rate: 1, burst: 1,
    keyOf: (c) => c.request.key,
    queueTimeoutMs: 50,
  });
  // Both keys get 1 token each — both admit immediately.
  await mw(ctxWith('a'), async () => 'ok');
  await mw(ctxWith('b'), async () => 'ok');
  assert.equal(mw.stats.admittedImmediately, 2);
});

test('clientSideRateLimit: one key exhausted does not block another', async () => {
  const mw = clientSideRateLimit({
    strategy: 'token-bucket', rate: 0.1, burst: 1,
    keyOf: (c) => c.request.key,
    queueTimeoutMs: 50,
  });
  await mw(ctxWith('a'), async () => 'ok');   // consumes a
  await assert.rejects(mw(ctxWith('a'), async () => 'ok'), RateLimitTimeoutError);
  // b still has a token.
  await mw(ctxWith('b'), async () => 'ok');
});

// ---- Empty key → 'global' bucket -----------

test('clientSideRateLimit: null key → global bucket', async () => {
  const mw = clientSideRateLimit({
    strategy: 'token-bucket', rate: 1, burst: 1,
    keyOf: () => null,
  });
  await mw(ctxWith(), async () => 'ok');
  assert.equal(mw.stats.lastKey, 'global');
});

// ---- keyOf error ---------------

test('clientSideRateLimit: keyOf throws → propagates', async () => {
  const errors = [];
  const mw = clientSideRateLimit({
    keyOf: () => { throw new Error('bad'); },
    onError: (i) => errors.push(i),
  });
  await assert.rejects(mw(ctxWith(), async () => 'ok'), /bad/);
  assert.equal(mw.stats.keyErrors, 1);
  assert.equal(errors[0].phase, 'keyOf');
});

// ---- Callbacks ------------

test('clientSideRateLimit: onAdmit fires with immediate flag', async () => {
  const events = [];
  const mw = clientSideRateLimit({
    strategy: 'token-bucket', rate: 1, burst: 5,
    onAdmit: (i) => events.push(i.immediate),
  });
  for (let i = 0; i < 3; i++) await mw(ctxWith(), async () => 'ok');
  assert.deepEqual(events, [true, true, true]);
});

test('clientSideRateLimit: onQueue fires with queue depth', async () => {
  const events = [];
  const mw = clientSideRateLimit({
    strategy: 'token-bucket', rate: 100, burst: 1,
    onQueue: (i) => events.push(i),
  });
  const calls = [mw(ctxWith(), async () => 'ok'), mw(ctxWith(), async () => 'ok')];
  await Promise.all(calls);
  assert.equal(events.length, 1);
  assert.equal(events[0].queueDepth, 1);
});

test('clientSideRateLimit: onTimeout fires with waited info', async () => {
  const events = [];
  const mw = clientSideRateLimit({
    strategy: 'token-bucket', rate: 0.5, burst: 1,
    keyOf: (c) => c.request.key,
    queueTimeoutMs: 30,
    onTimeout: (i) => events.push(i),
  });
  await mw(ctxWith('x'), async () => 'ok');
  try { await mw(ctxWith('x'), async () => 'ok'); } catch {}
  assert.equal(events.length, 1);
  assert.equal(events[0].key, 'x');
  assert.equal(events[0].queueTimeoutMs, 30);
});

test('clientSideRateLimit: callback throws swallowed', async () => {
  const mw = clientSideRateLimit({
    strategy: 'token-bucket', rate: 1, burst: 5,
    onAdmit: () => { throw new Error('x'); },
  });
  await mw(ctxWith(), async () => 'ok');
});

// ---- Peak queue depth tracked ---------

test('clientSideRateLimit: peakQueueDepth tracked', async () => {
  const mw = clientSideRateLimit({
    strategy: 'token-bucket', rate: 100, burst: 1,
    queueTimeoutMs: 5000,
  });
  const calls = [];
  for (let i = 0; i < 4; i++) calls.push(mw(ctxWith(), async () => 'ok'));
  await Promise.all(calls);
  assert.ok(mw.stats.peakQueueDepth >= 3);
});

// ---- avgWaitMs ----------

test('clientSideRateLimit: avgWaitMs computed', async () => {
  const mw = clientSideRateLimit({
    strategy: 'token-bucket', rate: 100, burst: 1,
    queueTimeoutMs: 5000,
  });
  const calls = [];
  for (let i = 0; i < 3; i++) calls.push(mw(ctxWith(), async () => 'ok'));
  await Promise.all(calls);
  assert.ok(mw.avgWaitMs() >= 0);
  // 2 calls were queued; each waited about 10ms per token refill.
  assert.equal(mw.stats.queuedThenAdmitted, 2);
});

// ---- snapshot + reset + MCP -----

test('clientSideRateLimit: snapshotKeys shape for token-bucket', async () => {
  const mw = clientSideRateLimit({
    strategy: 'token-bucket', rate: 5, burst: 10,
    keyOf: (c) => c.request.key,
  });
  await mw(ctxWith('a'), async () => 'ok');
  const snap = mw.snapshotKeys();
  assert.ok('a' in snap);
  assert.ok(typeof snap.a.tokens === 'number');
  assert.equal(snap.a.queued, 0);
});

test('clientSideRateLimit: snapshotKeys shape for sliding-window', async () => {
  const mw = clientSideRateLimit({
    strategy: 'sliding-window', limit: 10, windowMs: 60_000,
    keyOf: (c) => c.request.key,
  });
  await mw(ctxWith('a'), async () => 'ok');
  await mw(ctxWith('a'), async () => 'ok');
  const snap = mw.snapshotKeys();
  assert.equal(snap.a.count, 2);
  assert.equal(snap.a.queued, 0);
});

test('clientSideRateLimit: reset zeroes counters', async () => {
  const mw = clientSideRateLimit({ strategy: 'token-bucket', rate: 10, burst: 5 });
  await mw(ctxWith(), async () => 'ok');
  assert.ok(mw.stats.totalCalls > 0);
  mw.reset();
  assert.equal(mw.stats.totalCalls, 0);
  assert.equal(mw.avgWaitMs(), 0);
});

test('clientSideRateLimit: asMcpResource for token-bucket', () => {
  const mw = clientSideRateLimit({ strategy: 'token-bucket', rate: 20, burst: 40 });
  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://client-rate-limit');
  const p = r.handler();
  assert.equal(p.strategy, 'token-bucket');
  assert.equal(p.rate, 20);
  assert.equal(p.burst, 40);
});

test('clientSideRateLimit: asMcpResource for sliding-window', () => {
  const mw = clientSideRateLimit({ strategy: 'sliding-window', limit: 50, windowMs: 30_000 });
  const r = mw.asMcpResource();
  const p = r.handler();
  assert.equal(p.strategy, 'sliding-window');
  assert.equal(p.limit, 50);
  assert.equal(p.windowMs, 30_000);
});
