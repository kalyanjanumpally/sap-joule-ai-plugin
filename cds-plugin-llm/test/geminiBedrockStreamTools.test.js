const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_gbst__';
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

// ---- Gemini _stream: functionCall parts surface as toolCalls on done ----

test('Gemini _stream: functionCall part surfaces as toolCalls with stopReason=tool_use', async () => {
  const GeminiLLMService = require('../lib/providers/gemini');
  const svc = new GeminiLLMService('llm', null, {
    credentials: { apiKey: 'gcp-fake' },
    modelId: 'gemini-2.5-flash',
  });
  await svc.init();

  // Two SSE frames: first a text delta, then a functionCall + usageMetadata.
  const frames = [
    { candidates: [{ content: { parts: [{ text: 'let me check' }] } }] },
    {
      candidates: [{ content: { parts: [{ functionCall: { name: 'search', args: { q: 'widgets' } } }] } }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 6 },
    },
  ];
  const sseBody = frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join('');

  const origFetch = global.fetch;
  global.fetch = async () => ({
    ok: true, status: 200, headers: new Headers(),
    body: (async function* () { yield new TextEncoder().encode(sseBody); })(),
  });
  try {
    const chunks = [];
    for await (const c of svc._stream({
      model: 'gemini-2.5-flash', maxTokens: 100, system: null,
      messages: [{ role: 'user', content: 'find widgets' }],
    })) chunks.push(c);
    const done = chunks.find(c => c.type === 'done');
    assert.ok(done, 'done chunk must be present');
    assert.ok(done.toolCalls, 'toolCalls on done chunk');
    assert.equal(done.toolCalls.length, 1);
    assert.equal(done.toolCalls[0].name, 'search');
    assert.deepEqual(done.toolCalls[0].input, { q: 'widgets' });
    assert.equal(done.stopReason, 'tool_use');
    const deltas = chunks.filter(c => c.type === 'text_delta').map(c => c.text);
    assert.deepEqual(deltas, ['let me check']);
  } finally {
    global.fetch = origFetch;
  }
});

test('Gemini _stream: text-only response — no toolCalls field on done', async () => {
  const GeminiLLMService = require('../lib/providers/gemini');
  const svc = new GeminiLLMService('llm', null, {
    credentials: { apiKey: 'gcp-fake' },
    modelId: 'gemini-2.5-flash',
  });
  await svc.init();
  const frames = [
    { candidates: [{ content: { parts: [{ text: 'plain answer' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3 } },
  ];
  const sseBody = frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join('');
  const origFetch = global.fetch;
  global.fetch = async () => ({
    ok: true, status: 200, headers: new Headers(),
    body: (async function* () { yield new TextEncoder().encode(sseBody); })(),
  });
  try {
    const chunks = [];
    for await (const c of svc._stream({
      model: 'gemini-2.5-flash', maxTokens: 100, system: null,
      messages: [{ role: 'user', content: 'hi' }],
    })) chunks.push(c);
    const done = chunks.find(c => c.type === 'done');
    assert.equal(done.toolCalls, undefined);
    assert.equal(done.text, 'plain answer');
    assert.equal(done.stopReason, 'STOP');
  } finally {
    global.fetch = origFetch;
  }
});

test('Gemini _stream: multiple functionCalls in one turn', async () => {
  const GeminiLLMService = require('../lib/providers/gemini');
  const svc = new GeminiLLMService('llm', null, {
    credentials: { apiKey: 'gcp-fake' },
    modelId: 'gemini-2.5-flash',
  });
  await svc.init();
  const frames = [
    { candidates: [{ content: { parts: [
      { functionCall: { name: 'a', args: { x: 1 } } },
      { functionCall: { name: 'b', args: {} } },
    ] } }] },
  ];
  const sseBody = frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join('');
  const origFetch = global.fetch;
  global.fetch = async () => ({
    ok: true, status: 200, headers: new Headers(),
    body: (async function* () { yield new TextEncoder().encode(sseBody); })(),
  });
  try {
    const chunks = [];
    for await (const c of svc._stream({
      model: 'gemini-2.5-flash', maxTokens: 100, system: null,
      messages: [{ role: 'user', content: 'x' }],
    })) chunks.push(c);
    const done = chunks.find(c => c.type === 'done');
    assert.equal(done.toolCalls.length, 2);
    assert.deepEqual(done.toolCalls.map(t => t.name).sort(), ['a', 'b']);
    const a = done.toolCalls.find(t => t.name === 'a');
    assert.deepEqual(a.input, { x: 1 });
  } finally {
    global.fetch = origFetch;
  }
});

// ---- Bedrock _stream: contentBlockStart + contentBlockDelta accumulation

test('Bedrock _stream: toolUse start + input deltas → toolCalls on done', async () => {
  const BedrockLLMService = require('../lib/providers/bedrock');
  const svc = new BedrockLLMService('llm', null, {
    credentials: { region: 'us-east-1' },
    modelId: 'anthropic.claude-opus-4-7-v1:0',
  });
  // Bypass real SDK init — inject a fake SDK + client that returns our scripted stream.
  svc._sdk = { ConverseStreamCommand: class { constructor(p) { this.params = p; } } };
  svc.client = {
    async send() {
      return {
        stream: (async function* () {
          yield { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'tu_1', name: 'search' } } } };
          yield { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"q"' } } } };
          yield { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: ':"widgets"}' } } } };
          yield { messageStop: { stopReason: 'tool_use' } };
          yield { metadata: { usage: { inputTokens: 5, outputTokens: 8 } } };
        })(),
      };
    },
  };

  const chunks = [];
  for await (const c of svc._stream({
    model: 'anthropic.claude-opus-4-7-v1:0', maxTokens: 100, system: null,
    messages: [{ role: 'user', content: 'find widgets' }],
  })) chunks.push(c);
  const done = chunks.find(c => c.type === 'done');
  assert.ok(done, 'done chunk must be present');
  assert.ok(done.toolCalls, 'toolCalls on done chunk');
  assert.equal(done.toolCalls.length, 1);
  assert.equal(done.toolCalls[0].id, 'tu_1');
  assert.equal(done.toolCalls[0].name, 'search');
  assert.deepEqual(done.toolCalls[0].input, { q: 'widgets' });
  assert.equal(done.stopReason, 'tool_use');
  assert.equal(done.usage.input_tokens,  5);
  assert.equal(done.usage.output_tokens, 8);
});

