const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_pe__';
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
  promptExperiment,
  hash32,
  welfordUpdate,
  welfordStats,
  ciAroundMean,
} = require('../lib/middleware/promptExperiment');

// ---- Helpers ----------------------------------------------------------

function ctxWith(userId) { return { request: { userId, prompt: 'x' } }; }

// ---- hash32 ---------------------------------------------------------

test('hash32: deterministic', () => {
  assert.equal(hash32('foo'), hash32('foo'));
});
test('hash32: different strings → different hashes', () => {
  assert.notEqual(hash32('foo'), hash32('bar'));
});
test('hash32: returns unsigned 32-bit', () => {
  const h = hash32('anything');
  assert.ok(h >= 0);
  assert.ok(h < 2 ** 32);
});

// ---- Welford ---------------------------------------------------

test('welfordUpdate: mean + variance after N samples', () => {
  const s = { count: 0, mean: 0, m2: 0 };
  const samples = [10, 20, 30, 40, 50];
  for (const x of samples) welfordUpdate(s, x);
  const stats = welfordStats(s);
  assert.equal(stats.count, 5);
  assert.equal(stats.mean, 30);
  // Sample variance of [10,20,30,40,50] = 250
  assert.equal(stats.variance, 250);
});

test('welfordUpdate: single sample → variance 0', () => {
  const s = { count: 0, mean: 0, m2: 0 };
  welfordUpdate(s, 42);
  const stats = welfordStats(s);
  assert.equal(stats.mean, 42);
  assert.equal(stats.variance, 0);
});

// ---- ciAroundMean -------------------------------

test('ciAroundMean: n < 2 → point interval', () => {
  const [lo, hi] = ciAroundMean(5, 0, 1);
  assert.equal(lo, 5);
  assert.equal(hi, 5);
});

test('ciAroundMean: n=100, stddev=1 → width ~= 2*1.96/10 = 0.392', () => {
  const [lo, hi] = ciAroundMean(10, 1, 100);
  const width = hi - lo;
  assert.ok(Math.abs(width - 2 * 1.96 * 0.1) < 1e-9);
});

// ---- Validation ----------------------------

test('promptExperiment: throws without name', () => {
  assert.throws(() => promptExperiment({
    variants: [{ name: 'a' }, { name: 'b' }],
    splitKeyOf: () => 'x', scorer: () => 0.5,
  }), /name/);
});
test('promptExperiment: throws on <2 variants', () => {
  assert.throws(() => promptExperiment({
    name: 'e', variants: [{ name: 'a' }],
    splitKeyOf: () => 'x', scorer: () => 0.5,
  }), /at least 2/);
});
test('promptExperiment: throws on duplicate variant name', () => {
  assert.throws(() => promptExperiment({
    name: 'e', variants: [{ name: 'a' }, { name: 'a' }],
    splitKeyOf: () => 'x', scorer: () => 0.5,
  }), /duplicate/);
});
test('promptExperiment: throws on invalid weight', () => {
  assert.throws(() => promptExperiment({
    name: 'e',
    variants: [{ name: 'a', weight: 0 }, { name: 'b' }],
    splitKeyOf: () => 'x', scorer: () => 0.5,
  }), /weight/);
});
test('promptExperiment: throws on non-function apply', () => {
  assert.throws(() => promptExperiment({
    name: 'e',
    variants: [{ name: 'a', apply: 'x' }, { name: 'b' }],
    splitKeyOf: () => 'x', scorer: () => 0.5,
  }), /apply/);
});
test('promptExperiment: throws without splitKeyOf', () => {
  assert.throws(() => promptExperiment({
    name: 'e', variants: [{ name: 'a' }, { name: 'b' }], scorer: () => 0.5,
  }), /splitKeyOf/);
});
test('promptExperiment: throws without scorer', () => {
  assert.throws(() => promptExperiment({
    name: 'e', variants: [{ name: 'a' }, { name: 'b' }], splitKeyOf: () => 'x',
  }), /scorer/);
});
test('promptExperiment: throws on invalid minSampleSize', () => {
  assert.throws(() => promptExperiment({
    name: 'e', variants: [{ name: 'a' }, { name: 'b' }],
    splitKeyOf: () => 'x', scorer: () => 0.5, minSampleSize: 1,
  }), /minSampleSize/);
});
test('promptExperiment: throws on non-function callback', () => {
  assert.throws(() => promptExperiment({
    name: 'e', variants: [{ name: 'a' }, { name: 'b' }],
    splitKeyOf: () => 'x', scorer: () => 0.5, onSample: 'x',
  }), /callbacks/);
});

