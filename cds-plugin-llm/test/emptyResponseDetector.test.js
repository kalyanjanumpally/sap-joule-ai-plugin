const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_erd__';
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
  emptyResponseDetector,
  EmptyResponseError,
  DEFAULT_REFUSAL_PATTERNS,
  ON_EMPTY_POLICIES,
  extractResponseText,
  defaultBuildRetryPrompt,
} = require('../lib/middleware/emptyResponseDetector');

function ctxWith(messages = [{ role: 'user', content: 'q' }]) {
  return { request: { messages } };
}

// ---- Frozen exports ------------------------

test('ON_EMPTY_POLICIES + DEFAULT_REFUSAL_PATTERNS are frozen', () => {
  assert.ok(Object.isFrozen(ON_EMPTY_POLICIES));
  assert.deepEqual([...ON_EMPTY_POLICIES], ['throw', 'retry', 'log']);
  assert.ok(Object.isFrozen(DEFAULT_REFUSAL_PATTERNS));
});

// ---- Helpers -----------------------------

test('extractResponseText: string result', () => {
  assert.equal(extractResponseText('hello'), 'hello');
});
test('extractResponseText: {text} result', () => {
  assert.equal(extractResponseText({ text: 'hi' }), 'hi');
});
test('extractResponseText: null → empty string', () => {
  assert.equal(extractResponseText(null), '');
});

test('defaultBuildRetryPrompt: refusal reason mentions policy', () => {
  const p = defaultBuildRetryPrompt({ previousText: '...', reason: 'refusal-pattern', retryIndex: 0 });
  assert.ok(p.toLowerCase().includes('refusal'));
});
test('defaultBuildRetryPrompt: too-short reason mentions empty/short', () => {
  const p = defaultBuildRetryPrompt({ previousText: '', reason: 'too-short', retryIndex: 0 });
  assert.ok(p.toLowerCase().includes('empty') || p.toLowerCase().includes('short'));
});

// ---- Validation --------------------------

test('emptyResponseDetector: throws on unknown onEmpty', () => {
  assert.throws(() => emptyResponseDetector({ onEmpty: 'bogus' }), /onEmpty/);
});
test('emptyResponseDetector: throws on negative minChars', () => {
  assert.throws(() => emptyResponseDetector({ minChars: -1 }), /minChars/);
});
test('emptyResponseDetector: throws on non-array refusalPatterns', () => {
  assert.throws(() => emptyResponseDetector({ refusalPatterns: 'x' }), /refusalPatterns/);
});
test('emptyResponseDetector: throws on non-RegExp pattern', () => {
  assert.throws(() => emptyResponseDetector({ refusalPatterns: ['not-a-regex'] }), /must be a RegExp/);
});
test('emptyResponseDetector: throws on non-function detectEmpty', () => {
  assert.throws(() => emptyResponseDetector({ detectEmpty: 'x' }), /detectEmpty/);
});
test('emptyResponseDetector: throws on negative maxRetries', () => {
  assert.throws(() => emptyResponseDetector({ maxRetries: -1 }), /maxRetries/);
});
test('emptyResponseDetector: throws on non-function callback', () => {
  assert.throws(() => emptyResponseDetector({ onDetected: 'x' }), /callbacks/);
});

// ---- Non-empty passthrough ---------

test('emptyResponseDetector: substantive response passes through', async () => {
  const mw = emptyResponseDetector();
  const r = await mw(ctxWith(), async () => ({ text: 'A substantive answer to the question.' }));
  assert.equal(r.text, 'A substantive answer to the question.');
  assert.equal(mw.stats.emptyDetected, 0);
});

// ---- Detection: too-short ------------

test('emptyResponseDetector: throws on too-short response by default', async () => {
  const mw = emptyResponseDetector({ minChars: 10 });
  await assert.rejects(mw(ctxWith(), async () => ({ text: 'ok' })), EmptyResponseError);
  assert.equal(mw.stats.byReason['too-short'], 1);
});

test('emptyResponseDetector: EmptyResponseError carries reason + textLength', async () => {
  const mw = emptyResponseDetector({ minChars: 10 });
  try {
    await mw(ctxWith(), async () => ({ text: 'ok' }));
    assert.fail('should throw');
  } catch (err) {
    assert.equal(err.code, 'EMPTY_RESPONSE');
    assert.equal(err.reason, 'too-short');
    assert.equal(err.textLength, 2);
    assert.equal(err.retries, 0);
  }
});

// ---- Detection: whitespace ------------

test('emptyResponseDetector: whitespace-only response detected', async () => {
  const mw = emptyResponseDetector({ minChars: 1 });
  await assert.rejects(mw(ctxWith(), async () => ({ text: '   \n   ' })), EmptyResponseError);
  assert.equal(mw.stats.byReason.whitespace, 1);
});

