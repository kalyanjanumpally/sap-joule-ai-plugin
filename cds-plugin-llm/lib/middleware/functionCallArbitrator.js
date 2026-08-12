// Function-call arbitrator. Policy + validation layer for LLM tool
// calls. Each shipped provider already normalizes tool schemas to
// `{ name, description?, input_schema }` on outbound and tool-call
// responses to `{ id, name, input }` on inbound — this middleware
// sits ON TOP to enforce:
//
//   * Registered-tool allowlist (reject calls to unknown tools)
//   * Schema validation of tool inputs (catch missing / bad-typed args)
//   * Policy on invalid calls (throw / strip / log)
//   * Observability (per-tool call counts + invalid-reason breakdown)
//   * Cross-provider tool-shape normalization on outbound
//     (`parameters` → `input_schema`, `functionDeclarations` unwrap)
//
//   const { functionCallArbitrator } = require('@saptarishi/cds-plugin-llm');
//
//   llm.use(functionCallArbitrator({
//     tools: [
//       {
//         name: 'lookup_customer',
//         description: 'Look up a customer by ID',
//         input_schema: {
//           type: 'object',
//           required: ['customerId'],
//           properties: { customerId: { type: 'string' } },
//         },
//       },
//     ],
//     onInvalid:        'strip',      // 'throw' | 'strip' | 'log'
//     allowUnregistered: false,
//     onCall: (i) => cds.log('llm:tools').info('called', i),
//   }));
//
// Placement: INSIDE prompt-safety layers (guardrails, promptInjection)
// so those still guard the raw text; OUTSIDE the tool runner so the
// runner only ever sees validated + allowlisted calls.

const { LLMError } = require('../errors');
const { validateBuiltIn } = require('./structuredOutputValidator');

class InvalidToolCallError extends LLMError {
  constructor({ callId, name, errors, allowUnregistered }) {
    super(
      `functionCallArbitrator: tool call ${callId ? `[${callId}] ` : ''}"${name}" failed validation: ${errors.slice(0, 3).join('; ')}`,
      'INVALID_TOOL_CALL',
    );
    this.callId = callId;
    this.name   = name;
    this.errors = errors;
    this.allowUnregistered = allowUnregistered;
  }
}

// ---- Outbound normalization -----------------------------------------

// Accepts any of three canonical forms and returns the Anthropic-style
// { name, description?, input_schema } shape used by all our shipped
// providers:
//
//   1. { name, description?, input_schema }          (Anthropic — canonical)
//   2. { name, description?, parameters }            (OpenAI)
//   3. { functionDeclarations: [{ name, parameters }, ...] }   (Gemini)
function normalizeToolShape(tool) {
  if (!tool || typeof tool !== 'object') return null;
  if (Array.isArray(tool.functionDeclarations)) {
    return tool.functionDeclarations.map(normalizeToolShape).filter(Boolean);
  }
  if (typeof tool.name !== 'string') return null;
  const out = { name: tool.name };
  if (typeof tool.description === 'string') out.description = tool.description;
  const schema = tool.input_schema ?? tool.parameters ?? tool.schema ?? null;
  if (schema && typeof schema === 'object') out.input_schema = schema;
  return out;
}

function normalizeToolList(tools) {
  if (!Array.isArray(tools)) return tools;
  const flat = [];
  for (const t of tools) {
    const norm = normalizeToolShape(t);
    if (norm == null) continue;
    if (Array.isArray(norm)) flat.push(...norm);
    else flat.push(norm);
  }
  return flat;
}

// ---- Middleware ----------------------------------------------------

