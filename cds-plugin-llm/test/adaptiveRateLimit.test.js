const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_arl__';
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

const { adaptiveRateLimit, detectProvider } = require('../lib/middleware/adaptiveRateLimit');

// ---- Fake bulkhead ------------------------------------------------------

function fakeBulkhead(initial = 10) {
  let current = initial;
  const setCalls = [];
  return {
    getMaxConcurrent: () => current,
    setMaxConcurrent: (n) => { setCalls.push(n); current = n; },
    setCalls,
  };
}

function makeCtx() { return { method: 'chat', request: {}, meta: {}, raw: {} }; }

// ---- Input validation ---------------------------------------------------

test('adaptiveRateLimit: throws without bulkhead', () => {
  assert.throws(() => adaptiveRateLimit(), /bulkhead must be a bulkhead middleware/);
});
test('adaptiveRateLimit: throws when bulkhead lacks required methods', () => {
  assert.throws(() => adaptiveRateLimit({ bulkhead: {} }), /bulkhead must be a bulkhead middleware/);
});
test('adaptiveRateLimit: throws on out-of-range headroom', () => {
  const bh = fakeBulkhead();
  assert.throws(() => adaptiveRateLimit({ bulkhead: bh, headroom: -0.1 }), /headroom must be in/);
  assert.throws(() => adaptiveRateLimit({ bulkhead: bh, headroom: 1.0 }), /headroom must be in/);
});
test('adaptiveRateLimit: throws on invalid alpha', () => {
  const bh = fakeBulkhead();
  assert.throws(() => adaptiveRateLimit({ bulkhead: bh, alpha: 0 }), /alpha must be in/);
  assert.throws(() => adaptiveRateLimit({ bulkhead: bh, alpha: 1.5 }), /alpha must be in/);
});
test('adaptiveRateLimit: throws on non-positive minConcurrent', () => {
  const bh = fakeBulkhead();
  assert.throws(() => adaptiveRateLimit({ bulkhead: bh, minConcurrent: 0 }), /minConcurrent must be/);
});
test('adaptiveRateLimit: throws on maxConcurrent < minConcurrent', () => {
  const bh = fakeBulkhead();
  assert.throws(() => adaptiveRateLimit({ bulkhead: bh, minConcurrent: 5, maxConcurrent: 3 }),
    /maxConcurrent must be an integer >= minConcurrent/);
});
test('adaptiveRateLimit: throws on non-function callback', () => {
  const bh = fakeBulkhead();
  assert.throws(() => adaptiveRateLimit({ bulkhead: bh, onAdjust: 'x' }), /callbacks must be functions/);
});

// ---- detectProvider -----------------------------------------------------

test('detectProvider: openai headers', () => {
  assert.equal(detectProvider({ headers: { 'x-ratelimit-limit-requests': '100' } }), 'openai');
});
test('detectProvider: anthropic headers', () => {
  assert.equal(detectProvider({ headers: { 'anthropic-ratelimit-tokens-remaining': '1000' } }), 'anthropic');
});
test('detectProvider: gemini headers', () => {
  assert.equal(detectProvider({ headers: { 'x-goog-request-id': 'x' } }), 'gemini');
});
test('detectProvider: null on unknown', () => {
  assert.equal(detectProvider({ headers: { 'x-custom': 'x' } }), null);
});

// ---- Pass-through on missing rate-limit data ---------------------------

test('adaptiveRateLimit: no headers → no adjustment', async () => {
  const bh = fakeBulkhead(10);
  const mw = adaptiveRateLimit({ bulkhead: bh });
  await mw(makeCtx(), async () => ({ text: 'ok' }));
  assert.equal(bh.setCalls.length, 0);
  assert.equal(mw.stats.samples, 0);
});

// ---- Sample from pre-parsed _rateLimit envelope (1.38+ providers) ------

test('adaptiveRateLimit: samples from result._rateLimit envelope', async () => {
  const bh = fakeBulkhead(10);
  const mw = adaptiveRateLimit({
    bulkhead: bh, maxConcurrent: 20,
    headroom: 0.2, alpha: 1.0,   // no smoothing so target is deterministic
  });
  // Remaining ratio: 50/100 = 0.5. Availability = 0.5 - 0.2 = 0.3. Target = 0.3 × 20 = 6.
  await mw(makeCtx(), async () => ({
    text: 'ok',
    _rateLimit: { requestsLimit: 100, requestsRemaining: 50 },
  }));
  assert.equal(mw.stats.samples, 1);
  assert.equal(mw.stats.adjustments, 1);
  assert.equal(bh.setCalls[0], 6);
});

