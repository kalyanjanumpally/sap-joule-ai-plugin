const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_car__';
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

const { costAwareRouter, labelForTier } = require('../lib/middleware/costAwareRouter');

// ---- Helpers ----------------------------------------------------------

const TIERS = [
  { model: 'cheap',   pricePerMtokIn: 0.15, pricePerMtokOut: 0.60 },
  { model: 'premium', pricePerMtokIn: 2.50, pricePerMtokOut: 10.00 },
];

function makeCtx(prompt = 'hi') {
  return { request: { prompt, messages: [{ role: 'user', content: prompt }] } };
}

function respWith(text, usage) {
  return { text, usage: usage ?? { input_tokens: 100, output_tokens: 200 } };
}

// ---- labelForTier -----------------------------------------------------

test('labelForTier: 0, 1, 2', () => {
  assert.equal(labelForTier(0), 'tier0');
  assert.equal(labelForTier(1), 'tier1');
  assert.equal(labelForTier(2), 'tier2');
});
test('labelForTier: beyond named range', () => {
  assert.equal(labelForTier(99), 'tier99');
});

// ---- Validation -------------------------------------------------------

test('costAwareRouter: throws on <2 tiers', () => {
  assert.throws(() => costAwareRouter({ tiers: [{ model: 'x' }], scorer: () => 1 }), /at least 2/);
});
test('costAwareRouter: throws on tier without model', () => {
  assert.throws(() => costAwareRouter({ tiers: [{ price: 1 }, { model: 'y' }], scorer: () => 1 }), /model: string/);
});
test('costAwareRouter: throws without scorer', () => {
  assert.throws(() => costAwareRouter({ tiers: TIERS }), /scorer/);
});
test('costAwareRouter: throws on invalid scoreThreshold', () => {
  assert.throws(() => costAwareRouter({ tiers: TIERS, scorer: () => 1, scoreThreshold: 1.5 }), /scoreThreshold/);
  assert.throws(() => costAwareRouter({ tiers: TIERS, scorer: () => 1, scoreThreshold: -0.1 }), /scoreThreshold/);
});
test('costAwareRouter: throws on non-integer maxEscalations', () => {
  assert.throws(() => costAwareRouter({ tiers: TIERS, scorer: () => 1, maxEscalations: 1.5 }), /maxEscalations/);
});
test('costAwareRouter: throws on non-function applyModel', () => {
  assert.throws(() => costAwareRouter({ tiers: TIERS, scorer: () => 1, applyModel: 'x' }), /applyModel/);
});
test('costAwareRouter: throws on non-function callback', () => {
  assert.throws(() => costAwareRouter({ tiers: TIERS, scorer: () => 1, onEscalate: 'x' }), /callbacks/);
});

// ---- Happy path: cheap wins ------------------------------------------

test('costAwareRouter: score above threshold → resolves on cheap tier', async () => {
  const mw = costAwareRouter({ tiers: TIERS, scorer: () => 0.9, scoreThreshold: 0.7 });
  let modelSeen = null;
  const r = await mw(makeCtx(), async (ctx) => {
    // ctx may be the original — but the mw mutated ctx.request. Read from the closure.
    return respWith('answer');
  });
  // Peek at last tier via stats
  assert.equal(mw.stats.resolvedByTier.tier0, 1);
  assert.equal(mw.stats.escalations, 0);
  assert.equal(mw.stats.lastTier, 'tier0');
});

test('costAwareRouter: model swapped to cheap tier on first attempt', async () => {
  const mw = costAwareRouter({ tiers: TIERS, scorer: () => 0.9 });
  const ctx = makeCtx();
  let observedModel;
  await mw(ctx, async () => {
    observedModel = ctx.request.model;
    return respWith('r');
  });
  assert.equal(observedModel, 'cheap');
});

test('costAwareRouter: original request restored after success', async () => {
  const mw = costAwareRouter({ tiers: TIERS, scorer: () => 0.9 });
  const ctx = makeCtx();
  const original = ctx.request;
  await mw(ctx, async () => respWith('r'));
  assert.equal(ctx.request, original);
});

// ---- Escalation on low score ----------------------------------------

test('costAwareRouter: low score → escalates to premium tier', async () => {
  const mw = costAwareRouter({
    tiers: TIERS,
    scorer: (r) => r.text === 'cheap-out' ? 0.4 : 0.9,
    scoreThreshold: 0.7,
  });
  let attempt = 0;
  const attempts = [];
  const ctx = makeCtx();
  const r = await mw(ctx, async () => {
    attempt++;
    attempts.push(ctx.request.model);
    return attempt === 1 ? respWith('cheap-out') : respWith('premium-out');
  });
  assert.equal(attempt, 2);
  assert.deepEqual(attempts, ['cheap', 'premium']);
  assert.equal(r.text, 'premium-out');
  assert.equal(mw.stats.escalations, 1);
  assert.equal(mw.stats.resolvedByTier.tier1, 1);
  assert.equal(mw.stats.resolvedByTier.tier0, 0);
});

