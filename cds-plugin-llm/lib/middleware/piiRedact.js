// PII redaction middleware. Detects emails / phones / SSNs / credit
// cards / IBANs in outbound requests and replaces them with reversible
// tokens BEFORE the request reaches the provider. Optionally un-masks
// tokens in responses for round-trip use.
//
// Different from `guardrails` (which BLOCKS PII entirely) and
// `promptInjectionGuard` (which detects prompt-injection patterns):
// this middleware SANITIZES so calls proceed safely — the model sees
// `<PII_EMAIL_1>` instead of `alice@example.com`, and the caller
// still gets `alice@example.com` back in the response.
//
//   const { piiRedact } = require('@saptarishi/cds-plugin-llm');
//
//   llm.use(piiRedact({
//     detectors:       ['email', 'phone', 'ssn', 'creditCard', 'iban'],
//     unmaskResponse:  true,
//   }));
//
//   // Caller sees the original values in the response; the provider
//   // only ever received tokens.
//
// Recommended placement: OUTER of the provider so redaction fires
// before the request leaves. INNER of jsonLog / replayBuffer so the
// observability layer sees the redacted view.
//
// Streams: request-side redaction always works. Response un-masking
// on streams is DEFERRED — tokens may split across chunks, so v1
// increments `stats.streamsSkipped` and leaves stream tokens intact.

const DEFAULT_DETECTORS = ['email', 'phone', 'ssn', 'creditCard', 'iban'];
const DEFAULT_FIELDS = ['messages', 'system', 'input'];

// ---- Built-in detectors ------------------------------------------------

const BUILT_IN = {
  // RFC 5321 basic — captures typical addresses without over-matching.
  email: {
    pattern: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
  },
  // Credit cards — 13-19 digits with optional separators. Luhn-validated
  // to avoid false-positives (long invoice numbers, part numbers, ...).
  creditCard: {
    pattern: /\b(?:\d[ \-]?){12,18}\d\b/g,
    validate: (m) => luhnValid(m.replace(/[ \-]/g, '')),
  },
  // IBAN — 2-letter country + 2 check digits + 11-30 alphanumerics.
  // Uppercased before match; conservative length bound avoids random junk.
  iban: {
    pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,
  },
  // US SSN — strict format only (avoids over-matching part numbers).
  ssn: {
    pattern: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g,
  },
  // Phone — E.164 + common US/EU formats. Requires at least 10 digits
  // in total to avoid capturing short numeric IDs.
  phone: {
    pattern: /(?:\+?\d{1,3}[ .\-]?)?(?:\(?\d{2,4}\)?[ .\-]?)?\d{3,4}[ .\-]?\d{3,4}/g,
    validate: (m) => {
      const digits = m.replace(/\D/g, '');
      return digits.length >= 10 && digits.length <= 15;
    },
  },
};

function luhnValid(digits) {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// ---- Redactor state ----------------------------------------------------
//
// Per-request substitution map: original string → token. Same original
// always maps to the same token within one request, so a model prompt
// like "email alice@x.com; reply to alice@x.com" gets a single token.

function makeRedactor(activeDetectors, tokenFor) {
  // Ordered longest-pattern-first for greedy matching. Credit card / IBAN
  // before phone; email before generic patterns.
  const ORDER = ['email', 'iban', 'creditCard', 'ssn', 'phone'];
  const detectorList = [];
  for (const name of ORDER) {
    if (activeDetectors[name]) detectorList.push([name, activeDetectors[name]]);
  }
  // Custom detectors after built-ins.
  for (const [name, d] of Object.entries(activeDetectors)) {
    if (!ORDER.includes(name)) detectorList.push([name, d]);
  }

  const map = new Map();      // original → token
  const counters = {};        // type → next index

  function tokenize(type, original) {
    if (map.has(original)) return map.get(original);
    counters[type] = (counters[type] ?? 0) + 1;
    const token = tokenFor(type, counters[type]);
    map.set(original, token);
    return token;
  }

  function redactString(text) {
    let out = text;
    for (const [type, det] of detectorList) {
      out = out.replace(det.pattern, (match) => {
        if (det.validate && !det.validate(match)) return match;
        return tokenize(type, match);
      });
    }
    return out;
  }

  function unmask(text) {
    if (typeof text !== 'string' || map.size === 0) return text;
    let out = text;
    // Sort by token length descending to avoid substring collisions
    // (`<PII_EMAIL_10>` would otherwise be partially consumed by a
    //  `<PII_EMAIL_1>` replacement).
    const entries = [...map.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [original, token] of entries) {
      if (out.indexOf(token) !== -1) {
        out = out.split(token).join(original);
      }
    }
    return out;
  }

  return {
    redactString,
    unmask,
    get counts() { return { ...counters }; },
    get mapSize() { return map.size; },
  };
}

// ---- Recursive request walker -----------------------------------------

function redactMessages(messages, redactor) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((msg) => {
    if (!msg || typeof msg !== 'object') return msg;
    const content = msg.content;
    if (typeof content === 'string') {
      return { ...msg, content: redactor.redactString(content) };
    }
    if (Array.isArray(content)) {
      return {
        ...msg,
        content: content.map((block) => {
          if (block?.type === 'text' && typeof block.text === 'string') {
            return { ...block, text: redactor.redactString(block.text) };
          }
          return block;
        }),
      };
    }
    return msg;
  });
}

