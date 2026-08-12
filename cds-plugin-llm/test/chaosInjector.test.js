const { test } = require('node:test');
const assert = require('node:assert/strict');

// Chaos injector is test-only by policy — enable via env flag so the
// safety guard doesn't block construction in Node's default test runner
// (which doesn't set NODE_ENV=test by default).
process.env.CHAOS_INJECTOR_ENABLED = '1';

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_chaos__';
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
  chaosInjector,
  mulberry32,
  FAULT_ORDER,
  DEFAULT_FAULTS,
  GARBAGE_BODIES,
} = require('../lib/middleware/chaosInjector');

// ---- Helpers ----------------------------------------------------------

function makeCtx() { return { request: { prompt: 'hi' } }; }

// Node tests run with NODE_ENV=test by default — safety guard should pass.
// We save/restore process.env for guard tests.

// ---- mulberry32 -----------------------------------------------------

test('mulberry32: seed 42 produces stable sequence', () => {
  const r1 = mulberry32(42);
  const seq1 = [r1(), r1(), r1(), r1(), r1()];
  const r2 = mulberry32(42);
  const seq2 = [r2(), r2(), r2(), r2(), r2()];
  assert.deepEqual(seq1, seq2);
});

test('mulberry32: different seeds diverge', () => {
  const r1 = mulberry32(42);
  const r2 = mulberry32(43);
  assert.notEqual(r1(), r2());
});

test('mulberry32: output in [0, 1)', () => {
  const r = mulberry32(1);
  for (let i = 0; i < 100; i++) {
    const v = r();
    assert.ok(v >= 0 && v < 1, `got ${v}`);
  }
});

// ---- Frozen exports -------------------------------------------------

test('FAULT_ORDER + DEFAULT_FAULTS + GARBAGE_BODIES are frozen', () => {
  assert.ok(Object.isFrozen(FAULT_ORDER));
  assert.ok(Object.isFrozen(DEFAULT_FAULTS));
  assert.ok(Object.isFrozen(GARBAGE_BODIES));
});

test('FAULT_ORDER lists all defaults', () => {
  assert.deepEqual(
    [...FAULT_ORDER].sort(),
    Object.keys(DEFAULT_FAULTS).sort(),
  );
});

// ---- Safety guard -----------------------------------------------------

