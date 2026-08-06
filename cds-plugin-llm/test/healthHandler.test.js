const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_hh__';
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

const { healthCheck, healthHandler, DEFAULT_IS_DEGRADED } = require('../lib/healthHandler');
const { circuitBreaker } = require('../lib/middleware/circuitBreaker');
const { bulkhead } = require('../lib/middleware/bulkhead');
const { deadline } = require('../lib/middleware/deadline');
const { retryOnRateLimit } = require('../lib/middleware/retryOnRateLimit');

// Fake Express `res` — captures status + json calls
function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json   = (b) => { res.body = b;      return res; };
  return res;
}

// ---- Programmatic entry: empty ----------------------------------------

test('healthCheck: empty input → ok status with no primitives', async () => {
  const r = await healthCheck({});
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.degraded, []);
  assert.deepEqual(r.primitives, {});
  assert.deepEqual(r.custom, {});
});

// ---- Programmatic entry: healthy primitives ---------------------------

test('healthCheck: all-healthy primitives → status ok', async () => {
  const dl = deadline({ timeoutMs: 30_000 });
  const br = circuitBreaker({ threshold: 3 });
  const bh = bulkhead({ maxConcurrent: 5 });
  const retry = retryOnRateLimit({ maxAttempts: 3 });

  const r = await healthCheck({ deadline: dl, breaker: br, bh, retry });
  assert.equal(r.status, 'ok');
  assert.equal(r.degraded.length, 0);
  assert.ok('deadline' in r.primitives);
  assert.ok('breaker'  in r.primitives);
  assert.ok('bulkhead' in r.primitives);
  assert.ok('retry'    in r.primitives);
  assert.equal(r.primitives.breaker.openBuckets.length, 0);
});

test('healthCheck: accepts either `bh` or `bulkhead` as the bulkhead key', async () => {
  const bh = bulkhead({ maxConcurrent: 5 });
  const rWithBh   = await healthCheck({ bh });
  const rWithBulk = await healthCheck({ bulkhead: bh });
  assert.ok('bulkhead' in rWithBh.primitives);
  assert.ok('bulkhead' in rWithBulk.primitives);
});

// ---- Programmatic entry: degraded detection ---------------------------

test('healthCheck: open breaker → status degraded, reason names the open provider', async () => {
  const br = circuitBreaker({ threshold: 1 });
  br.forceOpen('openai');
  const r = await healthCheck({ breaker: br });
  assert.equal(r.status, 'degraded');
  assert.equal(r.degraded.length, 1);
  assert.equal(r.degraded[0].layer, 'breaker');
  assert.match(r.degraded[0].reason, /openai/);
});

test('healthCheck: bulkhead rejections → degraded', async () => {
  const bh = bulkhead({ maxConcurrent: 5 });
  bh.stats.rejected = 3;
  const r = await healthCheck({ bh });
  assert.equal(r.status, 'degraded');
  assert.equal(r.degraded[0].layer, 'bulkhead');
  assert.match(r.degraded[0].reason, /3 rejected/);
});

test('healthCheck: deadline expirations → degraded', async () => {
  const dl = deadline({ timeoutMs: 1000 });
  dl.stats.expired = 2;
  const r = await healthCheck({ deadline: dl });
  assert.equal(r.status, 'degraded');
  assert.match(r.degraded[0].reason, /2 requests exceeded time budget/);
});

test('healthCheck: retry give-ups → degraded', async () => {
  const retry = retryOnRateLimit({ maxAttempts: 3 });
  retry.stats.givenUp = 1;
  const r = await healthCheck({ retry });
  assert.equal(r.status, 'degraded');
  assert.match(r.degraded[0].reason, /1 requests gave up/);
});

test('healthCheck: budget over-limit → degraded', async () => {
  const fakeBudget = {
    snapshot: async () => ({ total: 600, currency: 'USD', window: 'day', perTenant: {}, perModel: {} }),
    limitFor: (scope, key) => (scope === 'total' ? 500 : null),
  };
  const r = await healthCheck({ budget: fakeBudget });
  assert.equal(r.status, 'degraded');
  assert.match(r.degraded[0].reason, /exceeds limit 500/);
});

// ---- Multiple degraded layers stack in the array ----------------------

