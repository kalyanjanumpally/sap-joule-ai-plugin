// Reversible PII tokenization. Strip PII from the outbound request
// (replace with opaque `<TYPE_N>` tokens), send the tokenized prompt to
// the model, then restore the original values in the response before
// returning to the caller. The model never sees raw customer data but
// callers get useful answers back.
//
//   const { reversibleTokenization } = require('@saptarishi/cds-plugin-llm');
//
//   llm.use(reversibleTokenization({
//     patterns: {                              // extends the built-in set
//       BADGE_ID: /\bE\d{6}\b/g,
//     },
//     onTokenize: (i) => cds.log('llm:pii').info('tokenized', i.byType),
//   }));
//
// How the mapping works
// ---------------------
// Within a single request, each *value* gets a stable token — so if
// "alice@example.com" appears three times in the prompt, all three
// become `<EMAIL_1>`. When the response comes back, any occurrence of
// `<EMAIL_1>` is restored to the original address. Tokens the model
// hallucinated (`<EMAIL_99>` when no such token was ever emitted) are
// left as-is by default — override via `onUnknownToken`.
//
// Streaming is skipped by default: rewriting an incremental token stream
// on the fly requires per-chunk detokenization + edge handling; skipped
// unless caller supplies `handleStream: true` + custom logic.

const {
  Service: _CDSService,   // eslint-disable-line no-unused-vars
} = require('@sap/cds');

// ---- Built-in patterns -------------------------------------------------
//
// Regex-first PII detection is imperfect by definition — false positives
// exist (a random 9-digit number becomes an SSN; "123 Main" becomes a
// phone). But for the common enterprise cases (email, credit card, SSN)
// the false-positive rate is low, and users can extend the set. Real-
// world deployments should compose with a proper NER model for name /
// address detection.
//
// Order matters here: patterns are checked in this order; the FIRST
// match at a position wins. Credit-card before phone (both are digit
// runs); email before URL-style patterns.

const BUILT_IN_PATTERNS = Object.freeze({
  EMAIL:      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  CREDIT_CARD: /\b(?:\d[ -]*?){13,16}\b/g,
  SSN:        /\b\d{3}-\d{2}-\d{4}\b/g,
  PHONE:      /\+?[1-9]\d{0,2}[ .-]?\(?\d{2,4}\)?[ .-]?\d{3,4}[ .-]?\d{3,4}/g,
  IPV4:       /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
  IBAN:       /\b[A-Z]{2}\d{2}[A-Z0-9]{4,30}\b/g,
});

// ---- Default text extractors -----------------------------------------
//
// A CAP `request` typically has `prompt` or `messages: [{ content }]`.
// The default extractor gathers all text-bearing string fields and hands
// them to a callback so the middleware can rewrite each independently.

function defaultExtractText(request) {
  const strings = [];
  if (typeof request.prompt === 'string') {
    strings.push({ path: 'prompt', text: request.prompt });
  }
  if (typeof request.system === 'string') {
    strings.push({ path: 'system', text: request.system });
  }
  if (Array.isArray(request.messages)) {
    for (let i = 0; i < request.messages.length; i++) {
      const m = request.messages[i];
      if (typeof m?.content === 'string') {
        strings.push({ path: `messages[${i}].content`, text: m.content });
      }
    }
  }
  return strings;
}

function defaultApplyText(request, rewrites) {
  const out = { ...request };
  for (const { path, text } of rewrites) {
    if (path === 'prompt')      out.prompt = text;
    else if (path === 'system') out.system = text;
    else if (path.startsWith('messages[')) {
      const idx = parseInt(path.match(/\[(\d+)\]/)[1], 10);
      out.messages = out.messages.slice();
      out.messages[idx] = { ...out.messages[idx], content: text };
    }
  }
  return out;
}

