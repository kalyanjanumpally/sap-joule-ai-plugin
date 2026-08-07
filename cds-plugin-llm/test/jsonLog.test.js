const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_jl__';
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

const { jsonLog } = require('../lib/middleware/jsonLog');
const { CircuitOpenError } = require('../lib/middleware/circuitBreaker');

// Capturing logger — records every payload emitted at each level
function capturingLogger() {
  const events = [];
  return {
    info:  (p) => events.push({ level: 'info',  payload: p }),
    warn:  (p) => events.push({ level: 'warn',  payload: p }),
    error: (p) => events.push({ level: 'error', payload: p }),
    log:   (p) => events.push({ level: 'log',   payload: p }),
    events,
  };
}

function invoke(mw, {
  method    = 'chat',
  request   = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Hi' }] },
  raw       = { tenant: 'acme', correlationId: 'req-abc' },
  service   = { name: 'llm', modelId: 'gpt-4o-mini' },
  next      = async () => ({ text: 'ok', model: 'gpt-4o-mini', usage: { input_tokens: 10, output_tokens: 20 } }),
  meta      = {},
} = {}) {
  const ctx = { method, request, raw, service, meta };
  return { ctx, promise: mw(ctx, next) };
}

// ---- Input validation --------------------------------------------------

test('jsonLog: throws when logger has no .info() or .log()', () => {
  assert.throws(() => jsonLog({ logger: {} }), /logger must expose/);
});

test('jsonLog: throws on negative previewChars', () => {
  assert.throws(() => jsonLog({ logger: console, previewChars: -1 }), /previewChars/);
});

test('jsonLog: throws when redactMetaFields is not an array', () => {
  assert.throws(() => jsonLog({ logger: console, redactMetaFields: 'stuff' }), /redactMetaFields must be an array/);
});

// ---- Happy path --------------------------------------------------------

test('jsonLog: success → emits ONE info-level payload with canonical schema', async () => {
  const logger = capturingLogger();
  const log = jsonLog({ logger });
  await invoke(log).promise;
  assert.equal(logger.events.length, 1);
  const { level, payload } = logger.events[0];
  assert.equal(level, 'info');
  assert.equal(payload.ok, true);
  assert.equal(payload.method, 'chat');
  assert.equal(payload.tenant, 'acme');
  assert.equal(payload.provider, 'llm');
  assert.equal(payload.model, 'gpt-4o-mini');
  assert.equal(payload.tokensIn, 10);
  assert.equal(payload.tokensOut, 20);
  assert.equal(payload.cachedHit, false);
  assert.equal(payload.correlationId, null);   // no correlationId fn supplied
  assert.ok(typeof payload.ts === 'string');
  assert.ok(payload.durationMs >= 0);
});

test('jsonLog: correlationId callback populates the correlationId field', async () => {
  const logger = capturingLogger();
  const log = jsonLog({
    logger,
    correlationId: (ctx) => ctx?.raw?.correlationId ?? null,
  });
  await invoke(log).promise;
  assert.equal(logger.events[0].payload.correlationId, 'req-abc');
});

test('jsonLog: correlationId callback that throws → correlationId is null (never breaks the log)', async () => {
  const logger = capturingLogger();
  const log = jsonLog({
    logger,
    correlationId: () => { throw new Error('boom'); },
  });
  await invoke(log).promise;
  assert.equal(logger.events[0].payload.correlationId, null);
});

test('jsonLog: uses ctx.meta.costEstimate.estimatedUsd as cost when no result.cost', async () => {
  const logger = capturingLogger();
  const log = jsonLog({ logger });
  const meta = { costEstimate: { estimatedUsd: 0.0012 } };
  await invoke(log, { meta }).promise;
  assert.equal(logger.events[0].payload.cost, 0.0012);
});

