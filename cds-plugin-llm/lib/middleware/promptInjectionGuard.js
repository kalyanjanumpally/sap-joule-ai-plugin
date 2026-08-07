// Prompt-injection detection middleware for llm.use(). Goes beyond the
// shallow regex-based `filters.promptInjection()` by layering multiple
// heuristics + confidence scoring + sanitization.
//
//   const guard = promptInjectionGuard({
//     action:    'block',            // 'block' | 'sanitize' | 'warn'
//     threshold: 0.6,                // 0-1; higher = fewer false positives
//     detectors: ['regex', 'base64', 'unicode', 'delimiters', 'roleAttempt', 'lengthAnomaly'],
//     maxUserMessageChars: 8000,     // triggers lengthAnomaly detector
//     extraPatterns: [/leak the vault/i],
//     onDetect: (info) => cds.log('llm:injection').warn(info),
//   });
//   llm.use(guard);
//
// Each detector returns { hit: bool, confidence: 0-1, evidence: string }.
// The middleware aggregates their confidences (capped at 1.0). If the
// combined score >= `threshold`, the configured action fires:
//
//   'block'    → throw PromptInjectionError. Provider never called.
//   'sanitize' → strip zero-width chars, NFKC normalize, drop suspicious
//                delimiters, truncate to maxUserMessageChars, then proceed.
//                Detector output still logged.
//   'warn'     → onDetect fires; request proceeds unmodified.
//
// Ordering: run OUTER of everything else so the sanitized/blocked payload
// is what cache keys, metering, and the provider see. Recommended chain:
//   promptInjectionGuard → guardrails → costBudget → usageMetering →
//   responseCache → provider

const { LLMError } = require('../errors');

class PromptInjectionError extends LLMError {
  constructor(score, evidence) {
    super(`prompt injection detected (score ${score.toFixed(2)}): ${evidence.join('; ')}`, 'PROMPT_INJECTION');
    this.score = score;
    this.evidence = evidence;
  }
}

// ---- Default detector patterns ---------------------------------------

const DEFAULT_REGEX_PATTERNS = [
  // Classic override attempts
  /ignore (all |the |any )?(previous|prior|above|earlier|preceding) (instructions?|prompts?|rules?|messages?)/i,
  /disregard (all |the |any )?(previous|prior|above|earlier|preceding) (instructions?|prompts?|rules?|messages?)/i,
  /forget (everything |all )?(i|you) (told|said|wrote|were told)/i,
  /override (your|the) (instructions?|guidelines?|rules?)/i,
  // Role-play manipulation
  /you are (now|actually) (?:a |an )?[a-z][a-z\- ]{2,}/i,     // "you are now DAN"
  /pretend (you|to be) (?:a |an )?[a-z]/i,
  /act (?:as|like) (?:if you are |you are )?(?:a |an )?[a-z]/i,
  /\bDAN\b|\bjailbreak\b|\brole[- ]?play\b|\bAIM\b/i,
  /from (?:now|this point) on(?:,)? you (are|will)/i,
  // Prompt exfiltration
  /reveal (?:your|the) (?:system prompt|instructions|hidden prompt|initial prompt)/i,
  /print (?:your|the) (?:system prompt|instructions|initial (?:prompt|message))/i,
  /(?:show|repeat|output|display) (?:me )?(?:your|the) (?:system prompt|initial (?:prompt|message)|instructions)/i,
  /what (?:were|are) your (?:instructions|initial instructions|guidelines)/i,
  // Delimiter smuggling
  new RegExp('</?(system|assistant|user)>', 'i'),
  /\[INST\]|\[\/INST\]/,
  /<\|(?:im_start|im_end|system|user|assistant)\|>/i,
  /^system[:.]?\s+/im,
  /###\s*(?:system|instruction)s?/i,
  // Data-exfil framing
  /(?:send|forward|email|post) (?:the |your |all )?(?:conversation|history|context) to/i,
];

// Unicode ranges we consider suspicious in user text:
//   U+200B..U+200F — zero-width space / joiner / non-joiner + LTR/RTL marks
//   U+202A..U+202E — bidi override / embedding controls
//   U+2060..U+2064, U+FEFF — invisible / BOM
const ZERO_WIDTH_RE = /[​-‏‪-‮⁠-⁤﻿]/g;

// Very rough homoglyph flag — presence of Cyrillic letters that look Latin
// in words that should be all-ASCII. Not exhaustive, but the classic phishing
// vector (Latin 'a' vs Cyrillic 'а') fires here.
const CYRILLIC_LOOKALIKE_RE = /[аеіорсхуӏ]/;

