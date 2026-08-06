const cds = require('@sap/cds');
const { createStreamableHttpTransport } = require('@saptarishi/cds-plugin-llm');
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
  getCache, getBudget, getBudgetLimits, getGuardrails, getInjectionGuard, getMetering,
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
      version:           '0.6.0',
      resources:         buildResources({ getCache, getBudget, getGuardrails, getInjectionGuard, getMetering }),
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

function buildResources({ getCache, getBudget, getGuardrails, getInjectionGuard, getMetering }) {
  // Adapter: MCPServer expects `read: async () => value`, middleware ships
  // `.asMcpResource()` returning `{ uri, name, description, mimeType, handler }`.
  const fromMiddleware = (mwResource) => ({
    uri:         mwResource.uri,
    name:        mwResource.name,
    description: mwResource.description,
    mimeType:    mwResource.mimeType ?? 'application/json',
    read:        async () => await mwResource.handler(),
  });

  const resources = [];

  const cache = getCache();
  if (cache?.asMcpResource) resources.push(fromMiddleware(cache.asMcpResource()));

  const budget = getBudget();
  if (budget?.asMcpResource) resources.push(fromMiddleware(budget.asMcpResource()));

  const guard = getInjectionGuard();
  if (guard?.asMcpResource) resources.push(fromMiddleware(guard.asMcpResource()));

  const meter = getMetering();
  if (meter?.asMcpResource) resources.push(fromMiddleware(meter.asMcpResource()));

  // Guardrails ships its own asMcpResource since 1.35.1 — no more hand-rolled adapter.
  const gr = getGuardrails();
  if (gr?.asMcpResource) resources.push(fromMiddleware(gr.asMcpResource()));

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

  return resources;
}

// ---- Resource templates ---------------------------------------------

function buildResourceTemplates() {
  return [
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
