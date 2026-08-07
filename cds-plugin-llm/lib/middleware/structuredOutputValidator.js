// Structured output validator — post-response JSON schema check.
//
// Rejects (or auto-retries) LLM responses that don't match a declared
// JSON Schema. Complements 1.34 `schemas` (which ships pre-built schemas
// for common business objects) by enforcing them at the chain level
// instead of trusting the model to obey `format:`.
//
//   const { structuredOutputValidator, schemas } = require('@saptarishi/cds-plugin-llm');
//
//   const validator = structuredOutputValidator({
//     schemaFrom: (ctx) => ctx.request.format,   // pick up per-request schema
//     onInvalid:  'retry',                        // 'throw' | 'retry'
//     maxRetries: 1,
//   });
//   llm.use(validator);
//
//   const res = await llm.chat({ messages: [...], format: schemas.Invoice });
//   //  → res.parsed is the validated object; throws StructuredOutputInvalidError otherwise
//
// On invalid: onInvalid === 'throw' surfaces StructuredOutputInvalidError
// immediately. onInvalid === 'retry' appends a corrective user message
// ("your previous response failed schema validation: ...") and re-invokes
// next(), up to maxRetries times.
//
// Streams (1.72+): defers validation to onComplete. No retry possible for
// an already-streamed response; increments stats.invalidStreams.

const { LLMError } = require('../errors');

// ---- Error class ------------------------------------------------------

class StructuredOutputInvalidError extends LLMError {
  constructor({ errors, rawText, schema, attempts }) {
    const errList = Array.isArray(errors) ? errors.slice(0, 3).join('; ') : String(errors);
    super(`structuredOutputValidator: response failed schema validation after ${attempts ?? 1} attempt(s). Errors: ${errList}`, 'STRUCTURED_OUTPUT_INVALID');
    this.errors  = errors;
    this.rawText = rawText;
    this.schema  = schema;
    this.attempts = attempts ?? 1;
  }
}

// ---- Built-in minimal validator ---------------------------------------
// Dep-free. Handles the subset used by the shipped `schemas` module:
// type / required / properties / items / enum / additionalProperties.
// Users who need full JSON Schema draft-7 can pass a Zod / Ajv adapter
// via the `validate` option.

function jsTypeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function validateBuiltIn(obj, schema, path = '$') {
  const errors = [];
  if (!schema || typeof schema !== 'object') return errors;

  if (schema.type) {
    const t = jsTypeOf(obj);
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    // Integer satisfies number.
    const match = expected.some((e) => e === t || (e === 'number' && t === 'integer'));
    if (!match) errors.push(`${path}: expected type ${expected.join('|')} but got ${t}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(obj)) {
    errors.push(`${path}: value ${JSON.stringify(obj)} not in enum [${schema.enum.map((e) => JSON.stringify(e)).join(', ')}]`);
  }
  if (schema.type === 'object' && obj && typeof obj === 'object' && !Array.isArray(obj)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!(key in obj)) errors.push(`${path}: missing required field "${key}"`);
      }
    }
    if (schema.properties && typeof schema.properties === 'object') {
      for (const [key, subSchema] of Object.entries(schema.properties)) {
        if (key in obj) errors.push(...validateBuiltIn(obj[key], subSchema, `${path}.${key}`));
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      const known = new Set(Object.keys(schema.properties));
      for (const key of Object.keys(obj)) {
        if (!known.has(key)) errors.push(`${path}: unexpected additional property "${key}"`);
      }
    }
  }
  if (schema.type === 'array' && Array.isArray(obj) && schema.items) {
    obj.forEach((el, i) => {
      errors.push(...validateBuiltIn(el, schema.items, `${path}[${i}]`));
    });
  }
  return errors;
}

// ---- JSON extraction --------------------------------------------------

function extractFromText(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  // 1. Straight parse
  try { return JSON.parse(text); } catch { /* fall through */ }
  // 2. ```json ... ``` code block
  const block = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (block) {
    try { return JSON.parse(block[1].trim()); } catch { /* fall through */ }
  }
  // 3. First '{' → matching outer '}' — greedy, then narrow.
  const firstBrace = text.indexOf('{');
  const lastBrace  = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try { return JSON.parse(text.slice(firstBrace, lastBrace + 1)); } catch { /* fall through */ }
  }
  // 4. First '[' → matching outer ']'
  const firstBr = text.indexOf('[');
  const lastBr  = text.lastIndexOf(']');
  if (firstBr !== -1 && lastBr > firstBr) {
    try { return JSON.parse(text.slice(firstBr, lastBr + 1)); } catch { /* fall through */ }
  }
  return null;
}

function defaultExtractJson(result) {
  // 1. Provider already parsed via `format:` → result.data
  if (result && typeof result === 'object' && result.data != null && typeof result.data === 'object') {
    return result.data;
  }
  // 2. Extract from result.text
  if (result && typeof result.text === 'string') return extractFromText(result.text);
  return null;
}

// ---- Correction prompt ------------------------------------------------

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

// ---- Main middleware --------------------------------------------------

function structuredOutputValidator(options = {}) {
  const {
    schema           = null,
    schemaFrom       = null,
    extractJson      = defaultExtractJson,
    validate         = validateBuiltIn,
    onInvalid        = 'throw',
    maxRetries       = 1,
    buildCorrection  = defaultBuildCorrection,
    applyCorrection  = defaultApplyCorrection,
    captureStreams   = true,
    attachParsedAs   = 'parsed',
  } = options;

  if (onInvalid !== 'throw' && onInvalid !== 'retry') {
    throw new Error(`structuredOutputValidator: onInvalid must be 'throw' or 'retry' (got ${JSON.stringify(onInvalid)}).`);
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error(`structuredOutputValidator: maxRetries must be a non-negative integer (got ${maxRetries}).`);
  }
  if (typeof validate !== 'function') {
    throw new Error('structuredOutputValidator: validate must be a function (obj, schema) => string[].');
  }
  if (typeof extractJson !== 'function') {
    throw new Error('structuredOutputValidator: extractJson must be a function (result) => object|null.');
  }

  const stats = {
    totalValidated:  0,
    valid:           0,
    invalid:         0,
    retries:         0,
    retriesGivenUp: 0,
    invalidStreams:  0,
    skipped:         0,
  };

  function resolveSchema(ctx) {
    if (typeof schemaFrom === 'function') {
      const dyn = schemaFrom(ctx);
      if (dyn) return dyn;
    }
    // Convention: `format:` on the request is a JSON Schema (see lib/schemas.js).
    if (ctx?.request?.responseSchema) return ctx.request.responseSchema;
    if (ctx?.request?.format && typeof ctx.request.format === 'object') return ctx.request.format;
    return schema;
  }

  function runValidate(result, sch) {
    const obj = extractJson(result);
    if (obj == null) {
      return { ok: false, obj: null, errors: ['response did not contain parseable JSON'] };
    }
    const errs = validate(obj, sch);
    if (Array.isArray(errs) && errs.length > 0) {
      return { ok: false, obj, errors: errs };
    }
    // Also accept {ok, errors} shape from pluggable validators.
    if (errs && typeof errs === 'object' && !Array.isArray(errs)) {
      if (errs.ok === false) return { ok: false, obj, errors: errs.errors ?? ['validation failed'] };
    }
    return { ok: true, obj, errors: [] };
  }

  const mw = async (ctx, next) => {
    const sch = resolveSchema(ctx);
    if (!sch) {
      stats.skipped++;
      return next();
    }

    const { hasStreamCompletion } = require('../streamCompletion');
    const originalRequest = ctx.request;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const result = await next();

      // Streaming path — defer validation, no retry.
      if (captureStreams && hasStreamCompletion(result)) {
        result.onComplete((info) => {
          const doneChunk = info?.doneChunk;
          if (!info?.ok || !doneChunk) return;
          stats.totalValidated++;
          const { ok, errors } = runValidate(doneChunk, sch);
          if (ok) stats.valid++;
          else {
            stats.invalid++;
            stats.invalidStreams++;
          }
        });
        return result;
      }

      stats.totalValidated++;
      const { ok, obj, errors } = runValidate(result, sch);

      if (ok) {
        stats.valid++;
        if (attachParsedAs && result && typeof result === 'object' && result[attachParsedAs] === undefined) {
          result[attachParsedAs] = obj;
        }
        ctx.request = originalRequest;
        return result;
      }

      stats.invalid++;

      if (onInvalid === 'throw' || attempt === maxRetries) {
        ctx.request = originalRequest;
        if (onInvalid === 'retry') stats.retriesGivenUp++;
        const rawText = typeof result?.text === 'string' ? result.text : null;
        throw new StructuredOutputInvalidError({
          errors, rawText, schema: sch, attempts: attempt + 1,
        });
      }

      // Retry: mutate request with corrective guidance.
      const rawText = typeof result?.text === 'string' ? result.text : null;
      const correction = buildCorrection({ errors, schema: sch, rawText });
      ctx.request = applyCorrection(originalRequest, correction);
      stats.retries++;
    }

    // Unreachable — the loop always returns or throws.
    ctx.request = originalRequest;
    throw new Error('structuredOutputValidator: exhausted attempts without result');
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.totalValidated = stats.valid = stats.invalid = 0;
    stats.retries = stats.retriesGivenUp = stats.invalidStreams = stats.skipped = 0;
  };
  mw.asMcpResource = () => ({
    uri: 'config://structured-output-validator',
    name: 'Structured output validator',
    description: 'JSON Schema validation of LLM responses. Counters + configuration.',
    mimeType: 'application/json',
    handler: () => ({
      onInvalid,
      maxRetries,
      captureStreams,
      hasStaticSchema: !!schema,
      hasSchemaFrom:   typeof schemaFrom === 'function',
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  structuredOutputValidator,
  StructuredOutputInvalidError,
  // Exposed for tests + advanced composition.
  validateBuiltIn,
  extractFromText,
};
