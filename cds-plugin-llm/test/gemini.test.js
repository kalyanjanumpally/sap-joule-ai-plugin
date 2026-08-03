const { test } = require('node:test');
const assert = require('node:assert/strict');

// Stub @sap/cds so tests run without installing it.
const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_gemini__';
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

const GeminiLLMService = require('../lib/providers/gemini');

function makeSvc(overrides = {}) {
  return new GeminiLLMService('llm', null, {
    modelId: 'gemini-1.5-flash',
    credentials: { apiKey: 'test-key-abc', ...overrides },
  });
}

// ---- init ---------------------------------------------------------------

test('Gemini: init picks up credentials.apiKey', async () => {
  const svc = makeSvc();
  await svc.init();
  assert.equal(svc.apiKey, 'test-key-abc');
});

test('Gemini: init falls back to GOOGLE_API_KEY env', async () => {
  const saved = process.env.GOOGLE_API_KEY;
  process.env.GOOGLE_API_KEY = 'env-key-google';
  try {
    const svc = new GeminiLLMService('llm', null, { modelId: 'gemini-1.5-flash', credentials: {} });
    await svc.init();
    assert.equal(svc.apiKey, 'env-key-google');
  } finally {
    if (saved === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = saved;
  }
});

test('Gemini: init falls back to GEMINI_API_KEY env when GOOGLE_API_KEY missing', async () => {
  const savedG = process.env.GOOGLE_API_KEY;
  const savedM = process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  process.env.GEMINI_API_KEY = 'env-key-gemini';
  try {
    const svc = new GeminiLLMService('llm', null, { modelId: 'gemini-1.5-flash', credentials: {} });
    await svc.init();
    assert.equal(svc.apiKey, 'env-key-gemini');
  } finally {
    if (savedG !== undefined) process.env.GOOGLE_API_KEY = savedG;
    if (savedM === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = savedM;
  }
});

test('Gemini: init throws when no apiKey anywhere', async () => {
  const savedG = process.env.GOOGLE_API_KEY;
  const savedM = process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const svc = new GeminiLLMService('llm', null, { modelId: 'gemini-1.5-flash', credentials: {} });
    await assert.rejects(() => svc.init(), /apiKey.*GOOGLE_API_KEY.*GEMINI_API_KEY/);
  } finally {
    if (savedG !== undefined) process.env.GOOGLE_API_KEY = savedG;
    if (savedM !== undefined) process.env.GEMINI_API_KEY = savedM;
  }
});

test('Gemini: init defaults modelId, baseUrl, embeddingModel', async () => {
  const svc = new GeminiLLMService('llm', null, { credentials: { apiKey: 'k' } });
  await svc.init();
  assert.equal(svc.modelId, 'gemini-1.5-flash');
  assert.equal(svc.baseUrl, 'https://generativelanguage.googleapis.com');
  assert.equal(svc.embeddingModel, 'text-embedding-004');
});

test('Gemini: init strips trailing slash on baseUrl', async () => {
  const svc = makeSvc({ baseUrl: 'https://gen-lang.example.com/' });
  await svc.init();
  assert.equal(svc.baseUrl, 'https://gen-lang.example.com');
});

// ---- endpoint URLs ------------------------------------------------------

test('Gemini: _chatEndpoint uses the request model, not the default', async () => {
  const svc = makeSvc();
  await svc.init();
  assert.equal(
    svc._chatEndpoint('gemini-2.0-pro'),
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-pro:generateContent',
  );
});

test('Gemini: _streamEndpoint uses alt=sse', async () => {
  const svc = makeSvc();
  await svc.init();
  assert.match(svc._streamEndpoint('gemini-1.5-flash'), /:streamGenerateContent\?alt=sse$/);
});

test('Gemini: _embedEndpoint / _batchEmbedEndpoint patterns', async () => {
  const svc = makeSvc();
  await svc.init();
  assert.match(svc._embedEndpoint('text-embedding-004'), /:embedContent$/);
  assert.match(svc._batchEmbedEndpoint('text-embedding-004'), /:batchEmbedContents$/);
});

// ---- chat ---------------------------------------------------------------

function mockFetch({ status = 200, body }) {
  const captured = {};
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    captured.url = url;
    captured.headers = opts.headers;
    captured.body = JSON.parse(opts.body);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  return { captured, restore: () => { globalThis.fetch = originalFetch; } };
}

test('Gemini: chat sends contents + x-goog-api-key header', async () => {
  const { captured, restore } = mockFetch({
    body: {
      candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 },
    },
  });
  try {
    const svc = makeSvc();
    await svc.init();
    const res = await svc.chat({ messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(res.text, 'hi');
    assert.equal(res.usage.input_tokens, 3);
    assert.equal(res.usage.output_tokens, 1);
    assert.match(captured.url, /:generateContent$/);
    assert.equal(captured.headers['x-goog-api-key'], 'test-key-abc');
    assert.deepEqual(captured.body.contents, [{ role: 'user', parts: [{ text: 'hello' }] }]);
  } finally { restore(); }
});

test('Gemini: chat maps assistant role to model', async () => {
  const { captured, restore } = mockFetch({
    body: { candidates: [{ content: { parts: [{ text: 'ok' }] } }] },
  });
  try {
    const svc = makeSvc(); await svc.init();
    await svc.chat({ messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'and?' },
    ] });
    assert.deepEqual(captured.body.contents.map(c => c.role), ['user', 'model', 'user']);
  } finally { restore(); }
});

