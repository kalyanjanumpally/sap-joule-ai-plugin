const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_ar__';
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

const { autoRetry, defaultRetryOn } = require('../lib/autoRetry');
const { CircuitOpenError } = require('../lib/middleware/circuitBreaker');
const { BulkheadFullError, BulkheadTimeoutError } = require('../lib/middleware/bulkhead');
const { DeadlineExceededError } = require('../lib/middleware/deadline');
const { CostGuardBlockedError } = require('../lib/middleware/costGuard');
const { PromptInjectionError } = require('../lib/middleware/promptInjectionGuard');

// ---- Input validation --------------------------------------------------

test('autoRetry: throws when first arg is not a function', () => {
  assert.throws(() => autoRetry('notafunction'), /first arg must be a function/);
});

test('autoRetry: throws on non-positive maxAttempts', () => {
  assert.throws(() => autoRetry(async () => {}, { maxAttempts: 0 }),  /maxAttempts/);
  assert.throws(() => autoRetry(async () => {}, { maxAttempts: -1 }), /maxAttempts/);
  assert.throws(() => autoRetry(async () => {}, { maxAttempts: 1.5 }), /maxAttempts/);
});

test('autoRetry: throws on negative backoff / jitter / maxBackoff', () => {
  assert.throws(() => autoRetry(async () => {}, { backoffMs: -1 }),     /backoffMs/);
  assert.throws(() => autoRetry(async () => {}, { jitterMs: -1 }),      /jitterMs/);
  assert.throws(() => autoRetry(async () => {}, { maxBackoffMs: -1 }),  /maxBackoffMs/);
});

// ---- Happy path --------------------------------------------------------

test('autoRetry: successful call on first attempt — no retry, no stats increment', async () => {
  const fn = async () => ({ text: 'ok' });
  const wrapped = autoRetry(fn, { maxAttempts: 3 });
  const res = await wrapped({ x: 1 });
  assert.deepEqual(res, { text: 'ok' });
  assert.equal(wrapped.stats.calls, 1);
  assert.equal(wrapped.stats.retriedCalls, 0);
  assert.equal(wrapped.stats.totalRetries, 0);
});

test('autoRetry: forwards args + this to the wrapped function', async () => {
  const obj = {
    label: 'myLabel',
    async chat(req) { return { label: this.label, req }; },
  };
  const wrapped = autoRetry(obj.chat, { maxAttempts: 1 });
  const res = await wrapped.call(obj, { messages: [] });
  assert.deepEqual(res, { label: 'myLabel', req: { messages: [] } });
});

// ---- Retriable error retries -----------------------------------------

test('autoRetry: retries BulkheadFullError, eventually succeeds', async () => {
  let call = 0;
  const fn = async () => {
    call++;
    if (call < 3) throw new BulkheadFullError('openai', 50);
    return { text: 'ok', attempt: call };
  };
  const wrapped = autoRetry(fn, { maxAttempts: 5, backoffMs: 1, jitterMs: 0 });
  const res = await wrapped();
  assert.equal(res.text, 'ok');
  assert.equal(res.attempt, 3);
  assert.equal(wrapped.stats.calls, 1);
  assert.equal(wrapped.stats.retriedCalls, 1);
  assert.equal(wrapped.stats.totalRetries, 2);
});

test('autoRetry: BulkheadTimeoutError also retries', async () => {
  let call = 0;
  const fn = async () => {
    call++;
    if (call < 2) throw new BulkheadTimeoutError('openai', 5000);
    return { text: 'ok' };
  };
  const wrapped = autoRetry(fn, { maxAttempts: 3, backoffMs: 1, jitterMs: 0 });
  const res = await wrapped();
  assert.equal(res.text, 'ok');
  assert.equal(wrapped.stats.totalRetries, 1);
});

test('autoRetry: CircuitOpenError uses cooldownRemainingMs for wait duration', async () => {
  let call = 0;
  const fn = async () => {
    call++;
    if (call === 1) throw new CircuitOpenError('openai', 30, new Error());   // 30ms cooldown
    return { text: 'ok' };
  };
  const wrapped = autoRetry(fn, { maxAttempts: 2, backoffMs: 5000, jitterMs: 0, maxBackoffMs: 30_000 });
  const startedAt = Date.now();
  const res = await wrapped();
  const elapsed = Date.now() - startedAt;
  assert.equal(res.text, 'ok');
  // Should wait ~30ms (from cooldownRemainingMs), NOT 5000ms (backoffMs)
  assert.ok(elapsed >= 20 && elapsed < 500, `waited ${elapsed}ms — should be ~30ms from cooldownRemainingMs`);
});

