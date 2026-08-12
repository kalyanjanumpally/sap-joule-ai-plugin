const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_pii__';
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
  reversibleTokenization,
  tokenizePII,
  detokenizePII,
  BUILT_IN_PATTERNS,
  defaultExtractText,
  defaultApplyText,
} = require('../lib/middleware/reversibleTokenization');

// ---- Helpers -----------------------------------------------------------

function ctxWith(request) { return { method: 'chat', request }; }

// ---- Built-in patterns detection ------------------------------------

test('tokenizePII: detects EMAIL', () => {
  const r = tokenizePII('Contact alice@example.com for details.');
  assert.ok(r.text.includes('<EMAIL_1>'));
  assert.ok(!r.text.includes('alice@example.com'));
  assert.equal(r.mapping['<EMAIL_1>'].original, 'alice@example.com');
  assert.equal(r.mapping['<EMAIL_1>'].type, 'EMAIL');
});

test('tokenizePII: detects SSN', () => {
  const r = tokenizePII('SSN: 123-45-6789 on file.');
  assert.ok(r.text.includes('<SSN_1>'));
  assert.equal(r.mapping['<SSN_1>'].original, '123-45-6789');
});

test('tokenizePII: detects credit card', () => {
  const r = tokenizePII('Card: 4111 1111 1111 1111');
  assert.ok(r.text.includes('<CREDIT_CARD_1>'));
  assert.equal(r.mapping['<CREDIT_CARD_1>'].type, 'CREDIT_CARD');
});

test('tokenizePII: detects IPv4', () => {
  const r = tokenizePII('Client at 192.168.1.100 disconnected.');
  assert.ok(r.text.includes('<IPV4_1>'));
  assert.equal(r.mapping['<IPV4_1>'].original, '192.168.1.100');
});

test('tokenizePII: detects IBAN', () => {
  const r = tokenizePII('IBAN: DE89370400440532013000');
  assert.ok(r.text.includes('<IBAN_1>'));
});

// ---- Consistent tokens for repeated values -------------------------

test('tokenizePII: same value → same token (deduped)', () => {
  const r = tokenizePII(
    'Email alice@x.com then again alice@x.com and once more alice@x.com.',
  );
  const matches = r.text.match(/<EMAIL_/g);
  assert.equal(matches.length, 3);
  assert.equal(Object.keys(r.mapping).length, 1);   // one mapping entry
  assert.equal(r.text.match(/<EMAIL_1>/g).length, 3);
});

test('tokenizePII: distinct values → distinct tokens', () => {
  const r = tokenizePII('alice@x.com and bob@y.com');
  assert.ok(r.text.includes('<EMAIL_1>'));
  assert.ok(r.text.includes('<EMAIL_2>'));
  assert.equal(r.mapping['<EMAIL_1>'].original, 'alice@x.com');
  assert.equal(r.mapping['<EMAIL_2>'].original, 'bob@y.com');
});

// ---- Custom patterns extension ---------------------------------

test('tokenizePII: user-defined patterns extend built-ins', () => {
  const r = tokenizePII('Employee E123456 has issues.', {
    patterns: { BADGE_ID: /\bE\d{6}\b/g },
  });
  assert.ok(r.text.includes('<BADGE_ID_1>'));
  assert.equal(r.mapping['<BADGE_ID_1>'].type, 'BADGE_ID');
});

// ---- No PII → passthrough --------------------------------------

test('tokenizePII: no matches → unchanged', () => {
  const r = tokenizePII('Just a normal sentence with no personal info.');
  assert.equal(r.text, 'Just a normal sentence with no personal info.');
  assert.equal(Object.keys(r.mapping).length, 0);
});

test('tokenizePII: empty string → empty', () => {
  const r = tokenizePII('');
  assert.equal(r.text, '');
});

// ---- Overlap handling ------------------------------------------

test('tokenizePII: overlapping patterns pick longest', () => {
  // Custom pattern that would overlap CREDIT_CARD
  const r = tokenizePII('Card 4111 1111 1111 1111 today', {
    patterns: { SHORT_NUM: /\d{4}/g },
  });
  // Credit card is longer → should win, no SHORT_NUM tokens.
  assert.ok(r.text.includes('<CREDIT_CARD_1>'));
  assert.equal(r.text.includes('<SHORT_NUM'), false);
});

// ---- Detokenize ------------------------------------------------

test('detokenizePII: restores tokens', () => {
  const { text, mapping } = tokenizePII('Email alice@x.com');
  const restored = detokenizePII(text.replace('.', '. Confirmed for <EMAIL_1>.'), mapping);
  assert.ok(restored.includes('alice@x.com'));
});

test('detokenizePII: unknown token left as-is by default', () => {
  const restored = detokenizePII('Hello <EMAIL_99>', {});
  assert.equal(restored, 'Hello <EMAIL_99>');
});

