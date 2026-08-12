const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_atc__';
require.cache[STUB_PATH] = {
  exports: {
    Service: class { constructor(name, model, options) { this.options = options ?? {}; } async init() {} },
    log: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} }),
  },
  loaded: true,
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function(request, ...rest) {
  if (request === '@sap/cds') return STUB_PATH;
  return origResolve.call(this, request, ...rest);
};

const {
  autoToolChain,
  UnknownToolError,
  MaxDepthExceededError,
  ToolChainCycleError,
} = require('../lib/middleware/autoToolChain');

// ---- Helpers ----------------------------------------------------------

function ctxWith(request) { return { request }; }
function toolCall(name, input, id) { return { id: id ?? 'c-' + name, name, input }; }

/**
 * Scripts a downstream: an array of responses, one per next() invocation.
 * Once exhausted, returns { text: 'final', toolCalls: [] } forever.
 */
function scriptDownstream(scripts) {
  let i = 0;
  return async () => {
    const s = i < scripts.length ? scripts[i] : { text: 'auto-final' };
    i++;
    return s;
  };
}

// ---- Validation -------------------------------------------------------

test('autoToolChain: throws on non-object handlers', () => {
  assert.throws(() => autoToolChain({ handlers: 'x' }), /handlers/);
});
test('autoToolChain: throws on non-function handler', () => {
  assert.throws(() => autoToolChain({ handlers: { a: 'not-a-function' } }), /handlers\.a/);
});
test('autoToolChain: throws on invalid maxDepth', () => {
  assert.throws(() => autoToolChain({ maxDepth: 0 }), /maxDepth/);
});
test('autoToolChain: throws on invalid handleUnknownTool', () => {
  assert.throws(() => autoToolChain({ handleUnknownTool: 'bogus' }), /handleUnknownTool/);
});
test('autoToolChain: throws on non-function callback', () => {
  assert.throws(() => autoToolChain({ onToolCall: 'x' }), /callbacks/);
});

// ---- No tool calls → passthrough --------------------------------

test('autoToolChain: no toolCalls in initial response → passthrough', async () => {
  const mw = autoToolChain({ handlers: {} });
  const r = await mw(ctxWith({ messages: [] }), async () => ({ text: 'just text' }));
  assert.equal(r.text, 'just text');
  assert.equal(mw.stats.chainsStarted, 0);
});

// ---- Single tool call, then final -----------------------------

test('autoToolChain: 1 tool call → runs handler → returns final', async () => {
  const handlers = {
    lookup_customer: async (input) => ({ id: input.id, name: 'Alice' }),
  };
  const scripts = [
    { text: 'looking up', toolCalls: [toolCall('lookup_customer', { id: 'C-1' })] },
    { text: 'Their name is Alice.', toolCalls: [] },
  ];
  const mw = autoToolChain({ handlers });
  const r = await mw(ctxWith({ messages: [] }), scriptDownstream(scripts));
  assert.equal(r.text, 'Their name is Alice.');
  assert.equal(mw.stats.chainsStarted, 1);
  assert.equal(mw.stats.chainsCompleted, 1);
  assert.equal(mw.stats.toolCallsExecuted, 1);
  assert.equal(mw.avgChainDepth(), 1);
});

// ---- Multi-hop chain -------------------------------------

test('autoToolChain: multi-hop chain (2 tools → 1 tool → final)', async () => {
  const handlers = {
    step_a: async () => 'A done',
    step_b: async () => 'B done',
    step_c: async () => 'C done',
  };
  const scripts = [
    { text: 'chain 1', toolCalls: [toolCall('step_a', {}), toolCall('step_b', {})] },
    { text: 'chain 2', toolCalls: [toolCall('step_c', {})] },
    { text: 'all done' },
  ];
  const mw = autoToolChain({ handlers });
  const r = await mw(ctxWith({ messages: [] }), scriptDownstream(scripts));
  assert.equal(r.text, 'all done');
  assert.equal(mw.stats.toolCallsExecuted, 3);
  assert.equal(mw.stats.chainsCompleted, 1);
  assert.equal(mw.stats.lastChainDepth, 2);   // 2 hops
});

// ---- Messages accumulated correctly ----------------------

