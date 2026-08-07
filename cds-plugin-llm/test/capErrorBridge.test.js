const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_ceb__';
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

const { toCapError, withCapHandler } = require('../lib/capErrorBridge');
const { LLMError } = require('../lib/errors');
const { CircuitOpenError } = require('../lib/middleware/circuitBreaker');
const { BulkheadFullError } = require('../lib/middleware/bulkhead');
const { CostGuardBlockedError } = require('../lib/middleware/costGuard');
const { PromptInjectionError } = require('../lib/middleware/promptInjectionGuard');

// Fake req that captures reject() calls
function fakeReq() {
  const calls = { reject: [], error: [] };
  return {
    calls,
    reject: (status, message, details) => {
      calls.reject.push({ status, message, details });
      return undefined;
    },
    error: (payload) => {
      calls.error.push(payload);
    },
  };
}

// ---- toCapError: LLMError → req.reject() ------------------------------

test('toCapError: CircuitOpenError → req.reject(503, ...) with structured details', () => {
  const req = fakeReq();
  const err = new CircuitOpenError('openai', 25_000, new Error('root'));
  toCapError(err, req);
  assert.equal(req.calls.reject.length, 1);
  const { status, message, details } = req.calls.reject[0];
  assert.equal(status, 503);
  assert.match(message, /circuit is OPEN/);
  assert.equal(details.code, 'CIRCUIT_OPEN');
  assert.equal(details.primitive, 'circuitBreaker');
  assert.equal(details.retriable, true);
  assert.equal(details.severity, 'error');
  assert.equal(details['@Common.numericSeverity'], 4);
  assert.equal(details.provider, 'openai');
  assert.equal(details.cooldownRemainingMs, 25_000);
});

test('toCapError: BulkheadFullError → req.reject(429, ...) with maxQueued detail', () => {
  const req = fakeReq();
  const err = new BulkheadFullError('openai', 50);
  toCapError(err, req);
  const { status, details } = req.calls.reject[0];
  assert.equal(status, 429);
  assert.equal(details.code, 'BULKHEAD_FULL');
  assert.equal(details.retriable, true);
  assert.equal(details.provider, 'openai');
  assert.equal(details.maxQueued, 50);
});

test('toCapError: CostGuardBlockedError → req.reject(402, ...) with $ details', () => {
  const req = fakeReq();
  const err = new CostGuardBlockedError(0.50, 0.10, 'gpt-4o');
  toCapError(err, req);
  const { status, details } = req.calls.reject[0];
  assert.equal(status, 402);
  assert.equal(details.code, 'COST_GUARD_BLOCKED');
  assert.equal(details.retriable, false);
  assert.equal(details.estimatedUsd, 0.50);
  assert.equal(details.limitUsd, 0.10);
  assert.equal(details.model, 'gpt-4o');
});

test('toCapError: PromptInjectionError → req.reject(400, ...) with evidence array', () => {
  const req = fakeReq();
  const err = new PromptInjectionError(0.87, ['ignore previous', 'zero-width chars']);
  toCapError(err, req);
  const { status, details } = req.calls.reject[0];
  assert.equal(status, 400);
  assert.equal(details.code, 'PROMPT_INJECTION');
  assert.deepEqual(details.evidence, ['ignore previous', 'zero-width chars']);
});

// ---- Non-LLMError path ------------------------------------------------

test('toCapError: non-LLMError re-thrown (not swallowed)', () => {
  const req = fakeReq();
  const err = new Error('random');
  assert.throws(() => toCapError(err, req), /random/);
  assert.equal(req.calls.reject.length, 0);
});

test('toCapError: TypeError re-thrown', () => {
  const req = fakeReq();
  assert.throws(() => toCapError(new TypeError('boom'), req), TypeError);
  assert.equal(req.calls.reject.length, 0);
});

// ---- Fallback paths ---------------------------------------------------

test('toCapError: falls back to req.error() when req.reject is missing', () => {
  const req = { error: (p) => { req.captured = p; } };
  const err = new CircuitOpenError('openai', 25_000, new Error('root'));
  toCapError(err, req);
  assert.ok(req.captured);
  assert.equal(req.captured.code, 'CIRCUIT_OPEN');
});

test('toCapError: throws Error with .status when no req helpers present', () => {
  const err = new CircuitOpenError('openai', 25_000, new Error('root'));
  assert.throws(() => toCapError(err, {}), (thrown) => {
    assert.ok(thrown instanceof Error);
    assert.equal(thrown.status, 503);
    assert.equal(thrown.code, 'CIRCUIT_OPEN');
    assert.ok(thrown.llmError);
    return true;
  });
});

test('toCapError: throws Error with .status when no req at all', () => {
  const err = new CircuitOpenError('openai', 25_000, new Error('root'));
  assert.throws(() => toCapError(err), (thrown) => {
    assert.equal(thrown.status, 503);
    return true;
  });
});

