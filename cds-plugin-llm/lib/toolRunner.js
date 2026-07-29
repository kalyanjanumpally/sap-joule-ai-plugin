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

module.exports = { runTools };
