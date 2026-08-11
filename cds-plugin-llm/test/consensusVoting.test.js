const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_consensus__';
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
  consensusVoting,
  COMPARATORS,
  KNOWN_COMPARATORS,
  keyExact,
  keyNormalizedText,
  keyJsonDeep,
  canonicalJson,
} = require('../lib/consensusVoting');

// ---- Helpers ------------------------------------------------------------

function svc(chatFn) {
  return { chat: chatFn };
}

function svcReturning(text, model = 'test-model') {
  return svc(async () => ({ text, model, usage: {} }));
}

function svcThrowing(errMsg = 'provider down') {
  return svc(async () => { throw new Error(errMsg); });
}

// ---- Input validation ---------------------------------------------------

test('consensusVoting: throws on empty models', async () => {
  await assert.rejects(
    consensusVoting({ models: [], request: {} }),
    /models must be a non-empty array/,
  );
});
test('consensusVoting: throws on bad service', async () => {
  await assert.rejects(
    consensusVoting({ models: [{ service: {} }], request: {} }),
    /must be an LLMService/,
  );
});
test('consensusVoting: throws on missing request', async () => {
  await assert.rejects(
    consensusVoting({ models: [{ service: svcReturning('x') }] }),
    /request must be an object/,
  );
});
test('consensusVoting: throws on unknown comparator string', async () => {
  await assert.rejects(
    consensusVoting({
      models: [{ service: svcReturning('x') }],
      request: {}, comparator: 'nope',
    }),
    /comparator must be a function or one of/,
  );
});
test('consensusVoting: throws on non-function onBallot', async () => {
  await assert.rejects(
    consensusVoting({
      models: [{ service: svcReturning('x') }],
      request: {}, onBallot: 'x',
    }),
    /onBallot must be a function/,
  );
});
test('consensusVoting: throws on out-of-range quorum', async () => {
  await assert.rejects(
    consensusVoting({
      models: [{ service: svcReturning('x') }, { service: svcReturning('x') }],
      request: {}, quorum: 5,
    }),
    /quorum must be integer in/,
  );
});

// ---- Comparator functions -----------------------------------------------

test('keyExact: string response passes through', () => {
  assert.equal(keyExact('hello'), 'hello');
});
test('keyExact: response.text used', () => {
  assert.equal(keyExact({ text: 'hi', model: 'x' }), 'hi');
});
test('keyNormalizedText: trims + collapses + lowercases', () => {
  assert.equal(
    keyNormalizedText({ text: '  Hello  \n WORLD  ' }),
    'hello world',
  );
});
test('keyJsonDeep: canonicalizes key order', () => {
  const a = keyJsonDeep({ text: '{"b": 2, "a": 1}' });
  const b = keyJsonDeep({ text: '{"a": 1, "b": 2}' });
  assert.equal(a, b);
});
test('keyJsonDeep: falls back to normalized text on non-JSON', () => {
  assert.equal(keyJsonDeep({ text: 'not json' }), 'not json');
});
test('keyJsonDeep: extracts JSON from code fence', () => {
  const key = keyJsonDeep({ text: '```json\n{"x": 1}\n```' });
  assert.equal(key, canonicalJson({ x: 1 }));
});
test('canonicalJson: nested + arrays stable', () => {
  const s = canonicalJson({ b: [1, 2], a: { z: 1, y: 2 } });
  assert.equal(s, '{"a":{"y":2,"z":1},"b":[1,2]}');
});

test('KNOWN_COMPARATORS lists shipped comparators', () => {
  // KNOWN_COMPARATORS is frozen; slice() before sort so we don't mutate it.
  assert.deepEqual([...KNOWN_COMPARATORS].sort(), ['exact', 'json-deep', 'normalized-text']);
});

// ---- Happy paths --------------------------------------------------------

