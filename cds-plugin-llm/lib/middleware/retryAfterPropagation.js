// Retry-after propagation middleware. Enriches outbound errors
// with retry timing hints parsed from provider rate-limit
// headers, so app code can implement smart backoff instead of
// hard-coded delays.
//
// Complements retryOnRateLimit (1.47): that middleware WAITS +
// retries internally; this middleware SURFACES the retry hint to
// the caller when the internal retry gives up or is disabled.
//
//   const { retryAfterPropagation } = require('@saptarishi/cds-plugin-llm');
//
//   llm.use(retryAfterPropagation({
//     onCapture: (info) => cds.log('llm:rate-limit').info(
//       `[rate-limit] provider=${info.provider} retry after ${info.retryAfterMs}ms`,
//     ),
//   }));
//
//   // In a controller / OData handler:
//   try {
//     return await llm.chat(req);
//   } catch (err) {
//     if (err.retryAfterMs) {
//       // Enqueue for later or return 429 with Retry-After.
//       res.set('Retry-After', Math.ceil(err.retryAfterMs / 1000));
//       return res.status(429).json({ error: 'try again later' });
//     }
//     throw err;
//   }
//
// Enrichment fields set on the error object (never overwrites
// existing values):
//   err.retryAfterMs   — milliseconds until safe to retry
//   err.resetAtMs      — Unix timestamp (ms) when quota resets
//   err.rateLimit      — full parsed shape (requests/tokens limit + remaining + reset)
//   err.retryAfterHint — meta for observability: provider, source
//
// Also useful hooked into llmErrorHandler (1.58) — that handler
// already surfaces LLMError as JSON; combine with a simple
// header setter in your Express app:
//
//   app.use((err, req, res, next) => {
//     if (err.retryAfterMs) res.set('Retry-After', Math.ceil(err.retryAfterMs / 1000));
//     next(err);
//   });

const {
  parseOpenAIRateLimit,
  parseAnthropicRateLimit,
  parseGeminiRateLimit,
  parseBedrockRateLimit,
} = require('../rateLimits');

const DEFAULT_PARSERS = {
  openai:    parseOpenAIRateLimit,
  anthropic: parseAnthropicRateLimit,
  gemini:    parseGeminiRateLimit,
  bedrock:   parseBedrockRateLimit,
};

// ---- Provider detection from headers -----------------------------

function readHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') {
    return headers.get(name) ?? headers.get(name.toLowerCase()) ?? null;
  }
  if (typeof headers === 'object') {
    return headers[name] ?? headers[name.toLowerCase()] ?? null;
  }
  return null;
}

/**
 * Detect provider from the headers shape by looking for
 * vendor-signature keys. Falls back to null when no known headers
 * are present.
 */
function detectProvider(err) {
  const headers = err?.headers ?? err?.response?.headers ?? null;
  if (!headers) return null;
  if (readHeader(headers, 'anthropic-ratelimit-tokens-remaining') != null
      || readHeader(headers, 'anthropic-ratelimit-requests-remaining') != null) {
    return 'anthropic';
  }
  if (readHeader(headers, 'x-goog-quota-remaining') != null
      || readHeader(headers, 'x-goog-request-id') != null) {
    return 'gemini';
  }
  if (readHeader(headers, 'x-ratelimit-limit-requests') != null
      || readHeader(headers, 'x-ratelimit-remaining-requests') != null
      || readHeader(headers, 'x-ratelimit-limit-tokens') != null) {
    // OpenAI-shaped (also used by Groq, DeepSeek, Mistral, Fireworks, Azure OpenAI).
    return 'openai';
  }
  return null;
}

// ---- Convert parsed rate-limit → millisecond hints ---------------

function computeRetryHints(parsed, err) {
  if (!parsed) return null;
  const now = Date.now();

  let retryAfterMs = null;
  if (typeof parsed.retryAfterSeconds === 'number' && parsed.retryAfterSeconds >= 0) {
    retryAfterMs = Math.round(parsed.retryAfterSeconds * 1000);
  }
  // Fallback: if err.retryAfterSec is present (some providers populate directly).
  if (retryAfterMs == null && typeof err?.retryAfterSec === 'number') {
    retryAfterMs = Math.round(err.retryAfterSec * 1000);
  }

  let resetAtMs = null;
  const resetIso = parsed.requestsResetAt ?? parsed.tokensResetAt;
  if (typeof resetIso === 'string') {
    const t = Date.parse(resetIso);
    if (Number.isFinite(t)) resetAtMs = t;
  }
  // If we have retryAfterMs but no explicit resetAt, derive one.
  if (resetAtMs == null && retryAfterMs != null) {
    resetAtMs = now + retryAfterMs;
  }
  return { retryAfterMs, resetAtMs };
}

