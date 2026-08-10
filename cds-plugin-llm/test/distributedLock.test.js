const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_lock__';
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
  distributedLock,
  InMemoryLockStore,
  DistributedLockHeldError,
  DistributedLockTimeoutError,
} = require('../lib/middleware/distributedLock');
const { LLMError } = require('../lib/errors');

function makeCtx({ method = 'chat', tenant = 'acme' } = {}) {
  return { method, request: { model: 'm', messages: [] }, raw: { tenant }, meta: {} };
}

// ---- Input validation --------------------------------------------------

test('distributedLock: throws without store', () => {
  assert.throws(() => distributedLock({ keyOf: () => 'k' }), /store must expose/);
});
test('distributedLock: throws on store missing methods', () => {
  assert.throws(() => distributedLock({ store: {}, keyOf: () => 'k' }), /store must expose/);
});
test('distributedLock: throws without keyOf', () => {
  assert.throws(() => distributedLock({ store: new InMemoryLockStore() }), /keyOf must be/);
});
test('distributedLock: throws on ttlMs < 100', () => {
  assert.throws(() => distributedLock({
    store: new InMemoryLockStore(), keyOf: () => 'k', ttlMs: 50,
  }), /ttlMs must be >= 100/);
});
test('distributedLock: throws on invalid action', () => {
  assert.throws(() => distributedLock({
    store: new InMemoryLockStore(), keyOf: () => 'k', action: 'nope',
  }), /action must be/);
});
test('distributedLock: throws on waitPollMs < 10', () => {
  assert.throws(() => distributedLock({
    store: new InMemoryLockStore(), keyOf: () => 'k', waitPollMs: 5,
  }), /waitPollMs must be >= 10/);
});
test('distributedLock: throws on non-function callback', () => {
  assert.throws(() => distributedLock({
    store: new InMemoryLockStore(), keyOf: () => 'k', onAcquire: 'bad',
  }), /callbacks must be functions/);
});

// ---- InMemoryLockStore -------------------------------------------------

test('InMemoryLockStore: acquire returns token', async () => {
  const s = new InMemoryLockStore();
  const tok = await s.acquire('k', 1000);
  assert.ok(typeof tok === 'string' && tok.length > 0);
});
test('InMemoryLockStore: second acquire returns null when held', async () => {
  const s = new InMemoryLockStore();
  await s.acquire('k', 1000);
  const second = await s.acquire('k', 1000);
  assert.equal(second, null);
});
test('InMemoryLockStore: release only when token matches', async () => {
  const s = new InMemoryLockStore();
  const tok = await s.acquire('k', 1000);
  assert.equal(await s.release('k', 'wrong'), false);
  assert.equal(await s.release('k', tok), true);
});
test('InMemoryLockStore: expired lock allows re-acquisition', async () => {
  const s = new InMemoryLockStore();
  await s.acquire('k', 100);
  await new Promise((r) => setTimeout(r, 150));
  const tok2 = await s.acquire('k', 1000);
  assert.ok(tok2);
});
test('InMemoryLockStore: different keys don\'t block each other', async () => {
  const s = new InMemoryLockStore();
  const t1 = await s.acquire('k1', 1000);
  const t2 = await s.acquire('k2', 1000);
  assert.ok(t1);
  assert.ok(t2);
});
test('InMemoryLockStore: size() reflects held count', async () => {
  const s = new InMemoryLockStore();
  await s.acquire('a', 1000);
  await s.acquire('b', 1000);
  assert.equal(s.size(), 2);
});

// ---- Skip paths --------------------------------------------------------

test('distributedLock: skips non-chat method by default', async () => {
  const store = new InMemoryLockStore();
  const mw = distributedLock({ store, keyOf: (c) => `k:${c.raw.tenant}` });
  await mw(makeCtx({ method: 'embed' }), async () => ({ text: 'ok' }));
  assert.equal(mw.stats.skipped, 1);
  assert.equal(mw.stats.acquired, 0);
});

test('distributedLock: skips when keyOf returns empty string', async () => {
  const store = new InMemoryLockStore();
  const mw = distributedLock({ store, keyOf: () => '' });
  await mw(makeCtx(), async () => ({ text: 'ok' }));
  assert.equal(mw.stats.skipped, 1);
});

test('distributedLock: skips when keyOf throws', async () => {
  const store = new InMemoryLockStore();
  const mw = distributedLock({ store, keyOf: () => { throw new Error('boom'); } });
  await mw(makeCtx(), async () => ({ text: 'ok' }));
  assert.equal(mw.stats.skipped, 1);
});

// ---- Acquire happy path ------------------------------------------------

test('distributedLock: single call acquires + releases', async () => {
  const store = new InMemoryLockStore();
  const mw = distributedLock({ store, keyOf: (c) => `k:${c.raw.tenant}` });
  const result = await mw(makeCtx(), async () => ({ text: 'ok' }));
  assert.equal(result.text, 'ok');
  assert.equal(mw.stats.acquired, 1);
  assert.equal(mw.stats.released, 1);
  assert.equal(store.size(), 0);   // released
});

