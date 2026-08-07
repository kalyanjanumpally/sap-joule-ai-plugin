const { test } = require('node:test');
const assert = require('node:assert/strict');

// This module has zero runtime deps on @sap/cds, no need for the stub shim.
const {
  validateMiddlewareOrder,
  filterWarnings,
  KNOWN_KINDS,
} = require('../lib/validateMiddlewareOrder');

// ---- Input validation --------------------------------------------------

test('validateMiddlewareOrder: throws on non-array input', () => {
  assert.throws(() => validateMiddlewareOrder('not an array'), /must be an array/);
  assert.throws(() => validateMiddlewareOrder(null), /must be an array/);
});

test('validateMiddlewareOrder: empty chain → still returns ok=true (just missing-primitive info)', () => {
  const r = validateMiddlewareOrder([]);
  assert.equal(r.ok, true);
  // Empty chain still triggers NO_RETRY / NO_METERING / NO_SECURITY_LAYER info warnings
  assert.ok(r.warnings.length > 0);
  assert.ok(r.warnings.every((w) => w.severity === 'info'));
});

// ---- The canonical demo-app chain PASSES cleanly ----------------------

test('validateMiddlewareOrder: canonical ai-service.js order produces zero warnings/errors', () => {
  const r = validateMiddlewareOrder([
    { kind: 'deadline' },
    { kind: 'promptInjectionGuard' },
    { kind: 'guardrails' },
    { kind: 'costBudget' },
    { kind: 'circuitBreaker' },
    { kind: 'bulkhead' },
    { kind: 'retryOnRateLimit' },
    { kind: 'usageMeteringToCap' },
    { kind: 'responseCache' },
  ]);
  assert.equal(r.ok, true);
  const nonInfo = r.warnings.filter((w) => w.severity !== 'info');
  assert.deepEqual(nonInfo, [], 'canonical chain should not fire any warning-severity findings');
  assert.equal(r.warnings.find((w) => w.code === 'CACHE_OUTER_OF_BUDGET'), undefined);
  assert.equal(r.warnings.find((w) => w.code === 'NO_CIRCUIT_BREAKER'), undefined);
  assert.equal(r.warnings.find((w) => w.code === 'NO_BULKHEAD'), undefined);
  assert.equal(r.warnings.find((w) => w.code === 'NO_DEADLINE'), undefined);
});

// ---- Deadline rules ---------------------------------------------------

test('validateMiddlewareOrder: DEADLINE_INNER_OF_RETRY fires when deadline follows retry', () => {
  const r = validateMiddlewareOrder([
    { kind: 'retryOnRateLimit' },
    { kind: 'deadline' },
  ]);
  const w = r.warnings.find((x) => x.code === 'DEADLINE_INNER_OF_RETRY');
  assert.ok(w);
  assert.equal(w.severity, 'warning');
  assert.match(w.message, /each retry gets a fresh deadline/);
});

test('validateMiddlewareOrder: deadline OUTER of retry does NOT fire DEADLINE_INNER_OF_RETRY', () => {
  const r = validateMiddlewareOrder([
    { kind: 'deadline' },
    { kind: 'retryOnRateLimit' },
  ]);
  assert.equal(r.warnings.find((x) => x.code === 'DEADLINE_INNER_OF_RETRY'), undefined);
});

test('validateMiddlewareOrder: NO_DEADLINE info fires when no deadline present', () => {
  const r = validateMiddlewareOrder([{ kind: 'retryOnRateLimit' }]);
  const w = r.warnings.find((x) => x.code === 'NO_DEADLINE');
  assert.ok(w);
  assert.equal(w.severity, 'info');
});

// ---- Bulkhead rules ---------------------------------------------------

test('validateMiddlewareOrder: BULKHEAD_OUTER_OF_BREAKER fires when bulkhead precedes breaker', () => {
  const r = validateMiddlewareOrder([
    { kind: 'bulkhead' },
    { kind: 'circuitBreaker' },
  ]);
  const w = r.warnings.find((x) => x.code === 'BULKHEAD_OUTER_OF_BREAKER');
  assert.ok(w);
  assert.equal(w.severity, 'warning');
  assert.match(w.message, /still acquire a bulkhead slot/);
});

test('validateMiddlewareOrder: bulkhead INNER of breaker does NOT fire BULKHEAD_OUTER_OF_BREAKER', () => {
  const r = validateMiddlewareOrder([
    { kind: 'circuitBreaker' },
    { kind: 'bulkhead' },
  ]);
  assert.equal(r.warnings.find((x) => x.code === 'BULKHEAD_OUTER_OF_BREAKER'), undefined);
});

test('validateMiddlewareOrder: NO_BULKHEAD info fires when no bulkhead present', () => {
  const r = validateMiddlewareOrder([{ kind: 'retryOnRateLimit' }]);
  const w = r.warnings.find((x) => x.code === 'NO_BULKHEAD');
  assert.ok(w);
  assert.equal(w.severity, 'info');
});

// ---- Circuit breaker rules --------------------------------------------