test('detokenizePII: accepts plain object mapping', () => {
  const restored = detokenizePII('Answer: <EMAIL_1>', {
    '<EMAIL_1>': { original: 'a@b.com', type: 'EMAIL' },
  });
  assert.equal(restored, 'Answer: a@b.com');
});

test('detokenizePII: onUnknownToken replaces unknown tokens', () => {
  const restored = detokenizePII('Hi <EMAIL_99>', {}, {
    onUnknownToken: () => '[REDACTED]',
  });
  assert.equal(restored, 'Hi [REDACTED]');
});

// ---- Middleware validation --------------------------------------

test('reversibleTokenization: throws on non-RegExp pattern', () => {
  assert.throws(() => reversibleTokenization({ patterns: { X: 'not-regex' } }), /RegExp/);
});

test('reversibleTokenization: throws on non-global RegExp', () => {
  assert.throws(() => reversibleTokenization({ patterns: { X: /foo/ } }), /'g' flag/);
});

test('reversibleTokenization: throws on non-string tokenPrefix', () => {
  assert.throws(() => reversibleTokenization({ tokenPrefix: 1 }), /tokenPrefix/);
});

test('reversibleTokenization: throws on non-function extractText', () => {
  assert.throws(() => reversibleTokenization({ extractText: 'x' }), /extractText/);
});

test('reversibleTokenization: throws on non-function callback', () => {
  assert.throws(() => reversibleTokenization({ onTokenize: 1 }), /callbacks/);
});

// ---- Middleware end-to-end -----------------------------------

test('reversibleTokenization: end-to-end round-trip', async () => {
  const mw = reversibleTokenization();
  let seenPrompt;
  const r = await mw(ctxWith({ prompt: 'Write to alice@example.com about their SSN 123-45-6789.' }),
                     async () => ({ text: 'I wrote to <EMAIL_1> about <SSN_1>.' }));
  assert.equal(r.text, 'I wrote to alice@example.com about 123-45-6789.');
  assert.equal(mw.stats.tokensCreated, 2);
  assert.equal(mw.stats.tokensRestored, 2);
});

test('reversibleTokenization: model sees tokenized prompt (not raw)', async () => {
  const mw = reversibleTokenization();
  let seenByModel;
  const ctx = ctxWith({ prompt: 'Send to alice@x.com' });
  await mw(ctx, async () => {
    seenByModel = ctx.request.prompt;
    return { text: 'done' };
  });
  assert.ok(seenByModel.includes('<EMAIL_1>'));
  assert.ok(!seenByModel.includes('alice@x.com'));
});

test('reversibleTokenization: restores ctx.request after call', async () => {
  const mw = reversibleTokenization();
  const ctx = ctxWith({ prompt: 'alice@x.com' });
  const original = ctx.request;
  await mw(ctx, async () => ({ text: 'ok' }));
  assert.equal(ctx.request, original);
});

test('reversibleTokenization: messages[] tokenized + restored', async () => {
  const mw = reversibleTokenization();
  const ctx = ctxWith({
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user',   content: 'My email is alice@x.com.' },
    ],
  });
  let seenMessage;
  const r = await mw(ctx, async () => {
    seenMessage = ctx.request.messages[1].content;
    return { text: 'I see your email is <EMAIL_1>.' };
  });
  assert.ok(seenMessage.includes('<EMAIL_1>'));
  assert.ok(!seenMessage.includes('alice@x.com'));
  assert.equal(r.text, 'I see your email is alice@x.com.');
});

test('reversibleTokenization: system prompt tokenized + restored', async () => {
  const mw = reversibleTokenization();
  const ctx = ctxWith({
    system: 'Assistant with email support@x.com',
    prompt: 'help me',
  });
  let seenSystem;
  await mw(ctx, async () => {
    seenSystem = ctx.request.system;
    return { text: 'contact <EMAIL_1>' };
  });
  assert.ok(seenSystem.includes('<EMAIL_1>'));
});

// ---- Shared mapping across fields --------------------------------

test('reversibleTokenization: same PII in system + user → same token', async () => {
  const mw = reversibleTokenization();
  const ctx = ctxWith({
    system: 'You represent alice@x.com.',
    messages: [{ role: 'user', content: 'Confirm alice@x.com is correct.' }],
  });
  let seenSystem, seenUser;
  await mw(ctx, async () => {
    seenSystem = ctx.request.system;
    seenUser   = ctx.request.messages[0].content;
    return { text: 'ok' };
  });
  const sysToken = seenSystem.match(/<EMAIL_\d+>/)[0];
  const userToken = seenUser.match(/<EMAIL_\d+>/)[0];
  assert.equal(sysToken, userToken);
  assert.equal(mw.stats.tokensCreated, 1);   // dedup across fields
});

// ---- No PII → straight through -----------------------------