// ---- Consistent assignment --------------------------------

test('promptExperiment: same splitKey always maps to same variant', async () => {
  const mw = promptExperiment({
    name: 'exp1',
    variants: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
    splitKeyOf: (ctx) => ctx.request.userId,
    scorer: () => 0.5,
  });
  const userToVariant = new Map();
  for (const u of ['u1', 'u2', 'u3', 'u4', 'u5', 'u6']) {
    for (let i = 0; i < 3; i++) {
      await mw(ctxWith(u), async () => ({ text: 'x' }));
      const v = mw.stats.lastVariant;
      if (userToVariant.has(u)) {
        assert.equal(userToVariant.get(u), v);
      } else {
        userToVariant.set(u, v);
      }
    }
  }
});

test('promptExperiment: distinct experiments assign independently', async () => {
  const mw1 = promptExperiment({
    name: 'exp1',
    variants: [{ name: 'a' }, { name: 'b' }],
    splitKeyOf: (ctx) => ctx.request.userId,
    scorer: () => 0.5,
  });
  const mw2 = promptExperiment({
    name: 'exp2',
    variants: [{ name: 'a' }, { name: 'b' }],
    splitKeyOf: (ctx) => ctx.request.userId,
    scorer: () => 0.5,
  });
  // Same user may land on different variants in different experiments.
  const seen1 = new Set(), seen2 = new Set();
  for (const u of ['u1','u2','u3','u4','u5','u6','u7','u8']) {
    await mw1(ctxWith(u), async () => ({ text: 'x' }));
    seen1.add(u + ':' + mw1.stats.lastVariant);
    await mw2(ctxWith(u), async () => ({ text: 'x' }));
    seen2.add(u + ':' + mw2.stats.lastVariant);
  }
  // The two sets should differ (different hash prefix).
  assert.notDeepEqual([...seen1].sort(), [...seen2].sort());
});

// ---- Weighted split ---------------------------

test('promptExperiment: weights bias variant frequencies', async () => {
  const mw = promptExperiment({
    name: 'exp',
    variants: [
      { name: 'heavy', weight: 9 },
      { name: 'light', weight: 1 },
    ],
    splitKeyOf: (ctx) => ctx.request.userId,
    scorer: () => 0.5,
  });
  const counts = { heavy: 0, light: 0 };
  for (let i = 0; i < 1000; i++) {
    await mw(ctxWith('user-' + i), async () => ({ text: 'x' }));
    counts[mw.stats.lastVariant]++;
  }
  // Heavy should get roughly 90% ± noise.
  assert.ok(counts.heavy > 800, `heavy=${counts.heavy}`);
  assert.ok(counts.light > 50, `light=${counts.light}`);
});

// ---- Applies variant modifications ---------------

test('promptExperiment: variant.apply mutates request', async () => {
  const mw = promptExperiment({
    name: 'exp',
    variants: [
      { name: 'plain' },
      { name: 'terse', apply: (req) => ({ ...req, system: 'be terse' }) },
      { name: 'wordy', apply: (req) => ({ ...req, system: 'be wordy' }) },
    ],
    splitKeyOf: (ctx) => ctx.request.userId,
    scorer: () => 0.5,
  });
  // Walk many users until we hit each variant.
  const seenSystems = new Set();
  for (let i = 0; i < 50; i++) {
    const ctx = ctxWith('u-' + i);
    await mw(ctx, async () => {
      seenSystems.add(ctx.request.system);
      return { text: 'x' };
    });
    if (seenSystems.size >= 3) break;
  }
  assert.ok(seenSystems.has(undefined));
  assert.ok(seenSystems.has('be terse'));
  assert.ok(seenSystems.has('be wordy'));
});

test('promptExperiment: original request restored after call', async () => {
  const mw = promptExperiment({
    name: 'exp',
    variants: [{ name: 'a', apply: (r) => ({ ...r, system: 'X' }) }, { name: 'b' }],
    splitKeyOf: (ctx) => ctx.request.userId,
    scorer: () => 0.5,
  });
  const ctx = ctxWith('u1');
  const original = ctx.request;
  await mw(ctx, async () => ({ text: 'x' }));
  assert.equal(ctx.request, original);
});

