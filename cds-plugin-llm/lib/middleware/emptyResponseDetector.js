// Empty-response detector. Catches broken model responses — empty
// string, whitespace-only, single-char replies, refusal patterns
// ("I can't help with that", "Sorry, but…") — BEFORE they reach the
// caller. Configurable three-way policy: throw / auto-retry / log.
//
// Distinct from other quality primitives:
//   * `structuredOutputRepair` (2.9)    — SCHEMA-driven
//   * `responseRevision` (2.29)          — RUBRIC-driven re-ask
//   * `emptyResponseDetector` (this)     — EMPTY / REFUSAL detection
//
// Common causes this middleware catches:
//   * Provider hiccup (empty response payload from timeout / bad JSON)
//   * Safety-filter or guardrail evasion that returned "" or "..."
//   * Refusal on a legitimate request (soft-blocked by the model)
//
//   const { emptyResponseDetector } = require('@saptarishi/cds-plugin-llm');
//
//   llm.use(emptyResponseDetector({
//     minChars:   10,
//     onEmpty:    'retry',       // 'throw' | 'retry' | 'log'
//     maxRetries: 1,
//     onDetected: (i) => cds.log('llm:empty').warn('empty response', i),
//   }));

const { LLMError } = require('../errors');

const ON_EMPTY_POLICIES = Object.freeze(['throw', 'retry', 'log']);

class EmptyResponseError extends LLMError {
  constructor({ reason, textLength, retries }) {
    super(
      `emptyResponseDetector: response detected as empty/refusal — ${reason}. Text length: ${textLength}, retries: ${retries}.`,
      'EMPTY_RESPONSE',
    );
    this.reason     = reason;
    this.textLength = textLength;
    this.retries    = retries;
  }
}

