const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_rap__';
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
  retryAfterPropagation,
  detectProvider,
  computeRetryHints,
  DEFAULT_PARSERS,
} = require('../lib/middleware/retryAfterPropagation');

function ctxOf() {
  return { method: 'chat', request: { model: 'm', messages: [] }, meta: {} };
}

// ---- Input validation --------------------------------------------------

test('retryAfterPropagation: throws on non-function onCapture', () => {
  assert.throws(() => retryAfterPropagation({ onCapture: 'x' }), /onCapture must be/);
});
test('retryAfterPropagation: throws on non-object parsers', () => {
  assert.throws(() => retryAfterPropagation({ parsers: 'x' }), /parsers must be an object/);
});
test('retryAfterPropagation: throws on negative fallbackRetryMs', () => {
  assert.throws(() => retryAfterPropagation({ fallbackRetryMs: -1 }), /fallbackRetryMs must be/);
});

// ---- Pass-through paths ------------------------------------------------

test('retryAfterPropagation: passes through non-errors', async () => {
  const mw = retryAfterPropagation();
  const r = await mw(ctxOf(), async () => ({ text: 'ok' }));
  assert.equal(r.text, 'ok');
  assert.equal(mw.stats.totalErrors, 0);
});

test('retryAfterPropagation: re-throws errors', async () => {
  const mw = retryAfterPropagation();
  await assert.rejects(
    mw(ctxOf(), async () => { throw new Error('boom'); }),
    /boom/,
  );
  assert.equal(mw.stats.totalErrors, 1);
});

test('retryAfterPropagation: skips enrichment when already set', async () => {
  const mw = retryAfterPropagation();
  const err = Object.assign(new Error('rate limit'), {
    retryAfterMs: 5000,
    resetAtMs: Date.now() + 5000,
    headers: { 'anthropic-ratelimit-tokens-remaining': '0' },
    status: 429,
  });
  await assert.rejects(mw(ctxOf(), async () => { throw err; }));
  assert.equal(err.retryAfterMs, 5000);       // unchanged
  assert.equal(mw.stats.hintsCaptured, 0);
});

// ---- Provider detection ----------------------------------------------

test('detectProvider: anthropic via anthropic-ratelimit-* header', () => {
  const err = { headers: { 'anthropic-ratelimit-tokens-remaining': '1000' } };
  assert.equal(detectProvider(err), 'anthropic');
});
test('detectProvider: openai via x-ratelimit-* header', () => {
  const err = { headers: { 'x-ratelimit-limit-requests': '100' } };
  assert.equal(detectProvider(err), 'openai');
});
test('detectProvider: gemini via x-goog-request-id', () => {
  const err = { headers: { 'x-goog-request-id': 'abc' } };
  assert.equal(detectProvider(err), 'gemini');
});
test('detectProvider: null on unknown headers', () => {
  const err = { headers: { 'x-custom': 'val' } };
  assert.equal(detectProvider(err), null);
});
test('detectProvider: null on missing headers', () => {
  assert.equal(detectProvider({}), null);
  assert.equal(detectProvider(null), null);
});
test('detectProvider: reads err.response.headers as fallback', () => {
  const err = { response: { headers: { 'x-ratelimit-limit-requests': '100' } } };
  assert.equal(detectProvider(err), 'openai');
});
test('detectProvider: Headers-like get() method', () => {
  const headers = new Map([['anthropic-ratelimit-tokens-remaining', '500']]);
  headers.get = function(k) { return this.has(k) ? Map.prototype.get.call(this, k) : undefined; };
  assert.equal(detectProvider({ headers }), 'anthropic');
});

// ---- computeRetryHints ------------------------------------------------

test('computeRetryHints: retryAfterSeconds → retryAfterMs', () => {
  const hints = computeRetryHints({ retryAfterSeconds: 30 }, {});
  assert.equal(hints.retryAfterMs, 30_000);
  assert.ok(hints.resetAtMs > Date.now() + 29_000);
});
test('computeRetryHints: falls back to err.retryAfterSec', () => {
  const hints = computeRetryHints({}, { retryAfterSec: 5 });
  assert.equal(hints.retryAfterMs, 5_000);
});
test('computeRetryHints: reset ISO → resetAtMs', () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const hints = computeRetryHints({ requestsResetAt: future }, {});
  assert.ok(Math.abs(hints.resetAtMs - Date.parse(future)) < 100);
});
test('computeRetryHints: null parsed → null', () => {
  assert.equal(computeRetryHints(null, {}), null);
});

