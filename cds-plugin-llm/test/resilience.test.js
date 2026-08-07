const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_res__';
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

const resilience = require('../lib/resilience');
const { validateMiddlewareOrder } = require('../lib/validateMiddlewareOrder');

// Fake service — captures the middleware use() calls in order.
function fakeLLM() {
  const svc = { middleware: [], use(mw) { svc.middleware.push(mw); return svc; } };
  return svc;
}

// ---- Default bundle -----------------------------------------------------

test('resilience.bundle: with no args wires all primitives except costBudget', () => {
  const stack = resilience.bundle();
  assert.ok(stack.deadline);
  assert.ok(stack.breaker);
  assert.ok(stack.bh);
  assert.ok(stack.retry);
  // costBudget requires budgetLimits — omitted here
  assert.equal(stack.budget, undefined);
  // Chain reflects only what got instantiated
  const kinds = stack.chain.map((c) => c.kind);
  assert.deepEqual(kinds, ['deadline', 'circuitBreaker', 'bulkhead', 'retryOnRateLimit']);
});

test('resilience.bundle: budget is wired when budgetLimits provided', () => {
  const stack = resilience.bundle({ budgetLimits: { total: 500 } });
  assert.ok(stack.budget);
  assert.equal(stack.chain[1].kind, 'costBudget');
});

// ---- apply(llm) --------------------------------------------------------

test('resilience.bundle: apply(llm) registers middleware in canonical order', () => {
  const stack = resilience.bundle({ budgetLimits: { total: 500 } });
  const llm = fakeLLM();
  stack.apply(llm);
  // The middleware array holds the actual instances — verify order by
  // comparing referential equality against the bundle's named fields.
  assert.equal(llm.middleware.length, 5);
  assert.equal(llm.middleware[0], stack.deadline);
  assert.equal(llm.middleware[1], stack.budget);
  assert.equal(llm.middleware[2], stack.breaker);
  assert.equal(llm.middleware[3], stack.bh);
  assert.equal(llm.middleware[4], stack.retry);
});

test('resilience.bundle: apply(llm) skips excluded primitives', () => {
  const stack = resilience.bundle({
    budgetLimits: { total: 500 },
    exclude: ['circuitBreaker', 'bulkhead'],
  });
  const llm = fakeLLM();
  stack.apply(llm);
  assert.equal(llm.middleware.length, 3);
  assert.equal(stack.breaker, undefined);
  assert.equal(stack.bh, undefined);
  const kinds = stack.chain.map((c) => c.kind);
  assert.deepEqual(kinds, ['deadline', 'costBudget', 'retryOnRateLimit']);
});

test('resilience.bundle: apply(llm) throws on service missing .use()', () => {
  const stack = resilience.bundle();
  assert.throws(() => stack.apply({}), /llm must expose \.use\(middleware\)/);
});

// ---- include/exclude ---------------------------------------------------

test('resilience.bundle: include restricts to the named subset', () => {
  const stack = resilience.bundle({
    include: ['deadline', 'retryOnRateLimit'],
  });
  assert.ok(stack.deadline);
  assert.ok(stack.retry);
  assert.equal(stack.breaker, undefined);
  assert.equal(stack.bh, undefined);
});

test('resilience.bundle: include + exclude combine — include first, then exclude', () => {
  const stack = resilience.bundle({
    include: ['deadline', 'circuitBreaker', 'bulkhead', 'retryOnRateLimit'],
    exclude: ['circuitBreaker'],
  });
  assert.ok(stack.deadline);
  assert.equal(stack.breaker, undefined);
  assert.ok(stack.bh);
  assert.ok(stack.retry);
});

// ---- Options plumbed to underlying primitives -------------------------

test('resilience.bundle: deadlineMs option is applied', () => {
  const stack = resilience.bundle({ deadlineMs: 7_777 });
  // asMcpResource() surfaces the resolved config
  const snap = stack.deadline.asMcpResource().handler();
  assert.equal(snap.timeoutMs, 7_777);
});

test('resilience.bundle: breakerThreshold + cooldown propagate', () => {
  const stack = resilience.bundle({
    breakerThreshold:  9,
    breakerCooldownMs: 12_345,
  });
  const snap = stack.breaker.asMcpResource().handler();
  assert.equal(snap.threshold, 9);
  assert.equal(snap.cooldownMs, 12_345);
});