// The three safety-guard tests toggle env vars — carefully save + restore
// (including handling `undefined` explicitly so we don't leave the string
// literal "undefined" in the env).
function withEnv(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try { return fn(); }
  finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('chaosInjector: refuses to construct outside test contexts', () => {
  withEnv({ NODE_ENV: 'production', CHAOS_INJECTOR_ENABLED: undefined }, () => {
    assert.throws(() => chaosInjector({ faults: { rate429: 1 } }), /refusing to construct/);
  });
});

test('chaosInjector: iKnowThisIsChaos:true overrides the guard', () => {
  withEnv({ NODE_ENV: 'production', CHAOS_INJECTOR_ENABLED: undefined }, () => {
    assert.doesNotThrow(() =>
      chaosInjector({ faults: { rate429: 1 }, iKnowThisIsChaos: true }));
  });
});

test('chaosInjector: CHAOS_INJECTOR_ENABLED=1 overrides the guard', () => {
  withEnv({ NODE_ENV: 'production', CHAOS_INJECTOR_ENABLED: '1' }, () => {
    assert.doesNotThrow(() => chaosInjector({ faults: { rate429: 1 } }));
  });
});

// ---- Validation -------------------------------------------------------

test('chaosInjector: throws on non-integer seed', () => {
  assert.throws(() => chaosInjector({ seed: 1.5 }), /seed/);
});
test('chaosInjector: throws on unknown fault key', () => {
  assert.throws(() => chaosInjector({ faults: { rateBoom: 0.5 } }), /unknown fault/);
});
test('chaosInjector: throws on out-of-range fault rate', () => {
  assert.throws(() => chaosInjector({ faults: { rate429: 1.5 } }), /faults\.rate429/);
  assert.throws(() => chaosInjector({ faults: { rate429: -0.1 } }), /faults\.rate429/);
});
test('chaosInjector: throws on negative slowMs', () => {
  assert.throws(() => chaosInjector({ slowMs: -1 }), /slowMs/);
});
test('chaosInjector: throws on empty garbageBodies', () => {
  assert.throws(() => chaosInjector({ garbageBodies: [] }), /garbageBodies/);
});
test('chaosInjector: throws on non-function filter', () => {
  assert.throws(() => chaosInjector({ filter: 'x' }), /filter/);
});
test('chaosInjector: throws on non-function onInject', () => {
  assert.throws(() => chaosInjector({ onInject: 1 }), /onInject/);
});

// ---- Zero rates → always passes through -----------------------------

test('chaosInjector: zero rates → passthrough for all calls', async () => {
  const mw = chaosInjector({ seed: 42 });
  let upstream = 0;
  for (let i = 0; i < 20; i++) {
    const r = await mw(makeCtx(), async () => { upstream++; return { text: 'ok' }; });
    assert.deepEqual(r, { text: 'ok' });
  }
  assert.equal(upstream, 20);
  assert.equal(mw.stats.injected, 0);
  assert.equal(mw.stats.passthrough, 20);
});

// ---- Rate 1.0 → always injects (deterministic) ---------------------

test('chaosInjector: rate429=1.0 → every call throws 429', async () => {
  const mw = chaosInjector({ faults: { rate429: 1 } });
  for (let i = 0; i < 5; i++) {
    await assert.rejects(
      mw(makeCtx(), async () => { throw new Error('should never run'); }),
      (err) => err.status === 429,
    );
  }
  assert.equal(mw.stats.byFault.rate429, 5);
});

test('chaosInjector: rate500 injects 500 status', async () => {
  const mw = chaosInjector({ faults: { rate500: 1 } });
  await assert.rejects(mw(makeCtx(), async () => 'x'), (err) => err.status === 500);
});

test('chaosInjector: rate503 injects 503 status', async () => {
  const mw = chaosInjector({ faults: { rate503: 1 } });
  await assert.rejects(mw(makeCtx(), async () => 'x'), (err) => err.status === 503);
});

test('chaosInjector: rateTimeout injects ETIMEDOUT', async () => {
  const mw = chaosInjector({ faults: { rateTimeout: 1 } });
  await assert.rejects(mw(makeCtx(), async () => 'x'), (err) => err.code === 'ETIMEDOUT');
});

test('chaosInjector: rateNetworkError injects ECONNRESET', async () => {
  const mw = chaosInjector({ faults: { rateNetworkError: 1 } });
  await assert.rejects(mw(makeCtx(), async () => 'x'), (err) => err.code === 'ECONNRESET');
});

// ---- Garbage fault --------------------------------------------------

test('chaosInjector: rateGarbage replaces text but calls next()', async () => {
  const mw = chaosInjector({ faults: { rateGarbage: 1 } });
  let upstreamCalled = false;
  const r = await mw(makeCtx(), async () => {
    upstreamCalled = true;
    return { text: 'clean answer', data: { parsed: true } };
  });
  assert.ok(upstreamCalled);
  assert.notEqual(r.text, 'clean answer');
  assert.equal('data' in r, false);
  assert.equal('parsed' in r, false);
});

test('chaosInjector: rateGarbage with primitive result wraps in object', async () => {
  const mw = chaosInjector({ faults: { rateGarbage: 1 } });
  const r = await mw(makeCtx(), async () => 'plain string');
  assert.ok(r && typeof r === 'object');
  assert.equal(typeof r.text, 'string');
});

test('chaosInjector: custom garbageBodies used', async () => {
  const mw = chaosInjector({
    faults: { rateGarbage: 1 },
    garbageBodies: ['ONLY THIS'],
  });
  const r = await mw(makeCtx(), async () => ({ text: 'x' }));
  assert.equal(r.text, 'ONLY THIS');
});

// ---- Slow fault ----------------------------------------------------

test('chaosInjector: rateSlow delays but still calls next()', async () => {
  const sleeps = [];
  const mw = chaosInjector({
    faults: { rateSlow: 1 },
    slowMs: 100,
    sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
  });
  const r = await mw(makeCtx(), async () => ({ text: 'delayed' }));
  assert.deepEqual(sleeps, [100]);
  assert.deepEqual(r, { text: 'delayed' });
});

// ---- Determinism ---------------------------------------------------

test('chaosInjector: same seed → identical fault sequence', async () => {
  const patternA = [];
  const mwA = chaosInjector({
    seed: 42, faults: { rate429: 0.5, rateTimeout: 0.3 },
    onInject: (i) => patternA.push(i.fault),
  });
  for (let i = 0; i < 20; i++) {
    try { await mwA(makeCtx(), async () => 'ok'); } catch { /* injected */ }
  }
  const patternB = [];
  const mwB = chaosInjector({
    seed: 42, faults: { rate429: 0.5, rateTimeout: 0.3 },
    onInject: (i) => patternB.push(i.fault),
  });
  for (let i = 0; i < 20; i++) {
    try { await mwB(makeCtx(), async () => 'ok'); } catch { /* injected */ }
  }
  assert.deepEqual(patternA, patternB);
});

test('chaosInjector: different seeds → different fault sequences', async () => {
  const collect = async (seed) => {
    const p = [];
    const mw = chaosInjector({
      seed, faults: { rate429: 0.5, rateTimeout: 0.3 },
      onInject: (i) => p.push(i.fault),
    });
    for (let i = 0; i < 30; i++) {
      try { await mw(makeCtx(), async () => 'ok'); } catch {}
    }
    return p;
  };
  const a = await collect(42);
  const b = await collect(43);
  assert.notDeepEqual(a, b);
});

test('chaosInjector: priority order — networkError beats 429 on same roll', async () => {
  // Both at 1.0; networkError should always win (it's first in FAULT_ORDER).
  const mw = chaosInjector({
    faults: { rateNetworkError: 1, rate429: 1 },
  });
  for (let i = 0; i < 5; i++) {
    await assert.rejects(mw(makeCtx(), async () => 'ok'),
      (err) => err.code === 'ECONNRESET');
  }
  assert.equal(mw.stats.byFault.rateNetworkError, 5);
  assert.equal(mw.stats.byFault.rate429, 0);
});

// ---- Filter --------------------------------------------------------

test('chaosInjector: filter=false → skip injection entirely', async () => {
  const mw = chaosInjector({
    faults: { rate429: 1 },
    filter: (ctx) => ctx.request.prompt === 'chaos-me',
  });
  const r = await mw({ request: { prompt: 'safe' } }, async () => 'ok');
  assert.equal(r, 'ok');
  assert.equal(mw.stats.skippedByFilter, 1);
  assert.equal(mw.stats.injected, 0);
});

test('chaosInjector: filter=true → injection proceeds', async () => {
  const mw = chaosInjector({
    faults: { rate429: 1 },
    filter: (ctx) => ctx.request.prompt === 'chaos-me',
  });
  await assert.rejects(
    mw({ request: { prompt: 'chaos-me' } }, async () => 'ok'),
    (err) => err.status === 429,
  );
});

// ---- Callback ------------------------------------------------------

test('chaosInjector: onInject fires with fault type', async () => {
  const events = [];
  const mw = chaosInjector({
    faults: { rate429: 1 },
    onInject: (i) => events.push(i.fault),
  });
  try { await mw(makeCtx(), async () => 'x'); } catch {}
  assert.deepEqual(events, ['rate429']);
});

test('chaosInjector: onInject throw swallowed', async () => {
  const mw = chaosInjector({
    faults: { rateGarbage: 1 },
    onInject: () => { throw new Error('hook bug'); },
  });
  const r = await mw(makeCtx(), async () => ({ text: 'x' }));
  assert.ok(r);
});

// ---- Stats + MCP ---------------------------------------------------

test('chaosInjector: injectionRate + reset', async () => {
  const mw = chaosInjector({ faults: { rate429: 1 } });
  for (let i = 0; i < 3; i++) {
    try { await mw(makeCtx(), async () => 'x'); } catch {}
  }
  assert.equal(mw.stats.totalCalls, 3);
  assert.equal(mw.injectionRate(), 1);
  mw.reset();
  assert.equal(mw.stats.totalCalls, 0);
  assert.equal(mw.injectionRate(), 0);
});

test('chaosInjector: asMcpResource', () => {
  const mw = chaosInjector({
    seed: 7, faults: { rate429: 0.5 }, slowMs: 2000,
  });
  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://chaos-injector');
  const p = r.handler();
  assert.equal(p.seed, 7);
  assert.equal(p.slowMs, 2000);
  assert.equal(p.faults.rate429, 0.5);
  assert.equal(p.faults.rateTimeout, 0);
});

// ---- Interaction with retryOnRateLimit (integration smoke) ---------

test('chaosInjector: 429 injection → downstream can retry', async () => {
  const mw = chaosInjector({ seed: 1, faults: { rate429: 0.5 } });
  // Simulate a naive external retry loop.
  let successes = 0;
  for (let i = 0; i < 30; i++) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await mw(makeCtx(), async () => 'ok');
        successes++;
        break;
      } catch (err) {
        if (err.status !== 429) throw err;
      }
    }
  }
  assert.ok(successes > 15, `expected at least half to succeed on retry, got ${successes}`);
});
