const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_snap__';
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
  chainSnapshot,
  URI_TO_KIND,
  KNOWN_STATS_FIELDS,
  stripStats,
  detectKind,
  extractConfig,
} = require('../lib/chainSnapshot');
const { chainDiff } = require('../lib/chainDiff');
const { validateMiddlewareOrder } = require('../lib/validateMiddlewareOrder');

function mkMw({ kind, uri, payload }) {
  const fn = async (ctx, next) => next();
  if (kind) fn.kind = kind;
  if (uri) {
    fn.asMcpResource = () => ({
      uri,
      name: 'test',
      description: 'test',
      mimeType: 'application/json',
      handler: () => payload ?? {},
    });
  }
  return fn;
}

function mkLLM(middleware = []) {
  return { middleware };
}

// ---- Input validation --------------------------------------------------

test('chainSnapshot: throws when llm.middleware missing', () => {
  assert.throws(() => chainSnapshot({}), /must be an LLMService/);
  assert.throws(() => chainSnapshot(null), /must be an LLMService/);
});

test('chainSnapshot: throws on non-object kindMap', () => {
  assert.throws(() => chainSnapshot(mkLLM(), { kindMap: 'x' }), /kindMap must be an object/);
});

test('chainSnapshot: throws on non-function extractConfig', () => {
  assert.throws(() => chainSnapshot(mkLLM(), { extractConfig: 'x' }), /extractConfig must be a function/);
});

// ---- Empty chain -----------------------------------------------------

test('chainSnapshot: empty middleware → empty order', () => {
  const s = chainSnapshot(mkLLM());
  assert.deepEqual(s.order, []);
  assert.ok(s.generatedAt);
  assert.ok(typeof s.version === 'string');
});

// ---- Kind detection --------------------------------------------------

test('detectKind: explicit mw.kind takes priority', () => {
  const mw = mkMw({ kind: 'myThing', uri: 'config://cache' });
  assert.equal(detectKind(mw, null), 'myThing');
});

test('detectKind: URI_TO_KIND fallback', () => {
  assert.equal(detectKind(mkMw({ uri: 'config://cache' }), null), 'responseCache');
  assert.equal(detectKind(mkMw({ uri: 'config://model-router' }), null), 'modelRouter');
  assert.equal(detectKind(mkMw({ uri: 'config://safety-classifier' }), null), 'safetyClassifier');
});

test('detectKind: custom kindMap overrides URI_TO_KIND', () => {
  const mw = mkMw({ uri: 'config://cache' });
  const k = detectKind(mw, { 'config://cache': 'custom-cache' });
  assert.equal(k, 'custom-cache');
});

test('detectKind: unknown URI returns null', () => {
  assert.equal(detectKind(mkMw({ uri: 'config://mystery' }), null), null);
});

test('detectKind: no asMcpResource + no kind → null', () => {
  const fn = async () => {};
  assert.equal(detectKind(fn, null), null);
});

test('detectKind: asMcpResource throwing → null (soft-fail)', () => {
  const mw = async () => {};
  mw.asMcpResource = () => { throw new Error('broken'); };
  assert.equal(detectKind(mw, null), null);
});

// ---- URI_TO_KIND completeness ----------------------------------------

test('URI_TO_KIND: has entries for all shipped middleware', () => {
  const expected = [
    'responseCache', 'costBudget', 'guardrails', 'promptInjectionGuard',
    'retryOnRateLimit', 'usageMetering', 'circuitBreaker', 'bulkhead',
    'deadline', 'costGuard', 'jsonLog', 'adaptiveBulkhead',
    'providerHealthProbe', 'adaptiveMaxTokens', 'traceCorrelation',
    'tenantIsolate', 'replayBuffer', 'structuredOutputValidator',
    'idempotency', 'piiRedact', 'modelRouter', 'embeddingDedup',
    'promptCacheStats', 'autoContinue', 'safetyClassifier',
    'compactHistory', 'distributedLock', 'retryAfterPropagation',
  ];
  const shipped = new Set(Object.values(URI_TO_KIND));
  for (const kind of expected) {
    assert.ok(shipped.has(kind), `URI_TO_KIND missing ${kind}`);
  }
});

// ---- stripStats + KNOWN_STATS_FIELDS ---------------------------------

