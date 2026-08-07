const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_tc__';
// Fake CAP with a mutable context we can inspect
const fakeCdsContext = {};
require.cache[STUB_PATH] = {
  exports: {
    Service: class { constructor(name, model, options) { this.options = options ?? {}; } async init() {} },
    log: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} }),
    get context() { return fakeCdsContext.value; },
    set context(v) { fakeCdsContext.value = v; },
  },
  loaded: true,
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function(request, ...rest) {
  if (request === '@sap/cds') return STUB_PATH;
  return origResolve.call(this, request, ...rest);
};

const {
  traceCorrelation,
  uuidv7,
  parseTraceparent,
} = require('../lib/middleware/traceCorrelation');

function invoke(mw, { raw = {}, meta = {}, next = async () => ({ text: 'ok' }) } = {}) {
  const ctx = { method: 'chat', request: {}, raw, meta };
  return { ctx, promise: mw(ctx, next) };
}

// Reset fake CAP context before each test scenario
function clearCdsContext() { fakeCdsContext.value = null; }

// ---- Input validation --------------------------------------------------

test('traceCorrelation: throws when fromCtx not a function', () => {
  assert.throws(() => traceCorrelation({ fromCtx: 'not fn' }), /fromCtx must be a function/);
});

test('traceCorrelation: throws when generator not a function', () => {
  assert.throws(() => traceCorrelation({ generator: 'not fn' }), /generator must be a function/);
});

test('traceCorrelation: throws when metaField is empty', () => {
  assert.throws(() => traceCorrelation({ metaField: '' }), /metaField must be a non-empty string/);
});

// ---- Extraction paths -------------------------------------------------

test('traceCorrelation: extracts from raw.correlationId', async () => {
  clearCdsContext();
  const mw = traceCorrelation();
  const { ctx, promise } = invoke(mw, { raw: { correlationId: 'req-abc-123' } });
  await promise;
  assert.equal(ctx.meta.correlationId, 'req-abc-123');
  assert.equal(mw.stats.extracted, 1);
  assert.equal(mw.stats.generated, 0);
});

test('traceCorrelation: extracts from raw.headers[x-correlation-id]', async () => {
  clearCdsContext();
  const mw = traceCorrelation();
  const { ctx, promise } = invoke(mw, { raw: { headers: { 'x-correlation-id': 'from-header' } } });
  await promise;
  assert.equal(ctx.meta.correlationId, 'from-header');
});

test('traceCorrelation: falls back to x-request-id when x-correlation-id missing', async () => {
  clearCdsContext();
  const mw = traceCorrelation();
  const { ctx, promise } = invoke(mw, { raw: { headers: { 'x-request-id': 'req-id-value' } } });
  await promise;
  assert.equal(ctx.meta.correlationId, 'req-id-value');
});

test('traceCorrelation: parses W3C traceparent trace-id', async () => {
  clearCdsContext();
  const mw = traceCorrelation();
  const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
  const { ctx, promise } = invoke(mw, { raw: { headers: { traceparent } } });
  await promise;
  assert.equal(ctx.meta.correlationId, '4bf92f3577b34da6a3ce929d0e0e4736');
});

test('traceCorrelation: extracts from cds.context.id when no ctx.raw values', async () => {
  fakeCdsContext.value = { id: 'cds-ctx-uuid-9999' };
  const mw = traceCorrelation();
  const { ctx, promise } = invoke(mw);
  await promise;
  assert.equal(ctx.meta.correlationId, 'cds-ctx-uuid-9999');
});

test('traceCorrelation: precedence — raw.correlationId beats cds.context.id', async () => {
  fakeCdsContext.value = { id: 'cds-ctx-id' };
  const mw = traceCorrelation();
  const { ctx, promise } = invoke(mw, { raw: { correlationId: 'raw-wins' } });
  await promise;
  assert.equal(ctx.meta.correlationId, 'raw-wins');
});

// ---- Generation path -------------------------------------------------

