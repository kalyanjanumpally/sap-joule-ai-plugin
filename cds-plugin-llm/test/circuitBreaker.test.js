const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_cb__';
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

const { circuitBreaker, CircuitOpenError } = require('../lib/middleware/circuitBreaker');

// Direct middleware invocation — avoids the full LLMService chain so
// tests are focused on breaker mechanics. ctx shape matches what
// _runMiddleware passes (service.name for perProvider bucketing).
function invoke(mw, { serviceName = 'llm', method = 'chat', shouldFail = false, err = null } = {}) {
  const ctx = { service: { name: serviceName }, method };
  const next = async () => {
    if (shouldFail) throw err ?? Object.assign(new Error('boom'), { status: 500 });
    return { text: 'ok' };
  };
  return mw(ctx, next);
}

// ---- Input validation --------------------------------------------------

test('circuitBreaker: rejects non-positive threshold', () => {
  assert.throws(() => circuitBreaker({ threshold: 0 }), /threshold/);
  assert.throws(() => circuitBreaker({ threshold: -1 }), /threshold/);
  assert.throws(() => circuitBreaker({ threshold: 1.5 }), /threshold/);
});

test('circuitBreaker: rejects negative cooldownMs', () => {
  assert.throws(() => circuitBreaker({ cooldownMs: -1 }), /cooldownMs/);
});

test('circuitBreaker: rejects non-positive halfOpenAttempts', () => {
  assert.throws(() => circuitBreaker({ halfOpenAttempts: 0 }), /halfOpenAttempts/);
});

// ---- Happy path (closed state) ----------------------------------------

test('circuitBreaker: successful calls stay closed', async () => {
  const cb = circuitBreaker({ threshold: 3 });
  await invoke(cb);
  await invoke(cb);
  const state = cb.state('llm');
  assert.equal(state.state, 'closed');
  assert.equal(state.consecutiveFailures, 0);
  assert.equal(cb.stats.successes, 2);
  assert.equal(cb.stats.opens, 0);
});

// ---- Threshold opening --------------------------------------------------

test('circuitBreaker: opens after threshold consecutive failures', async () => {
  const cb = circuitBreaker({ threshold: 3, cooldownMs: 1000 });
  for (let i = 0; i < 3; i++) {
    await invoke(cb, { shouldFail: true }).catch(() => {});
  }
  const state = cb.state('llm');
  assert.equal(state.state, 'open');
  assert.equal(state.consecutiveFailures, 3);
  assert.equal(cb.stats.opens, 1);
});

test('circuitBreaker: does NOT open on non-failure errors (4xx client errors)', async () => {
  const cb = circuitBreaker({ threshold: 2 });
  const err400 = Object.assign(new Error('bad request'), { status: 400 });
  for (let i = 0; i < 5; i++) {
    await invoke(cb, { shouldFail: true, err: err400 }).catch(() => {});
  }
  const state = cb.state('llm');
  assert.equal(state.state, 'closed');
  assert.equal(cb.stats.opens, 0);
});

test('circuitBreaker: 5xx counts as failure, 4xx does not', async () => {
  const cb = circuitBreaker({ threshold: 3 });
  const err500 = Object.assign(new Error('server error'), { status: 500 });
  const err400 = Object.assign(new Error('bad request'), { status: 400 });

  await invoke(cb, { shouldFail: true, err: err500 }).catch(() => {});
  await invoke(cb, { shouldFail: true, err: err400 }).catch(() => {});
  // 400 resets consecutive counter → next 500 restarts from 1
  await invoke(cb, { shouldFail: true, err: err500 }).catch(() => {});
  await invoke(cb, { shouldFail: true, err: err500 }).catch(() => {});
  const state = cb.state('llm');
  assert.equal(state.state, 'closed');
  assert.equal(state.consecutiveFailures, 2);
});

test('circuitBreaker: successful call resets consecutive failure count', async () => {
  const cb = circuitBreaker({ threshold: 3 });
  await invoke(cb, { shouldFail: true }).catch(() => {});
  await invoke(cb, { shouldFail: true }).catch(() => {});
  await invoke(cb); // success resets
  await invoke(cb, { shouldFail: true }).catch(() => {});
  const state = cb.state('llm');
  assert.equal(state.state, 'closed');
  assert.equal(state.consecutiveFailures, 1);
});

// ---- Short-circuit behavior --------------------------------------------

