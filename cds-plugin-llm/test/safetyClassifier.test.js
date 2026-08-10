const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_safety__';
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
  safetyClassifier,
  SafetyClassifierBlockedError,
} = require('../lib/middleware/safetyClassifier');
const { LLMError } = require('../lib/errors');
const { wrapStreamCompletion } = require('../lib/streamCompletion');

function mockFetch(responseFn) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return responseFn(url, init);
  };
  fn.calls = calls;
  return fn;
}

function moderationOk(scores = {}) {
  return {
    ok: true,
    status: 200,
    async json() {
      return { id: 'modr-x', model: 'test',
        results: [{ flagged: false, categories: {}, category_scores: scores }] };
    },
    async text() { return ''; },
  };
}

// ---- Input validation --------------------------------------------------

test('safetyClassifier: throws on out-of-range threshold', () => {
  assert.throws(() => safetyClassifier({ threshold: 1.5 }), /threshold must be/);
  assert.throws(() => safetyClassifier({ threshold: -0.1 }), /threshold must be/);
});
test('safetyClassifier: throws on invalid action', () => {
  assert.throws(() => safetyClassifier({ action: 'bogus' }), /action must be/);
});
test('safetyClassifier: throws on non-array categories', () => {
  assert.throws(() => safetyClassifier({ categories: 'violence' }), /categories must be an array/);
});
test('safetyClassifier: throws on non-array skipMethods', () => {
  assert.throws(() => safetyClassifier({ skipMethods: 'embed' }), /skipMethods must be/);
});
test('safetyClassifier: throws on non-function onFlag', () => {
  assert.throws(() => safetyClassifier({ onFlag: 'x' }), /onFlag must be/);
});

// ---- Pass-through paths ------------------------------------------------

test('safetyClassifier: passes benign response through', async () => {
  const mw = safetyClassifier({ apiKey: 'k', fetch: mockFetch(() => moderationOk({ violence: 0.01 })) });
  const result = await mw(
    { method: 'chat', request: { messages: [] }, meta: {} },
    async () => ({ text: 'hello, world', stopReason: 'end_turn' }),
  );
  assert.equal(result.text, 'hello, world');
  assert.equal(mw.stats.flagged, 0);
  assert.equal(mw.stats.blocked, 0);
});

test('safetyClassifier: skips embed method by default', async () => {
  const fetch = mockFetch(() => moderationOk({ violence: 0.99 }));
  const mw = safetyClassifier({ apiKey: 'k', fetch });
  await mw(
    { method: 'embed', request: { input: ['x'] }, meta: {} },
    async () => ({ embeddings: [[1, 2, 3]] }),
  );
  assert.equal(fetch.calls.length, 0);
  assert.equal(mw.stats.totalChecks, 0);
});

test('safetyClassifier: skips moderation call when no apiKey', async () => {
  const fetch = mockFetch(() => moderationOk({ violence: 0.99 }));
  const mw = safetyClassifier({ fetch });   // no apiKey
  await mw(
    { method: 'chat', request: { messages: [] }, meta: {} },
    async () => ({ text: 'bad content', stopReason: 'end_turn' }),
  );
  assert.equal(fetch.calls.length, 0);
  assert.equal(mw.stats.moderationCalls, 0);
});

test('safetyClassifier: skips when result has no text', async () => {
  const fetch = mockFetch(() => moderationOk({ violence: 0.99 }));
  const mw = safetyClassifier({ apiKey: 'k', fetch });
  await mw(
    { method: 'chat', request: { messages: [] }, meta: {} },
    async () => ({ embeddings: [[1, 2]] }),   // no text field
  );
  assert.equal(fetch.calls.length, 0);
});

// ---- Anthropic refusal detection --------------------------------------

test('safetyClassifier: detects Anthropic refusal via stopReason', async () => {
  const mw = safetyClassifier();   // no apiKey, only refusal detection
  await assert.rejects(
    mw({ method: 'chat', request: {}, meta: {} },
       async () => ({ text: 'I cannot help with that.', stopReason: 'refusal' })),
    (err) => {
      assert.ok(err instanceof SafetyClassifierBlockedError);
      assert.ok(err instanceof LLMError);
      assert.equal(err.code, 'SAFETY_CLASSIFIER_BLOCKED');
      assert.equal(err.source, 'anthropic-refusal');
      assert.equal(err.httpStatus, 400);
      return true;
    },
  );
  assert.equal(mw.stats.refusals, 1);
  assert.equal(mw.stats.blocked, 1);
  assert.equal(mw.stats.bySource['anthropic-refusal'], 1);
});

test('safetyClassifier: refusal + action=flag passes through', async () => {
  const events = [];
  const mw = safetyClassifier({ action: 'flag', onFlag: (info) => events.push(info) });
  const result = await mw(
    { method: 'chat', request: {}, meta: {} },
    async () => ({ text: 'I cannot help.', stopReason: 'refusal' }),
  );
  assert.equal(result.text, 'I cannot help.');
  assert.equal(mw.stats.flagged, 1);
  assert.equal(mw.stats.blocked, 0);
  assert.equal(events[0].source, 'anthropic-refusal');
  assert.equal(events[0].action, 'flag');
});

