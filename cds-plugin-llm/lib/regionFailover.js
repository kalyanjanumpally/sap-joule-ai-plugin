// Multi-region failover. Routes LLM calls to the nearest healthy
// region with automatic failover on breaker-open / 5xx / network
// errors. Extends chatWithFallback (1.50) — per-provider fallback
// happens INSIDE each region's chain; this handles per-region
// fallback across regions.
//
// Together they form a full HA topology:
//   Request → region A → provider 1 (breaker open) → provider 2 → success
//                     ↑ chatWithFallback (1.50)
//   OR (region A entirely unhealthy):
//   Request → region A (skipped) → region B → chatWithFallback → success
//                                   ↑ regionFailover (this)
//
//   const { regionFailover } = require('@saptarishi/cds-plugin-llm');
//
//   const routed = regionFailover({
//     regions: [
//       { name: 'eu-central-1', service: euCentralLlm },
//       { name: 'eu-west-1',    service: euWestLlm    },
//       { name: 'us-east-1',    service: usLlm        },
//     ],
//     allowedRegions:   ['eu-central-1', 'eu-west-1'],   // GDPR
//     unhealthyCooldownMs: 60_000,
//     onFailover: (info) => cds.log('llm:region').warn(info),
//   });
//
//   const result = await routed.chat({ messages: [...] });
//   //  { text, model, usage, region: 'eu-central-1', attempts: [...] }

const { LLMError } = require('./errors');

// ---- Error class ------------------------------------------------------

class AllRegionsFailedError extends LLMError {
  constructor(lastError, attempts, filteredCount) {
    super(
      `regionFailover: all ${attempts.length} regions failed (${filteredCount} regions filtered out). Last error: ${lastError?.message ?? 'unknown'}`,
      'ALL_REGIONS_FAILED',
    );
    this.attempts = attempts;
    this.cause    = lastError;
  }
}

// ---- Default failover predicate ---------------------------------------
//
// Matches chatWithFallback's philosophy: transport / server errors →
// fail over; 4xx → don't (same bad request will fail on all regions).

function defaultIsFallback(err) {
  if (err?.name === 'CircuitOpenError' || err?.code === 'CIRCUIT_OPEN') return true;
  if (err?.name === 'RateLimitGiveUpError' || err?.code === 'RATE_LIMIT_GIVE_UP') return true;
  if (err?.code === 'DEADLINE_EXCEEDED') return true;
  if (err?.code === 'BULKHEAD_FULL' || err?.code === 'BULKHEAD_TIMEOUT') return true;
  const status = err?.status ?? err?.statusCode;
  if (status == null) return true;   // network / unknown → try next region
  return status >= 500;
}

// ---- Main factory -----------------------------------------------------