test('distributedLock: releases lock even on error', async () => {
  const store = new InMemoryLockStore();
  const mw = distributedLock({ store, keyOf: (c) => `k:${c.raw.tenant}` });
  await assert.rejects(
    mw(makeCtx(), async () => { throw new Error('boom'); }),
    /boom/,
  );
  assert.equal(mw.stats.released, 1);
  assert.equal(store.size(), 0);
});

test('distributedLock: onAcquire fires with info', async () => {
  const store = new InMemoryLockStore();
  const events = [];
  const mw = distributedLock({
    store, keyOf: () => 'my-key',
    onAcquire: (info) => events.push(info),
  });
  await mw(makeCtx(), async () => ({ text: 'ok' }));
  assert.equal(events.length, 1);
  assert.equal(events[0].key, 'my-key');
  assert.equal(events[0].method, 'chat');
  assert.ok(events[0].token);
});

test('distributedLock: onRelease fires with released flag', async () => {
  const store = new InMemoryLockStore();
  const events = [];
  const mw = distributedLock({
    store, keyOf: () => 'k',
    onRelease: (info) => events.push(info),
  });
  await mw(makeCtx(), async () => ({ text: 'ok' }));
  assert.equal(events.length, 1);
  assert.equal(events[0].released, true);
});

test('distributedLock: different keys don\'t block each other', async () => {
  const store = new InMemoryLockStore();
  const mw = distributedLock({ store, keyOf: (c) => `k:${c.raw.tenant}` });
  const p1 = mw(makeCtx({ tenant: 'A' }), async () => new Promise((r) => setTimeout(() => r({ text: 'A' }), 50)));
  const p2 = mw(makeCtx({ tenant: 'B' }), async () => ({ text: 'B' }));
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.text, 'A');
  assert.equal(r2.text, 'B');
  assert.equal(mw.stats.acquired, 2);
  assert.equal(mw.stats.waited, 0);
});

// ---- action=reject -----------------------------------------------------

test('distributedLock: action=reject throws when held', async () => {
  const store = new InMemoryLockStore();
  const mw = distributedLock({
    store, keyOf: () => 'k', action: 'reject',
  });
  // First call takes the lock and waits for release trigger.
  let release;
  const gate = new Promise((r) => { release = r; });
  const first = mw(makeCtx(), async () => { await gate; return { text: 'ok' }; });
  // Ensure first has acquired.
  await new Promise((r) => setTimeout(r, 10));
  // Second call should reject immediately.
  await assert.rejects(
    mw(makeCtx(), async () => ({ text: 'never' })),
    (err) => {
      assert.ok(err instanceof DistributedLockHeldError);
      assert.ok(err instanceof LLMError);
      assert.equal(err.code, 'DISTRIBUTED_LOCK_HELD');
      assert.equal(err.httpStatus, 423);
      return true;
    },
  );
  release();
  await first;
  assert.equal(mw.stats.rejected, 1);
});

test('distributedLock: action=reject fires onReject', async () => {
  const store = new InMemoryLockStore();
  const events = [];
  const mw = distributedLock({
    store, keyOf: () => 'k', action: 'reject',
    onReject: (info) => events.push(info),
  });
  let release;
  const gate = new Promise((r) => { release = r; });
  const first = mw(makeCtx(), async () => { await gate; return { text: 'ok' }; });
  await new Promise((r) => setTimeout(r, 10));
  await assert.rejects(mw(makeCtx(), async () => ({ text: 'no' })));
  release();
  await first;
  assert.equal(events.length, 1);
  assert.equal(events[0].key, 'k');
});

// ---- action=wait -------------------------------------------------------

test('distributedLock: action=wait polls until released', async () => {
  const store = new InMemoryLockStore();
  const mw = distributedLock({
    store, keyOf: () => 'k', action: 'wait',
    waitTimeoutMs: 5000, waitPollMs: 20,
  });
  let release;
  const gate = new Promise((r) => { release = r; });
  const first = mw(makeCtx(), async () => { await gate; return { text: 'first' }; });
  await new Promise((r) => setTimeout(r, 10));
  // Start second (should wait), then release first after a delay.
  const second = mw(makeCtx(), async () => ({ text: 'second' }));
  await new Promise((r) => setTimeout(r, 50));
  release();
  const [r1, r2] = await Promise.all([first, second]);
  assert.equal(r1.text, 'first');
  assert.equal(r2.text, 'second');
  assert.equal(mw.stats.waited, 1);
  assert.equal(mw.stats.acquired, 2);
});

