// Multi-model consensus voting. Sends the same request to N models
// in parallel, tallies their responses under a caller-supplied
// comparator (default: normalized-text equality), and returns the
// majority response with a confidence score + full ballot trail.
//
// Cost multiplier (roughly Nx per call) — use for high-stakes calls
// where hallucination cost > extra spend: compliance-critical
// extractions, financial risk assessments, structured-output where
// even small deviations are bugs.
//
// Composes with responseCache (1.26 semantic mode) for hybrid
// cheap+consensus: cache warm queries; consensus-vote only on
// cache misses.
//
//   const { consensusVoting } = require('@saptarishi/cds-plugin-llm');
//
//   const result = await consensusVoting({
//     models: [
//       { service: anthropicLlm, model: 'claude-opus-4-7' },
//       { service: openaiLlm,    model: 'gpt-4o' },
//       { service: geminiLlm,    model: 'gemini-1.5-pro' },
//     ],
//     request: { messages: [{ role: 'user', content: 'What is the invoice total?' }] },
//     quorum: 2,                              // 2 of 3 must agree
//     comparator: 'normalized-text',           // shipped: 'exact' | 'normalized-text' | 'json-deep'
//   });
//   //  {
//   //    verdict: 'consensus',                    // 'consensus' | 'plurality' | 'no-consensus' | 'all-failed'
//   //    response: { text: 'The invoice total is $1234.56.', ... },
//   //    confidence: 0.667,                        // matching_ballots / total_ballots
//   //    quorum: 2,
//   //    ballots: [
//   //      { model: 'claude-opus-4-7', ok: true,  response: {...}, key: 'the invoice total is 1234 56', matched: true },
//   //      { model: 'gpt-4o',           ok: true,  response: {...}, key: 'the invoice total is 1234 56', matched: true },
//   //      { model: 'gemini-1.5-pro',   ok: true,  response: {...}, key: 'invoice was 1234 56 total', matched: false },
//   //    ],
//   //    tallies: [
//   //      { key: 'the invoice total is 1234 56', count: 2, sampleModel: 'claude-opus-4-7' },
//   //      { key: 'invoice was 1234 56 total',    count: 1, sampleModel: 'gemini-1.5-pro' },
//   //    ],
//   //  }

// ---- Comparators -----------------------------------------------------

/**
 * Reduce a response object down to a comparable "key" — same key ⇒
 * same vote. Shipped comparators:
 *
 *   'exact'           — verbatim text equality (trailing-newline sensitive)
 *   'normalized-text' — trim + collapse whitespace + lowercase (default)
 *   'json-deep'       — parse text as JSON, canonical stringify
 */
const COMPARATORS = Object.freeze({
  exact:               keyExact,
  'normalized-text':   keyNormalizedText,
  'json-deep':         keyJsonDeep,
});

const KNOWN_COMPARATORS = Object.freeze(Object.keys(COMPARATORS));

function keyExact(response) {
  if (response == null) return '';
  if (typeof response === 'string') return response;
  return typeof response.text === 'string' ? response.text : JSON.stringify(response);
}

function keyNormalizedText(response) {
  return keyExact(response)
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function keyJsonDeep(response) {
  const text = typeof response?.text === 'string' ? response.text : keyExact(response);
  const parsed = tryParseJson(text);
  if (parsed == null) return keyNormalizedText(response);
  return canonicalJson(parsed);
}

function tryParseJson(text) {
  if (typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch { /* fall through */ }
  const block = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (block) { try { return JSON.parse(block[1].trim()); } catch { /* fall through */ } }
  const f = text.indexOf('{'), l = text.lastIndexOf('}');
  if (f !== -1 && l > f) { try { return JSON.parse(text.slice(f, l + 1)); } catch { /* fall through */ } }
  return null;
}

function canonicalJson(v) {
  // Recursive stable stringify — sorts object keys.
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
}

// ---- Timeout helper --------------------------------------------------

async function withTimeout(promise, ms, label) {
  if (!ms || ms <= 0) return promise;
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label}: timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(t);
  }
}

// ---- Main API -------------------------------------------------------

/**
 * Run consensus voting across N models. Returns a verdict + response
 * + full ballot trail.
 *
 * @param options.models     — Array of { service, model? } entries.
 * @param options.request    — Shared request payload (messages, etc).
 * @param options.quorum     — Min number of matching ballots for
 *                             'consensus' verdict. Default:
 *                             floor(N/2) + 1.
 * @param options.comparator — String kind (see KNOWN_COMPARATORS) or
 *                             function (response) => string. Default:
 *                             'normalized-text'.
 * @param options.timeoutMs  — Per-model timeout. Default 30_000.
 * @param options.onBallot   — Called per ballot with { model, ok, ... }.
 *                             Errors swallowed.
 */
