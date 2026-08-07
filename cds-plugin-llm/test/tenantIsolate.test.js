const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_ti__';
// Fake CAP with a mutable context so we can test the fallback
const fakeCdsContext = { value: null };
require.cache[STUB_PATH] = {
  exports: {
    Service: class { constructor(name, model, options) { this.options = options ?? {}; } async init() {} },
    log: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} }),
    get context() { return fakeCdsContext.value; },
    set context(v) { fakeCdsContext.value = v; },
  },
  loaded: true,
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function(request, ...rest) {
  if (request === '@sap/cds') return STUB_PATH;
  return origResolve.call(this, request, ...rest);
};

const { tenantIsolate } = require('../lib/middleware/tenantIsolate');
const { bulkhead } = require('../lib/middleware/bulkhead');
const { circuitBreaker } = require('../lib/middleware/circuitBreaker');

function invoke(mw, { tenant = null, next = async () => ({ text: 'ok' }) } = {}) {
  const ctx = { method: 'chat', request: {}, raw: tenant != null ? { tenant } : {}, meta: {} };
  return { ctx, promise: mw(ctx, next) };
}

// ---- Input validation --------------------------------------------------

test('tenantIsolate: throws when factory is missing', () => {
  assert.throws(() => tenantIsolate(), /factory must be a function/);
});

test('tenantIsolate: throws when tenantOf is not a function', () => {
  assert.throws(() => tenantIsolate({ factory: () => {}, tenantOf: 'not fn' }), /tenantOf must be a function/);
});

test('tenantIsolate: throws when factory returns non-function value', async () => {
  const iso = tenantIsolate({ factory: () => 'not a middleware' });
  await assert.rejects(invoke(iso).promise, /factory.*must return/);
});

test('tenantIsolate: throws when factory returns array with a non-function entry', async () => {
  const iso = tenantIsolate({ factory: () => [async () => {}, 'nope'] });
  await assert.rejects(invoke(iso).promise, /non-function in the middleware array/);
});

// ---- Per-tenant isolation ---------------------------------------------

test('tenantIsolate: separate bulkheads per tenant — one tenant does not fill the other', async () => {
  let createdFor = [];
  const iso = tenantIsolate({
    factory: (tenantId) => {
      createdFor.push(tenantId);
      return bulkhead({ maxConcurrent: 1, maxQueued: 0 });
    },
  });

  // Simulate tenant A: hold their in-flight slot
  let releaseA;
  const heldA = new Promise((r) => { releaseA = r; });
  const pA = invoke(iso, { tenant: 'acme', next: () => heldA });
  await new Promise((r) => setImmediate(r));

  // Tenant A's slot is now filled. Tenant B should get their OWN slot, not be rejected.
  const resB = await invoke(iso, { tenant: 'wonka', next: async () => ({ text: 'B result' }) }).promise;
  assert.equal(resB.text, 'B result');

  // Two tenants, two factories called
  assert.deepEqual(createdFor.sort(), ['acme', 'wonka']);

  releaseA({ text: 'A result' });
  await pA.promise;
});

test('tenantIsolate: same tenant → SHARED bulkhead (second call queues / rejects)', async () => {
  const iso = tenantIsolate({
    factory: () => bulkhead({ maxConcurrent: 1, maxQueued: 0 }),
  });

  // First call for tenant 'acme': holds the slot
  let releaseFirst;
  const held = new Promise((r) => { releaseFirst = r; });
  const p1 = invoke(iso, { tenant: 'acme', next: () => held });
  await new Promise((r) => setImmediate(r));

  // Second call SAME tenant: bulkhead full → rejects
  await assert.rejects(
    invoke(iso, { tenant: 'acme' }).promise,
    /queue is full/,
  );

  releaseFirst({ text: 'first' });
  await p1.promise;
});

test('tenantIsolate: separate breakers per tenant — one tenant\'s failures don\'t affect another', async () => {
  const iso = tenantIsolate({
    factory: () => circuitBreaker({ threshold: 2, cooldownMs: 30_000 }),
  });

  // Tenant A: 2 failures → circuit opens for A
  const err500 = Object.assign(new Error('boom'), { status: 500 });
  await invoke(iso, { tenant: 'acme', next: async () => { throw err500; } }).promise.catch(() => {});
  await invoke(iso, { tenant: 'acme', next: async () => { throw err500; } }).promise.catch(() => {});
  await assert.rejects(
    invoke(iso, { tenant: 'acme' }).promise,
    /circuit is OPEN/,
  );

  // Tenant B: unaffected — their breaker is fresh
  const resB = await invoke(iso, { tenant: 'wonka' }).promise;
  assert.deepEqual(resB, { text: 'ok' });
});

// ---- Composable middleware array --------------------------------------

