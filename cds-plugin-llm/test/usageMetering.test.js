const { test } = require('node:test');
const assert = require('node:assert/strict');

// Stub @sap/cds so LLMService loads without the real package.
const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_usage__';
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
const { usageMetering } = require('../lib/middleware/usageMetering');
const { DEFAULT_PRICING } = require('../lib/pricing');

// ---- test double: stub provider that echoes fixed usage --------------

// LLMService._mergeRequest strips unknown fields, so we can't smuggle fake
// usage numbers through the request object. Instead, set `_nextUsage` on
// the stub instance before each chat() call — the stub's _chat reads it.
class StubProvider extends LLMService {
  async init() { await super.init(); this._chatCalls = []; }
  async _chat(params) {
    this._chatCalls.push(params);
    const usage = this._nextUsage ?? { input_tokens: 100, output_tokens: 200 };
    return {
      text: 'ok',
      raw: null,
      usage,
      stopReason: 'end_turn',
      model: this._nextModel ?? params.model,
    };
  }
  async _embed({ model, input }) {
    const inputs = Array.isArray(input) ? input : [input];
    return { embeddings: inputs.map(() => [0.1, 0.2, 0.3]), model };
  }
  async *_stream(params) {
    const usage = this._nextUsage ?? { input_tokens: 50, output_tokens: 30 };
    yield { type: 'text_delta', text: 'ok' };
    yield {
      type: 'done',
      text: 'ok',
      usage,
      stopReason: 'end_turn',
      model: this._nextModel ?? params.model,
    };
  }
}

function makeSvc(modelId = 'claude-opus-4-7', maxTokens = 500) {
  return new StubProvider('llm', null, { modelId, maxTokens });
}

function setUsage(svc, input, output) {
  svc._nextUsage = { input_tokens: input, output_tokens: output };
  return svc;
}

// ---- basic accounting ---------------------------------------------------

test('usageMetering: chat records tokens + cost against DEFAULT_PRICING', async () => {
  const svc = makeSvc('claude-opus-4-7');
  await svc.init();
  const meter = usageMetering();
  svc.use(meter);

  setUsage(svc, 1000, 500);
  await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });

  const s = meter.summary();
  assert.equal(s.totalRequests, 1);
  assert.equal(s.totalInputTokens, 1000);
  assert.equal(s.totalOutputTokens, 500);
  // claude-opus-4-7 = $15/1M input, $75/1M output
  // 1000/1e6 * 15 + 500/1e6 * 75 = 0.015 + 0.0375 = 0.0525
  assert.ok(Math.abs(s.totalCost - 0.0525) < 1e-9, `expected 0.0525, got ${s.totalCost}`);
  assert.equal(s.byModel['claude-opus-4-7'].requests, 1);
  assert.equal(s.byModel['claude-opus-4-7'].inputTokens, 1000);
});

test('usageMetering: unknown model → cost $0 but request is counted', async () => {
  const svc = makeSvc('mystery-model-xyz');
  await svc.init();
  const meter = usageMetering();
  svc.use(meter);

  setUsage(svc, 100, 200);
  await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });

  const s = meter.summary();
  assert.equal(s.totalRequests, 1);
  assert.equal(s.totalCost, 0);
  // Model still shows up so callers can spot missing pricing
  assert.equal(s.byModel['mystery-model-xyz'].requests, 1);
  assert.equal(s.byModel['mystery-model-xyz'].cost, 0);
});

test('usageMetering: chat without usage in response silently skips', async () => {
  const svc = makeSvc();
  await svc.init();
  // Force the stub to return a response without usage
  svc._chat = async () => ({ text: 'ok', raw: null, model: 'claude-opus-4-7' });
  const meter = usageMetering();
  svc.use(meter);

  await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });

  const s = meter.summary();
  assert.equal(s.totalRequests, 0, 'no usage → no record');
});

// ---- user-provided pricing overrides -----------------------------------