test('costAwareRouter: premium still below threshold → returns it as fallback + increments givenUp', async () => {
  const mw = costAwareRouter({ tiers: TIERS, scorer: () => 0.1, scoreThreshold: 0.7 });
  const r = await mw(makeCtx(), async () => respWith('meh'));
  assert.equal(r.text, 'meh');
  assert.equal(mw.stats.escalations, 1);
  assert.equal(mw.stats.givenUp, 1);
  assert.equal(mw.stats.resolvedByTier.tier1, 1);
});

// ---- maxEscalations cap ---------------------------------------------

test('costAwareRouter: maxEscalations=0 → no escalation ever, returns cheap', async () => {
  const mw = costAwareRouter({
    tiers: TIERS,
    scorer: () => 0.1,          // always low
    scoreThreshold: 0.7,
    maxEscalations: 0,
  });
  const r = await mw(makeCtx(), async (_ctx) => respWith('cheap-only'));
  assert.equal(r.text, 'cheap-only');
  assert.equal(mw.stats.escalations, 0);
  assert.equal(mw.stats.givenUp, 1);
  assert.equal(mw.stats.resolvedByTier.tier0, 1);
});

// ---- Escalate on downstream error ------------------------------------

test('costAwareRouter: escalateOnError=true → next tier tried on cheap error', async () => {
  const mw = costAwareRouter({ tiers: TIERS, scorer: () => 0.9, escalateOnError: true });
  let attempt = 0;
  const r = await mw(makeCtx(), async () => {
    attempt++;
    if (attempt === 1) throw new Error('cheap down');
    return respWith('premium ok');
  });
  assert.equal(r.text, 'premium ok');
  assert.equal(mw.stats.escalations, 1);
  assert.equal(mw.stats.downstreamErrors, 1);
});

test('costAwareRouter: escalateOnError=false → error propagates immediately', async () => {
  const mw = costAwareRouter({ tiers: TIERS, scorer: () => 0.9, escalateOnError: false });
  await assert.rejects(mw(makeCtx(), async () => { throw new Error('cheap down'); }), /cheap down/);
  assert.equal(mw.stats.escalations, 0);
});

test('costAwareRouter: top tier throws → propagates even with escalateOnError=true', async () => {
  const mw = costAwareRouter({ tiers: TIERS, scorer: () => 0.1, escalateOnError: true });
  let attempt = 0;
  await assert.rejects(mw(makeCtx(), async () => {
    attempt++;
    if (attempt === 1) return respWith('low');
    throw new Error('premium fail');
  }), /premium fail/);
});

// ---- Scorer error handling ------------------------------------------

test('costAwareRouter: scorer throws → treated as failing score → escalate', async () => {
  const mw = costAwareRouter({
    tiers: TIERS,
    scorer: () => { throw new Error('scorer bug'); },
    scoreThreshold: 0.7,
  });
  const ctx = makeCtx();
  const r = await mw(ctx, async () => respWith(`resp-${ctx.request.model}`));
  assert.equal(r.text, 'resp-premium');
  assert.equal(mw.stats.scoreExceptions, 2);   // fires on both tiers
});

test('costAwareRouter: scorer returns non-number → treated as failing', async () => {
  const mw = costAwareRouter({
    tiers: TIERS,
    scorer: () => 'not-a-number',
    scoreThreshold: 0.7,
  });
  const ctx = makeCtx();
  const r = await mw(ctx, async () => respWith(`resp-${ctx.request.model}`));
  assert.equal(r.text, 'resp-premium');
  assert.equal(mw.stats.escalations, 1);
});

// ---- Cost accounting -----------------------------------------------

test('costAwareRouter: tokensSpent + tokensSaved computed when priced', async () => {
  const mw = costAwareRouter({ tiers: TIERS, scorer: () => 0.9 });
  await mw(makeCtx(), async () => respWith('r', { input_tokens: 1_000_000, output_tokens: 1_000_000 }));
  // Cheap: (1 * 0.15) + (1 * 0.60) = 0.75
  // Premium: (1 * 2.5) + (1 * 10)   = 12.50
  // Saved by resolving on cheap:    = 11.75
  assert.equal(mw.stats.tokensSpentUsd, 0.75);
  assert.equal(mw.stats.tokensSavedUsd, 11.75);
  assert.equal(mw.savingsRatio(), 11.75 / (0.75 + 11.75));
});

test('costAwareRouter: no savings tracked when resolved on top tier', async () => {
  const mw = costAwareRouter({ tiers: TIERS, scorer: () => 0.1, scoreThreshold: 0.7 });
  await mw(makeCtx(), async (ctx) =>
    respWith('r', { input_tokens: 1_000_000, output_tokens: 1_000_000 }));
  // Escalated to premium; premium spend counted; no savings (was at top).
  assert.equal(mw.stats.tokensSavedUsd, 0);
  assert.equal(mw.stats.tokensSpentUsd, 12.5);
});