test('autoToolChain: appends assistant + tool messages between hops', async () => {
  const handlers = {
    ping: async (input) => ({ pong: input.n }),
  };
  const scripts = [
    { text: 'calling ping', toolCalls: [toolCall('ping', { n: 42 }, 'c1')] },
    { text: 'answer is 42' },
  ];
  let seenSecondRequest;
  let call = 0;
  const mw = autoToolChain({ handlers });
  await mw(ctxWith({ messages: [{ role: 'user', content: 'what is n?' }] }), async (arg) => {
    call++;
    if (call === 2) {
      // On the 2nd invocation, ctx.request should have the assistant + tool messages appended.
      // But: since autoToolChain doesn't pass ctx explicitly, we need to peek at the closure.
      return scripts[call - 1];
    }
    return scripts[call - 1];
  });
  // Rerun with explicit ctx access.
  const scripts2 = [
    { text: 'calling ping', toolCalls: [toolCall('ping', { n: 42 }, 'c1')] },
    { text: 'answer is 42' },
  ];
  const ctx = ctxWith({ messages: [{ role: 'user', content: 'what is n?' }] });
  const mw2 = autoToolChain({ handlers });
  let i = 0;
  await mw2(ctx, async () => {
    if (i === 1) {
      seenSecondRequest = ctx.request.messages.map((m) => m.role);
    }
    return scripts2[i++];
  });
  assert.deepEqual(seenSecondRequest, ['user', 'assistant', 'tool']);
});

// ---- Original request restored --------------------------

test('autoToolChain: restores ctx.request after chain completes', async () => {
  const handlers = { x: async () => 'y' };
  const scripts = [
    { text: 'call x', toolCalls: [toolCall('x', {})] },
    { text: 'done' },
  ];
  const mw = autoToolChain({ handlers });
  const ctx = ctxWith({ messages: [{ role: 'user', content: 'q' }] });
  const original = ctx.request;
  await mw(ctx, scriptDownstream(scripts));
  assert.equal(ctx.request, original);
});

// ---- Unknown tool: throw ------------------------------

test('autoToolChain: unknown tool with handleUnknownTool=throw → UnknownToolError', async () => {
  const handlers = { known: async () => 'ok' };
  const scripts = [
    { text: '', toolCalls: [toolCall('unknown_tool', {})] },
  ];
  const mw = autoToolChain({ handlers });
  await assert.rejects(
    mw(ctxWith({ messages: [] }), scriptDownstream(scripts)),
    UnknownToolError,
  );
  assert.equal(mw.stats.unknownToolCalls, 1);
});

// ---- Unknown tool: skip ----------------------------

test('autoToolChain: unknown tool with handleUnknownTool=skip → tool result dropped', async () => {
  const handlers = { known: async () => 'ok' };
  const scripts = [
    { text: 'mix', toolCalls: [toolCall('unknown', {}, 'c1'), toolCall('known', {}, 'c2')] },
    { text: 'done' },
  ];
  const mw = autoToolChain({ handlers, handleUnknownTool: 'skip' });
  const r = await mw(ctxWith({ messages: [] }), scriptDownstream(scripts));
  assert.equal(r.text, 'done');
  assert.equal(mw.stats.unknownToolCalls, 1);
});

// ---- Unknown tool: error-back ----------------------

test('autoToolChain: unknown tool with handleUnknownTool=error-back → tool result carries error', async () => {
  const handlers = { known: async () => 'ok' };
  const scripts = [
    { text: '', toolCalls: [toolCall('unknown', {}, 'c1')] },
    { text: 'done' },
  ];
  let seenMessages;
  const mw = autoToolChain({ handlers, handleUnknownTool: 'error-back' });
  const ctx = ctxWith({ messages: [] });
  let call = 0;
  await mw(ctx, async () => {
    if (call === 1) seenMessages = ctx.request.messages;
    return scripts[call++];
  });
  const toolMsg = seenMessages.find((m) => m.role === 'tool');
  assert.ok(toolMsg);
  const parsed = JSON.parse(toolMsg.content);
  assert.ok(parsed.error.includes('unknown tool'));
});

// ---- Max depth cap ----------------------------

test('autoToolChain: exceeding maxDepth → MaxDepthExceededError', async () => {
  const handlers = { loop: async () => 'x' };
  const scripts = Array.from({ length: 20 }, (_, i) => ({
    text: 'chain ' + i,
    toolCalls: [toolCall('loop', { i })],   // different inputs → no cycle detection kick
  }));
  const mw = autoToolChain({ handlers, maxDepth: 5 });
  await assert.rejects(
    mw(ctxWith({ messages: [] }), scriptDownstream(scripts)),
    MaxDepthExceededError,
  );
  assert.equal(mw.stats.depthExceededCount, 1);
});

