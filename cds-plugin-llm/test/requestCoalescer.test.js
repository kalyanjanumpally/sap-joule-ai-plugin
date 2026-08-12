const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_rc__';
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
  requestCoalescer,
  defaultKeyOf,
  stableStringify,
} = require('../lib/middleware/requestCoalescer');

// ---- Helpers -----------------------------------------------------------

function ctxWithPrompt(prompt, extras = {}) {
  return { method: 'chat', request: { prompt, ...extras } };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ---- stableStringify ---------------------------------------------------

test('stableStringify: key order deterministic', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
});
test('stableStringify: nested objects sorted', () => {
  assert.equal(
    stableStringify({ x: { b: 1, a: 2 } }),
    stableStringify({ x: { a: 2, b: 1 } }),
  );
});
test('stableStringify: arrays preserve order', () => {
  assert.notEqual(
    stableStringify([1, 2, 3]),
    stableStringify([3, 2, 1]),
  );
});
test('stableStringify: functions and undefined dropped', () => {
  assert.equal(
    stableStringify({ a: 1, b: undefined, c: () => {} }),
    '{"a":1}',
  );
});
test('stableStringify: primitives', () => {
  assert.equal(stableStringify(null), 'null');
  assert.equal(stableStringify(42), '42');
  assert.equal(stableStringify('x'), '"x"');
});

// ---- defaultKeyOf ------------------------------------------------------

test('defaultKeyOf: same prompt → same key', () => {
  const k1 = defaultKeyOf(ctxWithPrompt('hi'));
  const k2 = defaultKeyOf(ctxWithPrompt('hi'));
  assert.equal(k1, k2);
});
test('defaultKeyOf: different prompt → different key', () => {
  const k1 = defaultKeyOf(ctxWithPrompt('hi'));
  const k2 = defaultKeyOf(ctxWithPrompt('bye'));
  assert.notEqual(k1, k2);
});
test('defaultKeyOf: different model → different key', () => {
  const k1 = defaultKeyOf(ctxWithPrompt('hi', { model: 'a' }));
  const k2 = defaultKeyOf(ctxWithPrompt('hi', { model: 'b' }));
  assert.notEqual(k1, k2);
});
test('defaultKeyOf: temperature affects key', () => {
  const k1 = defaultKeyOf(ctxWithPrompt('hi', { temperature: 0 }));
  const k2 = defaultKeyOf(ctxWithPrompt('hi', { temperature: 1 }));
  assert.notEqual(k1, k2);
});
test('defaultKeyOf: messages array recognized', () => {
  const c = { request: { messages: [{ role: 'user', content: 'hi' }] } };
  assert.equal(typeof defaultKeyOf(c), 'string');
});
test('defaultKeyOf: no prompt and no messages → null', () => {
  assert.equal(defaultKeyOf({ request: { model: 'x' } }), null);
});
test('defaultKeyOf: null ctx → null', () => {
  assert.equal(defaultKeyOf(null), null);
});

// ---- Validation --------------------------------------------------------

test('requestCoalescer: throws on non-function keyOf', () => {
  assert.throws(() => requestCoalescer({ keyOf: 'x' }), /keyOf/);
});
test('requestCoalescer: throws on negative ttlMs', () => {
  assert.throws(() => requestCoalescer({ ttlMs: -1 }), /ttlMs/);
});
test('requestCoalescer: throws on invalid maxInFlightKeys', () => {
  assert.throws(() => requestCoalescer({ maxInFlightKeys: 0 }), /maxInFlightKeys/);
});
test('requestCoalescer: throws on non-string keyPrefix', () => {
  assert.throws(() => requestCoalescer({ keyPrefix: 1 }), /keyPrefix/);
});
test('requestCoalescer: throws on non-function callback', () => {
  assert.throws(() => requestCoalescer({ onCoalesce: 'x' }), /onCoalesce/);
});

// ---- Core: concurrent identical calls collapse ------------------------

