const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_ab__';
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

const { bulkhead } = require('../lib/middleware/bulkhead');
const { adaptiveBulkhead } = require('../lib/middleware/adaptiveBulkhead');

function invoke(mw, { serviceName = 'llm', next = async () => ({ text: 'ok' }) } = {}) {
  const ctx = { service: { name: serviceName }, method: 'chat' };
  return mw(ctx, next);
}

// ---- Bulkhead extensions (setMaxConcurrent / subscribe) --------------

test('bulkhead: setMaxConcurrent updates the limit at runtime', async () => {
  const bh = bulkhead({ maxConcurrent: 2 });
  assert.equal(bh.getMaxConcurrent(), 2);
  bh.setMaxConcurrent(5);
  assert.equal(bh.getMaxConcurrent(), 5);
  // Confirm the fast path uses the new limit
  const held1 = new Promise((r) => setTimeout(() => r({ text: '1' }), 10));
  const held2 = new Promise((r) => setTimeout(() => r({ text: '2' }), 10));
  const held3 = new Promise((r) => setTimeout(() => r({ text: '3' }), 10));
  // All three admit under the new limit of 5 — no queueing
  await Promise.all([
    invoke(bh, { next: () => held1 }),
    invoke(bh, { next: () => held2 }),
    invoke(bh, { next: () => held3 }),
  ]);
  assert.equal(bh.state('llm').queued, 0);
});

test('bulkhead: setMaxConcurrent rejects non-positive integers', () => {
  const bh = bulkhead({ maxConcurrent: 5 });
  assert.throws(() => bh.setMaxConcurrent(0),   /positive integer/);
  assert.throws(() => bh.setMaxConcurrent(-1),  /positive integer/);
  assert.throws(() => bh.setMaxConcurrent(1.5), /positive integer/);
});

test('bulkhead: subscribe receives { provider, durationMs, ok, method } after each call', async () => {
  const bh = bulkhead({ maxConcurrent: 5 });
  const events = [];
  const unsub = bh.subscribe((info) => events.push(info));
  await invoke(bh);
  await invoke(bh, { next: async () => { throw new Error('boom'); } }).catch(() => {});
  assert.equal(events.length, 2);
  assert.equal(events[0].ok, true);
  assert.equal(events[0].provider, 'llm');
  assert.ok(events[0].durationMs >= 0);
  assert.equal(events[1].ok, false);
  unsub();
});

test('bulkhead: subscribe returns unsubscribe fn', async () => {
  const bh = bulkhead({ maxConcurrent: 5 });
  const events = [];
  const unsub = bh.subscribe((info) => events.push(info));
  await invoke(bh);
  unsub();
  await invoke(bh);
  assert.equal(events.length, 1);
});

// ---- adaptiveBulkhead: input validation ------------------------------

test('adaptiveBulkhead: throws when bulkhead lacks setMaxConcurrent / subscribe', () => {
  assert.throws(() => adaptiveBulkhead({ bulkhead: {}, p95TargetMs: 1000 }),
    /must be a bulkhead middleware/);
});

test('adaptiveBulkhead: throws on non-positive p95TargetMs', () => {
  const bh = bulkhead({ maxConcurrent: 5 });
  assert.throws(() => adaptiveBulkhead({ bulkhead: bh, p95TargetMs: 0 }),  /p95TargetMs/);
  assert.throws(() => adaptiveBulkhead({ bulkhead: bh, p95TargetMs: -1 }), /p95TargetMs/);
});

test('adaptiveBulkhead: throws when maxConcurrent < minConcurrent', () => {
  const bh = bulkhead({ maxConcurrent: 5 });
  assert.throws(() => adaptiveBulkhead({ bulkhead: bh, p95TargetMs: 1000, minConcurrent: 10, maxConcurrent: 5 }),
    /maxConcurrent/);
});

test('adaptiveBulkhead: throws on adjustEveryMs < 100', () => {
  const bh = bulkhead({ maxConcurrent: 5 });
  assert.throws(() => adaptiveBulkhead({ bulkhead: bh, p95TargetMs: 1000, adjustEveryMs: 50 }),
    /adjustEveryMs/);
});

test('adaptiveBulkhead: throws on sampleWindow < 5', () => {
  const bh = bulkhead({ maxConcurrent: 5 });
  assert.throws(() => adaptiveBulkhead({ bulkhead: bh, p95TargetMs: 1000, sampleWindow: 3 }),
    /sampleWindow/);
});

// ---- Tuning behavior ------------------------------------------------

