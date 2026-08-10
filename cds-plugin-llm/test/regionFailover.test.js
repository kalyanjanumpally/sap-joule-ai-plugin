const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_region__';
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
  regionFailover,
  AllRegionsFailedError,
  defaultIsFallback,
} = require('../lib/regionFailover');
const { LLMError } = require('../lib/errors');

function fakeSvc(behavior) {
  const calls = [];
  let n = 0;
  return {
    async chat(req) {
      calls.push(req);
      const spec = typeof behavior === 'function' ? behavior(n++, req) : behavior;
      if (spec && spec.throw) throw spec.throw;
      return spec ?? { text: 'ok' };
    },
    calls,
  };
}

// ---- Input validation --------------------------------------------------

test('regionFailover: throws on empty regions', () => {
  assert.throws(() => regionFailover({ regions: [] }), /regions must be a non-empty array/);
});
test('regionFailover: throws on region missing name', () => {
  assert.throws(() => regionFailover({
    regions: [{ service: fakeSvc() }],
  }), /regions\[0\]\.name must be/);
});
test('regionFailover: throws on region missing service', () => {
  assert.throws(() => regionFailover({
    regions: [{ name: 'r1' }],
  }), /regions\[0\]\.service must expose/);
});
test('regionFailover: throws on non-array allowedRegions', () => {
  assert.throws(() => regionFailover({
    regions: [{ name: 'r1', service: fakeSvc() }],
    allowedRegions: 'r1',
  }), /allowedRegions must be an array/);
});
test('regionFailover: throws on invalid perRegionTimeoutMs', () => {
  assert.throws(() => regionFailover({
    regions: [{ name: 'r1', service: fakeSvc() }],
    perRegionTimeoutMs: 0,
  }), /perRegionTimeoutMs must be > 0/);
});
test('regionFailover: throws on negative unhealthyCooldownMs', () => {
  assert.throws(() => regionFailover({
    regions: [{ name: 'r1', service: fakeSvc() }],
    unhealthyCooldownMs: -1,
  }), /unhealthyCooldownMs must be >= 0/);
});
test('regionFailover: throws on non-function callback', () => {
  assert.throws(() => regionFailover({
    regions: [{ name: 'r1', service: fakeSvc() }],
    onFailover: 'x',
  }), /callbacks must be functions/);
});

// ---- defaultIsFallback ------------------------------------------------

test('defaultIsFallback: retries on CircuitOpenError', () => {
  assert.equal(defaultIsFallback({ code: 'CIRCUIT_OPEN' }), true);
  assert.equal(defaultIsFallback({ name: 'CircuitOpenError' }), true);
});
test('defaultIsFallback: retries on rate-limit give-up', () => {
  assert.equal(defaultIsFallback({ code: 'RATE_LIMIT_GIVE_UP' }), true);
});
test('defaultIsFallback: retries on deadline / bulkhead / timeout errors', () => {
  assert.equal(defaultIsFallback({ code: 'DEADLINE_EXCEEDED' }), true);
  assert.equal(defaultIsFallback({ code: 'BULKHEAD_FULL' }), true);
  assert.equal(defaultIsFallback({ code: 'BULKHEAD_TIMEOUT' }), true);
});
test('defaultIsFallback: retries on 5xx status', () => {
  assert.equal(defaultIsFallback({ status: 503 }), true);
  assert.equal(defaultIsFallback({ status: 502 }), true);
});
test('defaultIsFallback: does NOT retry on 4xx', () => {
  assert.equal(defaultIsFallback({ status: 400 }), false);
  assert.equal(defaultIsFallback({ status: 429 }), false);
});
test('defaultIsFallback: retries on missing status (network)', () => {
  assert.equal(defaultIsFallback({ message: 'ECONNREFUSED' }), true);
});

// ---- Happy path ------------------------------------------------------