test('resilience.bundle: bulkhead options propagate', () => {
  const stack = resilience.bundle({
    bulkheadMax:       42,
    bulkheadQueue:     100,
    bulkheadTimeoutMs: 8_888,
  });
  const snap = stack.bh.asMcpResource().handler();
  assert.equal(snap.maxConcurrent, 42);
  assert.equal(snap.maxQueued, 100);
  assert.equal(snap.queueTimeoutMs, 8_888);
});

test('resilience.bundle: retryAttempts + fallbackMs propagate', () => {
  const stack = resilience.bundle({
    retryAttempts:   7,
    retryFallbackMs: 4_444,
  });
  const snap = stack.retry.asMcpResource().handler();
  assert.equal(snap.maxAttempts, 7);
  assert.equal(snap.fallbackWaitMs, 4_444);
});

// ---- Callback hooks forwarded ------------------------------------------

test('resilience.bundle: onBreakerOpen callback is forwarded to the breaker', async () => {
  const events = [];
  const stack = resilience.bundle({
    breakerThreshold: 1,
    onBreakerOpen: (info) => events.push(info),
  });
  // Force one failure — reach threshold → onOpen fires
  const ctx = { service: { name: 'openai' }, method: 'chat' };
  try {
    await stack.breaker(ctx, async () => { throw Object.assign(new Error('x'), { status: 500 }); });
  } catch { /* expected */ }
  assert.equal(events.length, 1);
  assert.equal(events[0].provider, 'openai');
});

// ---- Chain validates against validateMiddlewareOrder ------------------

test('resilience.bundle: chain description passes validateMiddlewareOrder cleanly', () => {
  const stack = resilience.bundle({ budgetLimits: { total: 500 } });
  const check = validateMiddlewareOrder(stack.chain);
  assert.equal(check.ok, true);
  const nonInfo = check.warnings.filter((w) => w.severity !== 'info');
  assert.deepEqual(nonInfo, [], 'canonical bundle chain should have no warning-severity findings');
});

test('resilience.bundle: chain with only deadline+retry produces the right info findings', () => {
  const stack = resilience.bundle({
    include: ['deadline', 'retryOnRateLimit'],
  });
  const check = validateMiddlewareOrder(stack.chain);
  const codes = check.warnings.map((w) => w.code).sort();
  // Should flag missing pieces
  assert.ok(codes.includes('NO_METERING'));
  assert.ok(codes.includes('NO_SECURITY_LAYER'));
  assert.ok(codes.includes('NO_CIRCUIT_BREAKER'));
  assert.ok(codes.includes('NO_BULKHEAD'));
});

// ---- prometheusBundle + healthBundle shapes ---------------------------

test('resilience.bundle: prometheusBundle() returns keys prometheusHandler expects', () => {
  const stack = resilience.bundle({ budgetLimits: { total: 500 } });
  const b = stack.prometheusBundle();
  assert.equal(b.deadline, stack.deadline);
  assert.equal(b.budget,   stack.budget);
  assert.equal(b.breaker,  stack.breaker);
  assert.equal(b.bh,       stack.bh);
  assert.equal(b.retry,    stack.retry);
});

test('resilience.bundle: healthBundle() returns keys healthHandler expects', () => {
  const stack = resilience.bundle({ budgetLimits: { total: 500 } });
  const b = stack.healthBundle();
  assert.equal(b.deadline, stack.deadline);
  assert.equal(b.budget,   stack.budget);
  assert.equal(b.breaker,  stack.breaker);
  assert.equal(b.bh,       stack.bh);
  assert.equal(b.retry,    stack.retry);
});

test('resilience.bundle: prometheusBundle() omits excluded primitives', () => {
  const stack = resilience.bundle({
    include: ['deadline', 'retryOnRateLimit'],
  });
  const b = stack.prometheusBundle();
  assert.ok(b.deadline);
  assert.ok(b.retry);
  assert.equal(b.breaker, undefined);
  assert.equal(b.bh, undefined);
});

// ---- CANONICAL_ORDER exported -----------------------------------------

test('resilience.CANONICAL_ORDER: exports the canonical middleware order', () => {
  assert.deepEqual(resilience.CANONICAL_ORDER, [
    'deadline', 'costBudget', 'circuitBreaker', 'bulkhead', 'retryOnRateLimit',
  ]);
});
