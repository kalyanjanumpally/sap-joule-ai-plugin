const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_otel__';
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

const LLMService = require('../lib/LLMService');
const { otel } = require('../lib/middleware/otel');

class StubProvider extends LLMService {
  async _chat(params) {
    return {
      text: 'ok', raw: null,
      usage: { input_tokens: 12, output_tokens: 3 },
      stopReason: 'end_turn', model: params.model,
    };
  }
  async _embed({ model, input }) {
    const arr = Array.isArray(input) ? input : [input];
    return { embeddings: arr.map(() => [0.1, 0.2]), model };
  }
  async *_stream(params) {
    yield { type: 'text_delta', text: 'a' };
    yield { type: 'text_delta', text: 'b' };
    yield {
      type: 'done', text: 'ab',
      usage: { input_tokens: 5, output_tokens: 2 },
      stopReason: 'stop', model: params.model,
    };
  }
}

function makeTracer() {
  const spans = [];
  return {
    spans,
    startSpan(name) {
      const attrs = {};
      const events = [];
      const status = { code: 1 };
      const span = {
        name, attrs, events, status,
        setAttribute(k, v) { attrs[k] = v; },
        recordException(err) { events.push({ type: 'exception', message: err?.message }); },
        setStatus(s) { Object.assign(status, s); },
        end() { span.ended = true; },
      };
      spans.push(span);
      return span;
    },
  };
}

async function makeProvider() {
  const p = new StubProvider('llm', null, { modelId: 'm1' });
  await p.init();
  return p;
}

test('otel: throws without a tracer', () => {
  assert.throws(() => otel({}), /tracer/);
  assert.throws(() => otel({ tracer: {} }), /tracer/);
});

test('otel: chat span records model, tokens, cached=false', async () => {
  const t = makeTracer();
  const p = await makeProvider();
  p.use(otel({ tracer: t, systemAttribute: 'anthropic' }));

  await p.chat({ messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(t.spans.length, 1);
  const s = t.spans[0];
  assert.equal(s.name, 'llm.chat');
  assert.equal(s.attrs['gen_ai.system'], 'anthropic');
  assert.equal(s.attrs['gen_ai.operation.name'], 'chat');
  assert.equal(s.attrs['gen_ai.request.model'], 'm1');
  assert.equal(s.attrs['gen_ai.response.model'], 'm1');
  assert.equal(s.attrs['gen_ai.usage.input_tokens'], 12);
  assert.equal(s.attrs['gen_ai.usage.output_tokens'], 3);
  assert.equal(s.attrs['gen_ai.response.stop_reason'], 'end_turn');
  assert.equal(s.attrs['llm.cached'], false);
  assert.equal(s.ended, true);
});

test('otel: embed span records embed count', async () => {
  const t = makeTracer();
  const p = await makeProvider();
  p.use(otel({ tracer: t }));

  await p.embed({ input: ['a', 'b', 'c'] });

  const s = t.spans[0];
  assert.equal(s.name, 'llm.embed');
  assert.equal(s.attrs['llm.embed.count'], 3);
  assert.equal(s.ended, true);
});

test('otel: stream span ends after iteration completes, records chunk count + usage from done', async () => {
  const t = makeTracer();
  const p = await makeProvider();
  p.use(otel({ tracer: t }));

  const iter = p.stream({ messages: [{ role: 'user', content: 'x' }] });
  const collected = [];
  for await (const c of iter) collected.push(c);

  assert.equal(collected.length, 3);
  const s = t.spans[0];
  assert.equal(s.name, 'llm.stream');
  assert.equal(s.attrs['llm.stream.chunks'], 3);
  assert.equal(s.attrs['gen_ai.usage.input_tokens'], 5);
  assert.equal(s.attrs['gen_ai.usage.output_tokens'], 2);
  assert.equal(s.ended, true);
});

test('otel: chat error records exception + status and ends span', async () => {
  const t = makeTracer();
  const p = await makeProvider();
  p._chat = async () => { throw new Error('boom'); };
  p.use(otel({ tracer: t }));

  await assert.rejects(() => p.chat({ messages: [{ role: 'user', content: 'x' }] }), /boom/);

  const s = t.spans[0];
  assert.equal(s.events.length, 1);
  assert.equal(s.events[0].message, 'boom');
  assert.equal(s.status.code, 2);
  assert.equal(s.ended, true);
});

test('otel: stream error inside iterator ends span + records exception', async () => {
  const t = makeTracer();
  const p = await makeProvider();
  p._stream = async function*() {
    yield { type: 'text_delta', text: 'a' };
    throw new Error('stream boom');
  };
  p.use(otel({ tracer: t }));

  await assert.rejects(async () => {
    for await (const _ of p.stream({ messages: [{ role: 'user', content: 'x' }] })) { /* drain */ }
  }, /stream boom/);

  const s = t.spans[0];
  assert.equal(s.events.length, 1);
  assert.equal(s.events[0].message, 'stream boom');
  assert.equal(s.status.code, 2);
  assert.equal(s.ended, true);
});

test('otel: uses custom spanNamePrefix', async () => {
  const t = makeTracer();
  const p = await makeProvider();
  p.use(otel({ tracer: t, spanNamePrefix: 'myapp.ai.' }));

  await p.chat({ messages: [{ role: 'user', content: 'q' }] });
  assert.equal(t.spans[0].name, 'myapp.ai.chat');
});