function regionFailover(options = {}) {
  const {
    regions,
    allowedRegions      = null,
    isFallback          = defaultIsFallback,
    perRegionTimeoutMs  = null,
    unhealthyCooldownMs = 60_000,
    onFailover          = null,
    onSelected          = null,
    now                 = () => Date.now(),
  } = options;

  if (!Array.isArray(regions) || regions.length === 0) {
    throw new Error('regionFailover: regions must be a non-empty array.');
  }
  for (const [i, r] of regions.entries()) {
    if (!r || typeof r.name !== 'string' || r.name.length === 0) {
      throw new Error(`regionFailover: regions[${i}].name must be a non-empty string.`);
    }
    if (!r.service || typeof r.service.chat !== 'function') {
      throw new Error(`regionFailover: regions[${i}].service must expose a chat() method.`);
    }
  }
  if (allowedRegions != null && !Array.isArray(allowedRegions)) {
    throw new Error('regionFailover: allowedRegions must be an array or null.');
  }
  if (perRegionTimeoutMs != null && (!Number.isFinite(perRegionTimeoutMs) || perRegionTimeoutMs <= 0)) {
    throw new Error(`regionFailover: perRegionTimeoutMs must be > 0 (got ${perRegionTimeoutMs}).`);
  }
  if (!Number.isFinite(unhealthyCooldownMs) || unhealthyCooldownMs < 0) {
    throw new Error(`regionFailover: unhealthyCooldownMs must be >= 0 (got ${unhealthyCooldownMs}).`);
  }
  for (const cb of [onFailover, onSelected]) {
    if (cb != null && typeof cb !== 'function') {
      throw new Error('regionFailover: callbacks must be functions or null.');
    }
  }

  const allowedSet = allowedRegions ? new Set(allowedRegions) : null;

  // Per-region health tracking: name → unhealthyUntilMs.
  const unhealthyUntil = new Map();

  const stats = {
    totalRequests:     0,
    successful:        0,
    failed:            0,
    failoversPerformed: 0,
    byRegionSuccess:   {},
    byRegionFailure:   {},
    filteredResidency: 0,
  };

  function filterRegions() {
    const t = now();
    const out = [];
    let filteredResidency = 0;
    let filteredUnhealthy = 0;
    for (const r of regions) {
      if (allowedSet && !allowedSet.has(r.name)) { filteredResidency++; continue; }
      const until = unhealthyUntil.get(r.name);
      if (until != null && until > t) { filteredUnhealthy++; continue; }
      // Cooldown expired → clean up map.
      if (until != null && until <= t) unhealthyUntil.delete(r.name);
      out.push(r);
    }
    return { candidates: out, filteredResidency, filteredUnhealthy };
  }

  function markUnhealthy(name) {
    if (unhealthyCooldownMs > 0) {
      unhealthyUntil.set(name, now() + unhealthyCooldownMs);
    }
  }

  async function withTimeout(promise, ms, label) {
    if (!ms || ms <= 0) return promise;
    let t;
    const timeout = new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error(`${label}: timed out after ${ms}ms`)), ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(t);
    }
  }

  async function chat(request) {
    stats.totalRequests++;

    const { candidates, filteredResidency, filteredUnhealthy } = filterRegions();
    if (filteredResidency > 0) stats.filteredResidency++;

    if (candidates.length === 0) {
      const filteredCount = filteredResidency + filteredUnhealthy;
      stats.failed++;
      throw new AllRegionsFailedError(
        new Error('no eligible regions (all filtered by residency policy or unhealthy)'),
        [],
        filteredCount,
      );
    }

    const attempts = [];
    let lastError = null;

    for (let i = 0; i < candidates.length; i++) {
      const r = candidates[i];
      if (onSelected) {
        try { onSelected({ region: r.name, attempt: i + 1, ofCandidates: candidates.length }); }
        catch { /* swallow */ }
      }

      const startedAt = now();
      try {
        const result = await withTimeout(
          r.service.chat(request),
          perRegionTimeoutMs,
          `regionFailover(${r.name})`,
        );
        stats.successful++;
        stats.byRegionSuccess[r.name] = (stats.byRegionSuccess[r.name] ?? 0) + 1;
        attempts.push({ region: r.name, ok: true, durationMs: now() - startedAt });
        return { ...result, region: r.name, attempts };
      } catch (err) {
        const durationMs = now() - startedAt;
        attempts.push({ region: r.name, ok: false, error: err?.message ?? String(err), durationMs });
        stats.byRegionFailure[r.name] = (stats.byRegionFailure[r.name] ?? 0) + 1;
        lastError = err;

        // Should we try next region?
        const shouldFailover = isFallback(err);
        if (!shouldFailover || i === candidates.length - 1) {
          // Either non-retryable OR final region — surface.
          markUnhealthy(r.name);   // still count against this region's health
          break;
        }

        // Fail over to next.
        markUnhealthy(r.name);
        stats.failoversPerformed++;
        if (onFailover) {
          try {
            onFailover({
              from: r.name,
              to:   candidates[i + 1]?.name ?? null,
              error: err,
              attempt: i + 1,
              durationMs,
            });
          } catch { /* swallow */ }
        }
      }
    }

    stats.failed++;
    throw new AllRegionsFailedError(lastError, attempts, filteredResidency);
  }

  return {
    chat,
    stats,
    reset() {
      stats.totalRequests = stats.successful = stats.failed = 0;
      stats.failoversPerformed = stats.filteredResidency = 0;
      for (const k of Object.keys(stats.byRegionSuccess)) delete stats.byRegionSuccess[k];
      for (const k of Object.keys(stats.byRegionFailure)) delete stats.byRegionFailure[k];
      unhealthyUntil.clear();
    },
    /** Snapshot of currently-unhealthy regions + when they cool off. */
    unhealthySnapshot() {
      const t = now();
      const out = {};
      for (const [name, until] of unhealthyUntil) {
        if (until > t) out[name] = { unhealthyUntilMs: until, msRemaining: until - t };
      }
      return out;
    },
    /** Manually mark a region unhealthy (e.g., from an external health probe). */
    markRegionUnhealthy(name, ttlMs = unhealthyCooldownMs) {
      if (typeof name !== 'string') throw new Error('markRegionUnhealthy: name must be a string.');
      unhealthyUntil.set(name, now() + ttlMs);
    },
    /** Manually clear a region's unhealthy state. */
    clearRegionHealth(name) {
      unhealthyUntil.delete(name);
    },
    asMcpResource: () => ({
      uri: 'config://region-failover',
      name: 'Multi-region failover',
      description: 'Region routing + health tracking. Counters + config + unhealthy snapshot.',
      mimeType: 'application/json',
      handler: () => ({
        regionCount:         regions.length,
        allowedRegions:      allowedRegions,
        perRegionTimeoutMs,
        unhealthyCooldownMs,
        currentUnhealthy:    Object.keys(regionFailoverGetUnhealthy(unhealthyUntil, now())),
        ...stats,
      }),
    }),
  };
}

// Split out for MCP resource use.
function regionFailoverGetUnhealthy(map, t) {
  const out = {};
  for (const [name, until] of map) {
    if (until > t) out[name] = until;
  }
  return out;
}

module.exports = {
  regionFailover,
  AllRegionsFailedError,
  defaultIsFallback,
};
