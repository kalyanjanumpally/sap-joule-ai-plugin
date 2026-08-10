const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_throttle__';
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

const { streamThrottle, defaultCountTokens } = require('../lib/middleware/streamThrottle');
const { wrapStreamCompletion, hasStreamCompletion } = require('../lib/streamCompletion');

// ---- Input validation --------------------------------------------------

test('streamThrottle: throws on invalid maxTokensPerSecond', () => {
  assert.throws(() => streamThrottle({ maxTokensPerSecond: 0 }), /maxTokensPerSecond must be > 0/);
  assert.throws(() => streamThrottle({ maxTokensPerSecond: -5 }), /maxTokensPerSecond must be > 0/);
});
test('streamThrottle: throws on non-function countTokens', () => {
  assert.throws(() => streamThrottle({ countTokens: 'x' }), /countTokens must be a function/);
});
test('streamThrottle: throws on non-array skipMethods', () => {
  assert.throws(() => streamThrottle({ skipMethods: 'chat' }), /skipMethods must be an array/);
});
test('streamThrottle: throws on non-function onDelay', () => {
  assert.throws(() => streamThrottle({ onDelay: 'x' }), /onDelay must be a function/);
});

// ---- defaultCountTokens ------------------------------------------------

test('defaultCountTokens: chunk.text → chars/4', () => {
  assert.equal(defaultCountTokens({ text: 'abcd' }), 1);          // 4 chars = 1 token
  assert.equal(defaultCountTokens({ text: 'abcdefghijklmnop' }), 4); // 16 chars = 4 tokens
});
test('defaultCountTokens: string chunk', () => {
  assert.equal(defaultCountTokens('abcdefgh'), 2);
});
test('defaultCountTokens: no text → 0', () => {
  assert.equal(defaultCountTokens({}), 0);
  assert.equal(defaultCountTokens(null), 0);
});

// ---- Pass-through paths ------------------------------------------------

test('streamThrottle: non-stream method passes through', async () => {
  const mw = streamThrottle();
  const r = await mw({ method: 'chat', request: {}, meta: {} }, async () => ({ text: 'ok' }));
  assert.equal(r.text, 'ok');
  assert.equal(mw.stats.totalStreams, 0);
});

test('streamThrottle: unwrapped async iterable → passes through with stats.skippedStreams++', async () => {
  const mw = streamThrottle();
  async function* raw() {
    yield { text: 'a' };
    yield { text: 'b' };
  }
  const iter = raw();
  const result = await mw({ method: 'stream', request: {}, meta: {} }, async () => iter);
  // Not throttled — same iterator returned.
  assert.equal(result, iter);
  assert.equal(mw.stats.skippedStreams, 1);
});

// ---- Throttled iteration ----------------------------------------------

test('streamThrottle: throttles chunks based on tokens/second', async () => {
  let clock = 0;
  const sleeps = [];
  const mw = streamThrottle({
    maxTokensPerSecond: 10,   // → 100 ms/token
    now:   () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
  });

  const stream = wrapStreamCompletion(async function* () {
    // Each chunk has 4 chars → 1 token → target 100ms between chunks.
    yield { type: 'text-delta', text: 'abcd' };
    yield { type: 'text-delta', text: 'efgh' };
    yield { type: 'text-delta', text: 'ijkl' };
    yield { type: 'done', text: 'abcdefghijkl' };
  }());

  const result = await mw({ method: 'stream', request: {}, meta: {} }, async () => stream);
  const chunks = [];
  for await (const chunk of result) chunks.push(chunk);

  assert.equal(chunks.length, 4);
  assert.equal(mw.stats.totalStreams, 1);
  assert.equal(mw.stats.totalChunks, 4);
  // Rough token count: 4 chunks × 1 token each + last chunk includes accumulated text.
  // Delays only fire when actual < target. With clock frozen, first delay = 100ms,
  // then 100ms, etc.
  assert.ok(sleeps.length >= 3);
  assert.ok(mw.stats.totalDelayMs > 0);
});

test('streamThrottle: no delay AFTER first chunk when provider is slower', async () => {
  let clock = 0;
  const sleeps = [];
  const mw = streamThrottle({
    maxTokensPerSecond: 100,   // 10ms/token
    now:   () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
  });

  const stream = wrapStreamCompletion((async function* () {
    yield { type: 'text-delta', text: 'abcd' };
    clock += 500;   // provider takes 500ms between chunks
    yield { type: 'text-delta', text: 'efgh' };
    clock += 500;
    yield { type: 'done', text: 'abcdefgh' };
  })());

  const result = await mw({ method: 'stream', request: {}, meta: {} }, async () => stream);
  const chunks = [];
  for await (const chunk of result) chunks.push(chunk);
  assert.equal(chunks.length, 3);
  // First chunk gets msPerToken=10ms delay (no info yet); subsequent chunks
  // arrive well after target → 0 delay.
  assert.ok(sleeps[0] <= 10);
  for (let i = 1; i < sleeps.length; i++) assert.equal(sleeps[i], 0);
});

test('streamThrottle: custom countTokens', async () => {
  const mw = streamThrottle({
    maxTokensPerSecond: 100,
    countTokens: (chunk) => chunk?.tokenCount ?? 0,
    now: () => 0,
    sleep: async () => {},
  });
  const stream = wrapStreamCompletion(async function* () {
    yield { type: 'text-delta', text: 'a', tokenCount: 5 };
    yield { type: 'done', text: 'a', tokenCount: 5 };
  }());
  const result = await mw({ method: 'stream', request: {}, meta: {} }, async () => stream);
  for await (const _ of result) { /* drain */ }
  assert.equal(mw.stats.totalTokens, 10);
});