test('usageMetering: user pricing overrides DEFAULT_PRICING for the listed models', async () => {
  const svc = makeSvc('claude-opus-4-7');
  await svc.init();
  const meter = usageMetering({
    pricing: { 'claude-opus-4-7': { input: 12, output: 60 } }, // contract discount
  });
  svc.use(meter);

  setUsage(svc, 1000, 1000);
  await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });

  const s = meter.summary();
  // 1000/1e6 * 12 + 1000/1e6 * 60 = 0.012 + 0.060 = 0.072
  assert.ok(Math.abs(s.totalCost - 0.072) < 1e-9);
});

test('usageMetering: models NOT in user pricing fall through to DEFAULT_PRICING', async () => {
  const svc = makeSvc('gpt-4o');
  await svc.init();
  const meter = usageMetering({
    pricing: { 'some-other-model': { input: 999, output: 999 } },
  });
  svc.use(meter);

  setUsage(svc, 1e6, 1e6);
  await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });

  const s = meter.summary();
  // gpt-4o default: input $5, output $20 → 5 + 20 = $25 per 1M in + 1M out
  assert.ok(Math.abs(s.totalCost - 25) < 1e-9, `expected $25, got ${s.totalCost}`);
});

// ---- tenant + provider partitioning ------------------------------------

test('usageMetering: tenantOf partitions cost by tenant', async () => {
  const svc = makeSvc('claude-opus-4-7');
  await svc.init();
  const meter = usageMetering({
    tenantOf: (ctx) => ctx.raw?.tenant ?? null,
  });
  svc.use(meter);

  setUsage(svc, 1e6, 0); await svc.chat({ messages: [{ role: 'user', content: 'a' }], tenant: 'acme' });
  setUsage(svc, 2e6, 0); await svc.chat({ messages: [{ role: 'user', content: 'b' }], tenant: 'globex' });
  setUsage(svc, 3e6, 0); await svc.chat({ messages: [{ role: 'user', content: 'c' }], tenant: 'acme' });

  const s = meter.summary();
  assert.equal(s.byTenant.acme.requests, 2);
  assert.equal(s.byTenant.acme.inputTokens, 4e6);
  assert.equal(s.byTenant.globex.requests, 1);
  assert.equal(s.byTenant.globex.inputTokens, 2e6);
  // per-tenant lookup
  assert.equal(meter.byTenant('acme').cost, s.byTenant.acme.cost);
  assert.equal(meter.byTenant('nonexistent'), null);
});

test('usageMetering: providerOf partitions cost by provider label', async () => {
  const svc = makeSvc('claude-opus-4-7');
  await svc.init();
  const meter = usageMetering({
    providerOf: (ctx) => ctx.raw?.providerAlias ?? null,
  });
  svc.use(meter);

  await svc.chat({ messages: [{ role: 'user', content: 'a' }], providerAlias: 'cheap' });
  await svc.chat({ messages: [{ role: 'user', content: 'b' }], providerAlias: 'smart' });
  await svc.chat({ messages: [{ role: 'user', content: 'c' }], providerAlias: 'cheap' });

  const s = meter.summary();
  assert.equal(s.byProvider.cheap.requests, 2);
  assert.equal(s.byProvider.smart.requests, 1);
});

test('usageMetering: byModel / byTenant / byProvider return null for unknown ids', async () => {
  const svc = makeSvc();
  await svc.init();
  const meter = usageMetering({ tenantOf: () => null });
  svc.use(meter);
  await svc.chat({ messages: [{ role: 'user', content: 'a' }] });
  assert.equal(meter.byTenant('never-seen'), null);
  assert.equal(meter.byProvider('never-seen'), null);
  assert.equal(meter.byModel('never-seen'), null);
});

// ---- currency + pricingUnit --------------------------------------------

test('usageMetering: currency label is preserved in summary + onRecord', async () => {
  const svc = makeSvc('gpt-4o');
  await svc.init();
  const records = [];
  const meter = usageMetering({
    currency: 'EUR',
    onRecord: async (r) => records.push(r),
  });
  svc.use(meter);

  await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });

  const s = meter.summary();
  assert.equal(s.currency, 'EUR');
  // onRecord is fire-and-forget; give it a tick
  await new Promise(r => setImmediate(r));
  assert.equal(records[0].currency, 'EUR');
});