test('regionFailover: first healthy region succeeds', async () => {
  const r1 = fakeSvc({ text: 'from r1', model: 'x' });
  const r2 = fakeSvc({ text: 'from r2', model: 'x' });
  const routed = regionFailover({
    regions: [
      { name: 'r1', service: r1 },
      { name: 'r2', service: r2 },
    ],
  });
  const result = await routed.chat({ messages: [] });
  assert.equal(result.text, 'from r1');
  assert.equal(result.region, 'r1');
  assert.equal(r1.calls.length, 1);
  assert.equal(r2.calls.length, 0);
  assert.equal(routed.stats.successful, 1);
  assert.equal(routed.stats.byRegionSuccess.r1, 1);
});

test('regionFailover: fails over on 5xx to next region', async () => {
  const r1 = fakeSvc({ throw: Object.assign(new Error('server error'), { status: 503 }) });
  const r2 = fakeSvc({ text: 'from r2', model: 'x' });
  const routed = regionFailover({
    regions: [
      { name: 'r1', service: r1 },
      { name: 'r2', service: r2 },
    ],
  });
  const result = await routed.chat({ messages: [] });
  assert.equal(result.text, 'from r2');
  assert.equal(result.region, 'r2');
  assert.equal(routed.stats.failoversPerformed, 1);
  assert.equal(routed.stats.byRegionFailure.r1, 1);
  assert.equal(routed.stats.byRegionSuccess.r2, 1);
  assert.equal(result.attempts.length, 2);
});

test('regionFailover: does NOT fail over on 4xx (non-retryable)', async () => {
  const r1 = fakeSvc({ throw: Object.assign(new Error('bad request'), { status: 400 }) });
  const r2 = fakeSvc({ text: 'from r2' });
  const routed = regionFailover({
    regions: [
      { name: 'r1', service: r1 },
      { name: 'r2', service: r2 },
    ],
  });
  await assert.rejects(routed.chat({}), (err) => {
    assert.ok(err instanceof AllRegionsFailedError);
    assert.equal(err.code, 'ALL_REGIONS_FAILED');
    assert.equal(err.httpStatus, 502);
    return true;
  });
  assert.equal(r2.calls.length, 0);
});

test('regionFailover: all regions fail → AllRegionsFailedError', async () => {
  const r1 = fakeSvc({ throw: Object.assign(new Error('r1 down'), { status: 503 }) });
  const r2 = fakeSvc({ throw: Object.assign(new Error('r2 down'), { status: 503 }) });
  const routed = regionFailover({
    regions: [
      { name: 'r1', service: r1 },
      { name: 'r2', service: r2 },
    ],
  });
  await assert.rejects(routed.chat({}), (err) => {
    assert.ok(err instanceof AllRegionsFailedError);
    assert.ok(err instanceof LLMError);
    assert.equal(err.attempts.length, 2);
    assert.equal(err.cause.message, 'r2 down');
    return true;
  });
  assert.equal(routed.stats.failed, 1);
});

// ---- Data residency ---------------------------------------------------

test('regionFailover: allowedRegions filters candidates', async () => {
  const r1 = fakeSvc({ text: 'r1', model: 'x' });
  const r2 = fakeSvc({ text: 'r2', model: 'x' });
  const usSvc = fakeSvc({ text: 'us', model: 'x' });
  const routed = regionFailover({
    regions: [
      { name: 'us-east-1', service: usSvc },
      { name: 'eu-central-1', service: r1 },
      { name: 'eu-west-1',    service: r2 },
    ],
    allowedRegions: ['eu-central-1', 'eu-west-1'],
  });
  const result = await routed.chat({});
  assert.equal(result.region, 'eu-central-1');   // first allowed
  assert.equal(usSvc.calls.length, 0);
});

test('regionFailover: no eligible regions → AllRegionsFailedError', async () => {
  const usSvc = fakeSvc({ text: 'us' });
  const routed = regionFailover({
    regions: [{ name: 'us-east-1', service: usSvc }],
    allowedRegions: ['eu-central-1'],
  });
  await assert.rejects(routed.chat({}), (err) => {
    assert.ok(err instanceof AllRegionsFailedError);
    assert.match(err.message, /no eligible regions/);
    return true;
  });
  assert.equal(routed.stats.filteredResidency, 1);
});

// ---- Health tracking -------------------------------------------------