test('jsonLog: prefers result.cost over ctx.meta.costEstimate.estimatedUsd', async () => {
  const logger = capturingLogger();
  const log = jsonLog({ logger });
  const meta = { costEstimate: { estimatedUsd: 0.0012 } };
  await invoke(log, {
    meta,
    next: async () => ({ text: 'ok', model: 'x', usage: {}, cost: 0.05 }),
  }).promise;
  assert.equal(logger.events[0].payload.cost, 0.05);
});

test('jsonLog: cachedHit reflects result.cached', async () => {
  const logger = capturingLogger();
  const log = jsonLog({ logger });
  await invoke(log, {
    next: async () => ({ text: 'ok', usage: {}, cached: true }),
  }).promise;
  assert.equal(logger.events[0].payload.cachedHit, true);
});

// ---- Request preview --------------------------------------------------

test('jsonLog: includeRequestPreview:false (default) omits requestPreview', async () => {
  const logger = capturingLogger();
  const log = jsonLog({ logger });
  await invoke(log).promise;
  assert.equal(logger.events[0].payload.requestPreview, undefined);
});

test('jsonLog: includeRequestPreview:true captures the last user message truncated to previewChars', async () => {
  const logger = capturingLogger();
  const log = jsonLog({ logger, includeRequestPreview: true, previewChars: 10 });
  const longMsg = 'This is a much longer message than the preview would allow';
  await invoke(log, {
    request: { model: 'x', messages: [{ role: 'user', content: longMsg }] },
  }).promise;
  assert.equal(logger.events[0].payload.requestPreview, longMsg.slice(0, 10));
});

test('jsonLog: multimodal content array → joins text blocks only', async () => {
  const logger = capturingLogger();
  const log = jsonLog({ logger, includeRequestPreview: true });
  await invoke(log, {
    request: {
      model: 'x',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'First text.' },
          { type: 'image', source: { type: 'url', url: 'https://x.com/pic.png' } },
          { type: 'text', text: 'Second text.' },
        ],
      }],
    },
  }).promise;
  assert.match(logger.events[0].payload.requestPreview, /First text\. Second text\./);
});

// ---- Failure path ------------------------------------------------------

test('jsonLog: LLMError → warn-level payload with structured error field', async () => {
  const logger = capturingLogger();
  const log = jsonLog({ logger });
  const err = new CircuitOpenError('openai', 25_000, new Error('root'));
  await assert.rejects(
    invoke(log, { next: async () => { throw err; } }).promise,
    /circuit is OPEN/,
  );
  assert.equal(logger.events.length, 1);
  assert.equal(logger.events[0].level, 'warn');
  const payload = logger.events[0].payload;
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'CIRCUIT_OPEN');
  assert.equal(payload.error.primitive, 'circuitBreaker');
  assert.equal(payload.error.retriable, true);
  assert.equal(payload.error.severity, 'error');
  assert.match(payload.error.message, /circuit is OPEN/);
});

test('jsonLog: non-LLMError → error.code = UNKNOWN (falls through gracefully)', async () => {
  const logger = capturingLogger();
  const log = jsonLog({ logger });
  await assert.rejects(
    invoke(log, { next: async () => { throw new Error('random'); } }).promise,
    /random/,
  );
  assert.equal(logger.events[0].payload.error.code, 'UNKNOWN');
  assert.equal(logger.events[0].payload.error.retriable, false);
});

test('jsonLog: failed request re-throws the original error unchanged', async () => {
  const log = jsonLog({ logger: capturingLogger() });
  const orig = new Error('original');
  const caught = await invoke(log, { next: async () => { throw orig; } }).promise
    .catch((e) => e);
  assert.equal(caught, orig);
});

test('jsonLog: errorLevel option overrides the failure emission level', async () => {
  const logger = capturingLogger();
  const log = jsonLog({ logger, errorLevel: 'error' });
  await assert.rejects(
    invoke(log, { next: async () => { throw new CircuitOpenError('a', 5_000, new Error()); } }).promise,
    /circuit is OPEN/,
  );
  assert.equal(logger.events[0].level, 'error');
});

