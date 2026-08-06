const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_st__';
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

const { streamTools } = require('../lib/toolRunner');

/** A scripted LLM stub — feed it an array of chat() responses to return in order. */
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

test('streamTools: requires llm', async () => {
  await assert.rejects(
    () => collect(streamTools({ messages: [{}], tools: [{ run: () => 'x' }] })),
    /requires \{ llm/,
  );
});
test('streamTools: requires messages', async () => {
  await assert.rejects(
    () => collect(streamTools({ llm: scriptedLLM([]), tools: [{ name: 't', run: () => 'x' }] })),
    /messages/,
  );
});
test('streamTools: requires tools', async () => {
  await assert.rejects(
    () => collect(streamTools({ llm: scriptedLLM([]), messages: [{}] })),
    /tools/,
  );
});
test('streamTools: rejects tool missing a run function', async () => {
  await assert.rejects(
    () => collect(streamTools({
      llm: scriptedLLM([]),
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'bogus' }],
    })),
    /missing a run/,
  );
});

// ---- Zero-tool-call case ----------------------------------------------

test('streamTools: text-only turn → turn_start + text + done', async () => {
  const llm = scriptedLLM([
    { text: 'hello there', usage: { input_tokens: 5, output_tokens: 5 }, model: 'stub-1', stopReason: 'end_turn' },
  ]);
  const events = await collect(streamTools({
    llm,
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 't', run: () => 'unused', input_schema: { type: 'object', properties: {} } }],
  }));
  const types = events.map(e => e.type);
  assert.deepEqual(types, ['turn_start', 'text', 'done']);
  assert.equal(events[1].text, 'hello there');
  assert.equal(events[2].steps, 1);
  assert.equal(events[2].text, 'hello there');
  assert.equal(events[2].usage.input_tokens, 5);
});

// ---- Single tool call --------------------------------------------------

test('streamTools: one tool call → start + call_start + call_result + start + text + done', async () => {
  const search = {
    name: 'search',
    description: 'search things',
    input_schema: { type: 'object', properties: { q: { type: 'string' } } },
    run: async ({ q }) => `hits for ${q}`,
  };
  const llm = scriptedLLM([
    {
      text: 'let me search',
      toolCalls: [{ id: 'c1', name: 'search', input: { q: 'widgets' } }],
      usage: { input_tokens: 10, output_tokens: 5 },
      model: 's',
      stopReason: 'tool_use',
    },
    {
      text: 'i found some widgets',
      usage: { input_tokens: 20, output_tokens: 8 },
      model: 's',
      stopReason: 'end_turn',
    },
  ]);
  const events = await collect(streamTools({
    llm,
    messages: [{ role: 'user', content: 'find widgets' }],
    tools: [search],
    maxSteps: 5,
  }));
  const types = events.map(e => e.type);
  assert.deepEqual(types, [
    'turn_start', 'text', 'tool_call_start', 'tool_call_result',
    'turn_start', 'text', 'done',
  ]);
  const start = events.find(e => e.type === 'tool_call_start');
  assert.equal(start.name, 'search');
  assert.deepEqual(start.input, { q: 'widgets' });
  const result = events.find(e => e.type === 'tool_call_result');
  assert.equal(result.result, 'hits for widgets');
  assert.equal(result.isError, false);
  const done = events.find(e => e.type === 'done');
  assert.equal(done.usage.input_tokens, 30, 'usage aggregated across turns');
  assert.equal(done.usage.output_tokens, 13);
  assert.equal(done.steps, 2);
  assert.equal(done.toolCalls.length, 1);
});

// ---- Tool throws → isError: true --------------------------------------

