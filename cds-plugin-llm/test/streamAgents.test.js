const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_sa__';
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

const { streamAgents, Agent } = require('../lib/agents');

function scriptedLLM(responses) {
  let i = 0;
  return {
    chat: async () => {
      if (i >= responses.length) throw new Error('scriptedLLM: no more responses queued');
      return responses[i++];
    },
  };
}

async function collect(iter) {
  const out = [];
  for await (const evt of iter) out.push(evt);
  return out;
}

// ---- Validation --------------------------------------------------------

test('streamAgents: missing coordinator throws', async () => {
  await assert.rejects(
    () => collect(streamAgents({ agents: [{ name: 'a', description: 'x', run: async () => 'ok' }], input: 'q' })),
    /coordinator/,
  );
});

test('streamAgents: missing agents throws', async () => {
  await assert.rejects(
    () => collect(streamAgents({ coordinator: scriptedLLM([]), input: 'q' })),
    /agents/,
  );
});

test('streamAgents: missing input throws', async () => {
  await assert.rejects(
    () => collect(streamAgents({
      coordinator: scriptedLLM([]),
      agents: [{ name: 'a', description: 'x', run: async () => 'ok' }],
    })),
    /input/,
  );
});

test('streamAgents: duplicate agent name throws', async () => {
  await assert.rejects(
    () => collect(streamAgents({
      coordinator: scriptedLLM([]),
      agents: [
        { name: 'a', description: 'x', run: async () => 'ok' },
        { name: 'a', description: 'y', run: async () => 'ok' },
      ],
      input: 'q',
    })),
    /duplicate agent name/,
  );
});

// ---- Single agent call — repackaging works ----------------------------

test('streamAgents: single agent call → agent_call_start + agent_call_result use slug (not invoke_<name>)', async () => {
  const coordinator = scriptedLLM([
    {
      text: 'i will consult contract-lookup',
      toolCalls: [{ id: 'x', name: 'invoke_contract-lookup', input: { question: 'find CTR-42' } }],
      usage: { input_tokens: 5, output_tokens: 3 },
    },
    { text: 'the answer is 42', usage: { input_tokens: 5, output_tokens: 2 }, model: 'c', stopReason: 'end_turn' },
  ]);
  const contractLookup = {
    name: 'contract-lookup',
    description: 'Looks up supplier contracts.',
    run: async ({ input }) => `hit for ${input}`,
  };
  const events = await collect(streamAgents({
    coordinator,
    agents: [contractLookup],
    input: 'find contract CTR-42',
  }));
  const types = events.map(e => e.type);
  assert.deepEqual(types, [
    'turn_start', 'text', 'agent_call_start', 'agent_call_result',
    'turn_start', 'text', 'done',
  ]);
  const start = events.find(e => e.type === 'agent_call_start');
  assert.equal(start.agent, 'contract-lookup', 'invoke_ prefix stripped');
  assert.equal(start.question, 'find CTR-42');
  const result = events.find(e => e.type === 'agent_call_result');
  assert.equal(result.agent, 'contract-lookup');
  assert.equal(result.answer, 'hit for find CTR-42');
  assert.equal(result.isError, false);
});

// ---- Done event carries the trace shape matching runAgents ----------

test('streamAgents: done event trace matches runAgents shape', async () => {
  const coordinator = scriptedLLM([
    {
      text: 'checking both',
      toolCalls: [
        { id: '1', name: 'invoke_price', input: { question: 'what is the rate?' } },
        { id: '2', name: 'invoke_compliance', input: { question: 'any RoHS issues?' } },
      ],
      usage: { input_tokens: 3, output_tokens: 2 },
    },
    { text: 'summarizing', usage: { input_tokens: 3, output_tokens: 5 }, model: 'c', stopReason: 'end_turn' },
  ]);
  const events = await collect(streamAgents({
    coordinator,
    agents: [
      { name: 'price',      description: 'Price analyst.',      run: async ({ input }) => `${input} → $42` },
      { name: 'compliance', description: 'Compliance checker.', run: async ({ input }) => `${input} → clean` },
    ],
    input: 'analyze this',
  }));
  const done = events[events.length - 1];
  assert.equal(done.type, 'done');
  assert.equal(done.text, 'summarizing');
  assert.equal(done.steps, 2);
  assert.equal(done.trace.length, 2);
  assert.equal(done.trace[0].agent, 'price');
  assert.equal(done.trace[0].question, 'what is the rate?');
  assert.match(done.trace[0].answer, /\$42/);
  assert.equal(done.trace[1].agent, 'compliance');
  assert.equal(done.trace[1].isError, false);
  assert.equal(done.usage.input_tokens, 6);
  assert.equal(done.usage.output_tokens, 7);
});

