// Cost-budget middleware for llm.use(). Reads per-model pricing (same
// table as usageMetering), maintains per-window spend counters, and
// blocks / warns / hooks when a limit is crossed.
//
//   const budget = costBudget({
//     limits: {
//       perTenant: { default: 100, 'acme': 500 },   // USD per window per tenant
//       perModel:  { 'claude-opus-4-7': 50 },       // USD per window per model
//       total:     1000,                             // aggregate ceiling
//     },
//     window: 'day',           // 'hour' | 'day' | 'month' | 'process' | <n> seconds
//     action: 'throw',         // 'throw' | 'warn' — what happens on exceed
//     tenantOf:  (ctx) => ctx.raw?.tenant,
//     providerOf:(ctx) => ctx.raw?.providerAlias,
//     onExceeded:(info) => cds.log('llm:budget').warn(info),
//   });
//   llm.use(budget);
//
// Ordering: costBudget should run OUTER of the LLM call (so the check
// fires before the provider). It composes with usageMetering + responseCache
// — the recommended chain is `guardrails → costBudget → usageMetering →
// responseCache → provider`. Cache hits are counted (accurate) but they
// contribute the SAME cost as an uncached call to keep the budget model
// simple. Consumers who want cache hits to count as $0 should override
// `pricing` or gate the cache before the budget.
//
// Windows:
//   'hour'   — bucket by YYYY-MM-DDTHH
//   'day'    — bucket by YYYY-MM-DD  (default)
//   'month'  — bucket by YYYY-MM
//   'process'— never resets (until process restart)
//   <number> — treat as a per-N-second sliding bucket (numeric ms)
//
// Storage is in-memory Maps. Per-process by default; for multi-instance
// deployments plug the same accounting logic against Redis via `store`
// (same shape as responseCache).

const { DEFAULT_PRICING } = require('../pricing');

class BudgetExceededError extends Error {
  constructor(scope, key, current, limit, currency) {
    super(
      `budget exceeded: ${scope}='${key}' — spent ${current.toFixed(4)} ${currency}, limit ${limit} ${currency}.`,
    );
    this.name = 'BudgetExceededError';
    this.code = 'BUDGET_EXCEEDED';
    this.scope = scope;
    this.key = key;
    this.current = current;
    this.limit = limit;
    this.currency = currency;
  }
}

