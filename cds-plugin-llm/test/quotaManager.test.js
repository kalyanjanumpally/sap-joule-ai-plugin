const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_qm__';
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
  quotaManager,
  inMemoryQuotaStore,
  QuotaExhaustedError,
} = require('../lib/middleware/quotaManager');

// ---- Helpers ----------------------------------------------------------

function ctxWith(userId) { return { request: { userId } }; }

// A downstream that returns a fixed-cost response.
function fixedCost(cost) {
  return async () => ({ text: 'ok', _cost: cost });
}
const costOfFixed = (_ctx, r) => r._cost;

// ---- inMemoryQuotaStore ----------------------------------------------

test('inMemoryQuotaStore: validates maxKeys', () => {
  assert.throws(() => inMemoryQuotaStore({ maxKeys: 0 }), /maxKeys/);
});
test('inMemoryQuotaStore: add + get', async () => {
  let t = 1000;
  const s = inMemoryQuotaStore({ now: () => t });
  await s.add('u1', 0.5, t);
  const e = await s.get('u1');
  assert.equal(e.samples.length, 1);
  assert.equal(e.samples[0].cost, 0.5);
});
test('inMemoryQuotaStore: unknown key → null', async () => {
  const s = inMemoryQuotaStore();
  assert.equal(await s.get('nope'), null);
});
test('inMemoryQuotaStore: maxKeys evicts oldest', async () => {
  const s = inMemoryQuotaStore({ maxKeys: 2 });
  await s.add('a', 1, 1);
  await s.add('b', 1, 1);
  await s.add('c', 1, 1);
  assert.equal(await s.get('a'), null);
  assert.ok(await s.get('c'));
});
test('inMemoryQuotaStore: reset clears one key', async () => {
  const s = inMemoryQuotaStore();
  await s.add('u', 1, 1);
  await s.reset('u');
  assert.equal(await s.get('u'), null);
});
test('inMemoryQuotaStore: setLastWarnLevel persists', async () => {
  const s = inMemoryQuotaStore();
  await s.add('u', 1, 1);
  await s.setLastWarnLevel('u', 0.8);
  const e = await s.get('u');
  assert.equal(e.lastWarnLevel, 0.8);
});

// ---- Middleware: validation ----------------------------------------

test('quotaManager: throws without keyOf', () => {
  assert.throws(() => quotaManager({ store: inMemoryQuotaStore(), costOf: () => 0 }), /keyOf/);
});
test('quotaManager: throws without store', () => {
  assert.throws(() => quotaManager({ keyOf: () => 'x', costOf: () => 0 }), /store/);
});
test('quotaManager: throws without costOf', () => {
  assert.throws(() => quotaManager({ keyOf: () => 'x', store: inMemoryQuotaStore() }), /costOf/);
});
test('quotaManager: throws on invalid quota', () => {
  assert.throws(() => quotaManager({
    keyOf: () => 'x', store: inMemoryQuotaStore(), costOf: () => 0,
    quotas: { u: { limitUsd: -1 } },
  }), /limitUsd/);
});
test('quotaManager: throws on invalid defaultLimitUsd', () => {
  assert.throws(() => quotaManager({
    keyOf: () => 'x', store: inMemoryQuotaStore(), costOf: () => 0,
    defaultLimitUsd: 0,
  }), /defaultLimitUsd/);
});
test('quotaManager: throws on tiny windowMs', () => {
  assert.throws(() => quotaManager({
    keyOf: () => 'x', store: inMemoryQuotaStore(), costOf: () => 0,
    windowMs: 500,
  }), /windowMs/);
});
test('quotaManager: throws on out-of-range warnThreshold', () => {
  assert.throws(() => quotaManager({
    keyOf: () => 'x', store: inMemoryQuotaStore(), costOf: () => 0,
    warnThresholds: [1.5],
  }), /warnThresholds/);
});
test('quotaManager: throws on out-of-range gracePeriodRatio', () => {
  assert.throws(() => quotaManager({
    keyOf: () => 'x', store: inMemoryQuotaStore(), costOf: () => 0,
    gracePeriodRatio: 2,
  }), /gracePeriodRatio/);
});
test('quotaManager: throws on non-function callback', () => {
  assert.throws(() => quotaManager({
    keyOf: () => 'x', store: inMemoryQuotaStore(), costOf: () => 0,
    onWarn: 'x',
  }), /callbacks/);
});

