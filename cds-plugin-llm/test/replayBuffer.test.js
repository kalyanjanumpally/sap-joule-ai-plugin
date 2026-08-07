const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_rb__';
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

const { replayBuffer } = require('../lib/middleware/replayBuffer');
const { wrapStreamCompletion } = require('../lib/streamCompletion');

function invoke(mw, {
  method = 'chat',
  request = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'ping' }] },
  meta = {},
  next = async () => ({ text: 'pong', usage: { input_tokens: 5, output_tokens: 10 }, model: 'gpt-4o-mini' }),
} = {}) {
  const ctx = { method, request, raw: request, meta };
  return { ctx, promise: mw(ctx, next) };
}

// ---- Input validation --------------------------------------------------

test('replayBuffer: throws on non-positive size', () => {
  assert.throws(() => replayBuffer({ size: 0 }),  /size must be/);
  assert.throws(() => replayBuffer({ size: -1 }), /size must be/);
  assert.throws(() => replayBuffer({ size: 1.5 }),/size must be/);
});

test('replayBuffer: throws on non-array redactFields', () => {
  assert.throws(() => replayBuffer({ redactFields: 'not-array' }), /redactFields must be/);
});

test('replayBuffer: throws on negative previewChars', () => {
  assert.throws(() => replayBuffer({ previewChars: -1 }), /previewChars must be/);
});

// ---- Successful calls captured ---------------------------------------

test('replayBuffer: captures successful chat call', async () => {
  const rb = replayBuffer({ size: 10 });
  await invoke(rb).promise;
  assert.equal(rb.size(), 1);
  const entry = rb.dump()[0];
  assert.equal(entry.ok, true);
  assert.equal(entry.method, 'chat');
  assert.equal(entry.model, 'gpt-4o-mini');
  assert.equal(entry.error, null);
  assert.equal(entry.response.textPreview, 'pong');
  assert.equal(entry.response.textLength, 4);
  assert.deepEqual(entry.response.usage, { input_tokens: 5, output_tokens: 10 });
  assert.ok(entry.timestamp > 0);
  assert.ok(entry.durationMs >= 0);
});

test('replayBuffer: default redaction hides messages + system + input', async () => {
  const rb = replayBuffer({ size: 10 });
  await invoke(rb, {
    request: {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'sensitive prompt' }],
      system: 'sensitive system',
      maxTokens: 100,
      temperature: 0.7,
    },
  }).promise;
  const entry = rb.dump()[0];
  assert.equal(entry.request.messages_redacted, true);
  assert.equal(entry.request.system_redacted, true);
  assert.equal(entry.request.messages, undefined);
  assert.equal(entry.request.system, undefined);
  // Non-redacted fields still present
  assert.equal(entry.request.model, 'gpt-4o-mini');
  assert.equal(entry.request.maxTokens, 100);
  assert.equal(entry.request.temperature, 0.7);
});

test('replayBuffer: custom redactFields override defaults', async () => {
  const rb = replayBuffer({ size: 10, redactFields: ['maxTokens'] });
  await invoke(rb, {
    request: { model: 'x', messages: [{ role: 'user', content: 'x' }], maxTokens: 100 },
  }).promise;
  const entry = rb.dump()[0];
  // Messages NOT redacted (not in custom list)
  assert.equal(entry.request.messages_redacted, undefined);
  assert.deepEqual(entry.request.messages, [{ role: 'user', content: 'x' }]);
  // maxTokens IS redacted
  assert.equal(entry.request.maxTokens_redacted, true);
});

test('replayBuffer: includeRedactedPreview captures last user message text (truncated)', async () => {
  const rb = replayBuffer({ size: 10, includeRedactedPreview: true, previewChars: 20 });
  const longText = 'A very long user message that should be truncated for the preview';
  await invoke(rb, {
    request: { model: 'x', messages: [{ role: 'user', content: longText }] },
  }).promise;
  const entry = rb.dump()[0];
  assert.equal(entry.request.messages_preview, longText.slice(0, 20));
  assert.equal(entry.request.messages_redacted, undefined);   // preview replaces redacted flag
});

// ---- Failed calls captured -------------------------------------------

