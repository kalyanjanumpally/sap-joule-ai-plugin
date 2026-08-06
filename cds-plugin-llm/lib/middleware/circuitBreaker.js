// Circuit-breaker middleware for llm.use(). After N consecutive failures
// per provider bucket, opens the circuit and short-circuits subsequent
// calls with CircuitOpenError for `cooldownMs`. A half-open probe re-tests
// after the cooldown; success closes the circuit, failure re-opens it.
//
// Composes with retryOnRateLimit: retries handle transient throttling
// (429/503), the breaker handles sustained outage (5xx storms, provider
// down). Recommended chain:
//
//   promptInjectionGuard → guardrails → costBudget → circuitBreaker →
//   retryOnRateLimit → usageMetering → responseCache → provider
//
// Placing it OUTER of retry means: if the provider is truly down, we
// short-circuit BEFORE burning retry budget. Placing it INNER of
// costBudget means the pre-flight budget check still fires on a
// short-circuit (short-circuits are $0 but callers can still be
// budget-blocked from making the call).
//
//   const breaker = circuitBreaker({
//     threshold:        5,          // default 5 consecutive failures
//     cooldownMs:       30_000,     // default 30s open state
//     halfOpenAttempts: 1,          // default 1 probe
//     perProvider:      true,       // default true (per-provider buckets)
//     isFailure:        (err) => err?.status >= 500,
//     onOpen:  (info) => cds.log('llm:breaker').warn('circuit opened', info),
//     onClose: (info) => cds.log('llm:breaker').info('circuit closed', info),
//   });
//   llm.use(breaker);

class CircuitOpenError extends Error {
  constructor(provider, cooldownRemainingMs, lastError) {
    super(
      `circuitBreaker: circuit is OPEN for provider='${provider}' — ${cooldownRemainingMs}ms cooldown remaining. Last error: ${lastError?.message ?? 'unknown'}`,
    );
    this.name = 'CircuitOpenError';
    this.code = 'CIRCUIT_OPEN';
    this.provider = provider;
    this.cooldownRemainingMs = cooldownRemainingMs;
    this.cause = lastError;
  }
}

function defaultIsFailure(err) {
  // Default: 5xx, network errors, "provider outage" — but NOT 4xx
  // (client errors: bad prompts, missing tokens, invalid params). A
  // 400 shouldn't open the circuit — it's the caller's problem.
  const status = err?.status ?? err?.statusCode;
  if (status != null) return status >= 500;
  // No status → treat as network/transport failure (open the circuit)
  return true;
}