test('adaptiveRateLimit: uses tighter of requests/tokens ratios', async () => {
  const bh = fakeBulkhead(50);
  const mw = adaptiveRateLimit({
    bulkhead: bh, maxConcurrent: 100, alpha: 1.0, headroom: 0.0,
  });
  // requests: 90/100 = 0.9; tokens: 100/1000 = 0.1. Tighter = 0.1. Target = 0.1 × 100 = 10.
  await mw(makeCtx(), async () => ({
    _rateLimit: {
      requestsLimit: 100, requestsRemaining: 90,
      tokensLimit: 1000, tokensRemaining: 100,
    },
  }));
  assert.equal(bh.setCalls[0], 10);
});

// ---- Sample from OpenAI-style headers ---------------------------------

test('adaptiveRateLimit: parses OpenAI headers to compute target', async () => {
  const bh = fakeBulkhead(10);
  const mw = adaptiveRateLimit({
    bulkhead: bh, maxConcurrent: 50, alpha: 1.0, headroom: 0.0,
  });
  await mw(makeCtx(), async () => ({
    text: 'ok',
    headers: {
      'x-ratelimit-limit-requests': '100',
      'x-ratelimit-remaining-requests': '80',
    },
  }));
  // 80/100 = 0.8 → target = 0.8 × 50 = 40.
  assert.equal(bh.setCalls[0], 40);
  assert.equal(mw.stats.byProvider.openai, 1);
});

// ---- Smoothing ---------------------------------------------------------

test('adaptiveRateLimit: EMA smoothing prevents whipsaws', async () => {
  const bh = fakeBulkhead(10);
  const mw = adaptiveRateLimit({
    bulkhead: bh, maxConcurrent: 100, alpha: 0.5, headroom: 0.0,
  });
  // Sample 1: ratio 0.2. EMA = 0.5 × 0.2 + 0.5 × 1.0 = 0.6. Target = 60.
  await mw(makeCtx(), async () => ({
    _rateLimit: { requestsLimit: 100, requestsRemaining: 20 },
  }));
  assert.equal(bh.setCalls[bh.setCalls.length - 1], 60);
  // Sample 2: still 0.2. EMA = 0.5 × 0.2 + 0.5 × 0.6 = 0.4. Target = 40.
  await mw(makeCtx(), async () => ({
    _rateLimit: { requestsLimit: 100, requestsRemaining: 20 },
  }));
  assert.equal(bh.setCalls[bh.setCalls.length - 1], 40);
});

// ---- 429 → halve ---------------------------------------------------

test('adaptiveRateLimit: halves on 429', async () => {
  const bh = fakeBulkhead(20);
  const on429Events = [];
  const mw = adaptiveRateLimit({
    bulkhead: bh, on429: (info) => on429Events.push(info),
  });
  const throwErr = Object.assign(new Error('rate limit'), { status: 429 });
  await assert.rejects(mw(makeCtx(), async () => { throw throwErr; }), /rate limit/);
  assert.equal(bh.setCalls[0], 10);   // halved
  assert.equal(mw.stats.on429Adjustments, 1);
  assert.equal(mw.stats.shrinks, 1);
  assert.equal(on429Events.length, 1);
  assert.equal(on429Events[0].before, 20);
  assert.equal(on429Events[0].after, 10);
});

test('adaptiveRateLimit: 503 also triggers halve', async () => {
  const bh = fakeBulkhead(8);
  const mw = adaptiveRateLimit({ bulkhead: bh });
  const throwErr = Object.assign(new Error('svc unavailable'), { status: 503 });
  await assert.rejects(mw(makeCtx(), async () => { throw throwErr; }), /svc unavailable/);
  assert.equal(bh.setCalls[0], 4);
});

test('adaptiveRateLimit: halve respects minConcurrent floor', async () => {
  const bh = fakeBulkhead(3);
  const mw = adaptiveRateLimit({ bulkhead: bh, minConcurrent: 2 });
  const throwErr = Object.assign(new Error('rate limit'), { status: 429 });
  await assert.rejects(mw(makeCtx(), async () => { throw throwErr; }), /rate limit/);
  assert.equal(bh.setCalls[0], 2);   // floor kicks in (3/2=1, but min=2)
});

test('adaptiveRateLimit: 429 without on429 callback still adjusts', async () => {
  const bh = fakeBulkhead(20);
  const mw = adaptiveRateLimit({ bulkhead: bh });
  const throwErr = Object.assign(new Error('x'), { status: 429 });
  await assert.rejects(mw(makeCtx(), async () => { throw throwErr; }));
  assert.equal(bh.setCalls[0], 10);
});

// ---- Non-throttle error → no halve, but still parse headers ---------

test('adaptiveRateLimit: non-throttle error passes through without halving', async () => {
  const bh = fakeBulkhead(10);
  const mw = adaptiveRateLimit({ bulkhead: bh });
  const throwErr = Object.assign(new Error('bad request'), { status: 400 });
  await assert.rejects(mw(makeCtx(), async () => { throw throwErr; }));
  // No adjustment.
  assert.equal(bh.setCalls.length, 0);
});

