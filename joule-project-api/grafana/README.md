# Grafana dashboards

Pre-wired dashboards for the `@saptarishi/cds-plugin-llm` Prometheus exporter.

## `dashboards/llm-observability.json`

Single dashboard covering every metric family the plugin emits:

| Row | Panels |
|---|---|
| **Overview** | Cache hit rate · Today's spend · Retries/min · Injections blocked (10m) |
| **Cost budget** | Total spend (timeseries with limit line) · Spend by tenant (bargauge) · Spend by model (bargauge) |
| **Cache** | Hits vs misses (stacked timeseries) · Semantic index size · Total cache size · Embedder errors |
| **Rate limits & retry** | Retry attempts vs give-ups · Cumulative wait time · Provider `remaining_requests` · Provider `remaining_tokens` |
| **Security** | Guardrails blocks/redacts by stage · Injection detector heat map |
| **Usage & cost per model** | Requests/model (rate) · Cost/tenant (cumulative) · Cache savings · Cache hits · Input tokens (10m) · Output tokens (10m) |

29 panels total. Uses standard Prometheus `rate()`, `increase()`, and instant queries. Refresh interval: 30s. Time window default: last 1h.

## Import

1. Ensure `prometheusHandler({ cache, budget, retry, guardrails, injectionGuard, metering })` is wired at `/metrics` on your app (the demo app does this in `srv/ai-service.js`). See the `cds-plugin-llm` CHANGELOG entries for 1.35.0 + 1.47.1.
2. Point Prometheus at `http://<your-app>:4004/metrics` — scrape interval 15–60s is fine; scaling higher costs cardinality without much precision gain since most series are gauges.
3. In Grafana → Dashboards → New → Import → Upload JSON file → select `dashboards/llm-observability.json`.
4. When prompted, pick the Prometheus datasource that has this scrape configured.

## Compatibility

- Grafana ≥ 9.4 (schemaVersion 39). Older versions may drop the bargauge gradient mode; downgrade to `basic` if needed.
- Assumes the demo app's `prometheusHandler` bundle includes **all** middleware. If you don't wire `retry`, `injectionGuard`, or `budget`, those panels stay blank — they don't error.
- Metric names are stable across `cds-plugin-llm` `1.35.x` → `1.47.x`. Rate-limit + retry rows require ≥ `1.47.1`.

## Alert recipes

Copy-paste into Grafana → Alerting → New rule → data source Prometheus:

```
# 1. Any Rate-limit give-ups happening
expr:  rate(llm_retry_given_up_total[10m]) > 0.01
label: severity=warning

# 2. Total spend approaching the daily ceiling
expr:  llm_budget_spent_dollars{scope="total",key="total"} / llm_budget_limit_dollars{scope="total",key="total"} > 0.85
label: severity=warning

# 3. Injection blocks spiking
expr:  rate(llm_injection_blocked_total[5m]) > 0.5
label: severity=critical

# 4. Cache hit rate collapsed (invalidation storm / config change)
expr:  avg_over_time(llm_cache_hit_rate[10m]) < 0.2
label: severity=info
```