test('requestCoalescer: N concurrent identical calls fire 1 upstream', async () => {
  const mw = requestCoalescer();
  let upstreamCalls = 0;
  const gate = deferred();
  const call = () => mw(ctxWithPrompt('hi'), async () => {
    upstreamCalls++;
    await gate.promise;
    return { text: 'greet' };
  });
  const promises = [call(), call(), call(), call(), call()];
  // Yield so all callers register.
  await new Promise((r) => setImmediate(r));
  gate.resolve();
  const results = await Promise.all(promises);
  assert.equal(upstreamCalls, 1);
  for (const r of results) assert.deepEqual(r, { text: 'greet' });
  assert.equal(mw.stats.leads, 1);
  assert.equal(mw.stats.coalesced, 4);
});

test('requestCoalescer: different keys do NOT coalesce', async () => {
  const mw = requestCoalescer();
  let upstreamCalls = 0;
  const call = (p) => mw(ctxWithPrompt(p), async () => {
    upstreamCalls++;
    return { text: p };
  });
  const [a, b, c] = await Promise.all([call('a'), call('b'), call('c')]);
  assert.equal(upstreamCalls, 3);
  assert.deepEqual([a, b, c], [{text:'a'},{text:'b'},{text:'c'}]);
  assert.equal(mw.stats.leads, 3);
  assert.equal(mw.stats.coalesced, 0);
});

// ---- Error propagation ------------------------------------------------

test('requestCoalescer: leader error propagates to all waiters', async () => {
  const mw = requestCoalescer();
  const gate = deferred();
  const call = () => mw(ctxWithPrompt('boom'), async () => {
    await gate.promise;
    throw new Error('leader-fail');
  });
  const p1 = call(), p2 = call(), p3 = call();
  await new Promise((r) => setImmediate(r));
  gate.resolve();
  await assert.rejects(p1, /leader-fail/);
  await assert.rejects(p2, /leader-fail/);
  await assert.rejects(p3, /leader-fail/);
  assert.equal(mw.stats.leads, 1);
  assert.equal(mw.stats.coalesced, 2);
  assert.equal(mw.stats.errors, 1);
});

// ---- TTL post-settle coalescing --------------------------------------

test('requestCoalescer: ttlMs > 0 serves briefly-following requests from cache', async () => {
  let t = 1000;
  const mw = requestCoalescer({ ttlMs: 100, now: () => t });
  let upstream = 0;
  const call = () => mw(ctxWithPrompt('same'), async () => {
    upstream++;
    return { text: 'answer' };
  });
  await call();
  t = 1050;   // within TTL
  const r = await call();
  assert.deepEqual(r, { text: 'answer' });
  assert.equal(upstream, 1);
  assert.equal(mw.stats.ttlHits, 1);
});

test('requestCoalescer: TTL expired → fresh upstream call', async () => {
  let t = 1000;
  const mw = requestCoalescer({ ttlMs: 100, now: () => t });
  let upstream = 0;
  const call = () => mw(ctxWithPrompt('same'), async () => { upstream++; return { text: 'x' }; });
  await call();
  t = 2000;   // way past TTL
  await call();
  assert.equal(upstream, 2);
  assert.equal(mw.stats.ttlHits, 0);
  assert.equal(mw.stats.leads, 2);
});

test('requestCoalescer: TTL replays leader errors', async () => {
  let t = 1000;
  const mw = requestCoalescer({ ttlMs: 100, now: () => t });
  const call = () => mw(ctxWithPrompt('same'), async () => { throw new Error('oops'); });
  await assert.rejects(call(), /oops/);
  t = 1050;
  await assert.rejects(call(), /oops/);
});

// ---- Streaming skip ---------------------------------------------------

test('requestCoalescer: skips streaming methods by default', async () => {
  const mw = requestCoalescer();
  let upstream = 0;
  const call = () => mw({ method: 'stream', request: { prompt: 's' } },
                        async () => { upstream++; return 'r'; });
  await Promise.all([call(), call(), call()]);
  assert.equal(upstream, 3);
  assert.equal(mw.stats.skippedByMethod, 3);
});

