const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_fca__';
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
  functionCallArbitrator,
  InvalidToolCallError,
  normalizeToolShape,
  normalizeToolList,
} = require('../lib/middleware/functionCallArbitrator');

// ---- Helpers ----------------------------------------------------------

const LOOKUP_SCHEMA = {
  type: 'object',
  required: ['customerId'],
  properties: {
    customerId: { type: 'string' },
    fields:     { type: 'array', items: { type: 'string' } },
  },
};

function toolCall(name, input, id = 'c1') { return { id, name, input }; }
function ctxWith(request = {}) { return { request }; }

// ---- normalizeToolShape -----------------------------------------------

test('normalizeToolShape: Anthropic shape passes through', () => {
  const r = normalizeToolShape({
    name: 'lookup', description: 'x', input_schema: LOOKUP_SCHEMA,
  });
  assert.equal(r.name, 'lookup');
  assert.equal(r.description, 'x');
  assert.deepEqual(r.input_schema, LOOKUP_SCHEMA);
});

test('normalizeToolShape: OpenAI parameters → input_schema', () => {
  const r = normalizeToolShape({ name: 'lookup', parameters: LOOKUP_SCHEMA });
  assert.deepEqual(r.input_schema, LOOKUP_SCHEMA);
});

test('normalizeToolShape: schema alias also accepted', () => {
  const r = normalizeToolShape({ name: 'lookup', schema: LOOKUP_SCHEMA });
  assert.deepEqual(r.input_schema, LOOKUP_SCHEMA);
});

test('normalizeToolShape: Gemini functionDeclarations unwrapped', () => {
  const r = normalizeToolShape({
    functionDeclarations: [
      { name: 'a', parameters: { type: 'object' } },
      { name: 'b', parameters: { type: 'object' } },
    ],
  });
  assert.ok(Array.isArray(r));
  assert.equal(r.length, 2);
  assert.equal(r[0].name, 'a');
});

test('normalizeToolShape: no name → null', () => {
  assert.equal(normalizeToolShape({ description: 'x' }), null);
});

test('normalizeToolShape: not-an-object → null', () => {
  assert.equal(normalizeToolShape('x'), null);
  assert.equal(normalizeToolShape(null), null);
});

// ---- normalizeToolList ---------------------------------------------

test('normalizeToolList: mixed shapes normalize to canonical', () => {
  const r = normalizeToolList([
    { name: 'a', input_schema: { type: 'object' } },
    { name: 'b', parameters: { type: 'object' } },
    { functionDeclarations: [{ name: 'c', parameters: { type: 'object' } }] },
  ]);
  assert.deepEqual(r.map((t) => t.name), ['a', 'b', 'c']);
});

test('normalizeToolList: non-array pass-through', () => {
  assert.equal(normalizeToolList('x'), 'x');
});

// ---- Validation --------------------------------------------------

test('functionCallArbitrator: throws on non-array tools', () => {
  assert.throws(() => functionCallArbitrator({ tools: 'x' }), /must be an array/);
});
test('functionCallArbitrator: throws on tool without name', () => {
  assert.throws(() => functionCallArbitrator({ tools: [{ description: 'x' }] }), /name: string/);
});
test('functionCallArbitrator: throws on duplicate tool name', () => {
  assert.throws(() => functionCallArbitrator({
    tools: [{ name: 'a' }, { name: 'a' }],
  }), /duplicate/);
});
test('functionCallArbitrator: throws on invalid onInvalid', () => {
  assert.throws(() => functionCallArbitrator({ tools: [], onInvalid: 'bogus' }), /onInvalid/);
});
test('functionCallArbitrator: throws on non-function validator', () => {
  assert.throws(() => functionCallArbitrator({ tools: [], validator: 'x' }), /validator/);
});
test('functionCallArbitrator: throws on non-function callback', () => {
  assert.throws(() => functionCallArbitrator({ tools: [], onCall: 'x' }), /callbacks/);
});

// ---- Outbound normalization ---------------------------------

test('functionCallArbitrator: outbound tools normalized to input_schema', async () => {
  const mw = functionCallArbitrator({ tools: [] });
  const ctx = ctxWith({
    tools: [
      { name: 'a', parameters: LOOKUP_SCHEMA },
      { name: 'b', input_schema: LOOKUP_SCHEMA },
    ],
  });
  let seenTools;
  await mw(ctx, async () => { seenTools = ctx.request.tools; return {}; });
  assert.equal(seenTools[0].input_schema.type, 'object');
  assert.equal(seenTools[1].input_schema.type, 'object');
  assert.equal(seenTools[0].parameters, undefined);
  assert.equal(mw.stats.outboundNormalized, 1);
});

test('functionCallArbitrator: normalizeOutbound=false leaves tools alone', async () => {
  const mw = functionCallArbitrator({ tools: [], normalizeOutbound: false });
  const ctx = ctxWith({ tools: [{ name: 'a', parameters: LOOKUP_SCHEMA }] });
  let seenTools;
  await mw(ctx, async () => { seenTools = ctx.request.tools; return {}; });
  assert.equal(seenTools[0].parameters.type, 'object');   // not renamed
});

