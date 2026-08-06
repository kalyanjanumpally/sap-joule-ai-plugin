const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_brl__';
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

const { parseBedrockRateLimit } = require('../lib/rateLimits');

// ---- Parser ---------------------------------------------------------

test('parseBedrockRateLimit: 200 with no signals → null (Bedrock default)', () => {
  const snap = parseBedrockRateLimit({ $metadata: { httpStatusCode: 200, requestId: 'req_1' } });
  assert.equal(snap, null);
});

test('parseBedrockRateLimit: 429 with retryAfterHeader → retryAfterSeconds', () => {
  const snap = parseBedrockRateLimit({ $metadata: { httpStatusCode: 429, retryAfterHeader: '30' } });
  assert.equal(snap.retryAfterSeconds, 30);
  assert.equal(snap.requestsLimit, undefined);
  assert.equal(snap.requestsRemaining, undefined);
});

test('parseBedrockRateLimit: 503 with retryAfterHeader → retryAfterSeconds', () => {
  const snap = parseBedrockRateLimit({ $metadata: { httpStatusCode: 503, retryAfterHeader: '10' } });
  assert.equal(snap.retryAfterSeconds, 10);
});

test('parseBedrockRateLimit: statusCode arg overrides $metadata.httpStatusCode', () => {
  const snap = parseBedrockRateLimit(
    { $metadata: { httpStatusCode: 200, retryAfterHeader: '5' } },
    429,
  );
  assert.equal(snap.retryAfterSeconds, 5);
});

test('parseBedrockRateLimit: 200 with retryAfterHeader is ignored (not a throttle response)', () => {
  const snap = parseBedrockRateLimit({ $metadata: { httpStatusCode: 200, retryAfterHeader: '99' } });
  assert.equal(snap, null);
});

test('parseBedrockRateLimit: proxy-injected x-amzn-ratelimit-* via httpHeaders → normalized', () => {
  const snap = parseBedrockRateLimit({
    $metadata: {
      httpStatusCode: 200,
      httpHeaders: {
        'x-amzn-ratelimit-limit':     '100',
        'x-amzn-ratelimit-remaining': '42',
        'x-amzn-ratelimit-reset':     '5s',
      },
    },
  });
  assert.equal(snap.requestsLimit, 100);
  assert.equal(snap.requestsRemaining, 42);
  assert.match(snap.requestsResetAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('parseBedrockRateLimit: 429 falls back to httpHeaders retry-after when retryAfterHeader missing', () => {
  const snap = parseBedrockRateLimit({
    $metadata: {
      httpStatusCode: 429,
      httpHeaders: { 'retry-after': '20' },
    },
  });
  assert.equal(snap.retryAfterSeconds, 20);
});

test('parseBedrockRateLimit: undefined / no metadata → null', () => {
  assert.equal(parseBedrockRateLimit(undefined), null);
  assert.equal(parseBedrockRateLimit(null), null);
  assert.equal(parseBedrockRateLimit({}), null);
});

// ---- Bedrock provider wiring ----------------------------------------

test('Bedrock _chat: attaches _rateLimit when 429 comes back with retryAfterHeader', async () => {
  const BedrockLLMService = require('../lib/providers/bedrock');
  const svc = new BedrockLLMService('llm', null, {
    credentials: { region: 'us-east-1' },
    modelId: 'anthropic.claude-opus-4-7-v1:0',
  });
  svc._sdk = { ConverseCommand: class { constructor(p) { this.input = p; } } };
  svc.client = {
    async send() {
      return {
        $metadata: { httpStatusCode: 429, retryAfterHeader: '25' },
        output: { message: { content: [{ text: 'throttled reply' }] } },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'end_turn',
      };
    },
  };
  const res = await svc._chat({
    model: 'anthropic.claude-opus-4-7-v1:0', maxTokens: 100, system: null,
    messages: [{ role: 'user', content: 'x' }],
  });
  assert.ok(res._rateLimit);
  assert.equal(res._rateLimit.retryAfterSeconds, 25);
});

test('Bedrock _chat: 200 with no signals → no _rateLimit field', async () => {
  const BedrockLLMService = require('../lib/providers/bedrock');
  const svc = new BedrockLLMService('llm', null, {
    credentials: { region: 'us-east-1' },
    modelId: 'anthropic.claude-opus-4-7-v1:0',
  });
  svc._sdk = { ConverseCommand: class { constructor(p) { this.input = p; } } };
  svc.client = {
    async send() {
      return {
        $metadata: { httpStatusCode: 200, requestId: 'req_1' },
        output: { message: { content: [{ text: 'ok' }] } },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'end_turn',
      };
    },
  };
  const res = await svc._chat({
    model: 'anthropic.claude-opus-4-7-v1:0', maxTokens: 100, system: null,
    messages: [{ role: 'user', content: 'x' }],
  });
  assert.equal(res._rateLimit, undefined);
  assert.equal(res.text, 'ok');
});

test('Bedrock _stream: attaches _rateLimit on done chunk when signals present', async () => {
  const BedrockLLMService = require('../lib/providers/bedrock');
  const svc = new BedrockLLMService('llm', null, {
    credentials: { region: 'us-east-1' },
    modelId: 'anthropic.claude-opus-4-7-v1:0',
  });
  svc._sdk = { ConverseStreamCommand: class { constructor(p) { this.params = p; } } };
  svc.client = {
    async send() {
      return {
        $metadata: {
          httpStatusCode: 200,
          httpHeaders: {
            'x-amzn-ratelimit-limit':     '100',
            'x-amzn-ratelimit-remaining': '7',
          },
        },
        stream: (async function* () {
          yield { contentBlockDelta: { delta: { text: 'ok' } } };
          yield { messageStop: { stopReason: 'end_turn' } };
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
  assert.ok(done._rateLimit);
  assert.equal(done._rateLimit.requestsRemaining, 7);
});

// ---- End-to-end with usageMetering ----------------------------------

test('usageMetering.rateLimits(): records Bedrock throttle snapshot end-to-end', async () => {
  const { usageMetering } = require('../lib/middleware/usageMetering');
  const BedrockLLMService = require('../lib/providers/bedrock');
  const svc = new BedrockLLMService('llm', null, {
    credentials: { region: 'us-east-1' },
    modelId: 'anthropic.claude-opus-4-7-v1:0',
  });
  svc._sdk = { ConverseCommand: class { constructor(p) { this.input = p; } } };
  svc.client = {
    async send() {
      return {
        $metadata: { httpStatusCode: 429, retryAfterHeader: '42' },
        output: { message: { content: [{ text: 'reply' }] } },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'end_turn',
      };
    },
  };
  // Manually initialize the middleware array (skipping full init() to avoid
  // needing the real @aws-sdk/client-bedrock-runtime peer dep).
  svc.middleware = [];
  const meter = usageMetering({ providerOf: () => 'bedrock' });
  svc.use(meter);
  await svc.chat({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(meter.rateLimits('bedrock').retryAfterSeconds, 42);
});
