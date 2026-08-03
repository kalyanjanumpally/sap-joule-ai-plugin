const { test } = require('node:test');
const assert = require('node:assert/strict');

// Stub @sap/cds so tests run without installing it.
const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_bedrock__';
require.cache[STUB_PATH] = {
  exports: {
    Service: class { constructor(name, model, options) { this.options = options ?? {}; } async init() {} },
    log: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  },
  loaded: true,
};

// Stub @aws-sdk/client-bedrock-runtime BEFORE requiring the provider.
// The provider imports the SDK lazily inside init(), so we can inject the
// stub via require.cache — no real AWS calls, no network.
const AWS_STUB_PATH = '/tmp/__aws_bedrock_stub__';
const sdkCalls = [];   // records every command sent
let sdkResponse;       // per-test scripted response
let sdkStreamEvents;   // per-test scripted stream events
require.cache[AWS_STUB_PATH] = {
  exports: {
    BedrockRuntimeClient: class {
      constructor(opts) { this.opts = opts; sdkCalls.push({ type: 'ctor', opts }); }
      async send(cmd) {
        sdkCalls.push({ type: cmd.__type, input: cmd.input });
        if (cmd.__type === 'ConverseStreamCommand') {
          return { stream: (async function*() { for (const e of sdkStreamEvents ?? []) yield e; })() };
        }
        if (cmd.__type === 'InvokeModelCommand') {
          return { body: new TextEncoder().encode(JSON.stringify(sdkResponse)) };
        }
        return sdkResponse;
      }
    },
    ConverseCommand: class { constructor(input) { this.__type = 'ConverseCommand'; this.input = input; } },
    ConverseStreamCommand: class { constructor(input) { this.__type = 'ConverseStreamCommand'; this.input = input; } },
    InvokeModelCommand: class { constructor(input) { this.__type = 'InvokeModelCommand'; this.input = input; } },
  },
  loaded: true,
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function(request, ...rest) {
  if (request === '@sap/cds') return STUB_PATH;
  if (request === '@aws-sdk/client-bedrock-runtime') return AWS_STUB_PATH;
  return origResolve.call(this, request, ...rest);
};

const BedrockLLMService = require('../lib/providers/bedrock');

function reset() {
  sdkCalls.length = 0;
  sdkResponse = undefined;
  sdkStreamEvents = undefined;
}

function makeSvc(credsOverrides = {}) {
  return new BedrockLLMService('llm', null, {
    modelId: 'anthropic.claude-opus-4-20250514-v1:0',
    credentials: {
      region: 'us-east-1',
      accessKeyId: 'AKIA_TEST',
      secretAccessKey: 'secret_test',
      ...credsOverrides,
    },
  });
}

// ---- init ---------------------------------------------------------------

test('Bedrock: init requires region (via credentials or env)', async () => {
  const savedR = process.env.AWS_REGION;
  const savedDR = process.env.AWS_DEFAULT_REGION;
  delete process.env.AWS_REGION;
  delete process.env.AWS_DEFAULT_REGION;
  try {
    const svc = new BedrockLLMService('llm', null, { modelId: 'x', credentials: {} });
    await assert.rejects(() => svc.init(), /region.*AWS_REGION/);
  } finally {
    if (savedR !== undefined) process.env.AWS_REGION = savedR;
    if (savedDR !== undefined) process.env.AWS_DEFAULT_REGION = savedDR;
  }
});

test('Bedrock: init picks up region from env when not in credentials', async () => {
  const saved = process.env.AWS_REGION;
  process.env.AWS_REGION = 'eu-central-1';
  try {
    const svc = new BedrockLLMService('llm', null, { modelId: 'x', credentials: {} });
    await svc.init();
    assert.equal(svc.region, 'eu-central-1');
  } finally {
    if (saved === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = saved;
  }
});

test('Bedrock: init passes accessKeyId + secretAccessKey to SDK client when both set', async () => {
  reset();
  const svc = makeSvc();
  await svc.init();
  const ctor = sdkCalls.find(c => c.type === 'ctor');
  assert.equal(ctor.opts.credentials.accessKeyId, 'AKIA_TEST');
  assert.equal(ctor.opts.credentials.secretAccessKey, 'secret_test');
  // No sessionToken when not provided
  assert.equal(ctor.opts.credentials.sessionToken, undefined);
});

test('Bedrock: init passes sessionToken when provided (temporary credentials)', async () => {
  reset();
  const svc = makeSvc({ sessionToken: 'temp-session-xyz' });
  await svc.init();
  const ctor = sdkCalls.find(c => c.type === 'ctor');
  assert.equal(ctor.opts.credentials.sessionToken, 'temp-session-xyz');
});

test('Bedrock: init omits credentials block when accessKeyId is missing (SDK default chain)', async () => {
  reset();
  const svc = new BedrockLLMService('llm', null, {
    modelId: 'x', credentials: { region: 'us-east-1' },
  });
  await svc.init();
  const ctor = sdkCalls.find(c => c.type === 'ctor');
  assert.equal(ctor.opts.credentials, undefined);
});

test('Bedrock: init opts maxAttempts=1 (base LLMService handles retry)', async () => {
  reset();
  const svc = makeSvc();
  await svc.init();
  const ctor = sdkCalls.find(c => c.type === 'ctor');
  assert.equal(ctor.opts.maxAttempts, 1);
});

test('Bedrock: init defaults modelId + embeddingModel', async () => {
  reset();
  const svc = new BedrockLLMService('llm', null, {
    credentials: { region: 'us-east-1' },
  });
  await svc.init();
  assert.match(svc.modelId, /^anthropic\.claude/);
  assert.equal(svc.embeddingModel, 'amazon.titan-embed-text-v2:0');
});

// ---- chat ---------------------------------------------------------------

test('Bedrock: chat sends ConverseCommand with modelId + messages + inferenceConfig', async () => {
  reset();
  sdkResponse = {
    output: { message: { role: 'assistant', content: [{ text: 'Hello!' }] } },
    stopReason: 'end_turn',
    usage: { inputTokens: 5, outputTokens: 3 },
  };
  const svc = makeSvc(); await svc.init();
  const res = await svc.chat({
    system: 'be terse',
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 128,
  });
  const call = sdkCalls.find(c => c.type === 'ConverseCommand');
  assert.equal(call.input.modelId, svc.modelId);
  assert.deepEqual(call.input.system, [{ text: 'be terse' }]);
  assert.deepEqual(call.input.messages, [{ role: 'user', content: [{ text: 'hi' }] }]);
  assert.equal(call.input.inferenceConfig.maxTokens, 128);
  assert.equal(res.text, 'Hello!');
  assert.equal(res.usage.input_tokens, 5);
  assert.equal(res.usage.output_tokens, 3);
  assert.equal(res.stopReason, 'end_turn');
});

test('Bedrock: system message in messages array is a caller error', async () => {
  const svc = makeSvc(); await svc.init();
  await assert.rejects(
    () => svc.chat({ messages: [{ role: 'system', content: 'x' }] }),
    /system messages belong in the `system` field/,
  );
});

test('Bedrock: tools translated to toolConfig.tools[].toolSpec shape', async () => {
  reset();
  sdkResponse = { output: { message: { content: [{ text: '' }] } }, stopReason: 'end_turn', usage: {} };
  const svc = makeSvc(); await svc.init();
  await svc.chat({
    messages: [{ role: 'user', content: 'call it' }],
    tools: [{ name: 'get_weather', description: 'get w', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
  });
  const call = sdkCalls.find(c => c.type === 'ConverseCommand');
  assert.equal(call.input.toolConfig.tools.length, 1);
  const spec = call.input.toolConfig.tools[0].toolSpec;
  assert.equal(spec.name, 'get_weather');
  assert.equal(spec.description, 'get w');
  assert.deepEqual(spec.inputSchema.json.type, 'object');
});

test('Bedrock: toolUse blocks parsed from response into unified toolCalls', async () => {
  reset();
  sdkResponse = {
    output: {
      message: {
        role: 'assistant',
        content: [
          { text: 'looking up' },
          { toolUse: { toolUseId: 'tu_123', name: 'get_weather', input: { city: 'Berlin' } } },
        ],
      },
    },
    stopReason: 'tool_use',
    usage: { inputTokens: 4, outputTokens: 8 },
  };
  const svc = makeSvc(); await svc.init();
  const res = await svc.chat({ messages: [{ role: 'user', content: 'weather?' }] });
  assert.equal(res.text, 'looking up');
  assert.equal(res.toolCalls.length, 1);
  assert.equal(res.toolCalls[0].id, 'tu_123');
  assert.equal(res.toolCalls[0].name, 'get_weather');
  assert.deepEqual(res.toolCalls[0].input, { city: 'Berlin' });
  assert.equal(res.stopReason, 'tool_use');
});

test('Bedrock: image base64 block → image content block with correct format', async () => {
  reset();
  sdkResponse = { output: { message: { content: [{ text: '' }] } }, stopReason: 'end_turn', usage: {} };
  const svc = makeSvc(); await svc.init();
  await svc.chat({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
      ],
    }],
  });
  const call = sdkCalls.find(c => c.type === 'ConverseCommand');
  const parts = call.input.messages[0].content;
  assert.equal(parts.length, 2);
  assert.equal(parts[0].text, 'what is this?');
  assert.equal(parts[1].image.format, 'jpeg');
  assert.ok(Buffer.isBuffer(parts[1].image.source.bytes));
});

test('Bedrock: image with unsupported media_type throws', async () => {
  const svc = makeSvc(); await svc.init();
  await assert.rejects(
    () => svc.chat({ messages: [{
      role: 'user',
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/tiff', data: 'AAAA' } }],
    }] }),
    /png\/jpeg\/gif\/webp/,
  );
});

test('Bedrock: image URL block throws (Converse does not fetch URLs)', async () => {
  const svc = makeSvc(); await svc.init();
  await assert.rejects(
    () => svc.chat({ messages: [{
      role: 'user',
      content: [{ type: 'image', source: { type: 'url', url: 'https://ex.com/x.png' } }],
    }] }),
    /base64/,
  );
});

test('Bedrock: tool_result blocks translated to Converse toolResult shape', async () => {
  reset();
  sdkResponse = { output: { message: { content: [{ text: 'ok' }] } }, stopReason: 'end_turn', usage: {} };
  const svc = makeSvc(); await svc.init();
  await svc.chat({
    messages: [{
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'sunny' }],
    }],
  });
  const call = sdkCalls.find(c => c.type === 'ConverseCommand');
  const tr = call.input.messages[0].content[0].toolResult;
  assert.equal(tr.toolUseId, 'tu_1');
  assert.deepEqual(tr.content, [{ text: 'sunny' }]);
  assert.equal(tr.status, undefined); // not an error
});

