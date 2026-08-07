// Guardrails middleware — pluggable input + output filters for llm.use().
//
//   const { guardrails, filters } = require('@saptarishi/cds-plugin-llm');
//   llm.use(guardrails({
//     inputFilters:  [ filters.blocklist(['password']), filters.pii({ redact: true }) ],
//     outputFilters: [ filters.pii({ redact: true }) ],
//     onBlock: (info) => cds.log('llm:guardrails').warn(info),
//   }));
//
// Input filters see `{ system, messages }`; output filters see the chat
// response payload. Each returns one of:
//
//   { action: 'allow' }
//   { action: 'block', reason: '...' }
//   { action: 'redact', payload: <modified> }
//
// On block, the middleware throws a `GuardrailBlockedError` and the request
// never reaches the provider (input) or returns to the caller (output).
// Redactions mutate the payload for downstream middleware / the provider
// but the ORIGINAL caller's request object is untouched.
//
// Streams: input filters run before the stream is opened, but per-chunk
// output filtering isn't in scope for this release. Callers who need
// stream-side moderation should collect the stream and filter at the end
// or wire their own middleware.

const { LLMError } = require('../errors');

class GuardrailBlockedError extends LLMError {
  constructor(reason, details = {}) {
    super(`guardrail blocked: ${reason}`, 'GUARDRAIL_BLOCKED');
    this.reason = reason;
    this.details = details;
  }
}

function guardrails(options = {}) {
  const {
    inputFilters = [],
    outputFilters = [],
    onBlock = null,
    onRedact = null,
  } = options;

  if (!Array.isArray(inputFilters))  throw new Error('guardrails: inputFilters must be an array');
  if (!Array.isArray(outputFilters)) throw new Error('guardrails: outputFilters must be an array');
  for (const [i, f] of [...inputFilters, ...outputFilters].entries()) {
    if (typeof f !== 'function') {
      throw new Error(`guardrails: filter[${i}] must be a function (payload, ctx) => Promise<{action}>`);
    }
  }

  const stats = { inputBlocks: 0, outputBlocks: 0, inputRedacts: 0, outputRedacts: 0 };

  const mw = async (ctx, next) => {
    // ---- INPUT filters --------------------------------------------------
    if (inputFilters.length > 0 && (ctx.method === 'chat' || ctx.method === 'stream')) {
      let payload = { system: ctx.request.system, messages: ctx.request.messages };
      for (const [i, filter] of inputFilters.entries()) {
        const verdict = await filter(payload, ctx);
        if (!verdict) continue; // undefined/null → allow
        if (verdict.action === 'block') {
          stats.inputBlocks++;
          if (onBlock) {
            try { await onBlock({ stage: 'input', filterIndex: i, reason: verdict.reason, ctx }); }
            catch { /* swallow */ }
          }
          throw new GuardrailBlockedError(verdict.reason ?? 'input blocked', { stage: 'input', filterIndex: i });
        }
        if (verdict.action === 'redact' && verdict.payload) {
          payload = verdict.payload;
          stats.inputRedacts++;
          if (onRedact) {
            try { await onRedact({ stage: 'input', filterIndex: i, ctx }); }
            catch { /* swallow */ }
          }
        }
      }
      // Mirror the redacted payload back to the ctx.request so downstream
      // middleware / the provider both see the scrubbed version.
      ctx.request.system = payload.system;
      ctx.request.messages = payload.messages;
    }

    const result = await next();

    // ---- OUTPUT filters -------------------------------------------------
    if (outputFilters.length > 0 && result && ctx.method === 'chat') {
      let payload = result;
      for (const [i, filter] of outputFilters.entries()) {
        const verdict = await filter(payload, ctx);
        if (!verdict) continue;
        if (verdict.action === 'block') {
          stats.outputBlocks++;
          if (onBlock) {
            try { await onBlock({ stage: 'output', filterIndex: i, reason: verdict.reason, ctx }); }
            catch { /* swallow */ }
          }
          throw new GuardrailBlockedError(verdict.reason ?? 'output blocked', { stage: 'output', filterIndex: i });
        }
        if (verdict.action === 'redact' && verdict.payload) {
          payload = verdict.payload;
          stats.outputRedacts++;
          if (onRedact) {
            try { await onRedact({ stage: 'output', filterIndex: i, ctx }); }
            catch { /* swallow */ }
          }
        }
      }
      return payload;
    }
    return result;
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.inputBlocks = 0;
    stats.outputBlocks = 0;
    stats.inputRedacts = 0;
    stats.outputRedacts = 0;
  };
  // Ready-to-register MCP resource — matches the pattern used by
  // costBudget / responseCache / promptInjectionGuard / usageMetering.
  // Consumers wire this into an MCPServer directly.
  mw.asMcpResource = () => ({
    uri: 'config://guardrails',
    name: 'Guardrails input/output filters',
    description: 'Block + redact counters across input + output filter stages.',
    mimeType: 'application/json',
    handler: () => ({
      inputBlocks:   stats.inputBlocks,
      outputBlocks:  stats.outputBlocks,
      inputRedacts:  stats.inputRedacts,
      outputRedacts: stats.outputRedacts,
      inputFilters:  inputFilters.length,
      outputFilters: outputFilters.length,
    }),
  });
  return mw;
}

module.exports = { guardrails, GuardrailBlockedError };
