const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_pf__';
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

const { preflight, PreflightError } = require('../lib/preflight');

// ---- Input validation --------------------------------------------------

test('preflight: throws on non-array requiredEnv', async () => {
  await assert.rejects(preflight({ requiredEnv: 'GROQ_API_KEY' }), /requiredEnv must be an array/);
});

test('preflight: throws on non-array providers', async () => {
  await assert.rejects(preflight({ providers: 'foo' }), /providers must be an array/);
});

test('preflight: throws on non-array chain', async () => {
  await assert.rejects(preflight({ chain: 'foo' }), /chain must be an array/);
});

test('preflight: throws on tiny timeoutMsPerCheck', async () => {
  await assert.rejects(preflight({ timeoutMsPerCheck: 50 }), /timeoutMsPerCheck/);
});

// ---- Empty preflight → ok ---------------------------------------------

test('preflight: no checks configured → ok', async () => {
  const report = await preflight({ failFast: false });
  assert.equal(report.ok, true);
  assert.equal(report.checks.length, 0);
  assert.equal(report.errors.length, 0);
  assert.equal(report.warnings.length, 0);
});

// ---- Env vars ---------------------------------------------------------

test('preflight: env var present → ok check', async () => {
  process.env.__PREFLIGHT_TEST_VAR = 'value';
  const report = await preflight({ requiredEnv: ['__PREFLIGHT_TEST_VAR'], failFast: false });
  assert.equal(report.ok, true);
  assert.equal(report.checks[0].status, 'ok');
  assert.equal(report.checks[0].name, 'env:__PREFLIGHT_TEST_VAR');
  delete process.env.__PREFLIGHT_TEST_VAR;
});

test('preflight: env var missing → error check + throws (default failFast)', async () => {
  delete process.env.__NEVER_SET_ME;
  await assert.rejects(
    preflight({ requiredEnv: ['__NEVER_SET_ME'] }),
    (err) => {
      assert.ok(err instanceof PreflightError);
      assert.equal(err.code, 'PREFLIGHT_FAILED');
      assert.equal(err.report.errors.length, 1);
      assert.match(err.report.errors[0].message, /not set/);
      return true;
    },
  );
});

test('preflight: env var missing + failFast:false → error in report, no throw', async () => {
  delete process.env.__NEVER_SET_ME;
  const report = await preflight({ requiredEnv: ['__NEVER_SET_ME'], failFast: false });
  assert.equal(report.ok, false);
  assert.equal(report.errors.length, 1);
});

// ---- Middleware chain -------------------------------------------------

test('preflight: chain with clean ordering → ok check', async () => {
  const report = await preflight({
    chain: [
      { kind: 'deadline' },
      { kind: 'promptInjectionGuard' },
      { kind: 'guardrails' },
      { kind: 'costBudget' },
      { kind: 'circuitBreaker' },
      { kind: 'bulkhead' },
      { kind: 'retryOnRateLimit' },
      { kind: 'usageMeteringToCap' },
      { kind: 'responseCache' },
    ],
    failFast: false,
  });
  const chainCheck = report.checks.find((c) => c.name === 'chain:validate');
  assert.equal(chainCheck.status, 'ok');
});

test('preflight: chain with warnings → warning-level check', async () => {
  const report = await preflight({
    chain: [
      { kind: 'retryOnRateLimit' },
      { kind: 'costBudget' },   // BUDGET_INNER_OF_RETRY warning
    ],
    failFast: false,
  });
  const chainCheck = report.checks.find((c) => c.name === 'chain:validate');
  assert.equal(chainCheck.status, 'warning');
  assert.equal(report.ok, true);   // warnings don't fail preflight
});

// ---- Budget limits ----------------------------------------------------

test('preflight: budgetLimits with total → ok', async () => {
  const report = await preflight({ budgetLimits: { total: 500 }, failFast: false });
  const check = report.checks.find((c) => c.name === 'budget:limits');
  assert.equal(check.status, 'ok');
});

test('preflight: budgetLimits with perTenant → ok', async () => {
  const report = await preflight({ budgetLimits: { perTenant: { free: 10 } }, failFast: false });
  const check = report.checks.find((c) => c.name === 'budget:limits');
  assert.equal(check.status, 'ok');
});

test('preflight: empty budgetLimits → warning', async () => {
  const report = await preflight({ budgetLimits: {}, failFast: false });
  const check = report.checks.find((c) => c.name === 'budget:limits');
  assert.equal(check.status, 'warning');
  assert.match(check.message, /no total\/perTenant\/perModel entries/);
});

// ---- Models -----------------------------------------------------------

test('preflight: model in pricing table → ok', async () => {
  const report = await preflight({ models: ['gpt-4o-mini'], failFast: false });
  const check = report.checks.find((c) => c.name === 'model:gpt-4o-mini');
  assert.equal(check.status, 'ok');
});

