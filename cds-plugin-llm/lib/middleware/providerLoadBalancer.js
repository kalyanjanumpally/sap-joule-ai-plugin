// Provider load balancer. Rotate across N credential sets of the SAME
// provider kind — multiple OpenAI accounts to work around per-account
// rate limits, multiple Azure regions for geographic spread, multiple
// AWS Bedrock cross-account roles, etc. Complements the 1.x
// 11-provider abstraction (which currently supports one credential set
// per provider kind) with per-account rotation ON TOP of the same kind.
//
//   const { providerLoadBalancer } = require('@saptarishi/cds-plugin-llm');
//
//   llm.use(providerLoadBalancer({
//     credentials: [
//       { name: 'openai-org-a', apiKey: process.env.OPENAI_KEY_A, weight: 3 },
//       { name: 'openai-org-b', apiKey: process.env.OPENAI_KEY_B, weight: 1 },
//       { name: 'openai-org-c', apiKey: process.env.OPENAI_KEY_C, weight: 1 },
//     ],
//     strategy: 'least-loaded',
//     applyCredential: (req, cred) => ({ ...req, credentials: { apiKey: cred.apiKey } }),
//     unhealthyThreshold:  3,      // 3 consecutive failures → mark unhealthy
//     unhealthyCooldownMs: 30_000,
//   }));
//
// Strategies:
//   * `round-robin`     — cycle through credentials in order
//   * `least-loaded`    — pick the credential with the fewest in-flight calls
//   * `weighted-random` — pick with probability ∝ `weight`
//   * `sticky`          — same `stickyKeyOf(ctx)` value always picks the
//                         same credential (session affinity, tenant
//                         isolation across accounts)
//
// Placement: OUTSIDE providers, INSIDE routing (semanticRouter,
// costAwareRouter). The routing decides which model to use; this
// middleware decides which credential to use.

const { LLMError } = require('../errors');

class AllCredentialsUnhealthyError extends LLMError {
  constructor({ credentialNames }) {
    super(
      `providerLoadBalancer: all ${credentialNames.length} credentials are marked unhealthy.`,
      'ALL_CREDENTIALS_UNHEALTHY',
    );
    this.credentialNames = credentialNames;
  }
}

const STRATEGIES = Object.freeze(['round-robin', 'least-loaded', 'weighted-random', 'sticky']);

