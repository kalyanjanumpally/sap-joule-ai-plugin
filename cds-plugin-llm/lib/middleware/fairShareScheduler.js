// Multi-tenant fair-share scheduler. Sits above the shipped `bulkhead`
// (or acts as its own concurrency gate) and admits requests in a
// weighted round-robin (WRR) order across tenants. No single tenant can
// starve the others under load; per-tenant queue depth caps prevent one
// tenant from consuming all memory during a spike.
//
//   const { fairShareScheduler, bulkhead } = require('@saptarishi/cds-plugin-llm');
//
//   llm.use(fairShareScheduler({
//     tenantOf:         (ctx) => ctx.request.tenantId ?? 'anon',
//     maxConcurrent:    20,
//     weights:          { gold: 5, silver: 2, free: 1 },
//     defaultWeight:    1,
//     maxPerTenantQueue: 100,
//     onReject: (i) => cds.log('llm:fair-share').warn('backpressure', i),
//   }));
//
// Distinct from 1.x `tenantIsolate` (which TAGS requests for observability)
// and `bulkhead` (which caps concurrency globally without fairness). This
// primitive adds a *scheduler*: when the bulkhead is full, the next
// request admitted is the one from the tenant with the most credit,
// not FIFO. That's the difference between "we cap requests" and "we
// share requests fairly."
//
// Distinct from `distributedLock` (per-key exclusive locking across
// instances). Fair-share is per-tenant queueing WITHIN an instance.

const { LLMError } = require('../errors');

class FairShareRejectedError extends LLMError {
  constructor({ tenant, queueDepth, queueLimit }) {
    super(
      `fairShareScheduler: tenant "${tenant}" queue is full (depth=${queueDepth}, limit=${queueLimit}).`,
      'FAIR_SHARE_QUEUE_FULL',
    );
    this.tenant     = tenant;
    this.queueDepth = queueDepth;
    this.queueLimit = queueLimit;
  }
}

