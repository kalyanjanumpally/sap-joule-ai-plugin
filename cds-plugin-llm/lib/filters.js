// Built-in filters for the guardrails() middleware. Each factory returns
// an async (payload, ctx) => { action } function. See lib/middleware/
// guardrails.js for how filters are wired.

// ---- Blocklist filter --------------------------------------------------
//
//   filters.blocklist(['password', /confidential-\d+/i])
//     → blocks the request when any pattern matches system + any message content.
//
//   filters.blocklist(['password'], { mode: 'redact', replacement: '[REDACTED]' })
//     → redacts matches instead of blocking.

function blocklist(patterns, options = {}) {
  const { mode = 'block', replacement = '[REDACTED]' } = options;
  if (!Array.isArray(patterns) || patterns.length === 0) {
    throw new Error('filters.blocklist: patterns must be a non-empty array of strings or RegExps');
  }
  if (mode !== 'block' && mode !== 'redact') {
    throw new Error(`filters.blocklist: mode must be 'block' or 'redact' (got ${mode})`);
  }
  const rxs = patterns.map(p => (p instanceof RegExp ? p : new RegExp(escapeRegex(String(p)), 'gi')));

  return async (payload) => {
    const texts = extractStrings(payload);
    if (mode === 'block') {
      for (const rx of rxs) {
        for (const t of texts) {
          if (rx.test(t)) {
            rx.lastIndex = 0;
            return { action: 'block', reason: `blocklist pattern matched: ${rx}` };
          }
          rx.lastIndex = 0;
        }
      }
      return { action: 'allow' };
    }
    // redact
    let touched = false;
    const redacted = mapStrings(payload, (s) => {
      let out = s;
      for (const rx of rxs) {
        rx.lastIndex = 0;
        if (rx.test(out)) {
          rx.lastIndex = 0;
          out = out.replace(rx, replacement);
          touched = true;
        }
      }
      return out;
    });
    return touched ? { action: 'redact', payload: redacted } : { action: 'allow' };
  };
}

// ---- PII filter --------------------------------------------------------
//
//   filters.pii({ redact: true })
//     → replaces PII with [REDACTED-<type>] tags.
//
//   filters.pii({ redact: false })
//     → blocks the request when PII is detected.
//
// Recognized types (all opt-in via `types: [...]`; default = all):
//   ssn         US Social Security Numbers (NNN-NN-NNNN)
//   creditCard  16-digit runs matching common brand prefixes
//   email       standard email addresses
//   phone       US-style phone numbers (with optional +1 country code)

const PII_REGEXES = {
  ssn:        /\b\d{3}-\d{2}-\d{4}\b/g,
  creditCard: /\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6011)[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
  email:      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  phone:      /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g,
};

function pii(options = {}) {
  const {
    redact = true,
    types = Object.keys(PII_REGEXES),
    replacement = (type) => `[REDACTED-${type}]`,
  } = options;
  const active = types.map(t => {
    if (!PII_REGEXES[t]) throw new Error(`filters.pii: unknown type '${t}'. Known: ${Object.keys(PII_REGEXES).join(', ')}`);
    return { type: t, rx: PII_REGEXES[t] };
  });

  return async (payload) => {
    const texts = extractStrings(payload);
    if (!redact) {
      for (const { type, rx } of active) {
        for (const t of texts) {
          rx.lastIndex = 0;
          if (rx.test(t)) {
            rx.lastIndex = 0;
            return { action: 'block', reason: `PII detected: ${type}` };
          }
          rx.lastIndex = 0;
        }
      }
      return { action: 'allow' };
    }
    let touched = false;
    const redacted = mapStrings(payload, (s) => {
      let out = s;
      for (const { type, rx } of active) {
        rx.lastIndex = 0;
        if (rx.test(out)) {
          rx.lastIndex = 0;
          out = out.replace(rx, replacement(type));
          touched = true;
        }
      }
      return out;
    });
    return touched ? { action: 'redact', payload: redacted } : { action: 'allow' };
  };
}

