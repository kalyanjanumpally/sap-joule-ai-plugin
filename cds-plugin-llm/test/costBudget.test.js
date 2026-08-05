const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_budget__';
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
const { costBudget, BudgetExceededError } = require('../lib/middleware/costBudget');

class Stub extends LLMService {
  async init() { await super.init(); this.calls = 0; }
  async _chat(params) {
    this.calls++;
    return {
      text: 'ok',
      model: params.model,
      usage: this._nextUsage ?? { input_tokens: 100, output_tokens: 200 },
      stopReason: 'end_turn',
    };
  }
  async *_stream(params) {
    yield { type: 'text_delta', text: 'ok' };
    yield {
      type: 'done',
      text: 'ok',
      usage: this._nextUsage ?? { input_tokens: 100, output_tokens: 200 },
      stopReason: 'end_turn',
      model: params.model,
    };
  }
}

function makeSvc(modelId = 'claude-opus-4-7') {
  return new Stub('llm', null, { modelId, maxTokens: 500 });
}
function setUsage(svc, i, o) { svc._nextUsage = { input_tokens: i, output_tokens: o }; }

// ---- Validation --------------------------------------------------------

test('costBudget: invalid action throws', () => {
  assert.throws(() => costBudget({ action: 'bogus' }), /action/);
});

test('costBudget: invalid window throws', () => {
  assert.throws(() => costBudget({ window: 'weekly' }), /window/);
  assert.throws(() => costBudget({ window: -5 }), /window/);
  assert.throws(() => costBudget({ window: 0 }), /window/);
});

// ---- Basic accounting ---------------------------------------------------

test('costBudget: sums per-call cost via DEFAULT_PRICING', async () => {
  const svc = makeSvc('claude-opus-4-7'); await svc.init();
  const budget = costBudget();
  svc.use(budget);
  // 1000 in + 500 out on claude-opus-4-7 ($15/$75 per 1M):
  //   1000/1e6 × 15 = 0.015
  //    500/1e6 × 75 = 0.0375
  // total 0.0525
  setUsage(svc, 1000, 500);
  await svc.chat({ messages: [{ role: 'user', content: 'a' }] });
  const s = budget.spentTotal();
  assert.ok(Math.abs(s - 0.0525) < 1e-9, `expected 0.0525, got ${s}`);
});

test('costBudget: unknown model → cost 0 (still records the request)', async () => {
  const svc = makeSvc('unknown-model-xyz'); await svc.init();
  const budget = costBudget();
  svc.use(budget);
  await svc.chat({ messages: [{ role: 'user', content: 'a' }] });
  assert.equal(budget.spentTotal(), 0);
});

test('costBudget: pricing overrides work (contract discount)', async () => {
  const svc = makeSvc('claude-opus-4-7'); await svc.init();
  const budget = costBudget({ pricing: { 'claude-opus-4-7': { input: 12, output: 60 } } });
  svc.use(budget);
  setUsage(svc, 1e6, 1e6);
  await svc.chat({ messages: [{ role: 'user', content: 'a' }] });
  // 12 + 60 = 72
  assert.ok(Math.abs(budget.spentTotal() - 72) < 1e-9);
});

// ---- Pre-call refusal (action='throw') ---------------------------------

test('costBudget: pre-call refusal — throws BudgetExceededError when total limit reached', async () => {
  const svc = makeSvc('claude-opus-4-7'); await svc.init();
  // Limit small; first call spends way over it. Second call's pre-check blocks.
  const budget = costBudget({ limits: { total: 0.01 } });
  svc.use(budget);
  setUsage(svc, 1000, 1000); // ~$0.09/call — comfortably over 0.01
  await svc.chat({ messages: [{ role: 'user', content: 'a' }] });
  await assert.rejects(
    () => svc.chat({ messages: [{ role: 'user', content: 'b' }] }),
    (err) => err instanceof BudgetExceededError && err.code === 'BUDGET_EXCEEDED' && err.scope === 'total',
  );
});

