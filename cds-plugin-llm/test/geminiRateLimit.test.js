const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_grl__';
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

const { parseGeminiRateLimit } = require('../lib/rateLimits');

// ---- Parser ----------------------------------------------------------

test('parseGeminiRateLimit: Vertex-style x-goog-quota headers → normalized snapshot', () => {
  const soon = Math.floor(Date.now() / 1000) + 60;
  const snap = parseGeminiRateLimit({
    'x-goog-quota-limit':     '60',
    'x-goog-quota-remaining': '42',
    'x-goog-quota-refresh':   String(soon),
  }, 200);
  assert.equal(snap.requestsLimit,     60);
  assert.equal(snap.requestsRemaining, 42);
  assert.match(snap.requestsResetAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(snap.tokensLimit,     undefined);
  assert.equal(snap.tokensRemaining, undefined);
  assert.equal(snap.retryAfterSeconds, undefined);
});

test('parseGeminiRateLimit: OpenAI-style x-ratelimit headers (API Gateway proxy)', () => {
  const snap = parseGeminiRateLimit({
    'x-ratelimit-limit-requests':     '5000',
    'x-ratelimit-remaining-requests': '4998',
    'x-ratelimit-reset-requests':     '1s',
  }, 200);
  assert.equal(snap.requestsLimit,     5000);
  assert.equal(snap.requestsRemaining, 4998);
  assert.match(snap.requestsResetAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('parseGeminiRateLimit: 429 with retry-after → retryAfterSeconds set', () => {
  const snap = parseGeminiRateLimit({ 'retry-after': '15' }, 429);
  assert.equal(snap.retryAfterSeconds, 15);
});

test('parseGeminiRateLimit: 200 with no rate-limit headers → null', () => {
  assert.equal(parseGeminiRateLimit({}, 200), null);
});

test('parseGeminiRateLimit: Vertex takes precedence when both header families present', () => {
  const snap = parseGeminiRateLimit({
    'x-goog-quota-limit':             '60',
    'x-goog-quota-remaining':         '30',
    'x-ratelimit-limit-requests':     '99999',
    'x-ratelimit-remaining-requests': '99998',
  }, 200);
  assert.equal(snap.requestsLimit,     60,  'x-goog-quota-limit wins');
  assert.equal(snap.requestsRemaining, 30,  'x-goog-quota-remaining wins');
});

test('parseGeminiRateLimit: accepts a Headers-like object with .get()', () => {
  const h = new Headers({
    'x-goog-quota-limit': '60',
    'x-goog-quota-remaining': '10',
  });
  const snap = parseGeminiRateLimit(h, 200);
  assert.equal(snap.requestsLimit, 60);
  assert.equal(snap.requestsRemaining, 10);
});

// ---- Gemini provider wiring end-to-end -------------------------------

test('Gemini _chat: attaches _rateLimit when Vertex-style headers present', async () => {
  const GeminiLLMService = require('../lib/providers/gemini');
  const svc = new GeminiLLMService('llm', null, {
    credentials: { apiKey: 'gcp-fake' },
    modelId: 'gemini-2.5-flash',
  });
  await svc.init();
  const soon = Math.floor(Date.now() / 1000) + 60;
  const origFetch = global.fetch;
  global.fetch = async () => ({
    ok: true, status: 200,
    headers: new Headers({
      'x-goog-quota-limit':     '60',
      'x-goog-quota-remaining': '42',
      'x-goog-quota-refresh':   String(soon),
    }),
    json: async () => ({
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
    }),
  });
  try {
    const res = await svc._chat({
      model: 'gemini-2.5-flash', maxTokens: 100, system: null,
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.ok(res._rateLimit, 'result carries _rateLimit');
    assert.equal(res._rateLimit.requestsRemaining, 42);
    assert.equal(res._rateLimit.requestsLimit, 60);
  } finally { global.fetch = origFetch; }
});

test('Gemini _chat: gracefully omits _rateLimit when no headers', async () => {
  const GeminiLLMService = require('../lib/providers/gemini');
  const svc = new GeminiLLMService('llm', null, {
    credentials: { apiKey: 'gcp-fake' },
    modelId: 'gemini-2.5-flash',
  });
  await svc.init();
  const origFetch = global.fetch;
  global.fetch = async () => ({
    ok: true, status: 200,
    headers: new Headers({}),
    json: async () => ({
      candidates: [{ content: { parts: [{ text: 'plain' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    }),
  });
  try {
    const res = await svc._chat({
      model: 'gemini-2.5-flash', maxTokens: 100, system: null,
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(res._rateLimit, undefined);
    assert.equal(res.text, 'plain');
  } finally { global.fetch = origFetch; }
});

test('Gemini _stream: attaches _rateLimit on done chunk', async () => {
  const GeminiLLMService = require('../lib/providers/gemini');
  const svc = new GeminiLLMService('llm', null, {
    credentials: { apiKey: 'gcp-fake' },
    modelId: 'gemini-2.5-flash',
  });
  await svc.init();
  const frames = [{ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }];
  const sseBody = frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join('');
  const origFetch = global.fetch;
  global.fetch = async () => ({
    ok: true, status: 200,
    headers: new Headers({
      'x-goog-quota-limit':     '60',
      'x-goog-quota-remaining': '7',
    }),
    body: (async function* () { yield new TextEncoder().encode(sseBody); })(),
  });
  try {
    const chunks = [];
    for await (const c of svc._stream({
      model: 'gemini-2.5-flash', maxTokens: 100, system: null,
      messages: [{ role: 'user', content: 'hi' }],
    })) chunks.push(c);
    const done = chunks.find(c => c.type === 'done');
    assert.ok(done._rateLimit);
    assert.equal(done._rateLimit.requestsRemaining, 7);
  } finally { global.fetch = origFetch; }
});

// ---- End-to-end with usageMetering ----------------------------------

test('usageMetering.rateLimits(): records Gemini snapshot end-to-end', async () => {
  const { usageMetering } = require('../lib/middleware/usageMetering');
  const GeminiLLMService = require('../lib/providers/gemini');
  const svc = new GeminiLLMService('llm', null, {
    credentials: { apiKey: 'gcp-fake' },
    modelId: 'gemini-2.5-flash',
  });
  await svc.init();
  const origFetch = global.fetch;
  global.fetch = async () => ({
    ok: true, status: 200,
    headers: new Headers({ 'x-goog-quota-limit': '60', 'x-goog-quota-remaining': '17' }),
    json: async () => ({
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 2 },
    }),
  });
  try {
    const meter = usageMetering({ providerOf: () => 'gemini' });
    svc.use(meter);
    await svc.chat({ messages: [{ role: 'user', content: 'x' }] });
    assert.equal(meter.rateLimits('gemini').requestsRemaining, 17);
    assert.equal(meter.rateLimits('gemini').requestsLimit,     60);
  } finally { global.fetch = origFetch; }
});