// ---- Passthrough on no split key ---------------

test('promptExperiment: no split key → passthrough', async () => {
  const mw = promptExperiment({
    name: 'exp',
    variants: [{ name: 'a' }, { name: 'b' }],
    splitKeyOf: () => null,
    scorer: () => 0.5,
  });
  const ctx = ctxWith('anon');
  const original = ctx.request;
  await mw(ctx, async () => ({ text: 'x' }));
  assert.equal(ctx.request, original);
  assert.equal(mw.stats.passthroughs, 1);
});

// ---- Stats tracking -------------------------

test('promptExperiment: score / latency stats accumulate per variant', async () => {
  let t = 0;
  const mw = promptExperiment({
    name: 'exp',
    variants: [{ name: 'a' }, { name: 'b' }],
    splitKeyOf: (ctx) => ctx.request.userId,
    scorer: (r) => r.score,
    now: () => t,
  });
  for (let i = 0; i < 20; i++) {
    t = i * 100;
    await mw(ctxWith('u' + i), async () => {
      t += 50;
      return { text: 'x', score: i / 20 };
    });
  }
  const snap = mw.snapshotVariants();
  const total = snap.reduce((a, v) => a + v.sampleCount, 0);
  assert.equal(total, 20);
  for (const v of snap) {
    assert.ok(v.sampleCount > 0);
    assert.ok(v.latencyMean > 0);
  }
});

test('promptExperiment: cost tracked via costEstimator', async () => {
  const mw = promptExperiment({
    name: 'exp',
    variants: [{ name: 'a' }, { name: 'b' }],
    splitKeyOf: (ctx) => ctx.request.userId,
    scorer: () => 0.5,
    costEstimator: (r) => r.tokens * 0.001,
  });
  for (let i = 0; i < 20; i++) {
    await mw(ctxWith('u' + i), async () => ({ text: 'x', tokens: 100 }));
  }
  const snap = mw.snapshotVariants();
  const totalCost = snap.reduce((a, v) => a + v.totalCostUsd, 0);
  assert.ok(Math.abs(totalCost - 20 * 0.1) < 1e-9);   // 20 calls × 100 tokens × 0.001
});

test('promptExperiment: scorer error captured, does not break call', async () => {
  const errors = [];
  const mw = promptExperiment({
    name: 'exp',
    variants: [{ name: 'a' }, { name: 'b' }],
    splitKeyOf: (ctx) => ctx.request.userId,
    scorer: () => { throw new Error('bad'); },
    onError: (i) => errors.push(i),
  });
  const r = await mw(ctxWith('u1'), async () => ({ text: 'x' }));
  assert.equal(r.text, 'x');
  assert.equal(mw.stats.scorerErrors, 1);
  assert.equal(errors[0].phase, 'scorer');
});

test('promptExperiment: downstream error tracked per variant', async () => {
  const mw = promptExperiment({
    name: 'exp',
    variants: [{ name: 'a' }, { name: 'b' }],
    splitKeyOf: (ctx) => ctx.request.userId,
    scorer: () => 0.5,
  });
  await assert.rejects(mw(ctxWith('u1'), async () => { throw new Error('down'); }));
  const snap = mw.snapshotVariants();
  const totalErrors = snap.reduce((a, v) => a + v.errors, 0);
  assert.equal(totalErrors, 1);
});

// ---- Winner detection ------------------------

test('promptExperiment: getWinner insufficient-samples when small', async () => {
  const mw = promptExperiment({
    name: 'exp',
    variants: [{ name: 'a' }, { name: 'b' }],
    splitKeyOf: (ctx) => ctx.request.userId,
    scorer: () => 0.5,
    minSampleSize: 5,
  });
  await mw(ctxWith('u1'), async () => ({ text: 'x' }));
  const w = mw.getWinner();
  assert.equal(w.winner, null);
  assert.equal(w.status, 'insufficient-samples');
});

