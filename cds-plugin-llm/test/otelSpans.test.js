const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_otelspans__';
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

const { otelSpans } = require('../lib/middleware/otelSpans');
const { LLMError } = require('../lib/errors');
const { wrapStreamCompletion } = require('../lib/streamCompletion');

// ---- Fake OTel tracer/span --------------------------------------------

function fakeSpan(name) {
  const attrs = {};
  const events = [];
  const errors = [];
  let status = null;
  let ended = false;
  return {
    name,
    attributes: attrs,
    events,
    errors,
    ended,
    setAttribute(k, v) { attrs[k] = v; },
    setStatus(s)       { status = s; },
    recordException(e) { errors.push(e); },
    addEvent(name, at) { events.push({ name, attributes: at }); },
    end()              { this.ended = true; },
    get status()       { return status; },
  };
}

function fakeTracer() {
  const spans = [];
  return {
    spans,
    startSpan(name) {
      const s = fakeSpan(name);
      spans.push(s);
      return s;
    },
  };
}

// ---- Input validation --------------------------------------------------

test('otelSpans: throws without tracer', () => {
  assert.throws(() => otelSpans(), /tracer is required/);
});
test('otelSpans: throws when tracer lacks startSpan', () => {
  assert.throws(() => otelSpans({ tracer: {} }), /must implement startSpan/);
});
test('otelSpans: throws on non-function enrich', () => {
  assert.throws(() => otelSpans({ tracer: fakeTracer(), enrich: 'x' }), /enrich must be a function/);
});
test('otelSpans: throws on non-object pricing', () => {
  assert.throws(() => otelSpans({ tracer: fakeTracer(), pricing: 'x' }), /pricing must be an object/);
});

// ---- Basic chat span --------------------------------------------------

test('otelSpans: chat call creates span with request + response attrs', async () => {
  const tracer = fakeTracer();
  const mw = otelSpans({ tracer });
  await mw(
    { method: 'chat', request: { model: 'gpt-4o-mini', maxTokens: 100, temperature: 0.5 }, meta: {} },
    async () => ({
      text: 'hi',
      model: 'gpt-4o-mini',
      usage: { input_tokens: 20, output_tokens: 10 },
      stopReason: 'end_turn',
    }),
  );
  assert.equal(tracer.spans.length, 1);
  const s = tracer.spans[0];
  assert.equal(s.name, 'llm.chat');
  assert.equal(s.attributes['gen_ai.operation.name'], 'chat');
  assert.equal(s.attributes['gen_ai.request.model'], 'gpt-4o-mini');
  assert.equal(s.attributes['gen_ai.request.max_tokens'], 100);
  assert.equal(s.attributes['gen_ai.request.temperature'], 0.5);
  assert.equal(s.attributes['gen_ai.response.model'], 'gpt-4o-mini');
  assert.equal(s.attributes['gen_ai.response.stop_reason'], 'end_turn');
  assert.equal(s.attributes['gen_ai.usage.input_tokens'], 20);
  assert.equal(s.attributes['gen_ai.usage.output_tokens'], 10);
  assert.equal(s.ended, true);
});

test('otelSpans: custom span name prefix', async () => {
  const tracer = fakeTracer();
  const mw = otelSpans({ tracer, spanNamePrefix: 'app.llm.' });
  await mw(
    { method: 'chat', request: {}, meta: {} },
    async () => ({ text: 'ok' }),
  );
  assert.equal(tracer.spans[0].name, 'app.llm.chat');
});

test('otelSpans: systemAttribute added when provided', async () => {
  const tracer = fakeTracer();
  const mw = otelSpans({ tracer, systemAttribute: 'anthropic' });
  await mw(
    { method: 'chat', request: {}, meta: {} },
    async () => ({ text: 'ok' }),
  );
  assert.equal(tracer.spans[0].attributes['gen_ai.system'], 'anthropic');
});

// ---- Cost math ---------------------------------------------------------

test('otelSpans: cost attributes computed via DEFAULT_PRICING', async () => {
  const tracer = fakeTracer();
  const mw = otelSpans({ tracer });
  await mw(
    { method: 'chat', request: { model: 'claude-opus-4-7' }, meta: {} },
    async () => ({
      text: 'x',
      model: 'claude-opus-4-7',
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },   // 1M each
    }),
  );
  const attrs = tracer.spans[0].attributes;
  // claude-opus-4-7 = input 15/M, output 75/M → in=$15, out=$75, total=$90
  assert.ok(Math.abs(attrs['llm.cost.input_usd']  - 15) < 0.01);
  assert.ok(Math.abs(attrs['llm.cost.output_usd'] - 75) < 0.01);
  assert.ok(Math.abs(attrs['llm.cost.total_usd']  - 90) < 0.01);
});

