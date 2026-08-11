const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_forecast__';
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

const { costForecast, computeCost } = require('../lib/middleware/costForecast');
const { wrapStreamCompletion } = require('../lib/streamCompletion');

// ---- Input validation --------------------------------------------------

test('costForecast: throws without targetUsd', () => {
  assert.throws(() => costForecast({}), /targetUsd is required/);
});
test('costForecast: throws on non-positive targetUsd', () => {
  assert.throws(() => costForecast({ targetUsd: 0 }), /must be > 0/);
  assert.throws(() => costForecast({ targetUsd: -5 }), /must be > 0/);
});
test('costForecast: throws on windowMs < 1000', () => {
  assert.throws(() => costForecast({ windowMs: 500, targetUsd: 10 }), /windowMs must be >= 1000/);
});
test('costForecast: throws on warnAtRatio out of range', () => {
  assert.throws(() => costForecast({ targetUsd: 10, warnAtRatio: 0 }), /warnAtRatio must be in/);
  assert.throws(() => costForecast({ targetUsd: 10, warnAtRatio: 1.1 }), /warnAtRatio must be in/);
});
test('costForecast: throws on non-positive criticalAtRatio', () => {
  assert.throws(() => costForecast({ targetUsd: 10, criticalAtRatio: 0 }), /criticalAtRatio must be > 0/);
});
test('costForecast: throws on critical < warn', () => {
  assert.throws(() => costForecast({ targetUsd: 10, warnAtRatio: 0.9, criticalAtRatio: 0.5 }),
    /criticalAtRatio must be >= warnAtRatio/);
});
test('costForecast: throws on non-positive minSampleSize', () => {
  assert.throws(() => costForecast({ targetUsd: 10, minSampleSize: 0 }), /minSampleSize must be/);
});
test('costForecast: throws on non-array skipMethods', () => {
  assert.throws(() => costForecast({ targetUsd: 10, skipMethods: 'x' }), /skipMethods must be an array/);
});
test('costForecast: throws on non-function callback', () => {
  assert.throws(() => costForecast({ targetUsd: 10, onWarn: 'x' }), /callbacks must be functions/);
});

// ---- computeCost helper -------------------------------------------------