// ---- OpenAI moderation trip ------------------------------------------

test('safetyClassifier: high moderation score → blocks', async () => {
  const fetch = mockFetch(() => moderationOk({ violence: 0.85, sexual: 0.02 }));
  const mw = safetyClassifier({ apiKey: 'k', threshold: 0.5, fetch });
  await assert.rejects(
    mw({ method: 'chat', request: {}, meta: {} },
       async () => ({ text: 'BAD OUTPUT', stopReason: 'end_turn' })),
    (err) => {
      assert.equal(err.code, 'SAFETY_CLASSIFIER_BLOCKED');
      assert.equal(err.source, 'openai-moderation');
      assert.ok(err.categories.includes('violence'));
      return true;
    },
  );
  assert.equal(mw.stats.byCategory.violence, 1);
  assert.equal(mw.stats.moderationCalls, 1);
});

test('safetyClassifier: score below threshold passes', async () => {
  const fetch = mockFetch(() => moderationOk({ violence: 0.30, sexual: 0.10 }));
  const mw = safetyClassifier({ apiKey: 'k', threshold: 0.5, fetch });
  const result = await mw(
    { method: 'chat', request: {}, meta: {} },
    async () => ({ text: 'meh', stopReason: 'end_turn' }),
  );
  assert.equal(result.text, 'meh');
  assert.equal(mw.stats.flagged, 0);
});

test('safetyClassifier: custom threshold', async () => {
  const fetch = mockFetch(() => moderationOk({ violence: 0.4 }));
  const mw = safetyClassifier({ apiKey: 'k', threshold: 0.3, fetch });
  await assert.rejects(
    mw({ method: 'chat', request: {}, meta: {} },
       async () => ({ text: 'x', stopReason: 'end_turn' })),
    (err) => err.categories.includes('violence'),
  );
});

test('safetyClassifier: category filter limits check', async () => {
  const fetch = mockFetch(() => moderationOk({ violence: 0.9, sexual: 0.9 }));
  const mw = safetyClassifier({ apiKey: 'k', categories: ['sexual'], fetch });
  await assert.rejects(
    mw({ method: 'chat', request: {}, meta: {} },
       async () => ({ text: 'x', stopReason: 'end_turn' })),
    (err) => {
      assert.deepEqual(err.categories, ['sexual']);   // violence not in filter
      return true;
    },
  );
});

test('safetyClassifier: moderation API error → soft-fail (pass through)', async () => {
  const fetch = mockFetch(() => ({
    ok: false, status: 500,
    async json() { return { error: 'server error' }; },
    async text() { return 'server error'; },
  }));
  const mw = safetyClassifier({ apiKey: 'k', fetch });
  const result = await mw(
    { method: 'chat', request: {}, meta: {} },
    async () => ({ text: 'ok', stopReason: 'end_turn' }),
  );
  assert.equal(result.text, 'ok');       // passes through
  assert.equal(mw.stats.moderationErrors, 1);
  assert.equal(mw.stats.flagged, 0);
});

test('safetyClassifier: moderation network exception → soft-fail', async () => {
  const fetch = async () => { throw new Error('ENOTFOUND'); };
  const mw = safetyClassifier({ apiKey: 'k', fetch });
  const result = await mw(
    { method: 'chat', request: {}, meta: {} },
    async () => ({ text: 'ok', stopReason: 'end_turn' }),
  );
  assert.equal(result.text, 'ok');
  assert.equal(mw.stats.moderationErrors, 1);
});

// ---- checkInput -------------------------------------------------------

test('safetyClassifier: checkInput=true scans messages before provider call', async () => {
  const fetch = mockFetch((url, init) => {
    const body = JSON.parse(init.body);
    // First call scans input; both share same shape.
    if (body.input.includes('BAD INPUT')) return moderationOk({ violence: 0.9 });
    return moderationOk({ violence: 0.01 });
  });
  const mw = safetyClassifier({ apiKey: 'k', checkInput: true, fetch });
  await assert.rejects(
    mw({
      method: 'chat',
      request: { messages: [{ role: 'user', content: 'BAD INPUT' }] },
      meta: {},
    }, async () => ({ text: 'ok', stopReason: 'end_turn' })),
    (err) => err.code === 'SAFETY_CLASSIFIER_BLOCKED',
  );
});

test('safetyClassifier: checkInput+checkOutput both scanned', async () => {
  const fetch = mockFetch(() => moderationOk({ violence: 0.01 }));
  const mw = safetyClassifier({ apiKey: 'k', checkInput: true, fetch });
  await mw({
    method: 'chat',
    request: { messages: [{ role: 'user', content: 'clean' }] },
    meta: {},
  }, async () => ({ text: 'ok reply', stopReason: 'end_turn' }));
  // 1 input scan + 1 output scan
  assert.equal(fetch.calls.length, 2);
});