test('otelSpans: cost omitted for unpriced model', async () => {
  const tracer = fakeTracer();
  const mw = otelSpans({ tracer });
  await mw(
    { method: 'chat', request: {}, meta: {} },
    async () => ({ model: 'unknown-custom-model', usage: { input_tokens: 100 } }),
  );
  assert.equal(tracer.spans[0].attributes['llm.cost.total_usd'], undefined);
});

test('otelSpans: costs:false disables cost attrs', async () => {
  const tracer = fakeTracer();
  const mw = otelSpans({ tracer, costs: false });
  await mw(
    { method: 'chat', request: {}, meta: {} },
    async () => ({ model: 'claude-opus-4-7', usage: { input_tokens: 100, output_tokens: 50 } }),
  );
  assert.equal(tracer.spans[0].attributes['llm.cost.total_usd'], undefined);
});

test('otelSpans: OpenAI-shape usage (prompt_tokens/completion_tokens) counted', async () => {
  const tracer = fakeTracer();
  const mw = otelSpans({ tracer });
  await mw(
    { method: 'chat', request: {}, meta: {} },
    async () => ({ model: 'gpt-4o', usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000 } }),
  );
  const attrs = tracer.spans[0].attributes;
  assert.equal(attrs['gen_ai.usage.input_tokens'], 1_000_000);
  assert.equal(attrs['gen_ai.usage.output_tokens'], 500_000);
  // gpt-4o = input 5/M, output 20/M → $5 + $10 = $15
  assert.ok(Math.abs(attrs['llm.cost.total_usd'] - 15) < 0.01);
});

// ---- Correlation ID from ctx.meta -----------------------------------

test('otelSpans: correlation ID from ctx.meta.correlationId', async () => {
  const tracer = fakeTracer();
  const mw = otelSpans({ tracer });
  await mw(
    { method: 'chat', request: {}, meta: { correlationId: 'req-abc-123' } },
    async () => ({ text: 'ok' }),
  );
  assert.equal(tracer.spans[0].attributes['llm.correlation_id'], 'req-abc-123');
});

test('otelSpans: correlation:false disables', async () => {
  const tracer = fakeTracer();
  const mw = otelSpans({ tracer, correlation: false });
  await mw(
    { method: 'chat', request: {}, meta: { correlationId: 'x' } },
    async () => ({ text: 'ok' }),
  );
  assert.equal(tracer.spans[0].attributes['llm.correlation_id'], undefined);
});

// ---- Routing meta from ctx.meta.routed ------------------------------

test('otelSpans: routing meta attrs from ctx.meta.routed', async () => {
  const tracer = fakeTracer();
  const mw = otelSpans({ tracer });
  await mw(
    { method: 'chat',
      request: { model: 'new-model' },
      meta: { routed: true, routedRule: 2, routedFrom: 'old-model', routedTo: 'new-model' } },
    async () => ({ text: 'ok' }),
  );
  const attrs = tracer.spans[0].attributes;
  assert.equal(attrs['llm.routing.rule_index'], 2);
  assert.equal(attrs['llm.routing.model.from'], 'old-model');
  assert.equal(attrs['llm.routing.model.to'],   'new-model');
});

test('otelSpans: routing attrs omitted when not routed', async () => {
  const tracer = fakeTracer();
  const mw = otelSpans({ tracer });
  await mw(
    { method: 'chat', request: {}, meta: {} },
    async () => ({ text: 'ok' }),
  );
  assert.equal(tracer.spans[0].attributes['llm.routing.rule_index'], undefined);
});

// ---- Error taxonomy ---------------------------------------------------

