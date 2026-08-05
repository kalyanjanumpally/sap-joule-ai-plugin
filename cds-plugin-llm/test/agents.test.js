const { test } = require('node:test');
const assert = require('node:assert/strict');

// Stub @sap/cds so LLMService loads without the real package.
const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_agents__';
require.cache[STUB_PATH] = {
  exports: {
    Service: class { constructor(name, model, options) { this.options = options ?? {}; } async init() {} },
    log: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  },
  loaded: true,
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function(request, ...rest) {
  if (request === '@sap/cds') return STUB_PATH;
  return origResolve.call(this, request, ...rest);
};

const { Agent, runAgents, DEFAULT_COORDINATOR_SYSTEM } = require('../lib/agents');

// Programmable stub LLM that walks a scripted sequence of responses.
function makeLLM(script) {
  const calls = [];
  let idx = 0;
  return {
    calls,
    async chat(req) {
      calls.push(req);
      const next = typeof script === 'function' ? script(calls.length - 1, req) : script[idx++];
      if (!next) throw new Error(`LLM script exhausted at call ${calls.length - 1}`);
      // Fill in usage if the script didn't supply it — matches the shape
      // Anthropic/OpenAI wrappers produce.
      return {
        text:       next.text ?? '',
        toolCalls:  next.toolCalls ?? undefined,
        stopReason: next.toolCalls?.length ? 'tool_use' : (next.stopReason ?? 'end_turn'),
        usage:      next.usage ?? { input_tokens: 10, output_tokens: 5 },
        model:      next.model ?? 'stub-model',
      };
    },
  };
}

// ---- Agent construction ------------------------------------------------

test('Agent: requires name matching tool-name regex', () => {
  const llm = makeLLM([]);
  assert.throws(() => new Agent({ description: 'x', llm }), /name/);
  assert.throws(() => new Agent({ name: '', description: 'x', llm }), /name/);
  assert.throws(() => new Agent({ name: 'not valid!', description: 'x', llm }), /must match/);
});

test('Agent: requires description (coordinator uses it to route)', () => {
  const llm = makeLLM([]);
  assert.throws(() => new Agent({ name: 'a', llm }), /description/);
});

test('Agent: requires llm with chat()', () => {
  assert.throws(() => new Agent({ name: 'a', description: 'x' }), /llm/);
  assert.throws(() => new Agent({ name: 'a', description: 'x', llm: {} }), /llm/);
});

test('Agent: tools must be an array if provided', () => {
  const llm = makeLLM([]);
  assert.throws(() => new Agent({ name: 'a', description: 'x', llm, tools: 'nope' }), /tools/);
});

test('Agent: maxSteps must be a positive integer', () => {
  const llm = makeLLM([]);
  assert.throws(() => new Agent({ name: 'a', description: 'x', llm, maxSteps: 0 }), /maxSteps/);
  assert.throws(() => new Agent({ name: 'a', description: 'x', llm, maxSteps: 1.5 }), /maxSteps/);
});

// ---- Agent.run (tool-less path) ----------------------------------------

test('Agent.run: tool-less agent → single chat call, returns text', async () => {
  const llm = makeLLM([{ text: 'the answer' }]);
  const a = new Agent({ name: 'plain', description: 'plain agent', llm, system: 'be brief' });
  const res = await a.run({ input: 'what is up' });
  assert.equal(res.text, 'the answer');
  assert.equal(res.steps, 1);
  assert.deepEqual(res.toolCalls, []);
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].system, 'be brief');
  assert.deepEqual(llm.calls[0].messages, [{ role: 'user', content: 'what is up' }]);
});

test('Agent.run: rejects non-string input', async () => {
  const llm = makeLLM([]);
  const a = new Agent({ name: 'a', description: 'x', llm });
  await assert.rejects(() => a.run({ input: null }), /input/);
});

test('Agent.run: model override propagates to the chat call', async () => {
  const llm = makeLLM([{ text: 'ok' }]);
  const a = new Agent({ name: 'a', description: 'x', llm, model: 'claude-haiku-4-5' });
  await a.run({ input: 'q' });
  assert.equal(llm.calls[0].model, 'claude-haiku-4-5');
});

// ---- Agent.run (with tools — delegates to runTools) --------------------