// ---- Main middleware --------------------------------------------------

function piiRedact(options = {}) {
  const {
    detectors        = DEFAULT_DETECTORS,
    customDetectors  = {},
    tokenFor         = (type, index) => `<PII_${type.toUpperCase()}_${index}>`,
    fields           = DEFAULT_FIELDS,
    unmaskResponse   = true,
    captureStreams   = true,
  } = options;

  if (!Array.isArray(detectors)) {
    throw new Error('piiRedact: detectors must be an array of names.');
  }
  if (typeof tokenFor !== 'function') {
    throw new Error('piiRedact: tokenFor must be a function.');
  }
  if (typeof customDetectors !== 'object' || customDetectors === null) {
    throw new Error('piiRedact: customDetectors must be an object.');
  }

  // Assemble the active detector set.
  const active = {};
  for (const name of detectors) {
    if (!BUILT_IN[name]) throw new Error(`piiRedact: unknown built-in detector '${name}'. Known: ${Object.keys(BUILT_IN).join(', ')}`);
    active[name] = BUILT_IN[name];
  }
  for (const [name, def] of Object.entries(customDetectors)) {
    if (!def || !(def.pattern instanceof RegExp)) {
      throw new Error(`piiRedact: customDetectors['${name}'] must have { pattern: RegExp }.`);
    }
    if (!def.pattern.global) {
      throw new Error(`piiRedact: customDetectors['${name}'].pattern must have the 'g' flag.`);
    }
    active[name] = def;
  }

  const stats = {
    totalRequests:   0,
    requestsWithPii: 0,
    tokensReplaced:  0,
    responsesUnmasked: 0,
    streamsSkipped:  0,
    byType:          {},
  };

  const mw = async (ctx, next) => {
    stats.totalRequests++;
    if (!ctx?.request) return next();

    const redactor = makeRedactor(active, tokenFor);

    // Redact requested fields on ctx.request.
    const original = ctx.request;
    const patched = { ...original };
    let changed = false;

    for (const field of fields) {
      const val = patched[field];
      if (val == null) continue;
      if (field === 'messages') {
        const redacted = redactMessages(val, redactor);
        if (redacted !== val) { patched.messages = redacted; changed = true; }
      } else if (typeof val === 'string') {
        const redacted = redactor.redactString(val);
        if (redacted !== val) { patched[field] = redacted; changed = true; }
      }
    }

    // Update stats based on the redactor's counters.
    if (redactor.mapSize > 0) {
      stats.requestsWithPii++;
      stats.tokensReplaced += redactor.mapSize;
      for (const [type, n] of Object.entries(redactor.counts)) {
        stats.byType[type] = (stats.byType[type] ?? 0) + n;
      }
    }

    if (changed) ctx.request = patched;

    let result;
    try {
      result = await next();
    } finally {
      // Restore original request (non-destructive for outer chain).
      ctx.request = original;
    }

    if (!unmaskResponse || redactor.mapSize === 0) return result;

    // Un-mask on the response text (non-stream).
    const { hasStreamCompletion } = require('../streamCompletion');
    if (captureStreams && hasStreamCompletion(result)) {
      stats.streamsSkipped++;
      return result;
    }

    if (result && typeof result === 'object' && typeof result.text === 'string') {
      const unmasked = redactor.unmask(result.text);
      if (unmasked !== result.text) {
        result.text = unmasked;
        stats.responsesUnmasked++;
      }
    }
    return result;
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.totalRequests = stats.requestsWithPii = 0;
    stats.tokensReplaced = stats.responsesUnmasked = stats.streamsSkipped = 0;
    for (const k of Object.keys(stats.byType)) delete stats.byType[k];
  };
  mw.asMcpResource = () => ({
    uri: 'config://pii-redact',
    name: 'PII redaction middleware',
    description: 'Redacts emails / phones / SSNs / credit cards / IBANs before requests leave, un-masks on response.',
    mimeType: 'application/json',
    handler: () => ({
      detectors:      [...detectors, ...Object.keys(customDetectors)],
      unmaskResponse,
      captureStreams,
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  piiRedact,
  luhnValid,
  BUILT_IN_DETECTORS: BUILT_IN,
  // Exposed for tests + composition
  makeRedactor,
  redactMessages,
};
