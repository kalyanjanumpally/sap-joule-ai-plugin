// Per-user (or per-tenant) quota manager. Tracks USD spend against a
// configurable monthly quota per key; blocks calls when the hard cap
// is hit, fires warnings at soft thresholds (50/80/95% by default).
// Composes with the shipped `costBudget` (global cap) and
// `fairShareScheduler` (concurrency fairness) — this primitive is the
// per-user *cost* fairness layer.
//
//   const { quotaManager, inMemoryQuotaStore } = require('@saptarishi/cds-plugin-llm');
//
//   llm.use(quotaManager({
//     keyOf:  (ctx) => ctx.request.userId ?? 'anon',
//     store:  inMemoryQuotaStore({ maxKeys: 10_000 }),
//     costOf: (ctx, result) => {
//       // Compute USD from result.usage using your provider pricing.
//       const inputCost  = (result.usage?.input_tokens  ?? 0) * 0.15 / 1e6;
//       const outputCost = (result.usage?.output_tokens ?? 0) * 0.60 / 1e6;
//       return inputCost + outputCost;
//     },
//     quotas: {
//       default:      { limitUsd: 10 },      // most users get $10
//       'user-vip':   { limitUsd: 1000 },     // VIP tier
//       'user-power': { limitUsd: 100 },
//     },
//     windowMs: 30 * 24 * 3600_000,           // 30-day rolling window
//     warnThresholds: [0.5, 0.8, 0.95],
//     gracePeriodRatio: 0.02,                 // allow 2% overshoot
//     onWarn:      (i) => cds.log('llm:quota').warn('threshold', i),
//     onExhausted: (i) => cds.log('llm:quota').error('exhausted', i),
//   }));
//
// Placement: OUTSIDE bulkhead / retry / providers. The quota check
// should short-circuit BEFORE any real work — an exhausted user
// shouldn't consume a slot or a retry budget.

const { LLMError } = require('../errors');

class QuotaExhaustedError extends LLMError {
  constructor({ key, usageUsd, limitUsd, windowMs }) {
    super(
      `quotaManager: quota exhausted for "${key}" — spent $${usageUsd.toFixed(4)} / $${limitUsd.toFixed(2)} in ${Math.round(windowMs / 3600_000 / 24)} days.`,
      'QUOTA_EXHAUSTED',
    );
    this.quotaKey = key;
    this.usageUsd = usageUsd;
    this.limitUsd = limitUsd;
    this.windowMs = windowMs;
  }
}

// ---- In-memory store ------------------------------------------------

function inMemoryQuotaStore(options = {}) {
  const {
    maxKeys  = 10_000,
    now      = () => Date.now(),
  } = options;

  if (!Number.isInteger(maxKeys) || maxKeys < 1) {
    throw new Error(`inMemoryQuotaStore: maxKeys must be a positive integer (got ${maxKeys}).`);
  }

  // Map preserves insertion order → cheap LRU eviction.
  //   key → { samples: [{ ts, cost }], lastWarnLevel: number | -1 }
  const map = new Map();

  return {
    async get(key) {
      const entry = map.get(key);
      if (!entry) return null;
      // LRU refresh.
      map.delete(key); map.set(key, entry);
      return { samples: entry.samples.slice(), lastWarnLevel: entry.lastWarnLevel };
    },
    async add(key, cost, ts) {
      let entry = map.get(key);
      if (!entry) {
        if (map.size >= maxKeys) map.delete(map.keys().next().value);
        entry = { samples: [], lastWarnLevel: -1 };
      }
      map.delete(key);
      entry.samples.push({ ts, cost });
      map.set(key, entry);
    },
    async setLastWarnLevel(key, level) {
      let entry = map.get(key);
      if (!entry) {
        if (map.size >= maxKeys) map.delete(map.keys().next().value);
        entry = { samples: [], lastWarnLevel: -1 };
      }
      entry.lastWarnLevel = level;
      map.delete(key); map.set(key, entry);
    },
    async reset(key) { map.delete(key); },
    async clear() { map.clear(); },
    async size() { return map.size; },
    _map: map,
  };
}

