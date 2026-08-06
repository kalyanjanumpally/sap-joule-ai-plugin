// Aggregate health-check for the resilience quartet + deadline + budget.
// Returns:
//
//   {
//     status: 'ok' | 'degraded' | 'down',
//     degraded: [{ layer: string, reason: string }],
//     primitives: {
//       deadline: { requests, expired, activeCount },
//       breaker:  { openBuckets, opens, closes },
//       bulkhead: { saturated, rejected, timedOut },
//       budget:   { spent, limit, overLimit },
//       retry:    { requests, givenUp },
//       cache:    { hitRate, size },
//       guardrails: { inputBlocks, outputBlocks, inputRedacts, outputRedacts },
//       injectionGuard: { scanned, blocked, sanitized, warned },
//       metering: { totalRequests, totalCost, totalCachedHits },
//     },
//     custom: { [name]: { ok, reason } },
//   }
//
// Two entry points:
//
//   1. healthHandler({...})  — Express/CAP-shaped route factory
//        app.get('/health', healthHandler({ deadline, breaker, bulkhead, ... }));
//
//   2. healthCheck({...})    — programmatic access for custom routes
//        const snap = await healthCheck({ deadline, breaker, bulkhead });
//        cds.log('health').info(snap);
//
// Extends cleanly:
//   - `custom: [{ name, check: async () => ({ ok, reason }) }]` for
//     app-specific probes (DB ping, downstream service, etc.)
//   - `isDegraded: { breaker: (snap) => bool, ... }` to override
//     the built-in per-primitive degraded predicates.
//
// Status codes:
//   200 for 'ok' AND 'degraded' (app still serving)
//   503 for 'down' (any custom probe returned ok=false, or forced by
//       `treatDegradedAs: 503`)

// ---- Default degraded predicates ----------------------------------------

const DEFAULT_IS_DEGRADED = {
  deadline: (snap) => snap.expired > 0,
  breaker:  (snap) => snap.openBuckets.length > 0,
  bulkhead: (snap) => snap.rejected > 0 || snap.timedOut > 0,
  budget:   (snap) => !!snap.overLimit,
  retry:    (snap) => snap.givenUp > 0,
  guardrails:     () => false,
  injectionGuard: () => false,
  metering:       () => false,
  cache:          () => false,
};

// ---- Primitive snapshotters --------------------------------------------

function snapshotDeadline(dl) {
  if (!dl?.stats) return null;
  return {
    requests:    dl.stats.requests    ?? 0,
    expired:     dl.stats.expired     ?? 0,
    activeCount: dl.stats.activeCount ?? 0,
  };
}

function snapshotBreaker(br) {
  if (!br?.stats || typeof br.asMcpResource !== 'function') return null;
  const snap = br.asMcpResource().handler();
  const openBuckets = Object.entries(snap.buckets ?? {})
    .filter(([, s]) => s.state === 'open')
    .map(([k]) => k);
  return {
    openBuckets,
    opens:  snap.opens  ?? 0,
    closes: snap.closes ?? 0,
    shortCircuited: snap.shortCircuited ?? 0,
  };
}

function snapshotBulkhead(bh) {
  if (!bh?.stats || typeof bh.asMcpResource !== 'function') return null;
  const snap = bh.asMcpResource().handler();
  const saturated = Object.entries(snap.buckets ?? {})
    .filter(([, s]) => s.queued > 0)
    .map(([k, s]) => ({ provider: k, inFlight: s.inFlight, queued: s.queued }));
  return {
    saturated,
    rejected: snap.rejected ?? 0,
    timedOut: snap.timedOut ?? 0,
  };
}

async function snapshotBudget(budget) {
  if (!budget?.snapshot) return null;
  const snap = await budget.snapshot();
  const totalLimit = typeof budget.limitFor === 'function'
    ? budget.limitFor('total', 'total')
    : null;
  const spent = snap.total ?? 0;
  return {
    spent,
    limit:     totalLimit ?? null,
    overLimit: totalLimit != null && spent > totalLimit,
  };
}

function snapshotRetry(retry) {
  if (!retry?.stats) return null;
  return {
    requests: retry.stats.requests ?? 0,
    givenUp:  retry.stats.givenUp  ?? 0,
  };
}

function snapshotGuardrails(gr) {
  if (!gr?.stats) return null;
  return {
    inputBlocks:   gr.stats.inputBlocks   ?? 0,
    outputBlocks:  gr.stats.outputBlocks  ?? 0,
    inputRedacts:  gr.stats.inputRedacts  ?? 0,
    outputRedacts: gr.stats.outputRedacts ?? 0,
  };
}

function snapshotInjection(g) {
  if (!g?.stats) return null;
  return {
    scanned:   g.stats.scanned   ?? 0,
    blocked:   g.stats.blocked   ?? 0,
    sanitized: g.stats.sanitized ?? 0,
    warned:    g.stats.warned    ?? 0,
  };
}

