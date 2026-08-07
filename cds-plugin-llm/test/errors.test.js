const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_err__';
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

const { LLMError, errorRegistry, isLLMError } = require('../lib/errors');

// Import every public error class to verify each extends LLMError
const { CircuitOpenError }       = require('../lib/middleware/circuitBreaker');
const { BulkheadFullError, BulkheadTimeoutError } = require('../lib/middleware/bulkhead');
const { DeadlineExceededError }  = require('../lib/middleware/deadline');
const { RateLimitGiveUpError }   = require('../lib/middleware/retryOnRateLimit');
const { CostGuardBlockedError }  = require('../lib/middleware/costGuard');
const { AllProvidersFailedError } = require('../lib/chatWithFallback');
const { BudgetExceededError }    = require('../lib/middleware/costBudget');
const { GuardrailBlockedError }  = require('../lib/middleware/guardrails');
const { PromptInjectionError }   = require('../lib/middleware/promptInjectionGuard');

// ---- Base class -------------------------------------------------------

test('LLMError: constructs with message + code, populates metadata from registry', () => {
  const e = new LLMError('boom', 'CIRCUIT_OPEN');
  assert.equal(e.message, 'boom');
  assert.equal(e.code, 'CIRCUIT_OPEN');
  assert.equal(e.primitive, 'circuitBreaker');
  assert.equal(e.retriable, true);
  assert.equal(e.httpStatus, 503);
  assert.equal(e.severity, 'error');
});

test('LLMError: unknown code gets fallback metadata', () => {
  const e = new LLMError('boom', 'MADE_UP_CODE');
  assert.equal(e.primitive, 'unknown');
  assert.equal(e.retriable, false);
  assert.equal(e.httpStatus, 500);
  assert.equal(e.severity, 'error');
});

test('LLMError: name preserves subclass identity', () => {
  class MyLLMError extends LLMError {
    constructor() { super('x', 'DEADLINE_EXCEEDED'); }
  }
  const e = new MyLLMError();
  assert.equal(e.name, 'MyLLMError');
});

test('isLLMError: distinguishes LLMError instances from native Error', () => {
  const custom = new LLMError('x', 'BULKHEAD_FULL');
  const native = new Error('x');
  const typeErr = new TypeError('x');
  assert.equal(isLLMError(custom), true);
  assert.equal(isLLMError(native), false);
  assert.equal(isLLMError(typeErr), false);
  assert.equal(isLLMError(null), false);
  assert.equal(isLLMError(undefined), false);
});

// ---- Every public subclass extends LLMError ---------------------------

test('every public error class inherits from LLMError', () => {
  const instances = [
    new CircuitOpenError('openai', 30_000, new Error('root')),
    new BulkheadFullError('openai', 50),
    new BulkheadTimeoutError('openai', 5000),
    new DeadlineExceededError(30_000, 'chat'),
    new RateLimitGiveUpError(new Error('429'), [{ attempt: 1, waitMs: 100, status: 429, error: '429' }]),
    new CostGuardBlockedError(0.50, 0.10, 'gpt-4o'),
    new AllProvidersFailedError(new Error('boom'), [{ service: 'openai', ok: false }]),
    new BudgetExceededError('total', 'total', 100, 50, 'USD'),
    new GuardrailBlockedError('pii filter matched', { filterIndex: 0 }),
    new PromptInjectionError(0.9, ['ignore previous instructions']),
  ];
  for (const inst of instances) {
    assert.ok(inst instanceof LLMError, `${inst.name} should extend LLMError`);
    assert.ok(inst instanceof Error, `${inst.name} should still be Error`);
    assert.ok(typeof inst.code === 'string' && inst.code.length > 0, `${inst.name}: code is a non-empty string`);
    assert.ok(typeof inst.primitive === 'string', `${inst.name}: primitive is a string`);
    assert.ok(typeof inst.retriable === 'boolean', `${inst.name}: retriable is a boolean`);
    assert.ok(Number.isInteger(inst.httpStatus), `${inst.name}: httpStatus is an integer`);
  }
});

test('each subclass preserves its own .name (for toString / instanceof serialization)', () => {
  assert.equal(new CircuitOpenError('a', 0, new Error()).name,   'CircuitOpenError');
  assert.equal(new BulkheadFullError('a', 0).name,               'BulkheadFullError');
  assert.equal(new BulkheadTimeoutError('a', 0).name,            'BulkheadTimeoutError');
  assert.equal(new DeadlineExceededError(1, 'chat').name,        'DeadlineExceededError');
  assert.equal(new RateLimitGiveUpError(new Error(), []).name,   'RateLimitGiveUpError');
  assert.equal(new CostGuardBlockedError(0, 0, 'x').name,        'CostGuardBlockedError');
  assert.equal(new AllProvidersFailedError(new Error(), []).name,'AllProvidersFailedError');
  assert.equal(new BudgetExceededError('a', 'a', 0, 0, 'USD').name,   'BudgetExceededError');
  assert.equal(new GuardrailBlockedError('x').name,              'GuardrailBlockedError');
  assert.equal(new PromptInjectionError(0.5, ['a']).name,        'PromptInjectionError');
});

