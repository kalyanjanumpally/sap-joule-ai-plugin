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

function emitRetry(retry) {
  if (!retry?.stats) return [];
  const s = retry.stats;
  const out = [];
  out.push(header('llm_retry_requests_total', 'Total requests observed by retryOnRateLimit (each retry counts as ONE, not N)', 'counter'));
  out.push(line('llm_retry_requests_total', s.requests ?? 0));
  out.push(header('llm_retry_retried_requests_total', 'Requests that hit throttling and were retried at least once', 'counter'));
  out.push(line('llm_retry_retried_requests_total', s.retriedRequests ?? 0));
  out.push(header('llm_retry_attempts_total', 'Total retry attempts across all requests (a request that retried twice contributes 2)', 'counter'));
  out.push(line('llm_retry_attempts_total', s.totalRetries ?? 0));
  out.push(header('llm_retry_given_up_total', 'Requests that exhausted maxAttempts and threw RateLimitGiveUpError', 'counter'));
  out.push(line('llm_retry_given_up_total', s.givenUp ?? 0));
  out.push(header('llm_retry_wait_seconds_total', 'Cumulative time spent waiting between retries, in seconds', 'counter'));
  out.push(line('llm_retry_wait_seconds_total', (s.totalWaitMs ?? 0) / 1000));
  return out;
}

function emitCostGuard(cg) {
  if (!cg?.stats) return [];
  const s = cg.stats;
  const out = [];
  out.push(header('llm_cost_guard_requests_total', 'Total requests observed by costGuard', 'counter'));
  out.push(line('llm_cost_guard_requests_total', s.requests ?? 0));
  out.push(header('llm_cost_guard_checked_total', 'Requests actually cost-estimated (in scope for the applyTo filter)', 'counter'));
  out.push(line('llm_cost_guard_checked_total', s.checked ?? 0));
  out.push(header('llm_cost_guard_skipped_total', 'Requests skipped (out of scope, opt-out, or missing model)', 'counter'));
  out.push(line('llm_cost_guard_skipped_total', s.skipped ?? 0));
  out.push(header('llm_cost_guard_warned_total', 'Requests over the soft warnAtUsd threshold (still passed through)', 'counter'));
  out.push(line('llm_cost_guard_warned_total', s.warned ?? 0));
  out.push(header('llm_cost_guard_blocked_total', 'Requests refused because estimated cost exceeded maxPerCallUsd', 'counter'));
  out.push(line('llm_cost_guard_blocked_total', s.blocked ?? 0));
  out.push(header('llm_cost_guard_estimated_dollars_total', 'Cumulative estimated $ across all checked requests (rough forecast for cost planning)', 'counter'));
  out.push(line('llm_cost_guard_estimated_dollars_total', s.estimatedUsdTotal ?? 0));
  return out;
}

function emitDeadline(dl) {
  if (!dl?.stats) return [];
  const s = dl.stats;
  const out = [];
  out.push(header('llm_deadline_requests_total', 'Total requests observed by deadline middleware', 'counter'));
  out.push(line('llm_deadline_requests_total', s.requests ?? 0));
  out.push(header('llm_deadline_expired_total', 'Requests aborted because they exceeded the deadline budget', 'counter'));
  out.push(line('llm_deadline_expired_total', s.expired ?? 0));
  out.push(header('llm_deadline_active_count', 'Currently in-flight requests still within their deadline window', 'gauge'));
  out.push(line('llm_deadline_active_count', s.activeCount ?? 0));
  return out;
}

function emitBulkhead(bh) {
  if (!bh?.stats) return [];
  const s = bh.stats;
  const out = [];
  out.push(header('llm_bulkhead_requests_total', 'Total requests observed by bulkhead', 'counter'));
  out.push(line('llm_bulkhead_requests_total', s.requests ?? 0));
  out.push(header('llm_bulkhead_admitted_total', 'Requests admitted (fast-path or after queueing)', 'counter'));
  out.push(line('llm_bulkhead_admitted_total', s.admitted ?? 0));
  out.push(header('llm_bulkhead_queued_total', 'Requests that waited in the queue before running', 'counter'));
  out.push(line('llm_bulkhead_queued_total', s.queued ?? 0));
  out.push(header('llm_bulkhead_rejected_total', 'Requests rejected because the queue was full', 'counter'));
  out.push(line('llm_bulkhead_rejected_total', s.rejected ?? 0));
  out.push(header('llm_bulkhead_timed_out_total', 'Requests rejected because they exceeded queueTimeoutMs while waiting', 'counter'));
  out.push(line('llm_bulkhead_timed_out_total', s.timedOut ?? 0));

  // Per-bucket gauges
  if (typeof bh.asMcpResource === 'function') {
    const snap = bh.asMcpResource().handler();
    const buckets = snap.buckets ?? {};
    const entries = Object.entries(buckets);
    if (entries.length > 0) {
      out.push(header('llm_bulkhead_in_flight', 'Current in-flight calls per bucket', 'gauge'));
      for (const [k, b] of entries) {
        out.push(line('llm_bulkhead_in_flight', b.inFlight ?? 0, { provider: k }));
      }
      out.push(header('llm_bulkhead_queued', 'Current queued waiters per bucket', 'gauge'));
      for (const [k, b] of entries) {
        out.push(line('llm_bulkhead_queued', b.queued ?? 0, { provider: k }));
      }
    }
  }
  return out;
}

