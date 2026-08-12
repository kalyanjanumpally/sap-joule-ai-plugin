// Auto-tool-chain. When the model returns tool_calls in a response,
// automatically run the tools, feed results back, re-invoke the chain,
// and loop until the model returns a final answer (no tool_calls) —
// or we hit a safety cap. Frees callers from writing the same
// tool-invocation-loop boilerplate for every agentic workflow.
//
// Composes with:
//   * `functionCallArbitrator` (2.18) — allowlist + schema validation
//     OUTSIDE this middleware so only vetted tool calls reach the chain
//   * `runTools` / `streamTools` / `Agent` (1.x) — the runner already
//     supports a single tool invocation; this primitive handles the
//     multi-step LOOP internally
//
//   const { autoToolChain, functionCallArbitrator } = require('@saptarishi/cds-plugin-llm');
//
//   llm.use(functionCallArbitrator({ tools: [...], onInvalid: 'strip' }));
//   llm.use(autoToolChain({
//     handlers: {
//       lookup_customer: async (input) => ({ id: input.id, name: 'Alice' }),
//       send_email:      async (input) => ({ sent: true }),
//     },
//     maxDepth: 10,
//     onToolCall:      (i) => cds.log('llm:chain').info('tool', i),
//     onCycleDetected: (i) => cds.log('llm:chain').warn('cycle', i),
//   }));
//
// Placement: OUTSIDE structuredOutputRepair (repair should operate on
// the FINAL response, not intermediate tool-request responses).
// INSIDE prompt-safety layers (guardrails, promptInjectionGuard) so
// they only see the initial user prompt, not the tool-loop internals.

const { LLMError } = require('../errors');

class UnknownToolError extends LLMError {
  constructor({ name, availableTools }) {
    super(
      `autoToolChain: unknown tool "${name}" (available: ${availableTools.join(', ') || '<none>'}).`,
      'UNKNOWN_TOOL',
    );
    this.toolName        = name;
    this.availableTools  = availableTools;
  }
}

class MaxDepthExceededError extends LLMError {
  constructor({ depth, maxDepth }) {
    super(
      `autoToolChain: max chain depth exceeded (${depth} > ${maxDepth}). Increase maxDepth or fix looping tools.`,
      'MAX_TOOL_DEPTH_EXCEEDED',
    );
    this.depth     = depth;
    this.maxDepth  = maxDepth;
  }
}

class ToolChainCycleError extends LLMError {
  constructor({ toolName, inputJson, depth }) {
    super(
      `autoToolChain: cycle detected — tool "${toolName}" called with same input at depth ${depth}.`,
      'TOOL_CHAIN_CYCLE',
    );
    this.toolName   = toolName;
    this.inputJson  = inputJson;
    this.depth      = depth;
  }
}

// Stable serialization for cycle detection — same shape as
// requestCoalescer's stableStringify.
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  const parts = [];
  for (const k of keys) {
    if (v[k] === undefined || typeof v[k] === 'function') continue;
    parts.push(JSON.stringify(k) + ':' + stableStringify(v[k]));
  }
  return '{' + parts.join(',') + '}';
}

