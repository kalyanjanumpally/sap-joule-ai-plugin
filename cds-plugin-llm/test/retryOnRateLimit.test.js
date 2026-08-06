const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_rrl__';
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

const LLMService = require('../lib/LLMService');
const { retryOnRateLimit, RateLimitGiveUpError } = require('../lib/middleware/retryOnRateLimit');
const { RetryableError } = require('../lib/util');

class Stub extends LLMService {
  async init() { await super.init(); this.calls = 0; this._script = []; }
  async _chat() {
    this.calls++;
    const next = this._script.shift();
    if (typeof next === 'function') return next();
    return { text: 'ok', model: 'stub', usage: { input_tokens: 5, output_tokens: 5 }, stopReason: 'end_turn' };
  }
}
function makeSvc() { return new Stub('llm', null, { modelId: 'test', maxTokens: 100 }); }

// ---- Validation --------------------------------------------------------

test('retryOnRateLimit: rejects non-positive maxAttempts', () => {
  assert.throws(() => retryOnRateLimit({ maxAttempts: 0 }), /maxAttempts/);
  assert.throws(() => retryOnRateLimit({ maxAttempts: -1 }), /maxAttempts/);
  assert.throws(() => retryOnRateLimit({ maxAttempts: 1.5 }), /maxAttempts/);
});
test('retryOnRateLimit: rejects negative fallbackWaitMs / jitterMs', () => {
  assert.throws(() => retryOnRateLimit({ fallbackWaitMs: -1 }), /fallbackWaitMs/);
  assert.throws(() => retryOnRateLimit({ jitterMs: -1 }),      /jitterMs/);
});

// ---- Happy path --------------------------------------------------------

test('retryOnRateLimit: success on first try does not retry', async () => {
  const svc = makeSvc(); await svc.init();
  const retry = retryOnRateLimit({ maxAttempts: 3 });
  svc.use(retry);
  const res = await svc.chat({ messages: [{ role: 'user', content: 'x' }], retries: { max: 0 } });
  assert.equal(res.text, 'ok');
  assert.equal(svc.calls, 1);
  assert.equal(retry.stats.requests, 1);
  assert.equal(retry.stats.retriedRequests, 0);
  assert.equal(retry.stats.totalRetries, 0);
});

// ---- Retry on RetryableError --------------------------------------------

test('retryOnRateLimit: retries on RetryableError with retryAfterSec', async () => {
  const svc = makeSvc(); await svc.init();
  svc._script = [
    () => { throw new RetryableError('rate limited', 429, 0); },  // 0 sec — fast test
  ];
  const retry = retryOnRateLimit({ maxAttempts: 3, jitterMs: 0 });
  svc.use(retry);
  const res = await svc.chat({ messages: [{ role: 'user', content: 'x' }], retries: { max: 0 } });
  assert.equal(res.text, 'ok');
  assert.equal(svc.calls, 2);
  assert.equal(retry.stats.retriedRequests, 1);
  assert.equal(retry.stats.totalRetries,   1);
});

test('retryOnRateLimit: retries multiple times, waiting between each', async () => {
  const svc = makeSvc(); await svc.init();
  svc._script = [
    () => { throw new RetryableError('rate limited', 429, 0); },
    () => { throw new RetryableError('rate limited', 429, 0); },
  ];
  const retry = retryOnRateLimit({ maxAttempts: 3, jitterMs: 0 });
  svc.use(retry);
  const res = await svc.chat({ messages: [{ role: 'user', content: 'x' }], retries: { max: 0 } });
  assert.equal(res.text, 'ok');
  assert.equal(svc.calls, 3);
  assert.equal(retry.stats.retriedRequests, 1);
  assert.equal(retry.stats.totalRetries,   2);
});

// ---- Retry on plain error with status --------------------------------

test('retryOnRateLimit: retries on plain Error with status=429', async () => {
  const svc = makeSvc(); await svc.init();
  svc._script = [
    () => { const e = new Error('too many'); e.status = 429; throw e; },
  ];
  const retry = retryOnRateLimit({ maxAttempts: 3, fallbackWaitMs: 0, jitterMs: 0 });
  svc.use(retry);
  const res = await svc.chat({ messages: [{ role: 'user', content: 'x' }], retries: { max: 0 } });
  assert.equal(res.text, 'ok');
  assert.equal(svc.calls, 2);
});

test('retryOnRateLimit: does NOT retry on non-retryable status (e.g. 400)', async () => {
  const svc = makeSvc(); await svc.init();
  svc._script = [
    () => { const e = new Error('bad request'); e.status = 400; throw e; },
  ];
  const retry = retryOnRateLimit({ maxAttempts: 3 });
  svc.use(retry);
  await assert.rejects(
    () => svc.chat({ messages: [{ role: 'user', content: 'x' }], retries: { max: 0 } }),
    (err) => err.message === 'bad request',
  );
  assert.equal(svc.calls, 1);
  assert.equal(retry.stats.retriedRequests, 0);
});

test('retryOnRateLimit: custom retryOnStatuses adds 500', async () => {
  const svc = makeSvc(); await svc.init();
  svc._script = [
    () => { const e = new Error('server'); e.status = 500; throw e; },
  ];
  const retry = retryOnRateLimit({ maxAttempts: 3, retryOnStatuses: [429, 500], fallbackWaitMs: 0, jitterMs: 0 });
  svc.use(retry);
  const res = await svc.chat({ messages: [{ role: 'user', content: 'x' }], retries: { max: 0 } });
  assert.equal(res.text, 'ok');
});