test('usageMetering: pricingUnit=1000 for per-1K contracts', async () => {
  const svc = makeSvc('contract-model');
  await svc.init();
  const meter = usageMetering({
    pricing: { 'contract-model': { input: 0.005, output: 0.02 } }, // $0.005/1K in, $0.02/1K out
    pricingUnit: 1000,
  });
  svc.use(meter);

  setUsage(svc, 10000, 5000);
  await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });

  const s = meter.summary();
  // 10000/1000 * 0.005 + 5000/1000 * 0.02 = 0.05 + 0.10 = 0.15
  assert.ok(Math.abs(s.totalCost - 0.15) < 1e-9);
});

// ---- streaming ---------------------------------------------------------

test('usageMetering: stream records usage on the done chunk', async () => {
  const svc = makeSvc('claude-opus-4-7');
  await svc.init();
  const meter = usageMetering();
  svc.use(meter);

  const chunks = [];
  setUsage(svc, 100, 50);
  for await (const c of svc.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
    chunks.push(c);
  }
  assert.equal(chunks[chunks.length - 1].type, 'done');

  const s = meter.summary();
  assert.equal(s.totalRequests, 1);
  assert.equal(s.totalInputTokens, 100);
  assert.equal(s.totalOutputTokens, 50);
  assert.equal(s.byModel['claude-opus-4-7'].requests, 1);
});

test('usageMetering: stream passes chunks through unchanged', async () => {
  const svc = makeSvc('claude-opus-4-7');
  await svc.init();
  const meter = usageMetering();
  svc.use(meter);

  const kinds = [];
  for await (const c of svc.stream({ messages: [{ role: 'user', content: 'hi' }] })) kinds.push(c.type);
  assert.deepEqual(kinds, ['text_delta', 'done']);
});

// ---- embed -------------------------------------------------------------

test('usageMetering: embed approximates input tokens from string length', async () => {
  const svc = makeSvc('text-embedding-004');
  await svc.init();
  const meter = usageMetering();
  svc.use(meter);

  // 400 chars ≈ 100 tokens by the ~4-chars-per-token rule
  await svc.embed({ input: 'x'.repeat(400) });
  const s = meter.summary();
  assert.equal(s.totalRequests, 1);
  assert.equal(s.totalInputTokens, 100);
  assert.equal(s.totalOutputTokens, 0);
  // text-embedding-004: input $0.15/1M, output $0 → 100/1e6 * 0.15 = 0.000015
  assert.ok(Math.abs(s.totalCost - 0.000015) < 1e-12);
});

test('usageMetering: embed with an array of inputs sums lengths', async () => {
  const svc = makeSvc('text-embedding-004');
  await svc.init();
  const meter = usageMetering();
  svc.use(meter);
  await svc.embed({ input: ['a'.repeat(400), 'b'.repeat(400)] });
  const s = meter.summary();
  assert.equal(s.totalInputTokens, 200); // 100 + 100
});

// ---- onRecord sink -----------------------------------------------------

