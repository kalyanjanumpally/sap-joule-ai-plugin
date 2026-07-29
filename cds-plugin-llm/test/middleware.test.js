const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_mw__';
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

class StubProvider extends LLMService {
  async init() {
    await super.init();
    this.calls = { chat: 0, embed: 0, stream: 0 };
  }
  async _chat(params) {
    this.calls.chat++;
    return {
      text: 'response for: ' + (params.messages.at(-1).content ?? ''),
      raw: null,
      usage: { input_tokens: 10, output_tokens: 5 },
      stopReason: 'end_turn',
      model: params.model,
    };
  }
  async _embed({ model, input }) {
    this.calls.embed++;
    const arr = Array.isArray(input) ? input : [input];
    return { embeddings: arr.map(() => [0.1, 0.2, 0.3]), model };
  }
  async *_stream(params) {
    this.calls.stream++;
    yield { type: 'text_delta', text: 'Hello' };
    yield { type: 'text_delta', text: ' world' };
    yield { type: 'done', text: 'Hello world', usage: {}, stopReason: 'stop', model: params.model };
  }
}

async function collect(iter) {
  const out = [];
  for await (const v of iter) out.push(v);
  return out;
}

// ---- basics --------------------------------------------------------------

test('use() adds a middleware; returns this for chaining', async () => {
  const svc = new StubProvider('llm', null, { modelId: 'm' });
  await svc.init();
  const returned = svc.use(async (ctx, next) => next());
  assert.strictEqual(returned, svc);
  assert.equal(svc.middleware.length, 1);
});

test('use() rejects non-function argument', async () => {
  const svc = new StubProvider('llm', null, { modelId: 'm' });
  await svc.init();
  assert.throws(() => svc.use(42), /function/);
});

// ---- chat middleware -----------------------------------------------------

test('middleware fires before + after chat, sees the request and response', async () => {
  const svc = new StubProvider('llm', null, { modelId: 'm' });
  await svc.init();

  const log = [];
  svc.use(async (ctx, next) => {
    log.push(`before ${ctx.method}: ${ctx.request.messages.at(-1).content}`);
    const res = await next();
    log.push(`after ${ctx.method}: ${res.text.slice(0, 20)}`);
    return res;
  });

  const res = await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.deepEqual(log, ['before chat: hi', 'after chat: response for: hi']);
  assert.match(res.text, /response for: hi/);
});

test('multiple middleware compose in registration order (outermost first)', async () => {
  const svc = new StubProvider('llm', null, { modelId: 'm' });
  await svc.init();
  const log = [];
  svc.use(async (ctx, next) => { log.push('A in'); const r = await next(); log.push('A out'); return r; });
  svc.use(async (ctx, next) => { log.push('B in'); const r = await next(); log.push('B out'); return r; });
  svc.use(async (ctx, next) => { log.push('C in'); const r = await next(); log.push('C out'); return r; });

  await svc.chat({ messages: [{ role: 'user', content: 'x' }] });
  assert.deepEqual(log, ['A in', 'B in', 'C in', 'C out', 'B out', 'A out']);
});

test('middleware can modify the request before it reaches the provider', async () => {
  const svc = new StubProvider('llm', null, { modelId: 'm' });
  await svc.init();
  svc.use(async (ctx, next) => {
    ctx.request.messages = [{ role: 'user', content: 'rewritten prompt' }];
    return next();
  });
  const res = await svc.chat({ messages: [{ role: 'user', content: 'original' }] });
  assert.match(res.text, /rewritten prompt/);
});

test('middleware can modify the response returned to the caller', async () => {
  const svc = new StubProvider('llm', null, { modelId: 'm' });
  await svc.init();
  svc.use(async (ctx, next) => {
    const res = await next();
    return { ...res, text: '<<' + res.text + '>>' };
  });
  const res = await svc.chat({ messages: [{ role: 'user', content: 'q' }] });
  assert.equal(res.text, '<<response for: q>>');
});

