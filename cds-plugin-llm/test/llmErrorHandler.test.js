const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_llmeh__';
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

const { llmErrorHandler } = require('../lib/llmErrorHandler');
const { CircuitOpenError } = require('../lib/middleware/circuitBreaker');
const { BulkheadFullError, BulkheadTimeoutError } = require('../lib/middleware/bulkhead');
const { DeadlineExceededError } = require('../lib/middleware/deadline');
const { CostGuardBlockedError } = require('../lib/middleware/costGuard');
const { PromptInjectionError } = require('../lib/middleware/promptInjectionGuard');

// Fake Express `res` — captures status + json calls + headers
function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} };
  res.status    = (c) => { res.statusCode = c; return res; };
  res.json      = (b) => { res.body = b; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  return res;
}

// Fake req (Express-ish)
function fakeReq(method = 'POST', url = '/ai/chat') {
  return { method, url, originalUrl: url };
}

// ---- Input validation --------------------------------------------------

test('llmErrorHandler: throws when mask is not an array', () => {
  assert.throws(() => llmErrorHandler({ mask: 'stack' }), /mask must be an array/);
});

// ---- LLMError → structured response -----------------------------------

test('llmErrorHandler: CircuitOpenError → HTTP 503 + Retry-After + details', () => {
  const handler = llmErrorHandler();
  const err = new CircuitOpenError('openai', 25_000, new Error('root'));
  const res = fakeRes();
  handler(err, fakeReq(), res, () => {});
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers['Retry-After'], '25');
  assert.equal(res.body.error.code, 'CIRCUIT_OPEN');
  assert.equal(res.body.error.primitive, 'circuitBreaker');
  assert.equal(res.body.error.retriable, true);
  assert.equal(res.body.error.severity, 'error');
  assert.equal(res.body.error.details.provider, 'openai');
  assert.equal(res.body.error.details.cooldownRemainingMs, 25_000);
});

test('llmErrorHandler: BulkheadFullError → HTTP 429 + Retry-After: 1', () => {
  const handler = llmErrorHandler();
  const err = new BulkheadFullError('openai', 50);
  const res = fakeRes();
  handler(err, fakeReq(), res, () => {});
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers['Retry-After'], '1');
  assert.equal(res.body.error.code, 'BULKHEAD_FULL');
});

test('llmErrorHandler: BulkheadTimeoutError → HTTP 429 + Retry-After: 1', () => {
  const handler = llmErrorHandler();
  const err = new BulkheadTimeoutError('openai', 5000);
  const res = fakeRes();
  handler(err, fakeReq(), res, () => {});
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers['Retry-After'], '1');
});

test('llmErrorHandler: DeadlineExceededError → HTTP 504, no Retry-After', () => {
  const handler = llmErrorHandler();
  const err = new DeadlineExceededError(30_000, 'chat');
  const res = fakeRes();
  handler(err, fakeReq(), res, () => {});
  assert.equal(res.statusCode, 504);
  assert.equal(res.headers['Retry-After'], undefined);
  assert.equal(res.body.error.code, 'DEADLINE_EXCEEDED');
  assert.equal(res.body.error.details.timeoutMs, 30_000);
  assert.equal(res.body.error.details.method, 'chat');
});

test('llmErrorHandler: CostGuardBlockedError → HTTP 402 + retriable=false', () => {
  const handler = llmErrorHandler();
  const err = new CostGuardBlockedError(0.50, 0.10, 'claude-opus-4-7');
  const res = fakeRes();
  handler(err, fakeReq(), res, () => {});
  assert.equal(res.statusCode, 402);
  assert.equal(res.body.error.retriable, false);
  assert.equal(res.body.error.details.estimatedUsd, 0.50);
  assert.equal(res.body.error.details.limitUsd, 0.10);
  assert.equal(res.body.error.details.model, 'claude-opus-4-7');
});

test('llmErrorHandler: PromptInjectionError → HTTP 400 + evidence in details', () => {
  const handler = llmErrorHandler();
  const err = new PromptInjectionError(0.87, ['ignore previous instructions', 'zero-width chars']);
  const res = fakeRes();
  handler(err, fakeReq(), res, () => {});
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body.error.details.evidence, ['ignore previous instructions', 'zero-width chars']);
});

// ---- Non-LLMError path -------------------------------------------------

test('llmErrorHandler: non-LLMError passed through to next()', () => {
  const handler = llmErrorHandler();
  const err = new Error('random');
  let nextCalledWith;
  handler(err, fakeReq(), fakeRes(), (e) => { nextCalledWith = e; });
  assert.equal(nextCalledWith, err);
});

