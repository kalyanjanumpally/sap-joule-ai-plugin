// Structured output repair — multi-strategy auto-recovery for LLM
// responses that fail JSON schema validation. Complements the shipped
// 1.x `structuredOutputValidator` (validate + re-ask) by adding a
// **strategy chain**: deterministic local fixes are tried first (free,
// zero tokens), and the LLM is only re-asked when local repair fails.
//
//   const { structuredOutputRepair, schemas } = require('@saptarishi/cds-plugin-llm');
//
//   llm.use(structuredOutputRepair({
//     schemaFrom: (ctx) => ctx.request.format,
//     strategies: ['json-fix', 're-ask'],   // order matters
//     maxLlmRetries: 1,
//     onRepair: (info) => cds.log('llm:repair').info(info),
//   }));
//
// Strategies (built-in):
//   * **json-fix**: strip code fences, extract first {...} block, remove
//     trailing commas, quote unquoted keys, replace single quotes with
//     double quotes, remove // and /* */ comments. Deterministic and
//     local — costs zero tokens.
//   * **re-ask**: existing behavior — send a corrective user message with
//     the schema violations inline, bounded by `maxLlmRetries`.
//
// You can also register custom strategies:
//   strategies: ['json-fix', { name: 'my-fixer', apply: (raw, { errors }) => fixed }]
//
// If ALL strategies exhaust, throws `StructuredOutputInvalidError` (the
// same error class as `structuredOutputValidator`) so the two middlewares
// share the same error taxonomy + downstream handling.

const {
  StructuredOutputInvalidError,
  validateBuiltIn,
  extractFromText,
} = require('./structuredOutputValidator');

// ---- Built-in local JSON auto-fixer ----------------------------------
//
// Applies a bounded set of heuristics that address the most common LLM
// output mistakes. Each step is safe when the input is already valid
// JSON (idempotent for well-formed input).

function jsonAutoFix(text) {
  if (typeof text !== 'string' || text.length === 0) return null;

  let candidate = text;

  // 1. Strip ```json ... ``` (or plain ``` ... ```) code fences.
  const fenceMatch = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) candidate = fenceMatch[1].trim();

  // 2. Narrow to the outer {...} or [...] block if there's surrounding prose.
  const firstBrace = candidate.indexOf('{');
  const lastBrace  = candidate.lastIndexOf('}');
  const firstBrack = candidate.indexOf('[');
  const lastBrack  = candidate.lastIndexOf(']');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    // Prefer object if it fully wraps the array too.
    if (firstBrack === -1 || firstBrace < firstBrack) {
      candidate = candidate.slice(firstBrace, lastBrace + 1);
    } else {
      candidate = candidate.slice(firstBrack, lastBrack + 1);
    }
  } else if (firstBrack !== -1 && lastBrack > firstBrack) {
    candidate = candidate.slice(firstBrack, lastBrack + 1);
  }

  // 3. Remove // line comments and /* block comments */. Be careful
  //    not to strip // inside quoted strings — walk the string and
  //    only strip when we're outside a quoted region.
  candidate = stripComments(candidate);

  // 4. Remove trailing commas before } or ].
  candidate = candidate.replace(/,(\s*[}\]])/g, '$1');

  // 5. Replace unquoted object keys with quoted ones.
  //    Match `{foo:` or `,foo:` where foo is a bareword (letters/digits/_).
  candidate = candidate.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');

  // 6. Convert single-quoted strings to double-quoted anywhere they
  //    appear (values, array elements). Walk the string so we don't
  //    touch apostrophes inside already-double-quoted strings.
  candidate = convertSingleQuotedStrings(candidate);

  try { return JSON.parse(candidate); }
  catch { return null; }
}