// ---- Meta redaction ---------------------------------------------------

test('jsonLog: includeMeta:true dumps ctx.meta (minus redactMetaFields)', async () => {
  const logger = capturingLogger();
  const log = jsonLog({ logger, includeMeta: true, redactMetaFields: ['secret'] });
  await invoke(log, { meta: { costEstimate: { estimatedUsd: 0.1 }, secret: 'hushhush', notes: 'ok' } }).promise;
  const meta = logger.events[0].payload.meta;
  assert.ok(meta.costEstimate);
  assert.equal(meta.notes, 'ok');
  assert.equal(meta.secret, undefined);   // redacted
});

test('jsonLog: default redactMetaFields includes messages + system', async () => {
  const logger = capturingLogger();
  const log = jsonLog({ logger, includeMeta: true });
  await invoke(log, { meta: { messages: 'raw prompt', system: 'raw system', costEstimate: { estimatedUsd: 0.01 } } }).promise;
  const meta = logger.events[0].payload.meta;
  assert.equal(meta.messages, undefined);
  assert.equal(meta.system, undefined);
  assert.ok(meta.costEstimate);
});

// ---- Stats + MCP resource --------------------------------------------

test('jsonLog: stats counts ok / failed + per-error-code breakdown', async () => {
  const log = jsonLog({ logger: capturingLogger() });
  // 3 ok, 2 failures with different codes
  await invoke(log).promise;
  await invoke(log).promise;
  await invoke(log).promise;
  await assert.rejects(
    invoke(log, { next: async () => { throw new CircuitOpenError('a', 5_000, new Error()); } }).promise,
  );
  await assert.rejects(
    invoke(log, { next: async () => { throw new CircuitOpenError('b', 5_000, new Error()); } }).promise,
  );
  await assert.rejects(
    invoke(log, { next: async () => { throw new Error('unknown'); } }).promise,
  );
  assert.equal(log.stats.requests, 6);
  assert.equal(log.stats.ok, 3);
  assert.equal(log.stats.failed, 3);
  assert.equal(log.stats.byErrorCode.CIRCUIT_OPEN, 2);
  assert.equal(log.stats.byErrorCode.UNKNOWN, 1);
});

test('jsonLog: reset() clears stats', async () => {
  const log = jsonLog({ logger: capturingLogger() });
  await invoke(log).promise;
  assert.equal(log.stats.requests, 1);
  log.reset();
  assert.equal(log.stats.requests, 0);
  assert.equal(Object.keys(log.stats.byErrorCode).length, 0);
});

test('jsonLog: asMcpResource() returns config://json-log snapshot', async () => {
  const log = jsonLog({ logger: capturingLogger(), level: 'debug', includeMeta: true });
  await invoke(log).promise;
  const res = log.asMcpResource();
  assert.equal(res.uri, 'config://json-log');
  assert.equal(res.mimeType, 'application/json');
  const snap = res.handler();
  assert.equal(snap.level, 'debug');
  assert.equal(snap.includeMeta, true);
  assert.equal(snap.requests, 1);
  assert.deepEqual(snap.redactMetaFields, ['messages', 'system']);
});

// ---- Logger error handling --------------------------------------------

test('jsonLog: logger that throws does NOT break the request path', async () => {
  const brokenLogger = { info: () => { throw new Error('logger broken'); } };
  const log = jsonLog({ logger: brokenLogger });
  const res = await invoke(log).promise;
  assert.deepEqual(res.text, 'ok');   // request succeeded despite logger explosion
});

// ---- Bare logger.log fallback ----------------------------------------

test('jsonLog: falls back to logger.log when logger.info is absent', async () => {
  let called = null;
  const bareLogger = { log: (p) => { called = p; } };
  const log = jsonLog({ logger: bareLogger });
  await invoke(log).promise;
  assert.ok(called);
  assert.equal(called.ok, true);
});
