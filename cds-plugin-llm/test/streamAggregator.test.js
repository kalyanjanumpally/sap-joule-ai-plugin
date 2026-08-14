const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_sa__';
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
  streamAggregator,
  defaultExtractText,
  defaultMakeAggregatedChunk,
  isTerminalChunk,
} = require('../lib/middleware/streamAggregator');
const { wrapStreamCompletion, hasStreamCompletion } = require('../lib/streamCompletion');

// ---- Helpers ----------------------------------------------------------

/**
 * Build a stream from an array of chunks with optional per-chunk delay.
 * Returns a shipped wrapStreamCompletion-wrapped iterable so it looks
 * like a real provider stream.
 */
function makeStream(chunks, { delayMs = 0 } = {}) {
  const src = (async function* () {
    for (const c of chunks) {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      yield c;
    }
  })();
  return wrapStreamCompletion(src);
}

async function consume(stream) {
  const out = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

// ---- Standalone helpers -----------------------------------------------

test('defaultExtractText: plain string', () => {
  assert.equal(defaultExtractText('hi'), 'hi');
});
test('defaultExtractText: { text }', () => {
  assert.equal(defaultExtractText({ text: 'hi' }), 'hi');
});
test('defaultExtractText: null / other → null', () => {
  assert.equal(defaultExtractText(null), null);
  assert.equal(defaultExtractText({ notText: 'x' }), null);
});
test('defaultMakeAggregatedChunk: wraps text', () => {
  assert.deepEqual(defaultMakeAggregatedChunk('hello'), { text: 'hello' });
});

test('isTerminalChunk: various shapes', () => {
  assert.equal(isTerminalChunk({ done: true }), true);
  assert.equal(isTerminalChunk({ isDone: true }), true);
  assert.equal(isTerminalChunk({ type: 'done' }), true);
  assert.equal(isTerminalChunk({ finish_reason: 'stop' }), true);
  assert.equal(isTerminalChunk({ stopReason: 'end_turn' }), true);
  assert.equal(isTerminalChunk({ text: 'x' }), false);
  assert.equal(isTerminalChunk(null), false);
});

// ---- Validation ------------------------------------------------------

test('streamAggregator: throws on invalid minChars', () => {
  assert.throws(() => streamAggregator({ minChars: 0 }), /minChars/);
});
test('streamAggregator: throws on negative maxIdleMs', () => {
  assert.throws(() => streamAggregator({ maxIdleMs: -1 }), /maxIdleMs/);
});
test('streamAggregator: throws on non-array skipMethods', () => {
  assert.throws(() => streamAggregator({ skipMethods: 'x' }), /skipMethods/);
});
test('streamAggregator: throws on non-function extractText', () => {
  assert.throws(() => streamAggregator({ extractText: 'x' }), /extractText/);
});
test('streamAggregator: throws on non-function onFlush', () => {
  assert.throws(() => streamAggregator({ onFlush: 'x' }), /onFlush/);
});

// ---- Non-stream passthrough --------------------------------

test('streamAggregator: non-stream methods pass through unchanged', async () => {
  const mw = streamAggregator();
  const r = await mw({ method: 'chat' }, async () => ({ text: 'hello' }));
  assert.deepEqual(r, { text: 'hello' });
  assert.equal(mw.stats.totalStreams, 0);
});

test('streamAggregator: unwrapped iterables skipped (counted, unwrapped)', async () => {
  const mw = streamAggregator();
  // Plain async generator without wrapStreamCompletion.
  const raw = (async function* () { yield 'a'; yield 'b'; })();
  const r = await mw({ method: 'stream' }, async () => raw);
  assert.equal(r, raw);
  assert.equal(mw.stats.skippedStreams, 1);
});

// ---- Threshold flush -------------------------

test('streamAggregator: aggregates per-char chunks to minChars threshold', async () => {
  const mw = streamAggregator({ minChars: 5, maxIdleMs: 10000 });
  const src = makeStream(['H', 'e', 'l', 'l', 'o', ' ', 'W', 'o', 'r', 'l', 'd']);
  const out = await consume(await mw({ method: 'stream' }, async () => src));
  // 11 char chunks in, threshold=5 → chunks emitted at 5+ chars.
  // First flush after "Hello", buffer has " Worl", then " World" (6 chars) triggers.
  // Actually: "Hello" (5 chars) fires. Then " Worl" (5 chars) fires. Then "d" left → final.
  assert.deepEqual(out.map((c) => c.text), ['Hello', ' Worl', 'd']);
  assert.equal(mw.stats.totalSourceChunks, 11);
  assert.equal(mw.stats.totalEmittedChunks, 3);
});

test('streamAggregator: whole-word chunk at threshold emits immediately', async () => {
  const mw = streamAggregator({ minChars: 5, maxIdleMs: 10000 });
  const src = makeStream(['Hello World']);   // one big chunk
  const out = await consume(await mw({ method: 'stream' }, async () => src));
  assert.deepEqual(out.map((c) => c.text), ['Hello World']);
  assert.equal(mw.stats.threshFlushes, 1);
});

// ---- Final flush -----------------------

test('streamAggregator: buffer flushed as final chunk on stream end', async () => {
  const mw = streamAggregator({ minChars: 100, maxIdleMs: 100000 });
  const src = makeStream(['a', 'b', 'c']);
  const out = await consume(await mw({ method: 'stream' }, async () => src));
  assert.deepEqual(out.map((c) => c.text), ['abc']);
  assert.equal(mw.stats.finalFlushes, 1);
});

test('streamAggregator: empty source → no chunks emitted', async () => {
  const mw = streamAggregator();
  const src = makeStream([]);
  const out = await consume(await mw({ method: 'stream' }, async () => src));
  assert.deepEqual(out, []);
  assert.equal(mw.stats.totalEmittedChunks, 0);
});

// ---- Idle flush -----------------------

test('streamAggregator: idle timer flushes short buffer', async () => {
  const mw = streamAggregator({ minChars: 100, maxIdleMs: 20 });
  // 3 char chunks with 50ms gap → each idle-flushes before next arrives.
  const src = makeStream(['ab', 'cd', 'ef'], { delayMs: 50 });
  const out = await consume(await mw({ method: 'stream' }, async () => src));
  assert.deepEqual(out.map((c) => c.text), ['ab', 'cd', 'ef']);
  assert.ok(mw.stats.idleFlushes >= 2);
});

test('streamAggregator: maxIdleMs=0 disables idle flushing', async () => {
  const mw = streamAggregator({ minChars: 100, maxIdleMs: 0 });
  const src = makeStream(['ab', 'cd', 'ef'], { delayMs: 20 });
  const out = await consume(await mw({ method: 'stream' }, async () => src));
  // With no idle flush + threshold not met, everything buffers to final.
  assert.deepEqual(out.map((c) => c.text), ['abcdef']);
  assert.equal(mw.stats.idleFlushes, 0);
  assert.equal(mw.stats.finalFlushes, 1);
});

// ---- Terminal chunk handling -------------

test('streamAggregator: terminal chunk (done:true) passed through after buffer flush', async () => {
  const mw = streamAggregator({ minChars: 100, maxIdleMs: 100000 });
  const src = makeStream(['a', 'b', 'c', { done: true, finish_reason: 'stop' }]);
  const out = await consume(await mw({ method: 'stream' }, async () => src));
  // Buffer 'abc' flushed first, then terminal chunk passed through.
  assert.equal(out.length, 2);
  assert.equal(out[0].text, 'abc');
  assert.equal(out[1].done, true);
  assert.equal(mw.stats.passthroughChunks, 1);
});

test('streamAggregator: stopReason chunk treated as terminal', async () => {
  const mw = streamAggregator({ minChars: 100 });
  const src = makeStream(['x', 'y', { stopReason: 'end_turn' }]);
  const out = await consume(await mw({ method: 'stream' }, async () => src));
  assert.equal(out.length, 2);
  assert.equal(out[1].stopReason, 'end_turn');
});

// ---- Non-text chunks ---------------

test('streamAggregator: non-text chunks pass through after buffer flush', async () => {
  const mw = streamAggregator({ minChars: 100 });
  const src = makeStream(['abc', { toolCallDelta: { name: 'x' } }, 'def']);
  const out = await consume(await mw({ method: 'stream' }, async () => src));
  // 'abc' buffered → threshold not met → tool call arrives → buffer flushed, tool call passed → 'def' buffered → final flush.
  assert.equal(out.length, 3);
  assert.equal(out[0].text, 'abc');
  assert.deepEqual(out[1].toolCallDelta, { name: 'x' });
  assert.equal(out[2].text, 'def');
});

// ---- Preserves onComplete ----------

test('streamAggregator: wraps + preserves onComplete completion tracker', async () => {
  const mw = streamAggregator({ minChars: 10 });
  const src = makeStream(['a', 'b', 'c', { done: true }]);
  const wrapped = await mw({ method: 'stream' }, async () => src);
  assert.equal(hasStreamCompletion(wrapped), true);
  let completedInfo = null;
  wrapped.onComplete((info) => { completedInfo = info; });
  await consume(wrapped);
  assert.ok(completedInfo);
  assert.equal(completedInfo.ok, true);
});

// ---- Skip methods -------------

test('streamAggregator: default skipMethods (chat/embed/batch) pass through unchanged', async () => {
  const mw = streamAggregator();
  const stub = { text: 'x' };
  for (const method of ['chat', 'embed', 'batch']) {
    const r = await mw({ method }, async () => stub);
    assert.equal(r, stub);
  }
});

test('streamAggregator: custom skipMethods honored', async () => {
  const mw = streamAggregator({ skipMethods: ['custom'] });
  const src = makeStream(['abc']);
  const r = await mw({ method: 'custom' }, async () => src);
  // Passthrough: not wrapped.
  assert.equal(r, src);
});

// ---- Callbacks --------------

test('streamAggregator: onFlush fires with reason + size + text', async () => {
  const events = [];
  const mw = streamAggregator({
    minChars: 5, maxIdleMs: 100,
    onFlush: (i) => events.push(i),
  });
  const src = makeStream(['Hello', ' World']);
  await consume(await mw({ method: 'stream' }, async () => src));
  assert.ok(events.length >= 2);
  assert.ok(events.some((e) => e.reason === 'threshold'));
  assert.ok(events.every((e) => typeof e.text === 'string' && typeof e.size === 'number'));
});

test('streamAggregator: onFlush throw swallowed', async () => {
  const mw = streamAggregator({
    minChars: 3,
    onFlush: () => { throw new Error('bug'); },
  });
  const src = makeStream(['abc', 'def']);
  const out = await consume(await mw({ method: 'stream' }, async () => src));
  assert.equal(out.length, 2);
});

// ---- Stats + MCP -----------

test('streamAggregator: reductionRatio', async () => {
  const mw = streamAggregator({ minChars: 100, maxIdleMs: 100000 });
  const src = makeStream(['a', 'b', 'c', 'd', 'e']);
  await consume(await mw({ method: 'stream' }, async () => src));
  // 5 source chunks → 1 emitted (all coalesced to final). ratio = 1 - 1/5 = 0.8.
  assert.equal(mw.reductionRatio(), 0.8);
});

test('streamAggregator: reset clears counters', async () => {
  const mw = streamAggregator({ minChars: 100 });
  const src = makeStream(['a', 'b']);
  await consume(await mw({ method: 'stream' }, async () => src));
  assert.ok(mw.stats.totalStreams > 0);
  mw.reset();
  assert.equal(mw.stats.totalStreams, 0);
  assert.equal(mw.reductionRatio(), 0);
});

test('streamAggregator: asMcpResource', () => {
  const mw = streamAggregator({ minChars: 25, maxIdleMs: 150 });
  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://stream-aggregator');
  const p = r.handler();
  assert.equal(p.minChars, 25);
  assert.equal(p.maxIdleMs, 150);
  assert.deepEqual(p.skipMethods.sort(), ['batch', 'chat', 'embed']);
});

// ---- Custom extractText / makeChunk ------

test('streamAggregator: custom extractText handles delta.content shape (OpenAI-style)', async () => {
  const mw = streamAggregator({
    minChars: 5,
    extractText: (c) => c?.delta?.content ?? null,
  });
  const src = makeStream([
    { delta: { content: 'ab' } },
    { delta: { content: 'cd' } },
    { delta: { content: 'ef' } },
  ]);
  const out = await consume(await mw({ method: 'stream' }, async () => src));
  const combined = out.map((c) => c.text).join('');
  assert.equal(combined, 'abcdef');
});

test('streamAggregator: custom makeChunk shape', async () => {
  const mw = streamAggregator({
    minChars: 100,
    makeChunk: (text) => ({ role: 'assistant', content: text }),
  });
  const src = makeStream(['hi']);
  const out = await consume(await mw({ method: 'stream' }, async () => src));
  assert.deepEqual(out, [{ role: 'assistant', content: 'hi' }]);
});