// ---- Middleware -----------------------------------------------------

function quotaManager(options = {}) {
  const {
    keyOf,
    store,
    costOf,
    quotas             = {},
    defaultLimitUsd    = 10,
    windowMs           = 30 * 24 * 3600_000,   // 30 days
    warnThresholds     = [0.5, 0.8, 0.95],
    gracePeriodRatio   = 0.02,
    onWarn             = null,
    onExhausted        = null,
    onError            = null,
    now                = () => Date.now(),
  } = options;

  if (typeof keyOf !== 'function') {
    throw new Error('quotaManager: keyOf must be a function (ctx) => string.');
  }
  if (!store || typeof store.get !== 'function' || typeof store.add !== 'function') {
    throw new Error('quotaManager: store must implement { get, add }.');
  }
  if (typeof costOf !== 'function') {
    throw new Error('quotaManager: costOf must be a function (ctx, result) => usdNumber.');
  }
  if (quotas == null || typeof quotas !== 'object') {
    throw new Error('quotaManager: quotas must be an object.');
  }
  for (const [k, v] of Object.entries(quotas)) {
    if (!v || typeof v !== 'object' || typeof v.limitUsd !== 'number' || v.limitUsd <= 0) {
      throw new Error(`quotaManager: quotas.${k}.limitUsd must be a positive number.`);
    }
  }
  if (typeof defaultLimitUsd !== 'number' || defaultLimitUsd <= 0) {
    throw new Error(`quotaManager: defaultLimitUsd must be a positive number (got ${defaultLimitUsd}).`);
  }
  if (!Number.isInteger(windowMs) || windowMs < 1000) {
    throw new Error(`quotaManager: windowMs must be an integer >= 1000 (got ${windowMs}).`);
  }
  if (!Array.isArray(warnThresholds)) {
    throw new Error('quotaManager: warnThresholds must be an array.');
  }
  for (const t of warnThresholds) {
    if (!Number.isFinite(t) || t <= 0 || t > 1) {
      throw new Error(`quotaManager: warnThresholds entries must be in (0, 1] (got ${t}).`);
    }
  }
  if (!Number.isFinite(gracePeriodRatio) || gracePeriodRatio < 0 || gracePeriodRatio > 1) {
    throw new Error(`quotaManager: gracePeriodRatio must be in [0, 1] (got ${gracePeriodRatio}).`);
  }
  for (const cb of [onWarn, onExhausted, onError]) {
    if (cb != null && typeof cb !== 'function') {
      throw new Error('quotaManager: callbacks must be functions or null.');
    }
  }

  const sortedThresholds = [...warnThresholds].sort((a, b) => a - b);

  const stats = {
    totalCalls:      0,
    allowedCalls:    0,
    blockedCalls:    0,
    warningsFired:   0,
    costErrors:      0,
    storeErrors:     0,
    keyErrors:       0,
    totalTrackedUsd: 0,
    lastKey:         null,
  };

  function callHook(hook, arg) {
    if (!hook) return;
    try { const r = hook(arg); if (r && typeof r.then === 'function') r.catch(() => {}); }
    catch { /* swallow */ }
  }

  function limitFor(key) {
    return quotas[key]?.limitUsd ?? quotas.default?.limitUsd ?? defaultLimitUsd;
  }

  function usageInWindow(entry) {
    if (!entry?.samples) return 0;
    const cutoff = now() - windowMs;
    return entry.samples
      .filter((s) => s.ts >= cutoff)
      .reduce((a, s) => a + s.cost, 0);
  }

  const mw = async (ctx, next) => {
    stats.totalCalls++;

    let key;
    try { key = keyOf(ctx); }
    catch (err) {
      stats.keyErrors++;
      callHook(onError, { phase: 'keyOf', error: err });
      throw err;
    }
    if (typeof key !== 'string' || key.length === 0) key = 'anon';
    stats.lastKey = key;

    let entry = null;
    try { entry = await store.get(key); }
    catch (err) {
      stats.storeErrors++;
      callHook(onError, { phase: 'store.get', error: err });
      // Fail open — a broken store shouldn't take the request path down.
      return next();
    }

    const currentUsage = usageInWindow(entry);
    const limit = limitFor(key);
    const hardCap = limit * (1 + gracePeriodRatio);

    if (currentUsage >= hardCap) {
      stats.blockedCalls++;
      callHook(onExhausted, { key, usageUsd: currentUsage, limitUsd: limit, windowMs });
      throw new QuotaExhaustedError({ key, usageUsd: currentUsage, limitUsd: limit, windowMs });
    }

    // Under quota — run downstream.
    const result = await next();
    stats.allowedCalls++;

    // Compute cost of this call.
    let cost = null;
    try {
      const c = costOf(ctx, result);
      if (typeof c === 'number' && Number.isFinite(c) && c >= 0) cost = c;
    } catch (err) {
      stats.costErrors++;
      callHook(onError, { phase: 'costOf', error: err });
    }
    if (cost === null || cost === 0) return result;

    // Persist the sample.
    try { await store.add(key, cost, now()); }
    catch (err) {
      stats.storeErrors++;
      callHook(onError, { phase: 'store.add', error: err });
      return result;
    }
    stats.totalTrackedUsd += cost;

    // Rising-edge warning check.
    const newUsage = currentUsage + cost;
    const utilization = newUsage / limit;
    const priorUtilization = currentUsage / limit;

    for (const level of sortedThresholds) {
      if (utilization >= level && priorUtilization < level) {
        stats.warningsFired++;
        callHook(onWarn, {
          key, level, utilization,
          usageUsd: newUsage, limitUsd: limit, windowMs,
        });
        // Persist lastWarnLevel if the store supports it (for durability
        // across restarts). If not, we rely on rising-edge from priorUtilization.
        if (typeof store.setLastWarnLevel === 'function') {
          try { await store.setLastWarnLevel(key, level); }
          catch (err) {
            stats.storeErrors++;
            callHook(onError, { phase: 'store.setLastWarnLevel', error: err });
          }
        }
      }
    }

    return result;
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.totalCalls = stats.allowedCalls = stats.blockedCalls = 0;
    stats.warningsFired = stats.costErrors = stats.storeErrors = stats.keyErrors = 0;
    stats.totalTrackedUsd = 0;
    stats.lastKey = null;
  };
  mw.getUsage = async (key) => {
    let entry = null;
    try { entry = await store.get(key); } catch { return { usageUsd: 0, limitUsd: limitFor(key), utilization: 0, samplesInWindow: 0 }; }
    const usage = usageInWindow(entry);
    const limit = limitFor(key);
    return {
      usageUsd:       usage,
      limitUsd:       limit,
      utilization:    limit > 0 ? usage / limit : 0,
      samplesInWindow: entry?.samples?.filter((s) => s.ts >= now() - windowMs).length ?? 0,
    };
  };
  mw.resetKey = async (key) => {
    if (typeof store.reset !== 'function') return false;
    await store.reset(key);
    return true;
  };
  mw.asMcpResource = () => ({
    uri: 'config://quota-manager',
    name: 'Quota manager',
    description: 'Per-user (or per-tenant) USD quota with sliding window, rising-edge warnings, hard cap with grace period.',
    mimeType: 'application/json',
    handler: () => ({
      windowMs,
      warnThresholds:  sortedThresholds,
      gracePeriodRatio,
      defaultLimitUsd,
      configuredQuotas: quotas,
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  quotaManager,
  inMemoryQuotaStore,
  QuotaExhaustedError,
};