test('functionCallArbitrator: original request restored after call', async () => {
  const mw = functionCallArbitrator({ tools: [] });
  const ctx = ctxWith({ tools: [{ name: 'a', parameters: LOOKUP_SCHEMA }] });
  const original = ctx.request;
  await mw(ctx, async () => ({}));
  assert.equal(ctx.request, original);
});

// ---- Inbound validation: strip -------------------------

test('functionCallArbitrator: valid tool call passes through', async () => {
  const mw = functionCallArbitrator({
    tools: [{ name: 'lookup_customer', input_schema: LOOKUP_SCHEMA }],
  });
  const r = await mw(ctxWith(), async () => ({
    toolCalls: [toolCall('lookup_customer', { customerId: 'C-1' })],
  }));
  assert.equal(r.toolCalls.length, 1);
  assert.equal(mw.stats.validCalls, 1);
  assert.equal(mw.stats.invalidCalls, 0);
});

test('functionCallArbitrator: unknown tool stripped by default', async () => {
  const mw = functionCallArbitrator({
    tools: [{ name: 'known', input_schema: LOOKUP_SCHEMA }],
  });
  const r = await mw(ctxWith(), async () => ({
    toolCalls: [
      toolCall('known', { customerId: 'C-1' }, 'c1'),
      toolCall('unknown_tool', { foo: 'bar' }, 'c2'),
    ],
  }));
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].name, 'known');
  assert.equal(mw.stats.invalidCalls, 1);
  assert.equal(mw.stats.strippedCalls, 1);
  assert.equal(mw.stats.invalidReasonCounts['unknown-tool'], 1);
});

test('functionCallArbitrator: missing required arg stripped', async () => {
  const mw = functionCallArbitrator({
    tools: [{ name: 'lookup', input_schema: LOOKUP_SCHEMA }],
  });
  const r = await mw(ctxWith(), async () => ({
    toolCalls: [toolCall('lookup', { fields: ['name'] })],   // missing customerId
  }));
  assert.equal(r.toolCalls.length, 0);
  assert.equal(mw.stats.invalidReasonCounts['schema-violation'], 1);
});

test('functionCallArbitrator: wrong type stripped', async () => {
  const mw = functionCallArbitrator({
    tools: [{ name: 'lookup', input_schema: LOOKUP_SCHEMA }],
  });
  const r = await mw(ctxWith(), async () => ({
    toolCalls: [toolCall('lookup', { customerId: 12345 })],   // number, not string
  }));
  assert.equal(r.toolCalls.length, 0);
  assert.equal(mw.stats.invalidReasonCounts['schema-violation'], 1);
});

// ---- Inbound validation: throw -----------------------

test('functionCallArbitrator: onInvalid=throw raises InvalidToolCallError', async () => {
  const mw = functionCallArbitrator({
    tools: [{ name: 'lookup', input_schema: LOOKUP_SCHEMA }],
    onInvalid: 'throw',
  });
  await assert.rejects(
    mw(ctxWith(), async () => ({ toolCalls: [toolCall('unknown', {})] })),
    InvalidToolCallError,
  );
  assert.equal(mw.stats.thrownCalls, 1);
});

test('functionCallArbitrator: InvalidToolCallError carries call info', async () => {
  const mw = functionCallArbitrator({
    tools: [{ name: 'lookup', input_schema: LOOKUP_SCHEMA }],
    onInvalid: 'throw',
  });
  try {
    await mw(ctxWith(), async () => ({ toolCalls: [toolCall('unknown', {}, 'call-99')] }));
    assert.fail('should throw');
  } catch (err) {
    assert.equal(err.code, 'INVALID_TOOL_CALL');
    assert.equal(err.name, 'unknown');
    assert.equal(err.callId, 'call-99');
    assert.ok(err.errors.length > 0);
  }
});

// ---- Inbound validation: log -------------------------

test('functionCallArbitrator: onInvalid=log keeps invalid calls tagged', async () => {
  const mw = functionCallArbitrator({
    tools: [{ name: 'lookup', input_schema: LOOKUP_SCHEMA }],
    onInvalid: 'log',
  });
  const r = await mw(ctxWith(), async () => ({
    toolCalls: [
      toolCall('lookup',  { customerId: 'C-1' }, 'c1'),
      toolCall('unknown', {}, 'c2'),
    ],
  }));
  assert.equal(r.toolCalls.length, 2);
  assert.equal(r.toolCalls[0].invalid, undefined);
  assert.equal(r.toolCalls[1].invalid, true);
  assert.ok(Array.isArray(r.toolCalls[1].invalidErrors));
  assert.equal(mw.stats.loggedCalls, 1);
});

// ---- allowUnregistered --------------------------------

test('functionCallArbitrator: allowUnregistered=true → unknown tools accepted', async () => {
  const mw = functionCallArbitrator({
    tools: [{ name: 'known' }],
    allowUnregistered: true,
  });
  const r = await mw(ctxWith(), async () => ({
    toolCalls: [toolCall('unknown', { foo: 'x' })],
  }));
  assert.equal(r.toolCalls.length, 1);
  assert.equal(mw.stats.validCalls, 1);
});