test('costAwareRouter: pricing missing → cost accounting skipped without error', async () => {
  const mw = costAwareRouter({
    tiers: [{ model: 'a' }, { model: 'b' }],
    scorer: () => 0.9,
  });
  await mw(makeCtx(), async () => respWith('r'));
  assert.equal(mw.stats.tokensSpentUsd, 0);
  assert.equal(mw.stats.tokensSavedUsd, 0);
  assert.equal(mw.savingsRatio(), 0);
});

// ---- Callbacks -----------------------------------------------------

test('costAwareRouter: onFinal fires with escalation info', async () => {
  const events = [];
  const mw = costAwareRouter({
    tiers: TIERS, scorer: () => 0.9,
    onFinal: (i) => events.push(i),
  });
  await mw(makeCtx(), async () => respWith('r'));
  assert.equal(events.length, 1);
  assert.equal(events[0].tier, 'tier0');
  assert.equal(events[0].escalated, false);
  assert.equal(events[0].aboveThreshold, true);
});

test('costAwareRouter: onEscalate fires with from/to/reason', async () => {
  const events = [];
  const mw = costAwareRouter({
    tiers: TIERS, scorer: () => 0.1, scoreThreshold: 0.7,
    onEscalate: (i) => events.push(i),
  });
  await mw(makeCtx(), async () => respWith('r'));
  assert.equal(events.length, 1);
  assert.equal(events[0].fromTier, 'tier0');
  assert.equal(events[0].toTier, 'tier1');
  assert.equal(events[0].reason, 'low-score');
});

test('costAwareRouter: onError fires for downstream errors', async () => {
  const events = [];
  const mw = costAwareRouter({
    tiers: TIERS, scorer: () => 0.9,
    onError: (i) => events.push(i),
  });
  const ctx = makeCtx();
  await mw(ctx, async () => {
    if (ctx.request.model === 'cheap') throw new Error('boom');
    return respWith('ok');
  });
  const downstream = events.find((e) => e.phase === 'downstream');
  assert.ok(downstream);
  assert.equal(downstream.tier, 'tier0');
});

test('costAwareRouter: callback throws are swallowed', async () => {
  const mw = costAwareRouter({
    tiers: TIERS, scorer: () => 0.9,
    onFinal: () => { throw new Error('x'); },
    onEscalate: () => { throw new Error('x'); },
  });
  const r = await mw(makeCtx(), async () => respWith('ok'));
  assert.equal(r.text, 'ok');
});

// ---- Custom tierName ---------------------------------------------

test('costAwareRouter: custom tierName labels', async () => {
  const mw = costAwareRouter({
    tiers: TIERS,
    scorer: () => 0.1, scoreThreshold: 0.7,
    tierName: (tier, i) => `${tier.model}-${i}`,
  });
  await mw(makeCtx(), async () => respWith('r'));
  assert.ok('cheap-0' in mw.stats.resolvedByTier);
  assert.ok('premium-1' in mw.stats.resolvedByTier);
  assert.equal(mw.stats.resolvedByTier['premium-1'], 1);
});

// ---- Reset + MCP ------------------------------------------------

test('costAwareRouter: reset zeroes counters', async () => {
  const mw = costAwareRouter({ tiers: TIERS, scorer: () => 0.9 });
  await mw(makeCtx(), async () => respWith('r'));
  assert.equal(mw.stats.totalCalls, 1);
  mw.reset();
  assert.equal(mw.stats.totalCalls, 0);
  assert.equal(mw.stats.resolvedByTier.tier0, 0);
  assert.equal(mw.stats.tokensSpentUsd, 0);
});

test('costAwareRouter: escalationRate', async () => {
  const mw = costAwareRouter({ tiers: TIERS, scorer: () => 0.1, scoreThreshold: 0.7 });
  await mw(makeCtx(), async () => respWith('r'));
  await mw(makeCtx(), async () => respWith('r'));
  assert.equal(mw.escalationRate(), 1);
});

test('costAwareRouter: asMcpResource', async () => {
  const mw = costAwareRouter({
    tiers: TIERS, scorer: () => 0.9,
    scoreThreshold: 0.85, maxEscalations: 2,
  });
  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://cost-aware-router');
  const p = r.handler();
  assert.equal(p.scoreThreshold, 0.85);
  assert.equal(p.maxEscalations, 2);
  assert.equal(p.tiers.length, 2);
  assert.equal(p.tiers[0].name, 'tier0');
  assert.equal(p.tiers[0].model, 'cheap');
  assert.equal(p.tiers[0].pricePerMtokIn, 0.15);
});