test('costBudget: per-tenant refusal is scoped correctly', async () => {
  const svc = makeSvc('claude-opus-4-7'); await svc.init();
  const budget = costBudget({
    limits: { perTenant: { acme: 0.05 } },
    tenantOf: (ctx) => ctx.raw?.tenant,
  });
  svc.use(budget);
  setUsage(svc, 1e6, 1e6);
  await svc.chat({ messages: [{ role: 'user', content: 'a' }], tenant: 'acme' });
  // acme spent > $0.05 already; next acme call refused
  await assert.rejects(
    () => svc.chat({ messages: [{ role: 'user', content: 'b' }], tenant: 'acme' }),
    (err) => err.scope === 'perTenant' && err.key === 'acme',
  );
  // Different tenant still allowed
  const res = await svc.chat({ messages: [{ role: 'user', content: 'c' }], tenant: 'globex' });
  assert.equal(res.text, 'ok');
});

test('costBudget: perTenant.default catches unnamed tenants', async () => {
  const svc = makeSvc('claude-opus-4-7'); await svc.init();
  const budget = costBudget({
    limits: { perTenant: { default: 0.01 } },
    tenantOf: (ctx) => ctx.raw?.tenant,
  });
  svc.use(budget);
  setUsage(svc, 1e6, 1e6);
  await svc.chat({ messages: [{ role: 'user', content: 'a' }], tenant: 'unnamed-corp' });
  await assert.rejects(
    () => svc.chat({ messages: [{ role: 'user', content: 'b' }], tenant: 'unnamed-corp' }),
    /budget exceeded/,
  );
});

test('costBudget: perModel refusal is scoped correctly', async () => {
  const svc = makeSvc('claude-opus-4-7'); await svc.init();
  const budget = costBudget({
    limits: { perModel: { 'claude-opus-4-7': 0.01 } },
  });
  svc.use(budget);
  setUsage(svc, 1e6, 0);
  await svc.chat({ messages: [{ role: 'user', content: 'a' }] });
  await assert.rejects(
    () => svc.chat({ messages: [{ role: 'user', content: 'b' }] }),
    (err) => err.scope === 'perModel' && err.key === 'claude-opus-4-7',
  );
});

test('costBudget: request path not entered when pre-call check fires', async () => {
  const svc = makeSvc('claude-opus-4-7'); await svc.init();
  const budget = costBudget({ limits: { total: 0.001 } });
  svc.use(budget);
  setUsage(svc, 1e5, 1e5);
  await svc.chat({ messages: [{ role: 'user', content: 'a' }] });
  const before = svc.calls;
  await svc.chat({ messages: [{ role: 'user', content: 'b' }] }).catch(() => {});
  assert.equal(svc.calls, before, 'LLM should NOT have been called when refused');
});

// ---- Warn mode --------------------------------------------------------

test('costBudget: action=warn → onExceeded fires but request proceeds', async () => {
  const svc = makeSvc('claude-opus-4-7'); await svc.init();
  const events = [];
  const budget = costBudget({
    limits: { total: 0.001 },
    action: 'warn',
    onExceeded: (info) => events.push(info),
  });
  svc.use(budget);
  setUsage(svc, 1e6, 1e6);
  await svc.chat({ messages: [{ role: 'user', content: 'a' }] });
  await svc.chat({ messages: [{ role: 'user', content: 'b' }] });
  await svc.chat({ messages: [{ role: 'user', content: 'c' }] });
  assert.equal(svc.calls, 3, 'warn mode should not block');
  assert.ok(events.length > 0, 'onExceeded should have fired');
});

test('costBudget: onExceeded distinguishes block vs exceeded', async () => {
  const svc = makeSvc('claude-opus-4-7'); await svc.init();
  const events = [];
  const budget = costBudget({
    limits: { total: 0.001 },
    onExceeded: (info) => events.push(info),
  });
  svc.use(budget);
  setUsage(svc, 1e6, 1e6);
  await svc.chat({ messages: [{ role: 'user', content: 'a' }] });
  // Second call: pre-check catches → block
  await svc.chat({ messages: [{ role: 'user', content: 'b' }] }).catch(() => {});
  assert.ok(events.some(e => e.action === 'exceeded'), 'first call should record exceeded');
  assert.ok(events.some(e => e.action === 'block'),    'second call should record block');
});

test('costBudget: onExceeded errors are swallowed (never block a request)', async () => {
  const svc = makeSvc('claude-opus-4-7'); await svc.init();
  const budget = costBudget({
    limits: { total: 0.001 },
    action: 'warn',
    onExceeded: () => { throw new Error('boom'); },
  });
  svc.use(budget);
  setUsage(svc, 1e6, 1e6);
  const res = await svc.chat({ messages: [{ role: 'user', content: 'a' }] });
  assert.equal(res.text, 'ok');
});