test('regionFailover: marks region unhealthy after failure', async () => {
  let clock = 1000;
  const r1 = fakeSvc({ throw: Object.assign(new Error('down'), { status: 503 }) });
  const r2 = fakeSvc({ text: 'r2', model: 'x' });
  const routed = regionFailover({
    regions: [
      { name: 'r1', service: r1 },
      { name: 'r2', service: r2 },
    ],
    unhealthyCooldownMs: 5_000,
    now: () => clock,
  });
  await routed.chat({});
  // r1 should be marked unhealthy.
  const snap = routed.unhealthySnapshot();
  assert.equal(snap.r1?.msRemaining > 0, true);

  // Second call should skip r1.
  await routed.chat({});
  assert.equal(r1.calls.length, 1);   // r1 NOT called again
  assert.equal(r2.calls.length, 2);
});

test('regionFailover: unhealthy cooldown expires → region re-eligible', async () => {
  let clock = 1000;
  const r1 = fakeSvc((n) => n === 0
    ? { throw: Object.assign(new Error('down'), { status: 503 }) }
    : { text: 'r1-recovered', model: 'x' });
  const r2 = fakeSvc({ text: 'r2', model: 'x' });
  const routed = regionFailover({
    regions: [
      { name: 'r1', service: r1 },
      { name: 'r2', service: r2 },
    ],
    unhealthyCooldownMs: 5_000,
    now: () => clock,
  });
  await routed.chat({});   // r1 fails, marked unhealthy
  clock += 10_000;         // past cooldown
  const result = await routed.chat({});
  assert.equal(result.region, 'r1');
  assert.equal(result.text, 'r1-recovered');
});

test('regionFailover: unhealthyCooldownMs:0 disables tracking', async () => {
  const r1 = fakeSvc((n) => n === 0
    ? { throw: Object.assign(new Error('down'), { status: 503 }) }
    : { text: 'r1-back', model: 'x' });
  const r2 = fakeSvc({ text: 'r2', model: 'x' });
  const routed = regionFailover({
    regions: [
      { name: 'r1', service: r1 },
      { name: 'r2', service: r2 },
    ],
    unhealthyCooldownMs: 0,
  });
  await routed.chat({});   // r1 fails
  const result = await routed.chat({});   // r1 immediately retried
  assert.equal(result.region, 'r1');
});

test('regionFailover: markRegionUnhealthy manually skips', async () => {
  const r1 = fakeSvc({ text: 'r1', model: 'x' });
  const r2 = fakeSvc({ text: 'r2', model: 'x' });
  const routed = regionFailover({
    regions: [
      { name: 'r1', service: r1 },
      { name: 'r2', service: r2 },
    ],
    unhealthyCooldownMs: 60_000,
  });
  routed.markRegionUnhealthy('r1');
  const result = await routed.chat({});
  assert.equal(result.region, 'r2');
  assert.equal(r1.calls.length, 0);
});

test('regionFailover: clearRegionHealth un-marks manually', async () => {
  const r1 = fakeSvc({ text: 'r1', model: 'x' });
  const routed = regionFailover({
    regions: [{ name: 'r1', service: r1 }],
    unhealthyCooldownMs: 60_000,
  });
  routed.markRegionUnhealthy('r1');
  routed.clearRegionHealth('r1');
  const result = await routed.chat({});
  assert.equal(result.region, 'r1');
});

// ---- Timeout ---------------------------------------------------------

test('regionFailover: perRegionTimeoutMs enforces cap', async () => {
  const r1 = {
    async chat() { return new Promise(() => {}); },   // never resolves
    calls: [],
  };
  const r2 = fakeSvc({ text: 'r2', model: 'x' });
  const routed = regionFailover({
    regions: [
      { name: 'r1', service: r1 },
      { name: 'r2', service: r2 },
    ],
    perRegionTimeoutMs: 50,
  });
  const result = await routed.chat({});
  // r1 timed out → fell over to r2
  assert.equal(result.region, 'r2');
});

// ---- Callbacks ------------------------------------------------------