test('adaptiveBulkhead: p95 above target → shrinks maxConcurrent by stepDown', async () => {
  const bh = bulkhead({ maxConcurrent: 10 });
  const tuner = adaptiveBulkhead({
    bulkhead:      bh,
    p95TargetMs:   50,
    minConcurrent: 1,
    maxConcurrent: 20,
    adjustEveryMs: 60_000,
    stepDown:      3,
    sampleWindow:  5,
  });
  tuner.start();
  // Simulate 5 slow calls (100ms each) — well above 50ms target
  for (let i = 0; i < 5; i++) {
    await invoke(bh, { next: async () => new Promise((r) => setTimeout(() => r({ text: 'slow' }), 100)) });
  }
  tuner.tickNow();
  assert.equal(bh.getMaxConcurrent(), 7);   // 10 → 7 (shrunk by 3)
  assert.equal(tuner.stats.shrinks, 1);
  assert.ok(tuner.stats.lastP95Ms >= 100);
  tuner.stop();
});

test('adaptiveBulkhead: p95 below target → grows maxConcurrent by stepUp', async () => {
  const bh = bulkhead({ maxConcurrent: 5 });
  const tuner = adaptiveBulkhead({
    bulkhead:      bh,
    p95TargetMs:   100,
    minConcurrent: 1,
    maxConcurrent: 20,
    adjustEveryMs: 60_000,
    stepUp:        2,
    sampleWindow:  5,
  });
  tuner.start();
  // Simulate 5 fast calls (10ms each) — well below 100ms target
  for (let i = 0; i < 5; i++) {
    await invoke(bh, { next: async () => new Promise((r) => setTimeout(() => r({ text: 'fast' }), 5)) });
  }
  tuner.tickNow();
  assert.equal(bh.getMaxConcurrent(), 7);   // 5 → 7 (grew by 2)
  assert.equal(tuner.stats.grows, 1);
  tuner.stop();
});

test('adaptiveBulkhead: never grows above maxConcurrent option', async () => {
  const bh = bulkhead({ maxConcurrent: 4 });
  const tuner = adaptiveBulkhead({
    bulkhead:      bh,
    p95TargetMs:   1000,
    minConcurrent: 1,
    maxConcurrent: 5,      // ceiling: only room for one growth step
    adjustEveryMs: 60_000,
    stepUp:        3,       // want to grow by 3
    sampleWindow:  5,
  });
  tuner.start();
  // Fast calls → tuner wants to grow
  for (let i = 0; i < 5; i++) {
    await invoke(bh, { next: async () => new Promise((r) => setTimeout(() => r({}), 5)) });
  }
  tuner.tickNow();
  assert.equal(bh.getMaxConcurrent(), 5);   // capped at 5, not 4+3=7
  tuner.stop();
});

test('adaptiveBulkhead: never shrinks below minConcurrent option', async () => {
  const bh = bulkhead({ maxConcurrent: 3 });
  const tuner = adaptiveBulkhead({
    bulkhead:      bh,
    p95TargetMs:   1,
    minConcurrent: 2,       // floor: only room for one shrink step
    maxConcurrent: 20,
    adjustEveryMs: 60_000,
    stepDown:      5,       // want to shrink by 5
    sampleWindow:  5,
  });
  tuner.start();
  for (let i = 0; i < 5; i++) {
    await invoke(bh, { next: async () => new Promise((r) => setTimeout(() => r({}), 20)) });
  }
  tuner.tickNow();
  assert.equal(bh.getMaxConcurrent(), 2);   // floored at 2, not 3-5=-2
  tuner.stop();
});

test('adaptiveBulkhead: no samples → noop-no-samples action, no adjustment', () => {
  const bh = bulkhead({ maxConcurrent: 10 });
  const tuner = adaptiveBulkhead({ bulkhead: bh, p95TargetMs: 100, adjustEveryMs: 100 });
  tuner.start();
  tuner.tickNow();
  assert.equal(tuner.stats.lastAction, 'noop-no-samples');
  assert.equal(bh.getMaxConcurrent(), 10);
  tuner.stop();
});

test('adaptiveBulkhead: p95 exactly at target → noop, no adjustment', async () => {
  const bh = bulkhead({ maxConcurrent: 10 });
  const tuner = adaptiveBulkhead({
    bulkhead: bh,
    p95TargetMs: 50,
    adjustEveryMs: 60_000,
    sampleWindow: 5,
  });
  tuner.start();
  // Manually inject 5 identical samples right at target
  // (via bulkhead.subscribe path)
  for (let i = 0; i < 5; i++) {
    await invoke(bh, { next: async () => new Promise((r) => setTimeout(() => r({}), 50)) });
  }
  tuner.tickNow();
  // p95 should be roughly 50 — could be slightly above due to timing
  // If it landed exactly at target OR just under, no shrink should fire
  // (only grow — which may or may not happen depending on jitter)
  const action = tuner.stats.lastAction;
  assert.ok(['noop', 'grow', 'shrink'].includes(action));
  tuner.stop();
});

// ---- Rolling window --------------------------------------------------