// ---- Give-up path -----------------------------------------------------

test('retryOnRateLimit: exhausts maxAttempts → RateLimitGiveUpError with history', async () => {
  const svc = makeSvc(); await svc.init();
  svc._script = [
    () => { throw new RetryableError('r1', 429, 0); },
    () => { throw new RetryableError('r2', 429, 0); },
    () => { throw new RetryableError('r3', 429, 0); },
  ];
  const retry = retryOnRateLimit({ maxAttempts: 3, jitterMs: 0 });
  svc.use(retry);
  await assert.rejects(
    () => svc.chat({ messages: [{ role: 'user', content: 'x' }], retries: { max: 0 } }),
    (err) => {
      assert.ok(err instanceof RateLimitGiveUpError);
      assert.equal(err.code, 'RATE_LIMIT_GIVE_UP');
      assert.equal(err.attempts.length, 2, 'the first attempt is the initial call, then two retries queued before the final error');
      assert.equal(err.cause.message, 'r3');
      return true;
    },
  );
  assert.equal(svc.calls, 3);
  assert.equal(retry.stats.givenUp, 1);
});

// ---- Callbacks --------------------------------------------------------

test('retryOnRateLimit: onRetry fires per retry attempt', async () => {
  const svc = makeSvc(); await svc.init();
  svc._script = [
    () => { throw new RetryableError('first', 429, 0); },
    () => { throw new RetryableError('second', 429, 0); },
  ];
  const events = [];
  const retry = retryOnRateLimit({
    maxAttempts: 4, jitterMs: 0,
    onRetry: (info) => events.push({ attempt: info.attempt, status: info.status, waitMs: info.waitMs }),
  });
  svc.use(retry);
  await svc.chat({ messages: [{ role: 'user', content: 'x' }], retries: { max: 0 } });
  assert.equal(events.length, 2);
  assert.equal(events[0].attempt, 1);
  assert.equal(events[0].status, 429);
  assert.equal(events[1].attempt, 2);
});

test('retryOnRateLimit: onGiveUp fires with attempt history', async () => {
  const svc = makeSvc(); await svc.init();
  svc._script = [
    () => { throw new RetryableError('r1', 429, 0); },
    () => { throw new RetryableError('r2', 429, 0); },
  ];
  const events = [];
  const retry = retryOnRateLimit({
    maxAttempts: 2, jitterMs: 0,
    onGiveUp: (info) => events.push({ attempts: info.attempts.length, finalMsg: info.finalError.message }),
  });
  svc.use(retry);
  await svc.chat({ messages: [{ role: 'user', content: 'x' }], retries: { max: 0 } }).catch(() => {});
  assert.equal(events.length, 1);
  assert.equal(events[0].attempts, 1, 'one retry before give-up');
  assert.equal(events[0].finalMsg, 'r2');
});

test('retryOnRateLimit: onRetry / onGiveUp errors are swallowed', async () => {
  const svc = makeSvc(); await svc.init();
  svc._script = [() => { throw new RetryableError('rate limited', 429, 0); }];
  const retry = retryOnRateLimit({
    maxAttempts: 2, jitterMs: 0,
    onRetry: () => { throw new Error('boom'); },
  });
  svc.use(retry);
  const res = await svc.chat({ messages: [{ role: 'user', content: 'x' }], retries: { max: 0 } });
  assert.equal(res.text, 'ok', 'broken hook must never take down chat()');
});

// ---- Stats + reset + asMcpResource -----------------------------------

test('retryOnRateLimit: stats accumulate wait time correctly', async () => {
  const svc = makeSvc(); await svc.init();
  svc._script = [
    () => { throw new RetryableError('rate limited', 429, 0.05); }, // 50ms
  ];
  const retry = retryOnRateLimit({ maxAttempts: 3, jitterMs: 0 });
  svc.use(retry);
  await svc.chat({ messages: [{ role: 'user', content: 'x' }], retries: { max: 0 } });
  assert.equal(retry.stats.totalWaitMs, 50);
});

test('retryOnRateLimit: reset() zeroes all counters', async () => {
  const svc = makeSvc(); await svc.init();
  svc._script = [() => { throw new RetryableError('r', 429, 0); }];
  const retry = retryOnRateLimit({ maxAttempts: 3, jitterMs: 0 });
  svc.use(retry);
  await svc.chat({ messages: [{ role: 'user', content: 'x' }], retries: { max: 0 } });
  assert.ok(retry.stats.totalRetries > 0);
  retry.reset();
  assert.equal(retry.stats.requests, 0);
  assert.equal(retry.stats.retriedRequests, 0);
  assert.equal(retry.stats.totalRetries, 0);
  assert.equal(retry.stats.givenUp, 0);
  assert.equal(retry.stats.totalWaitMs, 0);
});

test('retryOnRateLimit: asMcpResource returns config://rate-limit-retry with counters + config', async () => {
  const retry = retryOnRateLimit({ maxAttempts: 5, fallbackWaitMs: 1000, jitterMs: 100 });
  const r = retry.asMcpResource();
  assert.equal(r.uri, 'config://rate-limit-retry');
  const payload = r.handler();
  assert.equal(payload.maxAttempts, 5);
  assert.equal(payload.fallbackWaitMs, 1000);
  assert.equal(payload.jitterMs, 100);
  assert.deepEqual(payload.retryOnStatuses, [429, 503]);
  assert.equal(payload.requests, 0);
});
