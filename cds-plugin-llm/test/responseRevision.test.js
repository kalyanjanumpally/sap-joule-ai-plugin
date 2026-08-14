const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_rr__';
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
  responseRevision,
  defaultBuildRevisionPrompt,
  defaultApplyRevision,
} = require('../lib/middleware/responseRevision');

// ---- Helpers ----------------------------------------------------------

function ctxWith(messages = [{ role: 'user', content: 'q' }]) {
  return { request: { messages } };
}

/** Scripted downstream: array of results, one per next() call. */
function scriptDownstream(scripts) {
  let i = 0;
  return async () => scripts[i++ % scripts.length];
}

// ---- defaultBuildRevisionPrompt ---------------------------------

test('defaultBuildRevisionPrompt: includes score + feedback + threshold', () => {
  const p = defaultBuildRevisionPrompt({
    previousText: 'old', score: 0.4, feedback: '- missing keyword',
    revisionIndex: 0, scoreThreshold: 0.8,
  });
  assert.ok(p.includes('40%'));
  assert.ok(p.includes('80%'));
  assert.ok(p.includes('missing keyword'));
});

test('defaultBuildRevisionPrompt: no feedback → still forms prompt', () => {
  const p = defaultBuildRevisionPrompt({
    previousText: 'x', score: 0.3, feedback: '', revisionIndex: 0, scoreThreshold: 0.7,
  });
  assert.ok(p.includes('30%'));
  assert.ok(p.includes('Revision 1'));
});

// ---- defaultApplyRevision ------------------------

test('defaultApplyRevision: appends assistant + user message', () => {
  const req = { messages: [{ role: 'user', content: 'original' }] };
  const out = defaultApplyRevision(req, 'please revise', { text: 'bad answer' });
  assert.equal(out.messages.length, 3);
  assert.equal(out.messages[1].role, 'assistant');
  assert.equal(out.messages[1].content, 'bad answer');
  assert.equal(out.messages[2].role, 'user');
  assert.equal(out.messages[2].content, 'please revise');
});

test('defaultApplyRevision: skips assistant append when no previous text', () => {
  const req = { messages: [{ role: 'user', content: 'x' }] };
  const out = defaultApplyRevision(req, 'revise', {});
  assert.equal(out.messages.length, 2);
});

// ---- Validation --------------------------------------

test('responseRevision: throws without scorer', () => {
  assert.throws(() => responseRevision({}), /scorer/);
});
test('responseRevision: throws on out-of-range threshold', () => {
  assert.throws(() => responseRevision({ scorer: () => 0.5, scoreThreshold: 0 }), /scoreThreshold/);
  assert.throws(() => responseRevision({ scorer: () => 0.5, scoreThreshold: 1.5 }), /scoreThreshold/);
});
test('responseRevision: throws on negative maxRevisions', () => {
  assert.throws(() => responseRevision({ scorer: () => 0.5, maxRevisions: -1 }), /maxRevisions/);
});
test('responseRevision: throws on non-function callback', () => {
  assert.throws(() => responseRevision({ scorer: () => 0.5, onRevision: 'x' }), /callbacks/);
});
test('responseRevision: throws on non-function buildRevisionPrompt', () => {
  assert.throws(() => responseRevision({ scorer: () => 0.5, buildRevisionPrompt: 'x' }), /buildRevisionPrompt/);
});

// ---- Pass first try -----------------

test('responseRevision: score above threshold on first try → returns immediately', async () => {
  const mw = responseRevision({ scorer: () => 0.9, scoreThreshold: 0.7 });
  let calls = 0;
  const r = await mw(ctxWith(), async () => { calls++; return { text: 'good' }; });
  assert.equal(r.text, 'good');
  assert.equal(calls, 1);
  assert.equal(mw.stats.passedFirstTry, 1);
  assert.equal(mw.stats.totalRevisions, 0);
});

// ---- Revise once, then pass ---------

test('responseRevision: below threshold → revises, then passes', async () => {
  const scripts = [
    { text: 'bad' },
    { text: 'good' },
  ];
  let calls = 0;
  const scores = [0.4, 0.9];
  const mw = responseRevision({
    scorer:         () => scores[calls - 1],
    scoreThreshold: 0.7,
    maxRevisions:   2,
  });
  const r = await mw(ctxWith(), async () => { calls++; return scripts[calls - 1]; });
  assert.equal(r.text, 'good');
  assert.equal(calls, 2);
  assert.equal(mw.stats.passedAfterRevision, 1);
  assert.equal(mw.stats.totalRevisions, 1);
});