test('distributedLock: action=wait times out → DistributedLockTimeoutError', async () => {
  const store = new InMemoryLockStore();
  const mw = distributedLock({
    store, keyOf: () => 'k', action: 'wait',
    waitTimeoutMs: 100, waitPollMs: 20,
  });
  let release;
  const gate = new Promise((r) => { release = r; });
  const first = mw(makeCtx(), async () => { await gate; return { text: 'ok' }; });
  await new Promise((r) => setTimeout(r, 10));
  await assert.rejects(
    mw(makeCtx(), async () => ({ text: 'no' })),
    (err) => {
      assert.ok(err instanceof DistributedLockTimeoutError);
      assert.equal(err.code, 'DISTRIBUTED_LOCK_TIMEOUT');
      assert.equal(err.httpStatus, 503);
      assert.ok(err.waitedMs >= 100);
      return true;
    },
  );
  release();
  await first;
  assert.equal(mw.stats.timedOut, 1);
});

test('distributedLock: action=wait onWait fires with info', async () => {
  const store = new InMemoryLockStore();
  const events = [];
  const mw = distributedLock({
    store, keyOf: () => 'k', action: 'wait',
    waitTimeoutMs: 5000, waitPollMs: 20,
    onWait: (info) => events.push(info),
  });
  let release;
  const gate = new Promise((r) => { release = r; });
  const first = mw(makeCtx(), async () => { await gate; return { text: 'ok' }; });
  await new Promise((r) => setTimeout(r, 10));
  const second = mw(makeCtx(), async () => ({ text: 'ok2' }));
  await new Promise((r) => setTimeout(r, 30));
  release();
  await Promise.all([first, second]);
  assert.equal(events.length, 1);
  assert.equal(events[0].key, 'k');
  assert.equal(events[0].waitTimeoutMs, 5000);
});

// ---- TTL --------------------------------------------------------------

test('distributedLock: expired lock allows re-acquisition mid-chain', async () => {
  const store = new InMemoryLockStore();
  // Manually acquire + let it expire.
  await store.acquire('k', 50);
  await new Promise((r) => setTimeout(r, 80));
  // Middleware should now be able to acquire since prior lock expired.
  const mw = distributedLock({ store, keyOf: () => 'k' });
  const result = await mw(makeCtx(), async () => ({ text: 'ok' }));
  assert.equal(result.text, 'ok');
  assert.equal(mw.stats.acquired, 1);
});

// ---- Release errors --------------------------------------------------

test('distributedLock: release error → releaseErrors counter, request result preserved', async () => {
  const store = {
    async acquire() { return 'tok'; },
    async release() { throw new Error('release failed'); },
  };
  const mw = distributedLock({ store, keyOf: () => 'k' });
  const result = await mw(makeCtx(), async () => ({ text: 'ok' }));
  assert.equal(result.text, 'ok');
  assert.equal(mw.stats.releaseErrors, 1);
});

// ---- Callbacks: error handling ---------------------------------------

test('distributedLock: onAcquire error swallowed', async () => {
  const store = new InMemoryLockStore();
  const mw = distributedLock({
    store, keyOf: () => 'k',
    onAcquire: () => { throw new Error('broken listener'); },
  });
  const result = await mw(makeCtx(), async () => ({ text: 'ok' }));
  assert.equal(result.text, 'ok');
});

// ---- MCP + reset -----------------------------------------------------

test('distributedLock: asMcpResource', () => {
  const store = new InMemoryLockStore();
  const mw = distributedLock({
    store, keyOf: () => 'k', ttlMs: 5000, action: 'reject',
  });
  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://distributed-lock');
  const p = r.handler();
  assert.equal(p.ttlMs, 5000);
  assert.equal(p.action, 'reject');
  assert.equal(p.storeType, 'InMemoryLockStore');
  assert.equal(p.currentHeld, 0);
});

test('distributedLock: reset clears counters', async () => {
  const store = new InMemoryLockStore();
  const mw = distributedLock({ store, keyOf: () => 'k' });
  await mw(makeCtx(), async () => ({ text: 'ok' }));
  assert.equal(mw.stats.acquired, 1);
  mw.reset();
  assert.equal(mw.stats.acquired, 0);
  assert.equal(mw.stats.released, 0);
});

// ---- Error class shape -----------------------------------------------

test('DistributedLockHeldError shape', () => {
  const err = new DistributedLockHeldError('my-key');
  assert.ok(err instanceof LLMError);
  assert.equal(err.code, 'DISTRIBUTED_LOCK_HELD');
  assert.equal(err.primitive, 'distributedLock');
  assert.equal(err.httpStatus, 423);
  assert.equal(err.retriable, true);
  assert.equal(err.key, 'my-key');
});

test('DistributedLockTimeoutError shape', () => {
  const err = new DistributedLockTimeoutError('my-key', 5000);
  assert.equal(err.code, 'DISTRIBUTED_LOCK_TIMEOUT');
  assert.equal(err.httpStatus, 503);
  assert.equal(err.waitedMs, 5000);
});