test('validateMiddlewareOrder: BREAKER_INNER_OF_RETRY fires when breaker follows retry', () => {
  const r = validateMiddlewareOrder([
    { kind: 'retryOnRateLimit' },
    { kind: 'circuitBreaker' },
  ]);
  const w = r.warnings.find((x) => x.code === 'BREAKER_INNER_OF_RETRY');
  assert.ok(w);
  assert.equal(w.severity, 'warning');
  assert.match(w.message, /burning retry budget|short-circuit/);
});

test('validateMiddlewareOrder: breaker OUTER of retry does NOT fire BREAKER_INNER_OF_RETRY', () => {
  const r = validateMiddlewareOrder([
    { kind: 'circuitBreaker' },
    { kind: 'retryOnRateLimit' },
  ]);
  assert.equal(r.warnings.find((x) => x.code === 'BREAKER_INNER_OF_RETRY'), undefined);
});

test('validateMiddlewareOrder: NO_CIRCUIT_BREAKER info fires when no circuitBreaker', () => {
  const r = validateMiddlewareOrder([{ kind: 'retryOnRateLimit' }]);
  const w = r.warnings.find((x) => x.code === 'NO_CIRCUIT_BREAKER');
  assert.ok(w);
  assert.equal(w.severity, 'info');
});

// ---- Specific bad orderings -------------------------------------------

test('validateMiddlewareOrder: CACHE_OUTER_OF_METERING info fires when cache precedes metering (hits skip metering)', () => {
  const r = validateMiddlewareOrder([
    { kind: 'responseCache' },
    { kind: 'usageMetering' },
  ]);
  const w = r.warnings.find((x) => x.code === 'CACHE_OUTER_OF_METERING');
  assert.ok(w, 'expected CACHE_OUTER_OF_METERING info');
  assert.equal(w.severity, 'info');
  assert.match(w.message, /skip the metering counter/);
});

test('validateMiddlewareOrder: CACHE_OUTER_OF_METERING info fires for usageMeteringToCap variant too', () => {
  const r = validateMiddlewareOrder([
    { kind: 'responseCache' },
    { kind: 'usageMeteringToCap' },
  ]);
  assert.ok(r.warnings.find((x) => x.code === 'CACHE_OUTER_OF_METERING'));
});

test('validateMiddlewareOrder: metering OUTER of cache does NOT fire CACHE_OUTER_OF_METERING (canonical pattern)', () => {
  const r = validateMiddlewareOrder([
    { kind: 'usageMetering' },
    { kind: 'responseCache' },
  ]);
  assert.equal(r.warnings.find((x) => x.code === 'CACHE_OUTER_OF_METERING'), undefined);
});

test('validateMiddlewareOrder: BUDGET_INNER_OF_RETRY fires when budget follows retry', () => {
  const r = validateMiddlewareOrder([
    { kind: 'retryOnRateLimit' },
    { kind: 'costBudget' },
  ]);
  const w = r.warnings.find((x) => x.code === 'BUDGET_INNER_OF_RETRY');
  assert.ok(w);
  assert.equal(w.severity, 'warning');
  assert.match(w.message, /burn through retries/);
});

test('validateMiddlewareOrder: INJECTION_INNER_OF_GUARDRAILS fires when injection follows guardrails', () => {
  const r = validateMiddlewareOrder([
    { kind: 'guardrails' },
    { kind: 'promptInjectionGuard' },
  ]);
  const w = r.warnings.find((x) => x.code === 'INJECTION_INNER_OF_GUARDRAILS');
  assert.ok(w);
  assert.equal(w.severity, 'warning');
  assert.match(w.message, /homoglyph|zero-width/);
});

test('validateMiddlewareOrder: CACHE_OUTER_OF_BUDGET is info-severity (sometimes intentional)', () => {
  const r = validateMiddlewareOrder([
    { kind: 'responseCache' },
    { kind: 'costBudget' },
  ]);
  const w = r.warnings.find((x) => x.code === 'CACHE_OUTER_OF_BUDGET');
  assert.ok(w);
  assert.equal(w.severity, 'info');
});

// ---- Missing-primitive advisories -------------------------------------

test('validateMiddlewareOrder: NO_RETRY info fires when no retryOnRateLimit', () => {
  const r = validateMiddlewareOrder([{ kind: 'usageMetering' }]);
  const w = r.warnings.find((x) => x.code === 'NO_RETRY');
  assert.ok(w);
  assert.equal(w.severity, 'info');
});

test('validateMiddlewareOrder: NO_METERING info fires when neither metering variant present', () => {
  const r = validateMiddlewareOrder([{ kind: 'responseCache' }]);
  assert.ok(r.warnings.find((x) => x.code === 'NO_METERING'));
});

test('validateMiddlewareOrder: NO_SECURITY_LAYER info fires when neither guardrails nor injection', () => {
  const r = validateMiddlewareOrder([
    { kind: 'costBudget' },
    { kind: 'usageMetering' },
  ]);
  assert.ok(r.warnings.find((x) => x.code === 'NO_SECURITY_LAYER'));
});

