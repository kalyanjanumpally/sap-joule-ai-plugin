// Chaos injector. Deterministically seeded fault injection for CI +
// resilience testing of the shipped middleware chain. Reproduces the
// same fault sequence given the same seed, so a red CI run can be
// re-run locally byte-identical.
//
// SAFETY: this primitive is intentionally test-only. It refuses to
// construct unless one of:
//   - `process.env.NODE_ENV === 'test'`
//   - `process.env.CHAOS_INJECTOR_ENABLED === '1'`
//   - `iKnowThisIsChaos: true` is passed explicitly.
// Deploying it to prod is a footgun; the guard makes that explicit.
//
// Typical use — verify that retry / bulkhead / circuitBreaker /
// adaptiveRateLimit / requestCoalescer / costAwareRouter behave
// correctly when the provider misbehaves:
//
//   const { chaosInjector, retryOnRateLimit, circuitBreaker } = require('@saptarishi/cds-plugin-llm');
//   llm.use(retryOnRateLimit());
//   llm.use(circuitBreaker());
//   llm.use(chaosInjector({
//     seed: 42,
//     faults: { rate429: 0.30, rateTimeout: 0.10, rateGarbage: 0.05 },
//   }));   // injector sits at the innermost layer, closest to the "provider"
//
// Fault priority (first roll that hits wins — stable for a given seed):
//   networkError → timeout → 500/503/429 → garbage → slow

// ---- Seedable PRNG (mulberry32) --------------------------------------
// 32-bit, deterministic, no dependencies. Same seed → same sequence.
function mulberry32(seed) {
  let s = (seed >>> 0) || 1;
  return function next() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- Fault defaults --------------------------------------------------

const DEFAULT_FAULTS = Object.freeze({
  rateNetworkError: 0,
  rateTimeout:      0,
  rate500:          0,
  rate503:          0,
  rate429:          0,
  rateGarbage:      0,
  rateSlow:         0,
});

// Priority order — first fault whose roll hits wins. Stable across
// versions so seeds remain reproducible.
const FAULT_ORDER = Object.freeze([
  'rateNetworkError',
  'rateTimeout',
  'rate500',
  'rate503',
  'rate429',
  'rateGarbage',
  'rateSlow',
]);

const GARBAGE_BODIES = Object.freeze([
  '',
  '{',
  'undefined',
  'null null null',
  '<html><body>502 Bad Gateway</body></html>',
  '{"malformed": tru',
]);

function makeStatusError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.statusCode = status;
  return err;
}

function makeNetworkError() {
  const err = new Error('ECONNRESET: chaos injector simulated network reset');
  err.code = 'ECONNRESET';
  return err;
}

function makeTimeoutError() {
  const err = new Error('ETIMEDOUT: chaos injector simulated timeout');
  err.code = 'ETIMEDOUT';
  return err;
}

// ---- Safety guard ----------------------------------------------------

function isChaosPermitted(opts) {
  if (opts.iKnowThisIsChaos === true) return true;
  if (process.env.NODE_ENV === 'test') return true;
  if (process.env.CHAOS_INJECTOR_ENABLED === '1') return true;
  return false;
}

// ---- Middleware ------------------------------------------------------

