const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_scs__';
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
  sessionContextStore,
  inMemorySessionStore,
  pruneOldest,
} = require('../lib/middleware/sessionContextStore');

// ---- Helpers ----------------------------------------------------------

function ctxWith(sessionId, messages) {
  return {
    method: 'chat',
    request: {
      sessionId,
      messages: messages ?? [],
    },
  };
}
function userMsg(content) { return { role: 'user', content }; }
function asstMsg(content) { return { role: 'assistant', content }; }
function sysMsg(content)  { return { role: 'system',    content }; }

// ---- pruneOldest -----------------------------------------------------

test('pruneOldest: under budget → unchanged', () => {
  const msgs = [userMsg('a'), asstMsg('b'), userMsg('c')];
  const r = pruneOldest(msgs, 10);
  assert.deepEqual(r.kept, msgs);
  assert.deepEqual(r.dropped, []);
});

test('pruneOldest: over budget → drops oldest', () => {
  const msgs = Array.from({ length: 10 }, (_, i) => userMsg('m' + i));
  const r = pruneOldest(msgs, 4);
  assert.equal(r.kept.length, 4);
  assert.deepEqual(r.kept.map((m) => m.content), ['m6', 'm7', 'm8', 'm9']);
  assert.equal(r.dropped.length, 6);
});

test('pruneOldest: preserves leading system message', () => {
  const msgs = [sysMsg('SYS'), userMsg('a'), asstMsg('b'), userMsg('c'), asstMsg('d')];
  const r = pruneOldest(msgs, 3);
  // budget = 3 → 1 for system + 2 for body → keeps last 2 body messages.
  assert.equal(r.kept[0].role, 'system');
  assert.deepEqual(r.kept.map((m) => m.content), ['SYS', 'c', 'd']);
  assert.equal(r.dropped.length, 2);
});

// ---- inMemorySessionStore -------------------------------------------

test('inMemorySessionStore: validates maxSessions', () => {
  assert.throws(() => inMemorySessionStore({ maxSessions: 0 }), /maxSessions/);
});
test('inMemorySessionStore: validates ttlMs', () => {
  assert.throws(() => inMemorySessionStore({ ttlMs: -1 }), /ttlMs/);
});
test('inMemorySessionStore: put + get + append', async () => {
  const store = inMemorySessionStore();
  await store.put('s1', [userMsg('a')]);
  const got = await store.get('s1');
  assert.equal(got.length, 1);
  await store.append('s1', asstMsg('b'), userMsg('c'));
  const got2 = await store.get('s1');
  assert.equal(got2.length, 3);
});
test('inMemorySessionStore: unknown session → null', async () => {
  const store = inMemorySessionStore();
  assert.equal(await store.get('nope'), null);
});
test('inMemorySessionStore: TTL expires entries', async () => {
  let t = 0;
  const store = inMemorySessionStore({ ttlMs: 100, now: () => t });
  await store.put('s1', [userMsg('a')]);
  t = 50;  assert.ok(await store.get('s1'));
  t = 200; assert.equal(await store.get('s1'), null);
});
test('inMemorySessionStore: maxSessions evicts oldest', async () => {
  const store = inMemorySessionStore({ maxSessions: 2 });
  await store.put('s1', [userMsg('a')]);
  await store.put('s2', [userMsg('b')]);
  await store.put('s3', [userMsg('c')]);
  assert.equal(await store.get('s1'), null);
  assert.ok(await store.get('s3'));
});
test('inMemorySessionStore: delete', async () => {
  const store = inMemorySessionStore();
  await store.put('s1', [userMsg('a')]);
  await store.delete('s1');
  assert.equal(await store.get('s1'), null);
});

// ---- Middleware: validation ----------------------------------------

test('sessionContextStore: throws without sessionOf', () => {
  assert.throws(() => sessionContextStore({ store: inMemorySessionStore() }), /sessionOf/);
});
test('sessionContextStore: throws without store', () => {
  assert.throws(() => sessionContextStore({ sessionOf: () => 's' }), /store/);
});
test('sessionContextStore: throws on incomplete store', () => {
  assert.throws(() => sessionContextStore({
    sessionOf: () => 's', store: { get: async () => [] },
  }), /store/);
});
test('sessionContextStore: throws on invalid maxMessages', () => {
  assert.throws(() => sessionContextStore({
    sessionOf: () => 's', store: inMemorySessionStore(), maxMessages: 0,
  }), /maxMessages/);
});
test('sessionContextStore: throws on invalid pruneStrategy', () => {
  assert.throws(() => sessionContextStore({
    sessionOf: () => 's', store: inMemorySessionStore(), pruneStrategy: 'bogus',
  }), /pruneStrategy/);
});
test('sessionContextStore: summarize strategy requires summarizer', () => {
  assert.throws(() => sessionContextStore({
    sessionOf: () => 's', store: inMemorySessionStore(), pruneStrategy: 'summarize',
  }), /summarizer/);
});
test('sessionContextStore: throws on non-function callback', () => {
  assert.throws(() => sessionContextStore({
    sessionOf: () => 's', store: inMemorySessionStore(), onSessionHit: 'x',
  }), /callbacks/);
});

