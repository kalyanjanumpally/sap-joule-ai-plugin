// Structured response scoring. Lightweight programmatic evaluator
// that scores an LLM output against a rubric of deterministic
// checks — no additional LLM call, no cost. Companion to llmJudge
// (1.84) for cheap sanity gates that catch obvious problems before
// paying for a full judgment.
//
// Composes with promptRegression (1.89): use scoreResponse for
// mechanical rubric enforcement, llmJudge for qualitative
// assessment. Together they form a two-tier eval:
//
//   1. Fast rubric filter (scoreResponse) — reject obvious failures
//   2. Slow judge scoring (llmJudge)      — grade the survivors
//
// Rubric shape:
//
//   const rubric = [
//     { name: 'contains-invoice-number',
//       check: 'contains', value: 'INV-' },
//     { name: 'is-valid-json',
//       check: 'json-schema',
//       schema: { type: 'object', required: ['vendor', 'total'] } },
//     { name: 'sentence-count',
//       check: 'word-count-range', min: 3, max: 60 },
//     { name: 'no-hallucinated-money',
//       check: 'no-hallucinated-numbers',
//       allowed: ['1234.56', '2026'] },        // known-good numbers
//     { name: 'has-citation',
//       check: 'regex', pattern: /\[\d+\]/ },
//     { name: 'custom-domain-check',
//       check: (text, ctx) => ({ ok: text.includes(ctx.tenantId), reason: 'tenant id present' }) },
//   ];
//
//   const result = scoreResponse(response, rubric);
//   //  {
//   //    ok:     false,
//   //    score:  0.83,                  // fraction of checks that passed
//   //    passed: 5, failed: 1, total: 6,
//   //    results: [
//   //      { name: 'contains-invoice-number', ok: true,  ... },
//   //      { name: 'is-valid-json',           ok: true,  ... },
//   //      { name: 'sentence-count',          ok: true,  ... },
//   //      { name: 'no-hallucinated-money',   ok: false, reason: 'unknown number: 9999.99' },
//   //      ...
//   //    ],
//   //  }

// ---- Rubric registry — one function per check kind ------------------

const CHECKS = Object.freeze({
  'contains':        checkContains,
  'not-contains':    checkNotContains,
  'regex':           checkRegex,
  'not-regex':       checkNotRegex,
  'json':            checkJson,
  'json-schema':     checkJsonSchema,
  'word-count-range': checkWordCountRange,
  'char-count-range': checkCharCountRange,
  'sentence-count-range': checkSentenceCountRange,
  'no-hallucinated-numbers': checkNoHallucinatedNumbers,
  'starts-with':     checkStartsWith,
  'ends-with':       checkEndsWith,
  'one-of':          checkOneOf,
});

const KNOWN_CHECK_KINDS = Object.freeze(Object.keys(CHECKS));

// ---- Individual check implementations -------------------------------

function checkContains(text, criterion) {
  const val = criterion.value ?? '';
  const insensitive = criterion.caseInsensitive === true;
  const found = insensitive
    ? text.toLowerCase().includes(String(val).toLowerCase())
    : text.includes(String(val));
  return {
    ok: found,
    reason: found
      ? `contains '${val}'`
      : `does not contain '${val}'`,
  };
}

function checkNotContains(text, criterion) {
  const r = checkContains(text, criterion);
  return {
    ok: !r.ok,
    reason: r.ok ? `unexpectedly ${r.reason}` : `correctly ${r.reason}`,
  };
}

function checkRegex(text, criterion) {
  const pattern = criterion.pattern;
  if (!(pattern instanceof RegExp)) {
    return { ok: false, reason: 'pattern must be a RegExp' };
  }
  const found = pattern.test(text);
  return {
    ok: found,
    reason: found ? `matches ${pattern}` : `does not match ${pattern}`,
  };
}

function checkNotRegex(text, criterion) {
  const r = checkRegex(text, criterion);
  return { ok: !r.ok, reason: r.ok ? 'unexpectedly ' + r.reason : 'correctly ' + r.reason };
}

function checkJson(text) {
  try {
    JSON.parse(text);
    return { ok: true, reason: 'valid JSON' };
  } catch (e) {
    return { ok: false, reason: `invalid JSON: ${e.message}` };
  }
}

function checkJsonSchema(text, criterion) {
  const parsed = tryParse(text);
  if (parsed == null) return { ok: false, reason: 'not parseable JSON' };
  const errs = validateJsonSchema(parsed, criterion.schema ?? {});
  if (errs.length === 0) return { ok: true, reason: 'matches schema' };
  return { ok: false, reason: errs[0] };
}

