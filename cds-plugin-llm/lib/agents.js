// Multi-agent orchestration primitives — supervisor/worker patterns on top
// of the existing runTools() agent loop.
//
//   const contractLookup = new Agent({
//     name: 'contract-lookup', llm: cheapLlm,
//     description: "Answers questions about supplier contracts. Give it a plain-language question.",
//     system: 'You are a procurement specialist...',
//     tools: [ hybridSearchTool, ... ],
//   });
//   const priceAnalyst = new Agent({ name: 'price-analyst', llm: smartLlm, ... });
//   const complianceChecker = new Agent({ name: 'compliance-checker', llm: smartLlm, ... });
//
//   const { text, trace } = await runAgents({
//     coordinator: smartLlm,
//     agents: [contractLookup, priceAnalyst, complianceChecker],
//     input: 'For PO 4500000123 draft a compliance memo including price analysis.',
//   });
//
// The coordinator sees each agent as a tool it can invoke by name. Behind
// the scenes, `runAgents` wires runTools() on the coordinator with one
// synthesized tool per agent — the tool's run() forwards the coordinator's
// question to that agent's own tool-use loop (also runTools() under the
// hood) and returns the specialist's final text.
//
// Anything with `{ name, description, run(input) => Promise<string> }` is a
// valid agent — you're not required to use the Agent class. That lets
// custom / non-LLM workers (e.g. a SQL query engine, a rules engine) plug
// into the coordinator alongside real Agent instances.

const { runTools, streamTools } = require('./toolRunner');

class Agent {
  constructor(options = {}) {
    const { name, description, llm, system, tools, maxSteps = 10, model } = options;
    if (typeof name !== 'string' || !name) {
      throw new Error('Agent: `name` is required (short slug like "contract-lookup").');
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new Error(`Agent: name '${name}' must match /^[a-zA-Z0-9_-]+$/ (LLM tool-name rules).`);
    }
    if (typeof description !== 'string' || !description) {
      throw new Error('Agent: `description` is required — the coordinator uses it to decide when to invoke.');
    }
    if (!llm || typeof llm.chat !== 'function') {
      throw new Error(`Agent '${name}': \`llm\` must be an LLMService with chat().`);
    }
    if (tools !== undefined && !Array.isArray(tools)) {
      throw new Error(`Agent '${name}': \`tools\` must be an array (or omit for a tool-less agent).`);
    }
    if (!Number.isInteger(maxSteps) || maxSteps < 1) {
      throw new Error(`Agent '${name}': maxSteps must be a positive integer (got ${maxSteps}).`);
    }
    this.name = name;
    this.description = description;
    this.llm = llm;
    this.system = system ?? null;
    this.tools = tools ?? [];
    this.maxSteps = maxSteps;
    this.model = model ?? null;
  }

  /**
   * Run the agent's tool-use loop against a plain-string input. Returns a
   * summary object; callers who only need the text can `await agent.run(...).then(r => r.text)`.
   */
  async run({ input }) {
    if (typeof input !== 'string') {
      throw new Error(`Agent '${this.name}': \`input\` must be a string (got ${typeof input}).`);
    }
    if (this.tools.length === 0) {
      // No tools — a single chat call is enough.
      const req = {
        messages: [{ role: 'user', content: input }],
        ...(this.system ? { system: this.system } : {}),
        ...(this.model  ? { model:  this.model  } : {}),
      };
      const res = await this.llm.chat(req);
      return {
        text: res.text ?? '',
        steps: 1,
        toolCalls: [],
        usage: res.usage ?? {},
        model: res.model,
      };
    }
    return runTools({
      llm: this.llm,
      system: this.system,
      messages: [{ role: 'user', content: input }],
      tools: this.tools,
      maxSteps: this.maxSteps,
      ...(this.model ? { model: this.model } : {}),
    });
  }
}

const DEFAULT_COORDINATOR_SYSTEM = `You are a supervisor coordinating a team of specialist agents.

Each specialist is available as a tool. Read the user's task, pick the right
specialist(s) to invoke, and pass a clear focused question to each. Wait for
each specialist's answer before deciding the next step.

Rules:
- Do NOT try to answer the specialist's question yourself. Always invoke the
  appropriate specialist via a tool call.
- Compose specialist answers into a final response only when you have enough
  information to answer the user's original task.
- If no specialist is suited to a sub-task, say so explicitly rather than
  fabricating an answer.`;