test('traceCorrelation: generates fresh UUID when nothing to extract', async () => {
  clearCdsContext();
  const mw = traceCorrelation();
  const { ctx, promise } = invoke(mw);
  await promise;
  assert.match(ctx.meta.correlationId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.equal(mw.stats.generated, 1);
});

test('traceCorrelation: custom generator is respected', async () => {
  clearCdsContext();
  let called = 0;
  const mw = traceCorrelation({ generator: () => `custom-${++called}` });
  const { ctx, promise } = invoke(mw);
  await promise;
  assert.equal(ctx.meta.correlationId, 'custom-1');
});

test('traceCorrelation: uuidv7 generator produces time-ordered IDs', async () => {
  clearCdsContext();
  const mw = traceCorrelation({ generator: traceCorrelation.uuidv7 });
  const { ctx: c1, promise: p1 } = invoke(mw); await p1;
  await new Promise((r) => setTimeout(r, 2));
  const { ctx: c2, promise: p2 } = invoke(mw); await p2;
  // v7 IDs are lexically sortable by time (48-bit ms timestamp at head)
  assert.ok(c1.meta.correlationId < c2.meta.correlationId,
    `${c1.meta.correlationId} should sort before ${c2.meta.correlationId}`);
});

// ---- CDS context injection -------------------------------------------

test('traceCorrelation: injectIntoCdsContext=true writes to cds.context when empty', async () => {
  clearCdsContext();
  fakeCdsContext.value = {};   // exists but no id
  const mw = traceCorrelation();
  const { promise } = invoke(mw, { raw: { correlationId: 'inject-me' } });
  await promise;
  assert.equal(fakeCdsContext.value.correlationId, 'inject-me');
});

test('traceCorrelation: injectIntoCdsContext does NOT overwrite existing id', async () => {
  clearCdsContext();
  fakeCdsContext.value = { correlationId: 'original' };
  const mw = traceCorrelation();
  const { promise } = invoke(mw, { raw: { correlationId: 'should-not-override' } });
  await promise;
  assert.equal(fakeCdsContext.value.correlationId, 'original');
});

test('traceCorrelation: injectIntoCdsContext=false leaves cds.context alone', async () => {
  clearCdsContext();
  fakeCdsContext.value = {};
  const mw = traceCorrelation({ injectIntoCdsContext: false });
  const { promise } = invoke(mw, { raw: { correlationId: 'req-abc' } });
  await promise;
  assert.equal(fakeCdsContext.value.correlationId, undefined);
});

// ---- onExtract callback ----------------------------------------------

test('traceCorrelation: onExtract fires with { id, source, method }', async () => {
  clearCdsContext();
  const events = [];
  const mw = traceCorrelation({ onExtract: (info) => events.push(info) });
  await invoke(mw, { raw: { correlationId: 'from-caller' } }).promise;
  await invoke(mw).promise;
  assert.equal(events.length, 2);
  assert.equal(events[0].source, 'extracted');
  assert.equal(events[0].id, 'from-caller');
  assert.equal(events[1].source, 'generated');
});

test('traceCorrelation: onExtract errors are swallowed', async () => {
  clearCdsContext();
  const mw = traceCorrelation({ onExtract: () => { throw new Error('handler broken'); } });
  await invoke(mw).promise;   // should NOT throw
});

// ---- Custom fromCtx --------------------------------------------------

test('traceCorrelation: custom fromCtx overrides default lookup', async () => {
  clearCdsContext();
  const mw = traceCorrelation({
    fromCtx: (ctx) => ctx?.raw?.customField ?? null,
  });
  const { ctx, promise } = invoke(mw, { raw: { customField: 'custom-value' } });
  await promise;
  assert.equal(ctx.meta.correlationId, 'custom-value');
});

test('traceCorrelation: fromCtx that throws → generated (never breaks the chain)', async () => {
  clearCdsContext();
  const mw = traceCorrelation({ fromCtx: () => { throw new Error('bad extractor'); } });
  const { ctx, promise } = invoke(mw);
  await promise;
  assert.equal(mw.stats.generated, 1);
  assert.match(ctx.meta.correlationId, /^[0-9a-f-]{36}$/);
});

// ---- Custom metaField -------------------------------------------------

test('traceCorrelation: custom metaField stores under that key', async () => {
  clearCdsContext();
  const mw = traceCorrelation({ metaField: 'traceId' });
  const { ctx, promise } = invoke(mw, { raw: { correlationId: 'xyz' } });
  await promise;
  assert.equal(ctx.meta.traceId, 'xyz');
  assert.equal(ctx.meta.correlationId, undefined);
});

// ---- Stats + MCP resource --------------------------------------------

test('traceCorrelation: stats accumulate extracted vs generated', async () => {
  clearCdsContext();
  const mw = traceCorrelation();
  await invoke(mw, { raw: { correlationId: 'a' } }).promise;
  await invoke(mw, { raw: { correlationId: 'b' } }).promise;
  await invoke(mw).promise;
  assert.equal(mw.stats.requests, 3);
  assert.equal(mw.stats.extracted, 2);
  assert.equal(mw.stats.generated, 1);
});

test('traceCorrelation: reset() clears stats', async () => {
  clearCdsContext();
  const mw = traceCorrelation();
  await invoke(mw).promise;
  assert.equal(mw.stats.requests, 1);
  mw.reset();
  assert.equal(mw.stats.requests, 0);
});

test('traceCorrelation: asMcpResource() returns config://trace-correlation', async () => {
  clearCdsContext();
  const mw = traceCorrelation({ metaField: 'traceId', injectIntoCdsContext: false });
  await invoke(mw).promise;
  const res = mw.asMcpResource();
  assert.equal(res.uri, 'config://trace-correlation');
  assert.equal(res.mimeType, 'application/json');
  const snap = res.handler();
  assert.equal(snap.metaField, 'traceId');
  assert.equal(snap.injectIntoCdsContext, false);
  assert.equal(snap.requests, 1);
});

// ---- Exports for reuse -----------------------------------------------

test('uuidv7 (top-level export): valid RFC-9562 v7 shape', () => {
  const id = uuidv7();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('parseTraceparent (top-level export): parses valid W3C header', () => {
  const id = parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
  assert.equal(id, '4bf92f3577b34da6a3ce929d0e0e4736');
});

test('parseTraceparent: returns null for malformed header', () => {
  assert.equal(parseTraceparent(null), null);
  assert.equal(parseTraceparent('not-a-traceparent'), null);
  assert.equal(parseTraceparent('00-tooshort-00f067aa0ba902b7-01'), null);
});