// ---- OpenAI enrichment ------------------------------------------------

test('retryAfterPropagation: OpenAI-shaped 429 error enriched', async () => {
  const mw = retryAfterPropagation();
  const err = Object.assign(new Error('too many'), {
    status: 429,
    headers: {
      'x-ratelimit-limit-requests': '100',
      'x-ratelimit-remaining-requests': '0',
      'x-ratelimit-reset-requests': '30s',
      'retry-after': '30',
    },
  });
  await assert.rejects(mw(ctxOf(), async () => { throw err; }));
  assert.equal(err.retryAfterMs, 30_000);
  assert.ok(err.resetAtMs > Date.now() + 29_000);
  assert.ok(err.rateLimit);
  assert.equal(err.rateLimit.requestsLimit, 100);
  assert.equal(err.retryAfterHint.provider, 'openai');
  assert.equal(err.retryAfterHint.source, 'headers');
  assert.equal(mw.stats.hintsCaptured, 1);
  assert.equal(mw.stats.byProvider.openai, 1);
});

// ---- Anthropic enrichment ---------------------------------------------

test('retryAfterPropagation: Anthropic 429 with reset ISO date', async () => {
  const mw = retryAfterPropagation();
  const resetAt = new Date(Date.now() + 60_000).toISOString();
  const err = Object.assign(new Error('rate limit'), {
    status: 429,
    headers: {
      'anthropic-ratelimit-tokens-limit': '100000',
      'anthropic-ratelimit-tokens-remaining': '0',
      'anthropic-ratelimit-tokens-reset': resetAt,
      'retry-after': '60',
    },
  });
  await assert.rejects(mw(ctxOf(), async () => { throw err; }));
  assert.equal(err.retryAfterMs, 60_000);
  assert.ok(Math.abs(err.resetAtMs - Date.parse(resetAt)) < 100);
  assert.equal(err.retryAfterHint.provider, 'anthropic');
});

// ---- Unknown provider fallback ---------------------------------------

test('retryAfterPropagation: unknown provider → stats but no enrichment', async () => {
  const mw = retryAfterPropagation();
  const err = Object.assign(new Error('rate limit'), {
    status: 429,
    headers: { 'x-custom': 'val' },
  });
  await assert.rejects(mw(ctxOf(), async () => { throw err; }));
  assert.equal(err.retryAfterMs, undefined);
  assert.equal(mw.stats.unknownProvider, 1);
  assert.equal(mw.stats.hintsCaptured, 0);
});

test('retryAfterPropagation: fallbackRetryMs applied when no provider detected', async () => {
  const mw = retryAfterPropagation({ fallbackRetryMs: 15_000 });
  const err = Object.assign(new Error('rate limit'), {
    status: 429,
    headers: {},
  });
  await assert.rejects(mw(ctxOf(), async () => { throw err; }));
  assert.equal(err.retryAfterMs, 15_000);
  assert.equal(err.retryAfterHint.source, 'fallback');
  assert.equal(err.retryAfterHint.provider, null);
  assert.equal(mw.stats.fallbackApplied, 1);
});

// ---- Manual provider override --------------------------------------

test('retryAfterPropagation: manual provider override', async () => {
  const mw = retryAfterPropagation({ provider: 'openai' });
  const err = Object.assign(new Error('too many'), {
    status: 429,
    headers: { 'retry-after': '10' },
  });
  await assert.rejects(mw(ctxOf(), async () => { throw err; }));
  assert.equal(err.retryAfterMs, 10_000);
  assert.equal(err.retryAfterHint.provider, 'openai');
});

// ---- Callback ------------------------------------------------------

test('retryAfterPropagation: onCapture fires with info', async () => {
  const events = [];
  const mw = retryAfterPropagation({ onCapture: (info) => events.push(info) });
  const err = Object.assign(new Error('too many'), {
    status: 429,
    headers: { 'x-ratelimit-limit-requests': '100', 'retry-after': '5' },
    code: 'RATE_LIMIT_GIVE_UP',
  });
  await assert.rejects(mw(ctxOf(), async () => { throw err; }));
  assert.equal(events.length, 1);
  assert.equal(events[0].provider, 'openai');
  assert.equal(events[0].retryAfterMs, 5_000);
  assert.equal(events[0].errorCode, 'RATE_LIMIT_GIVE_UP');
});

