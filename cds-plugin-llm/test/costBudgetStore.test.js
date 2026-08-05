const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_budget_store__';
require.cache[STUB_PATH] = {
  exports: {
    Service: class { constructor(name, model, options) { this.options = options ?? {}; } async init() {} },
    log: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  },
  loaded: true,
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function(request, ...rest) {
  if (request === '@sap/cds') return STUB_PATH;
  return origResolve.call(this, request, ...rest);
};

const LLMService = require('../lib/LLMService');
const {
  costBudget,
  BudgetExceededError,
  InMemoryCounterStore,
  RedisCounterStore,
} = require('../lib/middleware/costBudget');

class Stub extends LLMService {
  async init() { await super.init(); this.calls = 0; }
  async _chat(params) {
    this.calls++;
    return {
      text: 'ok',
      model: params.model,
      usage: this._nextUsage ?? { input_tokens: 100, output_tokens: 200 },
      stopReason: 'end_turn',
    };
  }
}
function makeSvc(modelId = 'claude-opus-4-7') {
  return new Stub('llm', null, { modelId, maxTokens: 500 });
}
function setUsage(svc, i, o) { svc._nextUsage = { input_tokens: i, output_tokens: o }; }

// ---- InMemoryCounterStore standalone ----------------------------------

test('InMemoryCounterStore: add / get roundtrip is stable', () => {
  const s = new InMemoryCounterStore();
  s.add('total', 'total', '2026-08-05', 0.10);
  s.add('total', 'total', '2026-08-05', 0.25);
  assert.equal(s.get('total', 'total', '2026-08-05'), 0.35);
  assert.equal(s.get('total', 'total', '2026-08-06'), 0, 'different bucket → separate counter');
});

test('InMemoryCounterStore: snapshot groups by scope and only includes the target bucket', () => {
  const s = new InMemoryCounterStore();
  s.add('total', 'total', 'day-A', 10);
  s.add('perTenant', 'acme', 'day-A', 4);
  s.add('perModel',  'claude-opus-4-7', 'day-A', 6);
  s.add('total', 'total', 'day-B', 999); // ignored by day-A snapshot
  const snap = s.snapshot('day-A');
  assert.equal(snap.total, 10);
  assert.equal(snap.perTenant.acme, 4);
  assert.equal(snap.perModel['claude-opus-4-7'], 6);
  assert.equal(snap.perTenant.other, undefined);
});

test('InMemoryCounterStore: clear() zeroes everything', () => {
  const s = new InMemoryCounterStore();
  s.add('total', 'total', 'B', 5);
  s.clear();
  assert.equal(s.get('total', 'total', 'B'), 0);
  assert.deepEqual(s.snapshot('B'), { total: 0, perTenant: {}, perModel: {} });
});

// ---- Custom async store — proves the interface is honored -------------

test('costBudget: uses a custom async store (async get / add / snapshot / clear)', async () => {
  const svc = makeSvc('claude-opus-4-7'); await svc.init();
  const asyncStore = makeAsyncMemoryStore();
  const budget = costBudget({
    limits: { total: 0.05 },
    store: asyncStore,
    tenantOf: (ctx) => ctx.raw?.tenant,
  });
  svc.use(budget);
  setUsage(svc, 1e6, 0); // $15 on claude-opus-4-7
  await svc.chat({ messages: [{ role: 'user', content: 'a' }], tenant: 'acme' });
  // Async store used → mw.spentTotal() returns a promise
  const spent = await budget.spentTotal();
  assert.ok(spent > 0.05);
  // Async store used → next pre-call should refuse (block)
  await assert.rejects(
    () => svc.chat({ messages: [{ role: 'user', content: 'b' }], tenant: 'acme' }),
    (err) => err instanceof BudgetExceededError,
  );
  assert.ok(asyncStore.opCount.get > 0, 'store.get was called');
  assert.ok(asyncStore.opCount.add > 0, 'store.add was called');
});

test('costBudget: async store snapshot() returns promise; asMcpResource awaits it', async () => {
  const svc = makeSvc('claude-opus-4-7'); await svc.init();
  const asyncStore = makeAsyncMemoryStore();
  const budget = costBudget({
    limits: { total: 100 },
    store: asyncStore,
    tenantOf: (ctx) => ctx.raw?.tenant,
  });
  svc.use(budget);
  setUsage(svc, 1000, 500);
  await svc.chat({ messages: [{ role: 'user', content: 'a' }], tenant: 'acme' });
  const snap = await budget.snapshot();
  assert.ok(snap.total > 0);
  assert.ok(snap.perTenant.acme > 0);
  const payload = await budget.asMcpResource().handler();
  assert.equal(payload.currency, 'USD');
  assert.ok(payload.current.total > 0);
});

test('costBudget: reset() on async store propagates via promise', async () => {
  const svc = makeSvc(); await svc.init();
  const asyncStore = makeAsyncMemoryStore();
  const budget = costBudget({ store: asyncStore });
  svc.use(budget);
  setUsage(svc, 1e5, 1e5);
  await svc.chat({ messages: [{ role: 'user', content: 'a' }] });
  assert.ok((await budget.spentTotal()) > 0);
  await budget.reset();
  assert.equal(await budget.spentTotal(), 0);
});

// ---- RedisCounterStore against a mock ioredis client -------------------

test('RedisCounterStore: rejects missing client', () => {
  assert.throws(() => new RedisCounterStore(null), /client is required/);
});

test('RedisCounterStore: add uses INCRBYFLOAT and namespaces keys', async () => {
  const fake = makeFakeRedis();
  const store = new RedisCounterStore(fake, { namespace: 'test:budget', keyTtlSeconds: 3600 });
  await store.add('total', 'total', '2026-08-05', 0.25);
  await store.add('total', 'total', '2026-08-05', 0.10);
  const raw = fake.map.get('test:budget:2026-08-05|total|total');
  assert.equal(parseFloat(raw), 0.35);
  assert.ok(fake.expireCalls.some(c => c.key === 'test:budget:2026-08-05|total|total' && c.ttl === 3600),
    'expire should have been set on the counter key');
});

test('RedisCounterStore: add(0) is a no-op (skips INCRBYFLOAT and EXPIRE)', async () => {
  const fake = makeFakeRedis();
  const store = new RedisCounterStore(fake, { keyTtlSeconds: 60 });
  const before = fake.incrCalls;
  await store.add('total', 'total', 'B', 0);
  assert.equal(fake.incrCalls, before, 'INCRBYFLOAT should NOT have been called');
  assert.equal(fake.expireCalls.length, 0, 'EXPIRE should NOT have been called');
});

test('RedisCounterStore: get returns 0 when key missing, number when present', async () => {
  const fake = makeFakeRedis();
  const store = new RedisCounterStore(fake, { namespace: 'ns' });
  assert.equal(await store.get('total', 'total', 'B'), 0);
  fake.map.set('ns:B|total|total', '0.42');
  assert.equal(await store.get('total', 'total', 'B'), 0.42);
});

test('RedisCounterStore: snapshot scans only the target bucket', async () => {
  const fake = makeFakeRedis();
  const store = new RedisCounterStore(fake, { namespace: 'ns' });
  // Bucket "target"
  await store.add('total', 'total', 'target', 1.00);
  await store.add('perTenant', 'acme', 'target', 0.75);
  await store.add('perModel',  'claude-opus-4-7', 'target', 0.25);
  // Bucket "other" — must be ignored
  await store.add('total', 'total', 'other', 999);

  const snap = await store.snapshot('target');
  assert.equal(snap.total, 1.00);
  assert.equal(snap.perTenant.acme, 0.75);
  assert.equal(snap.perModel['claude-opus-4-7'], 0.25);
  assert.equal(Object.keys(snap.perTenant).length, 1);
  assert.equal(Object.keys(snap.perModel).length, 1);
});

test('RedisCounterStore: snapshot handles empty bucket cleanly', async () => {
  const fake = makeFakeRedis();
  const store = new RedisCounterStore(fake, { namespace: 'ns' });
  const snap = await store.snapshot('empty-bucket');
  assert.deepEqual(snap, { total: 0, perTenant: {}, perModel: {} });
});

test('RedisCounterStore: clear() removes every key under the namespace', async () => {
  const fake = makeFakeRedis();
  const store = new RedisCounterStore(fake, { namespace: 'ns' });
  await store.add('total', 'total', 'B1', 1);
  await store.add('perModel', 'm', 'B2', 2);
  // Unrelated key survives
  fake.map.set('other:key', 'sacred');
  await store.clear();
  assert.equal(fake.map.get('ns:B1|total|total'), undefined);
  assert.equal(fake.map.get('ns:B2|perModel|m'),  undefined);
  assert.equal(fake.map.get('other:key'), 'sacred');
});

// ---- End-to-end with the fake Redis in the middleware chain -----------

test('costBudget: end-to-end with RedisCounterStore refuses over-limit call', async () => {
  const svc = makeSvc('claude-opus-4-7'); await svc.init();
  const fake = makeFakeRedis();
  const store = new RedisCounterStore(fake, { namespace: 'e2e' });
  const budget = costBudget({
    limits: { total: 0.05 },
    store,
    tenantOf: (ctx) => ctx.raw?.tenant,
  });
  svc.use(budget);
  setUsage(svc, 1e6, 0); // ~$15 — comfortably over $0.05
  await svc.chat({ messages: [{ role: 'user', content: 'a' }] });
  await assert.rejects(
    () => svc.chat({ messages: [{ role: 'user', content: 'b' }] }),
    (err) => err instanceof BudgetExceededError && err.scope === 'total',
  );
  // The block should have prevented the second _chat from executing.
  assert.equal(svc.calls, 1, 'LLM should have been called exactly once');
});

test('costBudget: two independent instances sharing a Redis store agree on spend', async () => {
  // Simulates two app instances hitting the same Redis. Same counters →
  // sum of both instances' spend must be visible to either budget.
  const fake = makeFakeRedis();
  const store = new RedisCounterStore(fake, { namespace: 'shared' });
  const svcA = makeSvc(); await svcA.init();
  const svcB = makeSvc(); await svcB.init();
  const budgetA = costBudget({ limits: { total: 0.05 }, store });
  const budgetB = costBudget({ limits: { total: 0.05 }, store });
  svcA.use(budgetA);
  svcB.use(budgetB);
  setUsage(svcA, 1e6, 0);
  setUsage(svcB, 1e6, 0);
  await svcA.chat({ messages: [{ role: 'user', content: 'a' }] });
  // Instance B sees instance A's spend and refuses.
  await assert.rejects(
    () => svcB.chat({ messages: [{ role: 'user', content: 'b' }] }),
    (err) => err instanceof BudgetExceededError,
  );
  assert.equal(svcB.calls, 0, 'instance B should never have called the LLM');
});

// ---- Fake stores -------------------------------------------------------

// Async wrapper around InMemoryCounterStore for interface conformance tests.
function makeAsyncMemoryStore() {
  const inner = new InMemoryCounterStore();
  const opCount = { get: 0, add: 0, snapshot: 0, clear: 0 };
  return {
    opCount,
    async get(...args)  { opCount.get++;      await tick(); return inner.get(...args); },
    async add(...args)  { opCount.add++;      await tick(); return inner.add(...args); },
    async snapshot(...args) { opCount.snapshot++; await tick(); return inner.snapshot(...args); },
    async clear()       { opCount.clear++;    await tick(); return inner.clear(); },
  };
}

function tick() { return new Promise((r) => setImmediate(r)); }

// Tiny in-memory Redis stand-in with the subset of ioredis's API that
// RedisCounterStore consumes.
function makeFakeRedis() {
  const map = new Map();
  const expireCalls = [];
  let incrCalls = 0;
  return {
    map,
    expireCalls,
    get incrCalls() { return incrCalls; },
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async incrbyfloat(key, amount) {
      incrCalls++;
      const cur = parseFloat(map.get(key) ?? '0');
      const next = cur + parseFloat(amount);
      map.set(key, String(next));
      return String(next);
    },
    async expire(key, ttl) { expireCalls.push({ key, ttl }); return 1; },
    async mget(...keys) { return keys.map((k) => map.has(k) ? map.get(k) : null); },
    async del(...keys) {
      let n = 0;
      for (const k of keys) if (map.delete(k)) n++;
      return n;
    },
    async scan(cursor, matchLit, pattern, countLit, count) {
      // Fake SCAN: return everything at once (cursor='0' terminates the loop).
      const re = globToRegex(pattern);
      const keys = [];
      for (const k of map.keys()) if (re.test(k)) keys.push(k);
      return ['0', keys];
    },
  };
}

function globToRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$');
}
