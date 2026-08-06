const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_std__';
require.cache[STUB_PATH] = {
  exports: {
    Service: class { constructor() {} async init() {} },
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
const { streamAgents } = require('../lib/agents');

/**
 * Scripted LLM stub that exposes BOTH chat() and stream(). Each scripted
 * entry describes one turn; stream() replays it as a token-level delta
 * stream followed by a done chunk.
 */
function scriptedStreamingLLM(turns) {
  let i = 0;
  return {
    async chat() {
      throw new Error('scriptedStreamingLLM: chat() should not be called when stream() is available');
    },
    async *stream() {
      if (i >= turns.length) throw new Error('scriptedStreamingLLM: no more turns queued');
      const t = turns[i++];
      // Emit the text as N delta chunks so we can verify accumulation.
      for (const piece of t.deltas ?? []) {
        yield { type: 'text_delta', text: piece };
      }
      yield {
        type: 'done',
        text: t.text ?? (t.deltas ?? []).join(''),
        usage: t.usage ?? {},
        stopReason: t.stopReason,
        model: t.model,
        ...(t.toolCalls ? { toolCalls: t.toolCalls } : {}),
      };
    },
  };
}

async function collect(iter) { const out = []; for await (const e of iter) out.push(e); return out; }

// ---- Text delta streaming --------------------------------------------

test('streamTools: uses stream() when available, emits text_delta events during a turn', async () => {
  const llm = scriptedStreamingLLM([
    { deltas: ['hello', ' ', 'world'], usage: { input_tokens: 3, output_tokens: 3 }, stopReason: 'end_turn', model: 's' },
  ]);
  const events = await collect(streamTools({
    llm,
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 't', input_schema: {}, run: async () => 'unused' }],
  }));
  const types = events.map(e => e.type);
  assert.deepEqual(types, ['turn_start', 'text_delta', 'text_delta', 'text_delta', 'text', 'done']);
  const deltas = events.filter(e => e.type === 'text_delta').map(e => e.text);
  assert.deepEqual(deltas, ['hello', ' ', 'world']);
  // Final `text` still emitted with the fully-accumulated turn text.
  const text = events.find(e => e.type === 'text');
  assert.equal(text.text, 'hello world');
});

test('streamTools: tool call from a streamed turn — deltas + tool_call events sequenced correctly', async () => {
  const llm = scriptedStreamingLLM([
    {
      deltas: ['let ', 'me ', 'look'],
      toolCalls: [{ id: 'c1', name: 'search', input: { q: 'x' } }],
      usage: { input_tokens: 3, output_tokens: 3 },
    },
    { deltas: ['ok, ', 'done'], usage: { input_tokens: 2, output_tokens: 2 }, stopReason: 'end_turn', model: 's' },
  ]);
  const events = await collect(streamTools({
    llm,
    messages: [{ role: 'user', content: 'find x' }],
    tools: [{ name: 'search', input_schema: {}, run: async ({ q }) => `hit for ${q}` }],
  }));
  const types = events.map(e => e.type);
  assert.deepEqual(types, [
    'turn_start', 'text_delta', 'text_delta', 'text_delta', 'text',
    'tool_call_start', 'tool_call_result',
    'turn_start', 'text_delta', 'text_delta', 'text',
    'done',
  ]);
});

test('streamTools: stream:false forces chat() path (backward-compat)', async () => {
  let streamCalled = false, chatCalled = false;
  const llm = {
    async chat() { chatCalled = true; return { text: 'ok', usage: {}, model: 's', stopReason: 'end_turn' }; },
    async *stream() { streamCalled = true; yield { type: 'done', text: '', usage: {} }; },
  };
  const events = await collect(streamTools({
    llm,
    stream: false,   // opt-out
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 't', input_schema: {}, run: async () => 'x' }],
  }));
  assert.equal(chatCalled,   true,  'chat() should have been used');
  assert.equal(streamCalled, false, 'stream() should have been bypassed');
  assert.ok(events.find(e => e.type === 'text'));
});

test('streamTools: falls back to chat() when llm.stream is missing', async () => {
  const llm = {
    async chat() { return { text: 'no stream', usage: {}, model: 's', stopReason: 'end_turn' }; },
  };
  const events = await collect(streamTools({
    llm,
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 't', input_schema: {}, run: async () => 'x' }],
  }));
  const types = events.map(e => e.type);
  assert.deepEqual(types, ['turn_start', 'text', 'done']);
});

// ---- Aggregate usage across streamed turns ----------------------------

test('streamTools: done.usage aggregates across every streamed turn', async () => {
  const llm = scriptedStreamingLLM([
    { deltas: ['plan'], toolCalls: [{ id: '1', name: 't', input: {} }], usage: { input_tokens: 10, output_tokens: 5 } },
    { deltas: ['finish'], usage: { input_tokens: 20, output_tokens: 15 }, stopReason: 'end_turn' },
  ]);
  const events = await collect(streamTools({
    llm,
    messages: [{ role: 'user', content: 'x' }],
    tools: [{ name: 't', input_schema: {}, run: async () => 'ok' }],
  }));
  const done = events.find(e => e.type === 'done');
  assert.equal(done.usage.input_tokens,  30);
  assert.equal(done.usage.output_tokens, 20);
});

// ---- streamAgents inherits streaming behavior -------------------------

test('streamAgents: uses stream() and emits text_delta events for coordinator turns', async () => {
  const coordinator = scriptedStreamingLLM([
    {
      deltas: ['checking ', 'contracts'],
      toolCalls: [{ id: 'x', name: 'invoke_contract-lookup', input: { question: 'find widgets' } }],
      usage: { input_tokens: 5, output_tokens: 3 },
    },
    { deltas: ['answer: ', 'found ', 'widgets'], usage: { input_tokens: 3, output_tokens: 3 }, stopReason: 'end_turn' },
  ]);
  const events = await collect(streamAgents({
    coordinator,
    agents: [{
      name: 'contract-lookup',
      description: 'Looks up contracts.',
      run: async ({ input }) => `hit for ${input}`,
    }],
    input: 'find widgets',
  }));
  const types = events.map(e => e.type);
  assert.deepEqual(types, [
    'turn_start', 'text_delta', 'text_delta', 'text',
    'agent_call_start', 'agent_call_result',
    'turn_start', 'text_delta', 'text_delta', 'text_delta', 'text',
    'done',
  ]);
  const deltas = events.filter(e => e.type === 'text_delta').map(e => e.text);
  assert.deepEqual(deltas, ['checking ', 'contracts', 'answer: ', 'found ', 'widgets']);
});