test('Gemini: system prompt goes into systemInstruction, not messages', async () => {
  const { captured, restore } = mockFetch({
    body: { candidates: [{ content: { parts: [{ text: 'ok' }] } }] },
  });
  try {
    const svc = makeSvc(); await svc.init();
    await svc.chat({ system: 'be terse', messages: [{ role: 'user', content: 'hi' }] });
    assert.deepEqual(captured.body.systemInstruction, { parts: [{ text: 'be terse' }] });
  } finally { restore(); }
});

test('Gemini: system-role message in messages array is a caller error', async () => {
  const svc = makeSvc(); await svc.init();
  await assert.rejects(
    () => svc.chat({ messages: [{ role: 'system', content: 'x' }] }),
    /system messages belong in the `system` field/,
  );
});

test('Gemini: tools translated to functionDeclarations', async () => {
  const { captured, restore } = mockFetch({
    body: { candidates: [{ content: { parts: [{ text: '' }] } }] },
  });
  try {
    const svc = makeSvc(); await svc.init();
    await svc.chat({
      messages: [{ role: 'user', content: 'call it' }],
      tools: [
        { name: 'get_weather', description: 'get w', input_schema: { type: 'object', properties: { city: { type: 'string' } } } },
      ],
    });
    assert.equal(captured.body.tools.length, 1);
    assert.equal(captured.body.tools[0].functionDeclarations[0].name, 'get_weather');
    assert.equal(captured.body.tools[0].functionDeclarations[0].description, 'get w');
    assert.equal(captured.body.tools[0].functionDeclarations[0].parameters.type, 'object');
  } finally { restore(); }
});

test('Gemini: tool_use blocks parsed from response', async () => {
  const { restore } = mockFetch({
    body: {
      candidates: [{
        content: {
          parts: [
            { text: 'looking up' },
            { functionCall: { name: 'get_weather', args: { city: 'Berlin' } } },
          ],
        },
        finishReason: 'STOP',
      }],
    },
  });
  try {
    const svc = makeSvc(); await svc.init();
    const res = await svc.chat({ messages: [{ role: 'user', content: 'weather?' }] });
    assert.equal(res.text, 'looking up');
    assert.equal(res.toolCalls?.length, 1);
    assert.equal(res.toolCalls[0].name, 'get_weather');
    assert.deepEqual(res.toolCalls[0].input, { city: 'Berlin' });
    assert.equal(res.stopReason, 'tool_use');
  } finally { restore(); }
});

test('Gemini: format schema → responseMimeType JSON + sanitized responseSchema', async () => {
  const { captured, restore } = mockFetch({
    body: { candidates: [{ content: { parts: [{ text: '{}' }] } }] },
  });
  try {
    const svc = makeSvc(); await svc.init();
    await svc.chat({
      messages: [{ role: 'user', content: 'extract' }],
      format: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        additionalProperties: false,
        title: 'Extract',
        properties: { vendor: { type: 'string', title: 'Vendor' } },
      },
    });
    assert.equal(captured.body.generationConfig.responseMimeType, 'application/json');
    // Gemini rejects $schema/additionalProperties/title — sanitizer strips them
    const schema = captured.body.generationConfig.responseSchema;
    assert.equal(schema.$schema, undefined);
    assert.equal(schema.additionalProperties, undefined);
    assert.equal(schema.title, undefined);
    assert.equal(schema.properties.vendor.title, undefined);
    assert.equal(schema.properties.vendor.type, 'string');
  } finally { restore(); }
});

test('Gemini: image base64 block → inlineData part', async () => {
  const { captured, restore } = mockFetch({
    body: { candidates: [{ content: { parts: [{ text: '' }] } }] },
  });
  try {
    const svc = makeSvc(); await svc.init();
    await svc.chat({ messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ],
    }] });
    const parts = captured.body.contents[0].parts;
    assert.equal(parts.length, 2);
    assert.equal(parts[0].text, 'what is this?');
    assert.deepEqual(parts[1].inlineData, { mimeType: 'image/png', data: 'AAAA' });
  } finally { restore(); }
});

