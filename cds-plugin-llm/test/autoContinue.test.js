const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_ac__';
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
  autoContinue,
  DEFAULT_TRIGGERS,
  DEFAULT_CONTINUE_PROMPT,
} = require('../lib/middleware/autoContinue');
const { wrapStreamCompletion } = require('../lib/streamCompletion');

function makeCtx({
  method = 'chat',
  request = { model: 'm', messages: [{ role: 'user', content: 'draft a long letter' }], maxTokens: 100 },
  meta = {},
} = {}) {
  return { method, request, raw: request, meta };
}

// ---- Input validation --------------------------------------------------

test('autoContinue: throws on empty triggers', () => {
  assert.throws(() => autoContinue({ triggers: [] }), /triggers must be a non-empty array/);
});
test('autoContinue: throws on non-positive maxContinuations', () => {
  assert.throws(() => autoContinue({ maxContinuations: 0 }), /maxContinuations must be/);
});
test('autoContinue: throws on empty continuePrompt', () => {
  assert.throws(() => autoContinue({ continuePrompt: '' }), /continuePrompt must be/);
});
test('autoContinue: throws on non-array methods', () => {
  assert.throws(() => autoContinue({ methods: 'chat' }), /methods must be an array/);
});
test('autoContinue: throws on non-function onContinue', () => {
  assert.throws(() => autoContinue({ onContinue: 'x' }), /onContinue must be a function/);
});
test('autoContinue: throws on non-function onGiveUp', () => {
  assert.throws(() => autoContinue({ onGiveUp: 'x' }), /onGiveUp must be a function/);
});

// ---- Defaults ---------------------------------------------------------

test('DEFAULT_TRIGGERS includes max_tokens, length, MAX_TOKENS', () => {
  assert.ok(DEFAULT_TRIGGERS.includes('max_tokens'));
  assert.ok(DEFAULT_TRIGGERS.includes('length'));
  assert.ok(DEFAULT_TRIGGERS.includes('MAX_TOKENS'));
});
test('DEFAULT_CONTINUE_PROMPT is a non-empty string', () => {
  assert.ok(typeof DEFAULT_CONTINUE_PROMPT === 'string');
  assert.match(DEFAULT_CONTINUE_PROMPT, /Continue/);
});

// ---- Pass-through ----------------------------------------------------