function chaosInjector(options = {}) {
  const {
    seed              = 42,
    faults            = {},
    slowMs            = 5000,
    garbageBodies     = GARBAGE_BODIES,
    filter            = null,
    onInject          = null,
    now               = () => Date.now(),
    sleep             = (ms) => new Promise((r) => setTimeout(r, ms).unref?.()),
  } = options;

  if (!isChaosPermitted(options)) {
    throw new Error(
      'chaosInjector: refusing to construct outside test contexts. ' +
      'Set NODE_ENV=test, CHAOS_INJECTOR_ENABLED=1, or pass iKnowThisIsChaos: true to override.',
    );
  }

  if (!Number.isInteger(seed)) {
    throw new Error(`chaosInjector: seed must be an integer (got ${seed}).`);
  }
  if (faults == null || typeof faults !== 'object') {
    throw new Error('chaosInjector: faults must be an object.');
  }
  for (const key of Object.keys(faults)) {
    if (!(key in DEFAULT_FAULTS)) {
      throw new Error(`chaosInjector: unknown fault "${key}" (allowed: ${Object.keys(DEFAULT_FAULTS).join(', ')}).`);
    }
    const v = faults[key];
    if (!Number.isFinite(v) || v < 0 || v > 1) {
      throw new Error(`chaosInjector: faults.${key} must be in [0, 1] (got ${v}).`);
    }
  }
  if (!Number.isFinite(slowMs) || slowMs < 0) {
    throw new Error(`chaosInjector: slowMs must be >= 0 (got ${slowMs}).`);
  }
  if (!Array.isArray(garbageBodies) || garbageBodies.length === 0) {
    throw new Error('chaosInjector: garbageBodies must be a non-empty array.');
  }
  if (filter != null && typeof filter !== 'function') {
    throw new Error('chaosInjector: filter must be a function or null.');
  }
  if (onInject != null && typeof onInject !== 'function') {
    throw new Error('chaosInjector: onInject must be a function or null.');
  }

  const resolved = { ...DEFAULT_FAULTS, ...faults };
  const rand = mulberry32(seed);

  const stats = {
    totalCalls:      0,
    skippedByFilter: 0,
    injected:        0,
    passthrough:     0,
    byFault:         {},
    lastFault:       null,
    lastSeedRoll:    null,
  };
  for (const k of FAULT_ORDER) stats.byFault[k] = 0;

  function callHook(hook, arg) {
    if (!hook) return;
    try { const r = hook(arg); if (r && typeof r.then === 'function') r.catch(() => {}); }
    catch { /* swallow */ }
  }

  // Decide which fault (if any) to inject for this call. Rolls the PRNG
  // once per fault type in stable order so the seed sequence is
  // deterministic — do NOT short-circuit as soon as a fault hits, or
  // later fault rates would consume different PRNG state depending on
  // whether an earlier one hit.
  function pickFault() {
    let chosen = null;
    const rolls = {};
    for (const k of FAULT_ORDER) {
      const r = rand();
      rolls[k] = r;
      if (chosen === null && r < resolved[k]) chosen = k;
    }
    stats.lastSeedRoll = rolls;
    return chosen;
  }

  const mw = async (ctx, next) => {
    stats.totalCalls++;

    if (filter && !filter(ctx)) {
      stats.skippedByFilter++;
      return next();
    }

    const chosen = pickFault();
    if (chosen == null) {
      stats.passthrough++;
      return next();
    }

    stats.injected++;
    stats.byFault[chosen]++;
    stats.lastFault = chosen;
    callHook(onInject, { fault: chosen, ctx });

    switch (chosen) {
      case 'rateNetworkError':
        throw makeNetworkError();
      case 'rateTimeout':
        throw makeTimeoutError();
      case 'rate500':
        throw makeStatusError(500, 'chaos: 500 Internal Server Error');
      case 'rate503':
        throw makeStatusError(503, 'chaos: 503 Service Unavailable');
      case 'rate429':
        throw makeStatusError(429, 'chaos: 429 Too Many Requests');
      case 'rateGarbage': {
        // Let next() run — but replace the response body with garbage
        // so downstream JSON / schema validators see a real broken
        // provider response.
        const result = await next();
        const idx = Math.floor(rand() * garbageBodies.length) % garbageBodies.length;
        const body = garbageBodies[idx];
        if (result && typeof result === 'object') {
          result.text = body;
          if ('data' in result) delete result.data;
          if ('parsed' in result) delete result.parsed;
          return result;
        }
        return { text: body };
      }
      case 'rateSlow':
        await sleep(slowMs);
        return next();
    }
    // Unreachable; keeps analysers happy.
    return next();
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.totalCalls = stats.skippedByFilter = stats.injected = stats.passthrough = 0;
    for (const k of FAULT_ORDER) stats.byFault[k] = 0;
    stats.lastFault = stats.lastSeedRoll = null;
  };
  mw.injectionRate = () => {
    return stats.totalCalls === 0 ? 0 : stats.injected / stats.totalCalls;
  };
  mw.asMcpResource = () => ({
    uri: 'config://chaos-injector',
    name: 'Chaos injector (test-only)',
    description: 'Deterministic seeded fault injection for CI resilience testing. Refuses to construct outside test contexts.',
    mimeType: 'application/json',
    handler: () => ({
      seed,
      slowMs,
      faults: resolved,
      injectionRate: mw.injectionRate(),
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  chaosInjector,
  // Exposed for tests + composition.
  mulberry32,
  FAULT_ORDER,
  DEFAULT_FAULTS,
  GARBAGE_BODIES,
};