async function consensusVoting(options = {}) {
  const {
    models,
    request,
    quorum,
    comparator      = 'normalized-text',
    timeoutMs       = 30_000,
    onBallot        = null,
  } = options;

  if (!Array.isArray(models) || models.length === 0) {
    throw new Error('consensusVoting: models must be a non-empty array.');
  }
  for (const [i, m] of models.entries()) {
    if (!m || !m.service || typeof m.service.chat !== 'function') {
      throw new Error(`consensusVoting: models[${i}].service must be an LLMService.`);
    }
  }
  if (!request || typeof request !== 'object') {
    throw new Error('consensusVoting: request must be an object.');
  }
  if (onBallot != null && typeof onBallot !== 'function') {
    throw new Error('consensusVoting: onBallot must be a function.');
  }

  // Resolve comparator.
  let keyFn;
  if (typeof comparator === 'function') keyFn = comparator;
  else if (typeof comparator === 'string' && COMPARATORS[comparator]) keyFn = COMPARATORS[comparator];
  else {
    throw new Error(`consensusVoting: comparator must be a function or one of [${KNOWN_COMPARATORS.join(', ')}] (got ${JSON.stringify(comparator)}).`);
  }

  const N = models.length;
  const effectiveQuorum = quorum ?? (Math.floor(N / 2) + 1);
  if (!Number.isInteger(effectiveQuorum) || effectiveQuorum < 1 || effectiveQuorum > N) {
    throw new Error(`consensusVoting: quorum must be integer in [1, ${N}] (got ${effectiveQuorum}).`);
  }

  // Fire all N calls in parallel with a per-model timeout + soft-fail.
  const ballots = await Promise.all(models.map(async (m, i) => {
    const started = Date.now();
    try {
      // Per-model request: merge shared request with per-model overrides.
      const perModelReq = m.model ? { ...request, model: m.model } : request;
      const response = await withTimeout(m.service.chat(perModelReq), timeoutMs, `model ${m.model ?? i}`);
      const key = keyFn(response);
      const info = {
        model: m.model ?? `model-${i}`,
        ok: true,
        response,
        key,
        error: null,
        durationMs: Date.now() - started,
      };
      if (onBallot) { try { onBallot(info); } catch { /* swallow */ } }
      return info;
    } catch (err) {
      const info = {
        model: m.model ?? `model-${i}`,
        ok: false,
        response: null,
        key: null,
        error: err?.message ?? String(err),
        durationMs: Date.now() - started,
      };
      if (onBallot) { try { onBallot(info); } catch { /* swallow */ } }
      return info;
    }
  }));

  // Tally.
  const okBallots = ballots.filter((b) => b.ok);
  const buckets = new Map();   // key → { count, sampleBallot }
  for (const b of okBallots) {
    const prev = buckets.get(b.key);
    if (prev) prev.count++;
    else buckets.set(b.key, { count: 1, sampleBallot: b });
  }
  const tallies = [...buckets.entries()]
    .map(([key, { count, sampleBallot }]) => ({
      key,
      count,
      sampleModel: sampleBallot.model,
    }))
    .sort((a, b) => b.count - a.count);

  // Verdict.
  let verdict;
  let winner = null;
  if (okBallots.length === 0) {
    verdict = 'all-failed';
  } else {
    const top = tallies[0];
    winner = buckets.get(top.key).sampleBallot;
    if (top.count >= effectiveQuorum) verdict = 'consensus';
    else if (tallies.length === 1 || (tallies.length > 1 && top.count > tallies[1].count)) verdict = 'plurality';
    else verdict = 'no-consensus';
  }

  // Mark ballots that voted with the winning key.
  const winnerKey = winner?.key ?? null;
  for (const b of ballots) {
    b.matched = winnerKey != null && b.key === winnerKey;
  }

  return {
    verdict,
    response: winner?.response ?? null,
    confidence: N > 0 ? (tallies[0]?.count ?? 0) / N : 0,
    quorum: effectiveQuorum,
    modelCount: N,
    ballots,
    tallies,
  };
}

module.exports = {
  consensusVoting,
  COMPARATORS,
  KNOWN_COMPARATORS,
  // Exposed for tests + composition.
  keyExact,
  keyNormalizedText,
  keyJsonDeep,
  canonicalJson,
};