test('consensusVoting: 3-of-3 unanimous → consensus', async () => {
  const models = [
    { service: svcReturning('yes'), model: 'a' },
    { service: svcReturning('yes'), model: 'b' },
    { service: svcReturning('yes'), model: 'c' },
  ];
  const r = await consensusVoting({ models, request: { messages: [] } });
  assert.equal(r.verdict, 'consensus');
  assert.equal(r.response.text, 'yes');
  assert.equal(r.confidence, 1);
  assert.equal(r.quorum, 2);
  assert.equal(r.modelCount, 3);
  assert.equal(r.ballots.length, 3);
  assert.equal(r.ballots.every((b) => b.matched && b.ok), true);
  assert.equal(r.tallies.length, 1);
});

test('consensusVoting: 2-of-3 majority → consensus', async () => {
  const models = [
    { service: svcReturning('yes'), model: 'a' },
    { service: svcReturning('yes'), model: 'b' },
    { service: svcReturning('no'),  model: 'c' },
  ];
  const r = await consensusVoting({ models, request: { messages: [] } });
  assert.equal(r.verdict, 'consensus');
  assert.equal(r.response.text, 'yes');
  assert.ok(Math.abs(r.confidence - 2 / 3) < 0.01);
  assert.equal(r.ballots.find((b) => b.model === 'c').matched, false);
  assert.equal(r.tallies[0].count, 2);
});

test('consensusVoting: 3-way tie → no-consensus (majority quorum unreachable)', async () => {
  const models = [
    { service: svcReturning('yes'), model: 'a' },
    { service: svcReturning('no'),  model: 'b' },
    { service: svcReturning('maybe'), model: 'c' },
  ];
  const r = await consensusVoting({ models, request: {} });
  assert.equal(r.verdict, 'no-consensus');
  assert.equal(r.tallies.length, 3);
  assert.equal(r.tallies.every((t) => t.count === 1), true);
});

test('consensusVoting: 2-2-1 → plurality', async () => {
  const models = [
    { service: svcReturning('yes'), model: 'a' },
    { service: svcReturning('yes'), model: 'b' },
    { service: svcReturning('no'),  model: 'c' },
    { service: svcReturning('no'),  model: 'd' },
    { service: svcReturning('maybe'), model: 'e' },
  ];
  // Default quorum for 5 = 3. Top is 2 → below quorum but only tied for top? No — 'yes' and 'no' both have 2, 'maybe' has 1.
  // Actually the top two are tied at 2 → NOT plurality (needs strict lead). Verdict is 'no-consensus'.
  const r = await consensusVoting({ models, request: {} });
  assert.equal(r.verdict, 'no-consensus');
});

test('consensusVoting: plurality when clear leader without quorum', async () => {
  const models = [
    { service: svcReturning('yes'), model: 'a' },
    { service: svcReturning('yes'), model: 'b' },
    { service: svcReturning('no'),  model: 'c' },
  ];
  // 2 yes / 1 no. Default quorum for 3 = 2 → consensus. Force quorum=3 → plurality.
  const r = await consensusVoting({ models, request: {}, quorum: 3 });
  assert.equal(r.verdict, 'plurality');
  assert.equal(r.response.text, 'yes');
});

test('consensusVoting: all fail → all-failed', async () => {
  const models = [
    { service: svcThrowing('down'), model: 'a' },
    { service: svcThrowing('down'), model: 'b' },
  ];
  const r = await consensusVoting({ models, request: {} });
  assert.equal(r.verdict, 'all-failed');
  assert.equal(r.response, null);
  assert.equal(r.confidence, 0);
  assert.equal(r.ballots.every((b) => !b.ok), true);
});

test('consensusVoting: mixed ok/fail — ok ballots still count', async () => {
  const models = [
    { service: svcReturning('yes'), model: 'a' },
    { service: svcThrowing(),       model: 'b' },
    { service: svcReturning('yes'), model: 'c' },
  ];
  const r = await consensusVoting({ models, request: {}, quorum: 2 });
  assert.equal(r.verdict, 'consensus');
  assert.equal(r.response.text, 'yes');
});

// ---- Comparator string param --------------------------------------------

test('consensusVoting: default comparator is normalized-text', async () => {
  const models = [
    { service: svcReturning('Hello World'), model: 'a' },
    { service: svcReturning('hello world'), model: 'b' },   // same when normalized
    { service: svcReturning('goodbye'),     model: 'c' },
  ];
  const r = await consensusVoting({ models, request: {}, quorum: 2 });
  assert.equal(r.verdict, 'consensus');
});