test('tenantIsolate: factory can return an array of middleware, composed in order', async () => {
  const iso = tenantIsolate({
    factory: () => [
      circuitBreaker({ threshold: 2, cooldownMs: 30_000 }),
      bulkhead({ maxConcurrent: 5, maxQueued: 10 }),
    ],
  });
  const res = await invoke(iso, { tenant: 'acme' }).promise;
  assert.deepEqual(res, { text: 'ok' });
});

test('tenantIsolate: array chain composes in Koa style — outer-first', async () => {
  const observed = [];
  const iso = tenantIsolate({
    factory: () => [
      async (ctx, next) => { observed.push('outer-before'); const r = await next(); observed.push('outer-after'); return r; },
      async (ctx, next) => { observed.push('inner-before'); const r = await next(); observed.push('inner-after'); return r; },
    ],
  });
  await invoke(iso, { tenant: 'acme' }).promise;
  assert.deepEqual(observed, ['outer-before', 'inner-before', 'inner-after', 'outer-after']);
});

// ---- Lazy instantiation ----------------------------------------------

test('tenantIsolate: factory called ONCE per tenant, reused on subsequent calls', async () => {
  let calls = 0;
  const iso = tenantIsolate({
    factory: () => { calls++; return async (ctx, next) => next(); },
  });
  await invoke(iso, { tenant: 'acme' }).promise;
  await invoke(iso, { tenant: 'acme' }).promise;
  await invoke(iso, { tenant: 'acme' }).promise;
  assert.equal(calls, 1, 'factory should be called once per tenant');
  await invoke(iso, { tenant: 'wonka' }).promise;
  assert.equal(calls, 2, 'new tenant → new factory call');
});

// ---- Default tenantOf --------------------------------------------------

test('tenantIsolate: default tenantOf reads ctx.raw.tenant first', async () => {
  fakeCdsContext.value = { tenant: 'from-cds' };
  const seen = [];
  const iso = tenantIsolate({
    factory: (tenantId) => { seen.push(tenantId); return async (ctx, next) => next(); },
  });
  await invoke(iso, { tenant: 'from-raw' }).promise;
  assert.deepEqual(seen, ['from-raw']);
  fakeCdsContext.value = null;
});

test('tenantIsolate: default tenantOf falls back to cds.context.tenant', async () => {
  fakeCdsContext.value = { tenant: 'from-cds-ctx' };
  const seen = [];
  const iso = tenantIsolate({
    factory: (tenantId) => { seen.push(tenantId); return async (ctx, next) => next(); },
  });
  // No ctx.raw.tenant → falls to cds.context.tenant
  await iso({ method: 'chat', request: {}, raw: {}, meta: {} }, async () => ({}));
  assert.deepEqual(seen, ['from-cds-ctx']);
  fakeCdsContext.value = null;
});

test('tenantIsolate: default tenantOf falls back to "default" when nothing set', async () => {
  fakeCdsContext.value = null;
  const seen = [];
  const iso = tenantIsolate({
    factory: (tenantId) => { seen.push(tenantId); return async (ctx, next) => next(); },
  });
  await iso({ method: 'chat', request: {}, raw: {}, meta: {} }, async () => ({}));
  assert.deepEqual(seen, ['default']);
});

test('tenantIsolate: tenantOf that throws → falls to "default"', async () => {
  const seen = [];
  const iso = tenantIsolate({
    tenantOf: () => { throw new Error('bad'); },
    factory:  (tenantId) => { seen.push(tenantId); return async (ctx, next) => next(); },
  });
  await invoke(iso).promise;
  assert.deepEqual(seen, ['default']);
});

test('tenantIsolate: null / undefined tenantOf result → "default"', async () => {
  const seen = [];
  const iso = tenantIsolate({
    tenantOf: () => null,
    factory:  (tenantId) => { seen.push(tenantId); return async (ctx, next) => next(); },
  });
  await invoke(iso).promise;
  assert.deepEqual(seen, ['default']);
});

test('tenantIsolate: numeric / non-string tenant IDs get stringified', async () => {
  const seen = [];
  const iso = tenantIsolate({
    tenantOf: () => 42,
    factory:  (tenantId) => { seen.push({ id: tenantId, type: typeof tenantId }); return async (ctx, next) => next(); },
  });
  await invoke(iso).promise;
  assert.equal(seen[0].type, 'string');
  assert.equal(seen[0].id, '42');
});

// ---- Callbacks --------------------------------------------------------

test('tenantIsolate: onTenantCreate fires once per new tenant', async () => {
  const events = [];
  const iso = tenantIsolate({
    factory: () => async (ctx, next) => next(),
    onTenantCreate: (id) => events.push(id),
  });
  await invoke(iso, { tenant: 'a' }).promise;
  await invoke(iso, { tenant: 'a' }).promise;
  await invoke(iso, { tenant: 'b' }).promise;
  assert.deepEqual(events, ['a', 'b']);
});

