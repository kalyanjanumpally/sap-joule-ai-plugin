const cds = require('@sap/cds');
const { createStreamableHttpTransport, schemas } = require('@saptarishi/cds-plugin-llm');
const { MCPServer } = require('@saptarishi/cds-plugin-llm/lib/mcp/server');

/**
 * Observability MCP surface — exposes every middleware's asMcpResource()
 * output as an MCP resource, so external MCP clients (Claude Desktop, Cline,
 * Cursor) can inspect the running system: cache hit rate, current-window
 * spend, injection detection stats, per-tenant usage, live LlmBudget config.
 *
 * Listens on a separate port (default 3334) via Streamable HTTP transport —
 * kept off the CAP OData port so /mcp doesn't shadow CAP routes and mTLS /
 * bearer auth can be configured independently.
 *
 * Client config snippet (Claude Desktop):
 *   "mcpServers": {
 *     "joule-procurement-ops": {
 *       "transport": { "type": "streamable-http", "url": "http://localhost:3334/mcp" }
 *     }
 *   }
 *
 * Env vars:
 *   MCP_OBS_PORT    — default 3334
 *   MCP_OBS_TOKEN   — if set, bearer token required in Authorization header
 *   MCP_OBS_DISABLE — set truthy to skip startup
 *
 * Called from ai-service.js's cds.once('served') hook so all middleware is
 * wired up before we build the resources.
 */
async function startObservabilityMcp({
  getCache, getBudget, getBudgetLimits, getGuardrails, getInjectionGuard, getMetering, getRetry,
  getDeadline, getBreaker, getBulkhead, getCostGuard, getJsonLog, getTuner, getProbe,
}) {
  if (process.env.MCP_OBS_DISABLE) {
    cds.log('mcp:obs').info('[mcp:obs] disabled via MCP_OBS_DISABLE — skipping startup');
    return null;
  }

  const log = cds.log('mcp:obs');
  const logger = (level, msg) => {
    const fn = log[level] ?? log.info;
    fn.call(log, `[mcp:obs] ${msg}`);
  };

  try {
    const server = new MCPServer({
      name:              'joule-procurement-ops',
      version:           '0.10.0',
      resources:         buildResources({
        getCache, getBudget, getGuardrails, getInjectionGuard, getMetering, getRetry,
        getDeadline, getBreaker, getBulkhead, getCostGuard, getJsonLog, getTuner, getProbe,
      }),
      resourceTemplates: buildResourceTemplates(),
      tools:             buildTools({ getCache, getInjectionGuard }),
      logger,
    });

    const port = parseInt(process.env.MCP_OBS_PORT ?? '3334', 10);
    const { url } = await createStreamableHttpTransport({
      server,
      port,
      host:      '127.0.0.1',
      path:      '/mcp',
      authToken: process.env.MCP_OBS_TOKEN ?? null,
      logger,
    });
    log.info(`[mcp:obs] listening on ${url}${process.env.MCP_OBS_TOKEN ? ' (bearer auth ON)' : ''}`);
    return { server, url };
  } catch (e) {
    log.error(`[mcp:obs] startup failed: ${e.message}`);
    return null;
  }
}

// ---- Resources -------------------------------------------------------

