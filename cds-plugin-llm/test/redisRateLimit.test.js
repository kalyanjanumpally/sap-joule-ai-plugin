const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_rrl__';
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
const { redisRateLimit } = require('../lib/middleware/redisRateLimit');

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

// Fake Redis that emulates the token-bucket Lua behavior in memory. Only cares
// about protocol shape (eval returning [ok, waitMs]) — good enough for unit tests.
function fakeRedis() {
  const state = new Map();
  const calls = [];
  return {
    calls,
    async eval(script, numKeys, ...args) {
      calls.push({ script, numKeys, args });
      const [key, capStr, refillStr, nowStr, ttlStr] = args;
      const capacity = Number(capStr);
      const refill = Number(refillStr);
      const now = Number(nowStr);
      let entry = state.get(key);
      let tokens, ts;
      if (!entry) {
        tokens = capacity;
        ts = now;
      } else {
        const elapsedSec = (now - entry.ts) / 1000;
        tokens = Math.min(capacity, entry.tokens + elapsedSec * refill);
        ts = now;
      }
      let ok = 0, waitMs = 0;
      if (tokens >= 1) {
        tokens -= 1;
        ok = 1;
      } else {
        waitMs = Math.ceil(((1 - tokens) / refill) * 1000);
      }
      state.set(key, { tokens, ts });
      return [ok, waitMs];
    },
  };
}

test('redisRateLimit: validates options', () => {
  assert.throws(() => redisRateLimit({}), /options\.redis/);
  assert.throws(() => redisRateLimit({ redis: {} }), /eval/);
  assert.throws(() => redisRateLimit({ redis: fakeRedis(), capacity: -1, refillPerSecond: 1 }), /capacity/);
  assert.throws(() => redisRateLimit({ redis: fakeRedis(), capacity: 1, refillPerSecond: 0 }), /refillPerSecond/);
  assert.throws(() => redisRateLimit({ redis: fakeRedis(), capacity: 1, refillPerSecond: 1, mode: 'x' }), /mode/);
});

test('redisRateLimit: burst up to capacity + block afterwards', async () => {
  const r = fakeRedis();
  const p = await makeProvider();
  p.use(redisRateLimit({ redis: r, capacity: 2, refillPerSecond: 0.001 }));

  await p.chat({ messages: [{ role: 'user', content: 'a' }] });
  await p.chat({ messages: [{ role: 'user', content: 'b' }] });
  await assert.rejects(
    () => p.chat({ messages: [{ role: 'user', content: 'c' }] }),
    (err) => err.code === 'RATE_LIMITED' && err.retryAfterMs > 0,
  );
});

test('redisRateLimit: key prefix + keyFn used correctly', async () => {
  const r = fakeRedis();
  const p = await makeProvider();
  let user = 'alice';
  p.use(async (ctx, next) => { ctx.meta.user = user; return next(); });
  p.use(redisRateLimit({
    redis: r,
    capacity: 1,
    refillPerSecond: 0.001,
    keyFn: (ctx) => ctx.meta.user,
    keyPrefix: 'test:',
  }));

  await p.chat({ messages: [{ role: 'user', content: 'x' }] });
  user = 'bob';
  await p.chat({ messages: [{ role: 'user', content: 'y' }] });

  // Two separate keys in Redis
  const keys = r.calls.map(c => c.args[0]);
  assert.deepEqual(keys, ['test:alice', 'test:bob']);
});

test("redisRateLimit: mode='wait' pauses then proceeds", async () => {
  const r = fakeRedis();
  const p = await makeProvider();
  p.use(redisRateLimit({ redis: r, capacity: 1, refillPerSecond: 50, mode: 'wait' }));

  await p.chat({ messages: [{ role: 'user', content: 'a' }] });
  const start = Date.now();
  await p.chat({ messages: [{ role: 'user', content: 'b' }] });
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 15, `expected wait ~20ms, got ${elapsed}ms`);
});

test('redisRateLimit: forwards atomic Lua script + arg shape', async () => {
  const r = fakeRedis();
  const p = await makeProvider();
  p.use(redisRateLimit({ redis: r, capacity: 5, refillPerSecond: 2 }));

  await p.chat({ messages: [{ role: 'user', content: 'q' }] });
  const call = r.calls[0];
  assert.equal(call.numKeys, 1);
  assert.match(call.script, /HMSET.*tokens.*ts/s);
  assert.match(call.script, /PEXPIRE/);
  assert.equal(call.args[1], '5');   // capacity
  assert.equal(call.args[2], '2');   // refillPerSecond
  assert.ok(Number(call.args[3]) > 0, 'now_ms should be > 0');
  assert.ok(Number(call.args[4]) >= 60000, 'ttl_ms should be >= 60_000');
});

test('redisRateLimit: fires for embed too', async () => {
  const r = fakeRedis();
  const p = await makeProvider();
  p._embed = async () => ({ embeddings: [[1]], model: 'm' });
  p.use(redisRateLimit({ redis: r, capacity: 1, refillPerSecond: 0.001 }));

  await p.embed({ input: 'x' });
  await assert.rejects(
    () => p.embed({ input: 'y' }),
    (err) => err.code === 'RATE_LIMITED',
  );
});