// ---- errorRegistry shape ---------------------------------------------

test('errorRegistry: entries for all 10 shipped codes', () => {
  const expectedCodes = [
    'RATE_LIMIT_GIVE_UP',
    'CIRCUIT_OPEN',
    'BULKHEAD_FULL',
    'BULKHEAD_TIMEOUT',
    'DEADLINE_EXCEEDED',
    'ALL_PROVIDERS_FAILED',
    'COST_GUARD_BLOCKED',
    'BUDGET_EXCEEDED',
    'PROMPT_INJECTION',
    'GUARDRAIL_BLOCKED',
  ];
  for (const code of expectedCodes) {
    assert.ok(errorRegistry[code], `expected registry entry for ${code}`);
    const meta = errorRegistry[code];
    assert.ok(typeof meta.primitive  === 'string',  `${code}: primitive missing`);
    assert.ok(typeof meta.retriable  === 'boolean', `${code}: retriable missing`);
    assert.ok(Number.isInteger(meta.httpStatus),    `${code}: httpStatus missing`);
    assert.ok(['error', 'warning'].includes(meta.severity), `${code}: valid severity`);
  }
});

test('errorRegistry: retriability matches the semantics we document', () => {
  // Retriable: caller can safely try again
  assert.equal(errorRegistry.CIRCUIT_OPEN.retriable,     true);  // after cooldown
  assert.equal(errorRegistry.BULKHEAD_FULL.retriable,    true);
  assert.equal(errorRegistry.BULKHEAD_TIMEOUT.retriable, true);
  // Non-retriable: same request will always fail
  assert.equal(errorRegistry.DEADLINE_EXCEEDED.retriable,   false);
  assert.equal(errorRegistry.COST_GUARD_BLOCKED.retriable,  false);
  assert.equal(errorRegistry.BUDGET_EXCEEDED.retriable,     false);
  assert.equal(errorRegistry.PROMPT_INJECTION.retriable,    false);
  assert.equal(errorRegistry.GUARDRAIL_BLOCKED.retriable,   false);
  assert.equal(errorRegistry.RATE_LIMIT_GIVE_UP.retriable,  false);
  assert.equal(errorRegistry.ALL_PROVIDERS_FAILED.retriable, false);
});

test('errorRegistry: HTTP status codes match semantic meaning', () => {
  assert.equal(errorRegistry.CIRCUIT_OPEN.httpStatus,      503);   // Service Unavailable
  assert.equal(errorRegistry.BULKHEAD_FULL.httpStatus,     429);   // Too Many Requests
  assert.equal(errorRegistry.BULKHEAD_TIMEOUT.httpStatus,  429);
  assert.equal(errorRegistry.DEADLINE_EXCEEDED.httpStatus, 504);   // Gateway Timeout
  assert.equal(errorRegistry.RATE_LIMIT_GIVE_UP.httpStatus, 429);
  assert.equal(errorRegistry.COST_GUARD_BLOCKED.httpStatus, 402);  // Payment Required
  assert.equal(errorRegistry.BUDGET_EXCEEDED.httpStatus,    402);
  assert.equal(errorRegistry.PROMPT_INJECTION.httpStatus,   400);  // Bad Request (user input)
  assert.equal(errorRegistry.GUARDRAIL_BLOCKED.httpStatus,  400);
  assert.equal(errorRegistry.ALL_PROVIDERS_FAILED.httpStatus, 502); // Bad Gateway
});

// ---- Consumer usage patterns ------------------------------------------

test('consumer: switch on err.code for HTTP status mapping', () => {
  const err = new CircuitOpenError('openai', 30_000, new Error('root'));
  // Simulated Express error handler
  let status;
  if (err instanceof LLMError) {
    status = err.httpStatus;
  } else {
    status = 500;
  }
  assert.equal(status, 503);
});

test('consumer: filter for retriable errors in a broad catch', () => {
  const errors = [
    new CircuitOpenError('a', 0, new Error()),
    new BulkheadFullError('a', 0),
    new DeadlineExceededError(1, 'chat'),
    new PromptInjectionError(0.9, ['x']),
  ];
  const retriable = errors.filter(e => e.retriable);
  const nonRetriable = errors.filter(e => !e.retriable);
  assert.equal(retriable.length, 2);   // Circuit + Bulkhead
  assert.equal(nonRetriable.length, 2); // Deadline + Injection
});

test('consumer: catch by primitive family', () => {
  const err = new BulkheadTimeoutError('openai', 5000);
  assert.equal(err.primitive, 'bulkhead');
  // Reduce noisy alerting: only alert on error-severity events
  assert.equal(err.severity, 'warning');
});