function buildResources({
  getCache, getBudget, getGuardrails, getInjectionGuard, getMetering, getRetry,
  getDeadline, getBreaker, getBulkhead, getCostGuard, getJsonLog, getTuner, getProbe,
}) {
  // As of cds-plugin-llm 1.40.1, MCPServer.registerResource() accepts the
  // { handler } shape shipped by middleware.asMcpResource() directly — no
  // adapter shim needed. Pass through as-is.
  const resources = [];

  const cache = getCache();
  if (cache?.asMcpResource) resources.push(cache.asMcpResource());

  const budget = getBudget();
  if (budget?.asMcpResource) resources.push(budget.asMcpResource());

  const guard = getInjectionGuard();
  if (guard?.asMcpResource) resources.push(guard.asMcpResource());

  const meter = getMetering();
  if (meter?.asMcpResource) resources.push(meter.asMcpResource());

  const retry = getRetry?.();
  if (retry?.asMcpResource) resources.push(retry.asMcpResource());

  // Resilience quartet + deadline (cds-plugin-llm 1.49-1.52). Each exposes
  // asMcpResource() → config://circuit-breaker, config://bulkhead,
  // config://deadline for MCP resource subscribers.
  const dl = getDeadline?.();
  if (dl?.asMcpResource) resources.push(dl.asMcpResource());
  const br = getBreaker?.();
  if (br?.asMcpResource) resources.push(br.asMcpResource());
  const bh = getBulkhead?.();
  if (bh?.asMcpResource) resources.push(bh.asMcpResource());
  // Cost guard (cds-plugin-llm 1.56.0) — pre-flight per-call ceiling.
  // config://cost-guard exposes ceiling + per-call counters.
  const cg = getCostGuard?.();
  if (cg?.asMcpResource) resources.push(cg.asMcpResource());
  // JSON logger (cds-plugin-llm 1.59.0) — per-call log emission stats.
  // config://json-log exposes requests / ok / failed + byErrorCode.
  const jl = getJsonLog?.();
  if (jl?.asMcpResource) resources.push(jl.asMcpResource());
  // Adaptive bulkhead tuner (cds-plugin-llm 1.61.0). config://adaptive-bulkhead.
  const tuner = getTuner?.();
  if (tuner?.asMcpResource) resources.push(tuner.asMcpResource());
  // Provider health probe (cds-plugin-llm 1.62.0). config://provider-health.
  const probe = getProbe?.();
  if (probe?.asMcpResource) resources.push(probe.asMcpResource());

  const gr = getGuardrails();
  if (gr?.asMcpResource) resources.push(gr.asMcpResource());

  // Live LlmBudget config rows from the DB. Complements config://budget
  // which shows CURRENT-WINDOW spend + effective limits; this shows the
  // underlying rows an admin can edit.
  resources.push({
    uri:         'finance://llm-budget',
    name:        'LlmBudget configuration',
    description: 'All rows in FinanceService.LlmBudget (per-scope ceilings). Editable via OData; changes take effect after POST /finance/reloadBudget.',
    mimeType:    'application/json',
    read:        async () => {
      try {
        const rows = await SELECT.from('FinanceService.LlmBudget');
        return { rows, count: rows.length, enabledCount: rows.filter((r) => r.enabled).length };
      } catch (e) {
        return { error: e.message };
      }
    },
  });

  // schema://list — enumerates every structured-output schema shipped in the
  // plugin. Useful for LLM-driven tool discovery: an agent can list the
  // available shapes then read schema://{name} to construct a matching
  // request. Powered by cds-plugin-llm 1.37.0.
  if (schemas?.asMcpResource) resources.push(schemas.asMcpResource());

  // config://chain — snapshot of the wired middleware order + per-middleware
  // config. Lets an MCP client (or a Joule reasoning step) inspect the plugin
  // stack live, without reading source. Order below MUST match the actual
  // llm.use() call order in ai-service.js (see the "Middleware stack" comment).
  resources.push({
    uri:         'config://chain',
    name:        'LLM middleware chain',
    description: 'The wired middleware order with per-middleware config. Order is OUTER→INNER (top of list runs first on the way DOWN, last on the way UP).',
    mimeType:    'application/json',
    read:        async () => buildChainSnapshot({
      getCache, getBudget, getGuardrails, getInjectionGuard, getMetering, getRetry,
      getDeadline, getBreaker, getBulkhead, getCostGuard, getJsonLog,
    }),
  });

  return resources;
}

/**
 * Snapshot the middleware chain as wired in ai-service.js's getLLM(). The
 * order is hand-maintained in this function AND in ai-service.js — if you
 * add / remove / reorder llm.use() calls there, mirror the change here.
 * The reason we don't just walk `svc.middleware` is that middleware
 * functions don't carry a self-identifying label; asMcpResource() URIs do,
 * so we key by the middleware instance we already have via getters.
 */
async function buildChainSnapshot({
  getCache, getBudget, getGuardrails, getInjectionGuard, getMetering, getRetry,
  getDeadline, getBreaker, getBulkhead, getCostGuard, getJsonLog,
}) {
  const order = [];
  let position = 0;
  const push = async (kind, mw) => {
    if (!mw) return;
    let config = null;
    try {
      if (typeof mw.asMcpResource === 'function') {
        const res = mw.asMcpResource();
        if (typeof res?.handler === 'function') {
          const payload = await res.handler();
          // Strip live counters — snapshot is about CONFIG, not state.
          // asMcpResource() payloads for observability primitives return
          // both. Consumers wanting counters read the per-primitive
          // resource (config://cache, config://budget, ...) directly.
          config = stripCounters(payload);
        }
      }
    } catch (e) {
      config = { error: e.message };
    }
    order.push({ position: position++, kind, config });
  };

  // Order matches ai-service.js's getLLM() llm.use() sequence:
  //   deadline → jsonLog → promptInjectionGuard → guardrails → costGuard →
  //   costBudget → circuitBreaker → bulkhead → retryOnRateLimit →
  //   usageMeteringToCap → responseCache
  await push('deadline',             getDeadline?.());
  await push('jsonLog',              getJsonLog?.());
  await push('promptInjectionGuard', getInjectionGuard?.());
  await push('guardrails',           getGuardrails?.());
  await push('costGuard',            getCostGuard?.());
  await push('costBudget',           getBudget?.());
  await push('circuitBreaker',       getBreaker?.());
  await push('bulkhead',             getBulkhead?.());
  await push('retryOnRateLimit',     getRetry?.());
  await push('usageMeteringToCap',   getMetering?.());
  await push('responseCache',        getCache?.());

  return {
    order,
    summary: {
      count:           order.length,
      hasDeadline:     order.some((m) => m.kind === 'deadline'),
      hasJsonLog:      order.some((m) => m.kind === 'jsonLog'),
      hasInjection:    order.some((m) => m.kind === 'promptInjectionGuard'),
      hasGuardrails:   order.some((m) => m.kind === 'guardrails'),
      hasCostGuard:    order.some((m) => m.kind === 'costGuard'),
      hasBudget:       order.some((m) => m.kind === 'costBudget'),
      hasBreaker:      order.some((m) => m.kind === 'circuitBreaker'),
      hasBulkhead:     order.some((m) => m.kind === 'bulkhead'),
      hasRetry:        order.some((m) => m.kind === 'retryOnRateLimit'),
      hasMetering:     order.some((m) => m.kind === 'usageMeteringToCap'),
      hasCache:        order.some((m) => m.kind === 'responseCache'),
    },
  };
}