test('emptyResponseDetector: empty string detected', async () => {
  const mw = emptyResponseDetector();
  await assert.rejects(mw(ctxWith(), async () => ({ text: '' })), EmptyResponseError);
});

test('emptyResponseDetector: null text detected as whitespace', async () => {
  const mw = emptyResponseDetector();
  await assert.rejects(mw(ctxWith(), async () => ({})), EmptyResponseError);
});

// ---- Detection: refusal patterns -----

test("emptyResponseDetector: I can't-style refusal detected", async () => {
  const mw = emptyResponseDetector();
  await assert.rejects(mw(ctxWith(), async () => ({ text: "I can't help with that request." })), EmptyResponseError);
  assert.equal(mw.stats.byReason['refusal-pattern'], 1);
});

test('emptyResponseDetector: I cannot detected', async () => {
  const mw = emptyResponseDetector();
  await assert.rejects(mw(ctxWith(), async () => ({ text: 'I cannot assist with that.' })), EmptyResponseError);
});

test('emptyResponseDetector: Sorry, but detected', async () => {
  const mw = emptyResponseDetector();
  await assert.rejects(mw(ctxWith(), async () => ({ text: "Sorry, but I can't do that." })), EmptyResponseError);
});

test('emptyResponseDetector: As an AI... refusal detected', async () => {
  const mw = emptyResponseDetector();
  await assert.rejects(mw(ctxWith(), async () => ({ text: "As an AI assistant, I can't help with that." })), EmptyResponseError);
});

test('emptyResponseDetector: refusal mid-response NOT detected (anchored to start)', async () => {
  const mw = emptyResponseDetector();
  // Legitimate answer that contains "I can't" but not at the start.
  const r = await mw(ctxWith(), async () => ({ text: "Here is what I found. The system says I can't verify beyond that." }));
  assert.ok(r.text);   // passed through
});

// ---- Custom detectEmpty ---------

test('emptyResponseDetector: custom detectEmpty overrides defaults', async () => {
  const mw = emptyResponseDetector({
    detectEmpty: (result) => result?.text === 'CUSTOM_EMPTY',
  });
  await assert.rejects(mw(ctxWith(), async () => ({ text: 'CUSTOM_EMPTY' })), EmptyResponseError);
});

test('emptyResponseDetector: custom detectEmpty returning object with reason', async () => {
  const mw = emptyResponseDetector({
    detectEmpty: () => ({ empty: true, reason: 'no-signal' }),
    onEmpty: 'log',
  });
  await mw(ctxWith(), async () => ({ text: 'some substantive text here that passes' }));
  assert.equal(mw.stats.byReason['no-signal'], 1);
});

test('emptyResponseDetector: custom detectEmpty returning null falls back to default', async () => {
  const mw = emptyResponseDetector({
    detectEmpty: () => null,
  });
  await assert.rejects(mw(ctxWith(), async () => ({ text: '' })), EmptyResponseError);
});

test('emptyResponseDetector: detectEmpty throws → captured, falls back', async () => {
  const errors = [];
  const mw = emptyResponseDetector({
    detectEmpty: () => { throw new Error('bug'); },
    onError: (i) => errors.push(i),
  });
  await assert.rejects(mw(ctxWith(), async () => ({ text: '' })), EmptyResponseError);
  assert.equal(errors[0].phase, 'detectEmpty');
});

// ---- onEmpty: log -----------

test('emptyResponseDetector: log mode passes empty through', async () => {
  const events = [];
  const mw = emptyResponseDetector({
    onEmpty: 'log',
    onDetected: (i) => events.push(i),
  });
  const r = await mw(ctxWith(), async () => ({ text: '' }));
  assert.deepEqual(r, { text: '' });   // passed through untouched
  assert.equal(events.length, 1);
  assert.equal(mw.stats.loggedCount, 1);
});

// ---- onEmpty: retry ------------

test('emptyResponseDetector: retry mode retries once and succeeds', async () => {
  const mw = emptyResponseDetector({
    onEmpty: 'retry', maxRetries: 1,
  });
  let call = 0;
  const r = await mw(ctxWith(), async () => {
    call++;
    return { text: call === 1 ? '' : 'now here is a proper response' };
  });
  assert.ok(r.text.startsWith('now here'));
  assert.equal(mw.stats.retried, 1);
  assert.equal(mw.stats.retrySucceeded, 1);
});

test('emptyResponseDetector: retry mode exhausts retries → throws', async () => {
  const mw = emptyResponseDetector({
    onEmpty: 'retry', maxRetries: 2,
  });
  await assert.rejects(mw(ctxWith(), async () => ({ text: '' })), EmptyResponseError);
  assert.equal(mw.stats.retried, 2);
  assert.equal(mw.stats.retrySucceeded, 0);
});