// ---- Under quota: allows + records cost -------------------------

test('quotaManager: allows call under quota + records cost', async () => {
  const store = inMemoryQuotaStore();
  const mw = quotaManager({
    keyOf: (c) => c.request.userId, store, costOf: costOfFixed,
    defaultLimitUsd: 10,
  });
  const r = await mw(ctxWith('u1'), fixedCost(0.5));
  assert.equal(r.text, 'ok');
  const usage = await mw.getUsage('u1');
  assert.equal(usage.usageUsd, 0.5);
  assert.equal(usage.limitUsd, 10);
});

test('quotaManager: multiple calls accumulate', async () => {
  const store = inMemoryQuotaStore();
  const mw = quotaManager({
    keyOf: (c) => c.request.userId, store, costOf: costOfFixed,
    defaultLimitUsd: 10,
  });
  for (let i = 0; i < 5; i++) {
    await mw(ctxWith('u1'), fixedCost(0.5));
  }
  const usage = await mw.getUsage('u1');
  assert.equal(usage.usageUsd, 2.5);
  assert.equal(usage.utilization, 0.25);
});

// ---- Hard cap ----------------------------------------

test('quotaManager: at hard cap throws QuotaExhaustedError', async () => {
  const store = inMemoryQuotaStore();
  const mw = quotaManager({
    keyOf: (c) => c.request.userId, store, costOf: costOfFixed,
    defaultLimitUsd: 1, gracePeriodRatio: 0,
  });
  // Spend enough to hit the cap.
  await mw(ctxWith('u1'), fixedCost(1.0));
  // Next call should be blocked.
  await assert.rejects(mw(ctxWith('u1'), fixedCost(0.1)), QuotaExhaustedError);
});

test('quotaManager: gracePeriodRatio allows small overshoot', async () => {
  const store = inMemoryQuotaStore();
  const mw = quotaManager({
    keyOf: (c) => c.request.userId, store, costOf: costOfFixed,
    defaultLimitUsd: 1, gracePeriodRatio: 0.1,
  });
  // limitUsd=$1, gracePeriodRatio=0.1 → hardCap=$1.10.
  // 1st call: usage=$0. Below cap → allowed. After: usage=$0.85.
  // 2nd call: usage=$0.85. Below cap → allowed even though it pushes past $1.
  //   After: usage=$1.15 (over hardCap now).
  // 3rd call: usage=$1.15 ≥ hardCap → BLOCKED.
  await mw(ctxWith('u1'), fixedCost(0.85));
  await mw(ctxWith('u1'), fixedCost(0.30));   // pushes past $1, still under $1.10 at check time
  await assert.rejects(mw(ctxWith('u1'), fixedCost(0.1)), QuotaExhaustedError);
});

test('quotaManager: QuotaExhaustedError carries usage + limit + windowMs', async () => {
  const store = inMemoryQuotaStore();
  const mw = quotaManager({
    keyOf: (c) => c.request.userId, store, costOf: costOfFixed,
    defaultLimitUsd: 1, gracePeriodRatio: 0,
  });
  await mw(ctxWith('u1'), fixedCost(1.5));
  try {
    await mw(ctxWith('u1'), fixedCost(0.01));
    assert.fail('should throw');
  } catch (err) {
    assert.equal(err.code, 'QUOTA_EXHAUSTED');
    assert.equal(err.quotaKey, 'u1');
    assert.equal(err.limitUsd, 1);
    assert.ok(err.usageUsd >= 1);
    assert.ok(err.windowMs > 0);
  }
});

test('quotaManager: block short-circuits before next() runs', async () => {
  const store = inMemoryQuotaStore();
  const mw = quotaManager({
    keyOf: (c) => c.request.userId, store, costOf: costOfFixed,
    defaultLimitUsd: 1, gracePeriodRatio: 0,
  });
  await mw(ctxWith('u1'), fixedCost(1.5));
  let downstreamRan = false;
  try {
    await mw(ctxWith('u1'), async () => { downstreamRan = true; return { text: 'ok' }; });
  } catch { /* expected */ }
  assert.equal(downstreamRan, false);
});

// ---- Per-key quotas -----------------------------

