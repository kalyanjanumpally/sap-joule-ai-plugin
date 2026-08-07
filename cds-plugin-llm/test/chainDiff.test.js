const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_cd__';
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

const { chainDiff, formatChainDiff } = require('../lib/chainDiff');

// Helper — build a chain snapshot
function chain(...entries) {
  return {
    order: entries.map((e, i) => ({ position: i, kind: e.kind, config: e.config ?? {} })),
  };
}

// ---- Input validation --------------------------------------------------

test('chainDiff: throws when first arg is not a chain snapshot', () => {
  assert.throws(() => chainDiff(null, chain({ kind: 'a' })), /first arg/);
  assert.throws(() => chainDiff({}, chain({ kind: 'a' })), /first arg/);
  assert.throws(() => chainDiff({ order: 'nope' }, chain({ kind: 'a' })), /first arg/);
});

test('chainDiff: throws when second arg is not a chain snapshot', () => {
  assert.throws(() => chainDiff(chain({ kind: 'a' }), null), /second arg/);
});

// ---- Identical chains ----------------------------------------------

test('chainDiff: identical chains → ok=true, all unchanged', () => {
  const a = chain(
    { kind: 'deadline',       config: { timeoutMs: 30000 } },
    { kind: 'circuitBreaker', config: { threshold: 5 } },
    { kind: 'bulkhead',       config: { maxConcurrent: 10 } },
  );
  const diff = chainDiff(a, a);
  assert.equal(diff.ok, true);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.reordered, []);
  assert.deepEqual(diff.configChanged, []);
  assert.equal(diff.unchanged.length, 3);
  assert.equal(diff.summary.unchanged, 3);
});

// ---- Added / removed ----------------------------------------------

test('chainDiff: detects added primitive', () => {
  const a = chain({ kind: 'deadline' }, { kind: 'bulkhead' });
  const b = chain({ kind: 'deadline' }, { kind: 'bulkhead' }, { kind: 'traceCorrelation' });
  const diff = chainDiff(a, b);
  assert.equal(diff.ok, false);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.added[0].kind, 'traceCorrelation');
  assert.equal(diff.added[0].position, 2);
});

test('chainDiff: detects removed primitive', () => {
  const a = chain({ kind: 'deadline' }, { kind: 'bulkhead' }, { kind: 'costGuard' });
  const b = chain({ kind: 'deadline' }, { kind: 'bulkhead' });
  const diff = chainDiff(a, b);
  assert.equal(diff.ok, false);
  assert.equal(diff.removed.length, 1);
  assert.equal(diff.removed[0].kind, 'costGuard');
  assert.equal(diff.removed[0].position, 2);
});

test('chainDiff: mixed add + remove tracked separately', () => {
  const a = chain({ kind: 'a' }, { kind: 'b' });
  const b = chain({ kind: 'a' }, { kind: 'c' });   // b removed, c added
  const diff = chainDiff(a, b);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.added[0].kind, 'c');
  assert.equal(diff.removed.length, 1);
  assert.equal(diff.removed[0].kind, 'b');
});

// ---- Reordering ----------------------------------------------------

test('chainDiff: reordered primitive shows from → to positions', () => {
  const a = chain({ kind: 'deadline' }, { kind: 'bulkhead' }, { kind: 'breaker' });
  const b = chain({ kind: 'deadline' }, { kind: 'breaker' }, { kind: 'bulkhead' });
  const diff = chainDiff(a, b);
  assert.equal(diff.ok, false);
  assert.equal(diff.reordered.length, 2);
  const bhReorder = diff.reordered.find((r) => r.kind === 'bulkhead');
  assert.equal(bhReorder.fromPosition, 1);
  assert.equal(bhReorder.toPosition, 2);
  const brReorder = diff.reordered.find((r) => r.kind === 'breaker');
  assert.equal(brReorder.fromPosition, 2);
  assert.equal(brReorder.toPosition, 1);
});

test('chainDiff: added primitive at head causes existing entries to reorder', () => {
  const a = chain({ kind: 'bulkhead' });
  const b = chain({ kind: 'deadline' }, { kind: 'bulkhead' });
  const diff = chainDiff(a, b);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.reordered.length, 1);   // bulkhead moved 0→1
  assert.equal(diff.reordered[0].kind, 'bulkhead');
  assert.equal(diff.reordered[0].fromPosition, 0);
  assert.equal(diff.reordered[0].toPosition, 1);
});

// ---- Config field changes -----------------------------------------

test('chainDiff: detects scalar config field change', () => {
  const a = chain({ kind: 'bulkhead', config: { maxConcurrent: 10 } });
  const b = chain({ kind: 'bulkhead', config: { maxConcurrent: 20 } });
  const diff = chainDiff(a, b);
  assert.equal(diff.ok, false);
  assert.equal(diff.configChanged.length, 1);
  assert.equal(diff.configChanged[0].kind, 'bulkhead');
  assert.equal(diff.configChanged[0].changes.length, 1);
  assert.equal(diff.configChanged[0].changes[0].field, 'maxConcurrent');
  assert.equal(diff.configChanged[0].changes[0].from, 10);
  assert.equal(diff.configChanged[0].changes[0].to, 20);
});

test('chainDiff: multiple config field changes on the same middleware', () => {
  const a = chain({ kind: 'bulkhead', config: { maxConcurrent: 10, maxQueued: 50, queueTimeoutMs: 5000 } });
  const b = chain({ kind: 'bulkhead', config: { maxConcurrent: 20, maxQueued: 50, queueTimeoutMs: 10000 } });
  const diff = chainDiff(a, b);
  assert.equal(diff.configChanged.length, 1);
  const fields = diff.configChanged[0].changes.map((c) => c.field).sort();
  assert.deepEqual(fields, ['maxConcurrent', 'queueTimeoutMs']);
});