test('validateMiddlewareOrder: NO_SECURITY_LAYER does NOT fire when injection guard alone is present', () => {
  const r = validateMiddlewareOrder([
    { kind: 'promptInjectionGuard' },
    { kind: 'usageMetering' },
  ]);
  assert.equal(r.warnings.find((x) => x.code === 'NO_SECURITY_LAYER'), undefined);
});

// ---- Duplicate + unknown detection -----------------------------------

test('validateMiddlewareOrder: DUPLICATE_KIND fires on repeated middleware', () => {
  const r = validateMiddlewareOrder([
    { kind: 'costBudget' },
    { kind: 'usageMetering' },
    { kind: 'costBudget' },  // duplicate
  ]);
  const w = r.warnings.find((x) => x.code === 'DUPLICATE_KIND');
  assert.ok(w);
  assert.equal(w.severity, 'warning');
  assert.match(w.message, /costBudget.*positions 0 AND 2/);
});

test('validateMiddlewareOrder: UNKNOWN_KIND fires on third-party middleware', () => {
  const r = validateMiddlewareOrder([{ kind: 'myCustomAuditor' }]);
  const w = r.warnings.find((x) => x.code === 'UNKNOWN_KIND');
  assert.ok(w);
  assert.equal(w.severity, 'info');
});

test('validateMiddlewareOrder: KNOWN_KINDS covers exactly the shipped middleware', () => {
  const expected = new Set([
    'promptInjectionGuard',
    'guardrails',
    'costBudget',
    'costGuard',
    'retryOnRateLimit',
    'circuitBreaker',
    'bulkhead',
    'deadline',
    'usageMetering',
    'usageMeteringToCap',
    'responseCache',
  ]);
  assert.deepEqual([...KNOWN_KINDS].sort(), [...expected].sort());
});

// ---- Cost guard rules -------------------------------------------------

test('validateMiddlewareOrder: COST_GUARD_OUTER_OF_GUARDRAILS fires when costGuard precedes guardrails', () => {
  const r = validateMiddlewareOrder([
    { kind: 'costGuard' },
    { kind: 'guardrails' },
  ]);
  const w = r.warnings.find((x) => x.code === 'COST_GUARD_OUTER_OF_GUARDRAILS');
  assert.ok(w);
  assert.equal(w.severity, 'warning');
  assert.match(w.message, /inflating the ceiling check/);
});

test('validateMiddlewareOrder: costGuard INNER of guardrails does NOT fire COST_GUARD_OUTER_OF_GUARDRAILS', () => {
  const r = validateMiddlewareOrder([
    { kind: 'guardrails' },
    { kind: 'costGuard' },
  ]);
  assert.equal(r.warnings.find((x) => x.code === 'COST_GUARD_OUTER_OF_GUARDRAILS'), undefined);
});

test('validateMiddlewareOrder: canonical chain with costGuard produces zero non-info warnings', () => {
  const r = validateMiddlewareOrder([
    { kind: 'deadline' },
    { kind: 'promptInjectionGuard' },
    { kind: 'guardrails' },
    { kind: 'costGuard' },
    { kind: 'costBudget' },
    { kind: 'circuitBreaker' },
    { kind: 'bulkhead' },
    { kind: 'retryOnRateLimit' },
    { kind: 'usageMeteringToCap' },
    { kind: 'responseCache' },
  ]);
  const nonInfo = r.warnings.filter((w) => w.severity !== 'info');
  assert.deepEqual(nonInfo, []);
});

// ---- Result shape ------------------------------------------------------

test('validateMiddlewareOrder: warning objects all carry code + severity + message + fixit + involved', () => {
  const r = validateMiddlewareOrder([
    { kind: 'usageMetering' },
    { kind: 'responseCache' },
  ]);
  for (const w of r.warnings) {
    assert.ok(typeof w.code === 'string');
    assert.ok(['error', 'warning', 'info'].includes(w.severity));
    assert.ok(typeof w.message === 'string' && w.message.length > 0);
    assert.ok(typeof w.fixit === 'string' && w.fixit.length > 0);
    assert.ok(Array.isArray(w.involved));
  }
});

// ---- filterWarnings ---------------------------------------------------

test('filterWarnings: drops specified codes', () => {
  const r = validateMiddlewareOrder([
    { kind: 'usageMetering' },
    { kind: 'responseCache' },
  ]);
  const filtered = filterWarnings(r, ['CACHE_OUTER_OF_METERING', 'NO_RETRY', 'NO_SECURITY_LAYER']);
  assert.equal(filtered.warnings.find((w) => w.code === 'CACHE_OUTER_OF_METERING'), undefined);
  assert.equal(filtered.warnings.find((w) => w.code === 'NO_RETRY'), undefined);
});

test('filterWarnings: ok stays true when only warning/info-severity codes are dropped', () => {
  const r = validateMiddlewareOrder([
    { kind: 'usageMetering' },
    { kind: 'responseCache' },
  ]);
  const filtered = filterWarnings(r, []);
  assert.equal(filtered.ok, r.ok);
});