test('autoContinue: non-triggered response passes through', async () => {
  const mw = autoContinue();
  let calls = 0;
  const result = await mw(makeCtx(), async () => {
    calls++;
    return { text: 'complete', stopReason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
  });
  assert.equal(calls, 1);
  assert.equal(result.text, 'complete');
  assert.equal(mw.stats.requestsContinued, 0);
});

test('autoContinue: skips non-matching methods (embed)', async () => {
  const mw = autoContinue();
  let calls = 0;
  await mw({ method: 'embed', request: { input: ['x'] }, meta: {} }, async () => {
    calls++;
    return { embeddings: [[1]] };   // no stopReason field anyway
  });
  assert.equal(calls, 1);
});

test('autoContinue: skips structured requests by default (format set)', async () => {
  const mw = autoContinue();
  let calls = 0;
  await mw(makeCtx({ request: { model: 'm', messages: [], format: {}, maxTokens: 100 } }), async () => {
    calls++;
    return { text: '{"partial"', stopReason: 'max_tokens' };
  });
  assert.equal(calls, 1);   // NOT continued
  assert.equal(mw.stats.requestsContinued, 0);
});

test('autoContinue: skipStructured:false continues structured', async () => {
  const mw = autoContinue({ skipStructured: false });
  let calls = 0;
  await mw(makeCtx({ request: { model: 'm', messages: [], format: {}, maxTokens: 100 } }), async () => {
    calls++;
    return calls < 2
      ? { text: '{"partial"', stopReason: 'max_tokens' }
      : { text: ': "done"}', stopReason: 'end_turn' };
  });
  assert.equal(calls, 2);
});

// ---- Continuation flow ------------------------------------------------

test('autoContinue: max_tokens triggers one continuation', async () => {
  const mw = autoContinue();
  let calls = 0;
  const result = await mw(makeCtx(), async () => {
    calls++;
    if (calls === 1) return { text: 'part one ', stopReason: 'max_tokens', usage: { input_tokens: 10, output_tokens: 100 } };
    return { text: 'part two', stopReason: 'end_turn', usage: { input_tokens: 12, output_tokens: 40 } };
  });
  assert.equal(calls, 2);
  assert.equal(result.text, 'part one part two');
  assert.equal(result.stopReason, 'end_turn');
  // Usage summed:
  assert.equal(result.usage.input_tokens, 22);
  assert.equal(result.usage.output_tokens, 140);
  assert.equal(mw.stats.requestsContinued, 1);
  assert.equal(mw.stats.totalContinuations, 1);
});

test('autoContinue: OpenAI-style "length" triggers continuation', async () => {
  const mw = autoContinue();
  let calls = 0;
  const result = await mw(makeCtx(), async () => {
    calls++;
    return calls === 1
      ? { text: 'A ', stopReason: 'length' }
      : { text: 'B', stopReason: 'stop' };
  });
  assert.equal(calls, 2);
  assert.equal(result.text, 'A B');
});

test('autoContinue: Gemini-style "MAX_TOKENS" triggers continuation', async () => {
  const mw = autoContinue();
  let calls = 0;
  await mw(makeCtx(), async () => {
    calls++;
    return calls === 1
      ? { text: 'a', stopReason: 'MAX_TOKENS' }
      : { text: 'b', stopReason: 'STOP' };
  });
  assert.equal(calls, 2);
});

test('autoContinue: continues up to maxContinuations then gives up', async () => {
  const mw = autoContinue({ maxContinuations: 2 });
  let calls = 0;
  const result = await mw(makeCtx(), async () => {
    calls++;
    return { text: `[${calls}]`, stopReason: 'max_tokens' };
  });
  // Initial + 2 continuations = 3 total
  assert.equal(calls, 3);
  assert.equal(result.text, '[1][2][3]');
  assert.equal(result.stopReason, 'max_tokens');       // still truncated
  assert.equal(mw.stats.totalContinuations, 2);
  assert.equal(mw.stats.giveUps, 1);
});

test('autoContinue: onContinue callback fires with info', async () => {
  const events = [];
  const mw = autoContinue({ onContinue: (info) => events.push(info) });
  let calls = 0;
  await mw(makeCtx(), async () => {
    calls++;
    return calls === 1
      ? { text: 'first ', stopReason: 'max_tokens' }
      : { text: 'second', stopReason: 'end_turn' };
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].attempt, 1);
  assert.equal(events[0].triggeredBy, 'max_tokens');
  assert.equal(events[0].addedChars, 6);       // 'second'.length
  assert.equal(events[0].totalChars, 12);       // 'first ' + 'second'
});

test('autoContinue: onGiveUp fires when cap exhausted', async () => {
  const gaveUp = [];
  const mw = autoContinue({ maxContinuations: 1, onGiveUp: (info) => gaveUp.push(info) });
  await mw(makeCtx(), async () => ({ text: '.', stopReason: 'max_tokens' }));
  assert.equal(gaveUp.length, 1);
  assert.equal(gaveUp[0].finalStopReason, 'max_tokens');
  assert.equal(gaveUp[0].attempts, 1);
});

test('autoContinue: onContinue error swallowed', async () => {
  const mw = autoContinue({ onContinue: () => { throw new Error('boom'); } });
  let calls = 0;
  const result = await mw(makeCtx(), async () => {
    calls++;
    return calls === 1
      ? { text: 'a', stopReason: 'max_tokens' }
      : { text: 'b', stopReason: 'end_turn' };
  });
  assert.equal(result.text, 'ab');
});

// ---- Message rewriting -------------------------------------------------

test('autoContinue: adds assistant + continue user message on continuation', async () => {
  const mw = autoContinue();
  let seenMessagesCounts = [];
  let calls = 0;
  const ctx = makeCtx({ request: { model: 'm', messages: [{ role: 'user', content: 'go' }], maxTokens: 100 } });
  await mw(ctx, async () => {
    calls++;
    seenMessagesCounts.push(ctx.request.messages.length);
    return calls === 1
      ? { text: 'started', stopReason: 'max_tokens' }
      : { text: 'finished', stopReason: 'end_turn' };
  });
  assert.deepEqual(seenMessagesCounts, [1, 3]);
});

test('autoContinue: uses custom continuePrompt on retry', async () => {
  const mw = autoContinue({ continuePrompt: 'RESUME NOW.' });
  let seenLastMessage;
  let calls = 0;
  const ctx = makeCtx();
  await mw(ctx, async () => {
    calls++;
    seenLastMessage = ctx.request.messages[ctx.request.messages.length - 1];
    return calls === 1
      ? { text: 'a', stopReason: 'max_tokens' }
      : { text: 'b', stopReason: 'end_turn' };
  });
  assert.equal(seenLastMessage.content, 'RESUME NOW.');
});

// ---- ctx.request restoration -------------------------------------------

test('autoContinue: restores ctx.request after continuation', async () => {
  const mw = autoContinue();
  const original = { model: 'm', messages: [{ role: 'user', content: 'go' }], maxTokens: 100 };
  const ctx = { method: 'chat', request: original, raw: original, meta: {} };
  let calls = 0;
  await mw(ctx, async () => {
    calls++;
    return calls === 1
      ? { text: 'a', stopReason: 'max_tokens' }
      : { text: 'b', stopReason: 'end_turn' };
  });
  assert.equal(ctx.request, original);
  assert.equal(ctx.request.messages.length, 1);
});

test('autoContinue: restores ctx.request on continuation error', async () => {
  const mw = autoContinue();
  const original = { model: 'm', messages: [{ role: 'user', content: 'go' }], maxTokens: 100 };
  const ctx = { method: 'chat', request: original, raw: original, meta: {} };
  let calls = 0;
  await assert.rejects(mw(ctx, async () => {
    calls++;
    if (calls === 1) return { text: 'a', stopReason: 'max_tokens' };
    throw new Error('boom');
  }), /boom/);
  assert.equal(ctx.request, original);
});

// ---- Streams ---------------------------------------------------------

test('autoContinue: skips streams by default (streams pass through untouched)', async () => {
  const mw = autoContinue();
  const stream = wrapStreamCompletion(async function* () {
    yield { type: 'done', text: 'a', stopReason: 'max_tokens' };
  }());
  let calls = 0;
  const result = await mw(makeCtx(), async () => { calls++; return stream; });
  assert.equal(calls, 1);
  assert.equal(result, stream);   // unmodified
});

// ---- Custom triggers -------------------------------------------------

test('autoContinue: custom triggers list', async () => {
  const mw = autoContinue({ triggers: ['custom-cutoff'] });
  let calls = 0;
  const result = await mw(makeCtx(), async () => {
    calls++;
    return calls === 1
      ? { text: 'a', stopReason: 'custom-cutoff' }
      : { text: 'b', stopReason: 'end_turn' };
  });
  assert.equal(calls, 2);
  assert.equal(result.text, 'ab');
});

test('autoContinue: standard triggers ignored when custom triggers override', async () => {
  const mw = autoContinue({ triggers: ['other'] });
  let calls = 0;
  await mw(makeCtx(), async () => {
    calls++;
    return { text: 'a', stopReason: 'max_tokens' };
  });
  assert.equal(calls, 1);   // max_tokens no longer a trigger
});

// ---- MCP + reset ------------------------------------------------------

test('autoContinue: asMcpResource', () => {
  const mw = autoContinue();
  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://auto-continue');
  const payload = r.handler();
  assert.equal(payload.maxContinuations, 3);
  assert.ok(payload.triggers.includes('max_tokens'));
  assert.deepEqual(payload.methods, ['chat']);
});

test('autoContinue: reset clears counters', async () => {
  const mw = autoContinue();
  let calls = 0;
  await mw(makeCtx(), async () => {
    calls++;
    return calls === 1
      ? { text: 'a', stopReason: 'max_tokens' }
      : { text: 'b', stopReason: 'end_turn' };
  });
  assert.equal(mw.stats.requestsContinued, 1);
  mw.reset();
  assert.equal(mw.stats.requestsContinued, 0);
  assert.deepEqual(mw.stats.byStopReason, {});
});

// ---- Missing fields fall-through --------------------------------------

test('autoContinue: response with no stopReason passes through', async () => {
  const mw = autoContinue();
  const result = await mw(makeCtx(), async () => ({ text: 'ok' }));
  assert.equal(result.text, 'ok');
  assert.equal(mw.stats.requestsContinued, 0);
});

test('autoContinue: piece without text handled', async () => {
  const mw = autoContinue();
  let calls = 0;
  const result = await mw(makeCtx(), async () => {
    calls++;
    return calls === 1
      ? { text: 'a', stopReason: 'max_tokens' }
      : { stopReason: 'end_turn' };   // no text
  });
  assert.equal(result.text, 'a');
  assert.equal(result.stopReason, 'end_turn');
});