test('autoRetry: exponential backoff — wait grows across attempts', async () => {
  let call = 0;
  const waits = [];
  const fn = async () => {
    call++;
    if (call < 4) throw new BulkheadFullError('a', 0);
    return { text: 'ok' };
  };
  const wrapped = autoRetry(fn, {
    maxAttempts: 5, backoffMs: 10, jitterMs: 0, maxBackoffMs: 10_000,
    onRetry: (info) => waits.push(info.ctx.waitMs),
  });
  await wrapped();
  // Expected: [10, 20, 40]
  assert.equal(waits.length, 3);
  assert.equal(waits[0], 10);
  assert.equal(waits[1], 20);
  assert.equal(waits[2], 40);
});

test('autoRetry: maxBackoffMs caps individual waits', async () => {
  let call = 0;
  const waits = [];
  const fn = async () => {
    call++;
    if (call < 4) throw new BulkheadFullError('a', 0);
    return { text: 'ok' };
  };
  const wrapped = autoRetry(fn, {
    maxAttempts: 5, backoffMs: 100, jitterMs: 0, maxBackoffMs: 150,
    onRetry: (info) => waits.push(info.ctx.waitMs),
  });
  await wrapped();
  // 100, 200 (capped→150), 400 (capped→150)
  assert.equal(waits[0], 100);
  assert.equal(waits[1], 150);
  assert.equal(waits[2], 150);
});

// ---- Non-retriable errors: immediate throw ---------------------------

test('autoRetry: DeadlineExceededError → immediate throw, NO retry', async () => {
  let call = 0;
  const fn = async () => {
    call++;
    throw new DeadlineExceededError(30_000, 'chat');
  };
  const wrapped = autoRetry(fn, { maxAttempts: 5, backoffMs: 1 });
  await assert.rejects(wrapped(), DeadlineExceededError);
  assert.equal(call, 1, 'should NOT retry non-retriable error');
  assert.equal(wrapped.stats.totalRetries, 0);
});

test('autoRetry: CostGuardBlockedError → immediate throw', async () => {
  let call = 0;
  const fn = async () => {
    call++;
    throw new CostGuardBlockedError(0.5, 0.1, 'gpt-4o');
  };
  const wrapped = autoRetry(fn, { maxAttempts: 5, backoffMs: 1 });
  await assert.rejects(wrapped(), CostGuardBlockedError);
  assert.equal(call, 1);
});

test('autoRetry: PromptInjectionError → immediate throw', async () => {
  const fn = async () => { throw new PromptInjectionError(0.9, ['x']); };
  const wrapped = autoRetry(fn, { maxAttempts: 5, backoffMs: 1 });
  await assert.rejects(wrapped(), PromptInjectionError);
});

test('autoRetry: plain Error (no retriable field) → immediate throw', async () => {
  let call = 0;
  const fn = async () => { call++; throw new Error('random'); };
  const wrapped = autoRetry(fn, { maxAttempts: 3, backoffMs: 1 });
  await assert.rejects(wrapped(), /random/);
  assert.equal(call, 1, 'plain Error is not retriable, should not retry');
});

// ---- Give-up ----------------------------------------------------------

test('autoRetry: retriable error that never recovers → give up after maxAttempts', async () => {
  let call = 0;
  const fn = async () => { call++; throw new BulkheadFullError('a', 0); };
  const wrapped = autoRetry(fn, { maxAttempts: 3, backoffMs: 1, jitterMs: 0 });
  await assert.rejects(wrapped(), BulkheadFullError);
  assert.equal(call, 3);
  assert.equal(wrapped.stats.givenUp, 1);
});

test('autoRetry: given-up error carries autoRetryAttempts field', async () => {
  const fn = async () => { throw new BulkheadFullError('a', 0); };
  const wrapped = autoRetry(fn, { maxAttempts: 3, backoffMs: 1, jitterMs: 0 });
  const err = await wrapped().catch((e) => e);
  assert.ok(Array.isArray(err.autoRetryAttempts));
  assert.equal(err.autoRetryAttempts.length, 2);   // 2 retries between 3 total attempts
  assert.equal(err.autoRetryAttempts[0].code, 'BULKHEAD_FULL');
});