// Long delimiter-like blocks that inject a fake conversation.
const FAKE_TURN_RE = /(?:---|===|~~~|\+\+\+)\s*(?:USER|ASSISTANT|SYSTEM|HUMAN|AI)(?:\s+TURN)?\s*(?:---|===|~~~|\+\+\+)/i;

function promptInjectionGuard(options = {}) {
  const {
    action = 'block',
    threshold = 0.6,
    detectors = ['regex', 'base64', 'unicode', 'delimiters', 'roleAttempt', 'lengthAnomaly'],
    maxUserMessageChars = 8000,
    extraPatterns = [],
    onDetect = null,
  } = options;

  if (!['block', 'sanitize', 'warn'].includes(action)) {
    throw new Error(`promptInjectionGuard: action must be 'block', 'sanitize', or 'warn' (got '${action}').`);
  }
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    throw new Error(`promptInjectionGuard: threshold must be in (0, 1] (got ${threshold}).`);
  }
  if (!Array.isArray(extraPatterns)) {
    throw new Error('promptInjectionGuard: extraPatterns must be an array of RegExps');
  }
  if (!Array.isArray(detectors) || detectors.length === 0) {
    throw new Error('promptInjectionGuard: detectors must be a non-empty array');
  }
  const enabled = new Set(detectors);

  const regexPatterns = [...DEFAULT_REGEX_PATTERNS, ...extraPatterns];

  const stats = {
    scanned:   0,
    blocked:   0,
    sanitized: 0,
    warned:    0,
    byDetector: { regex: 0, base64: 0, unicode: 0, delimiters: 0, roleAttempt: 0, lengthAnomaly: 0 },
  };

  const mw = async (ctx, next) => {
    // Only screen inputs on chat + stream. Embeddings + tool-call responses
    // don't need injection guarding.
    if (ctx.method !== 'chat' && ctx.method !== 'stream') return next();

    stats.scanned++;
    const userTexts = collectUserTexts(ctx.request);
    if (userTexts.length === 0) return next();

    // Run detectors. Each returns [hit, evidence].
    const hits = [];
    let score = 0;

    if (enabled.has('regex')) {
      const h = detectRegex(userTexts, regexPatterns);
      if (h) { hits.push({ detector: 'regex', ...h }); score += h.confidence; stats.byDetector.regex++; }
    }
    if (enabled.has('base64')) {
      const h = detectBase64(userTexts, regexPatterns);
      if (h) { hits.push({ detector: 'base64', ...h }); score += h.confidence; stats.byDetector.base64++; }
    }
    if (enabled.has('unicode')) {
      const h = detectUnicode(userTexts);
      if (h) { hits.push({ detector: 'unicode', ...h }); score += h.confidence; stats.byDetector.unicode++; }
    }
    if (enabled.has('delimiters')) {
      const h = detectDelimiters(userTexts);
      if (h) { hits.push({ detector: 'delimiters', ...h }); score += h.confidence; stats.byDetector.delimiters++; }
    }
    if (enabled.has('roleAttempt')) {
      const h = detectRoleAttempt(userTexts);
      if (h) { hits.push({ detector: 'roleAttempt', ...h }); score += h.confidence; stats.byDetector.roleAttempt++; }
    }
    if (enabled.has('lengthAnomaly')) {
      const h = detectLengthAnomaly(userTexts, maxUserMessageChars);
      if (h) { hits.push({ detector: 'lengthAnomaly', ...h }); score += h.confidence; stats.byDetector.lengthAnomaly++; }
    }

    // Cap combined score at 1.0 so extraPatterns can't push us into infinity.
    if (score > 1) score = 1;

    if (hits.length === 0 || score < threshold) return next();

    const evidence = hits.map((h) => `${h.detector}: ${h.evidence}`);

    if (onDetect) {
      try { onDetect({ action, score, threshold, hits, evidence }); }
      catch { /* swallow */ }
    }

    if (action === 'block') {
      stats.blocked++;
      throw new PromptInjectionError(score, evidence);
    }
    if (action === 'sanitize') {
      stats.sanitized++;
      sanitizeInPlace(ctx.request, maxUserMessageChars);
      return next();
    }
    // action === 'warn' — request proceeds unmodified
    stats.warned++;
    return next();
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.scanned = stats.blocked = stats.sanitized = stats.warned = 0;
    for (const k of Object.keys(stats.byDetector)) stats.byDetector[k] = 0;
  };
  mw.asMcpResource = () => ({
    uri: 'config://prompt-injection-guard',
    name: 'Prompt injection guard',
    description: 'Detection + block/sanitize/warn counters since process start.',
    mimeType: 'application/json',
    handler: () => ({ action, threshold, detectors, maxUserMessageChars, stats }),
  });
  return mw;
}

// ---- Detectors --------------------------------------------------------