test('llmErrorHandler: passThroughNonLLMErrors=false → generic 500', () => {
  const handler = llmErrorHandler({ passThroughNonLLMErrors: false });
  const err = new Error('some internal thing that should not leak');
  const res = fakeRes();
  let nextCalled = false;
  handler(err, fakeReq(), res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error.code, 'INTERNAL_ERROR');
  // Original message NOT leaked
  assert.doesNotMatch(JSON.stringify(res.body), /some internal thing/);
});

// ---- log callback ------------------------------------------------------

test('llmErrorHandler: log callback fires with { method, url, status, code }', () => {
  const captured = [];
  const handler = llmErrorHandler({ log: (err, meta) => captured.push({ err, meta }) });
  const err = new CircuitOpenError('openai', 5000, new Error());
  handler(err, fakeReq('POST', '/ai/chat'), fakeRes(), () => {});
  assert.equal(captured.length, 1);
  assert.equal(captured[0].err, err);
  assert.equal(captured[0].meta.method, 'POST');
  assert.equal(captured[0].meta.url, '/ai/chat');
  assert.equal(captured[0].meta.status, 503);
  assert.equal(captured[0].meta.code, 'CIRCUIT_OPEN');
});

test('llmErrorHandler: log callback errors are swallowed (does not affect response)', () => {
  const handler = llmErrorHandler({ log: () => { throw new Error('logger broken'); } });
  const err = new DeadlineExceededError(1000, 'chat');
  const res = fakeRes();
  handler(err, fakeReq(), res, () => {});
  assert.equal(res.statusCode, 504);
  assert.equal(res.body.error.code, 'DEADLINE_EXCEEDED');
});

// ---- includeStack + mask ----------------------------------------------

test('llmErrorHandler: includeStack=true adds stack trace to response body', () => {
  const handler = llmErrorHandler({ includeStack: true });
  const err = new CircuitOpenError('openai', 5000, new Error());
  const res = fakeRes();
  handler(err, fakeReq(), res, () => {});
  assert.ok(typeof res.body.error.stack === 'string');
  assert.ok(res.body.error.stack.length > 0);
});

test('llmErrorHandler: includeStack=false (default) omits stack trace', () => {
  const handler = llmErrorHandler();
  const err = new CircuitOpenError('openai', 5000, new Error());
  const res = fakeRes();
  handler(err, fakeReq(), res, () => {});
  assert.equal(res.body.error.stack, undefined);
});

test('llmErrorHandler: mask strips specified fields from details', () => {
  const handler = llmErrorHandler({ mask: ['cooldownRemainingMs'] });
  const err = new CircuitOpenError('openai', 25_000, new Error());
  const res = fakeRes();
  handler(err, fakeReq(), res, () => {});
  assert.equal(res.body.error.details.cooldownRemainingMs, undefined);
  assert.equal(res.body.error.details.provider, 'openai');   // not masked
});

test('llmErrorHandler: mask with includeStack: mask wins for `stack`', () => {
  const handler = llmErrorHandler({ includeStack: true, mask: ['stack'] });
  const err = new CircuitOpenError('openai', 5000, new Error());
  const res = fakeRes();
  handler(err, fakeReq(), res, () => {});
  assert.equal(res.body.error.stack, undefined);
});

// ---- Cause serialization ----------------------------------------------

test('llmErrorHandler: details.cause is NOT included (avoid nesting) — details include everything else', () => {
  const handler = llmErrorHandler();
  const rootCause = new Error('provider timed out');
  const err = new CircuitOpenError('openai', 5000, rootCause);
  const res = fakeRes();
  handler(err, fakeReq(), res, () => {});
  // 'cause' is a base-key so it's stripped from details by design
  assert.equal(res.body.error.details.cause, undefined);
});

// ---- Bare http.ServerResponse shape -----------------------------------

test('llmErrorHandler: works with bare http.ServerResponse (writeHead/end)', () => {
  const handler = llmErrorHandler();
  let capturedCode, capturedHeaders, capturedBody;
  const res = {
    writeHead: (c, h) => { capturedCode = c; capturedHeaders = h; },
    end: (b) => { capturedBody = b; },
  };
  const err = new BulkheadFullError('openai', 50);
  handler(err, fakeReq(), res, () => {});
  assert.equal(capturedCode, 429);
  assert.equal(capturedHeaders['Content-Type'], 'application/json');
  assert.equal(capturedHeaders['Retry-After'], '1');
  const parsed = JSON.parse(capturedBody);
  assert.equal(parsed.error.code, 'BULKHEAD_FULL');
});