test('autoRetry: give-up preserves the original error class + code', async () => {
  const orig = new BulkheadFullError('provX', 42);
  const fn = async () => { throw orig; };
  const wrapped = autoRetry(fn, { maxAttempts: 2, backoffMs: 1 });
  const caught = await wrapped().catch((e) => e);
  assert.ok(caught instanceof BulkheadFullError);
  assert.equal(caught.code, 'BULKHEAD_FULL');
  assert.equal(caught.provider, 'provX');
  assert.equal(caught.maxQueued, 42);
});

// ---- onRetry + onGiveUp callbacks -----------------------------------

test('autoRetry: onRetry fires with { ctx: { attempt, waitMs, code, error }, error }', async () => {
  const events = [];
  let call = 0;
  const fn = async () => {
    call++;
    if (call < 2) throw new BulkheadFullError('a', 0);
    return { text: 'ok' };
  };
  const wrapped = autoRetry(fn, {
    maxAttempts: 3,
    backoffMs:   1,
    jitterMs:    0,
    onRetry: (info) => events.push(info),
  });
  await wrapped();
  assert.equal(events.length, 1);
  assert.equal(events[0].ctx.attempt, 1);
  assert.equal(events[0].ctx.code, 'BULKHEAD_FULL');
  assert.ok(events[0].error instanceof BulkheadFullError);
});

test('autoRetry: onGiveUp fires once with { attempts, finalError } on final failure', async () => {
  const events = [];
  const fn = async () => { throw new BulkheadFullError('a', 0); };
  const wrapped = autoRetry(fn, {
    maxAttempts: 3, backoffMs: 1, jitterMs: 0,
    onGiveUp: (info) => events.push(info),
  });
  await wrapped().catch(() => {});
  assert.equal(events.length, 1);
  assert.equal(events[0].attempts.length, 2);   // 2 retries between 3 attempts
  assert.ok(events[0].finalError instanceof BulkheadFullError);
});

test('autoRetry: onRetry / onGiveUp callback errors are swallowed', async () => {
  const fn = async () => { throw new BulkheadFullError('a', 0); };
  const wrapped = autoRetry(fn, {
    maxAttempts: 2, backoffMs: 1,
    onRetry:  () => { throw new Error('handler broken'); },
    onGiveUp: () => { throw new Error('another handler broken'); },
  });
  // Should still throw the original error, not the handler's
  await assert.rejects(wrapped(), BulkheadFullError);
});

// ---- Custom retryOn ---------------------------------------------------

test('autoRetry: custom retryOn overrides default', async () => {
  let call = 0;
  const fn = async () => {
    call++;
    throw Object.assign(new Error('boom'), { httpCode: 429 });
  };
  const wrapped = autoRetry(fn, {
    maxAttempts: 3, backoffMs: 1,
    retryOn: (err) => err?.httpCode === 429,
  });
  await assert.rejects(wrapped(), /boom/);
  assert.equal(call, 3);   // retried thanks to custom predicate
});

test('autoRetry: custom retryOn can be MORE restrictive than default', async () => {
  let call = 0;
  // Don't retry BulkheadFull, only Bulkhead-timeout
  const fn = async () => { call++; throw new BulkheadFullError('a', 0); };
  const wrapped = autoRetry(fn, {
    maxAttempts: 3, backoffMs: 1,
    retryOn: (err) => err?.code === 'BULKHEAD_TIMEOUT',
  });
  await assert.rejects(wrapped(), BulkheadFullError);
  assert.equal(call, 1);
});

// ---- defaultRetryOn ---------------------------------------------------

test('defaultRetryOn: true for retriable, false for non-retriable / plain / null', () => {
  assert.equal(defaultRetryOn(new CircuitOpenError('a', 0, new Error())),  true);
  assert.equal(defaultRetryOn(new BulkheadFullError('a', 0)),              true);
  assert.equal(defaultRetryOn(new BulkheadTimeoutError('a', 0)),           true);
  assert.equal(defaultRetryOn(new DeadlineExceededError(1, 'chat')),       false);
  assert.equal(defaultRetryOn(new CostGuardBlockedError(1, 0.5, 'x')),     false);
  assert.equal(defaultRetryOn(new Error('plain')),                         false);
  assert.equal(defaultRetryOn(null),                                       false);
  assert.equal(defaultRetryOn(undefined),                                  false);
});

// ---- reset() stats ----------------------------------------------------

test('autoRetry: reset() clears stats', async () => {
  const fn = async () => ({});
  const wrapped = autoRetry(fn);
  await wrapped();
  await wrapped();
  assert.equal(wrapped.stats.calls, 2);
  wrapped.reset();
  assert.equal(wrapped.stats.calls, 0);
});