test('Bedrock _stream: text-only response — no toolCalls, stopReason preserved', async () => {
  const BedrockLLMService = require('../lib/providers/bedrock');
  const svc = new BedrockLLMService('llm', null, {
    credentials: { region: 'us-east-1' },
    modelId: 'anthropic.claude-opus-4-7-v1:0',
  });
  svc._sdk = { ConverseStreamCommand: class { constructor(p) { this.params = p; } } };
  svc.client = {
    async send() {
      return {
        stream: (async function* () {
          yield { contentBlockDelta: { delta: { text: 'hello ' } } };
          yield { contentBlockDelta: { delta: { text: 'world' } } };
          yield { messageStop: { stopReason: 'end_turn' } };
        })(),
      };
    },
  };
  const chunks = [];
  for await (const c of svc._stream({
    model: 'anthropic.claude-opus-4-7-v1:0', maxTokens: 100, system: null,
    messages: [{ role: 'user', content: 'hi' }],
  })) chunks.push(c);
  const done = chunks.find(c => c.type === 'done');
  assert.equal(done.text, 'hello world');
  assert.equal(done.toolCalls, undefined);
  assert.equal(done.stopReason, 'end_turn');
});

test('Bedrock _stream: multiple parallel tool_use blocks (different indices)', async () => {
  const BedrockLLMService = require('../lib/providers/bedrock');
  const svc = new BedrockLLMService('llm', null, {
    credentials: { region: 'us-east-1' },
    modelId: 'anthropic.claude-opus-4-7-v1:0',
  });
  svc._sdk = { ConverseStreamCommand: class { constructor(p) { this.params = p; } } };
  svc.client = {
    async send() {
      return {
        stream: (async function* () {
          yield { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'a', name: 'ta' } } } };
          yield { contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: 'b', name: 'tb' } } } };
          yield { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{}' } } } };
          yield { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"x":1}' } } } };
          yield { messageStop: { stopReason: 'tool_use' } };
        })(),
      };
    },
  };
  const chunks = [];
  for await (const c of svc._stream({
    model: 'anthropic.claude-opus-4-7-v1:0', maxTokens: 100, system: null,
    messages: [{ role: 'user', content: 'x' }],
  })) chunks.push(c);
  const done = chunks.find(c => c.type === 'done');
  assert.equal(done.toolCalls.length, 2);
  assert.deepEqual(done.toolCalls.map(t => t.name).sort(), ['ta', 'tb']);
  const tb = done.toolCalls.find(t => t.name === 'tb');
  assert.deepEqual(tb.input, { x: 1 });
});