// Live counters we deliberately strip from the config snapshot. The chain
// resource is about STRUCTURE + tuning; state belongs on the per-primitive
// resources (config://cache, config://budget, ...).
const COUNTER_KEYS = new Set([
  'hits', 'misses', 'skips', 'semanticHits', 'semanticMisses', 'embedderErrors',
  'hitRate', 'size', 'semanticIndexSize',
  'total', 'perTenant', 'perModel', 'current',
  'inputBlocks', 'outputBlocks', 'inputRedacts', 'outputRedacts',
  'scanned', 'blocked', 'sanitized', 'warned', 'byDetector',
  'totalRequests', 'totalInputTokens', 'totalOutputTokens', 'totalCost', 'totalCachedHits', 'totalCostSaved',
  'byModel', 'byTenant', 'byProvider', 'rateLimits',
  'requests', 'retriedRequests', 'totalRetries', 'givenUp', 'totalWaitMs',
  // cds-plugin-llm 1.49-1.52 counters
  'expired', 'activeCount',                                    // deadline
  'shortCircuited', 'opens', 'closes', 'halfOpens', 'failures', 'successes', 'buckets',   // breaker
  'admitted', 'queued', 'rejected', 'timedOut',                // bulkhead
  // cds-plugin-llm 1.56.0 counters
  'checked', 'skipped', 'warned', 'blocked', 'estimatedUsdTotal', // costGuard
  // cds-plugin-llm 1.59.0 counters
  'byErrorCode', 'ok', 'failed',                                  // jsonLog
  // cds-plugin-llm 1.61.0 counters
  'ticks', 'adjustments', 'grows', 'shrinks',
  'lastP95Ms', 'lastAction', 'lastMaxConcurrent',
  'currentMaxConcurrent', 'sampleCount', 'running',                // adaptive
  // cds-plugin-llm 1.62.0 counters
  'probes', 'timeouts', 'healthChanges', 'providers',              // probe
]);
function stripCounters(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const out = {};
  for (const [k, v] of Object.entries(payload)) {
    if (!COUNTER_KEYS.has(k)) out[k] = v;
  }
  return out;
}

// ---- Resource templates ---------------------------------------------

function buildResourceTemplates() {
  const out = [
    {
      uriTemplate: 'finance://llm-spend/recent?limit={limit}',
      name:        'Recent LlmSpend rows',
      description: 'The N most recent rows in FinanceService.LlmSpend, newest first. Limit clamped to 200.',
      mimeType:    'application/json',
      read:        async ({ limit }) => {
        const n = Math.min(200, Math.max(1, parseInt(limit, 10) || 20));
        try {
          const rows = await SELECT.from('FinanceService.LlmSpend').orderBy('timestamp desc').limit(n);
          return { rows, count: rows.length, limit: n };
        } catch (e) {
          return { error: e.message };
        }
      },
    },
  ];

  // schema://{name} — resolves any shipped schema to its raw JSON. Powered
  // by cds-plugin-llm 1.37.0; passed through as-is thanks to the handler→read
  // shim shipped in 1.40.1.
  if (schemas?.asMcpResourceTemplate) out.push(schemas.asMcpResourceTemplate());

  return out;
}

// ---- Tools -----------------------------------------------------------

function buildTools({ getCache, getInjectionGuard }) {
  return [
    {
      name:        'reload_budget',
      description: 'Re-read LlmBudget rows into the costBudget middleware. Call after editing rows via OData.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler:     async () => {
        const svc = await cds.connect.to('FinanceService');
        const result = await svc.send('reloadBudget');
        return { ok: true, ...result };
      },
    },
    {
      name:        'reset_cache',
      description: 'Clear both the exact-match cache and the semantic index. Use to force cache warmup after a data change.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler:     async () => {
        const cache = getCache();
        if (!cache) return { ok: false, error: 'cache not initialized yet' };
        await cache.clear();
        return { ok: true, cleared: true };
      },
    },
    {
      name:        'reset_injection_stats',
      description: 'Reset the promptInjectionGuard counters (scanned/blocked/sanitized/warned + per-detector). Cadence: after ops reviews the pattern of hits.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler:     async () => {
        const g = getInjectionGuard();
        if (!g) return { ok: false, error: 'injection guard not initialized yet' };
        g.reset();
        return { ok: true, reset: true };
      },
    },
  ];
}

module.exports = { startObservabilityMcp };