// Default refusal patterns — common soft-refusal openings. Kept
// conservative (anchored to start of trimmed response) to minimize
// false positives on legitimate answers that happen to contain
// the phrases mid-response.
const DEFAULT_REFUSAL_PATTERNS = Object.freeze([
  /^i (can'?t|cannot|won'?t|refuse to) (help|assist|do|answer|provide|comply)/i,
  /^i'?m (unable|not able|sorry|not allowed) to/i,
  /^sorry,? (but )?i (can'?t|cannot|won'?t)/i,
  /^i must (decline|refuse)/i,
  /^this request (cannot|can'?t) be/i,
  /^as an ai( assistant| language model)?,? i (can'?t|cannot|don'?t)/i,
]);

function extractResponseText(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (typeof result?.text === 'string') return result.text;
  return '';
}

function defaultBuildRetryPrompt({ previousText, reason, retryIndex }) {
  if (reason === 'refusal-pattern') {
    return `Your previous response was flagged as a refusal. If you are unable to help, explain briefly WHY (which specific policy applies) rather than refusing outright. Otherwise, please provide a substantive answer to the request. (Retry ${retryIndex + 1})`;
  }
  return `Your previous response was empty or too short. Please provide a substantive answer to the request. (Retry ${retryIndex + 1})`;
}

function defaultApplyRetry(request, retryPrompt, previousResponse) {
  const messages = Array.isArray(request.messages) ? [...request.messages] : [];
  if (previousResponse?.text) {
    messages.push({ role: 'assistant', content: previousResponse.text });
  }
  messages.push({ role: 'user', content: retryPrompt });
  return { ...request, messages };
}

function emptyResponseDetector(options = {}) {
  const {
    minChars             = 5,
    refusalPatterns      = DEFAULT_REFUSAL_PATTERNS,
    detectEmpty          = null,          // full override; return null to fall back to defaults
    onEmpty              = 'throw',
    maxRetries           = 1,
    buildRetryPrompt     = defaultBuildRetryPrompt,
    applyRetry           = defaultApplyRetry,
    onDetected           = null,
    onRetry              = null,
    onFinalize           = null,
    onError              = null,
  } = options;

  if (!ON_EMPTY_POLICIES.includes(onEmpty)) {
    throw new Error(`emptyResponseDetector: onEmpty must be one of ${ON_EMPTY_POLICIES.join(', ')} (got ${JSON.stringify(onEmpty)}).`);
  }
  if (!Number.isInteger(minChars) || minChars < 0) {
    throw new Error(`emptyResponseDetector: minChars must be a non-negative integer (got ${minChars}).`);
  }
  if (!Array.isArray(refusalPatterns)) {
    throw new Error('emptyResponseDetector: refusalPatterns must be an array of RegExp.');
  }
  for (let i = 0; i < refusalPatterns.length; i++) {
    if (!(refusalPatterns[i] instanceof RegExp)) {
      throw new Error(`emptyResponseDetector: refusalPatterns[${i}] must be a RegExp.`);
    }
  }
  if (detectEmpty != null && typeof detectEmpty !== 'function') {
    throw new Error('emptyResponseDetector: detectEmpty must be a function or null.');
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error(`emptyResponseDetector: maxRetries must be a non-negative integer (got ${maxRetries}).`);
  }
  if (typeof buildRetryPrompt !== 'function' || typeof applyRetry !== 'function') {
    throw new Error('emptyResponseDetector: buildRetryPrompt + applyRetry must be functions.');
  }
  for (const cb of [onDetected, onRetry, onFinalize, onError]) {
    if (cb != null && typeof cb !== 'function') {
      throw new Error('emptyResponseDetector: callbacks must be functions or null.');
    }
  }

  const stats = {
    totalCalls:        0,
    emptyDetected:     0,
    retried:           0,
    retrySucceeded:    0,
    thrownCount:       0,
    loggedCount:       0,
    byReason:          {
      'too-short':       0,
      'whitespace':      0,
      'refusal-pattern': 0,
      'custom':          0,
    },
    lastReason:        null,
  };

  function callHook(hook, arg) {
    if (!hook) return;
    try { const r = hook(arg); if (r && typeof r.then === 'function') r.catch(() => {}); }
    catch { /* swallow */ }
  }

  function checkEmpty(result) {
    if (detectEmpty) {
      try {
        const custom = detectEmpty(result);
        if (custom !== null && custom !== undefined) {
          // Custom returned true/false or a { reason } object.
          if (typeof custom === 'object') {
            return { empty: !!custom.empty, reason: custom.reason ?? 'custom' };
          }
          return { empty: !!custom, reason: 'custom' };
        }
      } catch (err) {
        callHook(onError, { phase: 'detectEmpty', error: err });
      }
    }
    // Default detection.
    const text = extractResponseText(result);
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return { empty: true, reason: 'whitespace' };
    }
    if (trimmed.length < minChars) {
      return { empty: true, reason: 'too-short' };
    }
    for (const re of refusalPatterns) {
      if (re.test(trimmed)) {
        return { empty: true, reason: 'refusal-pattern' };
      }
    }
    return { empty: false, reason: null };
  }

  const mw = async (ctx, next) => {
    stats.totalCalls++;
    const originalRequest = ctx.request;

    let result;
    try {
      result = await next();
    } catch (err) {
      throw err;
    }

    let check = checkEmpty(result);
    if (!check.empty) {
      callHook(onFinalize, { result, empty: false, retries: 0 });
      return result;
    }

    // Empty detected on the first attempt.
    stats.emptyDetected++;
    stats.byReason[check.reason] = (stats.byReason[check.reason] ?? 0) + 1;
    stats.lastReason = check.reason;
    callHook(onDetected, {
      reason: check.reason,
      textLength: extractResponseText(result).length,
      retries: 0,
    });

    if (onEmpty === 'log') {
      stats.loggedCount++;
      callHook(onFinalize, { result, empty: true, retries: 0, reason: check.reason });
      return result;   // pass through untouched
    }

    if (onEmpty === 'throw') {
      stats.thrownCount++;
      throw new EmptyResponseError({
        reason: check.reason,
        textLength: extractResponseText(result).length,
        retries: 0,
      });
    }

    // 'retry' — attempt maxRetries times.
    let lastResult = result;
    let lastCheck = check;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      let retryPrompt;
      try {
        retryPrompt = buildRetryPrompt({
          previousText: extractResponseText(lastResult),
          reason: lastCheck.reason,
          retryIndex: attempt - 1,
        });
      } catch (err) {
        callHook(onError, { phase: 'buildRetryPrompt', error: err });
        break;
      }

      let revisedRequest;
      try {
        revisedRequest = applyRetry(originalRequest, retryPrompt, lastResult);
      } catch (err) {
        callHook(onError, { phase: 'applyRetry', error: err });
        break;
      }

      ctx.request = revisedRequest;
      stats.retried++;
      callHook(onRetry, {
        retryIndex: attempt - 1,
        reason: lastCheck.reason,
        previousText: extractResponseText(lastResult),
      });

      try {
        lastResult = await next();
      } catch (err) {
        ctx.request = originalRequest;
        throw err;
      }
      lastCheck = checkEmpty(lastResult);
      if (!lastCheck.empty) {
        stats.retrySucceeded++;
        ctx.request = originalRequest;
        callHook(onFinalize, { result: lastResult, empty: false, retries: attempt });
        return lastResult;
      }
    }

    // Exhausted retries — still empty.
    ctx.request = originalRequest;
    stats.thrownCount++;
    callHook(onFinalize, {
      result: lastResult, empty: true,
      retries: maxRetries, reason: lastCheck.reason,
    });
    throw new EmptyResponseError({
      reason: lastCheck.reason,
      textLength: extractResponseText(lastResult).length,
      retries: maxRetries,
    });
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.totalCalls = stats.emptyDetected = 0;
    stats.retried = stats.retrySucceeded = stats.thrownCount = stats.loggedCount = 0;
    for (const k of Object.keys(stats.byReason)) stats.byReason[k] = 0;
    stats.lastReason = null;
  };
  mw.emptyRate = () => {
    return stats.totalCalls === 0 ? 0 : stats.emptyDetected / stats.totalCalls;
  };
  mw.asMcpResource = () => ({
    uri: 'config://empty-response-detector',
    name: 'Empty-response detector',
    description: 'Catches empty/refusal responses. Three-way policy: throw / retry / log. Composes with responseRevision (2.29) for full quality-driven loops.',
    mimeType: 'application/json',
    handler: () => ({
      minChars, onEmpty, maxRetries,
      refusalPatternCount: refusalPatterns.length,
      emptyRate: mw.emptyRate(),
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  emptyResponseDetector,
  EmptyResponseError,
  DEFAULT_REFUSAL_PATTERNS,
  ON_EMPTY_POLICIES,
  extractResponseText,
  defaultBuildRetryPrompt,
  defaultApplyRetry,
};