test('promptExperiment: getWinner declares winner when CIs disjoint', async () => {
  const mw = promptExperiment({
    name: 'exp',
    variants: [
      { name: 'good' },
      { name: 'bad' },
    ],
    splitKeyOf: (ctx) => ctx.request.userId,
    scorer: (r) => r.score,
    minSampleSize: 30,
  });
  // Simulate 100 users, 'good' scores near 0.9, 'bad' near 0.1.
  for (let i = 0; i < 200; i++) {
    const ctx = ctxWith('u' + i);
    await mw(ctx, async () => {
      // Give the variant a score that matches its intent.
      const targetScore = mw.stats.lastVariant === 'good' ? 0.9 : 0.1;
      // Tiny jitter so variance isn't 0.
      return { text: 'x', score: targetScore + (i % 5) * 0.001 };
    });
  }
  const w = mw.getWinner();
  assert.equal(w.status, 'confident');
  assert.equal(w.winner, 'good');
});

test('promptExperiment: getWinner inconclusive-overlap when tied', async () => {
  const mw = promptExperiment({
    name: 'exp',
    variants: [{ name: 'a' }, { name: 'b' }],
    splitKeyOf: (ctx) => ctx.request.userId,
    scorer: () => 0.5 + (Math.random() - 0.5) * 0.02,   // all near 0.5
    minSampleSize: 30,
  });
  for (let i = 0; i < 100; i++) {
    await mw(ctxWith('u' + i), async () => ({ text: 'x' }));
  }
  const w = mw.getWinner();
  assert.equal(w.status, 'inconclusive-overlap');
  assert.equal(w.winner, null);
});

test('promptExperiment: onWinner fires only when confident', async () => {
  const events = [];
  const mw = promptExperiment({
    name: 'exp',
    variants: [{ name: 'good' }, { name: 'bad' }],
    splitKeyOf: (ctx) => ctx.request.userId,
    scorer: (r) => r.score,
    minSampleSize: 30,
    onWinner: (i) => events.push(i.winner),
  });
  for (let i = 0; i < 200; i++) {
    await mw(ctxWith('u' + i), async () => {
      const target = mw.stats.lastVariant === 'good' ? 0.9 : 0.1;
      return { text: 'x', score: target + (i % 5) * 0.001 };
    });
  }
  mw.getWinner();
  assert.ok(events.includes('good'));
});

// ---- Callbacks ---------------------------

test('promptExperiment: onSample fires per call', async () => {
  const events = [];
  const mw = promptExperiment({
    name: 'exp',
    variants: [{ name: 'a' }, { name: 'b' }],
    splitKeyOf: (ctx) => ctx.request.userId,
    scorer: () => 0.5,
    onSample: (i) => events.push(i.variant),
  });
  for (let i = 0; i < 5; i++) await mw(ctxWith('u' + i), async () => ({ text: 'x' }));
  assert.equal(events.length, 5);
});

test('promptExperiment: callback throws swallowed', async () => {
  const mw = promptExperiment({
    name: 'exp',
    variants: [{ name: 'a' }, { name: 'b' }],
    splitKeyOf: (ctx) => ctx.request.userId,
    scorer: () => 0.5,
    onSample: () => { throw new Error('x'); },
  });
  await mw(ctxWith('u1'), async () => ({ text: 'x' }));
});

// ---- Reset + MCP -------------------

test('promptExperiment: reset clears all stats', async () => {
  const mw = promptExperiment({
    name: 'exp',
    variants: [{ name: 'a' }, { name: 'b' }],
    splitKeyOf: (ctx) => ctx.request.userId,
    scorer: () => 0.5,
    costEstimator: () => 0.01,
  });
  for (let i = 0; i < 5; i++) await mw(ctxWith('u' + i), async () => ({ text: 'x' }));
  assert.ok(mw.stats.totalCalls > 0);
  mw.reset();
  assert.equal(mw.stats.totalCalls, 0);
  const snap = mw.snapshotVariants();
  for (const v of snap) {
    assert.equal(v.sampleCount, 0);
    assert.equal(v.totalCostUsd, 0);
  }
});

test('promptExperiment: asMcpResource has experiment URI', () => {
  const mw = promptExperiment({
    name: 'my-experiment',
    variants: [{ name: 'a' }, { name: 'b' }],
    splitKeyOf: (ctx) => ctx.request.userId,
    scorer: () => 0.5,
  });
  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://prompt-experiment/my-experiment');
  const p = r.handler();
  assert.equal(p.experimentName, 'my-experiment');
  assert.equal(p.variants.length, 2);
  assert.equal(p.minSampleSize, 30);
});