function fairShareScheduler(options = {}) {
  const {
    tenantOf,
    maxConcurrent      = 10,
    weights            = {},
    defaultWeight      = 1,
    maxPerTenantQueue  = 100,
    onAdmit            = null,
    onQueue            = null,
    onReject           = null,
    onError            = null,
    now                = () => Date.now(),
  } = options;

  if (typeof tenantOf !== 'function') {
    throw new Error('fairShareScheduler: tenantOf must be a function (ctx) => string.');
  }
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error(`fairShareScheduler: maxConcurrent must be a positive integer (got ${maxConcurrent}).`);
  }
  if (weights == null || typeof weights !== 'object') {
    throw new Error('fairShareScheduler: weights must be an object.');
  }
  for (const [k, w] of Object.entries(weights)) {
    if (!Number.isInteger(w) || w < 1) {
      throw new Error(`fairShareScheduler: weights.${k} must be a positive integer (got ${w}).`);
    }
  }
  if (!Number.isInteger(defaultWeight) || defaultWeight < 1) {
    throw new Error(`fairShareScheduler: defaultWeight must be a positive integer (got ${defaultWeight}).`);
  }
  if (!Number.isInteger(maxPerTenantQueue) || maxPerTenantQueue < 1) {
    throw new Error(`fairShareScheduler: maxPerTenantQueue must be a positive integer (got ${maxPerTenantQueue}).`);
  }
  for (const cb of [onAdmit, onQueue, onReject, onError]) {
    if (cb != null && typeof cb !== 'function') {
      throw new Error('fairShareScheduler: callbacks must be functions or null.');
    }
  }

  // Per-tenant state, lazily created. `credits` is the WRR budget that
  // gets refilled from `weight` when every tenant with pending work has
  // hit zero.
  //
  //   { weight, credits, queue: waiter[], active: int, totalAdmitted, totalRejected, totalQueued }
  const tenants = new Map();

  function stateFor(tenantId) {
    let s = tenants.get(tenantId);
    if (!s) {
      s = {
        weight:         weights[tenantId] ?? defaultWeight,
        credits:        weights[tenantId] ?? defaultWeight,
        queue:          [],
        active:         0,
        totalAdmitted:  0,
        totalRejected:  0,
        totalQueued:    0,
      };
      tenants.set(tenantId, s);
    }
    return s;
  }

  let activeCount = 0;

  const stats = {
    totalCalls:       0,
    totalAdmitted:    0,
    totalRejected:    0,
    totalQueued:      0,
    peakActive:       0,
    peakQueued:       0,
    lastTenant:       null,
    lastAdmitLatencyMs: null,
    byTenant:         {},   // read-through of the per-tenant map, populated at read time
  };

  function callHook(hook, arg) {
    if (!hook) return;
    try { const r = hook(arg); if (r && typeof r.then === 'function') r.catch(() => {}); }
    catch { /* swallow */ }
  }

  function totalQueuedNow() {
    let n = 0;
    for (const s of tenants.values()) n += s.queue.length;
    return n;
  }

  // WRR pick: among tenants with pending work, choose the one with the
  // highest positive credit. If no positive credits remain, refill
  // credits from weight and re-select.
  function pickNextTenant() {
    // First pass — look for a tenant with pending work AND positive credits.
    let best = null;
    for (const [id, s] of tenants.entries()) {
      if (s.queue.length === 0) continue;
      if (s.credits <= 0) continue;
      if (best === null || s.credits > best.state.credits) {
        best = { id, state: s };
      }
    }
    if (best) return best;
    // Second pass — everyone with pending work is out of credit. Refill
    // and repeat (only for tenants that have work).
    let anyPending = false;
    for (const s of tenants.values()) {
      if (s.queue.length > 0) {
        anyPending = true;
        s.credits = s.weight;
      }
    }
    if (!anyPending) return null;
    for (const [id, s] of tenants.entries()) {
      if (s.queue.length === 0) continue;
      if (best === null || s.credits > best.state.credits) {
        best = { id, state: s };
      }
    }
    return best;
  }

  // When a slot frees, drain as many queued waiters as we have capacity.
  function drain() {
    while (activeCount < maxConcurrent) {
      const pick = pickNextTenant();
      if (!pick) return;
      const { id: tenantId, state } = pick;
      const waiter = state.queue.shift();
      if (!waiter) continue;
      state.credits--;
      admit(tenantId, state, waiter);
    }
  }

  function admit(tenantId, state, waiter) {
    state.active++;
    state.totalAdmitted++;
    activeCount++;
    stats.totalAdmitted++;
    stats.lastTenant = tenantId;
    if (activeCount > stats.peakActive) stats.peakActive = activeCount;
    const latencyMs = now() - waiter.enqueuedAt;
    stats.lastAdmitLatencyMs = latencyMs;
    callHook(onAdmit, { tenant: tenantId, waitMs: latencyMs, activeCount });
    waiter.resolve();
  }

  const mw = async (ctx, next) => {
    stats.totalCalls++;

    let tenantId;
    try { tenantId = tenantOf(ctx); }
    catch (err) {
      callHook(onError, { phase: 'tenantOf', error: err });
      throw err;
    }
    if (typeof tenantId !== 'string' || tenantId.length === 0) {
      tenantId = '__anon__';
    }

    const state = stateFor(tenantId);

    // Backpressure check — enforced BEFORE we try to admit so an over-
    // subscribed tenant fails fast rather than growing the queue.
    if (state.queue.length >= maxPerTenantQueue) {
      state.totalRejected++;
      stats.totalRejected++;
      const err = new FairShareRejectedError({
        tenant: tenantId,
        queueDepth: state.queue.length,
        queueLimit: maxPerTenantQueue,
      });
      callHook(onReject, { tenant: tenantId, queueDepth: state.queue.length, queueLimit: maxPerTenantQueue });
      throw err;
    }

    // Fast path — spare capacity + no pending work anywhere else.
    if (activeCount < maxConcurrent && totalQueuedNow() === 0) {
      state.credits = Math.max(0, state.credits - 1);
      state.active++;
      state.totalAdmitted++;
      activeCount++;
      stats.totalAdmitted++;
      stats.lastTenant = tenantId;
      if (activeCount > stats.peakActive) stats.peakActive = activeCount;
      stats.lastAdmitLatencyMs = 0;
      callHook(onAdmit, { tenant: tenantId, waitMs: 0, activeCount });
    } else {
      // Queue it.
      const enqueuedAt = now();
      state.totalQueued++;
      stats.totalQueued++;
      const qDepthNow = totalQueuedNow() + 1;
      if (qDepthNow > stats.peakQueued) stats.peakQueued = qDepthNow;
      callHook(onQueue, {
        tenant: tenantId,
        queueDepth: state.queue.length + 1,
        totalQueued: qDepthNow,
      });
      await new Promise((resolve) => {
        state.queue.push({ resolve, enqueuedAt });
      });
      // Admission handled by drain(); we resume here.
    }

    try {
      return await next();
    } finally {
      state.active--;
      activeCount--;
      drain();
    }
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.totalCalls = stats.totalAdmitted = stats.totalRejected = 0;
    stats.totalQueued = stats.peakActive = stats.peakQueued = 0;
    stats.lastTenant = stats.lastAdmitLatencyMs = null;
    for (const s of tenants.values()) {
      s.credits = s.weight;
      s.totalAdmitted = s.totalRejected = s.totalQueued = 0;
      // Don't touch active — those are real in-flight calls.
      // Don't drop the queue — those are real in-flight waiters.
    }
  };
  mw.activeCount = () => activeCount;
  mw.queuedCount = () => totalQueuedNow();
  mw.tenantCount = () => tenants.size;
  mw.snapshotTenants = () => {
    const out = {};
    for (const [id, s] of tenants.entries()) {
      out[id] = {
        weight:        s.weight,
        credits:       s.credits,
        active:        s.active,
        queued:        s.queue.length,
        totalAdmitted: s.totalAdmitted,
        totalRejected: s.totalRejected,
        totalQueued:   s.totalQueued,
      };
    }
    return out;
  };
  mw.asMcpResource = () => ({
    uri: 'config://fair-share-scheduler',
    name: 'Fair-share scheduler',
    description: 'Weighted round-robin per-tenant admission control on top of a shared concurrency ceiling.',
    mimeType: 'application/json',
    handler: () => ({
      maxConcurrent,
      defaultWeight,
      maxPerTenantQueue,
      configuredWeights: weights,
      currentActive: activeCount,
      currentQueued: totalQueuedNow(),
      tenants: mw.snapshotTenants(),
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  fairShareScheduler,
  FairShareRejectedError,
};