test('consensusVoting: exact comparator distinguishes case', async () => {
  const models = [
    { service: svcReturning('Hello World'), model: 'a' },
    { service: svcReturning('hello world'), model: 'b' },
    { service: svcReturning('goodbye'),     model: 'c' },
  ];
  const r = await consensusVoting({ models, request: {}, comparator: 'exact' });
  assert.equal(r.verdict, 'no-consensus');   // all 3 unique under exact
});

test('consensusVoting: json-deep comparator collapses key order', async () => {
  const models = [
    { service: svcReturning('{"b":2,"a":1}'), model: 'a' },
    { service: svcReturning('{"a":1,"b":2}'), model: 'b' },
    { service: svcReturning('{"a":9}'),       model: 'c' },
  ];
  const r = await consensusVoting({ models, request: {}, comparator: 'json-deep', quorum: 2 });
  assert.equal(r.verdict, 'consensus');
});

test('consensusVoting: custom comparator function', async () => {
  // Compare only the length bucket ("short" vs "long").
  const models = [
    { service: svcReturning('a'), model: 'a' },
    { service: svcReturning('b'), model: 'b' },
    { service: svcReturning('longer answer here'), model: 'c' },
  ];
  const r = await consensusVoting({
    models, request: {}, quorum: 2,
    comparator: (response) => response.text.length < 10 ? 'short' : 'long',
  });
  assert.equal(r.verdict, 'consensus');
  assert.equal(r.tallies[0].key, 'short');
  assert.equal(r.tallies[0].count, 2);
});

// ---- Per-model model override ------------------------------------------

test('consensusVoting: per-model model override propagates', async () => {
  const captured = [];
  const models = [
    { service: svc(async (req) => { captured.push(req.model); return { text: 'x' }; }),
      model: 'gpt-4o' },
    { service: svc(async (req) => { captured.push(req.model); return { text: 'x' }; }),
      model: 'claude-opus-4-7' },
  ];
  await consensusVoting({ models, request: { messages: [] } });
  assert.deepEqual(captured.sort(), ['claude-opus-4-7', 'gpt-4o']);
});

// ---- onBallot callback -------------------------------------------------

test('consensusVoting: onBallot fires once per model, ok + fail', async () => {
  const events = [];
  const models = [
    { service: svcReturning('yes'), model: 'a' },
    { service: svcThrowing('boom'), model: 'b' },
  ];
  await consensusVoting({
    models, request: {},
    onBallot: (info) => events.push(info),
  });
  assert.equal(events.length, 2);
  const okEvent = events.find((e) => e.ok);
  const failEvent = events.find((e) => !e.ok);
  assert.equal(okEvent.model, 'a');
  assert.equal(failEvent.model, 'b');
  assert.match(failEvent.error, /boom/);
});

test('consensusVoting: onBallot error swallowed', async () => {
  const models = [{ service: svcReturning('yes'), model: 'a' }];
  const r = await consensusVoting({
    models, request: {},
    onBallot: () => { throw new Error('broken listener'); },
  });
  assert.equal(r.verdict, 'consensus');
});

// ---- Timeout -----------------------------------------------------------

test('consensusVoting: timeoutMs enforced per model', async () => {
  const models = [
    { service: svc(async () => new Promise(() => {})), model: 'slow' },
    { service: svcReturning('yes'), model: 'fast' },
  ];
  const r = await consensusVoting({
    models, request: {}, timeoutMs: 50,
  });
  const slowBallot = r.ballots.find((b) => b.model === 'slow');
  assert.equal(slowBallot.ok, false);
  assert.match(slowBallot.error, /timed out after 50ms/);
});

// ---- Ballot durations tracked -----------------------------------------

test('consensusVoting: ballots record durationMs', async () => {
  const models = [
    { service: svc(async () => { await new Promise((r) => setTimeout(r, 5)); return { text: 'x' }; }), model: 'a' },
  ];
  const r = await consensusVoting({ models, request: {} });
  assert.ok(r.ballots[0].durationMs >= 0);
});
