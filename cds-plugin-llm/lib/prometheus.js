// Prometheus text-format exporter for every observability primitive shipped
// by this plugin. Same data as the asMcpResource() / mw.stats surfaces —
// just serialized to the metric-name{labels} format that Grafana / DataDog
// agent / Prometheus itself expects to scrape.
//
//   const { promMetrics, prometheusHandler } = require('@saptarishi/cds-plugin-llm');
//
//   // Option A: Express-shaped handler, drop into your app
//   app.get('/metrics', prometheusHandler({
//     cache, budget, guardrails, injectionGuard, metering,
//   }));
//
//   // Option B: raw serializer, embed anywhere
//   const text = await promMetrics({ cache, budget });
//   // Content-Type: text/plain; version=0.0.4; charset=utf-8
//
// Every middleware slot is optional — pass what you have wired.

// ---- Serialization helpers -------------------------------------------

// Prometheus label-value escaping: backslash, double-quote, newline.
function escapeLabel(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

// Label name sanitization — Prom names must match [a-zA-Z_][a-zA-Z0-9_]*.
// We keep known labels short + snake_case; this only fires on user-supplied
// keys (tenants, models, providers) so we sanitize aggressively.
function sanitizeLabelName(name) {
  const s = String(name).replace(/[^a-zA-Z0-9_]/g, '_');
  return /^[a-zA-Z_]/.test(s) ? s : '_' + s;
}

function line(name, value, labels) {
  if (labels && Object.keys(labels).length > 0) {
    const parts = [];
    for (const [k, v] of Object.entries(labels)) {
      if (v == null || v === '') continue;
      parts.push(`${sanitizeLabelName(k)}="${escapeLabel(v)}"`);
    }
    return `${name}{${parts.join(',')}} ${formatValue(value)}`;
  }
  return `${name} ${formatValue(value)}`;
}

function formatValue(v) {
  if (v == null || Number.isNaN(v)) return '0';
  if (v === Infinity) return '+Inf';
  if (v === -Infinity) return '-Inf';
  // Prom accepts scientific notation. Keep integers integer-formatted for
  // readability; use up to 6 decimals for floats to preserve dollar precision.
  return Number.isInteger(v) ? String(v) : v.toFixed(6).replace(/\.?0+$/, '');
}

function header(name, help, type) {
  return `# HELP ${name} ${help}\n# TYPE ${name} ${type}`;
}

// ---- Per-middleware emitters ----------------------------------------

function emitCache(cache) {
  if (!cache?.stats) return [];
  const s = cache.stats;
  const out = [];
  out.push(header('llm_cache_hits_total', 'Cache hits (exact match)', 'counter'));
  out.push(line('llm_cache_hits_total', s.hits ?? 0));
  out.push(header('llm_cache_misses_total', 'Cache misses (no exact + no semantic match)', 'counter'));
  out.push(line('llm_cache_misses_total', s.misses ?? 0));
  out.push(header('llm_cache_skips_total', 'Requests that bypassed the cache (opt-out or non-chat method)', 'counter'));
  out.push(line('llm_cache_skips_total', s.skips ?? 0));

  if ('semanticHits' in s) {
    out.push(header('llm_cache_semantic_hits_total', 'Cache hits via semantic (embedding) lookup', 'counter'));
    out.push(line('llm_cache_semantic_hits_total', s.semanticHits ?? 0));
    out.push(header('llm_cache_semantic_misses_total', 'Semantic lookups performed with candidates present that did not cross threshold', 'counter'));
    out.push(line('llm_cache_semantic_misses_total', s.semanticMisses ?? 0));
    out.push(header('llm_cache_embedder_errors_total', 'Embedder calls that failed (rate-limit / provider outage)', 'counter'));
    out.push(line('llm_cache_embedder_errors_total', s.embedderErrors ?? 0));
  }

  if (typeof cache.hitRate === 'function') {
    out.push(header('llm_cache_hit_rate', 'Combined exact+semantic hit rate over total requests that reached the cache', 'gauge'));
    out.push(line('llm_cache_hit_rate', cache.hitRate()));
  }
  if (typeof cache.size === 'function') {
    const sz = cache.size();
    if (sz != null) {
      out.push(header('llm_cache_size', 'Cache entry count', 'gauge'));
      out.push(line('llm_cache_size', sz));
    }
  }
  if (cache.semanticIndex && typeof cache.semanticIndex.size === 'number') {
    out.push(header('llm_cache_semantic_index_size', 'Semantic-index entry count (bounded by semantic.maxScan)', 'gauge'));
    out.push(line('llm_cache_semantic_index_size', cache.semanticIndex.size));
  }
  return out;
}

async function emitBudget(budget) {
  if (!budget?.snapshot) return [];
  const snap = await budget.snapshot();
  const out = [];
  out.push(header('llm_budget_spent_dollars', 'Current-window spend by scope+key', 'gauge'));
  out.push(line('llm_budget_spent_dollars', snap.total ?? 0, { scope: 'total', key: 'total' }));
  for (const [k, v] of Object.entries(snap.perTenant ?? {})) {
    out.push(line('llm_budget_spent_dollars', v, { scope: 'perTenant', key: k }));
  }
  for (const [k, v] of Object.entries(snap.perModel ?? {})) {
    out.push(line('llm_budget_spent_dollars', v, { scope: 'perModel', key: k }));
  }
  if (typeof budget.limitFor === 'function') {
    out.push(header('llm_budget_limit_dollars', 'Configured ceiling by scope+key. Absent limits are omitted.', 'gauge'));
    const totalLimit = budget.limitFor('total', 'total');
    if (totalLimit != null) {
      out.push(line('llm_budget_limit_dollars', totalLimit, { scope: 'total', key: 'total' }));
    }
    for (const k of Object.keys(snap.perTenant ?? {})) {
      const l = budget.limitFor('perTenant', k);
      if (l != null) out.push(line('llm_budget_limit_dollars', l, { scope: 'perTenant', key: k }));
    }
    for (const k of Object.keys(snap.perModel ?? {})) {
      const l = budget.limitFor('perModel', k);
      if (l != null) out.push(line('llm_budget_limit_dollars', l, { scope: 'perModel', key: k }));
    }
  }
  return out;
}

function emitGuardrails(gr) {
  if (!gr?.stats) return [];
  const s = gr.stats;
  const out = [];
  out.push(header('llm_guardrails_blocks_total', 'Requests blocked by guardrail filters', 'counter'));
  out.push(line('llm_guardrails_blocks_total', s.inputBlocks ?? 0,  { stage: 'input' }));
  out.push(line('llm_guardrails_blocks_total', s.outputBlocks ?? 0, { stage: 'output' }));
  out.push(header('llm_guardrails_redacts_total', 'Requests redacted (mutated) by guardrail filters', 'counter'));
  out.push(line('llm_guardrails_redacts_total', s.inputRedacts ?? 0,  { stage: 'input' }));
  out.push(line('llm_guardrails_redacts_total', s.outputRedacts ?? 0, { stage: 'output' }));
  return out;
}

function emitInjectionGuard(guard) {
  if (!guard?.stats) return [];
  const s = guard.stats;
  const out = [];
  out.push(header('llm_injection_scanned_total', 'User messages scanned by promptInjectionGuard', 'counter'));
  out.push(line('llm_injection_scanned_total', s.scanned ?? 0));
  out.push(header('llm_injection_blocked_total', 'Requests refused (action=block, score >= threshold)', 'counter'));
  out.push(line('llm_injection_blocked_total', s.blocked ?? 0));
  out.push(header('llm_injection_sanitized_total', 'Requests scrubbed and passed through (action=sanitize)', 'counter'));
  out.push(line('llm_injection_sanitized_total', s.sanitized ?? 0));
  out.push(header('llm_injection_warned_total', 'Requests flagged but passed through unmodified (action=warn)', 'counter'));
  out.push(line('llm_injection_warned_total', s.warned ?? 0));
  if (s.byDetector) {
    out.push(header('llm_injection_detector_hits_total', 'Per-detector hit count (sum can exceed scanned count — multiple detectors can fire per request)', 'counter'));
    for (const [det, n] of Object.entries(s.byDetector)) {
      out.push(line('llm_injection_detector_hits_total', n, { detector: det }));
    }
  }
  return out;
}

function emitMetering(meter) {
  if (!meter?.summary) return [];
  const s = meter.summary();
  const out = [];
  out.push(header('llm_usage_requests_total', 'Total metered requests', 'counter'));
  out.push(line('llm_usage_requests_total', s.totalRequests ?? 0));
  out.push(header('llm_usage_input_tokens_total', 'Total input tokens across all metered requests', 'counter'));
  out.push(line('llm_usage_input_tokens_total', s.totalInputTokens ?? 0));
  out.push(header('llm_usage_output_tokens_total', 'Total output tokens across all metered requests', 'counter'));
  out.push(line('llm_usage_output_tokens_total', s.totalOutputTokens ?? 0));
  out.push(header('llm_usage_cost_dollars_total', 'Total cost in USD (or configured currency)', 'counter'));
  out.push(line('llm_usage_cost_dollars_total', s.totalCost ?? 0));

  if ('totalCachedHits' in s) {
    out.push(header('llm_usage_cached_hits_total', 'Requests served from responseCache (cost was $0)', 'counter'));
    out.push(line('llm_usage_cached_hits_total', s.totalCachedHits ?? 0));
    out.push(header('llm_usage_cost_saved_dollars_total', 'Cumulative $ saved by cache hits (what those calls WOULD have cost)', 'counter'));
    out.push(line('llm_usage_cost_saved_dollars_total', s.totalCostSaved ?? 0));
  }

  // Per-bucket breakdowns — bounded by cardinality; large tenant/model
  // fleets get their own series. Users worried about cardinality can call
  // promMetrics({ metering: ... }, { excludeBreakdowns: true }).
  if (s.byModel) {
    out.push(header('llm_usage_requests_by_model_total', 'Requests bucketed by model', 'counter'));
    for (const [m, b] of Object.entries(s.byModel)) {
      out.push(line('llm_usage_requests_by_model_total', b.requests ?? 0, { model: m }));
    }
    out.push(header('llm_usage_cost_by_model_dollars_total', 'Cost bucketed by model', 'counter'));
    for (const [m, b] of Object.entries(s.byModel)) {
      out.push(line('llm_usage_cost_by_model_dollars_total', b.cost ?? 0, { model: m }));
    }
  }
  if (s.byTenant) {
    out.push(header('llm_usage_requests_by_tenant_total', 'Requests bucketed by tenant', 'counter'));
    for (const [t, b] of Object.entries(s.byTenant)) {
      out.push(line('llm_usage_requests_by_tenant_total', b.requests ?? 0, { tenant: t }));
    }
    out.push(header('llm_usage_cost_by_tenant_dollars_total', 'Cost bucketed by tenant', 'counter'));
    for (const [t, b] of Object.entries(s.byTenant)) {
      out.push(line('llm_usage_cost_by_tenant_dollars_total', b.cost ?? 0, { tenant: t }));
    }
  }
  if (s.byProvider) {
    out.push(header('llm_usage_requests_by_provider_total', 'Requests bucketed by provider alias', 'counter'));
    for (const [p, b] of Object.entries(s.byProvider)) {
      out.push(line('llm_usage_requests_by_provider_total', b.requests ?? 0, { provider: p }));
    }
  }
  return out;
}

// ---- Public API -----------------------------------------------------

/**
 * Serialize middleware state to Prometheus text-exposition format.
 * All args optional — pass whichever middleware you have wired.
 *
 * @param {object} mw
 * @param {object} [mw.cache]           responseCache middleware
 * @param {object} [mw.budget]          costBudget middleware
 * @param {object} [mw.guardrails]      guardrails middleware
 * @param {object} [mw.injectionGuard]  promptInjectionGuard middleware
 * @param {object} [mw.metering]        usageMetering / usageMeteringToCap middleware
 * @param {object} [options]
 * @param {boolean} [options.excludeBreakdowns=false]  Skip per-tenant/model/provider breakdowns
 *                                                     (cardinality control for large fleets).
 * @returns {Promise<string>}  Prometheus text-format body, LF-terminated.
 */
async function promMetrics(mw = {}, options = {}) {
  const { excludeBreakdowns = false } = options;
  const lines = [];
  lines.push(...emitCache(mw.cache));
  lines.push(...(await emitBudget(mw.budget)));
  lines.push(...emitGuardrails(mw.guardrails));
  lines.push(...emitInjectionGuard(mw.injectionGuard));
  let meteringLines = emitMetering(mw.metering);
  if (excludeBreakdowns) {
    meteringLines = meteringLines.filter(
      (l) => !/^(#[^\n]* )?llm_usage_(requests|cost)_by_/.test(l),
    );
  }
  lines.push(...meteringLines);
  return lines.filter(Boolean).join('\n') + '\n';
}

/**
 * Express-shaped `(req, res) => void` handler. Sets Content-Type,
 * writes the text-format body, and swallows errors into 500s. Register
 * with any Express-like app at /metrics.
 */
function prometheusHandler(mw = {}, options = {}) {
  return async function metricsRoute(_req, res) {
    try {
      const body = await promMetrics(mw, options);
      if (res.setHeader) res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      if (res.status && res.send) {
        res.status(200).send(body);
      } else if (res.writeHead && res.end) {
        // Bare http.ServerResponse
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
        res.end(body);
      }
    } catch (e) {
      if (res.status && res.send) {
        res.status(500).send(`# metrics generation failed: ${e.message}\n`);
      } else if (res.writeHead && res.end) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`# metrics generation failed: ${e.message}\n`);
      }
    }
  };
}

module.exports = { promMetrics, prometheusHandler, escapeLabel, sanitizeLabelName };