function checkWordCountRange(text, criterion) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const n = words.length;
  const min = criterion.min ?? 0;
  const max = criterion.max ?? Infinity;
  const ok = n >= min && n <= max;
  return {
    ok,
    reason: ok
      ? `${n} words (in [${min}, ${max}])`
      : `${n} words (out of [${min}, ${max}])`,
  };
}

function checkCharCountRange(text, criterion) {
  const n = text.length;
  const min = criterion.min ?? 0;
  const max = criterion.max ?? Infinity;
  const ok = n >= min && n <= max;
  return { ok, reason: ok ? `${n} chars in range` : `${n} chars out of [${min}, ${max}]` };
}

function checkSentenceCountRange(text, criterion) {
  // Split on . ! ? and count runs of alpha-num content.
  const sentences = text.split(/[.!?]+/).map((s) => s.trim()).filter((s) => s.length > 0);
  const n = sentences.length;
  const min = criterion.min ?? 0;
  const max = criterion.max ?? Infinity;
  const ok = n >= min && n <= max;
  return { ok, reason: ok ? `${n} sentences in range` : `${n} sentences out of [${min}, ${max}]` };
}

function checkNoHallucinatedNumbers(text, criterion) {
  const allowedList = (criterion.allowed ?? []).map((v) => normalizeNumber(String(v)));
  const allowedSet = new Set(allowedList);
  // Match numbers with clean word boundaries so trailing punctuation
  // (commas, semicolons) doesn't get pulled into the token. Use a
  // lookahead to ensure the number ends on a non-digit, non-comma
  // boundary. Thousands separators inside the digit stream still work
  // (1,234.56 matches whole) but a bare "2," in prose becomes "2".
  const found = text.match(/-?\d(?:[\d,]*\.\d+|[\d,]*(?=[^\d,]|$))/g) ?? [];
  for (const raw of found) {
    const norm = normalizeNumber(raw);
    // Ignore standalone single digits — commonly used as list markers,
    // ordinals, quantities, and rarely carry hallucination risk.
    if (/^-?\d$/.test(norm)) continue;
    if (!allowedSet.has(norm)) {
      return { ok: false, reason: `unknown number: ${raw}` };
    }
  }
  return { ok: true, reason: 'all numbers accounted for' };
}

function checkStartsWith(text, criterion) {
  const val = String(criterion.value ?? '');
  const insensitive = criterion.caseInsensitive === true;
  const found = insensitive
    ? text.toLowerCase().startsWith(val.toLowerCase())
    : text.startsWith(val);
  return { ok: found, reason: found ? `starts with '${val}'` : `does not start with '${val}'` };
}

function checkEndsWith(text, criterion) {
  const val = String(criterion.value ?? '');
  const insensitive = criterion.caseInsensitive === true;
  const found = insensitive
    ? text.toLowerCase().trim().endsWith(val.toLowerCase())
    : text.trim().endsWith(val);
  return { ok: found, reason: found ? `ends with '${val}'` : `does not end with '${val}'` };
}

function checkOneOf(text, criterion) {
  const options = criterion.options ?? [];
  const insensitive = criterion.caseInsensitive === true;
  const t = insensitive ? text.trim().toLowerCase() : text.trim();
  const match = options.find((opt) => {
    const o = insensitive ? String(opt).toLowerCase() : String(opt);
    return t === o;
  });
  return {
    ok: match != null,
    reason: match != null
      ? `is one of [${options.join(', ')}]`
      : `not one of [${options.join(', ')}]`,
  };
}

// ---- Helpers -------------------------------------------------------

function tryParse(text) {
  try { return JSON.parse(text); }
  catch { /* fall through */ }
  // Try to extract JSON block from prose.
  const block = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (block) {
    try { return JSON.parse(block[1].trim()); }
    catch { /* fall through */ }
  }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(text.slice(first, last + 1)); }
    catch { /* fall through */ }
  }
  return null;
}

function normalizeNumber(raw) {
  // Strip thousands separators + trailing zeros; parseFloat then toString
  // gives us a canonical form so 1234.56 == "1,234.56" == "1234.560".
  const stripped = String(raw).replace(/,/g, '');
  const n = parseFloat(stripped);
  return Number.isFinite(n) ? String(n) : String(raw);
}

/**
 * Minimal JSON Schema validator — same subset as
 * structuredOutputValidator (1.76) uses. Returns array of error strings.
 */