test('tenantIsolate: onRequest fires for every request', async () => {
  const events = [];
  const iso = tenantIsolate({
    factory: () => async (ctx, next) => next(),
    onRequest: (info) => events.push(info),
  });
  await invoke(iso, { tenant: 'a' }).promise;
  await invoke(iso, { tenant: 'b' }).promise;
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.tenantId), ['a', 'b']);
});

test('tenantIsolate: callback exceptions are swallowed', async () => {
  const iso = tenantIsolate({
    factory: () => async (ctx, next) => next(),
    onTenantCreate: () => { throw new Error('handler broken'); },
    onRequest:      () => { throw new Error('handler broken'); },
  });
  const res = await invoke(iso, { tenant: 'a' }).promise;
  assert.deepEqual(res, { text: 'ok' });
});

// ---- Introspection ---------------------------------------------------

test('tenantIsolate: tenants() lists all seen tenants', async () => {
  const iso = tenantIsolate({ factory: () => async (ctx, next) => next() });
  await invoke(iso, { tenant: 'acme' }).promise;
  await invoke(iso, { tenant: 'wonka' }).promise;
  await invoke(iso, { tenant: 'stark' }).promise;
  assert.deepEqual(iso.tenants().sort(), ['acme', 'stark', 'wonka']);
});

test('tenantIsolate: chainFor returns the tenant\'s middleware array', async () => {
  const iso = tenantIsolate({
    factory: () => [circuitBreaker({ threshold: 3 }), bulkhead({ maxConcurrent: 5 })],
  });
  await invoke(iso, { tenant: 'acme' }).promise;
  const chain = iso.chainFor('acme');
  assert.equal(chain.length, 2);
  // Reach in for stats
  assert.equal(typeof chain[0].stats, 'object');   // breaker stats
  assert.equal(typeof chain[1].stats, 'object');   // bulkhead stats
});

test('tenantIsolate: chainFor returns null for unknown tenant', () => {
  const iso = tenantIsolate({ factory: () => async (ctx, next) => next() });
  assert.equal(iso.chainFor('never-seen'), null);
});

test('tenantIsolate: statsFor returns per-tenant request count', async () => {
  const iso = tenantIsolate({ factory: () => async (ctx, next) => next() });
  await invoke(iso, { tenant: 'a' }).promise;
  await invoke(iso, { tenant: 'a' }).promise;
  await invoke(iso, { tenant: 'b' }).promise;
  assert.equal(iso.statsFor('a').requests, 2);
  assert.equal(iso.statsFor('b').requests, 1);
  assert.equal(iso.statsFor('never'), null);
});

test('tenantIsolate: reset(tenantId) clears just that tenant', async () => {
  let calls = 0;
  const iso = tenantIsolate({
    factory: () => { calls++; return async (ctx, next) => next(); },
  });
  await invoke(iso, { tenant: 'a' }).promise;
  iso.reset('a');
  assert.deepEqual(iso.tenants(), []);
  // Next call for 'a' → factory called again
  await invoke(iso, { tenant: 'a' }).promise;
  assert.equal(calls, 2);
});

test('tenantIsolate: reset() clears everything', async () => {
  const iso = tenantIsolate({ factory: () => async (ctx, next) => next() });
  await invoke(iso, { tenant: 'a' }).promise;
  await invoke(iso, { tenant: 'b' }).promise;
  iso.reset();
  assert.deepEqual(iso.tenants(), []);
  assert.equal(iso.stats.requests, 0);
  assert.equal(iso.stats.tenantsSeen, 0);
});

// ---- MCP resource ---------------------------------------------------

test('tenantIsolate: asMcpResource() returns config://tenant-isolate snapshot', async () => {
  const iso = tenantIsolate({
    factory: () => [circuitBreaker({ threshold: 3 })],
  });
  await invoke(iso, { tenant: 'acme' }).promise;
  await invoke(iso, { tenant: 'acme' }).promise;
  await invoke(iso, { tenant: 'wonka' }).promise;
  const res = iso.asMcpResource();
  assert.equal(res.uri, 'config://tenant-isolate');
  assert.equal(res.mimeType, 'application/json');
  const snap = res.handler();
  assert.equal(snap.tenantsSeen, 2);
  assert.equal(snap.requests, 3);
  assert.deepEqual(snap.tenants.sort(), ['acme', 'wonka']);
  assert.equal(snap.perTenant.acme.requests, 2);
  assert.equal(snap.perTenant.acme.middlewareCount, 1);
  assert.equal(snap.perTenant.wonka.requests, 1);
});
