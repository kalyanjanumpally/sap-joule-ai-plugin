// CAP error bridge — converts a 1.57 LLMError into a CAP req.reject()
// call so OData action handlers surface structured errors to clients.
// The Express-shaped 1.58 `llmErrorHandler` catches errors AFTER they
// escape the handler; this bridge lets the handler itself decide how to
// signal the error inside CAP's normal req.reject / req.error flow.
//
//   const { toCapError, withCapHandler } = require('@saptarishi/cds-plugin-llm');
//
//   // Option 1: direct in a handler
//   this.on('summarizePurchaseOrder', async (req) => {
//     try {
//       const { text } = await llm.chat({ messages: [...] });
//       return { summary: text };
//     } catch (e) {
//       return toCapError(e, req);
//     }
//   });
//
//   // Option 2: wrapper decorator — auto-catch LLMError
//   this.on('summarizePurchaseOrder', withCapHandler(async (req) => {
//     const { text } = await llm.chat({ messages: [...] });
//     return { summary: text };
//   }));
//
// The resulting OData error payload carries:
//   {
//     "error": {
//       "code":       "CIRCUIT_OPEN",
//       "message":    "circuitBreaker: circuit is OPEN for provider='openai' — 25000ms cooldown remaining. ...",
//       "@Common.numericSeverity": 4,
//       "primitive":  "circuitBreaker",
//       "retriable":  true,
//       "severity":   "error",
//       "provider":   "openai",
//       "cooldownRemainingMs": 25000
//     }
//   }
//
// Non-LLMError exceptions are RE-THROWN — CAP's default handler takes
// them. This is intentional: we don't want to swallow unrelated bugs.

const { isLLMError } = require('./errors');

// Base keys on LLMError itself. Everything else on the subclass instance
// (provider, attempts, cooldownRemainingMs, etc.) becomes `details`.
const BASE_KEYS = new Set([
  'name', 'message', 'stack', 'code', 'primitive', 'retriable', 'httpStatus', 'severity', 'cause',
]);

function extractDetails(err, mask = new Set()) {
  const details = {};
  for (const k of Object.getOwnPropertyNames(err)) {
    if (BASE_KEYS.has(k)) continue;
    if (mask.has(k)) continue;
    const v = err[k];
    if (v instanceof Error) {
      details[k] = { message: v.message, name: v.name, code: v.code };
    } else if (typeof v !== 'function') {
      details[k] = v;
    }
  }
  return details;
}

/**
 * Convert an LLMError into a CAP req.reject() call. Non-LLMError errors
 * are re-thrown so CAP's default handler can process them unchanged.
 *
 * @param {Error} err   The exception caught in a CAP handler
 * @param {object} req  The CAP req object (must expose .reject() or .error())
 * @param {object} [options]
 * @param {string[]} [options.mask=[]]  Fields to strip from the details payload
 * @param {number}   [options.severity=4]  OData Common.numericSeverity (2=warn, 3=err, 4=fatal)
 */
function toCapError(err, req, options = {}) {
  if (!isLLMError(err)) throw err;

  const { mask = [], severity = 4 } = options;
  if (!Array.isArray(mask)) {
    throw new Error('toCapError: mask must be an array of field names.');
  }
  const maskSet = new Set(mask);
  const details = extractDetails(err, maskSet);

  // CAP surfaces additional key/value pairs from a plain object arg as
  // OData custom fields on the error payload. The '@Common.numericSeverity'
  // annotation controls whether the OData client shows it as an error
  // (>= 3) or a warning (2).
  const payload = {
    code:                          err.code,
    message:                       err.message,
    '@Common.numericSeverity':     severity,
    primitive:                     err.primitive,
    retriable:                     err.retriable,
    severity:                      err.severity,
    ...details,
  };

  if (req && typeof req.reject === 'function') {
    // Modern CAP: req.reject(status, message, details)
    return req.reject(err.httpStatus, err.message, payload);
  }
  if (req && typeof req.error === 'function') {
    // Older CAP / fallback: req.error() adds a non-fatal error; still surfaces
    // in the OData response payload.
    req.error(payload);
    return;
  }

  // No req context — surface as a plain Error with a status hint so
  // callers can still map to HTTP if needed.
  throw Object.assign(new Error(err.message), {
    status:   err.httpStatus,
    code:     err.code,
    llmError: payload,
  });
}

/**
 * Wrapper decorator — catches any LLMError thrown by `handler` and
 * converts it via toCapError. Non-LLMError exceptions propagate.
 * Preserves the handler's `this` binding + additional args.
 *
 *   this.on('myAction', withCapHandler(async (req, ctx) => {
 *     const r = await llm.chat({...});
 *     return r.text;
 *   }));
 */
function withCapHandler(handler, options = {}) {
  if (typeof handler !== 'function') {
    throw new Error('withCapHandler: handler must be a function.');
  }
  return async function wrapped(req, ...rest) {
    try {
      return await handler.call(this, req, ...rest);
    } catch (e) {
      return toCapError(e, req, options);
    }
  };
}

module.exports = { toCapError, withCapHandler, extractDetails };
