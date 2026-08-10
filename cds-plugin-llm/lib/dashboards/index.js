// Pre-built dashboards + Prometheus alert rules matching the shipped
// `promMetrics` output. Consumed by the CLI (`saptarishi-llm
// export-dashboard`) and also exported programmatically so ops teams
// can compose custom dashboards on top.
//
//   const { grafanaDashboard, prometheusAlertRules,
//           datadogDashboard, newrelicDashboard } = require('@saptarishi/cds-plugin-llm/lib/dashboards');
//
// All dashboards use `{{DATASOURCE}}` / `{{JOB}}` placeholders that
// the CLI replaces at render time from --datasource / --job flags.

// ---- Grafana (JSON model v41+) --------------------------------------

function grafanaDashboard({ datasource = 'Prometheus', job = 'llm' } = {}) {
  const dsRef = { type: 'prometheus', uid: datasource };
  const jobFilter = `job="${job}"`;

  const stat = (title, expr, unit, id) => ({
    id, title, type: 'stat',
    datasource: dsRef,
    targets: [{ refId: 'A', expr, legendFormat: '{{model}}', datasource: dsRef }],
    fieldConfig: { defaults: { unit } },
  });

  const timeseries = (title, expr, unit, id, legend = '{{__name__}}') => ({
    id, title, type: 'timeseries',
    datasource: dsRef,
    targets: [{ refId: 'A', expr, legendFormat: legend, datasource: dsRef }],
    fieldConfig: { defaults: { unit } },
  });

  const gauge = (title, expr, unit, id) => ({
    id, title, type: 'gauge',
    datasource: dsRef,
    targets: [{ refId: 'A', expr, datasource: dsRef }],
    fieldConfig: { defaults: { unit, min: 0, max: 100 } },
  });

  return {
    title: 'cds-plugin-llm — LLM Middleware',
    uid: 'cds-plugin-llm',
    tags: ['llm', 'cds-plugin-llm', 'saptarishi'],
    schemaVersion: 41,
    version: 1,
    time: { from: 'now-6h', to: 'now' },
    refresh: '30s',
    panels: [
      // Row 1 — Spend
      { id: 100, title: 'Spend', type: 'row', gridPos: { x: 0, y: 0, w: 24, h: 1 } },
      { ...stat('Total spend (24h)', `sum(increase(llm_usage_cost_dollars_total{${jobFilter}}[24h]))`, 'currencyUSD', 1),
        gridPos: { x: 0, y: 1, w: 6, h: 4 } },
      { ...stat('Savings from caching (24h)', `sum(increase(llm_usage_cost_saved_dollars_total{${jobFilter}}[24h]))`, 'currencyUSD', 2),
        gridPos: { x: 6, y: 1, w: 6, h: 4 } },
      { ...timeseries('Spend rate ($/hour)', `sum by (model) (rate(llm_usage_cost_by_model_dollars_total{${jobFilter}}[5m])) * 3600`, 'currencyUSD', 3, '{{model}}'),
        gridPos: { x: 12, y: 1, w: 12, h: 8 } },

      // Row 2 — Budget
      { id: 200, title: 'Budget', type: 'row', gridPos: { x: 0, y: 9, w: 24, h: 1 } },
      { ...timeseries('Budget utilization %', `100 * llm_budget_spent_dollars{${jobFilter}} / on(scope,key) llm_budget_limit_dollars{${jobFilter}}`, 'percent', 10, '{{scope}}/{{key}}'),
        gridPos: { x: 0, y: 10, w: 12, h: 8 } },
      { ...timeseries('Budget spend by scope', `llm_budget_spent_dollars{${jobFilter}}`, 'currencyUSD', 11, '{{scope}}/{{key}}'),
        gridPos: { x: 12, y: 10, w: 12, h: 8 } },

      // Row 3 — Cache
      { id: 300, title: 'Cache', type: 'row', gridPos: { x: 0, y: 18, w: 24, h: 1 } },
      { ...gauge('Cache hit rate', `llm_cache_hit_rate{${jobFilter}} * 100`, 'percent', 20),
        gridPos: { x: 0, y: 19, w: 6, h: 6 } },
      { ...timeseries('Cache hits vs misses (rate/min)',
        `sum(rate(llm_cache_hits_total{${jobFilter}}[5m])) * 60`,
        'short', 21, 'hits/min'),
        gridPos: { x: 6, y: 19, w: 9, h: 6 } },
      { ...stat('Cache size (entries)', `llm_cache_size{${jobFilter}}`, 'short', 22),
        gridPos: { x: 15, y: 19, w: 4, h: 6 } },
      { ...stat('Semantic hits (24h)', `sum(increase(llm_cache_semantic_hits_total{${jobFilter}}[24h]))`, 'short', 23),
        gridPos: { x: 19, y: 19, w: 5, h: 6 } },

      // Row 4 — Resilience
      { id: 400, title: 'Resilience', type: 'row', gridPos: { x: 0, y: 25, w: 24, h: 1 } },
      { ...stat('Circuit breaker state', `llm_breaker_state{${jobFilter}}`, 'short', 30),
        gridPos: { x: 0, y: 26, w: 4, h: 6 } },
      { ...timeseries('Bulkhead queue depth', `llm_bulkhead_queued{${jobFilter}}`, 'short', 31, 'queued'),
        gridPos: { x: 4, y: 26, w: 8, h: 6 } },
      { ...timeseries('Retry wait budget (sec/min)', `rate(llm_retry_wait_seconds_total{${jobFilter}}[5m]) * 60`, 's', 32, 'sec/min'),
        gridPos: { x: 12, y: 26, w: 6, h: 6 } },
      { ...stat('Circuit opens (24h)', `sum(increase(llm_breaker_opens_total{${jobFilter}}[24h]))`, 'short', 33),
        gridPos: { x: 18, y: 26, w: 3, h: 6 } },
      { ...stat('Bulkhead rejected (24h)', `sum(increase(llm_bulkhead_rejected_total{${jobFilter}}[24h]))`, 'short', 34),
        gridPos: { x: 21, y: 26, w: 3, h: 6 } },

      // Row 5 — Errors + safety
      { id: 500, title: 'Errors + safety', type: 'row', gridPos: { x: 0, y: 32, w: 24, h: 1 } },
      { ...timeseries('Error rate %', `100 * sum(rate(llm_json_log_failed_total{${jobFilter}}[5m])) / sum(rate(llm_json_log_requests_total{${jobFilter}}[5m]))`, 'percent', 40, 'error %'),
        gridPos: { x: 0, y: 33, w: 12, h: 6 } },
      { ...timeseries('Prompt-injection detections',
        `sum by (action) (rate(llm_injection_scanned_total{${jobFilter}}[5m]))`,
        'short', 41, '{{action}}'),
        gridPos: { x: 12, y: 33, w: 12, h: 6 } },
      { ...stat('Guardrail blocks (24h)', `sum(increase(llm_guardrails_blocks_total{${jobFilter}}[24h]))`, 'short', 42),
        gridPos: { x: 0, y: 39, w: 6, h: 4 } },
      { ...stat('Injection blocked (24h)', `sum(increase(llm_injection_blocked_total{${jobFilter}}[24h]))`, 'short', 43),
        gridPos: { x: 6, y: 39, w: 6, h: 4 } },
      { ...stat('Deadlines expired (24h)', `sum(increase(llm_deadline_expired_total{${jobFilter}}[24h]))`, 'short', 44),
        gridPos: { x: 12, y: 39, w: 6, h: 4 } },
      { ...stat('Rate-limit give-ups (24h)', `sum(increase(llm_retry_given_up_total{${jobFilter}}[24h]))`, 'short', 45),
        gridPos: { x: 18, y: 39, w: 6, h: 4 } },
    ],
  };
}