test('usageMetering: onRecord receives one record per request', async () => {
  const svc = makeSvc('claude-opus-4-7');
  await svc.init();
  const records = [];
  const meter = usageMetering({
    tenantOf: (ctx) => ctx.raw?.tenant ?? null,
    providerOf: () => 'anthropic',
    onRecord: async (r) => records.push(r),
  });
  svc.use(meter);

  setUsage(svc, 100, 200); await svc.chat({ messages: [{ role: 'user', content: 'a' }], tenant: 'acme' });
  setUsage(svc, 50,  25);  await svc.chat({ messages: [{ role: 'user', content: 'b' }], tenant: 'globex' });
  // fire-and-forget — flush microtasks before asserting
  await new Promise(r => setImmediate(r));

  assert.equal(records.length, 2);
  assert.equal(records[0].tenant, 'acme');
  assert.equal(records[0].provider, 'anthropic');
  assert.equal(records[0].method, 'chat');
  assert.equal(records[0].inputTokens, 100);
  assert.equal(records[0].pricingKnown, true);
  assert.match(records[0].timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(records[0].totalCost > 0);
  assert.equal(records[1].tenant, 'globex');
});

test('usageMetering: onRecord marks unknown models pricingKnown=false', async () => {
  const svc = makeSvc('mystery-xyz');
  await svc.init();
  const records = [];
  const meter = usageMetering({ onRecord: async (r) => records.push(r) });
  svc.use(meter);

  await svc.chat({ messages: [{ role: 'user', content: 'a' }] });
  await new Promise(r => setImmediate(r));

  assert.equal(records.length, 1);
  assert.equal(records[0].pricingKnown, false);
  assert.equal(records[0].totalCost, 0);
});

test('usageMetering: onRecord errors do not crash the request path', async () => {
  const svc = makeSvc();
  await svc.init();
  const meter = usageMetering({
    onRecord: async () => { throw new Error('sink boom'); },
  });
  svc.use(meter);

  // Should not throw despite the sink erroring
  const res = await svc.chat({ messages: [{ role: 'user', content: 'a' }] });
  assert.equal(res.text, 'ok');
  await new Promise(r => setImmediate(r));
  const s = meter.summary();
  assert.equal(s.totalRequests, 1); // aggregation still succeeded
});

// ---- reset -------------------------------------------------------------

test('usageMetering: reset() zeroes counters + buckets', async () => {
  const svc = makeSvc('claude-opus-4-7');
  await svc.init();
  const meter = usageMetering({ tenantOf: () => 't1' });
  svc.use(meter);

  setUsage(svc, 100, 200); await svc.chat({ messages: [{ role: 'user', content: 'a' }] });
  setUsage(svc, 100, 200); await svc.chat({ messages: [{ role: 'user', content: 'b' }] });
  assert.equal(meter.summary().totalRequests, 2);

  meter.reset();
  const s = meter.summary();
  assert.equal(s.totalRequests, 0);
  assert.equal(s.totalCost, 0);
  assert.deepEqual(s.byModel, {});
  assert.deepEqual(s.byTenant, {});
  // Currency label preserved across reset
  assert.equal(s.currency, 'USD');

  // Post-reset accounting works
  setUsage(svc, 10, 10);
  await svc.chat({ messages: [{ role: 'user', content: 'c' }] });
  assert.equal(meter.summary().totalRequests, 1);
});

// ---- summary() returns a snapshot (immutable) --------------------------

test('usageMetering: summary() returns a deep clone; mutating it does not affect internal state', async () => {
  const svc = makeSvc();
  await svc.init();
  const meter = usageMetering();
  svc.use(meter);
  await svc.chat({ messages: [{ role: 'user', content: 'a' }] });

  const snap = meter.summary();
  snap.totalCost = 999;
  snap.byModel['claude-opus-4-7'].cost = 999;

  const fresh = meter.summary();
  assert.notEqual(fresh.totalCost, 999);
  assert.notEqual(fresh.byModel['claude-opus-4-7'].cost, 999);
});

// ---- MCP resource shape ------------------------------------------------

test('usageMetering: asMcpResource() returns a valid MCP resource descriptor', async () => {
  const svc = makeSvc();
  await svc.init();
  const meter = usageMetering();
  svc.use(meter);
  await svc.chat({ messages: [{ role: 'user', content: 'a' }] });

  const resource = meter.asMcpResource();
  assert.equal(resource.uri, 'config://usage');
  assert.equal(resource.mimeType, 'application/json');
  assert.equal(typeof resource.handler, 'function');
  const payload = resource.handler();
  assert.equal(payload.totalRequests, 1);
});

// ---- DEFAULT_PRICING sanity check --------------------------------------

test('DEFAULT_PRICING: covers the major shipped provider defaults', () => {
  // Every kind's default model (from PROVIDER_DEFAULTS) should have a price entry.
  const shipped = [
    'claude-opus-4-7',
    'gpt-4o',
    'gemini-1.5-flash',
    'llama-3.3-70b-versatile',
    'anthropic.claude-opus-4-20250514-v1:0',
    'amazon.titan-embed-text-v2:0',
    'text-embedding-004',
    'nomic-embed-text',
  ];
  for (const m of shipped) {
    assert.ok(DEFAULT_PRICING[m], `expected DEFAULT_PRICING entry for '${m}'`);
    assert.equal(typeof DEFAULT_PRICING[m].input, 'number');
    assert.equal(typeof DEFAULT_PRICING[m].output, 'number');
  }
});