test('quotaManager: per-key quota overrides default', async () => {
  const store = inMemoryQuotaStore();
  const mw = quotaManager({
    keyOf: (c) => c.request.userId, store, costOf: costOfFixed,
    defaultLimitUsd: 1,
    quotas: {
      'user-vip': { limitUsd: 100 },
    },
    gracePeriodRatio: 0,
  });
  // Normal user hits $1 quickly.
  await mw(ctxWith('u1'), fixedCost(1.0));
  await assert.rejects(mw(ctxWith('u1'), fixedCost(0.1)), QuotaExhaustedError);
  // VIP user gets $100 — same $1 spend is only 1% utilization.
  await mw(ctxWith('user-vip'), fixedCost(1.0));
  const vipUsage = await mw.getUsage('user-vip');
  assert.equal(vipUsage.limitUsd, 100);
  assert.equal(vipUsage.utilization, 0.01);
});

// ---- Warning thresholds ------------------------

test('quotaManager: rising-edge warnings fire once per level', async () => {
  const store = inMemoryQuotaStore();
  const events = [];
  const mw = quotaManager({
    keyOf: (c) => c.request.userId, store, costOf: costOfFixed,
    defaultLimitUsd: 10,
    warnThresholds: [0.5, 0.8, 0.95],
    onWarn: (i) => events.push(i.level),
  });
  // Ramp up: 0.2, 0.5 (fires 0.5), 0.85 (fires 0.8), 0.96 (fires 0.95).
  await mw(ctxWith('u1'), fixedCost(2));
  await mw(ctxWith('u1'), fixedCost(3));   // 5 total → 50%
  await mw(ctxWith('u1'), fixedCost(3.5)); // 8.5 → 85%
  await mw(ctxWith('u1'), fixedCost(1.5)); // 10 → 100%
  assert.deepEqual(events, [0.5, 0.8, 0.95]);
});

test('quotaManager: threshold only fires once at same level per rising crossing', async () => {
  const store = inMemoryQuotaStore();
  const events = [];
  const mw = quotaManager({
    keyOf: (c) => c.request.userId, store, costOf: costOfFixed,
    defaultLimitUsd: 10,
    warnThresholds: [0.5],
    onWarn: (i) => events.push(i.level),
  });
  await mw(ctxWith('u1'), fixedCost(3));   // 30%
  await mw(ctxWith('u1'), fixedCost(3));   // 60% — fires
  await mw(ctxWith('u1'), fixedCost(1));   // 70% — no fire
  await mw(ctxWith('u1'), fixedCost(0.5)); // 75% — no fire
  assert.equal(events.length, 1);
});

// ---- Cost tracking edge cases -----------------

test('quotaManager: zero cost → not tracked', async () => {
  const store = inMemoryQuotaStore();
  const mw = quotaManager({
    keyOf: (c) => c.request.userId, store, costOf: () => 0,
    defaultLimitUsd: 10,
  });
  await mw(ctxWith('u1'), async () => ({ text: 'free' }));
  const usage = await mw.getUsage('u1');
  assert.equal(usage.usageUsd, 0);
});

test('quotaManager: negative cost → not tracked', async () => {
  const store = inMemoryQuotaStore();
  const mw = quotaManager({
    keyOf: (c) => c.request.userId, store, costOf: () => -1,
    defaultLimitUsd: 10,
  });
  await mw(ctxWith('u1'), async () => ({ text: 'ok' }));
  const usage = await mw.getUsage('u1');
  assert.equal(usage.usageUsd, 0);
});

test('quotaManager: costOf throws → counted as costError, call succeeds', async () => {
  const store = inMemoryQuotaStore();
  const errors = [];
  const mw = quotaManager({
    keyOf: (c) => c.request.userId, store,
    costOf: () => { throw new Error('cost bug'); },
    defaultLimitUsd: 10,
    onError: (i) => errors.push(i),
  });
  await mw(ctxWith('u1'), async () => ({ text: 'ok' }));
  assert.equal(mw.stats.costErrors, 1);
  assert.equal(errors[0].phase, 'costOf');
});

// ---- Sliding window --------------------

test('quotaManager: samples outside window not counted', async () => {
  let t = 1000;
  const store = inMemoryQuotaStore({ now: () => t });
  const mw = quotaManager({
    keyOf: (c) => c.request.userId, store, costOf: costOfFixed,
    defaultLimitUsd: 10, windowMs: 1000,
    now: () => t,
  });
  await mw(ctxWith('u1'), fixedCost(5));
  assert.equal((await mw.getUsage('u1')).usageUsd, 5);
  t = 5000;
  assert.equal((await mw.getUsage('u1')).usageUsd, 0);
});