// ---- Prometheus alert rules ----------------------------------------

function prometheusAlertRules({ job = 'llm' } = {}) {
  const jobFilter = `job="${job}"`;
  return {
    groups: [{
      name: 'cds-plugin-llm',
      interval: '30s',
      rules: [
        {
          alert: 'LlmBudgetNearLimit',
          expr: `llm_budget_spent_dollars{${jobFilter}} / on(scope,key) llm_budget_limit_dollars{${jobFilter}} > 0.80`,
          for: '5m',
          labels: { severity: 'warning', component: 'cds-plugin-llm' },
          annotations: {
            summary: 'LLM budget {{ $labels.scope }}/{{ $labels.key }} > 80% of limit',
            description: 'Spend {{ $value | humanizePercentage }} of configured ceiling. Investigate before budget-throttling kicks in.',
          },
        },
        {
          alert: 'LlmBudgetExhausted',
          expr: `llm_budget_spent_dollars{${jobFilter}} / on(scope,key) llm_budget_limit_dollars{${jobFilter}} >= 1.0`,
          for: '2m',
          labels: { severity: 'critical', component: 'cds-plugin-llm' },
          annotations: {
            summary: 'LLM budget {{ $labels.scope }}/{{ $labels.key }} exhausted',
            description: 'costBudget middleware will throw BudgetExceededError until window resets.',
          },
        },
        {
          alert: 'LlmCircuitBreakerOpen',
          expr: `llm_breaker_state{${jobFilter}} > 0`,
          for: '2m',
          labels: { severity: 'critical', component: 'cds-plugin-llm' },
          annotations: {
            summary: 'LLM circuit breaker is open (state > 0)',
            description: 'Sustained provider failures triggered the breaker. Downstream calls are short-circuiting with CircuitOpenError.',
          },
        },
        {
          alert: 'LlmHighErrorRate',
          expr: `sum(rate(llm_json_log_failed_total{${jobFilter}}[5m])) / sum(rate(llm_json_log_requests_total{${jobFilter}}[5m])) > 0.05`,
          for: '10m',
          labels: { severity: 'warning', component: 'cds-plugin-llm' },
          annotations: {
            summary: 'LLM error rate > 5% for 10m',
            description: 'Elevated error rate. Check /injection-stats, /breaker-state, and the recent LLMError entries.',
          },
        },
        {
          alert: 'LlmBulkheadSaturation',
          expr: `llm_bulkhead_queued{${jobFilter}} > 0`,
          for: '5m',
          labels: { severity: 'warning', component: 'cds-plugin-llm' },
          annotations: {
            summary: 'LLM bulkhead has queued requests for > 5m',
            description: 'Concurrency ceiling reached. Consider raising maxConcurrent or letting adaptiveBulkhead settle.',
          },
        },
        {
          alert: 'LlmRateLimitGiveUps',
          expr: `sum(rate(llm_retry_given_up_total{${jobFilter}}[5m])) > 0`,
          for: '5m',
          labels: { severity: 'warning', component: 'cds-plugin-llm' },
          annotations: {
            summary: 'LLM rate-limit retries exhausted',
            description: 'retryOnRateLimit gave up after maxAttempts. Users are seeing RateLimitGiveUpError. Check the provider status.',
          },
        },
        {
          alert: 'LlmProviderUnhealthy',
          expr: `llm_probe_provider_healthy{${jobFilter}} == 0`,
          for: '3m',
          labels: { severity: 'critical', component: 'cds-plugin-llm' },
          annotations: {
            summary: 'LLM provider {{ $labels.provider }} unhealthy',
            description: 'providerHealthProbe reports failure for 3m. Real user traffic is likely affected.',
          },
        },
      ],
    }],
  };
}

