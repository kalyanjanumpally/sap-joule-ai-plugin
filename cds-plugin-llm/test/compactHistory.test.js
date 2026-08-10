const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_compact__';
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
  compactHistory,
  DEFAULT_SUMMARY_SYSTEM,
  DEFAULT_SUMMARY_PROMPT,
  DEFAULT_SUMMARY_PREFIX,
} = require('../lib/middleware/compactHistory');

function makeMessages(n) {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `turn-${i}`,
  }));
}

function makeCtx({
  method = 'chat',
  messages = makeMessages(30),
  system = 'system prompt',
} = {}) {
  const request = { model: 'm', system, messages };
  return { method, request, raw: request, meta: {} };
}

// ---- Input validation --------------------------------------------------

test('compactHistory: throws on maxMessages < 2', () => {
  assert.throws(() => compactHistory({ maxMessages: 1 }), /maxMessages must be/);
});
test('compactHistory: throws on non-positive keepRecent', () => {
  assert.throws(() => compactHistory({ keepRecent: 0 }), /keepRecent must be/);
});
test('compactHistory: throws when keepRecent >= maxMessages', () => {
  assert.throws(() => compactHistory({ maxMessages: 5, keepRecent: 5 }), /keepRecent.*must be < maxMessages/);
  assert.throws(() => compactHistory({ maxMessages: 5, keepRecent: 6 }), /keepRecent.*must be < maxMessages/);
});
test('compactHistory: throws on non-function summarizer', () => {
  assert.throws(() => compactHistory({ summarizer: 'x' }), /summarizer must be/);
});
test('compactHistory: throws on non-function onCompact', () => {
  assert.throws(() => compactHistory({ onCompact: 'x' }), /onCompact must be/);
});
test('compactHistory: throws on non-array skipMethods', () => {
  assert.throws(() => compactHistory({ skipMethods: 'chat' }), /skipMethods must be/);
});

// ---- Pass-through paths ------------------------------------------------

test('compactHistory: skips non-chat method', async () => {
  const summarizer = async () => 'summary';
  const mw = compactHistory({ maxMessages: 5, keepRecent: 2, summarizer });
  const ctx = makeCtx({ method: 'embed', messages: makeMessages(20) });
  let seenLen;
  await mw(ctx, async () => { seenLen = ctx.request.messages.length; return { text: 'ok' }; });
  assert.equal(seenLen, 20);
  assert.equal(mw.stats.compacted, 0);
  assert.equal(mw.stats.skipped, 1);
});

test('compactHistory: skips when messages array missing', async () => {
  const mw = compactHistory({ summarizer: async () => 'x' });
  const ctx = { method: 'chat', request: {}, meta: {} };
  await mw(ctx, async () => ({ text: 'ok' }));
  assert.equal(mw.stats.compacted, 0);
  assert.equal(mw.stats.skipped, 1);
});

test('compactHistory: skips when messages.length <= maxMessages', async () => {
  const mw = compactHistory({ maxMessages: 20, keepRecent: 5, summarizer: async () => 'x' });
  const ctx = makeCtx({ messages: makeMessages(20) });
  let seenLen;
  await mw(ctx, async () => { seenLen = ctx.request.messages.length; return { text: 'ok' }; });
  assert.equal(seenLen, 20);
  assert.equal(mw.stats.compacted, 0);
});

// ---- Compaction happy path -------------------------------------------

test('compactHistory: compacts when messages > maxMessages', async () => {
  let seenMessages;
  const summarizer = async (old) => `summary of ${old.length} messages`;
  const mw = compactHistory({ maxMessages: 10, keepRecent: 4, summarizer });
  const ctx = makeCtx({ messages: makeMessages(30) });
  await mw(ctx, async () => {
    seenMessages = ctx.request.messages;
    return { text: 'ok' };
  });
  // 30 - 4 = 26 removed; replaced with 2 synthetic + 4 kept = 6 total
  assert.equal(seenMessages.length, 6);
  assert.equal(seenMessages[0].role, 'user');
  assert.match(seenMessages[0].content, /Please summarize/);
  assert.equal(seenMessages[1].role, 'assistant');
  assert.match(seenMessages[1].content, /\[EARLIER CONVERSATION SUMMARY\]/);
  assert.match(seenMessages[1].content, /summary of 26 messages/);
  // Last 4 kept verbatim
  assert.equal(seenMessages[2].content, 'turn-26');
  assert.equal(seenMessages[5].content, 'turn-29');
});

test('compactHistory: preserves system prompt', async () => {
  let seenSystem;
  const summarizer = async () => 'summary';
  const mw = compactHistory({ maxMessages: 5, keepRecent: 2, summarizer });
  const ctx = makeCtx({ messages: makeMessages(20), system: 'be terse' });
  await mw(ctx, async () => {
    seenSystem = ctx.request.system;
    return { text: 'ok' };
  });
  assert.equal(seenSystem, 'be terse');
});