function validateJsonSchema(obj, schema, path = '$') {
  const errors = [];
  if (!schema || typeof schema !== 'object') return errors;

  if (schema.type) {
    const t = jsTypeOf(obj);
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    const match = expected.some((e) => e === t || (e === 'number' && t === 'integer'));
    if (!match) errors.push(`${path}: expected type ${expected.join('|')} but got ${t}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(obj)) {
    errors.push(`${path}: value ${JSON.stringify(obj)} not in enum`);
  }
  if (schema.type === 'object' && obj && typeof obj === 'object' && !Array.isArray(obj)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!(key in obj)) errors.push(`${path}: missing required field "${key}"`);
      }
    }
    if (schema.properties && typeof schema.properties === 'object') {
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (key in obj) errors.push(...validateJsonSchema(obj[key], sub, `${path}.${key}`));
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      const known = new Set(Object.keys(schema.properties));
      for (const key of Object.keys(obj)) {
        if (!known.has(key)) errors.push(`${path}: unexpected property "${key}"`);
      }
    }
  }
  if (schema.type === 'array' && Array.isArray(obj) && schema.items) {
    obj.forEach((el, i) => errors.push(...validateJsonSchema(el, schema.items, `${path}[${i}]`)));
  }
  return errors;
}

function jsTypeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

// ---- Public API ----------------------------------------------------

/**
 * Score a text response against a rubric.
 *
 * @param response  string | { text: string }  the LLM output
 * @param rubric    array of { name, check, weight?, ... } criteria
 * @param ctx       optional context object passed to function-check
 */
function scoreResponse(response, rubric, ctx = {}) {
  if (response == null) {
    throw new Error('scoreResponse: response is required.');
  }
  if (!Array.isArray(rubric)) {
    throw new Error('scoreResponse: rubric must be an array.');
  }

  const text = typeof response === 'string'
    ? response
    : typeof response?.text === 'string'
      ? response.text
      : '';

  const results = [];
  let weightSum = 0;
  let weightedPassed = 0;

  for (const [i, criterion] of rubric.entries()) {
    if (!criterion || typeof criterion !== 'object') {
      throw new Error(`scoreResponse: rubric[${i}] must be an object.`);
    }
    const name = criterion.name ?? `criterion-${i + 1}`;
    const weight = criterion.weight ?? 1;
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new Error(`scoreResponse: rubric[${i}].weight must be a positive number.`);
    }

    let outcome;
    if (typeof criterion.check === 'function') {
      // Function check — user-supplied; must return { ok, reason }.
      try {
        outcome = criterion.check(text, ctx, response) ?? { ok: false, reason: 'check returned nothing' };
      } catch (err) {
        outcome = { ok: false, reason: `check threw: ${err.message}` };
      }
    } else if (typeof criterion.check === 'string') {
      const impl = CHECKS[criterion.check];
      if (!impl) {
        throw new Error(`scoreResponse: rubric[${i}] unknown check kind '${criterion.check}'. Known: ${KNOWN_CHECK_KINDS.join(', ')}`);
      }
      outcome = impl(text, criterion, ctx);
    } else {
      throw new Error(`scoreResponse: rubric[${i}].check must be a string kind or a function.`);
    }

    results.push({ name, ok: outcome.ok, reason: outcome.reason, weight });
    weightSum += weight;
    if (outcome.ok) weightedPassed += weight;
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;

  return {
    ok:      failed === 0,
    score:   weightSum > 0 ? weightedPassed / weightSum : 0,
    passed, failed, total: results.length,
    results,
  };
}

/**
 * Human-readable renderer for a scoreResponse result. Great for CI logs.
 */
function formatScoreReport(report, { colors = false } = {}) {
  const c = colors
    ? { green: '\x1b[32m', red: '\x1b[31m', dim: '\x1b[2m', reset: '\x1b[0m' }
    : { green: '', red: '', dim: '', reset: '' };
  const lines = [];
  for (const r of report.results) {
    const mark = r.ok ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
    const w = r.weight !== 1 ? ` ${c.dim}(weight ${r.weight})${c.reset}` : '';
    lines.push(`  ${mark} ${r.name}${w}  ${c.dim}${r.reason}${c.reset}`);
  }
  lines.push('');
  const scorePct = (report.score * 100).toFixed(1);
  const summary = `${report.passed}/${report.total} passed  ·  score ${scorePct}%`;
  lines.push(report.ok
    ? `${c.green}${summary}${c.reset}`
    : `${c.red}${summary}${c.reset}`);
  return lines.join('\n');
}

module.exports = {
  scoreResponse,
  formatScoreReport,
  KNOWN_CHECK_KINDS,
  CHECKS,
  // Exposed for tests + composition
  validateJsonSchema,
};