test('requestCoalescer: skipMethods override', async () => {
  const mw = requestCoalescer({ skipMethods: ['embed'] });
  let upstream = 0;
  const gate = deferred();
  const call = (method) => mw({ method, request: { prompt: 'p' } },
                              async () => { upstream++; await gate.promise; return 'r'; });
  const p1 = call('embed');
  const p2 = call('embed');
  await new Promise((r) => setImmediate(r));
  gate.resolve();
  await Promise.all([p1, p2]);
  assert.equal(upstream, 2);   // both skipped
  assert.equal(mw.stats.skippedByMethod, 2);
});

// ---- maxInFlightKeys safety cap --------------------------------------

test('requestCoalescer: maxInFlightKeys drops through excess distinct keys', async () => {
  const mw = requestCoalescer({ maxInFlightKeys: 2 });
  const gate = deferred();
  let upstream = 0;
  const call = (p) => mw(ctxWithPrompt(p), async () => {
    upstream++; await gate.promise; return p;
  });
  const p1 = call('a');
  const p2 = call('b');
  const p3 = call('c');   // should be dropped through (map already has 2)
  await new Promise((r) => setImmediate(r));
  gate.resolve();
  await Promise.all([p1, p2, p3]);
  assert.equal(upstream, 3);
  assert.equal(mw.stats.dropped, 1);
});

// ---- No key → straight through ---------------------------------------

test('requestCoalescer: null key means no coalescing', async () => {
  const mw = requestCoalescer({ keyOf: () => null });
  let upstream = 0;
  const call = () => mw(ctxWithPrompt('x'), async () => { upstream++; return 'r'; });
  await Promise.all([call(), call(), call()]);
  assert.equal(upstream, 3);
  assert.equal(mw.stats.leads, 0);
});

test('requestCoalescer: keyOf throws → fall through', async () => {
  const errs = [];
  const mw = requestCoalescer({
    keyOf: () => { throw new Error('bad'); },
    onError: (i) => errs.push(i),
  });
  let upstream = 0;
  const r = await mw(ctxWithPrompt('x'), async () => { upstream++; return 'r'; });
  assert.equal(r, 'r');
  assert.equal(upstream, 1);
  assert.equal(mw.stats.keyErrors, 1);
  assert.equal(errs[0].phase, 'keyOf');
});

// ---- cloneResult ----------------------------------------------------

test('requestCoalescer: cloneResult=false shares reference (default)', async () => {
  const mw = requestCoalescer();
  const gate = deferred();
  const call = () => mw(ctxWithPrompt('x'),
                        async () => { await gate.promise; return { arr: [1, 2, 3] }; });
  const p1 = call(), p2 = call();
  await new Promise((r) => setImmediate(r));
  gate.resolve();
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(a, b);   // same reference
});

test('requestCoalescer: cloneResult=true deep-clones per caller', async () => {
  const mw = requestCoalescer({ cloneResult: true });
  const gate = deferred();
  const call = () => mw(ctxWithPrompt('x'),
                        async () => { await gate.promise; return { arr: [1, 2, 3] }; });
  const p1 = call(), p2 = call();
  await new Promise((r) => setImmediate(r));
  gate.resolve();
  const [a, b] = await Promise.all([p1, p2]);
  assert.deepEqual(a, b);
  assert.notEqual(a, b);   // different references
  a.arr.push(999);
  assert.deepEqual(b.arr, [1, 2, 3]);   // b untouched
});

// ---- keyPrefix isolation --------------------------------------------