test('regionFailover: onFailover fires with info', async () => {
  const events = [];
  const r1 = fakeSvc({ throw: Object.assign(new Error('down'), { status: 503 }) });
  const r2 = fakeSvc({ text: 'r2' });
  const routed = regionFailover({
    regions: [
      { name: 'r1', service: r1 },
      { name: 'r2', service: r2 },
    ],
    onFailover: (info) => events.push(info),
  });
  await routed.chat({});
  assert.equal(events.length, 1);
  assert.equal(events[0].from, 'r1');
  assert.equal(events[0].to, 'r2');
  assert.equal(events[0].error.message, 'down');
});

test('regionFailover: onSelected fires per attempt', async () => {
  const events = [];
  const r1 = fakeSvc({ throw: Object.assign(new Error('down'), { status: 503 }) });
  const r2 = fakeSvc({ text: 'r2' });
  const routed = regionFailover({
    regions: [
      { name: 'r1', service: r1 },
      { name: 'r2', service: r2 },
    ],
    onSelected: (info) => events.push(info),
  });
  await routed.chat({});
  assert.equal(events.length, 2);
  assert.equal(events[0].region, 'r1');
  assert.equal(events[1].region, 'r2');
  assert.equal(events[1].attempt, 2);
});

test('regionFailover: onFailover error swallowed', async () => {
  const r1 = fakeSvc({ throw: Object.assign(new Error('down'), { status: 503 }) });
  const r2 = fakeSvc({ text: 'r2' });
  const routed = regionFailover({
    regions: [
      { name: 'r1', service: r1 },
      { name: 'r2', service: r2 },
    ],
    onFailover: () => { throw new Error('broken listener'); },
  });
  const result = await routed.chat({});
  assert.equal(result.region, 'r2');
});

// ---- Reset + MCP -------------------------------------------------

test('regionFailover: reset clears counters + health', async () => {
  const r1 = fakeSvc({ text: 'r1' });
  const routed = regionFailover({
    regions: [{ name: 'r1', service: r1 }],
    unhealthyCooldownMs: 60_000,
  });
  await routed.chat({});
  routed.markRegionUnhealthy('r1');
  assert.equal(routed.stats.successful, 1);
  assert.equal(Object.keys(routed.unhealthySnapshot()).length, 1);
  routed.reset();
  assert.equal(routed.stats.successful, 0);
  assert.equal(Object.keys(routed.unhealthySnapshot()).length, 0);
});

test('regionFailover: asMcpResource', () => {
  const r1 = fakeSvc({ text: 'r1' });
  const routed = regionFailover({
    regions: [{ name: 'r1', service: r1 }, { name: 'r2', service: r1 }],
    allowedRegions: ['r1'],
    perRegionTimeoutMs: 5000,
  });
  const r = routed.asMcpResource();
  assert.equal(r.uri, 'config://region-failover');
  const p = r.handler();
  assert.equal(p.regionCount, 2);
  assert.deepEqual(p.allowedRegions, ['r1']);
  assert.equal(p.perRegionTimeoutMs, 5000);
});

// ---- Error class shape --------------------------------------------

test('AllRegionsFailedError shape', () => {
  const err = new AllRegionsFailedError(new Error('last'), [{ region: 'r1' }], 0);
  assert.ok(err instanceof LLMError);
  assert.equal(err.code, 'ALL_REGIONS_FAILED');
  assert.equal(err.primitive, 'regionFailover');
  assert.equal(err.httpStatus, 502);
  assert.equal(err.retriable, false);
  assert.equal(err.attempts.length, 1);
});

// ---- Custom isFallback --------------------------------------------

test('regionFailover: custom isFallback overrides default', async () => {
  const r1 = fakeSvc({ throw: Object.assign(new Error('bad'), { status: 400 }) });
  const r2 = fakeSvc({ text: 'r2' });
  const routed = regionFailover({
    regions: [
      { name: 'r1', service: r1 },
      { name: 'r2', service: r2 },
    ],
    isFallback: () => true,   // always fail over
  });
  const result = await routed.chat({});
  assert.equal(result.region, 'r2');
});
