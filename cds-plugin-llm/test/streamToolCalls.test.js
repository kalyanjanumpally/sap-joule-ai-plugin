const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_stc__';
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

// ---- OpenAI-compat stream: tool_calls accumulation --------------------

test('OpenAI-compat _stream: accumulates tool_call fragments across deltas → toolCalls on done chunk', async () => {
  const OpenAICompatibleLLMService = require('../lib/providers/openai-compatible');
  const svc = new OpenAICompatibleLLMService('llm', null, {
    credentials: { apiKey: 'sk-fake', baseUrl: 'http://127.0.0.1:65535/v1' },
    modelId: 'gpt-4o',
  });
  await svc.init();

  // Compose an SSE body that spreads a single tool_call across three deltas:
  //   chunk 1: id + function.name
  //   chunk 2: partial arguments
  //   chunk 3: rest of arguments
  //   chunk 4: finish_reason=tool_calls + usage
  const events = [
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'search', arguments: '{"q"' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"widg' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'ets"}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 5 }, model: 'gpt-4o' },
  ];
  const sseBody = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';

  const origFetch = global.fetch;
  global.fetch = async () => {
    const encoder = new TextEncoder();
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: (async function* () { yield encoder.encode(sseBody); })(),
    };
  };
  try {
    const chunks = [];
    for await (const c of svc._stream({
      model: 'gpt-4o', maxTokens: 100, system: null,
      messages: [{ role: 'user', content: 'find widgets' }],
    })) chunks.push(c);
    const done = chunks.find(c => c.type === 'done');
    assert.ok(done, 'stream must terminate with a done chunk');
    assert.ok(done.toolCalls, 'toolCalls should be on the done chunk');
    assert.equal(done.toolCalls.length, 1);
    assert.equal(done.toolCalls[0].id, 'call_1');
    assert.equal(done.toolCalls[0].name, 'search');
    assert.deepEqual(done.toolCalls[0].input, { q: 'widgets' });
    assert.equal(done.stopReason, 'tool_use');
  } finally {
    global.fetch = origFetch;
  }
});

