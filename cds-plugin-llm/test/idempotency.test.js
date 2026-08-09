const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_idem__';
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

const { idempotency, IdempotencyInFlightError, defaultHashOf } = require('../lib/middleware/idempotency');
const { LLMError } = require('../lib/errors');
const { wrapStreamCompletion } = require('../lib/streamCompletion');

function makeCtx({
  method = 'chat',
  request = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] },
  meta = {},
} = {}) {
  return { method, request, raw: request, meta };
}

// ---- Input validation --------------------------------------------------

test('idem: throws on negative ttlMs', () => {
  assert.throws(() => idempotency({ ttlMs: -1 }), /ttlMs must be/);
});
test('idem: throws on non-positive maxSize', () => {
  assert.throws(() => idempotency({ maxSize: 0 }), /maxSize must be/);
});
test('idem: throws on non-function hashOf', () => {
  assert.throws(() => idempotency({ hashOf: 'x' }), /hashOf must be/);
});
test('idem: throws on non-function keyFrom', () => {
  assert.throws(() => idempotency({ keyFrom: 'x' }), /keyFrom must be/);
});
test('idem: throws on invalid onInFlight', () => {
  assert.throws(() => idempotency({ onInFlight: 'nope' }), /onInFlight must be/);
});
test('idem: throws on invalid onDuplicate', () => {
  assert.throws(() => idempotency({ onDuplicate: 'nope' }), /onDuplicate must be/);
});

// ---- Default hash ------------------------------------------------------

test('idem.defaultHashOf: same request → same hash', () => {
  const a = defaultHashOf(makeCtx());
  const b = defaultHashOf(makeCtx());
  assert.equal(a, b);
});
test('idem.defaultHashOf: different model → different hash', () => {
  const a = defaultHashOf(makeCtx({ request: { model: 'a', messages: [] } }));
  const b = defaultHashOf(makeCtx({ request: { model: 'b', messages: [] } }));
  assert.notEqual(a, b);
});
test('idem.defaultHashOf: different messages → different hash', () => {
  const a = defaultHashOf(makeCtx({ request: { model: 'm', messages: [{ role: 'user', content: 'a' }] } }));
  const b = defaultHashOf(makeCtx({ request: { model: 'm', messages: [{ role: 'user', content: 'b' }] } }));
  assert.notEqual(a, b);
});
test('idem.defaultHashOf: different method → different hash', () => {
  const a = defaultHashOf({ method: 'chat', request: { model: 'm' } });
  const b = defaultHashOf({ method: 'embed', request: { model: 'm' } });
  assert.notEqual(a, b);
});

// ---- Hit / miss ---------------------------------------------------------

test('idem: fresh call is a miss', async () => {
  const mw = idempotency();
  let n = 0;
  const next = async () => { n++; return { text: 'r' }; };
  const r = await mw(makeCtx(), next);
  assert.equal(r.text, 'r');
  assert.equal(mw.stats.misses, 1);
  assert.equal(mw.stats.hits, 0);
  assert.equal(mw.size(), 1);
  assert.equal(n, 1);
});

test('idem: second identical call is a hit (completed cache)', async () => {
  const mw = idempotency();
  let n = 0;
  const next = async () => { n++; return { text: `r${n}` }; };
  const r1 = await mw(makeCtx(), next);
  const r2 = await mw(makeCtx(), next);
  assert.equal(n, 1);              // only 1 provider call
  assert.equal(r1.text, 'r1');
  assert.equal(r2, r1);            // same reference
  assert.equal(mw.stats.hits, 1);
  assert.equal(mw.stats.misses, 1);
});

test('idem: different requests get separate entries', async () => {
  const mw = idempotency();
  let n = 0;
  const next = async () => { n++; return { text: `r${n}` }; };
  await mw(makeCtx({ request: { model: 'a', messages: [] } }), next);
  await mw(makeCtx({ request: { model: 'b', messages: [] } }), next);
  assert.equal(n, 2);
  assert.equal(mw.size(), 2);
});

// ---- In-flight coalescing --------------------------------------------