test('requestCoalescer: keyPrefix isolates tenants', async () => {
  const store = { count: 0 };
  const mwA = requestCoalescer({ keyPrefix: 'A:' });
  const mwB = requestCoalescer({ keyPrefix: 'B:' });
  const gate = deferred();
  const upstream = async () => {
    const mine = ++store.count;
    await gate.promise;
    return mine;
  };
  const p1 = mwA(ctxWithPrompt('same'), upstream);
  const p2 = mwB(ctxWithPrompt('same'), upstream);
  await new Promise((r) => setImmediate(r));
  gate.resolve();
  const [a, b] = await Promise.all([p1, p2]);
  assert.notEqual(a, b);   // both fired independently
  assert.equal(store.count, 2);
});

// ---- Callbacks ------------------------------------------------------

test('requestCoalescer: onLead + onCoalesce + onSettle fire', async () => {
  const events = [];
  const mw = requestCoalescer({
    onLead:     (i) => events.push(['lead', i.key]),
    onCoalesce: (i) => events.push(['coalesce', i.source]),
    onSettle:   (i) => events.push(['settle', i.outcome, i.waiters]),
  });
  const gate = deferred();
  const call = () => mw(ctxWithPrompt('x'),
                        async () => { await gate.promise; return 'r'; });
  const p1 = call(), p2 = call(), p3 = call();
  await new Promise((r) => setImmediate(r));
  gate.resolve();
  await Promise.all([p1, p2, p3]);
  const kinds = events.map(([k]) => k);
  assert.deepEqual(kinds.sort(), ['coalesce', 'coalesce', 'lead', 'settle']);
  const settle = events.find(([k]) => k === 'settle');
  assert.equal(settle[1], 'ok');
  assert.equal(settle[2], 3);
});

test('requestCoalescer: callback throws are swallowed', async () => {
  const mw = requestCoalescer({
    onLead: () => { throw new Error('x'); },
    onSettle: () => { throw new Error('x'); },
  });
  const r = await mw(ctxWithPrompt('x'), async () => 'ok');
  assert.equal(r, 'ok');
});

// ---- Stats + reset + MCP ---------------------------------------------

test('requestCoalescer: savingsRatio', async () => {
  const mw = requestCoalescer();
  const gate = deferred();
  const call = () => mw(ctxWithPrompt('same'),
                        async () => { await gate.promise; return 'r'; });
  const promises = [call(), call(), call(), call()];
  await new Promise((r) => setImmediate(r));
  gate.resolve();
  await Promise.all(promises);
  assert.equal(mw.savingsRatio(), 3 / 4);
});

test('requestCoalescer: reset clears counters + settled', async () => {
  const mw = requestCoalescer({ ttlMs: 100 });
  await mw(ctxWithPrompt('x'), async () => 'r');
  assert.equal(mw.stats.leads, 1);
  assert.equal(mw.recentlySettledCount(), 1);
  mw.reset();
  assert.equal(mw.stats.leads, 0);
  assert.equal(mw.recentlySettledCount(), 0);
});

test('requestCoalescer: asMcpResource', () => {
  const mw = requestCoalescer({ ttlMs: 500, keyPrefix: 'ns:', maxInFlightKeys: 100 });
  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://request-coalescer');
  const p = r.handler();
  assert.equal(p.ttlMs, 500);
  assert.equal(p.keyPrefix, 'ns:');
  assert.equal(p.maxInFlightKeys, 100);
  assert.ok(Array.isArray(p.skipMethods));
  assert.equal(p.savingsRatio, 0);
});

// ---- peakInFlight tracked --------------------------------------------

test('requestCoalescer: peakInFlight tracks the high-water mark', async () => {
  const mw = requestCoalescer();
  const gates = [deferred(), deferred(), deferred()];
  const call = (i) => mw(ctxWithPrompt(`k${i}`),
                         async () => { await gates[i].promise; return i; });
  const promises = [call(0), call(1), call(2)];
  await new Promise((r) => setImmediate(r));
  assert.equal(mw.inFlightCount(), 3);
  assert.equal(mw.stats.peakInFlight, 3);
  gates.forEach((g) => g.resolve());
  await Promise.all(promises);
  assert.equal(mw.inFlightCount(), 0);
  assert.equal(mw.stats.peakInFlight, 3);   // preserved after settle
});