// ---- Datadog dashboard ---------------------------------------------

function datadogDashboard({ job = 'llm' } = {}) {
  const tag = `job:${job}`;
  return {
    title: 'cds-plugin-llm — LLM Middleware',
    description: 'Auto-generated by `saptarishi-llm export-dashboard --format datadog`.',
    layout_type: 'ordered',
    widgets: [
      { definition: {
        title: 'Spend rate ($/hour)',
        type: 'timeseries',
        requests: [{
          q: `sum:llm.usage.cost_by_model_dollars_total{${tag}} by {model}.as_rate() * 3600`,
          display_type: 'line',
        }],
      } },
      { definition: {
        title: 'Cache hit rate',
        type: 'query_value',
        requests: [{ q: `avg:llm.cache.hit_rate{${tag}} * 100`, aggregator: 'avg' }],
        precision: 1,
      } },
      { definition: {
        title: 'Budget utilization',
        type: 'timeseries',
        requests: [{
          q: `100 * sum:llm.budget.spent_dollars{${tag}} by {scope,key} / sum:llm.budget.limit_dollars{${tag}} by {scope,key}`,
          display_type: 'line',
        }],
      } },
      { definition: {
        title: 'Circuit breaker state',
        type: 'query_value',
        requests: [{ q: `max:llm.breaker.state{${tag}}`, aggregator: 'max' }],
      } },
      { definition: {
        title: 'Bulkhead queue',
        type: 'timeseries',
        requests: [{ q: `avg:llm.bulkhead.queued{${tag}}`, display_type: 'area' }],
      } },
      { definition: {
        title: 'Error rate %',
        type: 'timeseries',
        requests: [{
          q: `100 * sum:llm.json_log.failed_total{${tag}}.as_rate() / sum:llm.json_log.requests_total{${tag}}.as_rate()`,
          display_type: 'line',
        }],
      } },
    ],
  };
}