async function runAgents(options = {}) {
  const {
    coordinator,
    agents,
    input,
    system = DEFAULT_COORDINATOR_SYSTEM,
    maxSteps = 20,
    onStep,
    onAgentInvocation,
    ...rest
  } = options;

  if (!coordinator || typeof coordinator.chat !== 'function') {
    throw new Error('runAgents: `coordinator` must be an LLMService with chat().');
  }
  if (!Array.isArray(agents) || agents.length === 0) {
    throw new Error('runAgents: `agents` must be a non-empty array of Agent instances (or duck-typed { name, description, run }).');
  }
  if (typeof input !== 'string' || !input) {
    throw new Error('runAgents: `input` must be a non-empty string.');
  }

  // Validate + build the synthesized tool set. One tool per agent —
  // `invoke_<name>` with a single string `question` parameter that gets
  // forwarded to the agent's own run() method.
  const seen = new Set();
  const tools = agents.map((agent, i) => {
    if (!agent || typeof agent.name !== 'string' || !agent.name) {
      throw new Error(`runAgents: agents[${i}] must have a non-empty \`name\`.`);
    }
    if (seen.has(agent.name)) {
      throw new Error(`runAgents: duplicate agent name '${agent.name}' — each agent must have a unique name.`);
    }
    seen.add(agent.name);
    if (typeof agent.description !== 'string' || !agent.description) {
      throw new Error(`runAgents: agents[${i}] ('${agent.name}') needs a description — the coordinator uses it to route.`);
    }
    if (typeof agent.run !== 'function') {
      throw new Error(`runAgents: agents[${i}] ('${agent.name}') must have a run(input) function.`);
    }
    return {
      name: `invoke_${agent.name}`,
      description: agent.description,
      input_schema: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: `The question or task for the ${agent.name} specialist. Be specific — the specialist can't see the original user task.`,
          },
        },
        required: ['question'],
      },
      run: async ({ question }) => {
        if (typeof question !== 'string' || !question) {
          throw new Error(`invoke_${agent.name}: 'question' must be a non-empty string`);
        }
        if (onAgentInvocation) {
          try { await onAgentInvocation({ agent: agent.name, question }); }
          catch { /* swallow observer errors */ }
        }
        const result = await agent.run({ input: question });
        // Coordinator only needs the text — the trace is captured separately.
        return typeof result === 'string' ? result : (result?.text ?? '');
      },
    };
  });

  const result = await runTools({
    llm: coordinator,
    system,
    messages: [{ role: 'user', content: input }],
    tools,
    maxSteps,
    onStep,
    ...rest,
  });

  // Repackage the trace so callers see one line per specialist invocation
  // (`agent`, `question`, `answer`) rather than the raw runTools shape which
  // spells them as `invoke_<name>` tool calls.
  const trace = result.toolCalls.map(tc => {
    const agentName = tc.name.startsWith('invoke_') ? tc.name.slice('invoke_'.length) : tc.name;
    return {
      agent:    agentName,
      question: tc.input?.question ?? null,
      answer:   tc.result,
      isError:  tc.isError,
    };
  });

  return {
    text: result.text,
    steps: result.steps,
    trace,
    usage: result.usage,
    model: result.model,
    stopReason: result.stopReason,
  };
}

/**
 * streamAgents() — async-generator counterpart to runAgents().
 *
 * Yields the same event surface as streamTools() but with `invoke_<name>`
 * tool-call events repackaged into agent-slug events. Chat UIs can render
 * per-specialist badges ("contract-lookup running…") without knowing about
 * the underlying `invoke_<name>` convention.
 *
 * Event types (all include `step: 1..maxSteps`):
 *   { type: 'turn_start', step }
 *   { type: 'text', step, text }                                  — coordinator prose
 *   { type: 'agent_call_start',  step, agent, question }
 *   { type: 'agent_call_result', step, agent, answer, isError }
 *   { type: 'done', step, text, trace, steps, usage, model, stopReason }
 *
 * The `done` event's `trace` matches `runAgents()` — one entry per
 * specialist invocation, with `{ agent, question, answer, isError }`.
 *
 *   for await (const evt of streamAgents({ coordinator, agents, input })) {
 *     if (evt.type === 'text')                writeToChat(evt.text);
 *     if (evt.type === 'agent_call_start')    showBadge(evt.agent);
 *     if (evt.type === 'agent_call_result')   hideBadge(evt.agent);
 *     if (evt.type === 'done')                finalize(evt);
 *   }
 *
 * @since 1.41.0
 */