test('chainDiff: added config field (undefined → value)', () => {
  const a = chain({ kind: 'breaker', config: { threshold: 5 } });
  const b = chain({ kind: 'breaker', config: { threshold: 5, cooldownMs: 30000 } });
  const diff = chainDiff(a, b);
  assert.equal(diff.configChanged.length, 1);
  const change = diff.configChanged[0].changes[0];
  assert.equal(change.field, 'cooldownMs');
  assert.equal(change.from, undefined);
  assert.equal(change.to, 30000);
});

test('chainDiff: removed config field (value → undefined)', () => {
  const a = chain({ kind: 'breaker', config: { threshold: 5, cooldownMs: 30000 } });
  const b = chain({ kind: 'breaker', config: { threshold: 5 } });
  const diff = chainDiff(a, b);
  const change = diff.configChanged[0].changes[0];
  assert.equal(change.field, 'cooldownMs');
  assert.equal(change.to, undefined);
});

test('chainDiff: nested object config changes detected', () => {
  const a = chain({ kind: 'deadline', config: { perMethod: { chat: 30000, embed: 5000 } } });
  const b = chain({ kind: 'deadline', config: { perMethod: { chat: 60000, embed: 5000 } } });
  const diff = chainDiff(a, b);
  assert.equal(diff.configChanged.length, 1);
  const change = diff.configChanged[0].changes[0];
  assert.equal(change.field, 'perMethod');
  assert.deepEqual(change.from, { chat: 30000, embed: 5000 });
  assert.deepEqual(change.to,   { chat: 60000, embed: 5000 });
});

test('chainDiff: array config value change detected', () => {
  const a = chain({ kind: 'x', config: { retryOnStatuses: [429, 503] } });
  const b = chain({ kind: 'x', config: { retryOnStatuses: [429, 503, 500] } });
  const diff = chainDiff(a, b);
  assert.equal(diff.configChanged.length, 1);
});

test('chainDiff: identical nested configs do NOT trigger changes', () => {
  const a = chain({ kind: 'deadline', config: { perMethod: { chat: 30000 } } });
  const b = chain({ kind: 'deadline', config: { perMethod: { chat: 30000 } } });
  const diff = chainDiff(a, b);
  assert.equal(diff.configChanged.length, 0);
  assert.equal(diff.ok, true);
});

// ---- Missing config handled ----

test('chainDiff: missing config on either side treated as {}', () => {
  const a = chain({ kind: 'x', config: { foo: 1 } });
  const b = chain({ kind: 'x' });   // no config field
  const diff = chainDiff(a, b);
  assert.equal(diff.configChanged.length, 1);
  assert.equal(diff.configChanged[0].changes[0].field, 'foo');
  assert.equal(diff.configChanged[0].changes[0].to, undefined);
});

// ---- Summary counts ----

test('chainDiff: summary matches individual counts', () => {
  const a = chain(
    { kind: 'deadline',       config: { timeoutMs: 30000 } },
    { kind: 'bulkhead',       config: { maxConcurrent: 10 } },
    { kind: 'costBudget',     config: { total: 100 } },
    { kind: 'removedThing' },
  );
  const b = chain(
    { kind: 'deadline',       config: { timeoutMs: 30000 } },        // unchanged
    { kind: 'costBudget',     config: { total: 100 } },              // reordered
    { kind: 'bulkhead',       config: { maxConcurrent: 20 } },        // reordered + config change
    { kind: 'traceCorrelation' },                                     // added
  );
  const diff = chainDiff(a, b);
  assert.equal(diff.summary.added, 1);
  assert.equal(diff.summary.removed, 1);
  assert.equal(diff.summary.reordered, 2);
  assert.equal(diff.summary.configChanged, 1);
  assert.equal(diff.summary.unchanged, 1);
});

// ---- Formatter -----------------------------------------------------

test('formatChainDiff: identical chains → no-diff message', () => {
  const a = chain({ kind: 'deadline' });
  const text = formatChainDiff(chainDiff(a, a));
  assert.match(text, /chain unchanged/);
});

test('formatChainDiff: shows +/-/~ markers', () => {
  const a = chain({ kind: 'a' }, { kind: 'b', config: { x: 1 } }, { kind: 'c' });
  const b = chain({ kind: 'a' }, { kind: 'b', config: { x: 2 } }, { kind: 'd' });
  const text = formatChainDiff(chainDiff(a, b));
  assert.match(text, /^\+ d/m);
  assert.match(text, /^- c/m);
  assert.match(text, /^~ b\b/m);
  assert.match(text, /x: 1 → 2/);
});

test('formatChainDiff: includes summary line at end', () => {
  const a = chain({ kind: 'a' });
  const b = chain({ kind: 'a' }, { kind: 'b' });
  const text = formatChainDiff(chainDiff(a, b));
  assert.match(text, /summary: \+1 added, -0 removed/);
});

test('formatChainDiff: colors option adds ANSI escape codes', () => {
  const a = chain({ kind: 'a' });
  const b = chain({ kind: 'a' }, { kind: 'b' });
  const text = formatChainDiff(chainDiff(a, b), { colors: true });
  // Colored output contains ANSI escape sequences
  assert.match(text, /\x1b\[32m/);
});

test('formatChainDiff: truncates long values', () => {
  const longVal = 'x'.repeat(200);
  const a = chain({ kind: 'x', config: { field: 'short' } });
  const b = chain({ kind: 'x', config: { field: longVal } });
  const text = formatChainDiff(chainDiff(a, b));
  assert.match(text, /\.\.\./);   // ellipsis appears
});