test('autoToolChain: MaxDepthExceededError carries depth + limit', async () => {
  const handlers = { loop: async () => 'x' };
  const scripts = Array.from({ length: 10 }, (_, i) => ({
    text: 'chain', toolCalls: [toolCall('loop', { i })],
  }));
  const mw = autoToolChain({ handlers, maxDepth: 3 });
  try {
    await mw(ctxWith({ messages: [] }), scriptDownstream(scripts));
    assert.fail('should throw');
  } catch (err) {
    assert.equal(err.code, 'MAX_TOOL_DEPTH_EXCEEDED');
    assert.equal(err.maxDepth, 3);
    assert.equal(err.depth, 4);
  }
});

// ---- Cycle detection --------------------------

test('autoToolChain: cycle detected → ToolChainCycleError', async () => {
  const handlers = { spin: async () => 'x' };
  const scripts = [
    { text: '', toolCalls: [toolCall('spin', { x: 1 })] },
    { text: '', toolCalls: [toolCall('spin', { x: 1 })] },   // SAME input → cycle
  ];
  const mw = autoToolChain({ handlers });
  await assert.rejects(
    mw(ctxWith({ messages: [] }), scriptDownstream(scripts)),
    ToolChainCycleError,
  );
  assert.equal(mw.stats.cyclesDetectedCount, 1);
});

test('autoToolChain: cycle detection with same key regardless of key order', async () => {
  const handlers = { spin: async () => 'x' };
  const scripts = [
    { text: '', toolCalls: [toolCall('spin', { a: 1, b: 2 })] },
    { text: '', toolCalls: [toolCall('spin', { b: 2, a: 1 })] },   // same content
  ];
  const mw = autoToolChain({ handlers });
  await assert.rejects(mw(ctxWith({ messages: [] }), scriptDownstream(scripts)), ToolChainCycleError);
});

test('autoToolChain: different inputs to same tool → no cycle', async () => {
  const handlers = { spin: async () => 'x' };
  const scripts = [
    { text: '', toolCalls: [toolCall('spin', { x: 1 })] },
    { text: '', toolCalls: [toolCall('spin', { x: 2 })] },
    { text: 'done' },
  ];
  const mw = autoToolChain({ handlers });
  const r = await mw(ctxWith({ messages: [] }), scriptDownstream(scripts));
  assert.equal(r.text, 'done');
});

test('autoToolChain: detectCycles=false allows same-input calls', async () => {
  const handlers = { spin: async () => 'x' };
  const scripts = [
    { text: '', toolCalls: [toolCall('spin', { x: 1 })] },
    { text: '', toolCalls: [toolCall('spin', { x: 1 })] },
    { text: 'done' },
  ];
  const mw = autoToolChain({ handlers, detectCycles: false });
  const r = await mw(ctxWith({ messages: [] }), scriptDownstream(scripts));
  assert.equal(r.text, 'done');
});

// ---- Handler errors -------------------------

test('autoToolChain: handler error sends error-back to model, chain continues', async () => {
  const handlers = { flaky: async () => { throw new Error('flake'); } };
  const scripts = [
    { text: '', toolCalls: [toolCall('flaky', { x: 1 })] },
    { text: 'recovered' },
  ];
  const errors = [];
  const mw = autoToolChain({ handlers, onToolError: (i) => errors.push(i) });
  const r = await mw(ctxWith({ messages: [] }), scriptDownstream(scripts));
  assert.equal(r.text, 'recovered');
  assert.equal(mw.stats.toolErrors, 1);
  assert.equal(errors[0].toolName, 'flaky');
});

test('autoToolChain: string return from handler used as content directly', async () => {
  const handlers = { get_greeting: async () => 'Hello!' };
  const scripts = [
    { text: '', toolCalls: [toolCall('get_greeting', {})] },
    { text: 'done' },
  ];
  let seenTool;
  const mw = autoToolChain({ handlers });
  const ctx = ctxWith({ messages: [] });
  let call = 0;
  await mw(ctx, async () => {
    if (call === 1) seenTool = ctx.request.messages.find((m) => m.role === 'tool');
    return scripts[call++];
  });
  assert.equal(seenTool.content, 'Hello!');
});

// ---- Callbacks ------------------------------

test('autoToolChain: onToolCall fires per invocation', async () => {
  const events = [];
  const handlers = { a: async () => 'x', b: async () => 'y' };
  const scripts = [
    { text: '', toolCalls: [toolCall('a', {}), toolCall('b', {})] },
    { text: 'done' },
  ];
  const mw = autoToolChain({
    handlers,
    onToolCall: (i) => events.push({ tool: i.toolName, depth: i.depth }),
  });
  await mw(ctxWith({ messages: [] }), scriptDownstream(scripts));
  assert.deepEqual(events, [{ tool: 'a', depth: 1 }, { tool: 'b', depth: 1 }]);
});