function convertSingleQuotedStrings(src) {
  let out = '';
  let i = 0;
  const N = src.length;
  while (i < N) {
    const ch = src[i];
    if (ch === '"') {
      // Copy a double-quoted string verbatim.
      out += ch; i++;
      while (i < N) {
        const c = src[i];
        out += c;
        if (c === '\\' && i + 1 < N) { out += src[i + 1]; i += 2; continue; }
        i++;
        if (c === '"') break;
      }
      continue;
    }
    if (ch === '\'') {
      // Collect a single-quoted string body.
      i++;
      let body = '';
      while (i < N) {
        const c = src[i];
        if (c === '\\' && i + 1 < N) { body += c + src[i + 1]; i += 2; continue; }
        if (c === '\'') { i++; break; }
        body += c; i++;
      }
      // Escape any embedded double quotes in the converted value.
      out += '"' + body.replace(/"/g, '\\"') + '"';
      continue;
    }
    out += ch; i++;
  }
  return out;
}

function stripComments(src) {
  let out = '';
  let i = 0;
  const N = src.length;
  let inString = false;
  let stringChar = null;
  while (i < N) {
    const ch = src[i];
    const next = i + 1 < N ? src[i + 1] : '';
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < N) { out += src[i + 1]; i += 2; continue; }
      if (ch === stringChar) { inString = false; stringChar = null; }
      i++;
      continue;
    }
    if (ch === '"' || ch === '\'') {
      inString = true; stringChar = ch;
      out += ch; i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < N && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < N && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// ---- Built-in re-ask strategy ---------------------------------------

function defaultBuildCorrection({ errors, schema, rawText }) {
  const errList = errors.slice(0, 5).map((e) => `- ${e}`).join('\n');
  const schemaSnippet = schema ? JSON.stringify(schema).slice(0, 500) : '(no schema available)';
  return `Your previous response could not be parsed as valid JSON matching the required schema. ` +
    `Errors:\n${errList}\n\nReturn ONLY a JSON object (no prose, no code fences) matching this schema:\n${schemaSnippet}\n\n` +
    (rawText ? `Your previous output was:\n${rawText.slice(0, 300)}` : '');
}

function defaultApplyCorrection(request, correctionText) {
  const messages = Array.isArray(request.messages) ? [...request.messages] : [];
  messages.push({ role: 'user', content: correctionText });
  return { ...request, messages };
}

// ---- Main middleware ------------------------------------------------

const BUILT_IN_STRATEGIES = Object.freeze(['json-fix', 're-ask']);

function structuredOutputRepair(options = {}) {
  const {
    schema           = null,
    schemaFrom       = null,
    validate         = validateBuiltIn,
    strategies       = ['json-fix', 're-ask'],
    maxLlmRetries    = 1,
    buildCorrection  = defaultBuildCorrection,
    applyCorrection  = defaultApplyCorrection,
    attachParsedAs   = 'parsed',
    onRepair         = null,
    onGiveUp         = null,
    onSuccess        = null,
  } = options;

  if (typeof validate !== 'function') {
    throw new Error('structuredOutputRepair: validate must be a function.');
  }
  if (!Array.isArray(strategies) || strategies.length === 0) {
    throw new Error('structuredOutputRepair: strategies must be a non-empty array.');
  }
  if (!Number.isInteger(maxLlmRetries) || maxLlmRetries < 0) {
    throw new Error(`structuredOutputRepair: maxLlmRetries must be a non-negative integer (got ${maxLlmRetries}).`);
  }
  for (const cb of [onRepair, onGiveUp, onSuccess]) {
    if (cb != null && typeof cb !== 'function') {
      throw new Error('structuredOutputRepair: callbacks must be functions or null.');
    }
  }

  // Normalize strategies: string names → built-in resolvers; objects
  // pass through as-is (assumed { name, apply }).
  const resolvedStrategies = strategies.map((s, i) => {
    if (typeof s === 'string') {
      if (!BUILT_IN_STRATEGIES.includes(s)) {
        throw new Error(`structuredOutputRepair: unknown built-in strategy "${s}" (allowed: ${BUILT_IN_STRATEGIES.join(', ')}).`);
      }
      return { name: s, builtIn: true };
    }
    if (s && typeof s === 'object' && typeof s.apply === 'function' && typeof s.name === 'string') {
      return { name: s.name, builtIn: false, apply: s.apply };
    }
    throw new Error(`structuredOutputRepair: strategies[${i}] must be a string or { name, apply } object.`);
  });

  const stats = {
    totalValidated:    0,
    validFirstTry:     0,
    repaired:          0,
    gaveUp:            0,
    skipped:           0,
    byStrategy:        {},
    llmRetries:        0,
  };
  for (const s of resolvedStrategies) stats.byStrategy[s.name] = 0;

  function callHook(hook, arg) {
    if (!hook) return;
    try { const r = hook(arg); if (r && typeof r.then === 'function') r.catch(() => {}); }
    catch { /* swallow */ }
  }

  function resolveSchema(ctx) {
    if (typeof schemaFrom === 'function') {
      const dyn = schemaFrom(ctx);
      if (dyn) return dyn;
    }
    if (ctx?.request?.responseSchema) return ctx.request.responseSchema;
    if (ctx?.request?.format && typeof ctx.request.format === 'object') return ctx.request.format;
    return schema;
  }

  function runValidate(obj, sch) {
    const errs = validate(obj, sch);
    if (Array.isArray(errs) && errs.length > 0) return { ok: false, errors: errs };
    if (errs && typeof errs === 'object' && !Array.isArray(errs) && errs.ok === false) {
      return { ok: false, errors: errs.errors ?? ['validation failed'] };
    }
    return { ok: true, errors: [] };
  }

  function extractInitial(result) {
    if (result?.data != null && typeof result.data === 'object') return result.data;
    if (typeof result?.text === 'string') return extractFromText(result.text);
    return null;
  }

  const mw = async (ctx, next) => {
    const sch = resolveSchema(ctx);
    if (!sch) { stats.skipped++; return next(); }

    const originalRequest = ctx.request;
    const result = await next();
    stats.totalValidated++;

    // Fast path: response parses + validates on first try.
    const parsed0 = extractInitial(result);
    if (parsed0 != null) {
      const v = runValidate(parsed0, sch);
      if (v.ok) {
        stats.validFirstTry++;
        if (attachParsedAs && result && typeof result === 'object' && result[attachParsedAs] === undefined) {
          result[attachParsedAs] = parsed0;
        }
        callHook(onSuccess, { attempts: 1, strategy: null, result });
        return result;
      }
    }

    // Repair loop — try each strategy in order.
    let lastErrors = parsed0 == null
      ? ['response did not contain parseable JSON']
      : runValidate(parsed0, sch).errors;
    let llmRetriesUsed = 0;

    for (const strat of resolvedStrategies) {
      let repaired = null;
      const rawText = typeof result?.text === 'string' ? result.text : null;

      if (strat.builtIn) {
        if (strat.name === 'json-fix') {
          if (rawText) repaired = jsonAutoFix(rawText);
        } else if (strat.name === 're-ask') {
          if (llmRetriesUsed >= maxLlmRetries) continue;   // budget exhausted
          const correction = buildCorrection({ errors: lastErrors, schema: sch, rawText });
          ctx.request = applyCorrection(originalRequest, correction);
          llmRetriesUsed++;
          stats.llmRetries++;
          const retryResult = await next();
          repaired = extractInitial(retryResult);
          // If re-ask succeeded, propagate the retry result so callers
          // see the corrected text/data — not just the parsed object.
          if (repaired != null) {
            const v = runValidate(repaired, sch);
            if (v.ok) {
              stats.repaired++;
              stats.byStrategy[strat.name]++;
              if (attachParsedAs && retryResult && typeof retryResult === 'object'
                  && retryResult[attachParsedAs] === undefined) {
                retryResult[attachParsedAs] = repaired;
              }
              ctx.request = originalRequest;
              callHook(onRepair, { strategy: strat.name, from: parsed0, to: repaired, errors: lastErrors });
              callHook(onSuccess, { attempts: llmRetriesUsed + 1, strategy: strat.name, result: retryResult });
              return retryResult;
            }
            lastErrors = v.errors;
          }
          continue;
        }
      } else {
        try { repaired = await strat.apply(rawText, { errors: lastErrors, schema: sch, parsed: parsed0 }); }
        catch { repaired = null; }
      }

      if (repaired != null) {
        const v = runValidate(repaired, sch);
        if (v.ok) {
          stats.repaired++;
          stats.byStrategy[strat.name]++;
          if (attachParsedAs && result && typeof result === 'object' && result[attachParsedAs] === undefined) {
            result[attachParsedAs] = repaired;
          }
          ctx.request = originalRequest;
          callHook(onRepair, { strategy: strat.name, from: parsed0, to: repaired, errors: lastErrors });
          callHook(onSuccess, { attempts: 1, strategy: strat.name, result });
          return result;
        }
        lastErrors = v.errors;
      }
    }

    // Exhausted — throw the standard error class.
    stats.gaveUp++;
    ctx.request = originalRequest;
    const rawText = typeof result?.text === 'string' ? result.text : null;
    callHook(onGiveUp, { errors: lastErrors, strategiesTried: resolvedStrategies.map((s) => s.name), rawText });
    throw new StructuredOutputInvalidError({
      errors:   lastErrors,
      rawText,
      schema:   sch,
      attempts: 1 + llmRetriesUsed,
    });
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.totalValidated = stats.validFirstTry = stats.repaired = 0;
    stats.gaveUp = stats.skipped = stats.llmRetries = 0;
    for (const k of Object.keys(stats.byStrategy)) stats.byStrategy[k] = 0;
  };
  mw.asMcpResource = () => ({
    uri: 'config://structured-output-repair',
    name: 'Structured output repair',
    description: 'Multi-strategy auto-recovery for JSON-schema violations. Local fixes tried before LLM re-ask.',
    mimeType: 'application/json',
    handler: () => ({
      strategies:    resolvedStrategies.map((s) => s.name),
      maxLlmRetries,
      hasStaticSchema: !!schema,
      hasSchemaFrom:   typeof schemaFrom === 'function',
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  structuredOutputRepair,
  jsonAutoFix,
  BUILT_IN_STRATEGIES,
  // Re-export for convenience so users don't need two imports.
  StructuredOutputInvalidError,
};
