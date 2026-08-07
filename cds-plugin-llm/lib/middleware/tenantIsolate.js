// Multi-tenant isolation wrapper. Wraps a middleware setup and hands
// out per-tenant instances — one call gives every tenant its OWN
// bulkhead / breaker / bulkhead-tuner / metering slot, keyed off
// `tenantOf(ctx)`.
//
// The problem this solves: today's bulkhead + breaker bucket by
// PROVIDER (per-provider isolation), not by TENANT. If tenant A
// hammers the LLM alias, tenant B's calls sit behind A's queue.
//
// The pitch: 'a noisy tenant can't affect another tenant's provider
// quota, circuit state, or observed latency.' SAP-CAP-native since
// tenant defaults to cds.context.tenant.
//
// Usage:
//
//   const { bulkhead, circuitBreaker, adaptiveBulkhead, tenantIsolate } =
//     require('@saptarishi/cds-plugin-llm');
//
//   const iso = tenantIsolate({
//     tenantOf: (ctx) => ctx.raw?.tenant ?? cds.context?.tenant ?? 'default',
//     factory:  (tenantId) => {
//       // Called ONCE the first time this tenant hits us. Return a
//       // middleware fn OR an array of middleware — the wrapper
//       // composes them in Koa style.
//       const bh = bulkhead({ maxConcurrent: 5, maxQueued: 20, queueTimeoutMs: 5_000 });
//       const br = circuitBreaker({ threshold: 3, cooldownMs: 30_000 });
//       return [br, bh];   // OUTER → INNER
//     },
//     onTenantCreate: (tenantId) => cds.log('tenant-iso').info(`spun up chain for '${tenantId}'`),
//   });
//   llm.use(iso);
//
// Introspection:
//   iso.tenants()             → ['acme', 'wonka', ...]
//   iso.chainFor('acme')      → [breakerMw, bulkheadMw]  — reach into tenant state
//   iso.stats                 → { requests, tenantsSeen }
//   iso.reset('acme')         → clear one tenant's chain (frees mid-flight primitives)
//   iso.reset()               → clear all
//   iso.asMcpResource()       → config://tenant-isolate

function tenantIsolate(options = {}) {
  const {
    tenantOf       = defaultTenantOf,
    factory,
    onTenantCreate = null,
    onRequest      = null,
  } = options;

  if (typeof factory !== 'function') {
    throw new Error('tenantIsolate: factory must be a function (tenantId) => middleware or middleware[].');
  }
  if (typeof tenantOf !== 'function') {
    throw new Error('tenantIsolate: tenantOf must be a function (ctx) => tenantId.');
  }

  // tenantId (string) → { mws: Middleware[], stats: { requests } }
  const tenantChains = new Map();

  const stats = {
    requests:    0,
    tenantsSeen: 0,
  };

  function getChain(tenantId) {
    let entry = tenantChains.get(tenantId);
    if (!entry) {
      let mws = factory(tenantId);
      if (typeof mws === 'function') mws = [mws];
      if (!Array.isArray(mws)) {
        throw new Error(`tenantIsolate: factory('${tenantId}') must return a middleware fn or array of middleware fns.`);
      }
      for (const m of mws) {
        if (typeof m !== 'function') {
          throw new Error(`tenantIsolate: factory('${tenantId}') returned a non-function in the middleware array.`);
        }
      }
      entry = { mws, stats: { requests: 0 } };
      tenantChains.set(tenantId, entry);
      stats.tenantsSeen++;
      if (onTenantCreate) {
        try { onTenantCreate(tenantId); } catch { /* swallow */ }
      }
    }
    return entry;
  }

  const mw = async (ctx, next) => {
    stats.requests++;
    let tenantId;
    try {
      const raw = tenantOf(ctx);
      tenantId = raw != null ? String(raw) : 'default';
    } catch {
      tenantId = 'default';
    }
    const entry = getChain(tenantId);
    entry.stats.requests++;
    if (onRequest) {
      try { onRequest({ tenantId, method: ctx?.method }); } catch { /* swallow */ }
    }

    // Koa-style compose: run entry.mws left-to-right, then delegate to next()
    const chain = entry.mws;
    let i = -1;
    const dispatch = async (idx) => {
      if (idx <= i) throw new Error('tenantIsolate: next() called concurrently more than once');
      i = idx;
      if (idx >= chain.length) return next();
      return chain[idx](ctx, () => dispatch(idx + 1));
    };
    return dispatch(0);
  };

  mw.stats     = stats;
  mw.tenants   = () => [...tenantChains.keys()];
  mw.chainFor  = (tenantId) => {
    const entry = tenantChains.get(String(tenantId));
    return entry ? entry.mws : null;
  };
  mw.statsFor  = (tenantId) => {
    const entry = tenantChains.get(String(tenantId));
    return entry ? { ...entry.stats } : null;
  };
  mw.reset     = (tenantId) => {
    if (tenantId != null) {
      tenantChains.delete(String(tenantId));
    } else {
      tenantChains.clear();
      stats.requests = 0;
      stats.tenantsSeen = 0;
    }
  };
  mw.asMcpResource = () => ({
    uri: 'config://tenant-isolate',
    name: 'Tenant isolation wrapper',
    description: 'Per-tenant middleware chain instances + call counters.',
    mimeType: 'application/json',
    handler: () => {
      const perTenant = {};
      for (const [id, entry] of tenantChains.entries()) {
        perTenant[id] = { requests: entry.stats.requests, middlewareCount: entry.mws.length };
      }
      return {
        requests:    stats.requests,
        tenantsSeen: stats.tenantsSeen,
        tenants:     [...tenantChains.keys()],
        perTenant,
      };
    },
  });
  return mw;
}

// Best-effort default — reads ctx.raw.tenant, then cds.context.tenant, then 'default'.
function defaultTenantOf(ctx) {
  if (ctx?.raw?.tenant != null) return ctx.raw.tenant;
  try {
    const cds = require('@sap/cds');
    if (cds?.context?.tenant != null) return cds.context.tenant;
  } catch { /* no cds — bare test rigs */ }
  return 'default';
}

module.exports = { tenantIsolate, defaultTenantOf };