test('stripStats: removes counter fields', () => {
  const config = {
    ttlMs: 60000,          // config
    maxEntries: 100,       // config
    hits: 42,              // stat
    misses: 5,             // stat
    totalRequests: 100,    // stat
  };
  const stripped = stripStats(config);
  assert.deepEqual(stripped, { ttlMs: 60000, maxEntries: 100 });
});

test('stripStats: removes histogram-shape fields', () => {
  const config = {
    threshold: 0.5,
    byProvider: { openai: 5, anthropic: 3 },
    byModel: { 'gpt-4o': 10 },
  };
  assert.deepEqual(stripStats(config), { threshold: 0.5 });
});

test('stripStats: null/undefined passthrough', () => {
  assert.equal(stripStats(null), null);
  assert.equal(stripStats(undefined), undefined);
});

test('KNOWN_STATS_FIELDS includes common counters', () => {
  for (const f of ['hits', 'misses', 'totalRequests', 'byProvider', 'byModel', 'errors']) {
    assert.ok(KNOWN_STATS_FIELDS.has(f), `KNOWN_STATS_FIELDS missing ${f}`);
  }
});

// ---- extractConfig --------------------------------------------------

test('extractConfig: strips stats by default', () => {
  const mw = mkMw({
    uri: 'config://cache',
    payload: { ttl: 3600, maxEntries: 100, hits: 42, misses: 5, totalRequests: 100 },
  });
  const config = extractConfig(mw, { includeStats: false });
  assert.deepEqual(config, { ttl: 3600, maxEntries: 100 });
});

test('extractConfig: includeStats:true keeps counters', () => {
  const mw = mkMw({
    uri: 'config://cache',
    payload: { ttl: 3600, hits: 42, misses: 5 },
  });
  const config = extractConfig(mw, { includeStats: true });
  assert.deepEqual(config, { ttl: 3600, hits: 42, misses: 5 });
});

test('extractConfig: custom extractConfig overrides default', () => {
  const mw = mkMw({
    uri: 'config://cache',
    payload: { ttl: 3600, secret: 'hide-me', hits: 42 },
  });
  const config = extractConfig(mw, {
    includeStats: false,
    extractConfig: (payload) => ({ ttlMs: payload.ttl * 1000 }),
  });
  assert.deepEqual(config, { ttlMs: 3600 * 1000 });
});

test('extractConfig: no asMcpResource → null', () => {
  const fn = async () => {};
  assert.equal(extractConfig(fn, { includeStats: false }), null);
});

test('extractConfig: handler throws → null (soft-fail)', () => {
  const mw = async () => {};
  mw.asMcpResource = () => ({
    uri: 'x', name: '', description: '', mimeType: '',
    handler: () => { throw new Error('boom'); },
  });
  assert.equal(extractConfig(mw, { includeStats: false }), null);
});

// ---- Full snapshot --------------------------------------------------

test('chainSnapshot: single-middleware snapshot', () => {
  const mw = mkMw({
    uri: 'config://cache',
    payload: { ttl: 3600, hits: 100 },
  });
  const s = chainSnapshot(mkLLM([mw]));
  assert.equal(s.order.length, 1);
  assert.equal(s.order[0].position, 0);
  assert.equal(s.order[0].kind, 'responseCache');
  assert.deepEqual(s.order[0].config, { ttl: 3600 });
});

test('chainSnapshot: preserves llm.use() insertion order', () => {
  const mw1 = mkMw({ uri: 'config://deadline', payload: { timeoutMs: 30000 } });
  const mw2 = mkMw({ uri: 'config://guardrails', payload: {} });
  const mw3 = mkMw({ uri: 'config://cache', payload: { ttl: 3600 } });
  const s = chainSnapshot(mkLLM([mw1, mw2, mw3]));
  assert.deepEqual(
    s.order.map((e) => ({ position: e.position, kind: e.kind })),
    [
      { position: 0, kind: 'deadline' },
      { position: 1, kind: 'guardrails' },
      { position: 2, kind: 'responseCache' },
    ],
  );
});

test('chainSnapshot: unknown middleware get numbered fallback names', () => {
  const mw1 = mkMw({ uri: 'config://cache' });
  const mw2 = async () => {};                  // no asMcpResource
  const mw3 = mkMw({ uri: 'config://custom' }); // not in URI_TO_KIND
  const s = chainSnapshot(mkLLM([mw1, mw2, mw3]));
  assert.equal(s.order[0].kind, 'responseCache');
  assert.equal(s.order[1].kind, 'unknown-0');
  assert.equal(s.order[2].kind, 'unknown-1');
  assert.equal(s.unknownCount, 2);
});

