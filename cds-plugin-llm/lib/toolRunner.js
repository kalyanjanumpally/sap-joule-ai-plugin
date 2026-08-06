/**
 * runTools() — automatic multi-turn tool-use loop.
 *
 * Wraps the pattern:
 *   chat with tools -> execute each toolCall via tool.run() -> append
 *   assistant + tool_result messages -> chat again -> repeat until
 *   the model stops calling tools (stopReason !== 'tool_use').
 *
 *   const result = await runTools({
 *     llm,                                     // any LLMService instance
 *     system: 'You help procurement approvers.',
 *     messages: [{ role: 'user', content: 'Fetch PO 4500000123 and summarize.' }],
 *     tools: [
 *       {
 *         name: 'get_purchase_order',
 *         description: 'Fetch a PO by 10-digit ID',
 *         input_schema: {
 *           type: 'object',
 *           properties: { purchaseOrderId: { type: 'string' } },
 *           required: ['purchaseOrderId'],
 *         },
 *         run: async ({ purchaseOrderId }) => {
 *           return await SELECT.one.from('PurchaseOrders').where({ ID: purchaseOrderId });
 *         },
 *       },
 *     ],
 *     maxSteps: 10,   // safety limit; throws if exceeded
 *     onStep,          // optional { step, response } callback per turn
 *   });
 *
 *   result.text       - final assistant text after the loop
 *   result.messages   - full message history (input + all turns)
 *   result.usage      - aggregated input/output token totals across all turns
 *   result.steps      - number of chat() calls made
 *   result.toolCalls  - array of every tool call executed (with input + result)
 */
async function runTools({
  llm,
  system,
  messages,
  tools,
  maxSteps = 10,
  onStep,
  ...rest
}) {
  if (!llm || typeof llm.chat !== 'function') {
    throw new Error('runTools() requires { llm: LLMService instance }');
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('runTools() requires { messages: non-empty array }');
  }
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error('runTools() requires { tools: [{ name, description, input_schema, run }, ...] }');
  }
  for (const t of tools) {
    if (typeof t.run !== 'function') {
      throw new Error(`Tool '${t.name}' is missing a run() function`);
    }
  }

  const toolIndex = new Map(tools.map(t => [t.name, t]));

  // Providers expect the tool definitions without .run (that's caller-side)
  const providerTools = tools.map(({ name, description, input_schema, parameters }) => ({
    name, description, input_schema, parameters,
  }));

  let history = messages.slice();  // don't mutate caller's array
  const executedCalls = [];
  const usage = { input_tokens: 0, output_tokens: 0 };

  for (let step = 1; step <= maxSteps; step++) {
    const response = await llm.chat({
      ...rest,
      system,
      messages: history,
      tools: providerTools,
    });

    // Aggregate usage
    usage.input_tokens += response.usage?.input_tokens ?? 0;
    usage.output_tokens += response.usage?.output_tokens ?? 0;

    if (typeof onStep === 'function') {
      await onStep({ step, response });
    }

    // No tool calls -> we're done
    if (!response.toolCalls?.length) {
      return {
        text: response.text ?? '',
        messages: [
          ...history,
          { role: 'assistant', content: response.text ?? '' },
        ],
        usage,
        steps: step,
        toolCalls: executedCalls,
        model: response.model,
        stopReason: response.stopReason,
      };
    }

    // Append the assistant turn with its tool calls
    history = [
      ...history,
      { role: 'assistant', content: response.text ?? null, toolCalls: response.toolCalls },
    ];

    // Execute each tool call, append tool_result messages
    for (const call of response.toolCalls) {
      const tool = toolIndex.get(call.name);
      let content;
      let isError = false;
      if (!tool) {
        content = `Error: no tool registered with name '${call.name}'`;
        isError = true;
      } else {
        try {
          const result = await tool.run(call.input ?? {});
          content = typeof result === 'string' ? result : JSON.stringify(result);
        } catch (err) {
          content = `Error: ${err.message}`;
          isError = true;
        }
      }
      executedCalls.push({ id: call.id, name: call.name, input: call.input, result: content, isError });
      history = [
        ...history,
        { role: 'tool', tool_call_id: call.id, content, ...(isError ? { is_error: true } : {}) },
      ];
    }
  }

  throw new Error(
    `runTools() exceeded maxSteps=${maxSteps}. The model keeps calling tools. ` +
    'Increase maxSteps if you expect a longer agent trace, or check the tool definitions ' +
    'for loops (e.g. a tool whose result triggers the same tool again).'
  );
}