// ---- onAgentInvocation observer fires --------------------------------

test('streamAgents: onAgentInvocation observer fires per specialist call', async () => {
  const coordinator = scriptedLLM([
    {
      text: null,
      toolCalls: [{ id: 'x', name: 'invoke_a', input: { question: 'ping' } }],
      usage: {},
    },
    { text: 'done', usage: {} },
  ]);
  const invocations = [];
  await collect(streamAgents({
    coordinator,
    agents: [{ name: 'a', description: 'x', run: async () => 'ok' }],
    input: 'go',
    onAgentInvocation: (info) => invocations.push(info),
  }));
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].agent, 'a');
  assert.equal(invocations[0].question, 'ping');
});

// ---- Text-only turn (no agent call) ----------------------------------

test('streamAgents: coordinator answers without calling any agent → only text + done', async () => {
  const coordinator = scriptedLLM([
    { text: 'trivial answer', usage: { input_tokens: 1, output_tokens: 1 }, model: 'c', stopReason: 'end_turn' },
  ]);
  const events = await collect(streamAgents({
    coordinator,
    agents: [{ name: 'a', description: 'x', run: async () => 'x' }],
    input: 'what is 2+2?',
  }));
  const types = events.map(e => e.type);
  assert.deepEqual(types, ['turn_start', 'text', 'done']);
  const done = events[2];
  assert.equal(done.trace.length, 0, 'no specialist calls in the trace');
});

// ---- Agent throws → isError propagates -------------------------------

test('streamAgents: specialist throws → agent_call_result.isError=true, trace records it', async () => {
  const coordinator = scriptedLLM([
    {
      text: 'checking',
      toolCalls: [{ id: 'x', name: 'invoke_bad', input: { question: 'q' } }],
      usage: {},
    },
    { text: 'recovered', usage: {}, model: 'c', stopReason: 'end_turn' },
  ]);
  const badAgent = {
    name: 'bad',
    description: 'always throws',
    run: async () => { throw new Error('kaboom'); },
  };
  const events = await collect(streamAgents({
    coordinator,
    agents: [badAgent],
    input: 'try bad',
  }));
  const result = events.find(e => e.type === 'agent_call_result');
  assert.equal(result.isError, true);
  assert.match(result.answer, /kaboom/);
  const done = events[events.length - 1];
  assert.equal(done.trace[0].isError, true);
});

// ---- Integration with Agent class ------------------------------------

test('streamAgents: works with real Agent class instances (duck-type equivalence)', async () => {
  // Agent class needs an llm to instantiate — reuse the coordinator stub.
  const stubLLM = {
    chat: async ({ messages }) => {
      const lastUserMsg = messages.find(m => m.role === 'user');
      const q = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : 'unknown';
      return { text: `agent saw: ${q}`, usage: { input_tokens: 1, output_tokens: 1 } };
    },
  };
  const specialist = new Agent({
    name: 'echo-agent',
    description: 'Echoes the question back.',
    llm: stubLLM,
    system: 'Echo the question.',
  });

  const coordinator = scriptedLLM([
    {
      text: 'asking the specialist',
      toolCalls: [{ id: '1', name: 'invoke_echo-agent', input: { question: 'hello world' } }],
      usage: {},
    },
    { text: 'final answer', usage: {}, model: 'c', stopReason: 'end_turn' },
  ]);

  const events = await collect(streamAgents({
    coordinator,
    agents: [specialist],
    input: 'go',
  }));
  const result = events.find(e => e.type === 'agent_call_result');
  assert.equal(result.agent, 'echo-agent');
  assert.match(result.answer, /agent saw: hello world/);
});
