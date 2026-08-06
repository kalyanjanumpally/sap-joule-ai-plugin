const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_rl__';
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

const { parseOpenAIRateLimit, parseAnthropicRateLimit, parseResetToIso } = require('../lib/rateLimits');
const LLMService = require('../lib/LLMService');
const { usageMetering } = require('../lib/middleware/usageMetering');
const { promMetrics } = require('../lib/prometheus');

// ---- parseResetToIso -------------------------------------------------

test('parseResetToIso: "1s" → ~1000ms from now', () => {
  const iso = parseResetToIso('1s', Date.now());
  const drift = Date.parse(iso) - Date.now();
  assert.ok(drift >= 900 && drift <= 1100, `expected ~1000ms, got ${drift}ms`);
});

test('parseResetToIso: "500ms" → ~500ms from now', () => {
  const iso = parseResetToIso('500ms', Date.now());
  const drift = Date.parse(iso) - Date.now();
  assert.ok(drift >= 400 && drift <= 600, `expected ~500ms, got ${drift}ms`);
});

test('parseResetToIso: "1m5s" → 65s from now', () => {
  const iso = parseResetToIso('1m5s', Date.now());
  const drift = Date.parse(iso) - Date.now();
  assert.ok(drift >= 64_500 && drift <= 65_500, `expected ~65000ms, got ${drift}ms`);
});

test('parseResetToIso: ISO passthrough', () => {
  const iso = parseResetToIso('2026-08-06T12:00:00Z', Date.now());
  assert.equal(iso, '2026-08-06T12:00:00Z');
});

test('parseResetToIso: unparseable returns undefined', () => {
  assert.equal(parseResetToIso('bogus', Date.now()), undefined);
  assert.equal(parseResetToIso(null, Date.now()), undefined);
});

// ---- parseOpenAIRateLimit --------------------------------------------