/**
 * streamTools() — async-generator counterpart to runTools().
 *
 * Same tool-execution loop; yields progress events between + inside each
 * turn so a chat UI can render "searching contracts…", "checking
 * compliance…" instead of blocking on the full agent trace.
 *
 * Event types (all include `step: 1..maxSteps`):
 *   { type: 'turn_start', step }
 *   { type: 'text_delta', step, text }                        — token-level text (1.42.0+ when llm.stream() available)
 *   { type: 'text', step, text }                              — assistant text for the turn (atomic; end of turn)
 *   { type: 'tool_call_start',  step, id, name, input }       — tool about to run
 *   { type: 'tool_call_result', step, id, name, result, isError }
 *   { type: 'done', step, text, messages, usage, steps, toolCalls, model, stopReason }
 *
 * If the provided LLM exposes `stream()`, the loop uses it and emits per-token
 * `text_delta` events during a turn, then a final `text` event with the
 * fully-accumulated turn text. If only `chat()` is available (or per-request
 * override `stream: false`), text is emitted atomically per turn.
 *
 *   for await (const evt of streamTools({ llm, system, messages, tools, maxSteps: 8 })) {
 *     if (evt.type === 'text_delta') appendToChatBubble(evt.text);
 *     if (evt.type === 'tool_call_start') showBadge(evt.name, evt.input);
 *     if (evt.type === 'tool_call_result') hideBadge(evt.name);
 *     if (evt.type === 'done') finalize(evt);
 *   }
 *
 * @since 1.39.0 (initial atomic-text version), 1.42.0 (text_delta streaming)
 */
async function* streamTools({
  llm,
  system,
  messages,
  tools,
  maxSteps = 10,
  ...rest
}) {
  if (!llm || typeof llm.chat !== 'function') {
    throw new Error('streamTools() requires { llm: LLMService instance }');
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('streamTools() requires { messages: non-empty array }');
  }
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error('streamTools() requires { tools: [{ name, description, input_schema, run }, ...] }');
  }
  for (const t of tools) {
    if (typeof t.run !== 'function') {
      throw new Error(`Tool '${t.name}' is missing a run() function`);
    }
  }

  const toolIndex = new Map(tools.map(t => [t.name, t]));
  const providerTools = tools.map(({ name, description, input_schema, parameters }) => ({
    name, description, input_schema, parameters,
  }));

  let history = messages.slice();
  const executedCalls = [];
  const usage = { input_tokens: 0, output_tokens: 0 };
  // Prefer streaming when the LLM exposes it AND the caller didn't opt out.
  // Providers wire tool_calls onto the done chunk (see openai-compatible.js,
  // anthropic.js) so a streamed turn is functionally equivalent to a chat turn.
  const useStream = rest.stream !== false && typeof llm.stream === 'function';

  for (let step = 1; step <= maxSteps; step++) {
    yield { type: 'turn_start', step };

    let text = '', toolCalls, model, stopReason, turnUsage = {};
    if (useStream) {
      let accumulated = '';
      for await (const chunk of llm.stream({
        ...rest,
        system,
        messages: history,
        tools: providerTools,
      })) {
        if (chunk?.type === 'text_delta' && typeof chunk.text === 'string') {
          accumulated += chunk.text;
          yield { type: 'text_delta', step, text: chunk.text };
        } else if (chunk?.type === 'done') {
          text       = chunk.text ?? accumulated;
          toolCalls  = chunk.toolCalls;
          model      = chunk.model;
          stopReason = chunk.stopReason;
          turnUsage  = chunk.usage ?? {};
        }
      }
    } else {
      const response = await llm.chat({
        ...rest,
        system,
        messages: history,
        tools: providerTools,
      });
      text       = response.text ?? '';
      toolCalls  = response.toolCalls;
      model      = response.model;
      stopReason = response.stopReason;
      turnUsage  = response.usage ?? {};
    }

    usage.input_tokens  += turnUsage.input_tokens  ?? 0;
    usage.output_tokens += turnUsage.output_tokens ?? 0;

    if (text) {
      yield { type: 'text', step, text };
    }

    if (!toolCalls?.length) {
      const finalMessages = [
        ...history,
        { role: 'assistant', content: text },
      ];
      yield {
        type: 'done',
        step,
        text,
        messages: finalMessages,
        usage,
        steps: step,
        toolCalls: executedCalls,
        model,
        stopReason,
      };
      return;
    }

    history = [
      ...history,
      { role: 'assistant', content: text || null, toolCalls },
    ];

    for (const call of toolCalls) {
      yield { type: 'tool_call_start', step, id: call.id, name: call.name, input: call.input ?? {} };

      const tool = toolIndex.get(call.name);
      let content;
      let isError = false;
      if (!tool) {
        content = `Error: no tool registered with name '${call.name}'`;
        isError = true;
      } else {
        try {
          const result = await tool.run(call.input ?? {});
          content = typeof result === 'string' ? result : JSON.stringify(result);
        } catch (err) {
          content = `Error: ${err.message}`;
          isError = true;
        }
      }
      executedCalls.push({ id: call.id, name: call.name, input: call.input, result: content, isError });
      history = [
        ...history,
        { role: 'tool', tool_call_id: call.id, content, ...(isError ? { is_error: true } : {}) },
      ];

      yield { type: 'tool_call_result', step, id: call.id, name: call.name, result: content, isError };
    }
  }

  throw new Error(
    `streamTools() exceeded maxSteps=${maxSteps}. The model keeps calling tools. ` +
    'Increase maxSteps if you expect a longer agent trace, or check the tool definitions ' +
    'for loops (e.g. a tool whose result triggers the same tool again).'
  );
}

module.exports = { runTools, streamTools };