// ---- Idempotent adjustments ---------------------------------------

test('adaptiveRateLimit: no-op when target == current ceiling', async () => {
  const bh = fakeBulkhead(10);
  const mw = adaptiveRateLimit({
    bulkhead: bh, maxConcurrent: 20, alpha: 1.0, headroom: 0.5,
  });
  // Ratio 1.0. Availability = 0.5. Target = 0.5 × 20 = 10. Same as current.
  await mw(makeCtx(), async () => ({
    _rateLimit: { requestsLimit: 100, requestsRemaining: 100 },
  }));
  // Even though a sample was recorded, no setMaxConcurrent call was made.
  assert.equal(bh.setCalls.length, 0);
  assert.equal(mw.stats.samples, 1);
  assert.equal(mw.stats.adjustments, 0);
});

// ---- Grow when quota heals ----------------------------------------

test('adaptiveRateLimit: grows concurrency as quota heals', async () => {
  const bh = fakeBulkhead(5);
  const mw = adaptiveRateLimit({
    bulkhead: bh, maxConcurrent: 40, alpha: 1.0, headroom: 0.0,
  });
  // Ratio 0.75 → target = 0.75 × 40 = 30. Should grow from 5 to 30.
  await mw(makeCtx(), async () => ({
    _rateLimit: { requestsLimit: 100, requestsRemaining: 75 },
  }));
  assert.equal(bh.setCalls[0], 30);
  assert.equal(mw.stats.grows, 1);
});

// ---- Callback + stats ---------------------------------------------

test('adaptiveRateLimit: onAdjust fires with info', async () => {
  const bh = fakeBulkhead(10);
  const events = [];
  const mw = adaptiveRateLimit({
    bulkhead: bh, maxConcurrent: 20, alpha: 1.0, headroom: 0.0,
    onAdjust: (info) => events.push(info),
  });
  await mw(makeCtx(), async () => ({
    _rateLimit: { requestsLimit: 100, requestsRemaining: 40 },
  }));
  assert.equal(events.length, 1);
  assert.equal(events[0].from, 10);
  assert.equal(events[0].to, 8);
  assert.equal(events[0].reason, 'sample');
});

test('adaptiveRateLimit: onAdjust error swallowed', async () => {
  const bh = fakeBulkhead(10);
  const mw = adaptiveRateLimit({
    bulkhead: bh, maxConcurrent: 20, alpha: 1.0, headroom: 0.0,
    onAdjust: () => { throw new Error('broken listener'); },
  });
  const r = await mw(makeCtx(), async () => ({
    _rateLimit: { requestsLimit: 100, requestsRemaining: 40 },
  }));
  assert.ok(r._rateLimit);
});

// ---- Reset + MCP ---------------------------------------------------

test('adaptiveRateLimit: reset clears everything', async () => {
  const bh = fakeBulkhead(10);
  const mw = adaptiveRateLimit({
    bulkhead: bh, maxConcurrent: 20, alpha: 1.0,
  });
  await mw(makeCtx(), async () => ({
    _rateLimit: { requestsLimit: 100, requestsRemaining: 40 },
  }));
  assert.ok(mw.stats.samples > 0);
  mw.reset();
  assert.equal(mw.stats.samples, 0);
  assert.equal(mw.stats.adjustments, 0);
  assert.equal(mw.stats.lastRatio, null);
});

test('adaptiveRateLimit: asMcpResource', () => {
  const bh = fakeBulkhead(15);
  const mw = adaptiveRateLimit({
    bulkhead: bh, headroom: 0.15, minConcurrent: 3, maxConcurrent: 50,
  });
  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://adaptive-rate-limit');
  const p = r.handler();
  assert.equal(p.headroom, 0.15);
  assert.equal(p.minConcurrent, 3);
  assert.equal(p.maxConcurrentCap, 50);
  assert.equal(p.currentBulkheadMax, 15);
  assert.deepEqual(p.supportedProviders.sort(), ['anthropic', 'bedrock', 'gemini', 'openai']);
});

// ---- Provider manual override ------------------------------------

test('adaptiveRateLimit: manual provider override', async () => {
  const bh = fakeBulkhead(10);
  const mw = adaptiveRateLimit({
    bulkhead: bh, maxConcurrent: 40, alpha: 1.0, headroom: 0.0,
    provider: 'openai',
  });
  // Headers don't have the OpenAI signature, but manual override forces it.
  await mw(makeCtx(), async () => ({
    headers: {
      'x-ratelimit-limit-requests': '100',
      'x-ratelimit-remaining-requests': '40',
    },
  }));
  assert.equal(bh.setCalls[0], 16);   // 0.4 × 40
});