test('circuitBreaker: short-circuits with CircuitOpenError when open', async () => {
  const cb = circuitBreaker({ threshold: 2, cooldownMs: 10_000 });
  await invoke(cb, { shouldFail: true }).catch(() => {});
  await invoke(cb, { shouldFail: true }).catch(() => {});
  // Circuit is open now — next call must short-circuit
  await assert.rejects(() => invoke(cb), (err) => {
    assert.ok(err instanceof CircuitOpenError);
    assert.equal(err.code, 'CIRCUIT_OPEN');
    assert.equal(err.provider, 'llm');
    assert.ok(err.cooldownRemainingMs > 0);
    return true;
  });
  assert.equal(cb.stats.shortCircuited, 1);
});

// ---- Half-open probing --------------------------------------------------

test('circuitBreaker: transitions to half-open after cooldown', async () => {
  const cb = circuitBreaker({ threshold: 2, cooldownMs: 50, halfOpenAttempts: 1 });
  await invoke(cb, { shouldFail: true }).catch(() => {});
  await invoke(cb, { shouldFail: true }).catch(() => {});
  assert.equal(cb.state('llm').state, 'open');
  await new Promise((r) => setTimeout(r, 60));
  // Half-open probe succeeds → closes circuit
  await invoke(cb);
  assert.equal(cb.state('llm').state, 'closed');
  assert.equal(cb.stats.halfOpens, 1);
  assert.equal(cb.stats.closes, 1);
});

test('circuitBreaker: failed half-open probe re-opens the circuit', async () => {
  const cb = circuitBreaker({ threshold: 2, cooldownMs: 50, halfOpenAttempts: 1 });
  await invoke(cb, { shouldFail: true }).catch(() => {});
  await invoke(cb, { shouldFail: true }).catch(() => {});
  await new Promise((r) => setTimeout(r, 60));
  await invoke(cb, { shouldFail: true }).catch(() => {});
  const state = cb.state('llm');
  assert.equal(state.state, 'open');
  assert.equal(cb.stats.opens, 2);  // opened twice
});

// ---- Per-provider bucketing --------------------------------------------

test('circuitBreaker: perProvider=true isolates buckets by service name', async () => {
  const cb = circuitBreaker({ threshold: 2, cooldownMs: 10_000, perProvider: true });
  await invoke(cb, { serviceName: 'openai', shouldFail: true }).catch(() => {});
  await invoke(cb, { serviceName: 'openai', shouldFail: true }).catch(() => {});
  // openai is open now; anthropic should still be closed
  assert.equal(cb.state('openai').state, 'open');
  assert.equal(cb.state('anthropic').state, 'closed');
  // Anthropic call should succeed (not short-circuited)
  const res = await invoke(cb, { serviceName: 'anthropic' });
  assert.deepEqual(res, { text: 'ok' });
});

test('circuitBreaker: perProvider=false shares one global bucket', async () => {
  const cb = circuitBreaker({ threshold: 2, cooldownMs: 10_000, perProvider: false });
  await invoke(cb, { serviceName: 'openai', shouldFail: true }).catch(() => {});
  await invoke(cb, { serviceName: 'anthropic', shouldFail: true }).catch(() => {});
  // Both failures counted against the single bucket → open
  assert.equal(cb.state().state, 'open');
  await assert.rejects(() => invoke(cb, { serviceName: 'anthropic' }), CircuitOpenError);
});

// ---- Custom isFailure predicate ----------------------------------------

test('circuitBreaker: custom isFailure overrides default', async () => {
  const cb = circuitBreaker({
    threshold: 2,
    isFailure: (err) => err?.status === 429,   // Only rate-limits count
  });
  const err500 = Object.assign(new Error('boom'), { status: 500 });
  const err429 = Object.assign(new Error('rate'), { status: 429 });
  await invoke(cb, { shouldFail: true, err: err500 }).catch(() => {});
  await invoke(cb, { shouldFail: true, err: err500 }).catch(() => {});
  assert.equal(cb.state('llm').state, 'closed');   // 500s don't count
  await invoke(cb, { shouldFail: true, err: err429 }).catch(() => {});
  await invoke(cb, { shouldFail: true, err: err429 }).catch(() => {});
  assert.equal(cb.state('llm').state, 'open');
});

// ---- Event callbacks ----------------------------------------------------