test('streamThrottle: onDelay fires with info', async () => {
  const events = [];
  let clock = 0;
  const mw = streamThrottle({
    maxTokensPerSecond: 10,
    onDelay: (info) => events.push(info),
    now:   () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  const stream = wrapStreamCompletion(async function* () {
    yield { type: 'text-delta', text: 'abcd' };
    yield { type: 'text-delta', text: 'efgh' };
    yield { type: 'done', text: 'abcdefgh' };
  }());
  const result = await mw({ method: 'stream', request: {}, meta: {} }, async () => stream);
  for await (const _ of result) { /* drain */ }
  assert.ok(events.length >= 2);
  assert.ok(events[0].delayMs > 0);
  assert.ok(events[0].tokensEmitted > 0);
});

test('streamThrottle: onDelay error swallowed', async () => {
  let clock = 0;
  const mw = streamThrottle({
    maxTokensPerSecond: 10,
    onDelay: () => { throw new Error('broken listener'); },
    now:   () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  const stream = wrapStreamCompletion(async function* () {
    yield { type: 'text-delta', text: 'abcd' };
    yield { type: 'done', text: 'abcd' };
  }());
  const result = await mw({ method: 'stream', request: {}, meta: {} }, async () => stream);
  const chunks = [];
  for await (const c of result) chunks.push(c);
  assert.equal(chunks.length, 2);
});

// ---- Preserves completion tracker -------------------------------------

test('streamThrottle: preserves hasStreamCompletion + onComplete', async () => {
  const mw = streamThrottle({
    maxTokensPerSecond: 100,
    now: () => 0,
    sleep: async () => {},
  });
  const stream = wrapStreamCompletion(async function* () {
    yield { type: 'text-delta', text: 'a' };
    yield { type: 'done', text: 'a', model: 'x' };
  }());
  const result = await mw({ method: 'stream', request: {}, meta: {} }, async () => stream);
  assert.equal(hasStreamCompletion(result), true);
  let completeInfo;
  result.onComplete((info) => { completeInfo = info; });

  for await (const _ of result) { /* drain */ }
  await new Promise((r) => setTimeout(r, 10));

  assert.ok(completeInfo);
  assert.equal(completeInfo.ok, true);
  assert.equal(completeInfo.doneChunk?.model, 'x');
});

test('streamThrottle: preserves isCompleted / completedInfo getters', async () => {
  const mw = streamThrottle({
    maxTokensPerSecond: 100,
    now: () => 0,
    sleep: async () => {},
  });
  const stream = wrapStreamCompletion(async function* () {
    yield { type: 'done', text: 'a' };
  }());
  const result = await mw({ method: 'stream', request: {}, meta: {} }, async () => stream);
  assert.equal(result.isCompleted, false);
  for await (const _ of result) { /* drain */ }
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(result.isCompleted, true);
  assert.ok(result.completedInfo);
});

// ---- Skip methods ---------------------------------------------------

test('streamThrottle: custom skipMethods', async () => {
  const mw = streamThrottle({
    maxTokensPerSecond: 100,
    skipMethods: [],   // don't skip anything — throttle all methods
    now: () => 0,
    sleep: async () => {},
  });
  const stream = wrapStreamCompletion(async function* () {
    yield { type: 'done', text: 'a' };
  }());
  // Even chat is throttled now (though the wrapped stream is what makes it apply).
  const result = await mw({ method: 'stream', request: {}, meta: {} }, async () => stream);
  for await (const _ of result) { /* drain */ }
  assert.equal(mw.stats.totalStreams, 1);
});

// ---- MCP + reset ---------------------------------------------------

test('streamThrottle: asMcpResource', () => {
  const mw = streamThrottle({ maxTokensPerSecond: 40 });
  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://stream-throttle');
  const p = r.handler();
  assert.equal(p.maxTokensPerSecond, 40);
  assert.equal(p.msPerToken, 25);
});

test('streamThrottle: reset clears counters', async () => {
  let clock = 0;
  const mw = streamThrottle({
    maxTokensPerSecond: 10,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  const stream = wrapStreamCompletion(async function* () {
    yield { type: 'text-delta', text: 'abcd' };
    yield { type: 'done', text: 'abcd' };
  }());
  const result = await mw({ method: 'stream', request: {}, meta: {} }, async () => stream);
  for await (const _ of result) { /* drain */ }
  assert.ok(mw.stats.totalChunks > 0);
  mw.reset();
  assert.equal(mw.stats.totalChunks, 0);
  assert.equal(mw.stats.totalStreams, 0);
});

// ---- End-to-end: chunks emit at expected times ---------------------

test('streamThrottle: end-to-end timing at 10 tok/sec target', async () => {
  let clock = 0;
  const yieldTimes = [];
  const mw = streamThrottle({
    maxTokensPerSecond: 10,   // 100ms per token
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  const stream = wrapStreamCompletion(async function* () {
    // 4 chunks × 1 token each.
    yield { type: 'text-delta', text: 'abcd' };
    yield { type: 'text-delta', text: 'efgh' };
    yield { type: 'text-delta', text: 'ijkl' };
    yield { type: 'done', text: 'abcdefghijkl' };
  }());
  const result = await mw({ method: 'stream', request: {}, meta: {} }, async () => stream);
  for await (const _ of result) {
    yieldTimes.push(clock);
  }
  // Chunk 1: should be delayed to reach 100ms (1 token)
  // Chunk 2: 200ms; Chunk 3: 300ms; Chunk 4 (done, +9 tokens for the accumulated done): jumps
  assert.equal(yieldTimes[0], 100);
  assert.equal(yieldTimes[1], 200);
  assert.equal(yieldTimes[2], 300);
});
