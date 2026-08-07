const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_testing__';
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

const { fakeLLM } = require('../lib/testing');
const { circuitBreaker } = require('../lib/middleware/circuitBreaker');
const { bulkhead } = require('../lib/middleware/bulkhead');

// ---- Input validation --------------------------------------------------

test('fakeLLM: throws on non-array scripts', () => {
  assert.throws(() => fakeLLM({ scripts: 'foo' }), /scripts must be an array/);
});

test('fakeLLM: throws on malformed script entry', () => {
  assert.throws(() => fakeLLM({ scripts: [{ respond: {} }] }), /when is required/);
  assert.throws(() => fakeLLM({ scripts: [{ when: {} }] }),    /respond is required/);
});

test('fakeLLM: throws on invalid failRate / delayMs', () => {
  assert.throws(() => fakeLLM({ failRate: -0.1 }), /failRate/);
  assert.throws(() => fakeLLM({ failRate: 1.5 }),  /failRate/);
  assert.throws(() => fakeLLM({ delayMs: -1 }),    /delayMs/);
});

// ---- Basic chat scripting ---------------------------------------------

test('fakeLLM: chat with object matcher — method+matches', async () => {
  const fake = fakeLLM({
    scripts: [
      { when: { method: 'chat', matches: /purchase order/i },
        respond: { text: 'PO summary', usage: { input_tokens: 10, output_tokens: 20 } } },
    ],
    defaultResponse: { text: 'fallback' },
  });
  const res = await fake.chat({ messages: [{ role: 'user', content: 'summarize this purchase order' }] });
  assert.equal(res.text, 'PO summary');
  assert.equal(res.usage.input_tokens, 10);
  assert.equal(res.model, 'fake-model');   // default modelId injected
});