function providerLoadBalancer(options = {}) {
  const {
    credentials,
    strategy             = 'round-robin',
    applyCredential,
    stickyKeyOf          = null,
    unhealthyThreshold   = null,   // null = disable health tracking
    unhealthyCooldownMs  = 30_000,
    random               = Math.random,
    onSelect             = null,
    onCredentialError    = null,
    onHealthChange       = null,
    now                  = () => Date.now(),
  } = options;

  if (!Array.isArray(credentials) || credentials.length < 1) {
    throw new Error('providerLoadBalancer: credentials must be a non-empty array.');
  }
  for (let i = 0; i < credentials.length; i++) {
    const c = credentials[i];
    if (!c || typeof c !== 'object' || typeof c.name !== 'string') {
      throw new Error(`providerLoadBalancer: credentials[${i}] must be { name: string, ... }.`);
    }
    if (c.weight != null && (!Number.isInteger(c.weight) || c.weight < 1)) {
      throw new Error(`providerLoadBalancer: credentials[${i}] "${c.name}" weight must be a positive integer.`);
    }
  }
  if (!STRATEGIES.includes(strategy)) {
    throw new Error(`providerLoadBalancer: strategy must be one of ${STRATEGIES.join(', ')} (got ${JSON.stringify(strategy)}).`);
  }
  if (typeof applyCredential !== 'function') {
    throw new Error('providerLoadBalancer: applyCredential must be a function.');
  }
  if (strategy === 'sticky' && typeof stickyKeyOf !== 'function') {
    throw new Error('providerLoadBalancer: stickyKeyOf must be a function when strategy=sticky.');
  }
  if (unhealthyThreshold != null && (!Number.isInteger(unhealthyThreshold) || unhealthyThreshold < 1)) {
    throw new Error(`providerLoadBalancer: unhealthyThreshold must be a positive integer or null (got ${unhealthyThreshold}).`);
  }
  if (!Number.isInteger(unhealthyCooldownMs) || unhealthyCooldownMs < 100) {
    throw new Error(`providerLoadBalancer: unhealthyCooldownMs must be >= 100 (got ${unhealthyCooldownMs}).`);
  }
  for (const cb of [onSelect, onCredentialError, onHealthChange]) {
    if (cb != null && typeof cb !== 'function') {
      throw new Error('providerLoadBalancer: callbacks must be functions or null.');
    }
  }

  // Per-credential state.
  const state = credentials.map((c) => ({
    name:             c.name,
    weight:           c.weight ?? 1,
    inFlight:         0,
    totalPicks:       0,
    totalErrors:      0,
    consecutiveErrors: 0,
    healthy:          true,
    unhealthySince:   null,
  }));

  let rrCursor = 0;

  const stats = {
    totalCalls:       0,
    totalSelections:  0,
    healthChecks:     0,
    unhealthyAtSelect: 0,
    lastCredential:   null,
    lastStrategy:     strategy,
  };

  function callHook(hook, arg) {
    if (!hook) return;
    try { const r = hook(arg); if (r && typeof r.then === 'function') r.catch(() => {}); }
    catch { /* swallow */ }
  }

  function checkCoolDown() {
    if (unhealthyThreshold == null) return;
    const t = now();
    for (const s of state) {
      if (!s.healthy && s.unhealthySince != null && (t - s.unhealthySince) >= unhealthyCooldownMs) {
        s.healthy = true;
        s.consecutiveErrors = 0;
        s.unhealthySince = null;
        callHook(onHealthChange, { credential: s.name, healthy: true, reason: 'cooldown-expired' });
      }
    }
  }

  function healthy() {
    return state.filter((s) => s.healthy);
  }

  function pickRoundRobin(pool) {
    // Find the next healthy credential in circular order from rrCursor.
    for (let step = 0; step < state.length; step++) {
      const idx = (rrCursor + step) % state.length;
      if (state[idx].healthy) {
        rrCursor = (idx + 1) % state.length;
        return state[idx];
      }
    }
    return null;
  }

  function pickLeastLoaded(pool) {
    let best = null;
    for (const s of pool) {
      if (best === null || s.inFlight < best.inFlight) best = s;
    }
    return best;
  }

  function pickWeightedRandom(pool) {
    const total = pool.reduce((a, s) => a + s.weight, 0);
    if (total === 0) return pool[0] ?? null;
    let r = random() * total;
    for (const s of pool) {
      r -= s.weight;
      if (r <= 0) return s;
    }
    return pool[pool.length - 1];
  }

  function pickSticky(pool, key) {
    // Consistent-hash-lite: reduce the key to an integer via a simple
    // fold, then modulo across the healthy pool. If the healthy pool
    // shrinks, keys will rebalance — which is the correct behavior.
    let h = 5381;
    const str = String(key);
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    return pool[h % pool.length];
  }

  function pickCredential(ctx) {
    checkCoolDown();
    const pool = healthy();
    if (pool.length === 0) {
      // All unhealthy — throw.
      stats.unhealthyAtSelect++;
      throw new AllCredentialsUnhealthyError({ credentialNames: credentials.map((c) => c.name) });
    }
    switch (strategy) {
      case 'round-robin':     return pickRoundRobin(pool);
      case 'least-loaded':    return pickLeastLoaded(pool);
      case 'weighted-random': return pickWeightedRandom(pool);
      case 'sticky': {
        const key = stickyKeyOf(ctx);
        return pickSticky(pool, key ?? '');
      }
    }
    return null;
  }

  function recordSuccess(s) {
    s.consecutiveErrors = 0;
  }

  function recordError(s, err) {
    s.totalErrors++;
    s.consecutiveErrors++;
    callHook(onCredentialError, { credential: s.name, error: err, consecutiveErrors: s.consecutiveErrors });
    if (unhealthyThreshold != null && s.healthy && s.consecutiveErrors >= unhealthyThreshold) {
      s.healthy = false;
      s.unhealthySince = now();
      callHook(onHealthChange, { credential: s.name, healthy: false, reason: 'threshold-exceeded' });
    }
  }

  const mw = async (ctx, next) => {
    stats.totalCalls++;

    const chosen = pickCredential(ctx);
    stats.totalSelections++;
    stats.lastCredential = chosen.name;
    chosen.totalPicks++;
    chosen.inFlight++;

    // Locate the underlying credential object (has the actual secrets).
    const credObj = credentials.find((c) => c.name === chosen.name);
    callHook(onSelect, {
      credential: chosen.name,
      strategy,
      inFlight: chosen.inFlight,
    });

    const originalRequest = ctx.request;
    ctx.request = applyCredential(originalRequest, credObj);
    try {
      const result = await next();
      recordSuccess(chosen);
      return result;
    } catch (err) {
      recordError(chosen, err);
      throw err;
    } finally {
      chosen.inFlight--;
      ctx.request = originalRequest;
    }
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.totalCalls = stats.totalSelections = 0;
    stats.healthChecks = stats.unhealthyAtSelect = 0;
    stats.lastCredential = null;
    for (const s of state) {
      s.totalPicks = s.totalErrors = 0;
      s.consecutiveErrors = 0;
      s.healthy = true;
      s.unhealthySince = null;
      // Don't touch inFlight — those are real in-flight calls.
    }
    rrCursor = 0;
  };
  mw.snapshotCredentials = () => state.map((s) => ({ ...s }));
  mw.markUnhealthy = (name, reason = 'manual') => {
    const s = state.find((x) => x.name === name);
    if (!s || !s.healthy) return false;
    s.healthy = false;
    s.unhealthySince = now();
    callHook(onHealthChange, { credential: s.name, healthy: false, reason });
    return true;
  };
  mw.markHealthy = (name, reason = 'manual') => {
    const s = state.find((x) => x.name === name);
    if (!s || s.healthy) return false;
    s.healthy = true;
    s.consecutiveErrors = 0;
    s.unhealthySince = null;
    callHook(onHealthChange, { credential: s.name, healthy: true, reason });
    return true;
  };
  mw.asMcpResource = () => ({
    uri: 'config://provider-load-balancer',
    name: 'Provider load balancer',
    description: 'Rotate across N credential sets of the same provider kind. Round-robin / least-loaded / weighted-random / sticky.',
    mimeType: 'application/json',
    handler: () => ({
      strategy,
      credentialCount: credentials.length,
      unhealthyThreshold,
      unhealthyCooldownMs,
      credentials: mw.snapshotCredentials(),
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  providerLoadBalancer,
  AllCredentialsUnhealthyError,
  STRATEGIES,
};
