const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_cwf__';
require.cache[STUB_PATH] = {
  exports: {
    Service: class { constructor(name, model, options) { this.options = options ?? {}; } async init() {} },
    log: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  },
  loaded: true,
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function(request, ...rest) {
  if (request === '@sap/cds') return STUB_PATH;
  return origResolve.call(this, request, ...rest);
};

const {
  chatWithFallback,
  AllProvidersFailedError,
  defaultIsFallback,
} = require('../lib/chatWithFallback');
const { CircuitOpenError } = require('../lib/middleware/circuitBreaker');

// Fake service — captures the `chat` calls and returns a scripted response
// (or throws a scripted error).
function fakeService(name, script = []) {
  const svc = {
    name,
    calls: [],
    _script: [...script],
    async chat(req) {
      svc.calls.push(req);
      const next = svc._script.shift();
      if (typeof next === 'function') return next();
      return next ?? { text: `${name}-ok`, model: req.model, usage: { input_tokens: 5, output_tokens: 5 } };
    },
  };
  return svc;
}

// ---- Input validation --------------------------------------------------

test('chatWithFallback: rejects empty providers', async () => {
  await assert.rejects(() => chatWithFallback({ providers: [], request: {} }), /non-empty array/);
  await assert.rejects(() => chatWithFallback({ providers: null, request: {} }), /non-empty array/);
});

test('chatWithFallback: rejects providers without .chat()', async () => {
  await assert.rejects(
    () => chatWithFallback({ providers: [{ service: {} }], request: {} }),
    /must have a `service` with a `chat\(\)` method/,
  );
});

// ---- Happy path (first provider succeeds) -----------------------------

test('chatWithFallback: first provider succeeds → no fallback', async () => {
  const openai    = fakeService('openai');
  const anthropic = fakeService('anthropic');
  const res = await chatWithFallback({
    providers: [
      { service: openai,    model: 'gpt-4o-mini' },
      { service: anthropic, model: 'claude-3-5-sonnet' },
    ],
    request: { messages: [{ role: 'user', content: 'x' }] },
  });
  assert.equal(res.providerUsed, 'openai');
  assert.equal(res.modelUsed,    'gpt-4o-mini');
  assert.equal(res.attempts.length, 1);
  assert.equal(res.attempts[0].ok, true);
  assert.equal(openai.calls.length, 1);
  assert.equal(anthropic.calls.length, 0);
});

// ---- Fallback on 5xx --------------------------------------------------

test('chatWithFallback: 5xx from first provider fails over to second', async () => {
  const err500 = Object.assign(new Error('server error'), { status: 500 });
  const openai    = fakeService('openai',    [() => { throw err500; }]);
  const anthropic = fakeService('anthropic', [{ text: 'from-anthropic', model: 'claude-3-5-sonnet', usage: { input_tokens: 5, output_tokens: 5 } }]);
  const res = await chatWithFallback({
    providers: [
      { service: openai,    model: 'gpt-4o-mini' },
      { service: anthropic, model: 'claude-3-5-sonnet' },
    ],
    request: { messages: [{ role: 'user', content: 'x' }] },
  });
  assert.equal(res.providerUsed, 'anthropic');
  assert.equal(res.result.text,  'from-anthropic');
  assert.equal(res.attempts.length, 2);
  assert.equal(res.attempts[0].ok, false);
  assert.equal(res.attempts[0].status, 500);
  assert.equal(res.attempts[1].ok, true);
});

// ---- 4xx does NOT fail over (bad request will fail on all) ------------

test('chatWithFallback: 4xx does NOT fail over — throws AllProvidersFailedError immediately', async () => {
  const err400 = Object.assign(new Error('bad request'), { status: 400 });
  const openai    = fakeService('openai',    [() => { throw err400; }]);
  const anthropic = fakeService('anthropic');
  await assert.rejects(
    () => chatWithFallback({
      providers: [
        { service: openai,    model: 'gpt-4o-mini' },
        { service: anthropic, model: 'claude-3-5-sonnet' },
      ],
      request: { messages: [{ role: 'user', content: 'x' }] },
    }),
    (err) => {
      assert.ok(err instanceof AllProvidersFailedError);
      assert.equal(err.code, 'ALL_PROVIDERS_FAILED');
      assert.equal(err.attempts.length, 1);   // second provider never tried
      assert.equal(err.attempts[0].status, 400);
      return true;
    },
  );
  assert.equal(anthropic.calls.length, 0);   // proved second provider not called
});

// ---- CircuitOpenError treated as failover signal ----------------------

test('chatWithFallback: CircuitOpenError from first provider → fail over to next', async () => {
  const circErr = new CircuitOpenError('openai', 25_000, new Error('root'));
  const openai    = fakeService('openai',    [() => { throw circErr; }]);
  const anthropic = fakeService('anthropic', [{ text: 'from-anthropic', model: 'claude-3-5-sonnet' }]);
  const res = await chatWithFallback({
    providers: [
      { service: openai,    model: 'gpt-4o-mini' },
      { service: anthropic, model: 'claude-3-5-sonnet' },
    ],
    request: { messages: [{ role: 'user', content: 'x' }] },
  });
  assert.equal(res.providerUsed, 'anthropic');
  assert.equal(res.attempts[0].skipped, true);  // marked as short-circuit, not live attempt
  assert.equal(res.attempts[0].errorName, 'CircuitOpenError');
});

// ---- Network errors (no status) ---------------------------------------

test('chatWithFallback: network error (no status) fails over', async () => {
  const netErr = Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
  const openai    = fakeService('openai',    [() => { throw netErr; }]);
  const anthropic = fakeService('anthropic', [{ text: 'from-anthropic', model: 'claude-3-5-sonnet' }]);
  const res = await chatWithFallback({
    providers: [
      { service: openai,    model: 'gpt-4o-mini' },
      { service: anthropic, model: 'claude-3-5-sonnet' },
    ],
    request: { messages: [{ role: 'user', content: 'x' }] },
  });
  assert.equal(res.providerUsed, 'anthropic');
});

// ---- All providers fail ------------------------------------------------

test('chatWithFallback: all providers fail → AllProvidersFailedError with full attempt history', async () => {
  const err500 = Object.assign(new Error('server error'), { status: 500 });
  const openai    = fakeService('openai',    [() => { throw err500; }]);
  const anthropic = fakeService('anthropic', [() => { throw err500; }]);
  const bedrock   = fakeService('bedrock',   [() => { throw err500; }]);
  await assert.rejects(
    () => chatWithFallback({
      providers: [
        { service: openai,    model: 'gpt-4o-mini' },
        { service: anthropic, model: 'claude-3-5-sonnet' },
        { service: bedrock,   model: 'anthropic.claude-3-haiku-20240307-v1:0' },
      ],
      request: { messages: [{ role: 'user', content: 'x' }] },
    }),
    (err) => {
      assert.ok(err instanceof AllProvidersFailedError);
      assert.equal(err.attempts.length, 3);
      assert.ok(err.attempts.every((a) => !a.ok));
      assert.equal(err.cause, err500);
      return true;
    },
  );
});

// ---- Custom isFallback predicate --------------------------------------

test('chatWithFallback: custom isFallback can restrict fallback to specific errors', async () => {
  const err500 = Object.assign(new Error('server error'), { status: 500 });
  const err429 = Object.assign(new Error('rate'), { status: 429 });
  const openai    = fakeService('openai',    [() => { throw err500; }]);
  const anthropic = fakeService('anthropic');
  // Custom predicate: only 429 counts as fallback signal. 500 will NOT fail over.
  await assert.rejects(
    () => chatWithFallback({
      providers: [
        { service: openai,    model: 'gpt-4o-mini' },
        { service: anthropic, model: 'claude-3-5-sonnet' },
      ],
      request: { messages: [{ role: 'user', content: 'x' }] },
      isFallback: (err) => err?.status === 429,
    }),
    AllProvidersFailedError,
  );
  assert.equal(anthropic.calls.length, 0);   // 500 does not trigger failover with this predicate
});

// ---- Per-provider request overrides -----------------------------------

test('chatWithFallback: per-provider `request` overrides merge onto shared request', async () => {
  const openai    = fakeService('openai');
  const anthropic = fakeService('anthropic');
  await chatWithFallback({
    providers: [
      { service: openai,    model: 'gpt-4o-mini',      request: { maxTokens: 100, temperature: 0.1 } },
      { service: anthropic, model: 'claude-3-5-sonnet' },
    ],
    request: { messages: [{ role: 'user', content: 'x' }], maxTokens: 500 },
  });
  const req = openai.calls[0];
  assert.equal(req.maxTokens,   100);        // per-provider override wins
  assert.equal(req.temperature, 0.1);
  assert.deepEqual(req.messages, [{ role: 'user', content: 'x' }]);
  assert.equal(req.model, 'gpt-4o-mini');
});

// ---- onFailover callback -----------------------------------------------

test('chatWithFallback: onFailover fires on each transition with { from, to, error, skipped, willRetry }', async () => {
  const circErr = new CircuitOpenError('openai', 10_000, new Error('root'));
  const err500  = Object.assign(new Error('server error'), { status: 500 });
  const openai    = fakeService('openai',    [() => { throw circErr; }]);
  const anthropic = fakeService('anthropic', [() => { throw err500; }]);
  const bedrock   = fakeService('bedrock',   [{ text: 'ok' }]);
  const events = [];
  const res = await chatWithFallback({
    providers: [
      { service: openai,    model: 'gpt-4o-mini' },
      { service: anthropic, model: 'claude-3-5-sonnet' },
      { service: bedrock,   model: 'anthropic.claude-3-haiku-20240307-v1:0' },
    ],
    request: { messages: [{ role: 'user', content: 'x' }] },
    onFailover: (info) => events.push(info),
  });
  assert.equal(res.providerUsed, 'bedrock');
  assert.equal(events.length, 2);
  assert.equal(events[0].from,      'openai');
  assert.equal(events[0].to,        'anthropic');
  assert.equal(events[0].skipped,   true);            // circuit-open → skipped
  assert.equal(events[0].willRetry, true);
  assert.equal(events[1].from,      'anthropic');
  assert.equal(events[1].to,        'bedrock');
  assert.equal(events[1].skipped,   false);           // 500 → live attempt
  assert.equal(events[1].willRetry, true);
});

test('chatWithFallback: onFailover errors are swallowed (do not affect outcome)', async () => {
  const err500 = Object.assign(new Error('server error'), { status: 500 });
  const openai    = fakeService('openai',    [() => { throw err500; }]);
  const anthropic = fakeService('anthropic', [{ text: 'ok' }]);
  const res = await chatWithFallback({
    providers: [
      { service: openai,    model: 'gpt-4o-mini' },
      { service: anthropic, model: 'claude-3-5-sonnet' },
    ],
    request: { messages: [{ role: 'user', content: 'x' }] },
    onFailover: () => { throw new Error('user handler blew up'); },
  });
  assert.equal(res.providerUsed, 'anthropic');
});

// ---- defaultIsFallback -------------------------------------------------

test('defaultIsFallback: matches CircuitOpenError, RateLimitGiveUpError, 5xx, and network errors', () => {
  assert.equal(defaultIsFallback({ name: 'CircuitOpenError' }), true);
  assert.equal(defaultIsFallback({ code: 'CIRCUIT_OPEN' }), true);
  assert.equal(defaultIsFallback({ name: 'RateLimitGiveUpError' }), true);
  assert.equal(defaultIsFallback({ code: 'RATE_LIMIT_GIVE_UP' }), true);
  assert.equal(defaultIsFallback({ status: 500 }), true);
  assert.equal(defaultIsFallback({ status: 503 }), true);
  assert.equal(defaultIsFallback({ code: 'ECONNRESET' }), true);   // no status
  assert.equal(defaultIsFallback({ status: 400 }), false);
  assert.equal(defaultIsFallback({ status: 401 }), false);
  assert.equal(defaultIsFallback({ status: 429 }), false);   // 429 is retry-in-place territory, not failover
});