test('Agent.run: with tools → tool-use loop runs; final text returned', async () => {
  const llm = makeLLM([
    { text: '', toolCalls: [{ id: 't1', name: 'lookup', input: { x: 1 } }] },
    { text: 'final answer' },
  ]);
  let toolInput;
  const a = new Agent({
    name: 'with-tools', description: 'x', llm,
    tools: [{
      name: 'lookup',
      description: 'look up',
      input_schema: { type: 'object', properties: { x: { type: 'number' } } },
      run: async (input) => { toolInput = input; return 'looked up'; },
    }],
  });
  const res = await a.run({ input: 'go' });
  assert.equal(res.text, 'final answer');
  assert.deepEqual(toolInput, { x: 1 });
  // First LLM turn had tools; second turn is after tool_result
  assert.equal(res.steps, 2);
});

// ---- runAgents validation ----------------------------------------------

test('runAgents: requires coordinator with chat()', async () => {
  await assert.rejects(
    () => runAgents({ agents: [], input: 'x' }),
    /coordinator/,
  );
  await assert.rejects(
    () => runAgents({ coordinator: {}, agents: [], input: 'x' }),
    /coordinator/,
  );
});

test('runAgents: requires non-empty agents array', async () => {
  const coord = makeLLM([]);
  await assert.rejects(
    () => runAgents({ coordinator: coord, agents: [], input: 'x' }),
    /agents/,
  );
  await assert.rejects(
    () => runAgents({ coordinator: coord, agents: 'nope', input: 'x' }),
    /agents/,
  );
});

test('runAgents: requires non-empty input', async () => {
  const coord = makeLLM([]);
  const a = new Agent({ name: 'a', description: 'x', llm: makeLLM([]) });
  await assert.rejects(
    () => runAgents({ coordinator: coord, agents: [a], input: '' }),
    /input/,
  );
});

test('runAgents: agents must have name / description / run', async () => {
  const coord = makeLLM([]);
  await assert.rejects(
    () => runAgents({ coordinator: coord, agents: [{}], input: 'q' }),
    /name/,
  );
  await assert.rejects(
    () => runAgents({ coordinator: coord, agents: [{ name: 'a', run: async () => 'ok' }], input: 'q' }),
    /description/,
  );
  await assert.rejects(
    () => runAgents({ coordinator: coord, agents: [{ name: 'a', description: 'x' }], input: 'q' }),
    /run\(input\)/,
  );
});

test('runAgents: rejects duplicate agent names', async () => {
  const coord = makeLLM([]);
  const dup = { name: 'a', description: 'x', run: async () => 'ok' };
  await assert.rejects(
    () => runAgents({ coordinator: coord, agents: [dup, dup], input: 'q' }),
    /duplicate agent name/,
  );
});

// ---- runAgents happy path ----------------------------------------------

test('runAgents: coordinator invokes one specialist by name, folds answer into final response', async () => {
  const lookupLlm = makeLLM([{ text: 'contract CTR-2026-101 is for Pacifica Freight' }]);
  const lookup = new Agent({
    name: 'contract-lookup',
    description: 'Answers questions about supplier contracts.',
    llm: lookupLlm,
  });
  const coord = makeLLM([
    // Turn 1: coordinator decides to ask the specialist
    { text: '', toolCalls: [{
      id: 'tc1', name: 'invoke_contract-lookup',
      input: { question: 'What supplier is on contract CTR-2026-101?' },
    }] },
    // Turn 2: coordinator sees the tool_result, produces the final answer
    { text: 'Pacifica Freight is on contract CTR-2026-101.' },
  ]);

  const result = await runAgents({
    coordinator: coord,
    agents: [lookup],
    input: 'Who is on contract CTR-2026-101?',
  });

  assert.equal(result.text, 'Pacifica Freight is on contract CTR-2026-101.');
  assert.equal(result.trace.length, 1);
  assert.equal(result.trace[0].agent, 'contract-lookup');
  assert.equal(result.trace[0].question, 'What supplier is on contract CTR-2026-101?');
  assert.equal(result.trace[0].answer, 'contract CTR-2026-101 is for Pacifica Freight');
  assert.equal(result.trace[0].isError, false);
  // Coordinator called chat() twice; specialist called chat() once.
  assert.equal(coord.calls.length, 2);
  assert.equal(lookupLlm.calls.length, 1);
});

test('runAgents: multi-step — coordinator routes to two specialists in sequence', async () => {
  const lookupLlm = makeLLM([{ text: 'sup-42 is Acme Steel' }]);
  const priceLlm  = makeLLM([{ text: 'sup-42 charges $2.10/kg' }]);
  const lookup = new Agent({ name: 'contract-lookup', description: 'contracts', llm: lookupLlm });
  const price  = new Agent({ name: 'price-analyst',  description: 'prices',   llm: priceLlm  });

  const coord = makeLLM([
    { text: '', toolCalls: [{ id: 'tc1', name: 'invoke_contract-lookup', input: { question: 'Who is sup-42?' } }] },
    { text: '', toolCalls: [{ id: 'tc2', name: 'invoke_price-analyst',   input: { question: 'What does sup-42 charge?' } }] },
    { text: 'Acme Steel (sup-42) charges $2.10/kg.' },
  ]);

  const result = await runAgents({
    coordinator: coord, agents: [lookup, price],
    input: 'Give me the current price for sup-42.',
  });

  assert.equal(result.text, 'Acme Steel (sup-42) charges $2.10/kg.');
  assert.equal(result.trace.length, 2);
  assert.deepEqual(result.trace.map(t => t.agent), ['contract-lookup', 'price-analyst']);
});