async function* streamAgents(options = {}) {
  const {
    coordinator,
    agents,
    input,
    system = DEFAULT_COORDINATOR_SYSTEM,
    maxSteps = 20,
    onAgentInvocation,
    ...rest
  } = options;

  if (!coordinator || typeof coordinator.chat !== 'function') {
    throw new Error('streamAgents: `coordinator` must be an LLMService with chat().');
  }
  if (!Array.isArray(agents) || agents.length === 0) {
    throw new Error('streamAgents: `agents` must be a non-empty array of Agent instances (or duck-typed { name, description, run }).');
  }
  if (typeof input !== 'string' || !input) {
    throw new Error('streamAgents: `input` must be a non-empty string.');
  }

  // Reuse the same invoke_<name> conversion as runAgents so behavior is
  // identical between streaming and non-streaming paths. Any change to the
  // conversion needs to happen in both places (or extract a shared helper).
  const seen = new Set();
  const tools = agents.map((agent, i) => {
    if (!agent || typeof agent.name !== 'string' || !agent.name) {
      throw new Error(`streamAgents: agents[${i}] must have a non-empty \`name\`.`);
    }
    if (seen.has(agent.name)) {
      throw new Error(`streamAgents: duplicate agent name '${agent.name}' — each agent must have a unique name.`);
    }
    seen.add(agent.name);
    if (typeof agent.description !== 'string' || !agent.description) {
      throw new Error(`streamAgents: agents[${i}] ('${agent.name}') needs a description — the coordinator uses it to route.`);
    }
    if (typeof agent.run !== 'function') {
      throw new Error(`streamAgents: agents[${i}] ('${agent.name}') must have a run(input) function.`);
    }
    return {
      name: `invoke_${agent.name}`,
      description: agent.description,
      input_schema: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: `The question or task for the ${agent.name} specialist. Be specific — the specialist can't see the original user task.`,
          },
        },
        required: ['question'],
      },
      run: async ({ question }) => {
        if (typeof question !== 'string' || !question) {
          throw new Error(`invoke_${agent.name}: 'question' must be a non-empty string`);
        }
        if (onAgentInvocation) {
          try { await onAgentInvocation({ agent: agent.name, question }); }
          catch { /* swallow observer errors */ }
        }
        const result = await agent.run({ input: question });
        return typeof result === 'string' ? result : (result?.text ?? '');
      },
    };
  });

  // Route the streamTools events through a translator: any `invoke_<name>`
  // tool-call event becomes an `agent_call_*` event with the slug stripped.
  const stripInvoke = (name) => name.startsWith('invoke_') ? name.slice('invoke_'.length) : name;

  for await (const evt of streamTools({
    llm: coordinator,
    system,
    messages: [{ role: 'user', content: input }],
    tools,
    maxSteps,
    ...rest,
  })) {
    switch (evt.type) {
      case 'tool_call_start':
        yield {
          type:     'agent_call_start',
          step:     evt.step,
          agent:    stripInvoke(evt.name),
          question: evt.input?.question ?? null,
        };
        break;
      case 'tool_call_result':
        yield {
          type:    'agent_call_result',
          step:    evt.step,
          agent:   stripInvoke(evt.name),
          answer:  evt.result,
          isError: evt.isError,
        };
        break;
      case 'done':
        yield {
          type:       'done',
          step:       evt.step,
          text:       evt.text,
          steps:      evt.steps,
          usage:      evt.usage,
          model:      evt.model,
          stopReason: evt.stopReason,
          trace:      evt.toolCalls.map(tc => ({
            agent:    stripInvoke(tc.name),
            question: tc.input?.question ?? null,
            answer:   tc.result,
            isError:  tc.isError,
          })),
        };
        break;
      default:
        // turn_start + text pass through unchanged
        yield evt;
    }
  }
}

module.exports = { Agent, runAgents, streamAgents, DEFAULT_COORDINATOR_SYSTEM };
