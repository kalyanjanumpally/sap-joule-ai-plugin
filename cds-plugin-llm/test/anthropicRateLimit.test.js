const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_arl__';
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

process.env.ANTHROPIC_API_KEY = 'sk-fake';
const AnthropicLLMService = require('../lib/providers/anthropic');

/**
 * Build a fake Anthropic SDK MessageStream. Exposes:
 *   - finalMessage() → resolves to a stub message
 *   - response() → resolves to { headers, status }
 *   - async-iterable protocol (yields nothing for the streaming test path)
 * Configurable per test via the `shape` param:
 *   'fn'        → response is a function
 *   'promise'   → response is a Promise
 *   'missing'   → response accessor absent (older SDK)
 *   'throws'    → response accessor throws
 */
function makeFakeStream(finalMessage, headers, statusCode = 200, shape = 'fn') {
  const headersObj = new Headers(headers ?? {});
  const responseObj = { headers: headersObj, status: statusCode };
  const stream = {
    finalMessage: async () => finalMessage,
    [Symbol.asyncIterator]: async function* () { /* no events */ },
  };
  if (shape === 'fn')       stream.response = async () => responseObj;
  else if (shape === 'promise') stream.response = Promise.resolve(responseObj);
  else if (shape === 'throws')  stream.response = async () => { throw new Error('no response'); };
  // 'missing' → don't attach
  return stream;
}

function stubFinalMessage() {
  return {
    content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 5, output_tokens: 5 },
    stop_reason: 'end_turn',
    model: 'claude-opus-4-7',
  };
}

const ANTHROPIC_HEADERS = {
  'anthropic-ratelimit-requests-limit':     '1000',
  'anthropic-ratelimit-requests-remaining': '999',
  'anthropic-ratelimit-requests-reset':     '2026-08-06T12:00:00Z',
  'anthropic-ratelimit-tokens-limit':       '400000',
  'anthropic-ratelimit-tokens-remaining':   '399900',
  'anthropic-ratelimit-tokens-reset':       '2026-08-06T12:00:00Z',
};

// ---- _chat with rate-limit headers ------------------------------------

test('Anthropic _chat: attaches _rateLimit when the SDK exposes response()', async () => {
  const svc = new AnthropicLLMService('llm', null, { modelId: 'claude-opus-4-7', maxTokens: 100 });
  await svc.init();
  // Swap the client's messages.stream() to return our fake stream
  svc.client = {
    messages: { stream: () => makeFakeStream(stubFinalMessage(), ANTHROPIC_HEADERS, 200, 'fn') },
  };
  const res = await svc._chat({
    model: 'claude-opus-4-7', maxTokens: 100, system: null,
    messages: [{ role: 'user', content: 'x' }],
  });
  assert.ok(res._rateLimit, 'result should carry _rateLimit');
  assert.equal(res._rateLimit.requestsRemaining, 999);
  assert.equal(res._rateLimit.tokensRemaining, 399900);
  assert.equal(res._rateLimit.requestsResetAt, '2026-08-06T12:00:00Z');
});

test('Anthropic _chat: works when SDK exposes response as a Promise property', async () => {
  const svc = new AnthropicLLMService('llm', null, { modelId: 'claude-opus-4-7', maxTokens: 100 });
  await svc.init();
  svc.client = {
    messages: { stream: () => makeFakeStream(stubFinalMessage(), ANTHROPIC_HEADERS, 200, 'promise') },
  };
  const res = await svc._chat({
    model: 'claude-opus-4-7', maxTokens: 100, system: null,
    messages: [{ role: 'user', content: 'x' }],
  });
  assert.ok(res._rateLimit);
  assert.equal(res._rateLimit.requestsRemaining, 999);
});

test('Anthropic _chat: gracefully skips when the SDK does not expose response', async () => {
  const svc = new AnthropicLLMService('llm', null, { modelId: 'claude-opus-4-7', maxTokens: 100 });
  await svc.init();
  svc.client = {
    messages: { stream: () => makeFakeStream(stubFinalMessage(), null, 200, 'missing') },
  };
  const res = await svc._chat({
    model: 'claude-opus-4-7', maxTokens: 100, system: null,
    messages: [{ role: 'user', content: 'x' }],
  });
  assert.equal(res._rateLimit, undefined, 'no _rateLimit field when SDK version lacks accessor');
  assert.equal(res.text, 'ok', 'chat still succeeds');
});

test('Anthropic _chat: swallows extraction errors — chat never fails on rate-limit code', async () => {
  const svc = new AnthropicLLMService('llm', null, { modelId: 'claude-opus-4-7', maxTokens: 100 });
  await svc.init();
  svc.client = {
    messages: { stream: () => makeFakeStream(stubFinalMessage(), null, 200, 'throws') },
  };
  const res = await svc._chat({
    model: 'claude-opus-4-7', maxTokens: 100, system: null,
    messages: [{ role: 'user', content: 'x' }],
  });
  assert.equal(res._rateLimit, undefined);
  assert.equal(res.text, 'ok', 'chat completes even when response() throws');
});

test('Anthropic _chat: omits _rateLimit when headers exist but carry no rate-limit info', async () => {
  const svc = new AnthropicLLMService('llm', null, { modelId: 'claude-opus-4-7', maxTokens: 100 });
  await svc.init();
  svc.client = {
    messages: { stream: () => makeFakeStream(stubFinalMessage(), { 'x-request-id': 'req_1' }, 200, 'fn') },
  };
  const res = await svc._chat({
    model: 'claude-opus-4-7', maxTokens: 100, system: null,
    messages: [{ role: 'user', content: 'x' }],
  });
  assert.equal(res._rateLimit, undefined);
});

// ---- _stream with rate-limit headers ---------------------------------

test('Anthropic _stream: attaches _rateLimit on the done chunk', async () => {
  const svc = new AnthropicLLMService('llm', null, { modelId: 'claude-opus-4-7', maxTokens: 100 });
  await svc.init();
  svc.client = {
    messages: { stream: () => makeFakeStream(stubFinalMessage(), ANTHROPIC_HEADERS, 200, 'fn') },
  };
  const chunks = [];
  for await (const c of svc._stream({
    model: 'claude-opus-4-7', maxTokens: 100, system: null,
    messages: [{ role: 'user', content: 'x' }],
  })) chunks.push(c);
  const done = chunks.find(c => c.type === 'done');
  assert.ok(done, 'stream must terminate with a done chunk');
  assert.ok(done._rateLimit, 'done chunk should carry _rateLimit');
  assert.equal(done._rateLimit.requestsRemaining, 999);
});

// ---- Integration with usageMetering -----------------------------------

test('usageMetering.rateLimits(): records Anthropic snapshot end-to-end', async () => {
  const { usageMetering } = require('../lib/middleware/usageMetering');
  const svc = new AnthropicLLMService('llm', null, { modelId: 'claude-opus-4-7', maxTokens: 100 });
  await svc.init();
  svc.client = {
    messages: { stream: () => makeFakeStream(stubFinalMessage(), ANTHROPIC_HEADERS, 200, 'fn') },
  };
  const meter = usageMetering({ providerOf: () => 'anthropic' });
  svc.use(meter);
  await svc.chat({ messages: [{ role: 'user', content: 'x' }] });
  assert.ok(meter.rateLimits('anthropic'));
  assert.equal(meter.rateLimits('anthropic').requestsRemaining, 999);
  assert.equal(meter.rateLimits('anthropic').tokensRemaining, 399900);
});