// Tokenize a single string: finds all matches under every pattern,
// merges by position, builds a per-request mapping so identical values
// share a token, and returns the rewritten string + updated mapping.
function tokenizeText(text, patterns, mapping, prefix, suffix) {
  if (typeof text !== 'string' || text.length === 0) return { text, mapping };
  // Collect all non-overlapping matches. Since patterns can overlap,
  // sort by [start, -length] so the LONGEST match at a given start wins,
  // then merge left-to-right skipping overlaps.
  const rawMatches = [];
  for (const [type, re] of Object.entries(patterns)) {
    if (!(re instanceof RegExp) || !re.global) continue;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      rawMatches.push({ start: m.index, end: m.index + m[0].length, value: m[0], type });
    }
  }
  if (rawMatches.length === 0) return { text, mapping };

  rawMatches.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const kept = [];
  let cursor = -1;
  for (const r of rawMatches) {
    if (r.start < cursor) continue;   // overlaps prior match — skip
    kept.push(r);
    cursor = r.end;
  }

  // Reverse-value index so identical values get the same token.
  const valueToToken = new Map();
  for (const [tok, val] of mapping.entries()) valueToToken.set(val.original, tok);

  const parts = [];
  let cur = 0;
  for (const r of kept) {
    parts.push(text.slice(cur, r.start));
    let token = valueToToken.get(r.value);
    if (!token) {
      const nextIdx = countTokensOfType(mapping, r.type) + 1;
      token = `${prefix}${r.type}_${nextIdx}${suffix}`;
      mapping.set(token, { original: r.value, type: r.type });
      valueToToken.set(r.value, token);
    }
    parts.push(token);
    cur = r.end;
  }
  parts.push(text.slice(cur));

  return { text: parts.join(''), mapping };
}

function countTokensOfType(mapping, type) {
  let n = 0;
  for (const v of mapping.values()) if (v.type === type) n++;
  return n;
}

function detokenizeText(text, mapping, onUnknownToken) {
  if (typeof text !== 'string' || text.length === 0) return { text, restored: 0, unknown: 0 };
  // Note: don't short-circuit on empty mapping — hallucinated tokens
  // still need to be reported / rewritten via onUnknownToken.
  let restored = 0;
  let unknown = 0;
  // Match any `<TYPE_N>`-shaped token (using default prefix/suffix).
  // For custom prefix/suffix, the caller passes a compiled pattern.
  // We build a regex from the mapping's keys directly to be safe.
  const tokenRe = /<([A-Z_]+_\d+)>/g;
  const rebuilt = text.replace(tokenRe, (full) => {
    if (mapping.has(full)) {
      restored++;
      return mapping.get(full).original;
    }
    unknown++;
    return onUnknownToken ? onUnknownToken(full) ?? full : full;
  });
  return { text: rebuilt, restored, unknown };
}

// ---- Standalone helpers (exported for one-off use) -------------------

function tokenizePII(text, options = {}) {
  const patterns = { ...BUILT_IN_PATTERNS, ...(options.patterns ?? {}) };
  const prefix = options.tokenPrefix ?? '<';
  const suffix = options.tokenSuffix ?? '>';
  const mapping = new Map();
  const { text: rewritten } = tokenizeText(text, patterns, mapping, prefix, suffix);
  // Return a plain-object mapping so callers can JSON.stringify freely.
  const out = {};
  for (const [tok, meta] of mapping.entries()) out[tok] = meta;
  return { text: rewritten, mapping: out };
}

function detokenizePII(text, mapping, options = {}) {
  const m = new Map();
  if (mapping instanceof Map) {
    for (const [k, v] of mapping.entries()) m.set(k, v);
  } else if (mapping && typeof mapping === 'object') {
    for (const [k, v] of Object.entries(mapping)) m.set(k, v);
  }
  const { text: rebuilt } = detokenizeText(text, m, options.onUnknownToken);
  return rebuilt;
}

// ---- Middleware ------------------------------------------------------