test('idem: concurrent dupes coalesce onto one call (default)', async () => {
  const mw = idempotency();
  let n = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const next = async () => { n++; await gate; return { text: 'once' }; };
  const p1 = mw(makeCtx(), next);
  const p2 = mw(makeCtx(), next);
  const p3 = mw(makeCtx(), next);
  release();
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  assert.equal(n, 1);
  assert.equal(r1, r2);
  assert.equal(r2, r3);
  assert.equal(mw.stats.inFlightCoalesced, 2);
  assert.equal(mw.stats.misses, 1);
});

test('idem: onInFlight=reject throws IdempotencyInFlightError', async () => {
  const mw = idempotency({ onInFlight: 'reject' });
  let release;
  const gate = new Promise((r) => { release = r; });
  const next = async () => { await gate; return { text: 'r' }; };
  const p1 = mw(makeCtx(), next);
  await assert.rejects(
    mw(makeCtx(), next),
    (err) => {
      assert.ok(err instanceof IdempotencyInFlightError);
      assert.ok(err instanceof LLMError);
      assert.equal(err.code, 'IDEMPOTENCY_IN_FLIGHT');
      assert.equal(err.httpStatus, 409);
      assert.equal(err.retriable, true);
      assert.equal(err.completed, false);
      return true;
    },
  );
  release();
  await p1;
  assert.equal(mw.stats.rejected, 1);
});

// ---- Completed reject ----------------------------------------------

test('idem: onDuplicate=reject throws for completed hit', async () => {
  const mw = idempotency({ onDuplicate: 'reject' });
  const next = async () => ({ text: 'first' });
  await mw(makeCtx(), next);
  await assert.rejects(
    mw(makeCtx(), next),
    (err) => err.code === 'IDEMPOTENCY_IN_FLIGHT' && err.completed === true,
  );
  assert.equal(mw.stats.rejected, 1);
});

// ---- Explicit keyFrom ------------------------------------------------

test('idem: keyFrom overrides hashOf', async () => {
  const mw = idempotency({ keyFrom: (ctx) => ctx.raw?.headers?.['idempotency-key'] });
  let n = 0;
  const next = async () => { n++; return { text: `r${n}` }; };
  const ctxA = { method: 'chat', request: { model: 'A' }, raw: { model: 'A', headers: { 'idempotency-key': 'K1' } }, meta: {} };
  const ctxB = { method: 'chat', request: { model: 'B' }, raw: { model: 'B', headers: { 'idempotency-key': 'K1' } }, meta: {} };
  await mw(ctxA, next);
  const r2 = await mw(ctxB, next);
  assert.equal(n, 1);                    // same key → coalesced, DIFFERENT request bodies
  assert.equal(r2.text, 'r1');
});

test('idem: keyFrom falsy falls back to hashOf', async () => {
  const mw = idempotency({ keyFrom: () => null });
  let n = 0;
  const next = async () => { n++; return { text: 'r' }; };
  await mw(makeCtx(), next);
  await mw(makeCtx(), next);
  assert.equal(n, 1);   // hashOf kicked in
});

test('idem: keyFrom throwing falls back to hashOf', async () => {
  const mw = idempotency({ keyFrom: () => { throw new Error('boom'); } });
  let n = 0;
  const next = async () => { n++; return { text: 'r' }; };
  await mw(makeCtx(), next);
  await mw(makeCtx(), next);
  assert.equal(n, 1);
});

// ---- TTL + LRU -----------------------------------------------------

test('idem: entry expires after ttlMs', async () => {
  let t = 1000;
  const mw = idempotency({ ttlMs: 100, now: () => t });
  let n = 0;
  const next = async () => { n++; return { text: `r${n}` }; };
  await mw(makeCtx(), next);
  t += 50;
  await mw(makeCtx(), next);   // still fresh
  assert.equal(n, 1);
  t += 200;                     // past TTL
  await mw(makeCtx(), next);
  assert.equal(n, 2);
  assert.ok(mw.stats.evictions >= 1);
});

test('idem: LRU evicts oldest when maxSize reached', async () => {
  const mw = idempotency({ maxSize: 2 });
  const next = async (n) => ({ text: `r${n}` });
  await mw(makeCtx({ request: { model: 'a' } }), () => next(1));
  await mw(makeCtx({ request: { model: 'b' } }), () => next(2));
  assert.equal(mw.size(), 2);
  await mw(makeCtx({ request: { model: 'c' } }), () => next(3));
  assert.equal(mw.size(), 2);
  assert.equal(mw.stats.evictions, 1);
  // 'a' should have been evicted (LRU).
  const hashA = defaultHashOf(makeCtx({ request: { model: 'a' } }));
  assert.equal(mw.has(hashA), false);
});

