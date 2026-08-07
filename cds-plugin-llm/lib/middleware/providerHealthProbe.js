// Provider health probe — periodic background pings to each provider.
// On failure, records into the 1.49 circuitBreaker so the circuit opens
// BEFORE the first real user request fails. Proactive circuit isolation
// (vs the reactive breaker that waits for a real user request to fail).
//
// Usage:
//
//   const { providerHealthProbe, circuitBreaker } = require('@saptarishi/cds-plugin-llm');
//
//   const breaker = circuitBreaker({ threshold: 3, cooldownMs: 30_000 });
//
//   const health = providerHealthProbe({
//     providers: [
//       { name: 'openai',    probe: async () => openaiSvc.chat({ messages: [{ role: 'user', content: 'ping' }], maxTokens: 1 }) },
//       { name: 'anthropic', probe: async () => anthropicSvc.chat({ messages: [{ role: 'user', content: 'ping' }], maxTokens: 1 }) },
//     ],
//     intervalMs: 60_000,        // ping every provider every 60s
//     timeoutMs:  10_000,        // fail a probe if it takes > 10s
//     breaker,                     // where to report success/failure
//     onHealthChange: (info) => cds.log('llm:health-probe').warn(info),
//   });
//
//   llm.use(breaker);
//   health.start();
//
//   // Later
//   health.stop();
//
// Semantics:
//   - Probe SUCCESS while breaker is OPEN → advances via breaker's own
//     half-open logic on the next real request. The probe does NOT
//     directly close the circuit (breaker owns that decision via
//     recordSuccess which triggers halfOpen→closed on match).
//   - Probe FAILURE anywhere → recordFailure(provider, err). N failures
//     in a row trips the breaker's threshold, exactly like N real
//     request failures would.
//   - onHealthChange fires with `{ provider, from, to, err? }` when the
//     probe observes a healthy → unhealthy transition (or vice versa)
//     for a given provider.

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_TIMEOUT_MS  = 10_000;

function providerHealthProbe(options = {}) {
  const {
    providers  = [],
    intervalMs = DEFAULT_INTERVAL_MS,
    timeoutMs  = DEFAULT_TIMEOUT_MS,
    breaker    = null,
    onHealthChange = null,
    onProbe        = null,
  } = options;

  if (!Array.isArray(providers) || providers.length === 0) {
    throw new Error('providerHealthProbe: providers must be a non-empty array.');
  }
  for (const p of providers) {
    if (!p || typeof p.name !== 'string' || typeof p.probe !== 'function') {
      throw new Error('providerHealthProbe: each provider must be { name: string, probe: async () => any }.');
    }
  }
  if (!Number.isFinite(intervalMs) || intervalMs < 100) {
    throw new Error(`providerHealthProbe: intervalMs must be >= 100 (got ${intervalMs}).`);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100) {
    throw new Error(`providerHealthProbe: timeoutMs must be >= 100 (got ${timeoutMs}).`);
  }
  if (breaker && (typeof breaker.recordFailure !== 'function' || typeof breaker.recordSuccess !== 'function')) {
    throw new Error('providerHealthProbe: breaker must be a circuitBreaker (v1.62+ with .recordFailure + .recordSuccess).');
  }

  // Per-provider observed health state.
  const state = new Map();
  for (const p of providers) {
    state.set(p.name, { healthy: null, lastProbeAt: null, lastError: null });
  }

  const stats = {
    probes:          0,
    successes:       0,
    failures:        0,
    timeouts:        0,
    healthChanges:   0,
  };

  let timers = [];

  async function runProbe(p) {
    stats.probes++;
    const startedAt = Date.now();
    let ok = false;
    let err = null;

    try {
      await Promise.race([
        Promise.resolve().then(() => p.probe({ provider: p.name })),
        new Promise((_, reject) => setTimeout(
          () => reject(Object.assign(new Error(`providerHealthProbe: '${p.name}' timed out after ${timeoutMs}ms`), { code: 'PROBE_TIMEOUT', provider: p.name })),
          timeoutMs,
        )),
      ]);
      ok = true;
    } catch (e) {
      err = e;
      if (e?.code === 'PROBE_TIMEOUT') stats.timeouts++;
    }

    const durationMs = Date.now() - startedAt;
    const prev = state.get(p.name);
    prev.lastProbeAt = Date.now();
    prev.lastError = ok ? null : err;

    if (ok) {
      stats.successes++;
      if (breaker) {
        try { breaker.recordSuccess(p.name); } catch { /* swallow */ }
      }
    } else {
      stats.failures++;
      if (breaker) {
        try { breaker.recordFailure(p.name, err); } catch { /* swallow */ }
      }
    }

    // Health change detection
    const newHealthy = ok;
    if (prev.healthy !== null && prev.healthy !== newHealthy) {
      stats.healthChanges++;
      if (onHealthChange) {
        try {
          onHealthChange({
            provider: p.name,
            from:     prev.healthy ? 'healthy' : 'unhealthy',
            to:       newHealthy   ? 'healthy' : 'unhealthy',
            err:      newHealthy ? null : err,
          });
        } catch { /* swallow */ }
      }
    }
    prev.healthy = newHealthy;

    if (onProbe) {
      try {
        onProbe({
          provider:   p.name,
          ok,
          durationMs,
          error:      err?.message ?? null,
        });
      } catch { /* swallow */ }
    }
  }

  return {
    start() {
      if (timers.length > 0) return;   // idempotent
      // Stagger probe starts across providers to avoid a synchronized
      // burst that hits every provider in the same instant.
      const stride = intervalMs / providers.length;
      for (let i = 0; i < providers.length; i++) {
        const p = providers[i];
        const t = setTimeout(() => {
          runProbe(p);   // first probe after stride offset
          const int = setInterval(() => runProbe(p), intervalMs);
          if (typeof int.unref === 'function') int.unref();
          timers.push(int);
        }, Math.floor(stride * i));
        if (typeof t.unref === 'function') t.unref();
        timers.push(t);
      }
    },
    stop() {
      for (const t of timers) {
        clearInterval(t);
        clearTimeout(t);
      }
      timers = [];
    },
    /**
     * Fire all probes right now (or a subset by name). Useful for tests +
     * on-demand refresh (e.g. after a deployment where you want to
     * re-evaluate provider health ASAP).
     */
    async probeNow(providerName = null) {
      if (providerName) {
        const p = providers.find((x) => x.name === providerName);
        if (p) await runProbe(p);
      } else {
        await Promise.all(providers.map(runProbe));
      }
    },
    /** Current health state per provider — null = never probed yet. */
    state(providerName) {
      if (providerName) return state.get(providerName) ?? null;
      const out = {};
      for (const [k, v] of state.entries()) out[k] = { ...v };
      return out;
    },
    stats,
    asMcpResource() {
      return {
        uri: 'config://provider-health',
        name: 'Provider health probe',
        description: 'Per-provider background health-check state + breaker feedback counters.',
        mimeType: 'application/json',
        handler: () => {
          const providersSnap = {};
          for (const [k, v] of state.entries()) {
            providersSnap[k] = {
              healthy:     v.healthy,
              lastProbeAt: v.lastProbeAt,
              lastError:   v.lastError?.message ?? null,
            };
          }
          return {
            intervalMs, timeoutMs,
            running:   timers.length > 0,
            providers: providersSnap,
            ...stats,
          };
        },
      };
    },
  };
}

module.exports = { providerHealthProbe };