// ---- No schema on registered tool → accept -------------

test('functionCallArbitrator: registered tool with no schema accepts any input', async () => {
  const mw = functionCallArbitrator({
    tools: [{ name: 'anything' }],   // no input_schema
  });
  const r = await mw(ctxWith(), async () => ({
    toolCalls: [toolCall('anything', { random: 'stuff' })],
  }));
  assert.equal(r.toolCalls.length, 1);
});

// ---- validateCalls=false --------------------------

test('functionCallArbitrator: validateCalls=false disables inbound validation', async () => {
  const mw = functionCallArbitrator({
    tools: [{ name: 'lookup', input_schema: LOOKUP_SCHEMA }],
    validateCalls: false,
    onInvalid: 'throw',
  });
  const r = await mw(ctxWith(), async () => ({
    toolCalls: [toolCall('unknown', {}), toolCall('lookup', {})],
  }));
  assert.equal(r.toolCalls.length, 2);
  assert.equal(mw.stats.inboundValidated, 0);
});

// ---- Malformed calls ------------------------------

test('functionCallArbitrator: not-an-object call classified as not-an-object', async () => {
  const mw = functionCallArbitrator({ tools: [] });
  const r = await mw(ctxWith(), async () => ({ toolCalls: ['not-an-object'] }));
  assert.equal(r.toolCalls.length, 0);
  assert.equal(mw.stats.invalidReasonCounts['not-an-object'], 1);
});

// ---- No tool calls in result -------------------------

test('functionCallArbitrator: no toolCalls → passthrough unchanged', async () => {
  const mw = functionCallArbitrator({ tools: [{ name: 'x' }] });
  const r = await mw(ctxWith(), async () => ({ text: 'just text' }));
  assert.equal(r.text, 'just text');
  assert.equal(mw.stats.inboundValidated, 0);
});

// ---- Callbacks --------------------------------------

test('functionCallArbitrator: onCall fires for each valid call', async () => {
  const events = [];
  const mw = functionCallArbitrator({
    tools: [{ name: 'a' }, { name: 'b' }],
    onCall: (i) => events.push(i.call.name),
  });
  await mw(ctxWith(), async () => ({
    toolCalls: [toolCall('a', {}), toolCall('b', {})],
  }));
  assert.deepEqual(events, ['a', 'b']);
});

test('functionCallArbitrator: onInvalidCall fires with reason', async () => {
  const events = [];
  const mw = functionCallArbitrator({
    tools: [{ name: 'known' }],
    onInvalidCall: (i) => events.push({ name: i.call.name, reason: i.reason }),
  });
  await mw(ctxWith(), async () => ({
    toolCalls: [toolCall('unknown', {})],
  }));
  assert.deepEqual(events, [{ name: 'unknown', reason: 'unknown-tool' }]);
});

test('functionCallArbitrator: callback throws swallowed', async () => {
  const mw = functionCallArbitrator({
    tools: [{ name: 'a' }],
    onCall: () => { throw new Error('x'); },
  });
  const r = await mw(ctxWith(), async () => ({ toolCalls: [toolCall('a', {})] }));
  assert.equal(r.toolCalls.length, 1);
});

// ---- Introspection + MCP + reset ------------------

test('functionCallArbitrator: listTools + getTool', () => {
  const mw = functionCallArbitrator({
    tools: [
      { name: 'lookup', input_schema: LOOKUP_SCHEMA },
      { name: 'notify' },
    ],
  });
  assert.deepEqual(mw.listTools(), ['lookup', 'notify']);
  const t = mw.getTool('lookup');
  assert.equal(t.name, 'lookup');
  assert.deepEqual(t.input_schema, LOOKUP_SCHEMA);
  assert.equal(mw.getTool('unknown'), null);
});

test('functionCallArbitrator: invalidRate reflects hit rate', async () => {
  const mw = functionCallArbitrator({ tools: [{ name: 'a' }] });
  await mw(ctxWith(), async () => ({
    toolCalls: [
      toolCall('a', {}),
      toolCall('unknown', {}),
      toolCall('a', {}),
      toolCall('unknown', {}),
    ],
  }));
  assert.equal(mw.invalidRate(), 0.5);
});

test('functionCallArbitrator: reset clears counters', async () => {
  const mw = functionCallArbitrator({ tools: [{ name: 'a' }] });
  await mw(ctxWith(), async () => ({ toolCalls: [toolCall('a', {})] }));
  assert.equal(mw.stats.validCalls, 1);
  mw.reset();
  assert.equal(mw.stats.validCalls, 0);
  assert.equal(mw.stats.callsByTool.a, undefined);
});

test('functionCallArbitrator: asMcpResource', () => {
  const mw = functionCallArbitrator({
    tools: [{ name: 'lookup', input_schema: LOOKUP_SCHEMA }],
    onInvalid: 'throw', allowUnregistered: true,
  });
  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://function-call-arbitrator');
  const p = r.handler();
  assert.deepEqual(p.registeredTools, ['lookup']);
  assert.equal(p.onInvalid, 'throw');
  assert.equal(p.allowUnregistered, true);
});