// ---- Options: mask + severity ----------------------------------------

test('toCapError: mask strips fields from details', () => {
  const req = fakeReq();
  const err = new CircuitOpenError('openai', 25_000, new Error());
  toCapError(err, req, { mask: ['cooldownRemainingMs'] });
  assert.equal(req.calls.reject[0].details.cooldownRemainingMs, undefined);
  assert.equal(req.calls.reject[0].details.provider, 'openai');
});

test('toCapError: mask must be an array', () => {
  const req = fakeReq();
  const err = new CircuitOpenError('a', 0, new Error());
  assert.throws(() => toCapError(err, req, { mask: 'not-array' }), /mask must be an array/);
});

test('toCapError: severity option sets OData Common.numericSeverity', () => {
  const req = fakeReq();
  const err = new BulkheadFullError('a', 50);
  toCapError(err, req, { severity: 2 });   // warning
  assert.equal(req.calls.reject[0].details['@Common.numericSeverity'], 2);
});

// ---- withCapHandler decorator ----------------------------------------

test('withCapHandler: success → passes result through unchanged', async () => {
  const wrapped = withCapHandler(async (req) => {
    return { answer: 'success', req };
  });
  const req = fakeReq();
  const result = await wrapped.call({}, req);
  assert.equal(result.answer, 'success');
  assert.equal(req.calls.reject.length, 0);
});

test('withCapHandler: LLMError → converted to req.reject()', async () => {
  const wrapped = withCapHandler(async () => {
    throw new CircuitOpenError('openai', 5000, new Error());
  });
  const req = fakeReq();
  await wrapped.call({}, req);
  assert.equal(req.calls.reject.length, 1);
  assert.equal(req.calls.reject[0].status, 503);
});

test('withCapHandler: non-LLMError re-thrown (not swallowed)', async () => {
  const wrapped = withCapHandler(async () => {
    throw new Error('random');
  });
  const req = fakeReq();
  await assert.rejects(wrapped.call({}, req), /random/);
  assert.equal(req.calls.reject.length, 0);
});

test('withCapHandler: forwards `this` binding', async () => {
  const wrapped = withCapHandler(async function (req) {
    return { ownField: this.ownField };
  });
  const req = fakeReq();
  const context = { ownField: 'from-service' };
  const result = await wrapped.call(context, req);
  assert.equal(result.ownField, 'from-service');
});

test('withCapHandler: forwards additional args', async () => {
  const wrapped = withCapHandler(async (req, ...args) => ({ args }));
  const req = fakeReq();
  const result = await wrapped(req, 'a', 'b', 42);
  assert.deepEqual(result.args, ['a', 'b', 42]);
});

test('withCapHandler: throws when handler is not a function', () => {
  assert.throws(() => withCapHandler('not fn'), /handler must be a function/);
});

test('withCapHandler: options passed to toCapError (mask/severity)', async () => {
  const wrapped = withCapHandler(async () => {
    throw new CircuitOpenError('openai', 5000, new Error());
  }, { mask: ['cooldownRemainingMs'], severity: 2 });
  const req = fakeReq();
  await wrapped.call({}, req);
  const details = req.calls.reject[0].details;
  assert.equal(details.cooldownRemainingMs, undefined);
  assert.equal(details['@Common.numericSeverity'], 2);
});

// ---- Cause / stack are excluded from details ------------------------

test('toCapError: base LLMError fields excluded from details (they surface as top-level)', () => {
  const req = fakeReq();
  const rootCause = new Error('root');
  const err = new CircuitOpenError('openai', 25_000, rootCause);
  toCapError(err, req);
  const details = req.calls.reject[0].details;
  // These base fields ARE included (as top-level), but should not appear in
  // details as duplicates from getOwnPropertyNames
  assert.equal(details.stack, undefined);
  assert.equal(details.cause, undefined);
  assert.equal(details.name, undefined);
  assert.equal(details.httpStatus, undefined);
});

// ---- Error-shaped values are flattened -------------------------------

test('toCapError: Error-shaped subclass field is flattened to { message, name, code }', () => {
  const req = fakeReq();
  // BulkheadFullError doesn't carry an Error-shaped field, but let's use a
  // synthetic subclass to verify the flattening behavior
  class SyntheticError extends LLMError {
    constructor() {
      super('synthetic', 'CIRCUIT_OPEN');
      this.nested = new TypeError('nested-boom');
      this.nested.code = 'INNER_CODE';
    }
  }
  toCapError(new SyntheticError(), req);
  const details = req.calls.reject[0].details;
  assert.deepEqual(details.nested, { message: 'nested-boom', name: 'TypeError', code: 'INNER_CODE' });
});