function functionCallArbitrator(options = {}) {
  const {
    tools              = [],
    onInvalid          = 'strip',        // 'throw' | 'strip' | 'log'
    allowUnregistered  = false,
    normalizeOutbound  = true,
    validateCalls      = true,
    onCall             = null,
    onInvalidCall      = null,
    onError            = null,
    validator          = validateBuiltIn,
  } = options;

  if (!Array.isArray(tools)) {
    throw new Error('functionCallArbitrator: tools must be an array.');
  }
  const registry = new Map();
  for (let i = 0; i < tools.length; i++) {
    const t = tools[i];
    if (!t || typeof t !== 'object' || typeof t.name !== 'string') {
      throw new Error(`functionCallArbitrator: tools[${i}] must be { name: string, ... }.`);
    }
    if (registry.has(t.name)) {
      throw new Error(`functionCallArbitrator: duplicate tool name "${t.name}".`);
    }
    registry.set(t.name, normalizeToolShape(t));
  }
  if (!['throw', 'strip', 'log'].includes(onInvalid)) {
    throw new Error(`functionCallArbitrator: onInvalid must be 'throw' | 'strip' | 'log' (got ${JSON.stringify(onInvalid)}).`);
  }
  if (typeof validator !== 'function') {
    throw new Error('functionCallArbitrator: validator must be a function.');
  }
  for (const cb of [onCall, onInvalidCall, onError]) {
    if (cb != null && typeof cb !== 'function') {
      throw new Error('functionCallArbitrator: callbacks must be functions or null.');
    }
  }

  const stats = {
    totalCalls:            0,
    outboundNormalized:    0,
    inboundValidated:      0,
    validCalls:            0,
    invalidCalls:          0,
    strippedCalls:         0,
    thrownCalls:           0,
    loggedCalls:           0,
    callsByTool:           {},
    invalidByTool:         {},
    invalidReasonCounts:   {
      'unknown-tool':      0,
      'schema-violation':  0,
      'not-an-object':     0,
    },
  };

  function callHook(hook, arg) {
    if (!hook) return;
    try { const r = hook(arg); if (r && typeof r.then === 'function') r.catch(() => {}); }
    catch { /* swallow */ }
  }

  function validateOneCall(call) {
    if (!call || typeof call !== 'object' || typeof call.name !== 'string') {
      return { ok: false, errors: ['tool call is not an object with a name'], reason: 'not-an-object' };
    }
    const tool = registry.get(call.name);
    if (!tool) {
      if (allowUnregistered) return { ok: true, errors: [] };
      return { ok: false, errors: [`unknown tool "${call.name}"`], reason: 'unknown-tool' };
    }
    if (!tool.input_schema) {
      // No schema to validate against — accept.
      return { ok: true, errors: [] };
    }
    const errs = validator(call.input ?? {}, tool.input_schema);
    if (Array.isArray(errs) && errs.length > 0) {
      return { ok: false, errors: errs, reason: 'schema-violation' };
    }
    if (errs && typeof errs === 'object' && !Array.isArray(errs) && errs.ok === false) {
      return { ok: false, errors: errs.errors ?? ['validation failed'], reason: 'schema-violation' };
    }
    return { ok: true, errors: [] };
  }

  const mw = async (ctx, next) => {
    stats.totalCalls++;

    // ---- Outbound normalization --------------------------------
    const originalRequest = ctx.request;
    if (normalizeOutbound && Array.isArray(originalRequest?.tools)) {
      const normalized = normalizeToolList(originalRequest.tools);
      if (normalized !== originalRequest.tools) {
        stats.outboundNormalized++;
        ctx.request = { ...originalRequest, tools: normalized };
      }
    }

    // ---- Downstream call ---------------------------------------
    let result;
    try {
      result = await next();
    } finally {
      ctx.request = originalRequest;
    }

    // ---- Inbound validation ------------------------------------
    if (!validateCalls || !result || !Array.isArray(result.toolCalls) || result.toolCalls.length === 0) {
      return result;
    }

    const keptCalls = [];
    for (const call of result.toolCalls) {
      stats.inboundValidated++;
      stats.callsByTool[call?.name ?? '<none>'] = (stats.callsByTool[call?.name ?? '<none>'] ?? 0) + 1;
      const check = validateOneCall(call);
      if (check.ok) {
        stats.validCalls++;
        callHook(onCall, { call, valid: true });
        keptCalls.push(call);
        continue;
      }
      stats.invalidCalls++;
      stats.invalidByTool[call?.name ?? '<none>'] = (stats.invalidByTool[call?.name ?? '<none>'] ?? 0) + 1;
      stats.invalidReasonCounts[check.reason] = (stats.invalidReasonCounts[check.reason] ?? 0) + 1;
      callHook(onInvalidCall, {
        call, errors: check.errors, reason: check.reason,
      });

      if (onInvalid === 'throw') {
        stats.thrownCalls++;
        throw new InvalidToolCallError({
          callId: call?.id, name: call?.name,
          errors: check.errors, allowUnregistered,
        });
      }
      if (onInvalid === 'strip') {
        stats.strippedCalls++;
        // Drop from output.
        continue;
      }
      if (onInvalid === 'log') {
        stats.loggedCalls++;
        // Keep but tag.
        keptCalls.push({ ...call, invalid: true, invalidErrors: check.errors });
      }
    }

    if (keptCalls.length !== result.toolCalls.length) {
      // Return a shallow clone so downstream doesn't mutate the caller's original.
      return { ...result, toolCalls: keptCalls };
    }
    // If we only annotated (log mode), still return the shallow clone
    // if we mutated any entries.
    if (onInvalid === 'log' && keptCalls.some((c) => c.invalid)) {
      return { ...result, toolCalls: keptCalls };
    }
    return result;
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.totalCalls = stats.outboundNormalized = stats.inboundValidated = 0;
    stats.validCalls = stats.invalidCalls = 0;
    stats.strippedCalls = stats.thrownCalls = stats.loggedCalls = 0;
    for (const k of Object.keys(stats.callsByTool)) delete stats.callsByTool[k];
    for (const k of Object.keys(stats.invalidByTool)) delete stats.invalidByTool[k];
    for (const k of Object.keys(stats.invalidReasonCounts)) stats.invalidReasonCounts[k] = 0;
  };
  mw.listTools = () => Array.from(registry.keys());
  mw.getTool   = (name) => registry.get(name) ?? null;
  mw.invalidRate = () => {
    return stats.inboundValidated === 0 ? 0 : stats.invalidCalls / stats.inboundValidated;
  };
  mw.asMcpResource = () => ({
    uri: 'config://function-call-arbitrator',
    name: 'Function-call arbitrator',
    description: 'Policy + validation layer for LLM tool calls. Allowlist, schema validation, invalid-call policy.',
    mimeType: 'application/json',
    handler: () => ({
      registeredTools:   Array.from(registry.keys()),
      onInvalid,
      allowUnregistered,
      normalizeOutbound,
      validateCalls,
      invalidRate: mw.invalidRate(),
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  functionCallArbitrator,
  InvalidToolCallError,
  // Exposed for tests + composition.
  normalizeToolShape,
  normalizeToolList,
};