test('parseOpenAIRateLimit: full header set → normalized snapshot', () => {
  const headers = {
    'x-ratelimit-limit-requests':     '5000',
    'x-ratelimit-remaining-requests': '4998',
    'x-ratelimit-reset-requests':     '1s',
    'x-ratelimit-limit-tokens':       '250000',
    'x-ratelimit-remaining-tokens':   '249900',
    'x-ratelimit-reset-tokens':       '24ms',
  };
  const snap = parseOpenAIRateLimit(headers, 200);
  assert.equal(snap.requestsLimit,     5000);
  assert.equal(snap.requestsRemaining, 4998);
  assert.equal(snap.tokensLimit,       250000);
  assert.equal(snap.tokensRemaining,   249900);
  assert.match(snap.requestsResetAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(snap.tokensResetAt,   /^\d{4}-\d{2}-\d{2}T/);
  assert.match(snap.updatedAt,       /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(snap.retryAfterSeconds, undefined);
});

test('parseOpenAIRateLimit: 429 with retry-after → retryAfterSeconds set', () => {
  const headers = { 'retry-after': '30' };
  const snap = parseOpenAIRateLimit(headers, 429);
  assert.equal(snap.retryAfterSeconds, 30);
});

test('parseOpenAIRateLimit: 200 ignores retry-after', () => {
  const snap = parseOpenAIRateLimit({ 'retry-after': '30' }, 200);
  assert.equal(snap, null, 'no rate-limit signals + not a 429 → null');
});

test('parseOpenAIRateLimit: no headers → null', () => {
  assert.equal(parseOpenAIRateLimit({}, 200), null);
});

test('parseOpenAIRateLimit: accepts a Headers-like object with .get()', () => {
  const headers = new Headers({
    'x-ratelimit-remaining-requests': '10',
    'x-ratelimit-limit-requests': '100',
  });
  const snap = parseOpenAIRateLimit(headers, 200);
  assert.equal(snap.requestsRemaining, 10);
  assert.equal(snap.requestsLimit, 100);
});

// ---- parseAnthropicRateLimit -----------------------------------------

test('parseAnthropicRateLimit: absolute ISO reset headers pass through', () => {
  const iso = '2026-08-06T12:34:56Z';
  const snap = parseAnthropicRateLimit({
    'anthropic-ratelimit-requests-limit': '1000',
    'anthropic-ratelimit-requests-remaining': '999',
    'anthropic-ratelimit-requests-reset': iso,
    'anthropic-ratelimit-tokens-remaining': '80000',
    'anthropic-ratelimit-tokens-reset': iso,
  }, 200);
  assert.equal(snap.requestsRemaining, 999);
  assert.equal(snap.requestsResetAt, iso);
  assert.equal(snap.tokensRemaining, 80000);
  assert.equal(snap.tokensResetAt, iso);
});

// ---- usageMetering integration ---------------------------------------

class Stub extends LLMService {
  async init() { await super.init(); this._nextRateLimit = null; }
  async _chat(params) {
    const base = {
      text: 'ok', model: params.model,
      usage: { input_tokens: 5, output_tokens: 10 },
      stopReason: 'end_turn',
    };
    if (this._nextRateLimit) base._rateLimit = this._nextRateLimit;
    return base;
  }
  async *_stream(params) {
    yield { type: 'text_delta', text: 'ok' };
    const done = {
      type: 'done', text: 'ok',
      usage: { input_tokens: 5, output_tokens: 10 },
      stopReason: 'end_turn', model: params.model,
    };
    if (this._nextRateLimit) done._rateLimit = this._nextRateLimit;
    yield done;
  }
}

test('usageMetering.rateLimits(): records the last-seen snapshot per provider', async () => {
  const svc = new Stub('llm', null, { modelId: 'claude-opus-4-7', maxTokens: 100 });
  await svc.init();
  const meter = usageMetering({ providerOf: (ctx) => ctx.raw?.providerAlias ?? 'openai' });
  svc.use(meter);

  svc._nextRateLimit = { requestsRemaining: 100, requestsLimit: 1000, updatedAt: '2026-08-06T00:00:00Z' };
  await svc.chat({ messages: [{ role: 'user', content: 'x' }], providerAlias: 'openai' });

  // Fresher snapshot on the second call overwrites the first
  svc._nextRateLimit = { requestsRemaining: 42, requestsLimit: 1000, updatedAt: '2026-08-06T00:01:00Z' };
  await svc.chat({ messages: [{ role: 'user', content: 'y' }], providerAlias: 'openai' });

  const all = meter.rateLimits();
  assert.ok(all.openai);
  assert.equal(all.openai.requestsRemaining, 42, 'later snapshot wins');
  assert.equal(all.openai.provider, 'openai');
});

test('usageMetering.rateLimits(alias): scoped lookup', async () => {
  const svc = new Stub('llm', null, { modelId: 'claude-opus-4-7', maxTokens: 100 });
  await svc.init();
  const meter = usageMetering({ providerOf: (ctx) => ctx.raw?.providerAlias });
  svc.use(meter);
  svc._nextRateLimit = { requestsRemaining: 99, updatedAt: '2026-08-06T00:00:00Z' };
  await svc.chat({ messages: [{ role: 'user', content: 'x' }], providerAlias: 'openai' });

  assert.equal(meter.rateLimits('openai').requestsRemaining, 99);
  assert.equal(meter.rateLimits('never-seen'), null);
});

test('usageMetering.rateLimits() also records from stream done-chunk', async () => {
  const svc = new Stub('llm', null, { modelId: 'claude-opus-4-7', maxTokens: 100 });
  await svc.init();
  const meter = usageMetering({ providerOf: (ctx) => 'stream-provider' });
  svc.use(meter);
  svc._nextRateLimit = { requestsRemaining: 7, updatedAt: '2026-08-06T00:00:00Z' };
  for await (const _ of svc.stream({ messages: [{ role: 'user', content: 'x' }] })) { /* drain */ }
  assert.equal(meter.rateLimits('stream-provider').requestsRemaining, 7);
});

test('usageMetering.reset(): drops rate-limit state', async () => {
  const svc = new Stub('llm', null, { modelId: 'claude-opus-4-7', maxTokens: 100 });
  await svc.init();
  const meter = usageMetering({ providerOf: () => 'p' });
  svc.use(meter);
  svc._nextRateLimit = { requestsRemaining: 1, updatedAt: '2026-08-06T00:00:00Z' };
  await svc.chat({ messages: [{ role: 'user', content: 'x' }] });
  assert.ok(meter.rateLimits('p'));
  meter.reset();
  assert.equal(meter.rateLimits('p'), null);
});

test('usageMetering.asMcpResource(): payload includes rateLimits', async () => {
  const svc = new Stub('llm', null, { modelId: 'claude-opus-4-7', maxTokens: 100 });
  await svc.init();
  const meter = usageMetering({ providerOf: () => 'x' });
  svc.use(meter);
  svc._nextRateLimit = { requestsRemaining: 42, updatedAt: '2026-08-06T00:00:00Z' };
  await svc.chat({ messages: [{ role: 'user', content: 'x' }] });
  const p = meter.asMcpResource().handler();
  assert.ok(p.rateLimits.x);
  assert.equal(p.rateLimits.x.requestsRemaining, 42);
});

// ---- Prometheus emission ---------------------------------------------

test('promMetrics: emits llm_rate_limit_* series when a provider reports state', async () => {
  const svc = new Stub('llm', null, { modelId: 'claude-opus-4-7', maxTokens: 100 });
  await svc.init();
  const meter = usageMetering({ providerOf: () => 'openai' });
  svc.use(meter);
  const future = new Date(Date.now() + 60_000).toISOString();
  svc._nextRateLimit = {
    requestsRemaining: 42,
    requestsLimit: 100,
    requestsResetAt: future,
    tokensRemaining: 5000,
    tokensLimit: 10000,
    tokensResetAt: future,
    updatedAt: new Date().toISOString(),
  };
  await svc.chat({ messages: [{ role: 'user', content: 'x' }] });
  const text = await promMetrics({ metering: meter });
  assert.match(text, /llm_rate_limit_remaining_requests\{provider="openai"\} 42/);
  assert.match(text, /llm_rate_limit_remaining_tokens\{provider="openai"\} 5000/);
  assert.match(text, /llm_rate_limit_reset_requests_seconds\{provider="openai"\} \d+/);
  assert.match(text, /llm_rate_limit_reset_tokens_seconds\{provider="openai"\} \d+/);
  assert.match(text, /llm_rate_limit_retry_after_seconds\{provider="openai"\} 0/);
});

test('promMetrics: no rate-limit series when no provider has reported state', async () => {
  const svc = new Stub('llm', null, { modelId: 'claude-opus-4-7', maxTokens: 100 });
  await svc.init();
  const meter = usageMetering();
  svc.use(meter);
  await svc.chat({ messages: [{ role: 'user', content: 'x' }] });
  const text = await promMetrics({ metering: meter });
  assert.doesNotMatch(text, /llm_rate_limit/);
});

// ---- Provider-side wiring (OpenAI-compat) -----------------------------

test('OpenAI-compat: _rateLimit attached to response when headers are present', async () => {
  const OpenAICompatibleLLMService = require('../lib/providers/openai-compatible');
  const svc = new OpenAICompatibleLLMService('llm', null, {
    credentials: { apiKey: 'sk-fake', baseUrl: 'http://127.0.0.1:65535/v1' },
    modelId: 'gpt-4o-mini',
  });
  await svc.init();
  const origFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Headers({
      'x-ratelimit-limit-requests':     '10000',
      'x-ratelimit-remaining-requests': '9999',
      'x-ratelimit-remaining-tokens':   '199990',
    }),
    json: async () => ({
      model: 'gpt-4o-mini',
      choices: [{ message: { content: 'ok', role: 'assistant' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
  });
  try {
    const res = await svc._chat({ model: 'gpt-4o-mini', maxTokens: 10, system: null, messages: [{ role: 'user', content: 'x' }] });
    assert.ok(res._rateLimit, 'result carries _rateLimit');
    assert.equal(res._rateLimit.requestsRemaining, 9999);
    assert.equal(res._rateLimit.tokensRemaining, 199990);
  } finally {
    global.fetch = origFetch;
  }
});