// ---- Window behavior --------------------------------------------------

test('costBudget: window="process" never resets', async () => {
  const svc = makeSvc(); await svc.init();
  const budget = costBudget({ window: 'process' });
  svc.use(budget);
  setUsage(svc, 100, 100);
  await svc.chat({ messages: [{ role: 'user', content: 'a' }] });
  await svc.chat({ messages: [{ role: 'user', content: 'b' }] });
  const s = budget.snapshot();
  assert.equal(s.window, 'process');
  assert.ok(s.total > 0);
});

test('costBudget: reset() zeroes counters immediately', async () => {
  const svc = makeSvc(); await svc.init();
  const budget = costBudget();
  svc.use(budget);
  setUsage(svc, 1e6, 1e6);
  await svc.chat({ messages: [{ role: 'user', content: 'a' }] });
  assert.ok(budget.spentTotal() > 0);
  budget.reset();
  assert.equal(budget.spentTotal(), 0);
});

// ---- Snapshot + observability ----------------------------------------

test('costBudget: snapshot returns { total, perTenant, perModel } for current window', async () => {
  const svc = makeSvc('claude-opus-4-7'); await svc.init();
  const budget = costBudget({ tenantOf: (ctx) => ctx.raw?.tenant });
  svc.use(budget);
  setUsage(svc, 1e6, 0);
  await svc.chat({ messages: [{ role: 'user', content: 'a' }], tenant: 'acme' });
  await svc.chat({ messages: [{ role: 'user', content: 'b' }], tenant: 'globex' });
  const s = budget.snapshot();
  assert.ok(s.total > 0);
  assert.ok(s.perTenant.acme > 0);
  assert.ok(s.perTenant.globex > 0);
  assert.ok(s.perModel['claude-opus-4-7'] > 0);
  assert.equal(s.currency, 'USD');
});

test('costBudget: spent(scope, key) surfaces per-key spend', async () => {
  const svc = makeSvc('claude-opus-4-7'); await svc.init();
  const budget = costBudget({ tenantOf: (ctx) => ctx.raw?.tenant });
  svc.use(budget);
  setUsage(svc, 1e6, 0);
  await svc.chat({ messages: [{ role: 'user', content: 'a' }], tenant: 'acme' });
  assert.ok(budget.spent('perTenant', 'acme') > 0);
  assert.equal(budget.spent('perTenant', 'never-seen'), 0);
});

test('costBudget: limitFor resolves named → default → null', () => {
  const budget = costBudget({
    limits: { perTenant: { default: 100, 'acme': 500 } },
  });
  assert.equal(budget.limitFor('perTenant', 'acme'), 500);
  assert.equal(budget.limitFor('perTenant', 'other'), 100);
  assert.equal(budget.limitFor('perModel', 'x'), null);
});

test('costBudget: asMcpResource returns config://budget', async () => {
  const svc = makeSvc(); await svc.init();
  const budget = costBudget({ limits: { total: 10 } });
  svc.use(budget);
  await svc.chat({ messages: [{ role: 'user', content: 'a' }] });
  const r = budget.asMcpResource();
  assert.equal(r.uri, 'config://budget');
  const payload = r.handler();
  assert.equal(payload.limits.total, 10);
  assert.ok(payload.current.total >= 0);
});

// ---- Stream --------------------------------------------------------

test('costBudget: stream done-chunk usage is counted', async () => {
  const svc = makeSvc('claude-opus-4-7'); await svc.init();
  const budget = costBudget();
  svc.use(budget);
  setUsage(svc, 500, 300);
  for await (const _ of svc.stream({ messages: [{ role: 'user', content: 'a' }] })) { /* drain */ }
  assert.ok(budget.spentTotal() > 0);
});

// ---- Ordering with usageMetering --------------------------------------

test('costBudget: composes cleanly with usageMetering (both wrap chat)', async () => {
  const { usageMetering } = require('../lib/middleware/usageMetering');
  const svc = makeSvc('claude-opus-4-7'); await svc.init();
  const meter = usageMetering();
  const budget = costBudget({ limits: { total: 10 } });
  svc.use(meter);   // OUTER
  svc.use(budget);  // INNER
  setUsage(svc, 100, 100);
  await svc.chat({ messages: [{ role: 'user', content: 'a' }] });
  // Both see the request; both record the same call's cost.
  assert.ok(meter.summary().totalCost > 0);
  assert.ok(budget.spentTotal() > 0);
});