test('fakeLLM: chat with model matcher', async () => {
  const fake = fakeLLM({
    scripts: [
      { when: { model: 'gpt-4o' }, respond: { text: 'from gpt-4o' } },
    ],
    defaultResponse: { text: 'default' },
  });
  const withMatch = await fake.chat({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
  const noMatch   = await fake.chat({ model: 'other',  messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(withMatch.text, 'from gpt-4o');
  assert.equal(noMatch.text,   'default');
});

test('fakeLLM: predicate matcher — full req + method access', async () => {
  const fake = fakeLLM({
    scripts: [
      { when: (req, method) => method === 'chat' && req.messages.length > 3,
        respond: (req) => ({ text: `long conv: ${req.messages.length} msgs`, usage: { input_tokens: 0, output_tokens: 0 } }) },
    ],
    defaultResponse: { text: 'short' },
  });
  const short = await fake.chat({ messages: [{ role: 'user', content: 'hi' }] });
  const long  = await fake.chat({ messages: [
    { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' },
    { role: 'user', content: 'c' }, { role: 'assistant', content: 'd' },
    { role: 'user', content: 'e' },
  ]});
  assert.equal(short.text, 'short');
  assert.equal(long.text, 'long conv: 5 msgs');
});

// ---- respond as fn — receives req/method ------------------------------

test('fakeLLM: respond fn receives request + method', async () => {
  const fake = fakeLLM({
    scripts: [
      { when: () => true, respond: (req, method) => ({ text: `${method}: ${req.messages[0].content}` }) },
    ],
  });
  const res = await fake.chat({ messages: [{ role: 'user', content: 'echo me' }] });
  assert.equal(res.text, 'chat: echo me');
});

// ---- Default response --------------------------------------------------

test('fakeLLM: no matching script + defaultResponse → default returned', async () => {
  const fake = fakeLLM({
    scripts: [{ when: { model: 'never-matches' }, respond: { text: 'nope' } }],
    defaultResponse: { text: 'default', usage: { input_tokens: 5, output_tokens: 5 } },
  });
  const res = await fake.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.text, 'default');
  assert.equal(res.usage.input_tokens, 5);
});

test('fakeLLM: no matching script + no defaultResponse → returns empty text stub (non-strict)', async () => {
  const fake = fakeLLM({});
  const res = await fake.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.text, '');
  assert.deepEqual(res.usage, { input_tokens: 0, output_tokens: 0 });
});

test('fakeLLM: strict mode throws when no match + no default', async () => {
  const fake = fakeLLM({ strict: true });
  await assert.rejects(
    fake.chat({ messages: [{ role: 'user', content: 'hi' }] }),
    /no matching script/,
  );
});

// ---- Embed / stream --------------------------------------------------

test('fakeLLM: embed method — scripted response', async () => {
  const fake = fakeLLM({
    scripts: [{ when: { method: 'embed' }, respond: { embeddings: [[0.1, 0.2, 0.3]], usage: { input_tokens: 5 } } }],
  });
  const res = await fake.embed({ input: 'hello' });
  assert.deepEqual(res.embeddings, [[0.1, 0.2, 0.3]]);
});

test('fakeLLM: stream method — yields text_delta + done', async () => {
  const fake = fakeLLM({
    scripts: [{ when: { method: 'stream' }, respond: { text: 'streamed reply', usage: { input_tokens: 3, output_tokens: 4 } } }],
  });
  const chunks = [];
  for await (const chunk of fake.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
    chunks.push(chunk);
  }
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].type, 'text_delta');
  assert.equal(chunks[0].text, 'streamed reply');
  assert.equal(chunks[1].type, 'done');
  assert.equal(chunks[1].text, 'streamed reply');
  assert.deepEqual(chunks[1].usage, { input_tokens: 3, output_tokens: 4 });
});

// ---- Call history ----------------------------------------------------

test('fakeLLM: calls capture full history — request / response / timestamp / durationMs', async () => {
  const fake = fakeLLM({ defaultResponse: { text: 'ok' } });
  await fake.chat({ messages: [{ role: 'user', content: 'hi 1' }] });
  await fake.chat({ messages: [{ role: 'user', content: 'hi 2' }] });
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[0].method, 'chat');
  assert.equal(fake.calls[0].request.messages[0].content, 'hi 1');
  assert.equal(fake.calls[0].response.text, 'ok');
  assert.ok(typeof fake.calls[0].timestamp === 'number');
  assert.ok(typeof fake.calls[0].durationMs === 'number');
});

test('fakeLLM: lastCall + callsMatching + reset', async () => {
  const fake = fakeLLM({ defaultResponse: { text: 'ok' } });
  await fake.chat({ messages: [{ role: 'user', content: 'a' }] });
  await fake.embed({ input: 'b' });
  await fake.chat({ messages: [{ role: 'user', content: 'c' }] });
  const chats = fake.callsMatching((c) => c.method === 'chat');
  assert.equal(chats.length, 2);
  assert.equal(fake.lastCall().method, 'chat');
  assert.equal(fake.lastCall().request.messages[0].content, 'c');
  fake.reset();
  assert.equal(fake.calls.length, 0);
  assert.equal(fake.lastCall(), null);
});

// ---- Failure injection -----------------------------------------------

test('fakeLLM: failRate 1.0 → always fails with failWith error', async () => {
  const fake = fakeLLM({
    failRate: 1.0,
    failWith: () => Object.assign(new Error('sim 429'), { status: 429 }),
  });
  await assert.rejects(
    fake.chat({ messages: [{ role: 'user', content: 'hi' }] }),
    (err) => {
      assert.equal(err.message, 'sim 429');
      assert.equal(err.status, 429);
      return true;
    },
  );
  // Failed call still recorded
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].error.message, 'sim 429');
});

test('fakeLLM: delayMs adds latency', async () => {
  const fake = fakeLLM({ defaultResponse: { text: 'ok' }, delayMs: 50 });
  const startedAt = Date.now();
  await fake.chat({ messages: [{ role: 'user', content: 'hi' }] });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 40, `expected ≥40ms, got ${elapsed}ms`);
});

