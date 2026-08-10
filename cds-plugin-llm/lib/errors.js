// Structured error taxonomy for @saptarishi/cds-plugin-llm.
//
// Every public error class in the plugin extends `LLMError`, carrying a
// stable `.code` field. `errorRegistry` maps each code to the primitive
// that raised it plus retriability + HTTP status + severity, so
// consumers can do:
//
//   try {
//     await llm.chat(...);
//   } catch (err) {
//     if (err instanceof LLMError) {
//       const meta = errorRegistry[err.code];
//       res.status(meta.httpStatus).json({
//         code: err.code,
//         primitive: err.primitive,
//         retriable: err.retriable,
//         message: err.message,
//       });
//       return;
//     }
//     throw err;   // unknown / provider-native — re-raise
//   }
//
// The taxonomy is DATA — adding a new error primitive means:
//   1. Add a new entry to `errorRegistry`
//   2. Make the new error class `extends LLMError`
//   3. Pass its code to super() in the constructor
// No enum, no switch statement to update.

// ---- Codes + metadata -------------------------------------------------

const errorRegistry = {
  // Rate-limit + retry family
  RATE_LIMIT_GIVE_UP: {
    primitive:  'retryOnRateLimit',
    retriable:  false,   // already exhausted retries; retrying again is silly
    httpStatus: 429,
    severity:   'error',
  },
  // Resilience quartet
  CIRCUIT_OPEN: {
    primitive:  'circuitBreaker',
    retriable:  true,    // safe to retry AFTER cooldown; the cooldownRemainingMs field tells caller when
    httpStatus: 503,
    severity:   'error',
  },
  BULKHEAD_FULL: {
    primitive:  'bulkhead',
    retriable:  true,    // safe to retry immediately with backoff
    httpStatus: 429,
    severity:   'warning',
  },
  BULKHEAD_TIMEOUT: {
    primitive:  'bulkhead',
    retriable:  true,
    httpStatus: 429,
    severity:   'warning',
  },
  DEADLINE_EXCEEDED: {
    primitive:  'deadline',
    retriable:  false,   // caller's budget was consumed; give up
    httpStatus: 504,
    severity:   'error',
  },
  ALL_PROVIDERS_FAILED: {
    primitive:  'chatWithFallback',
    retriable:  false,   // every fallback exhausted
    httpStatus: 502,
    severity:   'error',
  },
  // Cost family
  COST_GUARD_BLOCKED: {
    primitive:  'costGuard',
    retriable:  false,   // same request will always exceed the ceiling
    httpStatus: 402,     // Payment Required — semantic match for "over cost limit"
    severity:   'error',
  },
  BUDGET_EXCEEDED: {
    primitive:  'costBudget',
    retriable:  false,   // budget won't refund until window resets
    httpStatus: 402,
    severity:   'error',
  },
  BUDGET_TOO_TIGHT: {
    primitive:  'adaptiveMaxTokens',
    retriable:  false,   // budget won't refund until window resets
    httpStatus: 402,     // Payment Required — semantically same as budget exhaustion
    severity:   'error',
  },
  // Testing family
  MISSING_FIXTURE: {
    primitive:  'testing.replay',
    retriable:  false,   // fixture is either recorded or not — retrying won't help
    httpStatus: 500,     // test infrastructure issue — surfaces as server error if it leaks to prod
    severity:   'error',
  },
  // Security family
  PROMPT_INJECTION: {
    primitive:  'promptInjectionGuard',
    retriable:  false,   // caller's input triggered the guard; not a transient failure
    httpStatus: 400,
    severity:   'error',
  },
  GUARDRAIL_BLOCKED: {
    primitive:  'guardrails',
    retriable:  false,
    httpStatus: 400,
    severity:   'error',
  },
  // Contract-validation family
  STRUCTURED_OUTPUT_INVALID: {
    primitive:  'structuredOutputValidator',
    retriable:  false,   // internal retry already exhausted (or disabled)
    httpStatus: 502,     // Bad Gateway — upstream (LLM) returned malformed data
    severity:   'error',
  },
  // Idempotency family
  IDEMPOTENCY_IN_FLIGHT: {
    primitive:  'idempotency',
    retriable:  true,    // safe to retry once the original completes (short wait)
    httpStatus: 409,     // Conflict — a request with this key is already being processed
    severity:   'warning',
  },
  // Safety-classification family
  SAFETY_CLASSIFIER_BLOCKED: {
    primitive:  'safetyClassifier',
    retriable:  false,   // response tripped a category threshold; retry won't fix
    httpStatus: 400,     // Bad Request — the content itself is disallowed
    severity:   'error',
  },
  // Distributed lock family
  DISTRIBUTED_LOCK_HELD: {
    primitive:  'distributedLock',
    retriable:  true,    // safe to retry once the lock holder finishes
    httpStatus: 423,     // Locked
    severity:   'warning',
  },
  DISTRIBUTED_LOCK_TIMEOUT: {
    primitive:  'distributedLock',
    retriable:  true,    // safe to retry with longer patience or lower load
    httpStatus: 503,     // Service Unavailable — waited too long
    severity:   'error',
  },
  // Multi-region failover family
  ALL_REGIONS_FAILED: {
    primitive:  'regionFailover',
    retriable:  false,   // every eligible region tried and failed; retrying won't help
    httpStatus: 502,     // Bad Gateway — upstream regions all failed
    severity:   'error',
  },
};

// ---- Base class -------------------------------------------------------

/**
 * Base class for every public error thrown by the plugin. Subclasses pass
 * their code to super(); LLMError enriches with metadata from
 * `errorRegistry`.
 */
class LLMError extends Error {
  constructor(message, code) {
    super(message);
    const meta = errorRegistry[code] ?? {};
    // Preserve the subclass name (`CircuitOpenError`, `BulkheadFullError`, etc.)
    // so instanceof + toString both remain useful.
    this.name = new.target.name;
    this.code = code;
    this.primitive  = meta.primitive  ?? 'unknown';
    this.retriable  = meta.retriable  ?? false;
    this.httpStatus = meta.httpStatus ?? 500;
    this.severity   = meta.severity   ?? 'error';
    // Node ≥14: preserve stack trace without the constructor frame.
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, new.target);
    }
  }
}

// ---- Helper ----------------------------------------------------------

/** Convenience: `if (isLLMError(e)) handle(e)`. */
function isLLMError(err) {
  return err instanceof LLMError;
}

module.exports = { LLMError, errorRegistry, isLLMError };