test('Bedrock: tool_result with is_error → status=error', async () => {
  reset();
  sdkResponse = { output: { message: { content: [{ text: 'ok' }] } }, stopReason: 'end_turn', usage: {} };
  const svc = makeSvc(); await svc.init();
  await svc.chat({
    messages: [{
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'failed', is_error: true }],
    }],
  });
  const call = sdkCalls.find(c => c.type === 'ConverseCommand');
  assert.equal(call.input.messages[0].content[0].toolResult.status, 'error');
});

// ---- embed --------------------------------------------------------------

test('Bedrock: embed with Titan model uses inputText body shape', async () => {
  reset();
  sdkResponse = { embedding: [0.1, 0.2, 0.3], inputTextTokenCount: 3 };
  const svc = makeSvc(); await svc.init();
  const res = await svc.embed({ input: 'hello world' });
  const call = sdkCalls.find(c => c.type === 'InvokeModelCommand');
  assert.equal(call.input.modelId, 'amazon.titan-embed-text-v2:0');
  assert.deepEqual(JSON.parse(call.input.body), { inputText: 'hello world' });
  assert.deepEqual(res.embeddings, [[0.1, 0.2, 0.3]]);
  assert.equal(res.model, 'amazon.titan-embed-text-v2:0');
});

test('Bedrock: embed with Cohere model uses texts + input_type body shape', async () => {
  reset();
  sdkResponse = { embeddings: [[0.5, 0.6, 0.7]] };
  const svc = makeSvc({ embeddingModel: 'cohere.embed-english-v3' });
  await svc.init();
  const res = await svc.embed({ input: 'hello' });
  const call = sdkCalls.find(c => c.type === 'InvokeModelCommand');
  assert.equal(call.input.modelId, 'cohere.embed-english-v3');
  const body = JSON.parse(call.input.body);
  assert.deepEqual(body.texts, ['hello']);
  assert.equal(body.input_type, 'search_document');
  assert.deepEqual(res.embeddings, [[0.5, 0.6, 0.7]]);
});