// ---- First turn: session miss ------------------------------------

test('sessionContextStore: first turn → miss, prepends nothing', async () => {
  const store = inMemorySessionStore();
  const mw = sessionContextStore({
    sessionOf: (ctx) => ctx.request.sessionId, store,
  });
  const ctx = ctxWith('s1', [userMsg('Hi')]);
  let seenMessages;
  await mw(ctx, async () => {
    seenMessages = ctx.request.messages;
    return { text: 'Hello' };
  });
  assert.equal(seenMessages.length, 1);   // just the caller's user turn
  assert.equal(seenMessages[0].content, 'Hi');
  assert.equal(mw.stats.sessionHits, 0);
  assert.equal(mw.stats.sessionMisses, 1);
});

test('sessionContextStore: appends user + assistant on first turn', async () => {
  const store = inMemorySessionStore();
  const mw = sessionContextStore({
    sessionOf: (ctx) => ctx.request.sessionId, store,
  });
  const ctx = ctxWith('s1', [userMsg('Hi')]);
  await mw(ctx, async () => ({ text: 'Hello there' }));
  const stored = await store.get('s1');
  assert.equal(stored.length, 2);
  assert.equal(stored[0].role, 'user');
  assert.equal(stored[0].content, 'Hi');
  assert.equal(stored[1].role, 'assistant');
  assert.equal(stored[1].content, 'Hello there');
});

// ---- Second turn: session hit ------------------------------

test('sessionContextStore: second turn → hit, prepends prior', async () => {
  const store = inMemorySessionStore();
  const mw = sessionContextStore({
    sessionOf: (ctx) => ctx.request.sessionId, store,
  });
  // Turn 1
  await mw(ctxWith('s1', [userMsg('What is my name?')]), async () => ({ text: "You didn't say." }));
  // Turn 2
  const ctx = ctxWith('s1', [userMsg('It is Alice.')]);
  let seenMessages;
  await mw(ctx, async () => {
    seenMessages = ctx.request.messages.map((m) => `${m.role}:${m.content}`);
    return { text: 'Nice to meet you, Alice.' };
  });
  assert.deepEqual(seenMessages, [
    'user:What is my name?',
    "assistant:You didn't say.",
    'user:It is Alice.',
  ]);
  assert.equal(mw.stats.sessionHits, 1);
});

test('sessionContextStore: preserves leading system message from caller', async () => {
  const store = inMemorySessionStore();
  const mw = sessionContextStore({
    sessionOf: (ctx) => ctx.request.sessionId, store,
  });
  await mw(ctxWith('s1', [userMsg('Hi')]), async () => ({ text: 'Hello' }));
  const ctx = ctxWith('s1', [sysMsg('You are helpful.'), userMsg('Follow-up')]);
  let seenMessages;
  await mw(ctx, async () => {
    seenMessages = ctx.request.messages.map((m) => `${m.role}:${m.content}`);
    return { text: 'ok' };
  });
  // System stays at front; prior turns inserted between system and follow-up.
  assert.equal(seenMessages[0], 'system:You are helpful.');
  assert.ok(seenMessages.includes('user:Hi'));
  assert.ok(seenMessages.includes('assistant:Hello'));
  assert.equal(seenMessages[seenMessages.length - 1], 'user:Follow-up');
});

test('sessionContextStore: original ctx.request restored after call', async () => {
  const store = inMemorySessionStore();
  const mw = sessionContextStore({
    sessionOf: (ctx) => ctx.request.sessionId, store,
  });
  await mw(ctxWith('s1', [userMsg('a')]), async () => ({ text: 'x' }));
  const ctx = ctxWith('s1', [userMsg('b')]);
  const original = ctx.request;
  await mw(ctx, async () => ({ text: 'y' }));
  assert.equal(ctx.request, original);
});

// ---- No session ID → passthrough ---------------------