test('healthCheck: multiple degraded layers → all appear in degraded[]', async () => {
  const br = circuitBreaker({ threshold: 1 });
  br.forceOpen('openai');
  const dl = deadline({ timeoutMs: 1000 });
  dl.stats.expired = 5;
  const r = await healthCheck({ breaker: br, deadline: dl });
  assert.equal(r.status, 'degraded');
  assert.equal(r.degraded.length, 2);
  const layers = r.degraded.map((d) => d.layer).sort();
  assert.deepEqual(layers, ['breaker', 'deadline']);
});

// ---- Custom probes ----------------------------------------------------

test('healthCheck: custom probes pass through into the result', async () => {
  const r = await healthCheck({
    custom: [
      { name: 'db',        check: async () => ({ ok: true }) },
      { name: 'kafka',     check: async () => ({ ok: true }) },
    ],
  });
  assert.equal(r.status, 'ok');
  assert.equal(r.custom.db.ok, true);
  assert.equal(r.custom.kafka.ok, true);
  assert.equal(r.degraded.length, 0);
});

test('healthCheck: failing custom probe → status down (not just degraded)', async () => {
  const r = await healthCheck({
    custom: [{ name: 'db', check: async () => ({ ok: false, reason: 'connection refused' }) }],
  });
  assert.equal(r.status, 'down');
  assert.equal(r.custom.db.ok, false);
  assert.equal(r.custom.db.reason, 'connection refused');
  assert.equal(r.degraded[0].layer, 'custom:db');
  assert.match(r.degraded[0].reason, /connection refused/);
});

test('healthCheck: custom probe that throws → treated as down with error captured', async () => {
  const r = await healthCheck({
    custom: [{ name: 'db', check: async () => { throw new Error('BOOM'); } }],
  });
  assert.equal(r.status, 'down');
  assert.equal(r.custom.db.ok, false);
  assert.match(r.custom.db.reason, /probe threw: BOOM/);
});

// ---- Override degraded predicates -------------------------------------

test('healthCheck: custom isDegraded overrides the built-in per-layer predicate', async () => {
  const br = circuitBreaker({ threshold: 1 });
  br.forceOpen('openai');
  // Default would fire; override to NEVER consider breaker degraded
  const r = await healthCheck({
    breaker: br,
    isDegraded: { breaker: () => false },
  });
  assert.equal(r.status, 'ok');
  assert.equal(r.degraded.length, 0);
});

// ---- Route factory: happy path ----------------------------------------

test('healthHandler: 200 on ok status', async () => {
  const handler = healthHandler({});
  const res = fakeRes();
  await handler({}, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'ok');
});

test('healthHandler: 200 on degraded (default treatDegradedAs=200)', async () => {
  const br = circuitBreaker({ threshold: 1 });
  br.forceOpen('openai');
  const handler = healthHandler({ breaker: br });
  const res = fakeRes();
  await handler({}, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'degraded');
});

test('healthHandler: 503 on degraded when treatDegradedAs=503 (strict mode)', async () => {
  const br = circuitBreaker({ threshold: 1 });
  br.forceOpen('openai');
  const handler = healthHandler({ breaker: br }, { treatDegradedAs: 503 });
  const res = fakeRes();
  await handler({}, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.status, 'degraded');
});

test('healthHandler: 503 on down (custom probe failure)', async () => {
  const handler = healthHandler({
    custom: [{ name: 'db', check: async () => ({ ok: false, reason: 'no db' }) }],
  });
  const res = fakeRes();
  await handler({}, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.status, 'down');
});

test('healthHandler: works with bare http.ServerResponse (writeHead/end shape)', async () => {
  const handler = healthHandler({});
  let capturedCode, capturedHeaders, capturedBody;
  const res = {
    writeHead: (c, h) => { capturedCode = c; capturedHeaders = h; },
    end: (b) => { capturedBody = b; },
  };
  await handler({}, res);
  assert.equal(capturedCode, 200);
  assert.equal(capturedHeaders['Content-Type'], 'application/json');
  const parsed = JSON.parse(capturedBody);
  assert.equal(parsed.status, 'ok');
});

// ---- DEFAULT_IS_DEGRADED shape ----------------------------------------

test('DEFAULT_IS_DEGRADED: exports predicates for all shipped layers', () => {
  const expected = [
    'deadline', 'breaker', 'bulkhead', 'budget', 'retry',
    'guardrails', 'injectionGuard', 'metering', 'cache',
  ];
  for (const layer of expected) {
    assert.equal(typeof DEFAULT_IS_DEGRADED[layer], 'function', `missing predicate: ${layer}`);
  }
});
