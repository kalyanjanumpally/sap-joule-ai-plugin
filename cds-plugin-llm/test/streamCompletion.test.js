const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_sc__';
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

const { wrapStreamCompletion, hasStreamCompletion } = require('../lib/streamCompletion');
const { bulkhead } = require('../lib/middleware/bulkhead');
const { circuitBreaker } = require('../lib/middleware/circuitBreaker');
const { jsonLog } = require('../lib/middleware/jsonLog');
const LLMService = require('../lib/LLMService');

// Fake async iterable — yields text_delta chunks + a done chunk
async function* fakeStream({ chunks = 3, delay = 5, usage = { input_tokens: 10, output_tokens: 20 }, model = 'test' } = {}) {
  for (let i = 0; i < chunks; i++) {
    await new Promise((r) => setTimeout(r, delay));
    yield { type: 'text_delta', text: `chunk${i}` };
  }
  yield { type: 'done', text: 'chunk0chunk1chunk2', usage, model };
}

async function* failingStream({ afterN = 2, error }) {
  for (let i = 0; i < afterN; i++) {
    yield { type: 'text_delta', text: `c${i}` };
  }
  throw error ?? new Error('stream broke');
}

// ---- wrapStreamCompletion basics --------------------------------------

test('wrapStreamCompletion: yields all original chunks unchanged', async () => {
  const wrapped = wrapStreamCompletion(fakeStream({ chunks: 3 }));
  const collected = [];
  for await (const chunk of wrapped) collected.push(chunk);
  assert.equal(collected.length, 4);   // 3 deltas + 1 done
  assert.equal(collected[0].type, 'text_delta');
  assert.equal(collected[3].type, 'done');
});

test('wrapStreamCompletion: onComplete fires exactly once after stream ends', async () => {
  const wrapped = wrapStreamCompletion(fakeStream({ chunks: 3 }));
  const events = [];
  wrapped.onComplete((info) => events.push(info));
  for await (const _ of wrapped) { /* consume */ }
  assert.equal(events.length, 1);
  assert.equal(events[0].ok, true);
  assert.equal(events[0].chunkCount, 4);
  assert.equal(events[0].doneChunk.type, 'done');
  assert.ok(events[0].durationMs >= 0);
});

test('wrapStreamCompletion: onComplete fires with ok:false + error on stream throw', async () => {
  const err = Object.assign(new Error('broke'), { code: 'STREAM_ERR' });
  const wrapped = wrapStreamCompletion(failingStream({ afterN: 2, error: err }));
  const events = [];
  wrapped.onComplete((info) => events.push(info));
  await assert.rejects((async () => {
    for await (const _ of wrapped) { /* consume */ }
  })(), /broke/);
  assert.equal(events.length, 1);
  assert.equal(events[0].ok, false);
  assert.equal(events[0].error, err);
  assert.equal(events[0].chunkCount, 2);
});

test('wrapStreamCompletion: multiple onComplete subscribers all fire', async () => {
  const wrapped = wrapStreamCompletion(fakeStream({ chunks: 1 }));
  const events = [];
  wrapped.onComplete((info) => events.push({ tag: 'a', info }));
  wrapped.onComplete((info) => events.push({ tag: 'b', info }));
  wrapped.onComplete((info) => events.push({ tag: 'c', info }));
  for await (const _ of wrapped) {}
  assert.deepEqual(events.map((e) => e.tag), ['a', 'b', 'c']);
});

test('wrapStreamCompletion: onComplete registered AFTER stream done fires synchronously', async () => {
  const wrapped = wrapStreamCompletion(fakeStream({ chunks: 1 }));
  for await (const _ of wrapped) {}
  let called = false;
  wrapped.onComplete(() => { called = true; });
  assert.equal(called, true);
});

test('wrapStreamCompletion: subscriber exceptions are swallowed', async () => {
  const wrapped = wrapStreamCompletion(fakeStream({ chunks: 1 }));
  let secondFired = false;
  wrapped.onComplete(() => { throw new Error('broken subscriber'); });
  wrapped.onComplete(() => { secondFired = true; });
  for await (const _ of wrapped) {}
  assert.equal(secondFired, true);
});

test('wrapStreamCompletion: idempotent — wrapping an already-wrapped stream returns the same envelope', () => {
  const wrapped = wrapStreamCompletion(fakeStream({}));
  const twice = wrapStreamCompletion(wrapped);
  assert.equal(twice, wrapped);
});

test('hasStreamCompletion: true for wrapped, false for other objects', () => {
  const wrapped = wrapStreamCompletion(fakeStream({}));
  assert.equal(hasStreamCompletion(wrapped), true);
  assert.equal(hasStreamCompletion(null), false);
  assert.equal(hasStreamCompletion({}), false);
  assert.equal(hasStreamCompletion(fakeStream({})), false);   // plain iterable, no wrapper
});

// ---- Bulkhead + streams -----------------------------------------------

test('bulkhead + stream: slot held UNTIL stream is fully consumed', async () => {
  const bh = bulkhead({ maxConcurrent: 1, maxQueued: 0 });
  const ctx1 = { method: 'stream', service: { name: 'llm' }, meta: {} };
  const ctx2 = { method: 'stream', service: { name: 'llm' }, meta: {} };

  // Call 1: get the stream, but do NOT consume it yet
  const iter1 = await bh(ctx1, async () => wrapStreamCompletion(fakeStream({ chunks: 2, delay: 20 })));
  assert.equal(bh.state('llm').inFlight, 1);

  // Call 2: bulkhead should reject (slot still held by call 1's stream)
  await assert.rejects(
    bh(ctx2, async () => wrapStreamCompletion(fakeStream({ chunks: 1 }))),
    /queue is full/,
  );
  assert.equal(bh.state('llm').inFlight, 1);

  // Now CONSUME call 1's stream — slot should release
  for await (const _ of iter1) {}
  assert.equal(bh.state('llm').inFlight, 0);
});