test('emptyResponseDetector: retry appends assistant + user messages when text non-empty', async () => {
  const mw = emptyResponseDetector({ onEmpty: 'retry', maxRetries: 1, minChars: 100 });
  let seenMessages;
  let call = 0;
  const ctx = ctxWith();
  await mw(ctx, async () => {
    call++;
    if (call === 2) seenMessages = ctx.request.messages;
    // First response is too-short (fails minChars 100 but has real text
    // so applyRetry appends the assistant message).
    return { text: call === 1 ? 'short' : 'x'.repeat(200) };
  });
  // On the 2nd call: user (orig) + assistant ('short') + user (retry).
  assert.equal(seenMessages.length, 3);
  assert.equal(seenMessages[1].role, 'assistant');
  assert.equal(seenMessages[1].content, 'short');
  assert.equal(seenMessages[2].role, 'user');
});

test('emptyResponseDetector: retry appends only user turn when previous text is empty', async () => {
  const mw = emptyResponseDetector({ onEmpty: 'retry', maxRetries: 1 });
  let seenMessages;
  let call = 0;
  const ctx = ctxWith();
  await mw(ctx, async () => {
    call++;
    if (call === 2) seenMessages = ctx.request.messages;
    return { text: call === 1 ? '' : 'substantive answer here' };
  });
  // No echo of empty assistant → user (orig) + user (retry).
  assert.equal(seenMessages.length, 2);
  assert.equal(seenMessages[1].role, 'user');
});

test('emptyResponseDetector: original request restored after retry', async () => {
  const mw = emptyResponseDetector({ onEmpty: 'retry', maxRetries: 1 });
  const ctx = ctxWith();
  const original = ctx.request;
  let call = 0;
  await mw(ctx, async () => {
    call++;
    return { text: call === 1 ? '' : 'proper response' };
  });
  assert.equal(ctx.request, original);
});

// ---- Callbacks ---------

test('emptyResponseDetector: onDetected fires with reason + retries', async () => {
  const events = [];
  const mw = emptyResponseDetector({
    onEmpty: 'log', onDetected: (i) => events.push(i),
  });
  await mw(ctxWith(), async () => ({ text: '' }));
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, 'whitespace');
  assert.equal(events[0].retries, 0);
});

test('emptyResponseDetector: onRetry fires per retry attempt', async () => {
  const events = [];
  const mw = emptyResponseDetector({
    onEmpty: 'retry', maxRetries: 2,
    onRetry: (i) => events.push(i.retryIndex),
  });
  await assert.rejects(mw(ctxWith(), async () => ({ text: '' })), EmptyResponseError);
  assert.deepEqual(events, [0, 1]);
});

test('emptyResponseDetector: onFinalize fires on both success + failure', async () => {
  const events = [];
  const mw = emptyResponseDetector({
    onFinalize: (i) => events.push(i),
  });
  await mw(ctxWith(), async () => ({ text: 'substantive answer that passes' }));
  assert.equal(events.length, 1);
  assert.equal(events[0].empty, false);
});

test('emptyResponseDetector: callback throws swallowed', async () => {
  const mw = emptyResponseDetector({
    onEmpty: 'log',
    onDetected: () => { throw new Error('x'); },
    onFinalize: () => { throw new Error('x'); },
  });
  const r = await mw(ctxWith(), async () => ({ text: '' }));
  assert.deepEqual(r, { text: '' });
});

// ---- Downstream errors propagate --------

test('emptyResponseDetector: downstream throw propagates untouched', async () => {
  const mw = emptyResponseDetector({ onEmpty: 'retry', maxRetries: 3 });
  await assert.rejects(mw(ctxWith(), async () => { throw new Error('down'); }), /down/);
});

// ---- Stats + MCP + reset ----------

test('emptyResponseDetector: emptyRate', async () => {
  const mw = emptyResponseDetector({ onEmpty: 'log' });
  await mw(ctxWith(), async () => ({ text: 'substantive answer here' }));
  await mw(ctxWith(), async () => ({ text: '' }));
  assert.equal(mw.emptyRate(), 0.5);
});

test('emptyResponseDetector: reset clears counters', async () => {
  const mw = emptyResponseDetector({ onEmpty: 'log' });
  await mw(ctxWith(), async () => ({ text: '' }));
  mw.reset();
  assert.equal(mw.stats.totalCalls, 0);
  assert.equal(mw.stats.byReason.whitespace, 0);
});

test('emptyResponseDetector: asMcpResource', () => {
  const mw = emptyResponseDetector({
    minChars: 20, onEmpty: 'retry', maxRetries: 3,
  });
  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://empty-response-detector');
  const p = r.handler();
  assert.equal(p.minChars, 20);
  assert.equal(p.onEmpty, 'retry');
  assert.equal(p.maxRetries, 3);
  assert.ok(p.refusalPatternCount > 0);
});