function autoToolChain(options = {}) {
  const {
    handlers            = {},
    maxDepth            = 10,
    detectCycles        = true,
    handleUnknownTool   = 'throw',    // 'throw' | 'skip' | 'error-back'
    onToolCall          = null,
    onToolError         = null,
    onDepthExceeded     = null,
    onCycleDetected     = null,
    onChainComplete     = null,
    now                 = () => Date.now(),
  } = options;

  if (handlers == null || typeof handlers !== 'object') {
    throw new Error('autoToolChain: handlers must be a { toolName: async (input, ctx) => result } map.');
  }
  for (const [name, fn] of Object.entries(handlers)) {
    if (typeof fn !== 'function') {
      throw new Error(`autoToolChain: handlers.${name} must be a function.`);
    }
  }
  if (!Number.isInteger(maxDepth) || maxDepth < 1) {
    throw new Error(`autoToolChain: maxDepth must be a positive integer (got ${maxDepth}).`);
  }
  if (!['throw', 'skip', 'error-back'].includes(handleUnknownTool)) {
    throw new Error(`autoToolChain: handleUnknownTool must be 'throw' | 'skip' | 'error-back' (got ${JSON.stringify(handleUnknownTool)}).`);
  }
  for (const cb of [onToolCall, onToolError, onDepthExceeded, onCycleDetected, onChainComplete]) {
    if (cb != null && typeof cb !== 'function') {
      throw new Error('autoToolChain: callbacks must be functions or null.');
    }
  }

  const handlerNames = Object.keys(handlers);

  const stats = {
    totalCalls:          0,
    chainsStarted:       0,
    chainsCompleted:     0,
    depthExceededCount:  0,
    cyclesDetectedCount: 0,
    toolCallsExecuted:   0,
    toolErrors:          0,
    unknownToolCalls:    0,
    maxObservedDepth:    0,
    totalDepth:          0,     // for avgDepth
    lastChainDepth:      null,
  };

  function callHook(hook, arg) {
    if (!hook) return;
    try { const r = hook(arg); if (r && typeof r.then === 'function') r.catch(() => {}); }
    catch { /* swallow */ }
  }

  // Run a single tool call. Returns the tool result content (stringified)
  // or throws for the 'throw' unknown-tool policy.
  async function runOneToolCall(call, ctx) {
    stats.toolCallsExecuted++;
    const handler = handlers[call.name];
    if (!handler) {
      stats.unknownToolCalls++;
      if (handleUnknownTool === 'throw') {
        throw new UnknownToolError({ name: call.name, availableTools: handlerNames });
      }
      if (handleUnknownTool === 'skip') {
        return null;   // signal to drop this call
      }
      // 'error-back' — return an error content so the model can recover.
      const errPayload = { error: `unknown tool: ${call.name}` };
      return { role: 'tool', tool_call_id: call.id, content: JSON.stringify(errPayload) };
    }
    let result;
    try {
      result = await handler(call.input, ctx);
    } catch (err) {
      stats.toolErrors++;
      callHook(onToolError, { toolName: call.name, callId: call.id, input: call.input, error: err });
      // Send the error back to the model so it can decide to give up or
      // try a different approach. This is a common pattern for agentic
      // loops and matches OpenAI's / Anthropic's expected shape.
      return { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: err?.message ?? String(err) }) };
    }
    const content = typeof result === 'string' ? result : JSON.stringify(result);
    return { role: 'tool', tool_call_id: call.id, content };
  }

  const mw = async (ctx, next) => {
    stats.totalCalls++;
    const originalRequest = ctx.request;

    // Initial call.
    let result = await next();

    // No tool calls? Passthrough.
    if (!result || !Array.isArray(result.toolCalls) || result.toolCalls.length === 0) {
      return result;
    }

    // We're entering a chain — track state.
    stats.chainsStarted++;
    let depth = 0;
    let messages = Array.isArray(originalRequest?.messages) ? originalRequest.messages.slice() : [];

    // Track last (toolName, inputJson) pair for cycle detection.
    let previousInvocations = new Map();   // toolName → set of inputJsons seen

    try {
      while (Array.isArray(result.toolCalls) && result.toolCalls.length > 0) {
        depth++;
        if (depth > maxDepth) {
          stats.depthExceededCount++;
          callHook(onDepthExceeded, { depth, maxDepth });
          throw new MaxDepthExceededError({ depth, maxDepth });
        }

        // Append the assistant's tool_use turn to the message stack.
        const assistantTurn = {
          role: 'assistant',
          content: typeof result.text === 'string' && result.text.length > 0 ? result.text : null,
          toolCalls: result.toolCalls,
        };
        messages.push(assistantTurn);

        // Cycle detection: for each pending tool call, check if we've
        // seen the same (name, inputJson) pair before.
        if (detectCycles) {
          for (const call of result.toolCalls) {
            const inputJson = stableStringify(call.input);
            const seen = previousInvocations.get(call.name);
            if (seen && seen.has(inputJson)) {
              stats.cyclesDetectedCount++;
              callHook(onCycleDetected, { toolName: call.name, inputJson, depth });
              throw new ToolChainCycleError({ toolName: call.name, inputJson, depth });
            }
          }
        }

        // Run tools + append their results to messages.
        for (const call of result.toolCalls) {
          callHook(onToolCall, { toolName: call.name, callId: call.id, input: call.input, depth });
          const toolMessage = await runOneToolCall(call, ctx);
          if (toolMessage != null) {
            messages.push(toolMessage);
          }
          if (detectCycles) {
            const inputJson = stableStringify(call.input);
            let seen = previousInvocations.get(call.name);
            if (!seen) { seen = new Set(); previousInvocations.set(call.name, seen); }
            seen.add(inputJson);
          }
        }

        // Re-invoke the chain with the updated message stack.
        ctx.request = { ...originalRequest, messages };
        result = await next();
      }

      // Chain complete.
      stats.chainsCompleted++;
      if (depth > stats.maxObservedDepth) stats.maxObservedDepth = depth;
      stats.totalDepth += depth;
      stats.lastChainDepth = depth;
      callHook(onChainComplete, { depth, finalResult: result });
      return result;
    } finally {
      ctx.request = originalRequest;
    }
  };

  mw.stats = stats;
  mw.reset = () => {
    stats.totalCalls = stats.chainsStarted = stats.chainsCompleted = 0;
    stats.depthExceededCount = stats.cyclesDetectedCount = 0;
    stats.toolCallsExecuted = stats.toolErrors = stats.unknownToolCalls = 0;
    stats.maxObservedDepth = stats.totalDepth = 0;
    stats.lastChainDepth = null;
  };
  mw.avgChainDepth = () => {
    return stats.chainsCompleted === 0 ? 0 : stats.totalDepth / stats.chainsCompleted;
  };
  mw.listTools = () => handlerNames.slice();
  mw.asMcpResource = () => ({
    uri: 'config://auto-tool-chain',
    name: 'Auto tool chain',
    description: 'Cascading tool-call loop with cycle detection + depth cap. Frees callers from writing tool-invocation-loop boilerplate.',
    mimeType: 'application/json',
    handler: () => ({
      registeredTools:   handlerNames,
      maxDepth,
      detectCycles,
      handleUnknownTool,
      avgChainDepth:     mw.avgChainDepth(),
      ...stats,
    }),
  });

  return mw;
}

module.exports = {
  autoToolChain,
  UnknownToolError,
  MaxDepthExceededError,
  ToolChainCycleError,
};