test('Bedrock: embed batches: multiple inputs → multiple InvokeModel calls', async () => {
  reset();
  const responses = [
    { embedding: [1, 1] },
    { embedding: [2, 2] },
    { embedding: [3, 3] },
  ];
  // Chain scripted responses by re-mounting the stub per call
  let i = 0;
  const svc = makeSvc(); await svc.init();
  // Monkey-patch client.send to return the next scripted embedding each call
  svc.client.send = async (cmd) => {
    if (cmd.__type !== 'InvokeModelCommand') throw new Error('unexpected cmd');
    return { body: new TextEncoder().encode(JSON.stringify(responses[i++])) };
  };
  const res = await svc.embed({ input: ['a', 'b', 'c'] });
  assert.equal(res.embeddings.length, 3);
  assert.deepEqual(res.embeddings, [[1, 1], [2, 2], [3, 3]]);
});

// ---- stream -------------------------------------------------------------

test('Bedrock: stream yields text_delta chunks then a final done event', async () => {
  reset();
  sdkStreamEvents = [
    { contentBlockDelta: { delta: { text: 'Hello' } } },
    { contentBlockDelta: { delta: { text: ' world' } } },
    { messageStop: { stopReason: 'end_turn' } },
    { metadata: { usage: { inputTokens: 4, outputTokens: 5 } } },
  ];
  const svc = makeSvc(); await svc.init();
  const chunks = [];
  for await (const c of svc.stream({ messages: [{ role: 'user', content: 'hi' }] })) chunks.push(c);
  const deltas = chunks.filter(c => c.type === 'text_delta').map(c => c.text);
  assert.deepEqual(deltas, ['Hello', ' world']);
  const done = chunks[chunks.length - 1];
  assert.equal(done.type, 'done');
  assert.equal(done.text, 'Hello world');
  assert.equal(done.stopReason, 'end_turn');
  assert.equal(done.usage.input_tokens, 4);
  assert.equal(done.usage.output_tokens, 5);
});