test('autoToolChain: onChainComplete fires with final result + depth', async () => {
  const events = [];
  const handlers = { x: async () => 'y' };
  const scripts = [
    { text: '', toolCalls: [toolCall('x', {})] },
    { text: 'done' },
  ];
  const mw = autoToolChain({
    handlers,
    onChainComplete: (i) => events.push(i),
  });
  await mw(ctxWith({ messages: [] }), scriptDownstream(scripts));
  assert.equal(events.length, 1);
  assert.equal(events[0].depth, 1);
  assert.equal(events[0].finalResult.text, 'done');
});

test('autoToolChain: onCycleDetected fires with tool + depth', async () => {
  const events = [];
  const handlers = { spin: async () => 'x' };
  const scripts = [
    { text: '', toolCalls: [toolCall('spin', { x: 1 })] },
    { text: '', toolCalls: [toolCall('spin', { x: 1 })] },
  ];
  const mw = autoToolChain({ handlers, onCycleDetected: (i) => events.push(i) });
  await assert.rejects(mw(ctxWith({ messages: [] }), scriptDownstream(scripts)), ToolChainCycleError);
  assert.equal(events.length, 1);
  assert.equal(events[0].toolName, 'spin');
});

test('autoToolChain: onDepthExceeded fires', async () => {
  const events = [];
  const handlers = { loop: async () => 'x' };
  const scripts = Array.from({ length: 10 }, (_, i) => ({
    text: '', toolCalls: [toolCall('loop', { i })],
  }));
  const mw = autoToolChain({
    handlers, maxDepth: 3,
    onDepthExceeded: (i) => events.push(i),
  });
  await assert.rejects(mw(ctxWith({ messages: [] }), scriptDownstream(scripts)), MaxDepthExceededError);
  assert.equal(events.length, 1);
  assert.equal(events[0].maxDepth, 3);
});

test('autoToolChain: callback throws swallowed', async () => {
  const handlers = { x: async () => 'y' };
  const scripts = [
    { text: '', toolCalls: [toolCall('x', {})] },
    { text: 'done' },
  ];
  const mw = autoToolChain({
    handlers,
    onToolCall: () => { throw new Error('bug'); },
    onChainComplete: () => { throw new Error('bug'); },
  });
  const r = await mw(ctxWith({ messages: [] }), scriptDownstream(scripts));
  assert.equal(r.text, 'done');
});

// ---- Stats + MCP + reset -------------------

test('autoToolChain: avgChainDepth', async () => {
  const handlers = { x: async () => 'y' };
  // Chain 1: depth 1
  const scripts1 = [
    { text: '', toolCalls: [toolCall('x', { n: 1 })] },
    { text: 'done' },
  ];
  // Chain 2: depth 2
  const scripts2 = [
    { text: '', toolCalls: [toolCall('x', { n: 2 })] },
    { text: '', toolCalls: [toolCall('x', { n: 3 })] },
    { text: 'done' },
  ];
  const mw = autoToolChain({ handlers });
  await mw(ctxWith({ messages: [] }), scriptDownstream(scripts1));
  await mw(ctxWith({ messages: [] }), scriptDownstream(scripts2));
  assert.equal(mw.avgChainDepth(), 1.5);
  assert.equal(mw.stats.maxObservedDepth, 2);
});

test('autoToolChain: reset clears counters', async () => {
  const handlers = { x: async () => 'y' };
  const scripts = [
    { text: '', toolCalls: [toolCall('x', {})] },
    { text: 'done' },
  ];
  const mw = autoToolChain({ handlers });
  await mw(ctxWith({ messages: [] }), scriptDownstream(scripts));
  assert.ok(mw.stats.chainsCompleted > 0);
  mw.reset();
  assert.equal(mw.stats.chainsCompleted, 0);
  assert.equal(mw.avgChainDepth(), 0);
});

test('autoToolChain: listTools returns registered handlers', () => {
  const mw = autoToolChain({ handlers: { a: async () => 'x', b: async () => 'y' } });
  assert.deepEqual(mw.listTools().sort(), ['a', 'b']);
});

test('autoToolChain: asMcpResource', () => {
  const mw = autoToolChain({
    handlers: { a: async () => 'x' },
    maxDepth: 7, handleUnknownTool: 'error-back',
  });
  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://auto-tool-chain');
  const p = r.handler();
  assert.deepEqual(p.registeredTools, ['a']);
  assert.equal(p.maxDepth, 7);
  assert.equal(p.handleUnknownTool, 'error-back');
});