// ---- Prompt-injection detector ----------------------------------------
//
// Heuristic-only — matches well-known injection patterns. Not a substitute
// for defense in depth (least-privilege tools, output constraints, etc.).
//
//   filters.promptInjection()
//     → default patterns
//   filters.promptInjection({ extraPatterns: [/leak the secret/i] })
//     → augment defaults

const DEFAULT_INJECTION_PATTERNS = [
  /ignore (all |the )?(previous|prior|above) (instructions?|prompts?)/i,
  /disregard (all |the )?(previous|prior|above) (instructions?|prompts?)/i,
  /forget everything (i|you) (told|said|wrote)/i,
  /you are (now|actually) (?:a|an )?[a-z]+/i,     // "you are now a pirate", "you are actually DAN"
  /^system[:.]?\s+/im,                              // stray system-role attempts in user text
  new RegExp('</?(system|assistant)>', 'i'),        // fake role tags (RegExp form avoids literal-slash ambiguity)
  /\bDAN\b|\bjailbreak\b|\brole[- ]?play\b/i,
  /reveal (?:your|the) (?:system prompt|instructions|hidden prompt)/i,
];

function promptInjection(options = {}) {
  const { extraPatterns = [] } = options;
  if (!Array.isArray(extraPatterns)) throw new Error('filters.promptInjection: extraPatterns must be an array of RegExps');
  const patterns = [...DEFAULT_INJECTION_PATTERNS, ...extraPatterns];

  return async (payload) => {
    // Only examine user + tool messages — never fingerprint the system prompt.
    const suspects = [];
    if (Array.isArray(payload.messages)) {
      for (const m of payload.messages) {
        if (m.role !== 'user' && m.role !== 'tool') continue;
        if (typeof m.content === 'string') suspects.push(m.content);
        else if (Array.isArray(m.content)) {
          for (const b of m.content) {
            if (b && typeof b.text === 'string') suspects.push(b.text);
          }
        }
      }
    }
    for (const rx of patterns) {
      for (const s of suspects) {
        if (rx.test(s)) {
          return { action: 'block', reason: `possible prompt injection: ${rx}` };
        }
      }
    }
    return { action: 'allow' };
  };
}

// ---- helpers -----------------------------------------------------------

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Given a payload — either { system, messages } (input side) or a chat
// response ({ text, content, ... }) — pull out all readable strings for
// pattern matching.
function extractStrings(payload) {
  const out = [];
  if (payload == null) return out;
  if (typeof payload.system === 'string') out.push(payload.system);
  if (Array.isArray(payload.messages)) {
    for (const m of payload.messages) {
      if (typeof m.content === 'string') out.push(m.content);
      else if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b && typeof b.text === 'string') out.push(b.text);
        }
      }
    }
  }
  if (typeof payload.text === 'string') out.push(payload.text);
  if (Array.isArray(payload.content)) {
    for (const b of payload.content) {
      if (b && typeof b.text === 'string') out.push(b.text);
    }
  }
  return out;
}

// Return a NEW payload with every readable string transformed. Preserves
// unrecognized fields untouched (raw, usage, model, etc.).
function mapStrings(payload, fn) {
  if (payload == null) return payload;
  const out = { ...payload };
  if (typeof payload.system === 'string') out.system = fn(payload.system);
  if (Array.isArray(payload.messages)) {
    out.messages = payload.messages.map((m) => {
      if (typeof m.content === 'string') return { ...m, content: fn(m.content) };
      if (Array.isArray(m.content)) {
        return {
          ...m,
          content: m.content.map((b) => (b && typeof b.text === 'string' ? { ...b, text: fn(b.text) } : b)),
        };
      }
      return m;
    });
  }
  if (typeof payload.text === 'string') out.text = fn(payload.text);
  if (Array.isArray(payload.content)) {
    out.content = payload.content.map((b) => (b && typeof b.text === 'string' ? { ...b, text: fn(b.text) } : b));
  }
  return out;
}

module.exports = {
  blocklist,
  pii,
  promptInjection,
  // internal helpers surfaced for tests + custom filter authors
  _extractStrings: extractStrings,
  _mapStrings: mapStrings,
  PII_REGEXES,
  DEFAULT_INJECTION_PATTERNS,
};