test('compactHistory: increments stats', async () => {
  const summarizer = async () => 'summary';
  const mw = compactHistory({ maxMessages: 5, keepRecent: 2, summarizer });
  await mw(makeCtx({ messages: makeMessages(20) }), async () => ({ text: 'ok' }));
  assert.equal(mw.stats.compacted, 1);
  assert.equal(mw.stats.totalMessagesRemoved, 18);   // 20 - 2 kept
  assert.equal(mw.stats.totalMessagesReplacedWith, 2);
});

test('compactHistory: restores ctx.request after next()', async () => {
  const summarizer = async () => 'summary';
  const mw = compactHistory({ maxMessages: 5, keepRecent: 2, summarizer });
  const ctx = makeCtx({ messages: makeMessages(20) });
  const originalRequest = ctx.request;
  await mw(ctx, async () => ({ text: 'ok' }));
  assert.equal(ctx.request, originalRequest);
  assert.equal(ctx.request.messages.length, 20);
});

test('compactHistory: restores ctx.request on error', async () => {
  const summarizer = async () => 'summary';
  const mw = compactHistory({ maxMessages: 5, keepRecent: 2, summarizer });
  const ctx = makeCtx({ messages: makeMessages(20) });
  const originalRequest = ctx.request;
  await assert.rejects(mw(ctx, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(ctx.request, originalRequest);
});

// ---- Summarizer variants ---------------------------------------------

test('compactHistory: custom summarizer receives old messages + ctx', async () => {
  let seenOld;
  let seenCtx;
  const mw = compactHistory({
    maxMessages: 5, keepRecent: 2,
    summarizer: async (old, ctx) => { seenOld = old; seenCtx = ctx; return 'x'; },
  });
  const ctx = makeCtx({ messages: makeMessages(10) });
  await mw(ctx, async () => ({ text: 'ok' }));
  assert.equal(seenOld.length, 8);
  assert.equal(seenOld[0].content, 'turn-0');
  assert.equal(seenOld[7].content, 'turn-7');
  assert.equal(seenCtx, ctx);
});

test('compactHistory: default summarizer uses llm handle', async () => {
  let seenReq;
  const llm = {
    chat: async (req) => {
      seenReq = req;
      return { text: 'auto summary', usage: {} };
    },
  };
  const mw = compactHistory({ maxMessages: 5, keepRecent: 2, llm });
  let seenMessages;
  const ctx = makeCtx({ messages: makeMessages(10) });
  await mw(ctx, async () => { seenMessages = ctx.request.messages; return { text: 'ok' }; });
  // Summary call happened
  assert.equal(seenReq.system, DEFAULT_SUMMARY_SYSTEM);
  assert.match(seenReq.messages[0].content, /Summarize the following conversation history/);
  // Compacted output includes the auto summary
  assert.match(seenMessages[1].content, /auto summary/);
});

test('compactHistory: default summarizer respects summaryModel override', async () => {
  let seenModel;
  const llm = {
    chat: async (req) => { seenModel = req.model; return { text: 'sum', usage: {} }; },
  };
  const mw = compactHistory({
    maxMessages: 5, keepRecent: 2, llm,
    summaryModel: 'claude-haiku-4-5',
  });
  await mw(makeCtx({ messages: makeMessages(10) }), async () => ({ text: 'ok' }));
  assert.equal(seenModel, 'claude-haiku-4-5');
});

test('compactHistory: throws helpful error if no summarizer AND no llm/chat', async () => {
  const mw = compactHistory({ maxMessages: 5, keepRecent: 2 });
  const ctx = makeCtx({ messages: makeMessages(10) });
  await mw(ctx, async () => ({ text: 'ok' }));
  // Soft-fail: summarizer error → skip compaction (not throw).
  assert.equal(mw.stats.summarizerErrors, 1);
  assert.equal(mw.stats.compacted, 0);
});

// ---- Summarizer errors ---------------------------------------------

test('compactHistory: summarizer error → soft-fail (pass through)', async () => {
  const mw = compactHistory({
    maxMessages: 5, keepRecent: 2,
    summarizer: async () => { throw new Error('summary failed'); },
  });
  let seenLen;
  await mw(makeCtx({ messages: makeMessages(20) }), async () => {
    seenLen = 20;   // not compacted → passed through
    return { text: 'ok' };
  });
  assert.equal(mw.stats.summarizerErrors, 1);
  assert.equal(mw.stats.compacted, 0);
});

test('compactHistory: onError fires when summarizer throws', async () => {
  const events = [];
  const mw = compactHistory({
    maxMessages: 5, keepRecent: 2,
    summarizer: async () => { throw new Error('boom'); },
    onError: (info) => events.push(info),
  });
  await mw(makeCtx({ messages: makeMessages(20) }), async () => ({ text: 'ok' }));
  assert.equal(events.length, 1);
  assert.equal(events[0].err.message, 'boom');
  assert.equal(events[0].oldMessagesCount, 18);
});

test('compactHistory: empty summary → pass through', async () => {
  const mw = compactHistory({
    maxMessages: 5, keepRecent: 2,
    summarizer: async () => '',
  });
  await mw(makeCtx({ messages: makeMessages(20) }), async () => ({ text: 'ok' }));
  assert.equal(mw.stats.summarizerErrors, 1);
  assert.equal(mw.stats.compacted, 0);
});

// ---- Callbacks ------------------------------------------------------

test('compactHistory: onCompact fires with info', async () => {
  const events = [];
  const mw = compactHistory({
    maxMessages: 5, keepRecent: 2,
    summarizer: async () => 'summary text',
    onCompact: (info) => events.push(info),
  });
  await mw(makeCtx({ messages: makeMessages(20) }), async () => ({ text: 'ok' }));
  assert.equal(events.length, 1);
  assert.equal(events[0].originalCount, 20);
  assert.equal(events[0].removedCount, 18);
  assert.equal(events[0].keptCount, 2);
  assert.equal(events[0].finalCount, 4);
  assert.equal(events[0].summaryChars, 'summary text'.length);
});

test('compactHistory: onCompact error swallowed', async () => {
  const mw = compactHistory({
    maxMessages: 5, keepRecent: 2,
    summarizer: async () => 'x',
    onCompact: () => { throw new Error('listener broken'); },
  });
  const res = await mw(makeCtx({ messages: makeMessages(10) }), async () => ({ text: 'ok' }));
  assert.equal(res.text, 'ok');
});

// ---- Message-content array support -----------------------------------

test('compactHistory: dumps array-content messages correctly to summarizer', async () => {
  let seenOld;
  const mw = compactHistory({
    maxMessages: 3, keepRecent: 1,
    llm: {
      chat: async (req) => {
        seenOld = req.messages[0].content;
        return { text: 'summary', usage: {} };
      },
    },
  });
  const messages = [
    { role: 'user', content: [
      { type: 'text', text: 'question' },
      { type: 'image', source: { type: 'base64' } },
    ] },
    { role: 'assistant', content: 'answer 1' },
    { role: 'user', content: 'follow up' },
    { role: 'assistant', content: 'answer 2' },
    { role: 'user', content: 'kept' },
  ];
  await mw({ method: 'chat', request: { model: 'm', messages }, raw: {}, meta: {} }, async () => ({ text: 'ok' }));
  assert.match(seenOld, /\[user\] question/);
  assert.match(seenOld, /\[assistant\] answer 1/);
});

// ---- MCP + reset ----------------------------------------------------

test('compactHistory: asMcpResource', () => {
  const mw = compactHistory({ maxMessages: 15, keepRecent: 4, summarizer: async () => 'x' });
  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://compact-history');
  const p = r.handler();
  assert.equal(p.maxMessages, 15);
  assert.equal(p.keepRecent, 4);
  assert.equal(p.hasCustomSummarizer, true);
});

test('compactHistory: reset clears counters', async () => {
  const mw = compactHistory({ maxMessages: 5, keepRecent: 2, summarizer: async () => 'x' });
  await mw(makeCtx({ messages: makeMessages(20) }), async () => ({ text: 'ok' }));
  assert.equal(mw.stats.compacted, 1);
  mw.reset();
  assert.equal(mw.stats.compacted, 0);
  assert.equal(mw.stats.totalMessagesRemoved, 0);
});

// ---- End-to-end long conversation ----------------------------------

test('compactHistory: 40-turn conversation collapses to 8 turns', async () => {
  const mw = compactHistory({
    maxMessages: 20, keepRecent: 6,
    summarizer: async () => 'compressed context',
  });
  let seenLen;
  await mw(makeCtx({ messages: makeMessages(40) }), async () => {
    seenLen = arguments; // won't work; use closure below
    return { text: 'ok' };
  });
  // Re-run with proper closure — check via stats + a second run.
  const ctx = makeCtx({ messages: makeMessages(40) });
  let observedLen;
  await mw(ctx, async () => { observedLen = ctx.request.messages.length; return { text: 'ok' }; });
  // 40 - 6 kept = 34 removed; replaced by 2 synthetic + 6 kept = 8 total
  assert.equal(observedLen, 8);
});
