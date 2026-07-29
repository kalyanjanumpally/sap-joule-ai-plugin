const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_rl__';
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

const LLMService = require('../lib/LLMService');
const { rateLimit } = require('../lib/middleware/rateLimit');

class StubProvider extends LLMService {
  async _chat(params) {
    return { text: 'ok', raw: null, usage: {}, stopReason: 'end_turn', model: params.model };
  }
}

async function makeProvider() {
  const p = new StubProvider('llm', null, { modelId: 'm1' });
  await p.init();
  return p;
}

test('rateLimit: throws when capacity is invalid', () => {
  assert.throws(() => rateLimit({ capacity: 0, refillPerSecond: 1 }), /capacity/);
  assert.throws(() => rateLimit({ capacity: -1, refillPerSecond: 1 }), /capacity/);
  assert.throws(() => rateLimit({ refillPerSecond: 1 }), /capacity/);
});

test('rateLimit: throws when refillPerSecond is invalid', () => {
  assert.throws(() => rateLimit({ capacity: 10, refillPerSecond: 0 }), /refillPerSecond/);
  assert.throws(() => rateLimit({ capacity: 10, refillPerSecond: -0.5 }), /refillPerSecond/);
  assert.throws(() => rateLimit({ capacity: 10 }), /refillPerSecond/);
});

test('rateLimit: rejects unknown mode', () => {
  assert.throws(() => rateLimit({ capacity: 1, refillPerSecond: 1, mode: 'bogus' }), /mode/);
});

test('rateLimit: allows burst up to capacity', async () => {
  const p = await makeProvider();
  p.use(rateLimit({ capacity: 3, refillPerSecond: 0.001 }));

  for (let i = 0; i < 3; i++) {
    const r = await p.chat({ messages: [{ role: 'user', content: `q${i}` }] });
    assert.equal(r.text, 'ok');
  }
});

test("rateLimit: mode='throw' throws RATE_LIMITED after capacity exhausted", async () => {
  const p = await makeProvider();
  p.use(rateLimit({ capacity: 2, refillPerSecond: 0.001, mode: 'throw' }));

  await p.chat({ messages: [{ role: 'user', content: 'a' }] });
  await p.chat({ messages: [{ role: 'user', content: 'b' }] });

  await assert.rejects(
    () => p.chat({ messages: [{ role: 'user', content: 'c' }] }),
    (err) => {
      assert.equal(err.code, 'RATE_LIMITED');
      assert.ok(err.retryAfterMs > 0);
      assert.equal(err.key, 'global');
      return true;
    },
  );
});

test("rateLimit: mode='wait' pauses then proceeds", async () => {
  const p = await makeProvider();
  p.use(rateLimit({ capacity: 1, refillPerSecond: 50, mode: 'wait' }));

  await p.chat({ messages: [{ role: 'user', content: 'a' }] });
  const start = Date.now();
  await p.chat({ messages: [{ role: 'user', content: 'b' }] });
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 15, `expected to wait ~20ms, waited ${elapsed}ms`);
});

test('rateLimit: refills tokens over time', async () => {
  const p = await makeProvider();
  p.use(rateLimit({ capacity: 1, refillPerSecond: 100 }));

  await p.chat({ messages: [{ role: 'user', content: 'a' }] });
  await new Promise(r => setTimeout(r, 25));
  await p.chat({ messages: [{ role: 'user', content: 'b' }] });
});

test('rateLimit: separate buckets per key', async () => {
  const p = await makeProvider();
  let currentUser = 'alice';
  p.use(async (ctx, next) => { ctx.meta.user = currentUser; return next(); });
  p.use(rateLimit({
    capacity: 1,
    refillPerSecond: 0.001,
    keyFn: (ctx) => ctx.meta.user ?? 'anon',
  }));

  await p.chat({ messages: [{ role: 'user', content: 'a1' }] });

  currentUser = 'bob';
  await p.chat({ messages: [{ role: 'user', content: 'b1' }] });

  currentUser = 'alice';
  await assert.rejects(
    () => p.chat({ messages: [{ role: 'user', content: 'a2' }] }),
    (err) => err.code === 'RATE_LIMITED' && err.key === 'alice',
  );
});

test('rateLimit: fires for stream and embed too', async () => {
  const p = await makeProvider();
  p._stream = async function*(params) { yield { type: 'done', text: '', usage: {}, model: params.model }; };
  p._embed = async () => ({ embeddings: [[1]], model: 'm' });
  p.use(rateLimit({ capacity: 2, refillPerSecond: 0.001 }));

  await p.embed({ input: 'x' });
  const iter = p.stream({ messages: [{ role: 'user', content: 'y' }] });
  for await (const _ of iter) { /* drain */ }

  await assert.rejects(
    () => p.embed({ input: 'z' }),
    (err) => err.code === 'RATE_LIMITED',
  );
});