test('safetyClassifier: checkOutput=false skips output moderation', async () => {
  const fetch = mockFetch(() => moderationOk({ violence: 0.9 }));
  const mw = safetyClassifier({ apiKey: 'k', checkOutput: false, fetch });
  const result = await mw(
    { method: 'chat', request: {}, meta: {} },
    async () => ({ text: 'BAD OUTPUT', stopReason: 'end_turn' }),
  );
  assert.equal(result.text, 'BAD OUTPUT');
  assert.equal(fetch.calls.length, 0);
});

// ---- onFlag callback ------------------------------------------------

test('safetyClassifier: onFlag fires with info', async () => {
  const events = [];
  const fetch = mockFetch(() => moderationOk({ violence: 0.9, sexual: 0.7 }));
  const mw = safetyClassifier({ apiKey: 'k', threshold: 0.5, action: 'flag', fetch,
    onFlag: (info) => events.push(info) });
  await mw(
    { method: 'chat', request: {}, meta: {} },
    async () => ({ text: 'bad', stopReason: 'end_turn' }),
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].source, 'openai-moderation');
  assert.ok(events[0].categories.includes('violence'));
  assert.ok(events[0].categories.includes('sexual'));
  assert.equal(events[0].scores.violence, 0.9);
});

test('safetyClassifier: onFlag error swallowed', async () => {
  const fetch = mockFetch(() => moderationOk({ violence: 0.9 }));
  const mw = safetyClassifier({ apiKey: 'k', action: 'flag', fetch,
    onFlag: () => { throw new Error('broken listener'); } });
  const result = await mw(
    { method: 'chat', request: {}, meta: {} },
    async () => ({ text: 'x', stopReason: 'end_turn' }),
  );
  assert.equal(result.text, 'x');
});

// ---- Streams --------------------------------------------------------

test('safetyClassifier: stream flagged via onComplete (flag-only, never blocks)', async () => {
  const fetch = mockFetch(() => moderationOk({ violence: 0.9 }));
  const events = [];
  const mw = safetyClassifier({ apiKey: 'k', action: 'block', fetch,
    onFlag: (info) => events.push(info) });
  const stream = wrapStreamCompletion(async function* () {
    yield { type: 'done', text: 'bad stream text', stopReason: 'end_turn' };
  }());
  const result = await mw({ method: 'chat', request: {}, meta: {} }, async () => stream);
  for await (const _ of result) { /* drain */ }
  await new Promise((r) => setTimeout(r, 10));
  // Even with action='block', streams get flag treatment.
  assert.equal(events.length, 1);
  assert.equal(events[0].streamMode, true);
  assert.equal(mw.stats.blocked, 0);
  assert.equal(mw.stats.flagged, 1);
});

test('safetyClassifier: stream Anthropic refusal detected via onComplete', async () => {
  const events = [];
  const mw = safetyClassifier({ action: 'block', onFlag: (info) => events.push(info) });
  const stream = wrapStreamCompletion(async function* () {
    yield { type: 'done', text: 'nope', stopReason: 'refusal' };
  }());
  const result = await mw({ method: 'chat', request: {}, meta: {} }, async () => stream);
  for await (const _ of result) { /* drain */ }
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(events.length, 1);
  assert.equal(events[0].source, 'anthropic-refusal');
});

// ---- MCP + reset ------------------------------------------------------

test('safetyClassifier: asMcpResource', () => {
  const mw = safetyClassifier({ apiKey: 'k', threshold: 0.7, action: 'flag' });
  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://safety-classifier');
  const p = r.handler();
  assert.equal(p.threshold, 0.7);
  assert.equal(p.action, 'flag');
  assert.equal(p.hasApiKey, true);
  assert.equal(p.categories, '(all)');
});

test('safetyClassifier: reset clears stats', async () => {
  const mw = safetyClassifier({ action: 'flag' });
  await mw({ method: 'chat', request: {}, meta: {} },
    async () => ({ text: 'x', stopReason: 'refusal' }));
  assert.equal(mw.stats.flagged, 1);
  mw.reset();
  assert.equal(mw.stats.flagged, 0);
  assert.deepEqual(mw.stats.bySource, {});
  assert.deepEqual(mw.stats.byCategory, {});
});

// ---- Error shape ------------------------------------------------------

test('SafetyClassifierBlockedError shape', () => {
  const err = new SafetyClassifierBlockedError({
    reason: 'category exceeded', categories: ['violence'],
    scores: { violence: 0.85 }, source: 'openai-moderation',
  });
  assert.ok(err instanceof LLMError);
  assert.equal(err.code, 'SAFETY_CLASSIFIER_BLOCKED');
  assert.equal(err.primitive, 'safetyClassifier');
  assert.equal(err.httpStatus, 400);
  assert.equal(err.retriable, false);
  assert.deepEqual(err.categories, ['violence']);
  assert.equal(err.source, 'openai-moderation');
  assert.match(err.message, /violence/);
});