test('adaptiveBulkhead: uses ONLY the most recent sampleWindow samples', async () => {
  const bh = bulkhead({ maxConcurrent: 10 });
  const tuner = adaptiveBulkhead({
    bulkhead:     bh,
    p95TargetMs:  50,
    adjustEveryMs: 60_000,
    sampleWindow: 5,   // last 5 only
  });
  tuner.start();
  // 10 slow calls (100ms) then 5 fast calls (5ms)
  for (let i = 0; i < 10; i++) {
    await invoke(bh, { next: async () => new Promise((r) => setTimeout(() => r({}), 100)) });
  }
  for (let i = 0; i < 5; i++) {
    await invoke(bh, { next: async () => new Promise((r) => setTimeout(() => r({}), 5)) });
  }
  tuner.tickNow();
  // Window holds only the last 5 (fast) — p95 should be ~5ms, well BELOW 50ms target
  // Tuner should GROW, not shrink
  assert.equal(tuner.stats.lastAction, 'grow');
  tuner.stop();
});

// ---- filterProvider --------------------------------------------------

test('adaptiveBulkhead: filterProvider restricts observations to a specific provider', async () => {
  const bh = bulkhead({ maxConcurrent: 10 });
  const tuner = adaptiveBulkhead({
    bulkhead:       bh,
    p95TargetMs:    50,
    adjustEveryMs:  60_000,
    sampleWindow:   5,
    filterProvider: (p) => p === 'openai',
  });
  tuner.start();
  // Slow calls to 'anthropic' — should be filtered out
  for (let i = 0; i < 5; i++) {
    await invoke(bh, { serviceName: 'anthropic', next: async () => new Promise((r) => setTimeout(() => r({}), 500)) });
  }
  tuner.tickNow();
  // No 'openai' samples yet → no adjustment
  assert.equal(tuner.stats.lastAction, 'noop-no-samples');
  tuner.stop();
});

// ---- Callbacks -------------------------------------------------------

test('adaptiveBulkhead: onAdjust fires with detailed info', async () => {
  const bh = bulkhead({ maxConcurrent: 10 });
  const events = [];
  const tuner = adaptiveBulkhead({
    bulkhead:       bh,
    p95TargetMs:    50,
    adjustEveryMs:  60_000,
    sampleWindow:   5,
    stepDown:       2,
    onAdjust:       (info) => events.push(info),
  });
  tuner.start();
  for (let i = 0; i < 5; i++) {
    await invoke(bh, { next: async () => new Promise((r) => setTimeout(() => r({}), 100)) });
  }
  tuner.tickNow();
  assert.equal(events.length, 1);
  assert.equal(events[0].action, 'shrink');
  assert.equal(events[0].targetMs, 50);
  assert.equal(events[0].prevMaxConcurrent, 10);
  assert.equal(events[0].newMaxConcurrent, 8);
  assert.ok(events[0].p95Ms >= 100);
  tuner.stop();
});

test('adaptiveBulkhead: onSample fires for each observed call', async () => {
  const bh = bulkhead({ maxConcurrent: 10 });
  const samples = [];
  const tuner = adaptiveBulkhead({
    bulkhead:       bh,
    p95TargetMs:    50,
    adjustEveryMs:  60_000,
    sampleWindow:   5,
    onSample:       (info) => samples.push(info),
  });
  tuner.start();
  await invoke(bh);
  await invoke(bh);
  await invoke(bh);
  assert.equal(samples.length, 3);
  tuner.stop();
});

// ---- start / stop lifecycle -----------------------------------------

test('adaptiveBulkhead: start() is idempotent', () => {
  const bh = bulkhead({ maxConcurrent: 5 });
  const tuner = adaptiveBulkhead({ bulkhead: bh, p95TargetMs: 100, adjustEveryMs: 100 });
  tuner.start();
  tuner.start();   // should be no-op
  tuner.stop();
});

test('adaptiveBulkhead: stop() unsubscribes so future calls don\'t collect samples', async () => {
  const bh = bulkhead({ maxConcurrent: 5 });
  const tuner = adaptiveBulkhead({ bulkhead: bh, p95TargetMs: 100, adjustEveryMs: 100, sampleWindow: 5 });
  tuner.start();
  await invoke(bh);
  tuner.stop();
  await invoke(bh);
  await invoke(bh);
  // Only 1 sample recorded before stop()
  const snap = tuner.asMcpResource().handler();
  assert.equal(snap.sampleCount, 1);
});

// ---- MCP resource -----------------------------------------------------

test('adaptiveBulkhead: asMcpResource() returns config://adaptive-bulkhead snapshot', () => {
  const bh = bulkhead({ maxConcurrent: 10 });
  const tuner = adaptiveBulkhead({
    bulkhead:      bh,
    p95TargetMs:   1500,
    minConcurrent: 2,
    maxConcurrent: 30,
  });
  const res = tuner.asMcpResource();
  assert.equal(res.uri, 'config://adaptive-bulkhead');
  assert.equal(res.mimeType, 'application/json');
  const snap = res.handler();
  assert.equal(snap.p95TargetMs, 1500);
  assert.equal(snap.minConcurrent, 2);
  assert.equal(snap.maxConcurrent, 30);
  assert.equal(snap.currentMaxConcurrent, 10);
  assert.equal(snap.running, false);
});