// ---- Middleware compatibility ---------------------------------------

test('fakeLLM: llm.use() works — middleware runs before scripted provider', async () => {
  const fake = fakeLLM({ defaultResponse: { text: 'ok' } });
  const observations = [];
  fake.use(async (ctx, next) => {
    observations.push({ before: ctx.method });
    const res = await next();
    observations.push({ after: res.text });
    return res;
  });
  await fake.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(observations.length, 2);
  assert.equal(observations[0].before, 'chat');
  assert.equal(observations[1].after, 'ok');
});

test('fakeLLM: composes with circuitBreaker — trip on repeated 500s', async () => {
  const fake = fakeLLM({
    failRate: 1.0,
    failWith: () => Object.assign(new Error('boom'), { status: 500 }),
  });
  const breaker = circuitBreaker({ threshold: 2, cooldownMs: 60_000 });
  fake.use(breaker);
  // 2 failures trip the breaker
  await fake.chat({ messages: [{ role: 'user', content: 'a' }] }).catch(() => {});
  await fake.chat({ messages: [{ role: 'user', content: 'b' }] }).catch(() => {});
  // 3rd short-circuits
  await assert.rejects(
    fake.chat({ messages: [{ role: 'user', content: 'c' }] }),
    /circuit is OPEN/,
  );
});

test('fakeLLM: composes with bulkhead — concurrent limit enforced', async () => {
  const fake = fakeLLM({ defaultResponse: { text: 'ok' }, delayMs: 30 });
  const bh = bulkhead({ maxConcurrent: 2, maxQueued: 0 });
  fake.use(bh);
  const p1 = fake.chat({ messages: [{ role: 'user', content: '1' }] });
  const p2 = fake.chat({ messages: [{ role: 'user', content: '2' }] });
  // The 3rd should be rejected (queue full)
  await assert.rejects(
    fake.chat({ messages: [{ role: 'user', content: '3' }] }),
    /queue is full/,
  );
  await Promise.all([p1, p2]);
});

test('fakeLLM.use: throws on non-function', () => {
  const fake = fakeLLM({});
  assert.throws(() => fake.use('not-a-fn'), /requires a function/);
});

// ---- Runtime script mutation ----------------------------------------

test('fakeLLM: setScripts replaces the script list', async () => {
  const fake = fakeLLM({ scripts: [{ when: () => true, respond: { text: 'v1' } }] });
  const first = await fake.chat({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(first.text, 'v1');
  fake.setScripts([{ when: () => true, respond: { text: 'v2' } }]);
  const second = await fake.chat({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(second.text, 'v2');
});

test('fakeLLM: addScript appends to the script list', async () => {
  const fake = fakeLLM({
    scripts: [{ when: { model: 'x' }, respond: { text: 'from-x' } }],
    defaultResponse: { text: 'fallback' },
  });
  const first = await fake.chat({ model: 'y', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(first.text, 'fallback');
  fake.addScript({ when: { model: 'y' }, respond: { text: 'from-y' } });
  const second = await fake.chat({ model: 'y', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(second.text, 'from-y');
});

// ---- Input validation on chat / embed / stream --------------------

test('fakeLLM.chat: throws on missing messages', async () => {
  const fake = fakeLLM({});
  await assert.rejects(fake.chat({}), /requires \{ messages/);
  await assert.rejects(fake.chat({ messages: [] }), /requires \{ messages/);
});

test('fakeLLM.embed: throws on missing input', async () => {
  const fake = fakeLLM({});
  await assert.rejects(fake.embed({}), /requires \{ input/);
});

test('fakeLLM.stream: throws on missing messages', async () => {
  const fake = fakeLLM({});
  const gen = fake.stream({});
  await assert.rejects(gen.next(), /requires \{ messages/);
});