test('otelSpans: LLMError taxonomy attrs on failure', async () => {
  class TestErr extends LLMError {
    constructor() { super('gone bad', 'CIRCUIT_OPEN'); }
  }
  const tracer = fakeTracer();
  const mw = otelSpans({ tracer });
  await assert.rejects(
    mw({ method: 'chat', request: {}, meta: {} }, async () => { throw new TestErr(); }),
    /gone bad/,
  );
  const s = tracer.spans[0];
  assert.equal(s.attributes['llm.error.code'], 'CIRCUIT_OPEN');
  assert.equal(s.attributes['llm.error.primitive'], 'circuitBreaker');
  assert.equal(s.attributes['llm.error.retriable'], true);
  assert.equal(s.errors.length, 1);
  assert.equal(s.status.code, 2);
  assert.equal(s.ended, true);
});

test('otelSpans: non-LLM error still recorded, no taxonomy attrs', async () => {
  const tracer = fakeTracer();
  const mw = otelSpans({ tracer });
  await assert.rejects(
    mw({ method: 'chat', request: {}, meta: {} }, async () => { throw new Error('plain'); }),
    /plain/,
  );
  const s = tracer.spans[0];
  assert.equal(s.errors.length, 1);
  assert.equal(s.attributes['llm.error.code'], undefined);
});

// ---- Cache attribution ------------------------------------------------

test('otelSpans: response-cache hit detected via result.cached', async () => {
  const tracer = fakeTracer();
  const mw = otelSpans({ tracer });
  await mw(
    { method: 'chat', request: {}, meta: {} },
    async () => ({ text: 'cached response', cached: true }),
  );
  const attrs = tracer.spans[0].attributes;
  assert.equal(attrs['llm.cache.hit'], true);
  assert.equal(attrs['llm.cache.source'], 'response-cache');
});

test('otelSpans: anthropic prompt-cache detected via cache_read_input_tokens', async () => {
  const tracer = fakeTracer();
  const mw = otelSpans({ tracer });
  await mw(
    { method: 'chat', request: {}, meta: {} },
    async () => ({ usage: { cache_read_input_tokens: 500, input_tokens: 100 } }),
  );
  assert.equal(tracer.spans[0].attributes['llm.cache.source'], 'prompt-cache-anthropic');
});

test('otelSpans: openai prompt-cache detected via prompt_tokens_details.cached_tokens', async () => {
  const tracer = fakeTracer();
  const mw = otelSpans({ tracer });
  await mw(
    { method: 'chat', request: {}, meta: {} },
    async () => ({ usage: { prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 700 } } }),
  );
  assert.equal(tracer.spans[0].attributes['llm.cache.source'], 'prompt-cache-openai');
});

test('otelSpans: deepseek + gemini prompt-cache detected', async () => {
  const tracer = fakeTracer();
  const mw = otelSpans({ tracer });
  await mw({ method: 'chat', request: {}, meta: {} }, async () => ({
    usage: { prompt_cache_hit_tokens: 100 } }));
  assert.equal(tracer.spans[0].attributes['llm.cache.source'], 'prompt-cache-deepseek');

  const t2 = fakeTracer();
  const mw2 = otelSpans({ tracer: t2 });
  await mw2({ method: 'chat', request: {}, meta: {} }, async () => ({
    usage: { cachedContentTokenCount: 200 } }));
  assert.equal(t2.spans[0].attributes['llm.cache.source'], 'prompt-cache-gemini');
});

test('otelSpans: no cache hit → hit=false, source absent', async () => {
  const tracer = fakeTracer();
  const mw = otelSpans({ tracer });
  await mw(
    { method: 'chat', request: {}, meta: {} },
    async () => ({ usage: { input_tokens: 100, output_tokens: 50 } }),
  );
  assert.equal(tracer.spans[0].attributes['llm.cache.hit'], false);
  assert.equal(tracer.spans[0].attributes['llm.cache.source'], undefined);
});

test('otelSpans: cacheAttribution:false disables', async () => {
  const tracer = fakeTracer();
  const mw = otelSpans({ tracer, cacheAttribution: false });
  await mw(
    { method: 'chat', request: {}, meta: {} },
    async () => ({ cached: true }),
  );
  assert.equal(tracer.spans[0].attributes['llm.cache.hit'], undefined);
});

// ---- Tool calls + embed ---------------------------------------------

test('otelSpans: tool_calls.count attribute', async () => {
  const tracer = fakeTracer();
  const mw = otelSpans({ tracer });
  await mw(
    { method: 'chat', request: {}, meta: {} },
    async () => ({ text: 'x', toolCalls: [{ name: 'a' }, { name: 'b' }] }),
  );
  assert.equal(tracer.spans[0].attributes['llm.tool_calls.count'], 2);
});