function snapshotMetering(meter) {
  if (typeof meter?.summary !== 'function') return null;
  const s = meter.summary();
  return {
    totalRequests:    s.totalRequests    ?? 0,
    totalCost:        s.totalCost        ?? 0,
    totalCachedHits:  s.totalCachedHits  ?? 0,
  };
}

function snapshotCache(cache) {
  if (!cache?.stats) return null;
  return {
    hitRate: typeof cache.hitRate === 'function' ? cache.hitRate() : null,
    size:    typeof cache.size    === 'function' ? cache.size()    : null,
    hits:    cache.stats.hits    ?? 0,
    misses:  cache.stats.misses  ?? 0,
  };
}

// ---- Programmatic entry -------------------------------------------------

/**
 * Snapshot the health of every provided middleware primitive and return
 * a unified { status, degraded, primitives, custom } object.
 *
 * Every slot is optional — pass whichever middleware you have wired.
 */
async function healthCheck(mw = {}) {
  const {
    deadline: dl,
    breaker,
    bh,
    bulkhead,           // accept either `bh` or `bulkhead` as the key
    budget,
    retry,
    guardrails: gr,
    injectionGuard,
    metering,
    cache,
    custom = [],
    isDegraded = {},
  } = mw;

  const bhInstance = bh ?? bulkhead;

  const primitives = {};
  const degraded = [];
  const customResults = {};

  const check = (name, snap) => {
    if (snap == null) return;
    primitives[name] = snap;
    const pred = isDegraded[name] ?? DEFAULT_IS_DEGRADED[name];
    if (pred && pred(snap)) {
      degraded.push({ layer: name, reason: buildDegradedReason(name, snap) });
    }
  };

  check('deadline',       snapshotDeadline(dl));
  check('breaker',        snapshotBreaker(breaker));
  check('bulkhead',       snapshotBulkhead(bhInstance));
  check('budget',         await snapshotBudget(budget));
  check('retry',          snapshotRetry(retry));
  check('guardrails',     snapshotGuardrails(gr));
  check('injectionGuard', snapshotInjection(injectionGuard));
  check('metering',       snapshotMetering(metering));
  check('cache',          snapshotCache(cache));

  let downFromCustom = false;
  for (const probe of custom) {
    if (!probe || typeof probe.check !== 'function') continue;
    let result;
    try {
      result = await probe.check();
    } catch (e) {
      result = { ok: false, reason: `probe threw: ${e.message}` };
    }
    customResults[probe.name] = {
      ok:     !!result?.ok,
      reason: result?.reason ?? null,
    };
    if (!result?.ok) {
      downFromCustom = true;
      degraded.push({
        layer:  `custom:${probe.name}`,
        reason: result?.reason ?? 'custom probe failed',
      });
    }
  }

  const status = downFromCustom
    ? 'down'
    : (degraded.length > 0 ? 'degraded' : 'ok');

  return { status, degraded, primitives, custom: customResults };
}

function buildDegradedReason(layer, snap) {
  switch (layer) {
    case 'deadline':
      return `${snap.expired} requests exceeded time budget`;
    case 'breaker':
      return `providers open: ${snap.openBuckets.join(', ')}`;
    case 'bulkhead':
      return `${snap.rejected} rejected, ${snap.timedOut} timed out`;
    case 'budget':
      return `spent ${Number(snap.spent).toFixed(2)} exceeds limit ${snap.limit}`;
    case 'retry':
      return `${snap.givenUp} requests gave up after retries`;
    default:
      return `${layer} degraded`;
  }
}

// ---- Express/CAP-shaped route factory ----------------------------------

/**
 * Return an Express-compatible `(req, res) => void` route that responds
 * with the unified health snapshot. Sets Content-Type, computes status
 * codes.
 *
 * @param {object} mw   Middleware handles + optional custom probes / overrides
 * @param {object} [options]
 * @param {number} [options.treatDegradedAs=200]  HTTP status for 'degraded' state
 * @param {number} [options.treatDownAs=503]      HTTP status for 'down' state
 */
function healthHandler(mw = {}, options = {}) {
  const {
    treatDegradedAs = 200,
    treatDownAs     = 503,
  } = options;
  return async function healthRoute(_req, res) {
    let payload;
    try {
      payload = await healthCheck(mw);
    } catch (e) {
      const errPayload = {
        status: 'down',
        degraded: [{ layer: 'health-handler', reason: `snapshot failed: ${e.message}` }],
        primitives: {},
        custom: {},
      };
      if (res.status && res.json) {
        return res.status(treatDownAs).json(errPayload);
      }
      if (res.writeHead && res.end) {
        res.writeHead(treatDownAs, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(errPayload));
      }
      return;
    }
    const code = payload.status === 'ok'       ? 200
             : payload.status === 'degraded'  ? treatDegradedAs
             : treatDownAs;
    if (res.status && res.json) {
      return res.status(code).json(payload);
    }
    if (res.writeHead && res.end) {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(payload));
    }
  };
}

module.exports = { healthCheck, healthHandler, DEFAULT_IS_DEGRADED };