test('quotaManager: after window expires, blocked user can call again', async () => {
  let t = 1000;
  const store = inMemoryQuotaStore({ now: () => t });
  const mw = quotaManager({
    keyOf: (c) => c.request.userId, store, costOf: costOfFixed,
    defaultLimitUsd: 1, gracePeriodRatio: 0, windowMs: 1000,
    now: () => t,
  });
  await mw(ctxWith('u1'), fixedCost(1.5));
  await assert.rejects(mw(ctxWith('u1'), fixedCost(0.1)), QuotaExhaustedError);
  t = 5000;
  // Window has expired — should work again.
  await mw(ctxWith('u1'), fixedCost(0.5));
});

// ---- Store errors -------------------

test('quotaManager: store.get error → fail open (call succeeds)', async () => {
  const badStore = {
    async get() { throw new Error('down'); },
    async add() {},
  };
  const mw = quotaManager({
    keyOf: (c) => c.request.userId, store: badStore, costOf: () => 0,
  });
  const r = await mw(ctxWith('u1'), async () => ({ text: 'ok' }));
  assert.equal(r.text, 'ok');
  assert.equal(mw.stats.storeErrors, 1);
});

// ---- Anonymous bucket -----------

test('quotaManager: no user → anon bucket', async () => {
  const store = inMemoryQuotaStore();
  const mw = quotaManager({
    keyOf: () => null, store, costOf: costOfFixed,
    defaultLimitUsd: 10,
  });
  await mw(ctxWith('nope'), fixedCost(1));
  const usage = await mw.getUsage('anon');
  assert.equal(usage.usageUsd, 1);
});

// ---- Callbacks --------------

test('quotaManager: onExhausted fires with usage info', async () => {
  const events = [];
  const store = inMemoryQuotaStore();
  const mw = quotaManager({
    keyOf: (c) => c.request.userId, store, costOf: costOfFixed,
    defaultLimitUsd: 1, gracePeriodRatio: 0,
    onExhausted: (i) => events.push(i),
  });
  await mw(ctxWith('u1'), fixedCost(1.5));
  try { await mw(ctxWith('u1'), fixedCost(0.1)); } catch {}
  assert.equal(events.length, 1);
  assert.equal(events[0].key, 'u1');
});

test('quotaManager: callback throws swallowed', async () => {
  const store = inMemoryQuotaStore();
  const mw = quotaManager({
    keyOf: (c) => c.request.userId, store, costOf: costOfFixed,
    defaultLimitUsd: 1,
    onWarn: () => { throw new Error('x'); },
    warnThresholds: [0.5],
  });
  await mw(ctxWith('u1'), fixedCost(0.8));   // crosses 50%
});

// ---- resetKey + stats + MCP -------------

test('quotaManager: resetKey clears usage for one user', async () => {
  const store = inMemoryQuotaStore();
  const mw = quotaManager({
    keyOf: (c) => c.request.userId, store, costOf: costOfFixed,
    defaultLimitUsd: 10,
  });
  await mw(ctxWith('u1'), fixedCost(5));
  assert.equal((await mw.getUsage('u1')).usageUsd, 5);
  await mw.resetKey('u1');
  assert.equal((await mw.getUsage('u1')).usageUsd, 0);
});

test('quotaManager: reset clears counters', async () => {
  const store = inMemoryQuotaStore();
  const mw = quotaManager({
    keyOf: (c) => c.request.userId, store, costOf: costOfFixed,
    defaultLimitUsd: 10,
  });
  await mw(ctxWith('u1'), fixedCost(1));
  mw.reset();
  assert.equal(mw.stats.totalCalls, 0);
});

test('quotaManager: asMcpResource', () => {
  const store = inMemoryQuotaStore();
  const mw = quotaManager({
    keyOf: (c) => c.request.userId, store, costOf: () => 0,
    defaultLimitUsd: 25,
    quotas: { vip: { limitUsd: 500 } },
    warnThresholds: [0.6, 0.9],
    gracePeriodRatio: 0.05,
  });
  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://quota-manager');
  const p = r.handler();
  assert.equal(p.defaultLimitUsd, 25);
  assert.deepEqual(p.warnThresholds, [0.6, 0.9]);
  assert.equal(p.gracePeriodRatio, 0.05);
});