// ---- Main middleware -------------------------------------------

function retryAfterPropagation(options = {}) {
  const {
    parsers        = DEFAULT_PARSERS,
    provider       = null,     // manual override
    onCapture      = null,
    fallbackRetryMs = null,    // used when we can't parse anything but caller wants a default
  } = options;

  if (onCapture != null && typeof onCapture !== 'function') {
    throw new Error('retryAfterPropagation: onCapture must be a function.');
  }
  if (typeof parsers !== 'object' || parsers === null) {
    throw new Error('retryAfterPropagation: parsers must be an object of { provider: fn }.');
  }
  if (fallbackRetryMs != null && (!Number.isFinite(fallbackRetryMs) || fallbackRetryMs < 0)) {
    throw new Error(`retryAfterPropagation: fallbackRetryMs must be a non-negative number (got ${fallbackRetryMs}).`);
  }

  const stats = {
    totalErrors:      0,
    hintsCaptured:    0,
    unknownProvider:  0,
    fallbackApplied:  0,
    byProvider:       {},
  };

  function enrichError(err) {
    stats.totalErrors++;

    // Don't overwrite if the caller already set these fields.
    if (err.retryAfterMs != null && err.resetAtMs != null) return;

    const detected = provider ?? detectProvider(err);
    if (!detected) {
      stats.unknownProvider++;
      if (fallbackRetryMs != null) {
        err.retryAfterMs = err.retryAfterMs ?? fallbackRetryMs;
        err.resetAtMs    = err.resetAtMs    ?? (Date.now() + fallbackRetryMs);
        err.retryAfterHint = { provider: null, source: 'fallback' };
        stats.fallbackApplied++;
      }
      return;
    }

    const parser = parsers[detected];
    if (typeof parser !== 'function') return;

    const headers = err.headers ?? err.response?.headers ?? null;
    const status  = err.status ?? err.statusCode ?? err.response?.status;
    let parsed;
    try {
      parsed = detected === 'bedrock' ? parser(err.response ?? err, status) : parser(headers, status);
    } catch { return; }
    if (!parsed) return;

    const hints = computeRetryHints(parsed, err);
    if (!hints || (hints.retryAfterMs == null && hints.resetAtMs == null)) return;

    if (hints.retryAfterMs != null && err.retryAfterMs == null) err.retryAfterMs = hints.retryAfterMs;
    if (hints.resetAtMs    != null && err.resetAtMs    == null) err.resetAtMs    = hints.resetAtMs;
    if (err.rateLimit == null) err.rateLimit = parsed;
    if (err.retryAfterHint == null) err.retryAfterHint = { provider: detected, source: 'headers' };

    stats.hintsCaptured++;
    stats.byProvider[detected] = (stats.byProvider[detected] ?? 0) + 1;

    if (onCapture) {
      try {
        onCapture({
          provider:      detected,
          retryAfterMs:  err.retryAfterMs,
          resetAtMs:     err.resetAtMs,
          rateLimit:     parsed,
          errorCode:     err.code ?? null,
        });
      } catch { /* swallow */ }
    }
  }

  const mw = async (ctx, next) => {
    try {
      return await next();
    } catch (err) {
      if (err && typeof err === 'object') enrichError(err);
      throw err;
    }
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.totalErrors = stats.hintsCaptured = stats.unknownProvider = stats.fallbackApplied = 0;
    for (const k of Object.keys(stats.byProvider)) delete stats.byProvider[k];
  };
  mw.asMcpResource = () => ({
    uri: 'config://retry-after-propagation',
    name: 'Retry-after propagation',
    description: 'Enriches outbound errors with retryAfterMs + resetAtMs from provider rate-limit headers.',
    mimeType: 'application/json',
    handler: () => ({
      provider,
      fallbackRetryMs,
      supportedProviders: Object.keys(parsers),
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  retryAfterPropagation,
  detectProvider,
  computeRetryHints,
  DEFAULT_PARSERS,
};