test('idem: touching an entry moves it to end (LRU)', async () => {
  const mw = idempotency({ maxSize: 2 });
  const next = async () => ({ text: 'r' });
  const ctxA = makeCtx({ request: { model: 'a' } });
  const ctxB = makeCtx({ request: { model: 'b' } });
  const ctxC = makeCtx({ request: { model: 'c' } });
  await mw(ctxA, next);
  await mw(ctxB, next);
  await mw(ctxA, next);           // touches A → B becomes oldest
  await mw(ctxC, next);           // evicts B
  const hashB = defaultHashOf(ctxB);
  assert.equal(mw.has(hashB), false);
  const hashA = defaultHashOf(ctxA);
  assert.equal(mw.has(hashA), true);
});

// ---- Error passthrough ---------------------------------------------

test('idem: failed call is NOT cached (subsequent gets fresh)', async () => {
  const mw = idempotency();
  let n = 0;
  const next = async () => {
    n++;
    if (n === 1) throw new Error('provider down');
    return { text: 'ok' };
  };
  await assert.rejects(mw(makeCtx(), next), /provider down/);
  const r = await mw(makeCtx(), next);
  assert.equal(r.text, 'ok');
  assert.equal(n, 2);
  assert.equal(mw.stats.errorsBypassed, 1);
});

test('idem: failed in-flight call propagates error to coalesced callers', async () => {
  const mw = idempotency();
  let release;
  const gate = new Promise((r) => { release = r; });
  const next = async () => { await gate; throw new Error('boom'); };
  const p1 = mw(makeCtx(), next);
  const p2 = mw(makeCtx(), next);
  release();
  await assert.rejects(p1, /boom/);
  await assert.rejects(p2, /boom/);
  // After failure, entry removed → next call is a miss.
  await assert.rejects(mw(makeCtx(), async () => { throw new Error('boom2'); }), /boom2/);
});

// ---- Streams ---------------------------------------------------------

test('idem: streams bypass by default (each caller gets fresh call)', async () => {
  const mw = idempotency();
  let n = 0;
  const next = async () => {
    n++;
    return wrapStreamCompletion(async function* () { yield { type: 'done', text: 't' }; }());
  };
  const s1 = await mw(makeCtx(), next);
  const s2 = await mw(makeCtx(), next);
  assert.equal(n, 2);
  assert.notEqual(s1, s2);
  assert.equal(mw.stats.streamsBypassed, 2);
  assert.equal(mw.size(), 0);   // streams don't populate the cache
});

test('idem: captureStreams:true does cache streams (advanced/risky)', async () => {
  const mw = idempotency({ captureStreams: true });
  let n = 0;
  const next = async () => {
    n++;
    return wrapStreamCompletion(async function* () { yield { type: 'done', text: 't' }; }());
  };
  const s1 = await mw(makeCtx(), next);
  const s2 = await mw(makeCtx(), next);
  assert.equal(n, 1);
  assert.equal(s1, s2);           // same reference — caller must know what they're doing
});

// ---- MCP + introspection --------------------------------------------

test('idem: asMcpResource', () => {
  const mw = idempotency({ ttlMs: 5000, maxSize: 50 });
  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://idempotency');
  const p = r.handler();
  assert.equal(p.ttlMs, 5000);
  assert.equal(p.maxSize, 50);
  assert.equal(p.onInFlight, 'coalesce');
  assert.equal(p.onDuplicate, 'return');
  assert.equal(p.current, 0);
});

test('idem: reset() clears store + counters', async () => {
  const mw = idempotency();
  await mw(makeCtx(), async () => ({ text: 'r' }));
  assert.equal(mw.size(), 1);
  mw.reset();
  assert.equal(mw.size(), 0);
  assert.equal(mw.stats.hits, 0);
  assert.equal(mw.stats.misses, 0);
});

test('idem: has(key) returns true when key present', async () => {
  const mw = idempotency();
  const ctx = makeCtx();
  await mw(ctx, async () => ({ text: 'r' }));
  assert.equal(mw.has(defaultHashOf(ctx)), true);
  assert.equal(mw.has('not-a-key'), false);
});