// ---- SDK missing -------------------------------------------------------

test('Bedrock: init throws a clear error if the AWS SDK is not installed', async () => {
  // Temporarily unlink the stub from require.cache and resolve
  const savedCache = require.cache[AWS_STUB_PATH];
  delete require.cache[AWS_STUB_PATH];
  const origResolve2 = Module._resolveFilename;
  Module._resolveFilename = function(request, ...rest) {
    if (request === '@aws-sdk/client-bedrock-runtime') {
      const e = new Error(`Cannot find module '${request}'`);
      e.code = 'MODULE_NOT_FOUND';
      throw e;
    }
    if (request === '@sap/cds') return STUB_PATH;
    return origResolve.call(this, request, ...rest);
  };
  try {
    const svc = new BedrockLLMService('llm', null, {
      credentials: { region: 'us-east-1' },
    });
    await assert.rejects(() => svc.init(), /@aws-sdk\/client-bedrock-runtime/);
  } finally {
    Module._resolveFilename = origResolve2;
    require.cache[AWS_STUB_PATH] = savedCache;
  }
});

// ---- CLI providerFactory integration ------------------------------------

test('providerFactory: bedrock kind builds BedrockLLMService with region', async () => {
  const { buildProvider } = require('../lib/cli/providerFactory');
  const { provider, kind, model } = await buildProvider({
    opts: { provider: 'bedrock' },
    env: { AWS_REGION: 'us-west-2' },
  });
  assert.equal(kind, 'bedrock');
  assert.match(model, /^anthropic\.claude/);
  assert.equal(provider.constructor.name, 'BedrockLLMService');
  assert.equal(provider.options.credentials.region, 'us-west-2');
});

test('providerFactory: bedrock forwards accessKeyId + secretAccessKey when in env', async () => {
  const { buildProvider } = require('../lib/cli/providerFactory');
  const { provider } = await buildProvider({
    opts: { provider: 'bedrock' },
    env: {
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'AKIA_ENV',
      AWS_SECRET_ACCESS_KEY: 'secret_env',
      AWS_SESSION_TOKEN: 'temp_env',
    },
  });
  assert.equal(provider.options.credentials.accessKeyId, 'AKIA_ENV');
  assert.equal(provider.options.credentials.secretAccessKey, 'secret_env');
  assert.equal(provider.options.credentials.sessionToken, 'temp_env');
});

test('providerFactory: bedrock throws with helpful message when region missing', async () => {
  const { buildProvider } = require('../lib/cli/providerFactory');
  await assert.rejects(
    () => buildProvider({ opts: { provider: 'bedrock' }, env: {} }),
    /AWS_REGION/,
  );
});
