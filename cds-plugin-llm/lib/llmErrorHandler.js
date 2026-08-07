// HTTP error-handler middleware for CAP / Express / any 4-arg
// error-middleware runtime. Converts any LLMError (1.57.0 taxonomy)
// into a structured JSON response with the correct HTTP status,
// derived from `errorRegistry`.
//
// One-liner:
//
//   const { llmErrorHandler } = require('@saptarishi/cds-plugin-llm');
//   app.use(llmErrorHandler());
//
// Response shape:
//
//   HTTP {err.httpStatus}
//   Content-Type: application/json
//   Retry-After: {seconds}     (when applicable — see below)
//
//   {
//     "error": {
//       "code":       "CIRCUIT_OPEN",
//       "primitive":  "circuitBreaker",
//       "retriable":  true,
//       "severity":   "error",
//       "message":    "circuitBreaker: circuit is OPEN for provider='openai' ...",
//       "details":    { "provider": "openai", "cooldownRemainingMs": 25000 },
//       "stack":      "…"     (only if includeStack: true)
//     }
//   }
//
// Non-LLMError errors are passed to `next(err)` so downstream / default
// error handlers see them unchanged. Set `passThroughNonLLMErrors: false`
// to catch everything as a generic 500 instead (defense-in-depth for
// APIs that must never leak a stack trace).
//
// Retry-After header is set when the plugin can suggest a specific wait:
//   - CircuitOpenError → cooldownRemainingMs / 1000 (rounded up)
//   - BulkheadTimeoutError / BulkheadFullError → 1 (immediate retry with backoff)
// Other retriable errors have no header (caller decides backoff strategy).

const { isLLMError } = require('./errors');

const DEFAULT_MASK = [];

function llmErrorHandler(options = {}) {
  const {
    log                     = null,
    mask                    = DEFAULT_MASK,
    includeStack            = false,
    passThroughNonLLMErrors = true,
  } = options;

  if (!Array.isArray(mask)) {
    throw new Error('llmErrorHandler: mask must be an array of field names to strip.');
  }
  const maskSet = new Set(mask);

  return function llmErrorRoute(err, req, res, next) {
    // Non-LLMError path
    if (!isLLMError(err)) {
      if (passThroughNonLLMErrors) {
        return typeof next === 'function' ? next(err) : void 0;
      }
      return writeJson(res, 500, {
        error: {
          code:      'INTERNAL_ERROR',
          primitive: 'unknown',
          retriable: false,
          severity:  'error',
          message:   'internal server error',
        },
      });
    }

    // LLMError → structured response
    if (log) {
      try {
        log(err, {
          method: req?.method,
          url:    req?.url ?? req?.originalUrl,
          status: err.httpStatus,
          code:   err.code,
        });
      } catch { /* swallow */ }
    }

    const details = extractDetails(err, maskSet);
    const body = {
      error: {
        code:      err.code,
        primitive: err.primitive,
        retriable: err.retriable,
        severity:  err.severity,
        message:   err.message,
      },
    };
    if (Object.keys(details).length > 0) body.error.details = details;
    if (includeStack && !maskSet.has('stack') && err.stack) body.error.stack = err.stack;

    // Retry-After header when we can suggest a specific wait.
    const retryAfterSecs = computeRetryAfter(err);
    const headers = { 'Content-Type': 'application/json' };
    if (retryAfterSecs != null) headers['Retry-After'] = String(retryAfterSecs);

    return writeJson(res, err.httpStatus, body, headers);
  };
}

// Extract subclass-specific fields (everything that isn't on the LLMError
// base). Skips masked fields + skips `cause` because it's usually a
// wrapped exception (would nest indefinitely; consumers can log it via
// the log callback).
function extractDetails(err, maskSet) {
  const BASE_KEYS = new Set(['name', 'message', 'stack', 'code', 'primitive', 'retriable', 'httpStatus', 'severity', 'cause']);
  const details = {};
  for (const k of Object.getOwnPropertyNames(err)) {
    if (BASE_KEYS.has(k)) continue;
    if (maskSet.has(k)) continue;
    const v = err[k];
    // Serialize an Error-shaped cause chain as { message } to keep the
    // response bounded. Arbitrary object graphs pass through as-is;
    // consumers should mask if they're worried about size.
    if (v instanceof Error) {
      details[k] = { message: v.message, name: v.name, code: v.code };
    } else {
      details[k] = v;
    }
  }
  return details;
}

function computeRetryAfter(err) {
  if (err.code === 'CIRCUIT_OPEN' && typeof err.cooldownRemainingMs === 'number') {
    return Math.max(1, Math.ceil(err.cooldownRemainingMs / 1000));
  }
  if (err.code === 'BULKHEAD_FULL' || err.code === 'BULKHEAD_TIMEOUT') {
    return 1;
  }
  return null;
}

function writeJson(res, status, body, headers = { 'Content-Type': 'application/json' }) {
  if (res.status && res.json) {
    for (const [k, v] of Object.entries(headers)) {
      if (res.setHeader) res.setHeader(k, v);
    }
    return res.status(status).json(body);
  }
  if (res.writeHead && res.end) {
    res.writeHead(status, headers);
    return res.end(JSON.stringify(body));
  }
}

module.exports = { llmErrorHandler };