function collectUserTexts(request) {
  const out = [];
  if (!Array.isArray(request?.messages)) return out;
  for (const m of request.messages) {
    if (m.role !== 'user' && m.role !== 'tool') continue;
    if (typeof m.content === 'string') out.push(m.content);
    else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b && typeof b.text === 'string') out.push(b.text);
      }
    }
  }
  return out;
}

function detectRegex(texts, patterns) {
  for (const rx of patterns) {
    for (const s of texts) {
      if (rx.test(s)) {
        return { hit: true, confidence: 0.7, evidence: `matched ${rx}` };
      }
    }
  }
  return null;
}

function detectBase64(texts, patterns) {
  // Look for base64 payloads >= 40 chars (short base64 is noisy — file
  // fingerprints, IDs, etc.). Decode and re-run the regex battery on
  // the decoded text. Only fires if the decoded content also trips a
  // pattern — that's the smuggling signal.
  const B64_RE = /[A-Za-z0-9+/]{40,}={0,2}/g;
  for (const s of texts) {
    const matches = s.match(B64_RE);
    if (!matches) continue;
    for (const m of matches) {
      try {
        const decoded = Buffer.from(m, 'base64').toString('utf8');
        // If decoded is mostly non-printable, skip (probably a binary blob
        // like an inline image thumbnail). Threshold: > 30% printable ASCII.
        const printable = decoded.replace(/[^\x20-\x7E\n\r\t]/g, '').length;
        if (printable / decoded.length < 0.3) continue;
        for (const rx of patterns) {
          if (rx.test(decoded)) {
            return {
              hit: true,
              confidence: 0.85,
              evidence: `base64-decoded payload matched ${rx}`,
            };
          }
        }
      } catch { /* invalid base64 — ignore */ }
    }
  }
  return null;
}

function detectUnicode(texts) {
  for (const s of texts) {
    if (ZERO_WIDTH_RE.test(s)) {
      return { hit: true, confidence: 0.4, evidence: 'zero-width or bidi control characters' };
    }
    // Reset lastIndex — we used the global regex above via .test which
    // advances state. Re-instantiating avoids the trap.
    if (CYRILLIC_LOOKALIKE_RE.test(s) && /[a-z]/i.test(s)) {
      return { hit: true, confidence: 0.35, evidence: 'Cyrillic/Latin homoglyph mix' };
    }
  }
  return null;
}

function detectDelimiters(texts) {
  for (const s of texts) {
    if (FAKE_TURN_RE.test(s)) {
      return { hit: true, confidence: 0.6, evidence: 'fake conversation turn marker' };
    }
  }
  return null;
}

function detectRoleAttempt(texts) {
  // Broader role-manipulation check that catches phrases the regex layer
  // would miss (multi-line variants, softened wording).
  const ROLE_RE = /(?:you are now|pretend to be|act as|from now on|starting now,? you are|new instructions?:|new role:)/i;
  for (const s of texts) {
    if (ROLE_RE.test(s)) {
      return { hit: true, confidence: 0.5, evidence: 'role manipulation phrasing' };
    }
  }
  return null;
}

function detectLengthAnomaly(texts, cap) {
  for (const s of texts) {
    if (s.length > cap) {
      return {
        hit: true,
        confidence: 0.25,
        evidence: `user message ${s.length} > ${cap} chars`,
      };
    }
  }
  return null;
}

// ---- Sanitization -----------------------------------------------------

function sanitizeInPlace(request, maxUserMessageChars) {
  if (!Array.isArray(request?.messages)) return;
  for (const m of request.messages) {
    if (m.role !== 'user' && m.role !== 'tool') continue;
    if (typeof m.content === 'string') {
      m.content = sanitizeString(m.content, maxUserMessageChars);
    } else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b && typeof b.text === 'string') {
          b.text = sanitizeString(b.text, maxUserMessageChars);
        }
      }
    }
  }
}

function sanitizeString(s, cap) {
  // 1. Strip zero-width + bidi controls
  let out = s.replace(ZERO_WIDTH_RE, '');
  // 2. NFKC normalize — folds Cyrillic homoglyphs onto their canonical form
  //    where applicable (partial defense; not all Cyrillic letters normalize
  //    to Latin), and folds full-width / compatibility characters.
  out = out.normalize('NFKC');
  // 3. Strip fake-turn markers
  out = out.replace(FAKE_TURN_RE, '[fake-turn-marker-removed]');
  out = out.replace(/<\|(?:im_start|im_end|system|user|assistant)\|>/gi, '[role-marker-removed]');
  out = out.replace(/<\/?(system|assistant|user)>/gi, '[role-tag-removed]');
  // 4. Truncate
  if (out.length > cap) out = out.slice(0, cap) + '\n[truncated]';
  return out;
}

module.exports = { promptInjectionGuard, PromptInjectionError };