test('streamTools: tool throws → tool_call_result carries isError=true + error message', async () => {
  const failing = {
    name: 'failing',
    input_schema: { type: 'object', properties: {} },
    run: async () => { throw new Error('boom'); },
  };
  const llm = scriptedLLM([
    {
      text: 'trying',
      toolCalls: [{ id: 'x', name: 'failing', input: {} }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    { text: 'ok, done', usage: { input_tokens: 1, output_tokens: 1 } },
  ]);
  const events = await collect(streamTools({
    llm,
    messages: [{ role: 'user', content: 'call failing' }],
    tools: [failing],
  }));
  const result = events.find(e => e.type === 'tool_call_result');
  assert.equal(result.isError, true);
  assert.match(result.result, /Error: boom/);
});

// ---- Unknown tool call → isError with clear message -------------------

test('streamTools: unknown tool name → isError=true, agent may recover', async () => {
  const llm = scriptedLLM([
    {
      text: null,
      toolCalls: [{ id: 'ghost', name: 'not_registered', input: {} }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    { text: 'recovered', usage: { input_tokens: 1, output_tokens: 1 } },
  ]);
  const events = await collect(streamTools({
    llm,
    messages: [{ role: 'user', content: 'test' }],
    tools: [{ name: 'a', run: () => 'x', input_schema: { type: 'object' } }],
  }));
  const result = events.find(e => e.type === 'tool_call_result');
  assert.equal(result.isError, true);
  assert.match(result.result, /no tool registered with name 'not_registered'/);
});

// ---- Multiple tool calls in one turn ---------------------------------

test('streamTools: multiple tool calls in one turn → paired start+result events', async () => {
  const a = { name: 'a', input_schema: { type: 'object' }, run: async () => 'A' };
  const b = { name: 'b', input_schema: { type: 'object' }, run: async () => 'B' };
  const llm = scriptedLLM([
    {
      text: 'calling both',
      toolCalls: [
        { id: 'x', name: 'a', input: {} },
        { id: 'y', name: 'b', input: {} },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    { text: 'both done', usage: { input_tokens: 1, output_tokens: 1 } },
  ]);
  const events = await collect(streamTools({
    llm,
    messages: [{ role: 'user', content: 'test' }],
    tools: [a, b],
  }));
  const starts  = events.filter(e => e.type === 'tool_call_start').map(e => e.name);
  const results = events.filter(e => e.type === 'tool_call_result').map(e => e.name);
  assert.deepEqual(starts, ['a', 'b']);
  assert.deepEqual(results, ['a', 'b'], 'paired 1:1 in order');
});

// ---- Empty text turn (planning + tool call, no visible message) --------

test('streamTools: turn without text does NOT emit a text event', async () => {
  const llm = scriptedLLM([
    { text: '', toolCalls: [{ id: 'z', name: 'a', input: {} }], usage: {} },
    { text: 'done', usage: {} },
  ]);
  const events = await collect(streamTools({
    llm,
    messages: [{ role: 'user', content: 'x' }],
    tools: [{ name: 'a', input_schema: {}, run: async () => 'ok' }],
  }));
  const textEvents = events.filter(e => e.type === 'text');
  assert.equal(textEvents.length, 1, 'only the final turn emits text');
  assert.equal(textEvents[0].text, 'done');
});

// ---- maxSteps guard ---------------------------------------------------

test('streamTools: throws when maxSteps exceeded', async () => {
  // LLM keeps calling the tool forever
  const infinite = Array.from({ length: 20 }, () => ({
    text: 'loop',
    toolCalls: [{ id: 'x', name: 'a', input: {} }],
    usage: {},
  }));
  const llm = scriptedLLM(infinite);
  await assert.rejects(
    () => collect(streamTools({
      llm,
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'a', input_schema: {}, run: async () => 'ok' }],
      maxSteps: 3,
    })),
    /exceeded maxSteps=3/,
  );
});

// ---- Done event shape matches RunToolsResult --------------------------

test('streamTools: done event carries the same shape as runTools() would', async () => {
  const llm = scriptedLLM([
    {
      text: 'first',
      toolCalls: [{ id: '1', name: 't', input: { a: 1 } }],
      usage: { input_tokens: 3, output_tokens: 2 },
      model: 'test-model',
    },
    {
      text: 'second',
      usage: { input_tokens: 5, output_tokens: 4 },
      model: 'test-model',
      stopReason: 'end_turn',
    },
  ]);
  const events = await collect(streamTools({
    llm,
    messages: [{ role: 'user', content: 'x' }],
    tools: [{ name: 't', input_schema: {}, run: async ({ a }) => `got ${a}` }],
  }));
  const done = events[events.length - 1];
  assert.equal(done.type, 'done');
  assert.equal(done.text, 'second');
  assert.equal(done.steps, 2);
  assert.equal(done.model, 'test-model');
  assert.equal(done.stopReason, 'end_turn');
  assert.ok(Array.isArray(done.messages));
  assert.ok(Array.isArray(done.toolCalls));
  assert.equal(done.toolCalls[0].name, 't');
  assert.equal(done.toolCalls[0].result, 'got 1');
  assert.equal(done.usage.input_tokens, 8);
  assert.equal(done.usage.output_tokens, 6);
});