test('sessionContextStore: no session ID → passthrough (no store touch)', async () => {
  const store = inMemorySessionStore();
  const mw = sessionContextStore({
    sessionOf: () => null, store,
  });
  await mw(ctxWith('does-not-matter', [userMsg('a')]), async () => ({ text: 'x' }));
  assert.equal(mw.stats.passthroughs, 1);
  assert.equal(await store.size(), 0);
});

// ---- Streaming skipped ------------------------------

test('sessionContextStore: streaming methods skipped by default', async () => {
  const store = inMemorySessionStore();
  const mw = sessionContextStore({
    sessionOf: (ctx) => ctx.request.sessionId, store,
  });
  await mw({ method: 'stream', request: { sessionId: 's1', messages: [userMsg('a')] } },
           async () => ({}));
  assert.equal(mw.stats.skippedStreaming, 1);
  assert.equal(await store.size(), 0);
});

// ---- Prune: oldest -------------------------------

test('sessionContextStore: prune oldest when maxMessages exceeded', async () => {
  const store = inMemorySessionStore();
  const mw = sessionContextStore({
    sessionOf: (ctx) => ctx.request.sessionId, store, maxMessages: 4,
  });
  // Feed 5 turns → 10 messages stored (u+a per turn).
  for (let i = 0; i < 5; i++) {
    await mw(ctxWith('s1', [userMsg(`Q${i}`)]), async () => ({ text: `A${i}` }));
  }
  const stored = await store.get('s1');
  assert.equal(stored.length, 4);   // pruned to maxMessages
  assert.equal(stored[stored.length - 1].content, 'A4');
  assert.ok(mw.stats.prunes > 0);
});

test('sessionContextStore: onPrune fires with counts', async () => {
  const store = inMemorySessionStore();
  const events = [];
  const mw = sessionContextStore({
    sessionOf: (ctx) => ctx.request.sessionId, store, maxMessages: 2,
    onPrune: (i) => events.push(i),
  });
  for (let i = 0; i < 3; i++) {
    await mw(ctxWith('s1', [userMsg(`Q${i}`)]), async () => ({ text: `A${i}` }));
  }
  assert.ok(events.length > 0);
  assert.equal(events[0].sessionId, 's1');
  assert.equal(events[0].strategy, 'oldest');
});

// ---- Prune: summarize ---------------------------

test('sessionContextStore: summarize strategy replaces dropped with synthetic summary', async () => {
  const store = inMemorySessionStore();
  const mw = sessionContextStore({
    sessionOf: (ctx) => ctx.request.sessionId, store, maxMessages: 3,
    pruneStrategy: 'summarize',
    summarizer: async (dropped) => `discussed ${dropped.length} messages`,
  });
  for (let i = 0; i < 4; i++) {
    await mw(ctxWith('s1', [userMsg(`Q${i}`)]), async () => ({ text: `A${i}` }));
  }
  const stored = await store.get('s1');
  // Summary is prepended, then last kept messages.
  assert.equal(stored[0].role, 'assistant');
  assert.ok(stored[0].content.includes('Summary of earlier conversation'));
  assert.ok(mw.stats.summarizations > 0);
});

test('sessionContextStore: summarizer failure falls through to plain drop', async () => {
  const store = inMemorySessionStore();
  const errors = [];
  const mw = sessionContextStore({
    sessionOf: (ctx) => ctx.request.sessionId, store, maxMessages: 2,
    pruneStrategy: 'summarize',
    summarizer: async () => { throw new Error('summarizer down'); },
    onError: (i) => errors.push(i),
  });
  for (let i = 0; i < 3; i++) {
    await mw(ctxWith('s1', [userMsg(`Q${i}`)]), async () => ({ text: `A${i}` }));
  }
  // Plain drop happened; no summary message.
  const stored = await store.get('s1');
  assert.ok(!stored[0].content?.includes('Summary of earlier'));
  assert.ok(errors.some((e) => e.phase === 'summarizer'));
});

// ---- Store errors ------------------------------

test('sessionContextStore: store.get error → passthrough downstream', async () => {
  const badStore = {
    async get() { throw new Error('store down'); },
    async put() {},
    async append() {},
  };
  const errors = [];
  const mw = sessionContextStore({
    sessionOf: (ctx) => ctx.request.sessionId, store: badStore,
    onError: (i) => errors.push(i),
  });
  const r = await mw(ctxWith('s1', [userMsg('a')]), async () => ({ text: 'x' }));
  assert.equal(r.text, 'x');
  assert.equal(mw.stats.storeErrors, 1);
});

