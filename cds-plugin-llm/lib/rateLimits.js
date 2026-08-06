// Rate-limit header parsers. Providers report their remaining budget +
// reset time in response headers; the shape differs per vendor. Normalized
// output makes `usageMetering` provider-agnostic when tracking.
//
// Return shape (all fields optional — provider only reports what it knows):
//   {
//     requestsLimit, requestsRemaining, requestsResetAt: ISO,
//     tokensLimit,   tokensRemaining,   tokensResetAt:   ISO,
//     retryAfterSeconds,        // set when the response was a 429
//     updatedAt: ISO,           // when we saw this state
//   }

/**
 * Read a header from a Headers-like object (fetch Response headers, Node http
 * IncomingMessage headers, or a plain object). Case-insensitive.
 */
function h(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') {
    return headers.get(name) ?? headers.get(name.toLowerCase()) ?? null;
  }
  if (typeof headers === 'object') {
    return headers[name] ?? headers[name.toLowerCase()] ?? null;
  }
  return null;
}

function toInt(v) {
  if (v == null) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}
function toFloat(v) {
  if (v == null) return undefined;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * OpenAI ratelimit headers — same shape used by Groq, DeepSeek, Mistral,
 * Fireworks, Azure OpenAI, GenAI Hub (when its underlying model is OpenAI).
 *
 *   x-ratelimit-limit-requests / -remaining-requests / -reset-requests
 *   x-ratelimit-limit-tokens   / -remaining-tokens   / -reset-tokens
 *
 * Reset headers can be `Ns`, `Nms`, `Nm5s`, or an ISO date. Normalize to
 * absolute ISO strings.
 */
function parseOpenAIRateLimit(headers, statusCode) {
  const now = Date.now();

  const requestsLimit     = toInt(h(headers, 'x-ratelimit-limit-requests'));
  const requestsRemaining = toInt(h(headers, 'x-ratelimit-remaining-requests'));
  const tokensLimit       = toInt(h(headers, 'x-ratelimit-limit-tokens'));
  const tokensRemaining   = toInt(h(headers, 'x-ratelimit-remaining-tokens'));

  const requestsResetAt = parseResetToIso(h(headers, 'x-ratelimit-reset-requests'), now);
  const tokensResetAt   = parseResetToIso(h(headers, 'x-ratelimit-reset-tokens'),   now);

  // retry-after is set on 429s. Value is either seconds (integer) or an HTTP-
  // date; we only interpret seconds here — HTTP-date usage is rare on APIs.
  let retryAfterSeconds;
  if (statusCode === 429 || statusCode === 503) {
    retryAfterSeconds = toInt(h(headers, 'retry-after'));
  }

  // If no rate-limit headers at all, return null so callers can skip.
  if (
    requestsLimit == null && requestsRemaining == null && tokensLimit == null &&
    tokensRemaining == null && requestsResetAt == null && tokensResetAt == null &&
    retryAfterSeconds == null
  ) return null;

  return {
    requestsLimit,
    requestsRemaining,
    requestsResetAt,
    tokensLimit,
    tokensRemaining,
    tokensResetAt,
    retryAfterSeconds,
    updatedAt: new Date(now).toISOString(),
  };
}

/**
 * Anthropic ratelimit headers (as of 2025-06):
 *   anthropic-ratelimit-requests-limit / -remaining / -reset (ISO)
 *   anthropic-ratelimit-tokens-limit   / -remaining / -reset (ISO)
 * retry-after on 429s.
 *
 * Anthropic already gives us absolute ISO timestamps — no parsing needed.
 */
function parseAnthropicRateLimit(headers, statusCode) {
  const now = Date.now();

  const requestsLimit     = toInt(h(headers, 'anthropic-ratelimit-requests-limit'));
  const requestsRemaining = toInt(h(headers, 'anthropic-ratelimit-requests-remaining'));
  const requestsResetAt   = h(headers, 'anthropic-ratelimit-requests-reset') || undefined;
  const tokensLimit       = toInt(h(headers, 'anthropic-ratelimit-tokens-limit'));
  const tokensRemaining   = toInt(h(headers, 'anthropic-ratelimit-tokens-remaining'));
  const tokensResetAt     = h(headers, 'anthropic-ratelimit-tokens-reset') || undefined;

  let retryAfterSeconds;
  if (statusCode === 429 || statusCode === 503) {
    retryAfterSeconds = toInt(h(headers, 'retry-after'));
  }

  if (
    requestsLimit == null && requestsRemaining == null && tokensLimit == null &&
    tokensRemaining == null && requestsResetAt == null && tokensResetAt == null &&
    retryAfterSeconds == null
  ) return null;

  return {
    requestsLimit,
    requestsRemaining,
    requestsResetAt,
    tokensLimit,
    tokensRemaining,
    tokensResetAt,
    retryAfterSeconds,
    updatedAt: new Date(now).toISOString(),
  };
}

/**
 * Parse a `x-ratelimit-reset-*` value into an absolute ISO timestamp.
 * OpenAI formats:
 *   "1s"     → now + 1s
 *   "500ms"  → now + 0.5s
 *   "1m5s"   → now + 65s
 *   "1h32m"  → now + 92 min
 *   "2026-08-06T12:34:56Z"  → passthrough
 * Returns undefined for unparseable input.
 */
function parseResetToIso(raw, nowMs) {
  if (!raw) return undefined;
  const s = String(raw).trim();
  // ISO passthrough
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s;
  // Compound duration: matches h/m/s/ms segments
  const durationRe = /(\d+(?:\.\d+)?)\s*(ms|s|m|h)/gi;
  let totalMs = 0;
  let matched = false;
  let m;
  while ((m = durationRe.exec(s)) !== null) {
    matched = true;
    const n = parseFloat(m[1]);
    const unit = m[2].toLowerCase();
    if (unit === 'ms') totalMs += n;
    else if (unit === 's') totalMs += n * 1000;
    else if (unit === 'm') totalMs += n * 60 * 1000;
    else if (unit === 'h') totalMs += n * 60 * 60 * 1000;
  }
  if (!matched) return undefined;
  return new Date(nowMs + totalMs).toISOString();
}

module.exports = { parseOpenAIRateLimit, parseAnthropicRateLimit, parseResetToIso, _h: h };