// ---- Duck-typed agents (non-Agent workers) -----------------------------

test('runAgents: duck-typed agent — anything with { name, description, run } works', async () => {
  const sqlWorker = {
    name: 'sql-worker',
    description: 'Runs SQL against the analytics warehouse.',
    run: async ({ input }) => ({ text: `SELECT for "${input}" returned 42 rows.` }),
  };
  const coord = makeLLM([
    { text: '', toolCalls: [{ id: 'tc1', name: 'invoke_sql-worker', input: { question: 'top 5 suppliers' } }] },
    { text: 'The top 5 supplier query returned 42 rows.' },
  ]);
  const result = await runAgents({
    coordinator: coord, agents: [sqlWorker], input: 'run the top-5 supplier report',
  });
  assert.match(result.text, /42 rows/);
  assert.equal(result.trace[0].agent, 'sql-worker');
  assert.match(result.trace[0].answer, /returned 42 rows/);
});

// ---- onAgentInvocation hook + custom system prompt ---------------------

test('runAgents: onAgentInvocation fires with { agent, question } per specialist call', async () => {
  const observed = [];
  const lookupLlm = makeLLM([{ text: 'ok' }]);
  const lookup = new Agent({ name: 'contract-lookup', description: 'x', llm: lookupLlm });
  const coord = makeLLM([
    { text: '', toolCalls: [{ id: 't', name: 'invoke_contract-lookup', input: { question: 'q1' } }] },
    { text: 'final' },
  ]);
  await runAgents({
    coordinator: coord, agents: [lookup], input: 'q',
    onAgentInvocation: ({ agent, question }) => observed.push({ agent, question }),
  });
  assert.deepEqual(observed, [{ agent: 'contract-lookup', question: 'q1' }]);
});

test('runAgents: custom system prompt replaces DEFAULT_COORDINATOR_SYSTEM', async () => {
  const coord = makeLLM([{ text: 'plain answer' }]);
  const stub = { name: 'x', description: 'x', run: async () => 'ok' };
  await runAgents({
    coordinator: coord, agents: [stub], input: 'q',
    system: 'You are a French-speaking supervisor.',
  });
  assert.equal(coord.calls[0].system, 'You are a French-speaking supervisor.');
});

test('runAgents: default coordinator system prompt is applied when none supplied', async () => {
  const coord = makeLLM([{ text: 'ok' }]);
  const stub = { name: 'x', description: 'x', run: async () => 'ok' };
  await runAgents({ coordinator: coord, agents: [stub], input: 'q' });
  assert.equal(coord.calls[0].system, DEFAULT_COORDINATOR_SYSTEM);
});

// ---- specialist errors surface into the trace --------------------------

test('runAgents: specialist throwing → trace entry isError: true + coordinator sees error text', async () => {
  const boom = {
    name: 'boom-agent', description: 'x',
    run: async () => { throw new Error('specialist crashed'); },
  };
  const coord = makeLLM([
    { text: '', toolCalls: [{ id: 't', name: 'invoke_boom-agent', input: { question: 'q' } }] },
    { text: 'The specialist failed; here is the fallback.' },
  ]);
  const result = await runAgents({ coordinator: coord, agents: [boom], input: 'go' });
  assert.equal(result.trace.length, 1);
  assert.equal(result.trace[0].isError, true);
  assert.match(result.trace[0].answer, /specialist crashed/);
  // Coordinator wove the error into its final response
  assert.match(result.text, /fallback/);
});

test('runAgents: coordinator returning null tool call args → runtime error surfaces', async () => {
  const stub = { name: 'x', description: 'x', run: async () => 'ok' };
  const coord = makeLLM([
    { text: '', toolCalls: [{ id: 't', name: 'invoke_x', input: {} }] },
    { text: 'ok' },
  ]);
  const result = await runAgents({ coordinator: coord, agents: [stub], input: 'go' });
  // Bad tool-call input surfaces as a tool error message, not a crash
  assert.equal(result.trace[0].isError, true);
  assert.match(result.trace[0].answer, /non-empty string/);
});