test('computeCost: known pricing yields correct USD', () => {
  const pricing = { 'claude-opus-4-7': { input: 15, output: 75 } };
  const cost = computeCost({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, 'claude-opus-4-7', pricing);
  assert.ok(Math.abs(cost.inputCost - 15) < 0.01);
  assert.ok(Math.abs(cost.outputCost - 75) < 0.01);
  assert.ok(Math.abs(cost.totalCost - 90) < 0.01);
  assert.equal(cost.priced, true);
});
test('computeCost: OpenAI shape (prompt_tokens/completion_tokens) also counted', () => {
  const pricing = { 'gpt-4o': { input: 5, output: 20 } };
  const cost = computeCost({ prompt_tokens: 1_000_000, completion_tokens: 500_000 }, 'gpt-4o', pricing);
  assert.ok(Math.abs(cost.totalCost - (5 + 10)) < 0.01);   // $5 in + $10 out
});
test('computeCost: unknown model → priced:false', () => {
  const cost = computeCost({ input_tokens: 1_000_000 }, 'no-such-model', {});
  assert.equal(cost.priced, false);
  assert.equal(cost.totalCost, 0);
});
test('computeCost: no usage → priced:false', () => {
  const cost = computeCost(null, 'gpt-4o', { 'gpt-4o': { input: 5, output: 20 } });
  assert.equal(cost.priced, false);
});

// ---- Basic accumulation -----------------------------------------------

function makeCtx({ method = 'chat', model = 'claude-opus-4-7', tenant = 'acme' } = {}) {
  const request = { model, messages: [] };
  return { method, request, raw: { tenant }, meta: {} };
}

test('costForecast: accumulates spend across calls', async () => {
  let clock = 1000;
  const mw = costForecast({
    windowMs: 60_000, targetUsd: 100, minSampleSize: 1,
    now: () => clock,
  });
  for (let i = 0; i < 3; i++) {
    await mw(makeCtx(), async () => ({
      model: 'claude-opus-4-7', usage: { input_tokens: 100_000, output_tokens: 50_000 },
    }));
    clock += 1000;
  }
  // 3 calls × ($1.5 + $3.75) = $15.75
  assert.equal(mw.stats.totalCalls, 3);
  assert.ok(Math.abs(mw.stats.totalUsd - 15.75) < 0.01);
  assert.equal(mw.stats.sampleCount, 3);
});

test('costForecast: unpriced model → skipped from spend but call counted', async () => {
  let clock = 1000;
  const mw = costForecast({
    windowMs: 60_000, targetUsd: 10, pricing: {},
    now: () => clock,
  });
  await mw(makeCtx(), async () => ({
    model: 'unknown-model', usage: { input_tokens: 1_000_000 },
  }));
  assert.equal(mw.stats.unpricedCalls, 1);
  assert.equal(mw.stats.totalUsd, 0);
  assert.equal(mw.stats.sampleCount, 0);
});

// ---- Sliding window -----------------------------------------------

test('costForecast: prunes samples older than windowMs', async () => {
  let clock = 1000;
  const mw = costForecast({
    windowMs: 5000, targetUsd: 100, minSampleSize: 1,
    now: () => clock,
  });
  // First call at t=1000.
  await mw(makeCtx(), async () => ({
    model: 'claude-opus-4-7', usage: { input_tokens: 100_000, output_tokens: 100_000 },
  }));
  clock += 10_000;   // advance past windowMs
  // Second call after window has slid past the first.
  await mw(makeCtx(), async () => ({
    model: 'claude-opus-4-7', usage: { input_tokens: 100_000, output_tokens: 100_000 },
  }));
  // Only 1 sample should be in window (the old one was pruned).
  assert.equal(mw.stats.sampleCount, 1);
  // totalUsd is cumulative across all time, sampleCount reflects current window.
  assert.ok(mw.stats.totalUsd > 0);
});

// ---- Projections -----------------------------------------------

test('costForecast: projection computes end-of-window from burn rate', async () => {
  let clock = 1000;
  const mw = costForecast({
    windowMs: 10_000, targetUsd: 100, minSampleSize: 1,
    now: () => clock,
  });
  // Spend $10 over 1 second.
  await mw(makeCtx(), async () => ({
    model: 'claude-opus-4-7', usage: { input_tokens: 666_667, output_tokens: 0 },
    // 666,667 × 15/1M = $10
  }));
  clock += 1000;   // 1 sec into window
  const proj = mw.projection();
  // Spent $10 over 1 sec (windowSpanMs) → projected = $10 × 10sec/1sec = $100
  // But actually, windowSpanMs is currentMs - oldestSampleMs = 1000ms, projectionRatio = 10.
  // So projection ≈ $10 × 10 = $100.
  assert.ok(Math.abs(proj.projectedUsd - 100) < 5);
  assert.ok(Math.abs(proj.utilizationRatio - 1.0) < 0.05);
});

test('costForecast: projection null when no samples', () => {
  const mw = costForecast({ windowMs: 60_000, targetUsd: 100 });
  assert.equal(mw.projection(), null);
});

// ---- Threshold callbacks ------------------------------------------

test('costForecast: fires onWarn at warn threshold', async () => {
  let clock = 1000;
  const warnEvents = [];
  const mw = costForecast({
    windowMs: 10_000, targetUsd: 10, minSampleSize: 1,
    warnAtRatio: 0.5, criticalAtRatio: 1.0,
    now: () => clock,
    onWarn: (info) => warnEvents.push(info),
  });
  // Spend $6 over 1 sec — projected to $60 over 10s = 6× target
  await mw(makeCtx(), async () => ({
    model: 'claude-opus-4-7', usage: { input_tokens: 400_000, output_tokens: 0 },
    // 400k × 15/1M = $6
  }));
  clock += 1000;
  // Trigger the projection recalculation by making another call.
  // (Actually the callbacks fire during recordSpend, so 1 call is enough
  //  if the sample crosses threshold immediately.)
  // Wait, minSampleSize = 1, so this DOES fire.
  assert.ok(warnEvents.length >= 1);
});

test('costForecast: fires onCritical when projection exceeds target', async () => {
  let clock = 1000;
  const criticalEvents = [];
  const mw = costForecast({
    windowMs: 10_000, targetUsd: 5, minSampleSize: 1,
    warnAtRatio: 0.5, criticalAtRatio: 1.0,
    now: () => clock,
    onCritical: (info) => criticalEvents.push(info),
  });
  // Spend $10 — projected to $100 → 20× target
  await mw(makeCtx(), async () => ({
    model: 'claude-opus-4-7', usage: { input_tokens: 666_667, output_tokens: 0 },
  }));
  assert.equal(criticalEvents.length, 1);
  assert.equal(criticalEvents[0].projection.utilizationRatio > 1, true);
  assert.equal(mw.stats.lastLevel, 'critical');
});

test('costForecast: onWarn/onCritical fire only on level transitions', async () => {
  let clock = 1000;
  const warnEvents = [];
  const mw = costForecast({
    windowMs: 60_000, targetUsd: 10, minSampleSize: 1,
    warnAtRatio: 0.5, criticalAtRatio: 5.0,
    now: () => clock,
    onWarn: (info) => warnEvents.push(info),
  });
  // Trigger warn on first sample.
  await mw(makeCtx(), async () => ({
    model: 'claude-opus-4-7', usage: { input_tokens: 400_000, output_tokens: 0 },
  }));
  clock += 100;
  // Second call at same level → should NOT fire onWarn again.
  await mw(makeCtx(), async () => ({
    model: 'claude-opus-4-7', usage: { input_tokens: 100_000, output_tokens: 0 },
  }));
  assert.equal(warnEvents.length, 1);
});

test('costForecast: minSampleSize gates callbacks', async () => {
  let clock = 1000;
  const warnEvents = [];
  const mw = costForecast({
    windowMs: 60_000, targetUsd: 1, minSampleSize: 5,
    warnAtRatio: 0.5,
    now: () => clock,
    onWarn: (info) => warnEvents.push(info),
  });
  // 4 samples — below minSampleSize, no warn.
  for (let i = 0; i < 4; i++) {
    await mw(makeCtx(), async () => ({
      model: 'claude-opus-4-7', usage: { input_tokens: 1_000_000, output_tokens: 0 },
    }));
    clock += 100;
  }
  assert.equal(warnEvents.length, 0);
  // 5th sample — now above minSampleSize, warn should fire.
  await mw(makeCtx(), async () => ({
    model: 'claude-opus-4-7', usage: { input_tokens: 1_000_000, output_tokens: 0 },
  }));
  assert.equal(warnEvents.length, 1);
});

test('costForecast: onSpend fires per priced call', async () => {
  const events = [];
  const mw = costForecast({
    windowMs: 60_000, targetUsd: 100, minSampleSize: 1,
    onSpend: (info) => events.push(info),
  });
  await mw(makeCtx(), async () => ({
    model: 'claude-opus-4-7', usage: { input_tokens: 100_000, output_tokens: 50_000 },
  }));
  assert.equal(events.length, 1);
  assert.ok(events[0].costUsd > 0);
  assert.equal(events[0].tenant, 'acme');
});

test('costForecast: onWarn error swallowed', async () => {
  let clock = 1000;
  const mw = costForecast({
    windowMs: 10_000, targetUsd: 5, minSampleSize: 1,
    warnAtRatio: 0.5,
    now: () => clock,
    onWarn: () => { throw new Error('broken listener'); },
  });
  const result = await mw(makeCtx(), async () => ({
    model: 'claude-opus-4-7', usage: { input_tokens: 400_000, output_tokens: 0 },
  }));
  assert.ok(result.usage);   // request result untouched
});

// ---- Skip methods --------------------------------------------------

test('costForecast: skipMethods bypasses forecasting', async () => {
  const mw = costForecast({
    targetUsd: 100, minSampleSize: 1,
    skipMethods: ['embed'],
  });
  await mw({ method: 'embed', request: {}, meta: {}, raw: {} }, async () => ({
    embeddings: [[1, 2, 3]], model: 'x', usage: { input_tokens: 100 },
  }));
  assert.equal(mw.stats.totalCalls, 0);
});

// ---- Streams -----------------------------------------------------

test('costForecast: stream via 1.72 completion tracker', async () => {
  let clock = 1000;
  const mw = costForecast({
    windowMs: 60_000, targetUsd: 100, minSampleSize: 1,
    now: () => clock,
  });
  const stream = wrapStreamCompletion(async function* () {
    yield { type: 'text-delta', text: 'a' };
    yield { type: 'done', text: 'a',
      model: 'claude-opus-4-7',
      usage: { input_tokens: 100_000, output_tokens: 50_000 } };
  }());
  const result = await mw({ method: 'stream', request: { model: 'claude-opus-4-7' }, meta: {}, raw: {} },
    async () => stream);
  for await (const _ of result) { /* drain */ }
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(mw.stats.totalCalls, 1);
  assert.ok(mw.stats.totalUsd > 0);
});

// ---- Reset + MCP ------------------------------------------------

test('costForecast: reset clears everything', async () => {
  const mw = costForecast({ targetUsd: 100, minSampleSize: 1 });
  await mw(makeCtx(), async () => ({
    model: 'claude-opus-4-7', usage: { input_tokens: 100_000, output_tokens: 0 },
  }));
  assert.equal(mw.stats.totalCalls, 1);
  mw.reset();
  assert.equal(mw.stats.totalCalls, 0);
  assert.equal(mw.stats.totalUsd, 0);
  assert.equal(mw.stats.sampleCount, 0);
  assert.equal(mw.projection(), null);
});

test('costForecast: asMcpResource', () => {
  const mw = costForecast({
    targetUsd: 50, windowMs: 10_000, warnAtRatio: 0.8, criticalAtRatio: 1.0,
  });
  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://cost-forecast');
  const p = r.handler();
  assert.equal(p.targetUsd, 50);
  assert.equal(p.windowMs, 10_000);
  assert.equal(p.warnAtRatio, 0.8);
  assert.equal(p.currentLevel, 'ok');
});