function circuitBreaker(options = {}) {
  const {
    threshold        = 5,
    cooldownMs       = 30_000,
    halfOpenAttempts = 1,
    perProvider      = true,
    isFailure        = defaultIsFailure,
    onOpen           = null,
    onClose          = null,
    onHalfOpen       = null,
  } = options;

  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new Error(`circuitBreaker: threshold must be a positive integer (got ${threshold}).`);
  }
  if (!Number.isFinite(cooldownMs) || cooldownMs < 0) {
    throw new Error(`circuitBreaker: cooldownMs must be a non-negative number (got ${cooldownMs}).`);
  }
  if (!Number.isInteger(halfOpenAttempts) || halfOpenAttempts < 1) {
    throw new Error(`circuitBreaker: halfOpenAttempts must be a positive integer (got ${halfOpenAttempts}).`);
  }

  // Per-bucket state. Bucket key is the provider label (or 'default' if
  // !perProvider). Each bucket: { state, consecutiveFailures, openedAt,
  // halfOpenAttemptsUsed, lastError }.
  const buckets = new Map();

  function bucketFor(ctx) {
    const key = perProvider ? (ctx?.service?.name || ctx?.provider || 'default') : 'default';
    let b = buckets.get(key);
    if (!b) {
      b = {
        state: 'closed',
        consecutiveFailures: 0,
        openedAt: null,
        halfOpenAttemptsUsed: 0,
        lastError: null,
      };
      buckets.set(key, b);
    }
    return { key, bucket: b };
  }

  const stats = {
    requests:       0,
    shortCircuited: 0,
    opens:          0,
    closes:         0,
    halfOpens:      0,
    failures:       0,
    successes:      0,
  };

  const mw = async (ctx, next) => {
    stats.requests++;
    const { key, bucket } = bucketFor(ctx);

    // OPEN state — check cooldown expiration
    if (bucket.state === 'open') {
      const elapsed = Date.now() - bucket.openedAt;
      if (elapsed >= cooldownMs) {
        bucket.state = 'halfOpen';
        bucket.halfOpenAttemptsUsed = 0;
        stats.halfOpens++;
        if (onHalfOpen) {
          try { onHalfOpen({ provider: key, method: ctx?.method }); } catch { /* swallow */ }
        }
      } else {
        stats.shortCircuited++;
        throw new CircuitOpenError(key, cooldownMs - elapsed, bucket.lastError);
      }
    }

    // HALF-OPEN state — allow up to halfOpenAttempts probes
    if (bucket.state === 'halfOpen') {
      if (bucket.halfOpenAttemptsUsed >= halfOpenAttempts) {
        // All half-open probes are in flight or exhausted → treat as open.
        stats.shortCircuited++;
        throw new CircuitOpenError(key, 0, bucket.lastError);
      }
      bucket.halfOpenAttemptsUsed++;
    }

    // CLOSED or HALF-OPEN with probe budget — try the call.
    try {
      const result = await next();
      // Success — close the circuit if half-open, reset failures.
      if (bucket.state === 'halfOpen') {
        bucket.state = 'closed';
        stats.closes++;
        if (onClose) {
          try { onClose({ provider: key, method: ctx?.method }); } catch { /* swallow */ }
        }
      }
      bucket.consecutiveFailures = 0;
      bucket.lastError = null;
      stats.successes++;
      return result;
    } catch (err) {
      // Failure — decide whether it counts against the breaker.
      if (!isFailure(err)) {
        // Non-counting failure (e.g. 4xx client error): reset consecutive counter,
        // don't advance the breaker. Rethrow as-is.
        bucket.consecutiveFailures = 0;
        throw err;
      }

      bucket.consecutiveFailures++;
      bucket.lastError = err;
      stats.failures++;

      if (bucket.state === 'halfOpen') {
        // Half-open probe failed → snap back to open.
        bucket.state = 'open';
        bucket.openedAt = Date.now();
        stats.opens++;
        if (onOpen) {
          try { onOpen({ provider: key, consecutiveFailures: bucket.consecutiveFailures, lastError: err, method: ctx?.method }); }
          catch { /* swallow */ }
        }
      } else if (bucket.consecutiveFailures >= threshold) {
        // Threshold reached → open the circuit.
        bucket.state = 'open';
        bucket.openedAt = Date.now();
        stats.opens++;
        if (onOpen) {
          try { onOpen({ provider: key, consecutiveFailures: bucket.consecutiveFailures, lastError: err, method: ctx?.method }); }
          catch { /* swallow */ }
        }
      }
      throw err;
    }
  };

  mw.stats = stats;
  mw.state = (provider) => {
    const key = perProvider ? (provider ?? 'default') : 'default';
    const b = buckets.get(key);
    if (!b) return { state: 'closed', consecutiveFailures: 0, openedAt: null };
    return {
      state: b.state,
      consecutiveFailures: b.consecutiveFailures,
      openedAt: b.openedAt,
      cooldownRemainingMs: b.state === 'open' ? Math.max(0, cooldownMs - (Date.now() - b.openedAt)) : 0,
    };
  };
  mw.reset = (provider) => {
    if (provider) {
      buckets.delete(perProvider ? provider : 'default');
    } else {
      buckets.clear();
      stats.requests = stats.shortCircuited = stats.opens = stats.closes = stats.halfOpens = stats.failures = stats.successes = 0;
    }
  };
  mw.forceOpen = (provider) => {
    const key = perProvider ? (provider ?? 'default') : 'default';
    let b = buckets.get(key);
    if (!b) {
      b = { state: 'closed', consecutiveFailures: 0, openedAt: null, halfOpenAttemptsUsed: 0, lastError: null };
      buckets.set(key, b);
    }
    b.state = 'open';
    b.openedAt = Date.now();
    stats.opens++;
  };
  mw.forceClose = (provider) => {
    const key = perProvider ? (provider ?? 'default') : 'default';
    const b = buckets.get(key);
    if (b) {
      b.state = 'closed';
      b.consecutiveFailures = 0;
      b.openedAt = null;
      b.halfOpenAttemptsUsed = 0;
      stats.closes++;
    }
  };
  mw.asMcpResource = () => ({
    uri: 'config://circuit-breaker',
    name: 'Circuit-breaker middleware',
    description: 'Per-provider circuit state + open/close counters.',
    mimeType: 'application/json',
    handler: () => {
      const bucketsSnap = {};
      for (const [k, b] of buckets.entries()) {
        bucketsSnap[k] = {
          state: b.state,
          consecutiveFailures: b.consecutiveFailures,
          openedAt: b.openedAt,
          cooldownRemainingMs: b.state === 'open' ? Math.max(0, cooldownMs - (Date.now() - b.openedAt)) : 0,
        };
      }
      return {
        threshold, cooldownMs, halfOpenAttempts, perProvider,
        buckets: bucketsSnap,
        ...stats,
      };
    },
  });
  return mw;
}

module.exports = { circuitBreaker, CircuitOpenError };