test('replayBuffer: captures failed call with structured error', async () => {
  const rb = replayBuffer({ size: 10 });
  const err = Object.assign(new Error('boom'), { code: 'PROVIDER_ERR', primitive: 'test', retriable: true });
  await invoke(rb, { next: async () => { throw err; } }).promise.catch(() => {});
  const entry = rb.dump()[0];
  assert.equal(entry.ok, false);
  assert.equal(entry.response, null);
  assert.equal(entry.error.name, 'Error');
  assert.equal(entry.error.code, 'PROVIDER_ERR');
  assert.equal(entry.error.message, 'boom');
  assert.equal(entry.error.primitive, 'test');
  assert.equal(entry.error.retriable, true);
});

test('replayBuffer: preserves the original thrown error', async () => {
  const rb = replayBuffer({ size: 10 });
  const err = new Error('original');
  const caught = await invoke(rb, { next: async () => { throw err; } }).promise.catch((e) => e);
  assert.equal(caught, err);   // same reference re-thrown
});

// ---- Correlation ID captured -----------------------------------------

test('replayBuffer: captures correlationId from ctx.meta', async () => {
  const rb = replayBuffer({ size: 10 });
  await invoke(rb, { meta: { correlationId: 'req-abc-123' } }).promise;
  const entry = rb.dump()[0];
  assert.equal(entry.correlationId, 'req-abc-123');
});

test('replayBuffer: correlationId is null when not set', async () => {
  const rb = replayBuffer({ size: 10 });
  await invoke(rb).promise;
  assert.equal(rb.dump()[0].correlationId, null);
});

// ---- Circular buffer behavior ----------------------------------------

test('replayBuffer: rolls over after size limit', async () => {
  const rb = replayBuffer({ size: 3 });
  for (let i = 0; i < 5; i++) {
    await invoke(rb, { next: async () => ({ text: `msg-${i}`, model: 'x' }) }).promise;
  }
  const entries = rb.dump();
  assert.equal(entries.length, 3);
  // Should hold the LAST 3 (msg-2, msg-3, msg-4), oldest first
  assert.equal(entries[0].response.textPreview, 'msg-2');
  assert.equal(entries[1].response.textPreview, 'msg-3');
  assert.equal(entries[2].response.textPreview, 'msg-4');
  // Stats reflect ALL insertions
  assert.equal(rb.stats.totalCaptured, 5);
  assert.equal(rb.size(), 3);
});

test('replayBuffer: dumpLastN respects buffer bounds', async () => {
  const rb = replayBuffer({ size: 10 });
  for (let i = 0; i < 5; i++) {
    await invoke(rb, { next: async () => ({ text: `msg-${i}`, model: 'x' }) }).promise;
  }
  assert.equal(rb.dumpLastN(3).length, 3);
  assert.equal(rb.dumpLastN(10).length, 5);   // capped by count
  assert.equal(rb.dumpLastN(0).length, 0);
  const last3 = rb.dumpLastN(3);
  assert.equal(last3[0].response.textPreview, 'msg-2');
  assert.equal(last3[2].response.textPreview, 'msg-4');
});

test('replayBuffer: dumpMatching filters via predicate', async () => {
  const rb = replayBuffer({ size: 10 });
  await invoke(rb, { method: 'chat',   next: async () => ({ text: 'a' }) }).promise;
  await invoke(rb, { method: 'embed',  next: async () => ({ embeddings: [[]] }) }).promise;
  await invoke(rb, { method: 'chat',   next: async () => ({ text: 'b' }) }).promise;
  const chatOnly = rb.dumpMatching((e) => e.method === 'chat');
  assert.equal(chatOnly.length, 2);
});

// ---- Clear + stats ---------------------------------------------------

test('replayBuffer: clear() empties buffer + resets stats', async () => {
  const rb = replayBuffer({ size: 10 });
  await invoke(rb).promise;
  await invoke(rb).promise;
  assert.equal(rb.size(), 2);
  assert.equal(rb.stats.totalCaptured, 2);
  rb.clear();
  assert.equal(rb.size(), 0);
  assert.equal(rb.dump().length, 0);
  assert.equal(rb.stats.totalCaptured, 0);
  assert.equal(rb.stats.successes, 0);
});

test('replayBuffer: stats track successes vs failures', async () => {
  const rb = replayBuffer({ size: 10 });
  await invoke(rb).promise;
  await invoke(rb).promise;
  await invoke(rb, { next: async () => { throw new Error('fail'); } }).promise.catch(() => {});
  assert.equal(rb.stats.successes, 2);
  assert.equal(rb.stats.failures, 1);
  assert.equal(rb.stats.totalCaptured, 3);
});