test('OpenAI-compat _stream: multiple parallel tool_calls (different indices) — all surface on done', async () => {
  const OpenAICompatibleLLMService = require('../lib/providers/openai-compatible');
  const svc = new OpenAICompatibleLLMService('llm', null, {
    credentials: { apiKey: 'sk-fake', baseUrl: 'http://127.0.0.1:65535/v1' },
    modelId: 'gpt-4o',
  });
  await svc.init();

  const events = [
    { choices: [{ delta: { tool_calls: [
      { index: 0, id: 'a', function: { name: 'ta', arguments: '{}' } },
      { index: 1, id: 'b', function: { name: 'tb', arguments: '{"x":1}' } },
    ] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
  ];
  const sseBody = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
  const origFetch = global.fetch;
  global.fetch = async () => ({
    ok: true, status: 200, headers: new Headers(),
    body: (async function* () { yield new TextEncoder().encode(sseBody); })(),
  });
  try {
    const chunks = [];
    for await (const c of svc._stream({
      model: 'gpt-4o', maxTokens: 100, system: null,
      messages: [{ role: 'user', content: 'x' }],
    })) chunks.push(c);
    const done = chunks.find(c => c.type === 'done');
    assert.equal(done.toolCalls.length, 2);
    assert.deepEqual(done.toolCalls.map(t => t.name).sort(), ['ta', 'tb']);
    const tb = done.toolCalls.find(t => t.name === 'tb');
    assert.deepEqual(tb.input, { x: 1 });
  } finally {
    global.fetch = origFetch;
  }
});

test('OpenAI-compat _stream: text_delta chunks still yielded alongside tool-call accumulation', async () => {
  const OpenAICompatibleLLMService = require('../lib/providers/openai-compatible');
  const svc = new OpenAICompatibleLLMService('llm', null, {
    credentials: { apiKey: 'sk-fake', baseUrl: 'http://127.0.0.1:65535/v1' },
    modelId: 'gpt-4o',
  });
  await svc.init();

  const events = [
    { choices: [{ delta: { content: 'let me ' } }] },
    { choices: [{ delta: { content: 'search' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 't', arguments: '{}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 3 } },
  ];
  const sseBody = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
  const origFetch = global.fetch;
  global.fetch = async () => ({
    ok: true, status: 200, headers: new Headers(),
    body: (async function* () { yield new TextEncoder().encode(sseBody); })(),
  });
  try {
    const chunks = [];
    for await (const c of svc._stream({
      model: 'gpt-4o', maxTokens: 100, system: null,
      messages: [{ role: 'user', content: 'x' }],
    })) chunks.push(c);
    const deltas = chunks.filter(c => c.type === 'text_delta').map(c => c.text);
    assert.deepEqual(deltas, ['let me ', 'search']);
    const done = chunks.find(c => c.type === 'done');
    assert.equal(done.text, 'let me search');
    assert.equal(done.toolCalls[0].name, 't');
  } finally {
    global.fetch = origFetch;
  }
});

// ---- Anthropic stream: toolCalls surface on done ----------------------

test('Anthropic _stream: tool_use content blocks surface as toolCalls on done chunk', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-fake';
  const AnthropicLLMService = require('../lib/providers/anthropic');
  const svc = new AnthropicLLMService('llm', null, { modelId: 'claude-opus-4-7', maxTokens: 100 });
  await svc.init();

  const fakeMessage = {
    content: [
      { type: 'text', text: 'let me check' },
      { type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: 'widgets' } },
    ],
    usage: { input_tokens: 5, output_tokens: 8 },
    stop_reason: 'tool_use',
    model: 'claude-opus-4-7',
  };

  const fakeStream = {
    finalMessage: async () => fakeMessage,
    [Symbol.asyncIterator]: async function* () {
      // Emit one text_delta so the outer stream loop yields it too.
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'let me check' } };
    },
    response: async () => ({ headers: new Headers(), status: 200 }),
  };
  svc.client = { messages: { stream: () => fakeStream } };

  const chunks = [];
  for await (const c of svc._stream({
    model: 'claude-opus-4-7', maxTokens: 100, system: null,
    messages: [{ role: 'user', content: 'find widgets' }],
  })) chunks.push(c);

  const deltas = chunks.filter(c => c.type === 'text_delta').map(c => c.text);
  assert.deepEqual(deltas, ['let me check']);
  const done = chunks.find(c => c.type === 'done');
  assert.ok(done.toolCalls, 'toolCalls should be on the done chunk');
  assert.equal(done.toolCalls.length, 1);
  assert.equal(done.toolCalls[0].id, 'toolu_1');
  assert.equal(done.toolCalls[0].name, 'search');
  assert.deepEqual(done.toolCalls[0].input, { q: 'widgets' });
});

test('Anthropic _stream: text-only response — no toolCalls field on done', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-fake';
  const AnthropicLLMService = require('../lib/providers/anthropic');
  const svc = new AnthropicLLMService('llm', null, { modelId: 'claude-opus-4-7', maxTokens: 100 });
  await svc.init();

  const fakeStream = {
    finalMessage: async () => ({
      content: [{ type: 'text', text: 'no tools needed' }],
      usage: { input_tokens: 5, output_tokens: 5 },
      stop_reason: 'end_turn',
      model: 'claude-opus-4-7',
    }),
    [Symbol.asyncIterator]: async function* () { /* no deltas */ },
    response: async () => ({ headers: new Headers(), status: 200 }),
  };
  svc.client = { messages: { stream: () => fakeStream } };

  const chunks = [];
  for await (const c of svc._stream({
    model: 'claude-opus-4-7', maxTokens: 100, system: null,
    messages: [{ role: 'user', content: 'hi' }],
  })) chunks.push(c);
  const done = chunks.find(c => c.type === 'done');
  assert.equal(done.toolCalls, undefined);
  assert.equal(done.text, 'no tools needed');
});