test('reversibleTokenization: no PII → passthrough, no tokens created', async () => {
  const mw = reversibleTokenization();
  const r = await mw(ctxWith({ prompt: 'Just a normal question.' }),
                     async () => ({ text: 'Just a normal answer.' }));
  assert.equal(r.text, 'Just a normal answer.');
  assert.equal(mw.stats.tokensCreated, 0);
  assert.equal(mw.stats.tokensRestored, 0);
});

// ---- Streaming skip ------------------------------------------

test('reversibleTokenization: skips streaming by default', async () => {
  const mw = reversibleTokenization();
  let seenPrompt;
  await mw({ method: 'stream', request: { prompt: 'Contact alice@x.com' } },
           async function () {
             seenPrompt = arguments.length > 0 ? arguments[0]?.request?.prompt : null;
             return { text: 'ok' };
           });
  assert.equal(mw.stats.skippedStreaming, 1);
  assert.equal(mw.stats.tokensCreated, 0);
});

// ---- Unknown token from model hallucination ---------------

test('reversibleTokenization: unknown token counted, not restored', async () => {
  const mw = reversibleTokenization();
  const r = await mw(ctxWith({ prompt: 'alice@x.com' }),
                     async () => ({ text: 'Hi <EMAIL_99> and <EMAIL_1>' }));
  assert.equal(mw.stats.unknownTokensSeen, 1);
  assert.equal(mw.stats.tokensRestored, 1);
  assert.ok(r.text.includes('alice@x.com'));
  assert.ok(r.text.includes('<EMAIL_99>'));
});

test('reversibleTokenization: onUnknownToken can replace hallucinated tokens', async () => {
  const mw = reversibleTokenization({
    onUnknownToken: () => '[REDACTED]',
  });
  const r = await mw(ctxWith({ prompt: 'alice@x.com' }),
                     async () => ({ text: '<EMAIL_99>' }));
  assert.equal(r.text, '[REDACTED]');
});

// ---- Callbacks ---------------------------------------------

test('reversibleTokenization: onTokenize fires with counts', async () => {
  const events = [];
  const mw = reversibleTokenization({
    onTokenize: (i) => events.push(i),
  });
  await mw(ctxWith({ prompt: 'Contact alice@x.com or bob@y.com' }),
           async () => ({ text: 'ok' }));
  assert.equal(events.length, 1);
  assert.equal(events[0].tokensCreated, 2);
  assert.equal(events[0].byType.EMAIL, 2);
});

test('reversibleTokenization: onRestore fires when restoration happens', async () => {
  const events = [];
  const mw = reversibleTokenization({
    onRestore: (i) => events.push(i),
  });
  await mw(ctxWith({ prompt: 'alice@x.com' }),
           async () => ({ text: 'confirmed <EMAIL_1>' }));
  assert.equal(events.length, 1);
  assert.equal(events[0].restored, 1);
});

test('reversibleTokenization: callback throws swallowed', async () => {
  const mw = reversibleTokenization({
    onTokenize: () => { throw new Error('x'); },
    onRestore:  () => { throw new Error('x'); },
  });
  const r = await mw(ctxWith({ prompt: 'alice@x.com' }),
                     async () => ({ text: '<EMAIL_1>' }));
  assert.ok(r.text.includes('alice@x.com'));
});

// ---- Stats + MCP -----------------------------------------

test('reversibleTokenization: restorationRate', async () => {
  const mw = reversibleTokenization();
  // Create 2 tokens, restore 1.
  await mw(ctxWith({ prompt: 'alice@x.com and bob@y.com' }),
           async () => ({ text: 'only <EMAIL_1>' }));
  assert.equal(mw.restorationRate(), 0.5);
});

test('reversibleTokenization: reset clears counters', async () => {
  const mw = reversibleTokenization();
  await mw(ctxWith({ prompt: 'alice@x.com' }),
           async () => ({ text: '<EMAIL_1>' }));
  assert.equal(mw.stats.tokensCreated, 1);
  mw.reset();
  assert.equal(mw.stats.tokensCreated, 0);
  assert.equal(mw.stats.byType.EMAIL, undefined);
});

test('reversibleTokenization: asMcpResource', () => {
  const mw = reversibleTokenization({
    patterns: { BADGE: /\bB\d+\b/g },
  });
  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://reversible-tokenization');
  const p = r.handler();
  assert.ok(p.patternTypes.includes('EMAIL'));
  assert.ok(p.patternTypes.includes('BADGE'));
  assert.equal(p.tokenPrefix, '<');
  assert.equal(p.tokenSuffix, '>');
});

test('reversibleTokenization: BUILT_IN_PATTERNS is frozen', () => {
  assert.ok(Object.isFrozen(BUILT_IN_PATTERNS));
  assert.ok(BUILT_IN_PATTERNS.EMAIL instanceof RegExp);
});