test('circuitBreaker: onOpen callback fires when circuit opens', async () => {
  const events = [];
  const cb = circuitBreaker({
    threshold: 2,
    onOpen: (info) => events.push({ event: 'open', ...info }),
  });
  await invoke(cb, { shouldFail: true }).catch(() => {});
  await invoke(cb, { shouldFail: true }).catch(() => {});
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'open');
  assert.equal(events[0].provider, 'llm');
  assert.equal(events[0].consecutiveFailures, 2);
});

test('circuitBreaker: onClose callback fires when half-open probe succeeds', async () => {
  const events = [];
  const cb = circuitBreaker({
    threshold: 2, cooldownMs: 50,
    onClose: (info) => events.push({ event: 'close', ...info }),
  });
  await invoke(cb, { shouldFail: true }).catch(() => {});
  await invoke(cb, { shouldFail: true }).catch(() => {});
  await new Promise((r) => setTimeout(r, 60));
  await invoke(cb);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'close');
  assert.equal(events[0].provider, 'llm');
});

test('circuitBreaker: onHalfOpen callback fires on cooldown expiration', async () => {
  const events = [];
  const cb = circuitBreaker({
    threshold: 2, cooldownMs: 50,
    onHalfOpen: (info) => events.push({ event: 'halfOpen', ...info }),
  });
  await invoke(cb, { shouldFail: true }).catch(() => {});
  await invoke(cb, { shouldFail: true }).catch(() => {});
  await new Promise((r) => setTimeout(r, 60));
  await invoke(cb);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'halfOpen');
});

// ---- Force controls ----------------------------------------------------

test('circuitBreaker: forceOpen manually opens the circuit', async () => {
  const cb = circuitBreaker({ threshold: 5, cooldownMs: 10_000 });
  cb.forceOpen('llm');
  await assert.rejects(() => invoke(cb), CircuitOpenError);
});

test('circuitBreaker: forceClose manually closes the circuit', async () => {
  const cb = circuitBreaker({ threshold: 2, cooldownMs: 10_000 });
  await invoke(cb, { shouldFail: true }).catch(() => {});
  await invoke(cb, { shouldFail: true }).catch(() => {});
  assert.equal(cb.state('llm').state, 'open');
  cb.forceClose('llm');
  // Should now allow calls through
  const res = await invoke(cb);
  assert.deepEqual(res, { text: 'ok' });
});

test('circuitBreaker: reset() clears all buckets + stats', async () => {
  const cb = circuitBreaker({ threshold: 2 });
  await invoke(cb, { shouldFail: true }).catch(() => {});
  await invoke(cb, { shouldFail: true }).catch(() => {});
  assert.equal(cb.stats.opens, 1);
  cb.reset();
  assert.equal(cb.stats.opens, 0);
  assert.equal(cb.state('llm').state, 'closed');
});

test('circuitBreaker: reset(provider) clears just that bucket', async () => {
  const cb = circuitBreaker({ threshold: 2 });
  await invoke(cb, { serviceName: 'openai', shouldFail: true }).catch(() => {});
  await invoke(cb, { serviceName: 'openai', shouldFail: true }).catch(() => {});
  await invoke(cb, { serviceName: 'anthropic', shouldFail: true }).catch(() => {});
  cb.reset('openai');
  assert.equal(cb.state('openai').state, 'closed');
  assert.equal(cb.state('anthropic').consecutiveFailures, 1);
});

// ---- MCP resource ------------------------------------------------------

test('circuitBreaker: asMcpResource() returns config://circuit-breaker snapshot', async () => {
  const cb = circuitBreaker({ threshold: 3, cooldownMs: 5000 });
  await invoke(cb, { serviceName: 'openai', shouldFail: true }).catch(() => {});
  const res = cb.asMcpResource();
  assert.equal(res.uri, 'config://circuit-breaker');
  assert.equal(res.mimeType, 'application/json');
  const snap = res.handler();
  assert.equal(snap.threshold, 3);
  assert.equal(snap.cooldownMs, 5000);
  assert.equal(snap.buckets.openai.consecutiveFailures, 1);
  assert.equal(snap.buckets.openai.state, 'closed');
});

// ---- Cooldown remaining exposure --------------------------------------

test('circuitBreaker: state() exposes cooldownRemainingMs while open', async () => {
  const cb = circuitBreaker({ threshold: 1, cooldownMs: 1000 });
  await invoke(cb, { shouldFail: true }).catch(() => {});
  const state = cb.state('llm');
  assert.equal(state.state, 'open');
  assert.ok(state.cooldownRemainingMs > 0);
  assert.ok(state.cooldownRemainingMs <= 1000);
});