test('bulkhead + stream: slot released on stream error', async () => {
  const bh = bulkhead({ maxConcurrent: 1, maxQueued: 0 });
  const ctx = { method: 'stream', service: { name: 'llm' }, meta: {} };
  const iter = await bh(ctx, async () => wrapStreamCompletion(failingStream({ afterN: 1, error: new Error('boom') })));
  assert.equal(bh.state('llm').inFlight, 1);
  await assert.rejects((async () => {
    for await (const _ of iter) {}
  })(), /boom/);
  assert.equal(bh.state('llm').inFlight, 0);
});

// ---- Circuit breaker + streams ---------------------------------------

test('circuitBreaker + stream: success recorded AFTER stream completes', async () => {
  const br = circuitBreaker({ threshold: 2, cooldownMs: 30_000 });
  const ctx = { method: 'stream', service: { name: 'llm' }, meta: {} };
  const iter = await br(ctx, async () => wrapStreamCompletion(fakeStream({ chunks: 2 })));
  // Before consumption: successes NOT yet recorded
  assert.equal(br.stats.successes, 0);
  for await (const _ of iter) {}
  // After consumption: success recorded
  assert.equal(br.stats.successes, 1);
});

test('circuitBreaker + stream: failure trips threshold via stream errors', async () => {
  const br = circuitBreaker({ threshold: 2, cooldownMs: 30_000 });
  const ctx = { method: 'stream', service: { name: 'llm' }, meta: {} };
  // 2 stream errors → circuit opens
  for (let i = 0; i < 2; i++) {
    const iter = await br(ctx, async () => wrapStreamCompletion(failingStream({
      afterN: 1, error: Object.assign(new Error('boom'), { status: 500 }),
    })));
    await assert.rejects((async () => {
      for await (const _ of iter) {}
    })(), /boom/);
  }
  assert.equal(br.state('llm').state, 'open');
  assert.equal(br.stats.opens, 1);
});

// ---- jsonLog + streams -----------------------------------------------

test('jsonLog + stream: log emitted ONCE at stream end with real duration + usage from done chunk', async () => {
  const events = [];
  const log = jsonLog({
    logger: { info: (p) => events.push({ level: 'info', payload: p }) },
  });
  const ctx = { method: 'stream', service: { name: 'llm' }, request: { model: 'test' }, raw: {}, meta: {} };
  const iter = await log(ctx, async () => wrapStreamCompletion(fakeStream({
    chunks: 3, delay: 5, usage: { input_tokens: 10, output_tokens: 20 }, model: 'test-final',
  })));
  // Before consumption: NO log emitted
  assert.equal(events.length, 0);
  for await (const _ of iter) {}
  // After: exactly one log line at info level
  assert.equal(events.length, 1);
  assert.equal(events[0].level, 'info');
  const p = events[0].payload;
  assert.equal(p.ok, true);
  assert.equal(p.method, 'stream');
  assert.equal(p.tokensIn, 10);
  assert.equal(p.tokensOut, 20);
  assert.equal(p.chunkCount, 4);   // 3 deltas + done
  assert.ok(p.durationMs >= 15);   // 3 × 5ms delay
});

test('jsonLog + stream: error log emitted ONCE at stream failure', async () => {
  const events = [];
  const log = jsonLog({
    logger: { info: () => {}, warn: (p) => events.push({ level: 'warn', payload: p }) },
  });
  const ctx = { method: 'stream', service: { name: 'llm' }, request: { model: 'test' }, raw: {}, meta: {} };
  const err = Object.assign(new Error('stream broke'), { code: 'STREAM_FAIL' });
  const iter = await log(ctx, async () => wrapStreamCompletion(failingStream({ afterN: 1, error: err })));
  await assert.rejects((async () => {
    for await (const _ of iter) {}
  })(), /stream broke/);
  assert.equal(events.length, 1);
  assert.equal(events[0].level, 'warn');
  const p = events[0].payload;
  assert.equal(p.ok, false);
  assert.equal(p.error.code, 'STREAM_FAIL');
  assert.equal(p.chunkCount, 1);   // 1 delta before throw
});

// ---- LLMService.stream() end-to-end ---------------------------------

test('LLMService.stream(): auto-wraps _streamCore so middleware sees a stream envelope', async () => {
  class StubService extends LLMService {
    async init() { await super.init(); }
    _streamCore() { return fakeStream({ chunks: 2 }); }
  }
  const svc = new StubService('llm', null, { modelId: 'stub', maxTokens: 200 });
  await svc.init();

  // Install bulkhead + log; verify they observe the stream properly
  const bh = bulkhead({ maxConcurrent: 5 });
  const events = [];
  const log = jsonLog({ logger: { info: (p) => events.push(p) } });
  svc.use(bh);
  svc.use(log);

  // Consume the stream
  const chunks = [];
  for await (const chunk of svc.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
    chunks.push(chunk);
  }
  assert.equal(chunks.length, 3);   // 2 deltas + done
  // Bulkhead slot released
  assert.equal(bh.state('llm').inFlight, 0);
  // Log fired once at stream end
  assert.equal(events.length, 1);
  assert.equal(events[0].method, 'stream');
});