test('Gemini: image URL block throws (Google AI Studio does not fetch URLs)', async () => {
  const svc = makeSvc(); await svc.init();
  await assert.rejects(
    () => svc.chat({ messages: [{
      role: 'user',
      content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/x.png' } }],
    }] }),
    /base64/,
  );
});

test('Gemini: PDF/document blocks throw with a helpful message', async () => {
  const svc = makeSvc(); await svc.init();
  await assert.rejects(
    () => svc.chat({ messages: [{ role: 'user', content: [{ type: 'document', source: {} }] }] }),
    /PDF.*not yet supported/,
  );
});

// ---- embed --------------------------------------------------------------

test('Gemini: embed single input → :embedContent', async () => {
  const { captured, restore } = mockFetch({
    body: { embedding: { values: [0.1, 0.2, 0.3] } },
  });
  try {
    const svc = makeSvc(); await svc.init();
    const res = await svc.embed({ input: 'hello world' });
    assert.deepEqual(res.embeddings, [[0.1, 0.2, 0.3]]);
    assert.equal(res.model, 'text-embedding-004');
    assert.match(captured.url, /text-embedding-004:embedContent$/);
    assert.deepEqual(captured.body, { content: { parts: [{ text: 'hello world' }] } });
  } finally { restore(); }
});

test('Gemini: embed array input → :batchEmbedContents', async () => {
  const { captured, restore } = mockFetch({
    body: { embeddings: [{ values: [1, 2] }, { values: [3, 4] }] },
  });
  try {
    const svc = makeSvc(); await svc.init();
    const res = await svc.embed({ input: ['a', 'b'] });
    assert.deepEqual(res.embeddings, [[1, 2], [3, 4]]);
    assert.match(captured.url, /:batchEmbedContents$/);
    assert.equal(captured.body.requests.length, 2);
    assert.equal(captured.body.requests[0].content.parts[0].text, 'a');
  } finally { restore(); }
});

// ---- stream -------------------------------------------------------------

async function* asyncIter(chunks) {
  for (const c of chunks) yield new TextEncoder().encode(c);
}

test('Gemini: stream parses SSE frames and yields text_delta + done', async () => {
  const sseFrames = [
    'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n\n',
    'data: {"candidates":[{"content":{"parts":[{"text":" world"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":2}}\n\n',
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    body: asyncIter(sseFrames),
    headers: { get: () => null },
  });
  try {
    const svc = makeSvc(); await svc.init();
    const chunks = [];
    for await (const c of svc.stream({ messages: [{ role: 'user', content: 'hi' }] })) chunks.push(c);
    const deltas = chunks.filter(c => c.type === 'text_delta').map(c => c.text);
    assert.deepEqual(deltas, ['Hello', ' world']);
    const done = chunks[chunks.length - 1];
    assert.equal(done.type, 'done');
    assert.equal(done.text, 'Hello world');
    assert.equal(done.stopReason, 'STOP');
    assert.equal(done.usage.input_tokens, 2);
    assert.equal(done.usage.output_tokens, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test('Gemini: stream tolerates a frame split across two chunks', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    body: asyncIter([
      'data: {"candidates":[{"content":{"parts":[{"tex',
      't":"partial"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"!"}]},"finishReason":"STOP"}]}\n\n',
    ]),
    headers: { get: () => null },
  });
  try {
    const svc = makeSvc(); await svc.init();
    const chunks = [];
    for await (const c of svc.stream({ messages: [{ role: 'user', content: 'hi' }] })) chunks.push(c);
    const deltas = chunks.filter(c => c.type === 'text_delta').map(c => c.text);
    assert.deepEqual(deltas, ['partial', '!']);
  } finally { globalThis.fetch = originalFetch; }
});

// ---- CLI providerFactory integration ------------------------------------

test('providerFactory: gemini kind builds GeminiLLMService with GOOGLE_API_KEY', async () => {
  const { buildProvider } = require('../lib/cli/providerFactory');
  const { provider, kind, model } = await buildProvider({
    opts: { provider: 'gemini' },
    env: { GOOGLE_API_KEY: 'k' },
  });
  assert.equal(kind, 'gemini');
  assert.equal(model, 'gemini-1.5-flash');
  assert.equal(provider.constructor.name, 'GeminiLLMService');
});

test('providerFactory: gemini also accepts GEMINI_API_KEY', async () => {
  const { buildProvider } = require('../lib/cli/providerFactory');
  const { provider } = await buildProvider({
    opts: { provider: 'gemini' },
    env: { GEMINI_API_KEY: 'k2' },
  });
  assert.equal(provider.options.credentials.apiKey, 'k2');
});

test('providerFactory: gemini throws with helpful message when key missing', async () => {
  const { buildProvider } = require('../lib/cli/providerFactory');
  await assert.rejects(
    () => buildProvider({ opts: { provider: 'gemini' }, env: {} }),
    /GOOGLE_API_KEY.*GEMINI_API_KEY/,
  );
});