test('responseRevision: revision appends assistant + user message to request', async () => {
  let seenMessages;
  let attempt = 0;
  const mw = responseRevision({
    scorer: () => (attempt === 1 ? 0.4 : 0.9),
    scoreThreshold: 0.7, maxRevisions: 2,
  });
  const ctx = ctxWith([{ role: 'user', content: 'original question' }]);
  await mw(ctx, async () => {
    attempt++;
    if (attempt === 2) seenMessages = ctx.request.messages;
    return { text: attempt === 1 ? 'bad' : 'good' };
  });
  // 2nd call should have: user (orig) + assistant (bad) + user (revision).
  assert.equal(seenMessages.length, 3);
  assert.equal(seenMessages[0].role, 'user');
  assert.equal(seenMessages[1].role, 'assistant');
  assert.equal(seenMessages[1].content, 'bad');
  assert.equal(seenMessages[2].role, 'user');
});

// ---- Give up after maxRevisions -------

test('responseRevision: exhausts revisions → returns best result + counts givenUp', async () => {
  const mw = responseRevision({
    scorer: () => 0.3,   // always below
    scoreThreshold: 0.7,
    maxRevisions: 2,
  });
  const r = await mw(ctxWith(), async () => ({ text: 'still bad' }));
  assert.equal(r.text, 'still bad');
  assert.equal(mw.stats.gaveUp, 1);
  assert.equal(mw.stats.totalRevisions, 2);
});

test('responseRevision: returns the best-scoring result even when all fail', async () => {
  const scores = [0.3, 0.5, 0.4];
  const texts = ['A', 'B', 'C'];
  let call = 0;
  const mw = responseRevision({
    scorer: () => scores[call - 1],
    scoreThreshold: 0.9,
    maxRevisions: 2,
  });
  const r = await mw(ctxWith(), async () => { call++; return { text: texts[call - 1] }; });
  // Best score was 0.5 → text 'B'.
  assert.equal(r.text, 'B');
});

// ---- maxRevisions=0 -----------

test('responseRevision: maxRevisions=0 → no retries even if below threshold', async () => {
  let calls = 0;
  const mw = responseRevision({
    scorer: () => 0.1, scoreThreshold: 0.9, maxRevisions: 0,
  });
  const r = await mw(ctxWith(), async () => { calls++; return { text: 'bad' }; });
  assert.equal(r.text, 'bad');
  assert.equal(calls, 1);
  assert.equal(mw.stats.gaveUp, 1);
});

// ---- Scorer variants -------------

test('responseRevision: scorer returns plain number (no feedback)', async () => {
  const mw = responseRevision({ scorer: () => 0.9, scoreThreshold: 0.7 });
  const r = await mw(ctxWith(), async () => ({ text: 'ok' }));
  assert.equal(r.text, 'ok');
});

test('responseRevision: scorer returns object with score + feedback', async () => {
  const feedbackSeen = [];
  const mw = responseRevision({
    scorer: () => ({ score: 0.4, feedback: 'missing detail' }),
    scoreThreshold: 0.7, maxRevisions: 1,
    onRevision: (i) => feedbackSeen.push(i.feedback),
  });
  await mw(ctxWith(), async () => ({ text: 'x' }));
  assert.deepEqual(feedbackSeen, ['missing detail']);
});

test('responseRevision: scorer throws → treated as unscorable → returns first result', async () => {
  const errors = [];
  const mw = responseRevision({
    scorer: () => { throw new Error('bad scorer'); },
    scoreThreshold: 0.7,
    onError: (i) => errors.push(i),
  });
  const r = await mw(ctxWith(), async () => ({ text: 'as-is' }));
  assert.equal(r.text, 'as-is');
  assert.equal(mw.stats.scoreErrors, 1);
  assert.equal(errors[0].phase, 'scorer');
});

test('responseRevision: scorer returns non-number/object → treated as unscorable', async () => {
  const mw = responseRevision({
    scorer: () => 'not-a-number',
    scoreThreshold: 0.7,
  });
  const r = await mw(ctxWith(), async () => ({ text: 'x' }));
  assert.equal(r.text, 'x');
});

// ---- Original request restored -----

test('responseRevision: restores original request after final result', async () => {
  const mw = responseRevision({
    scorer: () => 0.3, scoreThreshold: 0.9, maxRevisions: 2,
  });
  const ctx = ctxWith();
  const original = ctx.request;
  await mw(ctx, async () => ({ text: 'x' }));
  assert.equal(ctx.request, original);
});