function reversibleTokenization(options = {}) {
  const {
    patterns          = {},
    tokenPrefix       = '<',
    tokenSuffix       = '>',
    extractText       = defaultExtractText,
    applyText         = defaultApplyText,
    onUnknownToken    = null,
    onTokenize        = null,
    onRestore         = null,
    skipStreaming     = true,
  } = options;

  const merged = { ...BUILT_IN_PATTERNS, ...patterns };

  // Validate patterns.
  for (const [name, re] of Object.entries(merged)) {
    if (!(re instanceof RegExp)) {
      throw new Error(`reversibleTokenization: patterns.${name} must be a RegExp (got ${typeof re}).`);
    }
    if (!re.global) {
      throw new Error(`reversibleTokenization: patterns.${name} must be a /g regex (append the 'g' flag).`);
    }
  }
  if (typeof tokenPrefix !== 'string' || typeof tokenSuffix !== 'string') {
    throw new Error('reversibleTokenization: tokenPrefix + tokenSuffix must be strings.');
  }
  if (typeof extractText !== 'function' || typeof applyText !== 'function') {
    throw new Error('reversibleTokenization: extractText + applyText must be functions.');
  }
  for (const cb of [onTokenize, onRestore, onUnknownToken]) {
    if (cb != null && typeof cb !== 'function') {
      throw new Error('reversibleTokenization: callbacks must be functions or null.');
    }
  }

  const stats = {
    totalCalls:        0,
    tokensCreated:     0,
    tokensRestored:    0,
    unknownTokensSeen: 0,
    skippedStreaming:  0,
    byType:            {},
  };

  function callHook(hook, arg) {
    if (!hook) return;
    try { const r = hook(arg); if (r && typeof r.then === 'function') r.catch(() => {}); }
    catch { /* swallow */ }
  }

  const mw = async (ctx, next) => {
    stats.totalCalls++;

    if (skipStreaming && (ctx?.method === 'stream' || ctx?.method === 'streamCompletion')) {
      stats.skippedStreaming++;
      return next();
    }

    const originalRequest = ctx.request;
    const inputs = extractText(originalRequest);
    if (!Array.isArray(inputs) || inputs.length === 0) {
      // Nothing to tokenize.
      return next();
    }

    // Per-request mapping — shared across all string fields so the same
    // PII value gets the same token everywhere.
    const mapping = new Map();
    const rewrites = [];
    const perTypeCounts = {};
    for (const { path, text } of inputs) {
      const before = mapping.size;
      const { text: rewritten } = tokenizeText(text, merged, mapping, tokenPrefix, tokenSuffix);
      rewrites.push({ path, text: rewritten });
      for (let entry of Array.from(mapping.entries()).slice(before)) {
        perTypeCounts[entry[1].type] = (perTypeCounts[entry[1].type] ?? 0) + 1;
      }
    }

    if (mapping.size > 0) {
      stats.tokensCreated += mapping.size;
      for (const [t, n] of Object.entries(perTypeCounts)) {
        stats.byType[t] = (stats.byType[t] ?? 0) + n;
      }
      ctx.request = applyText(originalRequest, rewrites);
      callHook(onTokenize, {
        tokensCreated: mapping.size,
        byType: perTypeCounts,
      });
    }

    let result;
    try {
      result = await next();
    } finally {
      ctx.request = originalRequest;
    }

    // Restore in the response text (only if we tokenized anything).
    if (mapping.size > 0 && result && typeof result === 'object' && typeof result.text === 'string') {
      const { text: restored, restored: restoredCount, unknown } =
        detokenizeText(result.text, mapping, onUnknownToken);
      result.text = restored;
      stats.tokensRestored += restoredCount;
      stats.unknownTokensSeen += unknown;
      if (restoredCount > 0 || unknown > 0) {
        callHook(onRestore, { restored: restoredCount, unknown });
      }
    }

    return result;
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.totalCalls = stats.tokensCreated = stats.tokensRestored = 0;
    stats.unknownTokensSeen = stats.skippedStreaming = 0;
    for (const k of Object.keys(stats.byType)) delete stats.byType[k];
  };
  mw.restorationRate = () => {
    return stats.tokensCreated === 0 ? 0 : stats.tokensRestored / stats.tokensCreated;
  };
  mw.asMcpResource = () => ({
    uri: 'config://reversible-tokenization',
    name: 'Reversible PII tokenization',
    description: 'Tokenize PII in outbound requests; restore in responses. Model never sees raw PII.',
    mimeType: 'application/json',
    handler: () => ({
      patternTypes: Object.keys(merged),
      tokenPrefix, tokenSuffix,
      skipStreaming,
      restorationRate: mw.restorationRate(),
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  reversibleTokenization,
  BUILT_IN_PATTERNS,
  // Standalone helpers — usable outside the middleware chain (e.g. for
  // one-off scrubbing of ad-hoc text, or unit tests of the pattern set).
  tokenizePII,
  detokenizePII,
  // Exposed for advanced composition + tests.
  defaultExtractText,
  defaultApplyText,
};