function emitCircuitBreaker(breaker) {
  if (!breaker?.stats) return [];
  const s = breaker.stats;
  const out = [];
  out.push(header('llm_breaker_requests_total', 'Total requests observed by circuitBreaker', 'counter'));
  out.push(line('llm_breaker_requests_total', s.requests ?? 0));
  out.push(header('llm_breaker_short_circuited_total', 'Requests short-circuited by an OPEN circuit (never reached provider)', 'counter'));
  out.push(line('llm_breaker_short_circuited_total', s.shortCircuited ?? 0));
  out.push(header('llm_breaker_opens_total', 'Times the circuit transitioned from closed/half-open to open', 'counter'));
  out.push(line('llm_breaker_opens_total', s.opens ?? 0));
  out.push(header('llm_breaker_closes_total', 'Times the circuit transitioned from half-open to closed after a successful probe', 'counter'));
  out.push(line('llm_breaker_closes_total', s.closes ?? 0));
  out.push(header('llm_breaker_half_opens_total', 'Times the circuit transitioned from open to half-open on cooldown expiration', 'counter'));
  out.push(line('llm_breaker_half_opens_total', s.halfOpens ?? 0));

  // Per-bucket gauges — one series per provider bucket.
  if (typeof breaker.asMcpResource === 'function') {
    const snap = breaker.asMcpResource().handler();
    const buckets = snap.buckets ?? {};
    const entries = Object.entries(buckets);
    if (entries.length > 0) {
      out.push(header('llm_breaker_state', 'Current circuit state per bucket (0=closed, 1=halfOpen, 2=open)', 'gauge'));
      const stateNum = { closed: 0, halfOpen: 1, open: 2 };
      for (const [k, b] of entries) {
        out.push(line('llm_breaker_state', stateNum[b.state] ?? 0, { provider: k }));
      }
      out.push(header('llm_breaker_consecutive_failures', 'Current consecutive-failure count per bucket', 'gauge'));
      for (const [k, b] of entries) {
        out.push(line('llm_breaker_consecutive_failures', b.consecutiveFailures ?? 0, { provider: k }));
      }
      out.push(header('llm_breaker_cooldown_remaining_seconds', 'Seconds until an open circuit transitions to half-open (0 if closed/half-open)', 'gauge'));
      for (const [k, b] of entries) {
        out.push(line('llm_breaker_cooldown_remaining_seconds', (b.cooldownRemainingMs ?? 0) / 1000, { provider: k }));
      }
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

  // Rate-limit snapshots per provider (new in 1.38.0). Gauges — the value
  // is the LATEST seen state, not cumulative. Provider slots without
  // rate-limit reporting yield no series.
  if (typeof meter.rateLimits === 'function') {
    const rl = meter.rateLimits();
    const entries = Object.entries(rl ?? {});
    if (entries.length > 0) {
      out.push(header('llm_rate_limit_remaining_requests', 'Latest x-ratelimit-remaining-requests (or vendor equivalent) — how many more calls fit before rate-limit reset', 'gauge'));
      for (const [p, s2] of entries) {
        if (s2.requestsRemaining != null) {
          out.push(line('llm_rate_limit_remaining_requests', s2.requestsRemaining, { provider: p }));
        }
      }
      out.push(header('llm_rate_limit_remaining_tokens', 'Latest x-ratelimit-remaining-tokens — how many more tokens the request bucket allows before reset', 'gauge'));
      for (const [p, s2] of entries) {
        if (s2.tokensRemaining != null) {
          out.push(line('llm_rate_limit_remaining_tokens', s2.tokensRemaining, { provider: p }));
        }
      }
      out.push(header('llm_rate_limit_reset_requests_seconds', 'Seconds until the requests bucket resets, based on the latest reset header', 'gauge'));
      for (const [p, s2] of entries) {
        const secs = isoToSecondsFromNow(s2.requestsResetAt);
        if (secs != null) out.push(line('llm_rate_limit_reset_requests_seconds', secs, { provider: p }));
      }
      out.push(header('llm_rate_limit_reset_tokens_seconds', 'Seconds until the tokens bucket resets, based on the latest reset header', 'gauge'));
      for (const [p, s2] of entries) {
        const secs = isoToSecondsFromNow(s2.tokensResetAt);
        if (secs != null) out.push(line('llm_rate_limit_reset_tokens_seconds', secs, { provider: p }));
      }
      out.push(header('llm_rate_limit_retry_after_seconds', 'Retry-After value from the LAST 429/503 seen for this provider (0 if none)', 'gauge'));
      for (const [p, s2] of entries) {
        out.push(line('llm_rate_limit_retry_after_seconds', s2.retryAfterSeconds ?? 0, { provider: p }));
      }
    }
  }
  return out;
}

function isoToSecondsFromNow(iso) {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, Math.round((ts - Date.now()) / 1000));
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
 * @param {object} [mw.retry]           retryOnRateLimit middleware (new in 1.47.1)
 * @param {object} [mw.breaker]         circuitBreaker middleware (new in 1.49.0)
 * @param {object} [mw.bh]              bulkhead middleware (new in 1.51.0)
 * @param {object} [mw.deadline]        deadline middleware (new in 1.52.0)
 * @param {object} [mw.costGuard]       costGuard middleware (new in 1.56.0)
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
  lines.push(...emitRetry(mw.retry));
  lines.push(...emitCircuitBreaker(mw.breaker));
  lines.push(...emitBulkhead(mw.bh));
  lines.push(...emitDeadline(mw.deadline));
  lines.push(...emitCostGuard(mw.costGuard));
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