test('retryAfterPropagation: onCapture error swallowed', async () => {
  const mw = retryAfterPropagation({
    onCapture: () => { throw new Error('broken'); },
  });
  const err = Object.assign(new Error('too many'), {
    status: 429,
    headers: { 'x-ratelimit-limit-requests': '100', 'retry-after': '5' },
  });
  await assert.rejects(mw(ctxOf(), async () => { throw err; }), /too many/);
  assert.equal(err.retryAfterMs, 5_000);   // enrichment still happened
});

// ---- Custom parser -------------------------------------------------

test('retryAfterPropagation: custom parser via parsers option', async () => {
  let called = false;
  const customParser = (headers, status) => {
    called = true;
    return { retryAfterSeconds: 42 };
  };
  const mw = retryAfterPropagation({
    provider:  'custom',
    parsers:   { custom: customParser },
  });
  const err = Object.assign(new Error('rate'), { status: 429, headers: {} });
  await assert.rejects(mw(ctxOf(), async () => { throw err; }));
  assert.equal(called, true);
  assert.equal(err.retryAfterMs, 42_000);
});

test('retryAfterPropagation: parser throwing → no enrichment (soft-fail)', async () => {
  const badParser = () => { throw new Error('parser broke'); };
  const mw = retryAfterPropagation({
    provider: 'custom',
    parsers:  { custom: badParser },
  });
  const err = Object.assign(new Error('rate'), { status: 429, headers: {} });
  await assert.rejects(mw(ctxOf(), async () => { throw err; }));
  assert.equal(err.retryAfterMs, undefined);
});

test('retryAfterPropagation: parser returning null → no enrichment', async () => {
  const nullParser = () => null;
  const mw = retryAfterPropagation({
    provider: 'custom',
    parsers:  { custom: nullParser },
  });
  const err = Object.assign(new Error('rate'), { status: 429, headers: {} });
  await assert.rejects(mw(ctxOf(), async () => { throw err; }));
  assert.equal(err.retryAfterMs, undefined);
});

// ---- Accumulation ---------------------------------------------------

test('retryAfterPropagation: accumulates stats across multiple errors', async () => {
  const mw = retryAfterPropagation();
  for (let i = 0; i < 3; i++) {
    const err = Object.assign(new Error('rate'), {
      status: 429,
      headers: { 'x-ratelimit-limit-requests': '100', 'retry-after': '5' },
    });
    await assert.rejects(mw(ctxOf(), async () => { throw err; }));
  }
  assert.equal(mw.stats.totalErrors, 3);
  assert.equal(mw.stats.hintsCaptured, 3);
  assert.equal(mw.stats.byProvider.openai, 3);
});

// ---- MCP + reset ---------------------------------------------------

test('retryAfterPropagation: asMcpResource', () => {
  const mw = retryAfterPropagation({ fallbackRetryMs: 10_000 });
  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://retry-after-propagation');
  const p = r.handler();
  assert.equal(p.fallbackRetryMs, 10_000);
  assert.deepEqual(p.supportedProviders.sort(), ['anthropic', 'bedrock', 'gemini', 'openai']);
});

test('retryAfterPropagation: reset clears counters', async () => {
  const mw = retryAfterPropagation();
  const err = Object.assign(new Error('rate'), {
    status: 429,
    headers: { 'x-ratelimit-limit-requests': '100', 'retry-after': '5' },
  });
  await assert.rejects(mw(ctxOf(), async () => { throw err; }));
  assert.equal(mw.stats.hintsCaptured, 1);
  mw.reset();
  assert.equal(mw.stats.hintsCaptured, 0);
  assert.deepEqual(mw.stats.byProvider, {});
});

// ---- Non-object throws ----------------------------------------------

test('retryAfterPropagation: non-object throw passes through untouched', async () => {
  const mw = retryAfterPropagation();
  await assert.rejects(mw(ctxOf(), async () => { throw 'string error'; }), (r) => r === 'string error');
  assert.equal(mw.stats.totalErrors, 0);
});