// ---- Callbacks -----------

test('responseRevision: onRevision fires per revision', async () => {
  const events = [];
  let call = 0;
  const mw = responseRevision({
    scorer: () => (call < 3 ? 0.3 : 0.9),   // 1st + 2nd score low; 3rd passes
    scoreThreshold: 0.7, maxRevisions: 3,
    onRevision: (i) => events.push(i.revisionIndex),
  });
  await mw(ctxWith(), async () => { call++; return { text: 'x' }; });
  // 2 revisions before passing on 3rd call.
  assert.deepEqual(events, [0, 1]);
});

test('responseRevision: onFinalize fires with pass info', async () => {
  const events = [];
  const mw = responseRevision({
    scorer: () => 0.9, scoreThreshold: 0.7,
    onFinalize: (i) => events.push(i),
  });
  await mw(ctxWith(), async () => ({ text: 'good' }));
  assert.equal(events.length, 1);
  assert.equal(events[0].passed, true);
  assert.equal(events[0].revisions, 0);
});

test('responseRevision: onGiveUp fires when exhausted', async () => {
  const events = [];
  const mw = responseRevision({
    scorer: () => 0.3, scoreThreshold: 0.9, maxRevisions: 1,
    onGiveUp: (i) => events.push(i),
  });
  await mw(ctxWith(), async () => ({ text: 'x' }));
  assert.equal(events.length, 1);
  assert.equal(events[0].bestScore, 0.3);
  assert.equal(events[0].scoreThreshold, 0.9);
});

test('responseRevision: callback throws swallowed', async () => {
  const mw = responseRevision({
    scorer: () => 0.9, scoreThreshold: 0.7,
    onFinalize: () => { throw new Error('x'); },
  });
  const r = await mw(ctxWith(), async () => ({ text: 'x' }));
  assert.equal(r.text, 'x');
});

// ---- Custom applyRevision / buildRevisionPrompt ------

test('responseRevision: custom applyRevision is used', async () => {
  let seenSystem;
  let attempt = 0;
  const mw = responseRevision({
    scorer: () => (attempt === 1 ? 0.4 : 0.9),
    scoreThreshold: 0.7, maxRevisions: 1,
    applyRevision: (req, prompt) => ({ ...req, system: prompt }),
  });
  const ctx = ctxWith();
  await mw(ctx, async () => {
    attempt++;
    if (attempt === 2) seenSystem = ctx.request.system;
    return { text: 'x' };
  });
  assert.ok(seenSystem && seenSystem.includes('40%'));
});

test('responseRevision: buildRevisionPrompt error → falls back to best result', async () => {
  const errors = [];
  const mw = responseRevision({
    scorer: () => 0.3, scoreThreshold: 0.9, maxRevisions: 3,
    buildRevisionPrompt: () => { throw new Error('build broke'); },
    onError: (i) => errors.push(i),
  });
  const r = await mw(ctxWith(), async () => ({ text: 'best-we-have' }));
  assert.equal(r.text, 'best-we-have');
  assert.equal(errors[0].phase, 'buildRevisionPrompt');
});

// ---- Stats + MCP + reset --------

test('responseRevision: avgRevisions + passRate', async () => {
  const mw = responseRevision({
    scorer: () => 0.9, scoreThreshold: 0.7, maxRevisions: 2,
  });
  await mw(ctxWith(), async () => ({ text: 'x' }));
  await mw(ctxWith(), async () => ({ text: 'y' }));
  assert.equal(mw.avgRevisions(), 0);
  assert.equal(mw.passRate(), 1);
});

test('responseRevision: reset zeroes counters', async () => {
  const mw = responseRevision({ scorer: () => 0.9, scoreThreshold: 0.7 });
  await mw(ctxWith(), async () => ({ text: 'x' }));
  assert.equal(mw.stats.totalCalls, 1);
  mw.reset();
  assert.equal(mw.stats.totalCalls, 0);
  assert.equal(mw.avgRevisions(), 0);
});

test('responseRevision: asMcpResource', () => {
  const mw = responseRevision({ scorer: () => 0.9, scoreThreshold: 0.85, maxRevisions: 4 });
  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://response-revision');
  const p = r.handler();
  assert.equal(p.scoreThreshold, 0.85);
  assert.equal(p.maxRevisions, 4);
});
