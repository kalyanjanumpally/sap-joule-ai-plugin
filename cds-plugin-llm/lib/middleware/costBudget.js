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
// Multi-instance deployments: pass a `store` implementing the
// CounterStore contract (see InMemoryCounterStore below). The default
// is per-process in-memory. Redis is a natural fit — the store
// contract maps directly to INCRBYFLOAT + SCAN.
//
// CounterStore contract — the ONE method a Redis adapter needs to
// implement is atomic increment via `add(scope, key, bucket, amount)`.
// Everything else (get, snapshot, clear) can be plain reads.
//   {
//     get      (scope, key, bucket)               → number   | Promise<number>
//     add      (scope, key, bucket, amount)       → void     | Promise<void>
//     snapshot (bucket)                           → { total, perTenant, perModel } | Promise<...>
//     clear    ()                                 → void     | Promise<void>
//   }

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
    store: userStore,
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
  const store = userStore ?? new InMemoryCounterStore();

  function currentBucket() {
    if (window === 'process') return 'process';
    if (typeof window === 'number') {
      return String(Math.floor(Date.now() / (window * 1000)));
    }
    const now = new Date();
    const iso = now.toISOString();
    if (window === 'hour')  return iso.slice(0, 13);
    if (window === 'month') return iso.slice(0, 7);
    return iso.slice(0, 10);
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

  async function checkAndMaybeThrow(scope, key) {
    const limit = limitFor(scope, key);
    if (limit == null) return;
    const spent = await store.get(scope, key, currentBucket());
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

  async function record({ tenant, model, cost }) {
    const bucket = currentBucket();
    await store.add('total', 'total', bucket, cost);
    if (tenant) await store.add('perTenant', tenant, bucket, cost);
    if (model)  await store.add('perModel',  model,  bucket, cost);
    // Post-record violation check — fires onExceeded for the crossing tick
    // even if the pre-call check hadn't caught it (this call is what pushed
    // us over the line).
    const violations = [];
    if (limitFor('total', 'total') != null) {
      const s = await store.get('total', 'total', bucket);
      const l = limitFor('total', 'total');
      if (s > l) violations.push({ scope: 'total', key: 'total', current: s, limit: l });
    }
    if (tenant && limitFor('perTenant', tenant) != null) {
      const s = await store.get('perTenant', tenant, bucket);
      const l = limitFor('perTenant', tenant);
      if (s > l) violations.push({ scope: 'perTenant', key: tenant, current: s, limit: l });
    }
    if (model && limitFor('perModel', model) != null) {
      const s = await store.get('perModel', model, bucket);
      const l = limitFor('perModel', model);
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
    await checkAndMaybeThrow('total',    'total');
    if (tenant) await checkAndMaybeThrow('perTenant', tenant);
    if (model)  await checkAndMaybeThrow('perModel',  model);

    if (ctx.method === 'stream') {
      const iter = await next();
      return (async function* wrapped() {
        for await (const chunk of iter) {
          if (chunk?.type === 'done' && chunk.usage) {
            const usedModel = chunk.model ?? model;
            await record({
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
      await record({
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

  // Introspection methods — thin passthroughs to the store. Return
  // whatever the store returns: sync value for InMemoryCounterStore,
  // Promise for async stores like Redis. Callers on async stores must
  // await; callers on the default in-memory store may use sync.
  mw.spent = (scope, key) => store.get(scope, key, currentBucket());
  mw.spentTotal = () => store.get('total', 'total', currentBucket());
  mw.snapshot = () => {
    const bucket = currentBucket();
    const inner = store.snapshot(bucket);
    // Wrap synchronous stores' output; pass promises through unchanged.
    if (inner && typeof inner.then === 'function') {
      return inner.then((s) => ({ window: bucket, currency, ...s }));
    }
    return { window: bucket, currency, ...inner };
  };
  mw.reset = () => store.clear();
  mw.limitFor = (scope, key) => limitFor(scope, key);
  mw.store = store;
  mw.asMcpResource = () => ({
    uri: 'config://budget',
    name: 'LLM cost budget',
    description: 'Current-window spend + configured limits.',
    mimeType: 'application/json',
    handler: async () => ({
      window,
      limits,
      currency,
      current: await mw.snapshot(),
    }),
  });
  return mw;
}

// ---- default in-memory store -------------------------------------------

class InMemoryCounterStore {
  constructor() {
    // key: `${bucket}|${scope}|${key}` -> accumulated spend in USD.
    this.counters = new Map();
  }
  get(scope, key, bucket) {
    return this.counters.get(`${bucket}|${scope}|${key}`) ?? 0;
  }
  add(scope, key, bucket, amount) {
    const k = `${bucket}|${scope}|${key}`;
    this.counters.set(k, (this.counters.get(k) ?? 0) + amount);
  }
  snapshot(bucket) {
    const out = { total: 0, perTenant: {}, perModel: {} };
    const prefix = bucket + '|';
    for (const [k, v] of this.counters) {
      if (!k.startsWith(prefix)) continue;
      const [, scope, key] = k.split('|');
      if (scope === 'total')          out.total = v;
      else if (scope === 'perTenant') out.perTenant[key] = v;
      else if (scope === 'perModel')  out.perModel[key]  = v;
    }
    return out;
  }
  clear() { this.counters.clear(); }
}

// ---- Redis-backed store ------------------------------------------------
//
// Works with any ioredis-shaped client exposing:
//   client.get(key)                     → Promise<string|null>
//   client.incrbyfloat(key, amount)     → Promise<string>
//   client.expire(key, seconds)         → Promise<any>
//   client.scan(cursor, ...args)        → Promise<[cursor, keys[]]>
//   client.mget(...keys)                → Promise<(string|null)[]>
//   client.del(...keys)                 → Promise<number>
//
// Redis key layout: `${namespace}:${bucket}|${scope}|${key}` — identical
// to the in-memory bucket-prefixed key format, so SCAN with pattern
// `${namespace}:${bucket}|*` cleanly returns only the active window.
//
//   const redis = new Redis(process.env.REDIS_URL);
//   const budget = costBudget({
//     limits: { perTenant: { default: 100 } },
//     store: new RedisCounterStore(redis, { namespace: 'llm:budget', keyTtlSeconds: 86400 * 40 }),
//   });
//
// keyTtlSeconds ensures old-window keys age out on their own — set it
// to comfortably longer than your window (default 40 days, which covers
// the widest 'month' window with margin).
class RedisCounterStore {
  constructor(client, options = {}) {
    if (!client) throw new Error('RedisCounterStore: client is required.');
    this.client = client;
    this.namespace   = options.namespace   ?? 'llm:budget';
    this.keyTtlSeconds = options.keyTtlSeconds ?? 60 * 60 * 24 * 40;
    this.scanCount   = options.scanCount   ?? 200;
  }
  _key(bucket, scope, key) {
    return `${this.namespace}:${bucket}|${scope}|${key}`;
  }
  async get(scope, key, bucket) {
    const v = await this.client.get(this._key(bucket, scope, key));
    return v == null ? 0 : parseFloat(v);
  }
  async add(scope, key, bucket, amount) {
    if (amount === 0) return;
    const k = this._key(bucket, scope, key);
    await this.client.incrbyfloat(k, amount);
    // Refresh TTL so a long-lived bucket doesn't stick around forever
    // once nobody's writing to it.
    if (this.keyTtlSeconds > 0) {
      await this.client.expire(k, this.keyTtlSeconds);
    }
  }
  async snapshot(bucket) {
    const pattern = `${this.namespace}:${bucket}|*`;
    const keys = [];
    let cursor = '0';
    do {
      // ioredis: client.scan(cursor, 'MATCH', pattern, 'COUNT', count) → [next, keys[]]
      const res = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', this.scanCount);
      cursor = Array.isArray(res) ? res[0] : res.cursor;
      const batch = Array.isArray(res) ? res[1] : res.keys;
      for (const k of batch) keys.push(k);
    } while (cursor !== '0' && cursor !== 0);

    const out = { total: 0, perTenant: {}, perModel: {} };
    if (keys.length === 0) return out;
    const values = await this.client.mget(...keys);
    for (let i = 0; i < keys.length; i++) {
      const stripped = keys[i].slice(this.namespace.length + 1); // drop "ns:"
      const parts = stripped.split('|');
      if (parts.length !== 3) continue;
      const [, scope, subkey] = parts;
      const v = parseFloat(values[i] ?? '0');
      if (!Number.isFinite(v)) continue;
      if (scope === 'total')          out.total = v;
      else if (scope === 'perTenant') out.perTenant[subkey] = v;
      else if (scope === 'perModel')  out.perModel[subkey]  = v;
    }
    return out;
  }
  async clear() {
    // Delete every key under the namespace — used for tests / manual admin.
    // Scans in batches to avoid blocking Redis on large keyspaces.
    const pattern = `${this.namespace}:*`;
    let cursor = '0';
    do {
      const res = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', this.scanCount);
      cursor = Array.isArray(res) ? res[0] : res.cursor;
      const batch = Array.isArray(res) ? res[1] : res.keys;
      if (batch.length > 0) await this.client.del(...batch);
    } while (cursor !== '0' && cursor !== 0);
  }
}

module.exports = { costBudget, BudgetExceededError, InMemoryCounterStore, RedisCounterStore };