test('otelSpans: embed.count attribute', async () => {
  const tracer = fakeTracer();
  const mw = otelSpans({ tracer });
  await mw(
    { method: 'embed', request: {}, meta: {} },
    async () => ({ embeddings: [[1, 2], [3, 4], [5, 6]] }),
  );
  const s = tracer.spans[0];
  assert.equal(s.name, 'llm.embed');
  assert.equal(s.attributes['llm.embed.count'], 3);
});

// ---- Streams ----------------------------------------------------------

test('otelSpans: stream span ends via onComplete + attrs from done chunk', async () => {
  const tracer = fakeTracer();
  const mw = otelSpans({ tracer });
  const stream = wrapStreamCompletion(async function* () {
    yield { type: 'text-delta', text: 'a' };
    yield { type: 'text-delta', text: 'b' };
    yield { type: 'done', text: 'ab', model: 'claude-opus-4-7',
      usage: { input_tokens: 10, output_tokens: 20 }, stopReason: 'end_turn' };
  }());
  const result = await mw(
    { method: 'stream', request: { model: 'claude-opus-4-7' }, meta: {} },
    async () => stream,
  );
  for await (const _ of result) { /* drain */ }
  await new Promise((r) => setTimeout(r, 10));
  const s = tracer.spans[0];
  assert.equal(s.name, 'llm.stream');
  assert.equal(s.attributes['gen_ai.response.model'], 'claude-opus-4-7');
  assert.equal(s.attributes['gen_ai.usage.input_tokens'], 10);
  assert.equal(s.attributes['gen_ai.usage.output_tokens'], 20);
  assert.equal(s.attributes['llm.stream.chunks'], 3);
  assert.ok(s.attributes['llm.stream.duration_ms'] >= 0);
  assert.equal(s.ended, true);
});

test('otelSpans: stream error path records exception', async () => {
  const tracer = fakeTracer();
  const mw = otelSpans({ tracer });
  const stream = wrapStreamCompletion(async function* () {
    yield { type: 'text-delta', text: 'a' };
    throw new Error('mid-stream boom');
  }());
  const result = await mw(
    { method: 'stream', request: {}, meta: {} },
    async () => stream,
  );
  await assert.rejects((async () => {
    for await (const _ of result) { /* consume */ }
  })());
  await new Promise((r) => setTimeout(r, 10));
  const s = tracer.spans[0];
  assert.equal(s.errors.length, 1);
  assert.equal(s.ended, true);
});

// ---- Custom enrich callback ------------------------------------------

test('otelSpans: enrich callback fires with (ctx, result, span)', async () => {
  const tracer = fakeTracer();
  let called = false;
  const mw = otelSpans({
    tracer,
    enrich: (ctx, result, span) => {
      called = true;
      span.setAttribute('custom.tenant', ctx.raw?.tenant ?? 'default');
      span.setAttribute('custom.text_length', result?.text?.length ?? 0);
    },
  });
  await mw(
    { method: 'chat', request: {}, raw: { tenant: 'acme' }, meta: {} },
    async () => ({ text: 'hello world' }),
  );
  assert.equal(called, true);
  const attrs = tracer.spans[0].attributes;
  assert.equal(attrs['custom.tenant'], 'acme');
  assert.equal(attrs['custom.text_length'], 11);
});

test('otelSpans: enrich error swallowed', async () => {
  const tracer = fakeTracer();
  const mw = otelSpans({ tracer, enrich: () => { throw new Error('broken enrich'); } });
  const result = await mw(
    { method: 'chat', request: {}, meta: {} },
    async () => ({ text: 'ok' }),
  );
  assert.equal(result.text, 'ok');
  assert.equal(tracer.spans[0].ended, true);
});

// ---- Custom pricing override ----------------------------------------

test('otelSpans: custom pricing override', async () => {
  const tracer = fakeTracer();
  const mw = otelSpans({ tracer, pricing: { 'my-model': { input: 100, output: 200 } } });
  await mw(
    { method: 'chat', request: {}, meta: {} },
    async () => ({ model: 'my-model', usage: { input_tokens: 1000, output_tokens: 500 } }),
  );
  const attrs = tracer.spans[0].attributes;
  // 100/M * 1000 = 0.1, 200/M * 500 = 0.1, total = 0.2
  assert.ok(Math.abs(attrs['llm.cost.total_usd'] - 0.2) < 0.001);
});
