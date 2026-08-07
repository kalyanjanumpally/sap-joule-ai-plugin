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