// ---- New Relic dashboard (NRQL-based) --------------------------------

function newrelicDashboard({ accountId, job = 'llm' } = {}) {
  const jobFilter = `WHERE job = '${job}'`;
  const page = (title, widgets) => ({ name: title, description: '', widgets });

  const widget = (title, nrql, viz = 'viz.line', col = 1, row = 1, w = 4, h = 3) => ({
    title,
    layout: { column: col, row, width: w, height: h },
    linkedEntityGuids: null,
    visualization: { id: viz },
    rawConfiguration: {
      nrqlQueries: [{ accountId, query: nrql }],
      platformOptions: { ignoreTimeRange: false },
    },
  });

  return {
    name: 'cds-plugin-llm — LLM Middleware',
    description: 'Auto-generated by `saptarishi-llm export-dashboard --format newrelic`.',
    permissions: 'PUBLIC_READ_WRITE',
    pages: [
      page('Overview', [
        widget('Spend rate ($/hour)',
          `SELECT rate(sum(llm_usage_cost_dollars_total), 1 hour) FROM Metric ${jobFilter} TIMESERIES`,
          'viz.line', 1, 1, 6, 3),
        widget('Cache hit rate',
          `SELECT latest(llm_cache_hit_rate) * 100 FROM Metric ${jobFilter}`,
          'viz.billboard', 7, 1, 3, 3),
        widget('Circuit breaker state',
          `SELECT latest(llm_breaker_state) FROM Metric ${jobFilter}`,
          'viz.billboard', 10, 1, 3, 3),
        widget('Error rate %',
          `SELECT 100 * rate(sum(llm_json_log_failed_total), 1 minute) / rate(sum(llm_json_log_requests_total), 1 minute) FROM Metric ${jobFilter} TIMESERIES`,
          'viz.line', 1, 4, 6, 3),
        widget('Budget utilization %',
          `SELECT 100 * latest(llm_budget_spent_dollars) / latest(llm_budget_limit_dollars) FROM Metric ${jobFilter} FACET scope, key`,
          'viz.bar', 7, 4, 6, 3),
      ]),
    ],
  };
}

module.exports = {
  grafanaDashboard,
  prometheusAlertRules,
  datadogDashboard,
  newrelicDashboard,
};