function costBudget(options = {}) {
  const {
    limits = {},
    window = 'day',
    action = 'throw',
    currency = 'USD',
    pricing = {},
    pricingUnit = 1_000_000,
    tenantOf = () => null,
    providerOf = () => null,
    onExceeded = null,
  } = options;

  if (action !== 'throw' && action !== 'warn') {
    throw new Error(`costBudget: action must be 'throw' or 'warn' (got '${action}').`);
  }
  const validWindow = window === 'hour' || window === 'day' || window === 'month' || window === 'process'
    || (typeof window === 'number' && window > 0 && Number.isFinite(window));
  if (!validWindow) {
    throw new Error(`costBudget: window must be 'hour' | 'day' | 'month' | 'process' | positive number of seconds (got ${JSON.stringify(window)}).`);
  }

  const priceTable = { ...DEFAULT_PRICING, ...pricing };
  // key: `${bucket}|${scope}|${key}` -> accumulated spend in USD (or currency).
  const counters = new Map();

  function currentBucket() {
    if (window === 'process') return 'process';
    if (typeof window === 'number') {
      // Sliding N-second window bucket
      return String(Math.floor(Date.now() / (window * 1000)));
    }
    const now = new Date();
    const iso = now.toISOString();
    if (window === 'hour')  return iso.slice(0, 13);
    if (window === 'month') return iso.slice(0, 7);
    return iso.slice(0, 10);
  }

  function get(scope, key) {
    return counters.get(`${currentBucket()}|${scope}|${key}`) ?? 0;
  }
  function add(scope, key, cost) {
    const k = `${currentBucket()}|${scope}|${key}`;
    counters.set(k, (counters.get(k) ?? 0) + cost);
  }
  // Resolve a limit for a given scope+key, with a `default` fallback lookup
  // for perTenant/perModel maps.
  function limitFor(scope, key) {
    if (scope === 'total') return typeof limits.total === 'number' ? limits.total : null;
    const map = limits[scope];
    if (!map) return null;
    if (key != null && typeof map[key] === 'number') return map[key];
    if (typeof map.default === 'number') return map.default;
    return null;
  }

  function checkAndMaybeThrow(scope, key) {
    const limit = limitFor(scope, key);
    if (limit == null) return;
    const spent = get(scope, key);
    if (spent >= limit) {
      const err = new BudgetExceededError(scope, key, spent, limit, currency);
      if (onExceeded) {
        try { onExceeded({ scope, key, current: spent, limit, currency, action: 'block' }); }
        catch { /* swallow */ }
      }
      if (action === 'throw') throw err;
    }
  }

  function costOf({ inputTokens, outputTokens, model }) {
    const p = priceTable[model];
    if (!p) return 0;
    return ((inputTokens ?? 0) / pricingUnit) * p.input
         + ((outputTokens ?? 0) / pricingUnit) * p.output;
  }

  function record({ tenant, model, cost }) {
    add('total', 'total', cost);
    if (tenant) add('perTenant', tenant, cost);
    if (model)  add('perModel',  model,  cost);
    // Post-record violation check — fires onExceeded for the crossing tick
    // even if the pre-call check hadn't caught it (this call is what pushed
    // us over the line).
    const violations = [];
    if (limitFor('total', 'total') != null) {
      const s = get('total', 'total'); const l = limitFor('total', 'total');
      if (s > l) violations.push({ scope: 'total', key: 'total', current: s, limit: l });
    }
    if (tenant && limitFor('perTenant', tenant) != null) {
      const s = get('perTenant', tenant); const l = limitFor('perTenant', tenant);
      if (s > l) violations.push({ scope: 'perTenant', key: tenant, current: s, limit: l });
    }
    if (model && limitFor('perModel', model) != null) {
      const s = get('perModel', model); const l = limitFor('perModel', model);
      if (s > l) violations.push({ scope: 'perModel', key: model, current: s, limit: l });
    }
    for (const v of violations) {
      if (onExceeded) {
        try { onExceeded({ ...v, currency, action: 'exceeded' }); }
        catch { /* swallow */ }
      }
    }
  }

  const mw = async (ctx, next) => {
    if (ctx.method !== 'chat' && ctx.method !== 'stream') return next();

    const tenant = tenantOf(ctx) ?? null;
    const model  = ctx.request.model ?? null;

    // Pre-call check — refuse if we're already over any applicable limit.
    checkAndMaybeThrow('total',    'total');
    if (tenant) checkAndMaybeThrow('perTenant', tenant);
    if (model)  checkAndMaybeThrow('perModel',  model);

    if (ctx.method === 'stream') {
      const iter = await next();
      return (async function* wrapped() {
        for await (const chunk of iter) {
          if (chunk?.type === 'done' && chunk.usage) {
            const usedModel = chunk.model ?? model;
            record({
              tenant, model: usedModel,
              cost: costOf({
                inputTokens: chunk.usage.input_tokens,
                outputTokens: chunk.usage.output_tokens,
                model: usedModel,
              }),
            });
          }
          yield chunk;
        }
      })();
    }

    const result = await next();
    if (result?.usage && ctx.method === 'chat') {
      const usedModel = result.model ?? model;
      record({
        tenant, model: usedModel,
        cost: costOf({
          inputTokens: result.usage.input_tokens,
          outputTokens: result.usage.output_tokens,
          model: usedModel,
        }),
      });
    }
    return result;
  };

  mw.spent = (scope, key) => get(scope, key);
  mw.spentTotal = () => get('total', 'total');
  // Full snapshot of the CURRENT window across all known scopes/keys.
  // Uses the bucket prefix to filter to the active window.
  mw.snapshot = () => {
    const bucket = currentBucket();
    const out = { window: bucket, total: 0, perTenant: {}, perModel: {}, currency };
    for (const [k, v] of counters) {
      if (!k.startsWith(bucket + '|')) continue;
      const [, scope, key] = k.split('|');
      if (scope === 'total')     out.total = v;
      else if (scope === 'perTenant') out.perTenant[key] = v;
      else if (scope === 'perModel')  out.perModel[key]  = v;
    }
    return out;
  };
  mw.reset = () => { counters.clear(); };
  mw.limitFor = (scope, key) => limitFor(scope, key);
  mw.asMcpResource = () => ({
    uri: 'config://budget',
    name: 'LLM cost budget',
    description: 'Current-window spend + configured limits.',
    mimeType: 'application/json',
    handler: () => ({
      window,
      limits,
      currency,
      current: mw.snapshot(),
    }),
  });
  return mw;
}

module.exports = { costBudget, BudgetExceededError };