test('middleware can short-circuit by returning without calling next()', async () => {
  const svc = new StubProvider('llm', null, { modelId: 'm' });
  await svc.init();
  svc.use(async (ctx, next) => ({
    text: 'cached', raw: null, usage: {}, stopReason: 'end_turn', model: 'stub',
  }));
  const res = await svc.chat({ messages: [{ role: 'user', content: 'q' }] });
  assert.equal(res.text, 'cached');
  assert.equal(svc.calls.chat, 0);   // provider never called
});

test('meta is shared across middleware in a single call', async () => {
  const svc = new StubProvider('llm', null, { modelId: 'm' });
  await svc.init();
  svc.use(async (ctx, next) => { ctx.meta.start = 100; return next(); });
  svc.use(async (ctx, next) => {
    const res = await next();
    ctx.meta.end = ctx.meta.start + 50;
    return { ...res, _meta: ctx.meta };
  });
  const res = await svc.chat({ messages: [{ role: 'user', content: 'x' }] });
  assert.deepEqual(res._meta, { start: 100, end: 150 });
});

test('calling next() twice from the same middleware throws', async () => {
  const svc = new StubProvider('llm', null, { modelId: 'm' });
  await svc.init();
  svc.use(async (ctx, next) => {
    await next();
    return await next();  // illegal
  });
  await assert.rejects(
    () => svc.chat({ messages: [{ role: 'user', content: 'x' }] }),
    /next\(\) more than once/,
  );
});

test('middleware error propagates to the caller', async () => {
  const svc = new StubProvider('llm', null, { modelId: 'm' });
  await svc.init();
  svc.use(async () => { throw new Error('mw blew up'); });
  await assert.rejects(
    () => svc.chat({ messages: [{ role: 'user', content: 'x' }] }),
    /mw blew up/,
  );
});

// ---- embed middleware -----------------------------------------------------

test('middleware also fires for embed()', async () => {
  const svc = new StubProvider('llm', null, { modelId: 'm' });
  await svc.init();
  let seenMethod = null;
  svc.use(async (ctx, next) => { seenMethod = ctx.method; return next(); });
  await svc.embed({ input: 'hello' });
  assert.equal(seenMethod, 'embed');
});

// ---- stream middleware ----------------------------------------------------

test('middleware wraps stream iterable — can observe each chunk', async () => {
  const svc = new StubProvider('llm', null, { modelId: 'm' });
  await svc.init();
  const seen = [];
  svc.use(async (ctx, next) => {
    if (ctx.method !== 'stream') return next();
    const inner = await next();  // async iterable
    return (async function* () {
      for await (const chunk of inner) {
        seen.push(chunk.type);
        yield chunk;
      }
    })();
  });

  const chunks = await collect(svc.stream({ messages: [{ role: 'user', content: 'x' }] }));
  assert.deepEqual(seen, ['text_delta', 'text_delta', 'done']);
  assert.equal(chunks.length, 3);
});

test('middleware can transform stream chunks', async () => {
  const svc = new StubProvider('llm', null, { modelId: 'm' });
  await svc.init();
  svc.use(async (ctx, next) => {
    if (ctx.method !== 'stream') return next();
    const inner = await next();
    return (async function* () {
      for await (const chunk of inner) {
        if (chunk.type === 'text_delta') {
          yield { ...chunk, text: chunk.text.toUpperCase() };
        } else {
          yield chunk;
        }
      }
    })();
  });
  const chunks = await collect(svc.stream({ messages: [{ role: 'user', content: 'x' }] }));
  const deltas = chunks.filter(c => c.type === 'text_delta').map(c => c.text);
  assert.deepEqual(deltas, ['HELLO', ' WORLD']);
});

// ---- middleware interacts with response cache correctly ------------------

test('middleware sees cache hits (cached:true) via next()', async () => {
  const svc = new StubProvider('llm', null, { modelId: 'm', responseCache: true });
  await svc.init();
  const observed = [];
  svc.use(async (ctx, next) => {
    const res = await next();
    observed.push({ text: res.text, cached: !!res.cached });
    return res;
  });
  await svc.chat({ messages: [{ role: 'user', content: 'same' }] });
  await svc.chat({ messages: [{ role: 'user', content: 'same' }] });
  assert.equal(observed.length, 2);
  assert.equal(observed[0].cached, false);
  assert.equal(observed[1].cached, true);
  assert.equal(svc.calls.chat, 1);  // provider only called once
});