test('preflight: model NOT in pricing table → warning', async () => {
  const report = await preflight({ models: ['made-up-model-v99'], failFast: false });
  const check = report.checks.find((c) => c.name === 'model:made-up-model-v99');
  assert.equal(check.status, 'warning');
  assert.match(check.message, /not in pricing table/);
});

// ---- Provider probes --------------------------------------------------

test('preflight: successful probe → ok', async () => {
  const report = await preflight({
    providers: [{ name: 'openai', probe: async () => ({ text: 'ping' }) }],
    failFast: false,
  });
  const check = report.checks.find((c) => c.name === 'provider:openai');
  assert.equal(check.status, 'ok');
});

test('preflight: failing probe → error', async () => {
  await assert.rejects(
    preflight({
      providers: [{ name: 'openai', probe: async () => { throw new Error('provider down'); } }],
    }),
    (err) => {
      assert.ok(err instanceof PreflightError);
      const check = err.report.checks.find((c) => c.name === 'provider:openai');
      assert.equal(check.status, 'error');
      assert.match(check.message, /provider down/);
      return true;
    },
  );
});

test('preflight: probe timeout → error with PROBE_TIMEOUT hint', async () => {
  await assert.rejects(
    preflight({
      providers: [{ name: 'slow', probe: async () => new Promise(() => {}) /* never resolves */ }],
      timeoutMsPerCheck: 100,
    }),
    (err) => {
      assert.ok(err instanceof PreflightError);
      const check = err.report.checks.find((c) => c.name === 'provider:slow');
      assert.equal(check.status, 'error');
      assert.match(check.message, /timed out/);
      return true;
    },
  );
});

test('preflight: multi-provider probes run in parallel (fast)', async () => {
  // If probes ran sequentially, this would take 3 × 100ms = 300ms.
  // In parallel, ~100ms.
  const startedAt = Date.now();
  await preflight({
    providers: [
      { name: 'a', probe: async () => new Promise((r) => setTimeout(r, 100)) },
      { name: 'b', probe: async () => new Promise((r) => setTimeout(r, 100)) },
      { name: 'c', probe: async () => new Promise((r) => setTimeout(r, 100)) },
    ],
    failFast: false,
  });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 250, `expected ~100ms (parallel), got ${elapsed}ms`);
});

test('preflight: malformed provider entry → error', async () => {
  const report = await preflight({
    providers: [{ name: 'x' }],   // missing probe
    failFast: false,
  });
  assert.equal(report.errors.length, 1);
});

// ---- Report shape -----------------------------------------------------

test('preflight: report includes counts + timestamp + durationMs', async () => {
  const report = await preflight({
    requiredEnv: ['__NEVER_SET_ME'],
    models: ['gpt-4o-mini'],
    failFast: false,
  });
  assert.equal(typeof report.timestamp, 'string');
  assert.ok(typeof report.durationMs === 'number' && report.durationMs >= 0);
  assert.equal(report.counts.error, 1);
  assert.equal(report.counts.ok, 1);
  assert.equal(report.counts.warning, 0);
});

// ---- onCheck callback -------------------------------------------------

test('preflight: onCheck fires per check', async () => {
  const events = [];
  process.env.__PF_ONCHECK_TEST = 'x';
  await preflight({
    requiredEnv: ['__PF_ONCHECK_TEST'],
    models:      ['gpt-4o-mini'],
    onCheck:     (info) => events.push(info),
    failFast:    false,
  });
  assert.equal(events.length, 2);
  assert.equal(events[0].name, 'env:__PF_ONCHECK_TEST');
  assert.equal(events[0].status, 'ok');
  assert.equal(events[1].name, 'model:gpt-4o-mini');
  delete process.env.__PF_ONCHECK_TEST;
});

test('preflight: onCheck errors are swallowed', async () => {
  const report = await preflight({
    models:   ['gpt-4o-mini'],
    onCheck:  () => { throw new Error('handler broken'); },
    failFast: false,
  });
  assert.equal(report.ok, true);
});

// ---- PreflightError structure -----------------------------------------

test('PreflightError: carries structured report', async () => {
  process.env.__A = 'x';
  delete process.env.__B;
  try {
    await preflight({ requiredEnv: ['__A', '__B'] });
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof PreflightError);
    assert.equal(err.name, 'PreflightError');
    assert.equal(err.code, 'PREFLIGHT_FAILED');
    assert.equal(err.report.checks.length, 2);
    assert.equal(err.report.errors.length, 1);
    assert.equal(err.report.errors[0].name, 'env:__B');
    assert.match(err.message, /preflight failed: 1 error/);
  }
  delete process.env.__A;
});