test('chainSnapshot: custom kindMap overrides URI_TO_KIND', () => {
  const mw = mkMw({ uri: 'config://custom-thing', payload: { x: 1 } });
  const s = chainSnapshot(
    mkLLM([mw]),
    { kindMap: { 'config://custom-thing': 'myCustomThing' } },
  );
  assert.equal(s.order[0].kind, 'myCustomThing');
});

test('chainSnapshot: includeVersion:false omits version', () => {
  const s = chainSnapshot(mkLLM(), { includeVersion: false });
  assert.equal(s.version, undefined);
});

test('chainSnapshot: version pulled from package.json', () => {
  const s = chainSnapshot(mkLLM());
  assert.match(s.version, /^\d+\.\d+\.\d+/);
});

test('chainSnapshot: versionSource override for tests', () => {
  const s = chainSnapshot(mkLLM(), { versionSource: '99.99.99' });
  assert.equal(s.version, '99.99.99');
});

test('chainSnapshot: config field omitted when no asMcpResource', () => {
  const fn = async () => {};
  fn.kind = 'myMw';
  const s = chainSnapshot(mkLLM([fn]));
  assert.equal(s.order[0].config, undefined);
});

// ---- Round-trip with chainDiff + validateMiddlewareOrder -------------

test('chainSnapshot → chainDiff: identical snapshots produce ok=true', () => {
  const mw1 = mkMw({ uri: 'config://deadline', payload: { timeoutMs: 30000 } });
  const mw2 = mkMw({ uri: 'config://guardrails', payload: { inputFilters: ['x'] } });
  const snap1 = chainSnapshot(mkLLM([mw1, mw2]));
  const snap2 = chainSnapshot(mkLLM([mw1, mw2]));
  const diff = chainDiff(snap1, snap2);
  assert.equal(diff.ok, true);
});

test('chainSnapshot → chainDiff: config drift detected', () => {
  const mw = mkMw({ uri: 'config://deadline', payload: { timeoutMs: 30000 } });
  const snap1 = chainSnapshot(mkLLM([mw]));

  const mw2 = mkMw({ uri: 'config://deadline', payload: { timeoutMs: 60000 } });
  const snap2 = chainSnapshot(mkLLM([mw2]));

  const diff = chainDiff(snap1, snap2);
  assert.equal(diff.ok, false);
  assert.equal(diff.configChanged.length, 1);
  assert.equal(diff.configChanged[0].kind, 'deadline');
  assert.equal(diff.configChanged[0].changes[0].field, 'timeoutMs');
  assert.equal(diff.configChanged[0].changes[0].from, 30000);
  assert.equal(diff.configChanged[0].changes[0].to, 60000);
});

test('chainSnapshot → chainDiff: added / removed detected', () => {
  const mw1 = mkMw({ uri: 'config://deadline', payload: {} });
  const mw2 = mkMw({ uri: 'config://cache', payload: {} });
  const snap1 = chainSnapshot(mkLLM([mw1]));
  const snap2 = chainSnapshot(mkLLM([mw1, mw2]));
  const diff = chainDiff(snap1, snap2);
  assert.equal(diff.ok, false);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.added[0].kind, 'responseCache');
});

test('chainSnapshot → validateMiddlewareOrder: accepts snapshot.order', () => {
  const mw1 = mkMw({ uri: 'config://prompt-injection-guard', payload: {} });
  const mw2 = mkMw({ uri: 'config://guardrails', payload: {} });
  const mw3 = mkMw({ uri: 'config://cache', payload: {} });
  const snap = chainSnapshot(mkLLM([mw1, mw2, mw3]));
  // validateMiddlewareOrder wants an array of { kind } — pass snap.order.
  const result = validateMiddlewareOrder(snap.order);
  assert.ok(typeof result.ok === 'boolean');
});

// ---- Stats snapshot inclusion ---------------------------------------

test('chainSnapshot: includeStats:true keeps counters', () => {
  const mw = mkMw({
    uri: 'config://cache',
    payload: { ttl: 3600, hits: 42, misses: 5 },
  });
  const s = chainSnapshot(mkLLM([mw]), { includeStats: true });
  assert.equal(s.order[0].config.hits, 42);
  assert.equal(s.order[0].config.misses, 5);
});