// ---- Response summarization ------------------------------------------

test('replayBuffer: long response text is truncated in the summary', async () => {
  const rb = replayBuffer({ size: 10 });
  const longText = 'x'.repeat(500);
  await invoke(rb, { next: async () => ({ text: longText, model: 'x' }) }).promise;
  const entry = rb.dump()[0];
  assert.equal(entry.response.textPreview.length, 200);
  assert.equal(entry.response.textLength, 500);
  assert.match(entry.response.textPreview, /\.\.\.$/);
});

// ---- Stream capture (1.72+) ------------------------------------------

test('replayBuffer: captures stream from the final done chunk after full consumption', async () => {
  const rb = replayBuffer({ size: 10 });
  async function* fakeStream() {
    yield { type: 'text_delta', text: 'a' };
    yield { type: 'text_delta', text: 'b' };
    yield { type: 'done', text: 'ab', usage: { input_tokens: 3, output_tokens: 2 }, model: 'stream-model' };
  }
  const wrapped = wrapStreamCompletion(fakeStream());
  const { promise } = invoke(rb, { method: 'stream', next: async () => wrapped });
  const iter = await promise;
  // Nothing captured yet (stream not consumed)
  assert.equal(rb.size(), 0);
  // Consume
  for await (const _ of iter) {}
  // Now captured with the done chunk's summary
  assert.equal(rb.size(), 1);
  const entry = rb.dump()[0];
  assert.equal(entry.ok, true);
  assert.equal(entry.method, 'stream');
  assert.equal(entry.response.textPreview, 'ab');
  assert.deepEqual(entry.response.usage, { input_tokens: 3, output_tokens: 2 });
});

test('replayBuffer: captures stream error after mid-flow throw', async () => {
  const rb = replayBuffer({ size: 10 });
  async function* failingStream() {
    yield { type: 'text_delta', text: 'a' };
    throw Object.assign(new Error('stream broke'), { code: 'STREAM_FAIL' });
  }
  const wrapped = wrapStreamCompletion(failingStream());
  const { promise } = invoke(rb, { method: 'stream', next: async () => wrapped });
  const iter = await promise;
  await assert.rejects((async () => {
    for await (const _ of iter) {}
  })(), /stream broke/);
  assert.equal(rb.size(), 1);
  const entry = rb.dump()[0];
  assert.equal(entry.ok, false);
  assert.equal(entry.error.code, 'STREAM_FAIL');
});

test('replayBuffer: captureStreams=false skips stream capture', async () => {
  const rb = replayBuffer({ size: 10, captureStreams: false });
  async function* fakeStream() {
    yield { type: 'done', text: 'x', usage: {}, model: 'x' };
  }
  const wrapped = wrapStreamCompletion(fakeStream());
  const { promise } = invoke(rb, { method: 'stream', next: async () => wrapped });
  const iter = await promise;
  for await (const _ of iter) {}
  // With captureStreams:false, the middleware treats the envelope as a
  // regular response — captures it immediately at the middleware return.
  // The envelope IS the "response" from next() so it gets captured as
  // an entry with the envelope object.
  assert.equal(rb.size(), 1);
});

// ---- MCP resource ----------------------------------------------------

test('replayBuffer: asMcpResource() returns config://replay-buffer snapshot', async () => {
  const rb = replayBuffer({ size: 5 });
  await invoke(rb).promise;
  const res = rb.asMcpResource();
  assert.equal(res.uri, 'config://replay-buffer');
  assert.equal(res.mimeType, 'application/json');
  const snap = res.handler();
  assert.equal(snap.capacity, 5);
  assert.equal(snap.current, 1);
  assert.equal(snap.entries.length, 1);
  assert.deepEqual(snap.redactFields, ['messages', 'system', 'input']);
});

// ---- capacity + size --------------------------------------------------

test('replayBuffer: size() reports current entries, capacity() reports max', async () => {
  const rb = replayBuffer({ size: 3 });
  assert.equal(rb.capacity(), 3);
  assert.equal(rb.size(), 0);
  await invoke(rb).promise;
  assert.equal(rb.size(), 1);
});