test('sessionContextStore: store.append error → still returns result', async () => {
  const badStore = {
    async get() { return null; },
    async put() {},
    async append() { throw new Error('append down'); },
  };
  const errors = [];
  const mw = sessionContextStore({
    sessionOf: (ctx) => ctx.request.sessionId, store: badStore,
    onError: (i) => errors.push(i),
  });
  const r = await mw(ctxWith('s1', [userMsg('a')]), async () => ({ text: 'x' }));
  assert.equal(r.text, 'x');
  assert.ok(errors.some((e) => e.phase === 'store.append'));
});

// ---- sessionOf error ---------------------------

test('sessionContextStore: sessionOf throws → propagates', async () => {
  const errors = [];
  const mw = sessionContextStore({
    sessionOf: () => { throw new Error('bad'); },
    store: inMemorySessionStore(),
    onError: (i) => errors.push(i),
  });
  await assert.rejects(mw(ctxWith('s1', [userMsg('a')]), async () => 'ok'), /bad/);
  assert.equal(errors[0].phase, 'sessionOf');
});

// ---- Callbacks -----------------------------

test('sessionContextStore: onSessionHit + onSessionMiss', async () => {
  const store = inMemorySessionStore();
  const events = [];
  const mw = sessionContextStore({
    sessionOf: (ctx) => ctx.request.sessionId, store,
    onSessionHit:  (i) => events.push(['hit', i.sessionId, i.priorTurnCount]),
    onSessionMiss: (i) => events.push(['miss', i.sessionId]),
  });
  await mw(ctxWith('s1', [userMsg('a')]), async () => ({ text: 'x' }));
  await mw(ctxWith('s1', [userMsg('b')]), async () => ({ text: 'y' }));
  assert.equal(events[0][0], 'miss');
  assert.equal(events[1][0], 'hit');
  assert.equal(events[1][2], 2);
});

test('sessionContextStore: callback throws swallowed', async () => {
  const mw = sessionContextStore({
    sessionOf: (ctx) => ctx.request.sessionId,
    store: inMemorySessionStore(),
    onSessionHit: () => { throw new Error('x'); },
    onSessionMiss: () => { throw new Error('x'); },
  });
  await mw(ctxWith('s1', [userMsg('a')]), async () => ({ text: 'x' }));
});

// ---- Persists tool calls too ----------------

test('sessionContextStore: assistant turn with toolCalls persisted', async () => {
  const store = inMemorySessionStore();
  const mw = sessionContextStore({
    sessionOf: (ctx) => ctx.request.sessionId, store,
  });
  await mw(ctxWith('s1', [userMsg('lookup')]), async () => ({
    text: 'calling tool',
    toolCalls: [{ id: 't1', name: 'lookup', input: { id: 'x' } }],
  }));
  const stored = await store.get('s1');
  const asst = stored.find((m) => m.role === 'assistant');
  assert.ok(Array.isArray(asst.toolCalls));
  assert.equal(asst.toolCalls[0].name, 'lookup');
});

// ---- hitRate + reset + MCP ------------

test('sessionContextStore: hitRate reflects usage', async () => {
  const store = inMemorySessionStore();
  const mw = sessionContextStore({
    sessionOf: (ctx) => ctx.request.sessionId, store,
  });
  await mw(ctxWith('s1', [userMsg('a')]), async () => ({ text: 'x' }));   // miss
  await mw(ctxWith('s1', [userMsg('b')]), async () => ({ text: 'y' }));   // hit
  await mw(ctxWith('s1', [userMsg('c')]), async () => ({ text: 'z' }));   // hit
  assert.equal(mw.hitRate(), 2/3);
});

test('sessionContextStore: reset clears counters', async () => {
  const mw = sessionContextStore({
    sessionOf: (ctx) => ctx.request.sessionId, store: inMemorySessionStore(),
  });
  await mw(ctxWith('s1', [userMsg('a')]), async () => ({ text: 'x' }));
  assert.equal(mw.stats.totalCalls, 1);
  mw.reset();
  assert.equal(mw.stats.totalCalls, 0);
  assert.equal(mw.hitRate(), 0);
});

test('sessionContextStore: asMcpResource', () => {
  const mw = sessionContextStore({
    sessionOf: (ctx) => ctx.request.sessionId,
    store: inMemorySessionStore(),
    maxMessages: 30,
    pruneStrategy: 'summarize',
    summarizer: async () => 'x',
  });
  const r = mw.asMcpResource();
  assert.equal(r.uri, 'config://session-context-store');
  const p = r.handler();
  assert.equal(p.maxMessages, 30);
  assert.equal(p.pruneStrategy, 'summarize');
  assert.equal(p.hasSummarizer, true);
  assert.equal(p.hitRate, 0);
});
