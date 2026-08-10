const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_rag__';
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
  ragChain,
  DEFAULT_RAG_SYSTEM,
  defaultTemplate,
  formatChunksForPrompt,
} = require('../lib/ragChain');

function fakeChat(reply = 'the answer') {
  const calls = [];
  const fn = async (req) => {
    calls.push(req);
    return { text: typeof reply === 'function' ? reply(req) : reply, model: 'test-model', usage: { input_tokens: 50, output_tokens: 20 } };
  };
  fn.calls = calls;
  return fn;
}

function fakeRetriever(chunks) {
  const calls = [];
  const fn = async (query, opts) => {
    calls.push({ query, opts });
    return typeof chunks === 'function' ? chunks(query, opts) : chunks;
  };
  fn.calls = calls;
  return fn;
}

// ---- Input validation --------------------------------------------------

test('ragChain: throws without retriever', () => {
  assert.throws(() => ragChain({ chat: () => {} }), /retriever must be a function/);
});
test('ragChain: throws without llm or chat', () => {
  assert.throws(() => ragChain({ retriever: () => {} }), /pass either.*llm.*or.*chat/);
});
test('ragChain: throws on non-function reranker', () => {
  assert.throws(() => ragChain({ chat: () => {}, retriever: () => {}, reranker: 'bad' }), /reranker must be/);
});
test('ragChain: throws on non-function queryExpander', () => {
  assert.throws(() => ragChain({ chat: () => {}, retriever: () => {}, queryExpander: 'bad' }), /queryExpander must be/);
});
test('ragChain: throws on non-function template', () => {
  assert.throws(() => ragChain({ chat: () => {}, retriever: () => {}, template: 'bad' }), /template must be a function/);
});
test('ragChain: throws on non-positive maxChunks', () => {
  assert.throws(() => ragChain({ chat: () => {}, retriever: () => {}, maxChunks: 0 }), /maxChunks must be/);
});
test('ragChain: throws on non-positive maxCharsPerChunk', () => {
  assert.throws(() => ragChain({ chat: () => {}, retriever: () => {}, maxCharsPerChunk: 0 }), /maxCharsPerChunk must be/);
});
test('ragChain: throws on invalid onEmptyRetrieval', () => {
  assert.throws(
    () => ragChain({ chat: () => {}, retriever: () => {}, onEmptyRetrieval: 'nope' }),
    /onEmptyRetrieval must be/,
  );
});

// ---- Ask input validation ---------------------------------------------

test('ask: throws on empty question', async () => {
  const ask = ragChain({ chat: fakeChat(), retriever: fakeRetriever([]) });
  await assert.rejects(ask(''), /question must be a non-empty string/);
  await assert.rejects(ask(null), /question must be a non-empty string/);
});

// ---- defaultTemplate + formatChunksForPrompt --------------------------

test('defaultTemplate: renders question + context', () => {
  const out = defaultTemplate({
    question: 'What is X?',
    context: '[1] X is a thing.',
    chunks: [],
  });
  assert.match(out, /QUESTION:\n?What is X\?/);
  assert.match(out, /\[1\] X is a thing/);
  assert.match(out, /Answer using ONLY the provided context/);
});

test('formatChunksForPrompt: numbers chunks starting at 1', () => {
  const out = formatChunksForPrompt([{ text: 'a' }, { text: 'b' }, { text: 'c' }]);
  assert.match(out, /^\[1\] a/);
  assert.match(out, /\[2\] b/);
  assert.match(out, /\[3\] c/);
});

// ---- Happy path -------------------------------------------------------

test('ragChain: basic retrieve → answer flow', async () => {
  const retriever = fakeRetriever([
    { id: 'c1', text: 'chunk one text', score: 0.9 },
    { id: 'c2', text: 'chunk two text', score: 0.8 },
  ]);
  const chat = fakeChat();
  const ask = ragChain({ chat, retriever });
  const result = await ask('question?');
  assert.equal(result.answer, 'the answer');
  assert.equal(result.chunks.length, 2);
  assert.equal(result.retrievedCount, 2);
  assert.equal(result.dedupedCount, 2);
  assert.deepEqual(result.queriesUsed, ['question?']);
  assert.equal(result.usage.input_tokens, 50);
  assert.equal(result.model, 'test-model');
  // Chat received the numbered context.
  const userContent = chat.calls[0].messages[0].content;
  assert.match(userContent, /\[1\] chunk one text/);
  assert.match(userContent, /\[2\] chunk two text/);
});

test('ragChain: uses llm handle instead of chat', async () => {
  let called = false;
  const llm = { chat: async () => { called = true; return { text: 'ok', model: 'x', usage: {} }; } };
  const ask = ragChain({ llm, retriever: fakeRetriever([{ id: 'c1', text: 'x' }]) });
  await ask('q');
  assert.equal(called, true);
});

test('ragChain: default systemPrompt used', async () => {
  const chat = fakeChat();
  const ask = ragChain({ chat, retriever: fakeRetriever([{ id: 'c', text: 't' }]) });
  await ask('q');
  assert.equal(chat.calls[0].system, DEFAULT_RAG_SYSTEM);
});

test('ragChain: custom systemPrompt propagates', async () => {
  const chat = fakeChat();
  const ask = ragChain({
    chat,
    retriever: fakeRetriever([{ id: 'c', text: 't' }]),
    systemPrompt: 'YOU ARE STRICT',
  });
  await ask('q');
  assert.equal(chat.calls[0].system, 'YOU ARE STRICT');
});

test('ragChain: topK opt override propagates to retriever', async () => {
  const retriever = fakeRetriever([{ id: 'c', text: 't' }]);
  const ask = ragChain({ chat: fakeChat(), retriever, defaultTopK: 8 });
  await ask('q', { topK: 20 });
  assert.equal(retriever.calls[0].opts.topK, 20);
});

test('ragChain: filter opt passed to retriever', async () => {
  const retriever = fakeRetriever([{ id: 'c', text: 't' }]);
  const ask = ragChain({ chat: fakeChat(), retriever });
  await ask('q', { filter: { region: 'EMEA' } });
  assert.deepEqual(retriever.calls[0].opts.filter, { region: 'EMEA' });
});

test('ragChain: opts.maxTokens forwarded to chat', async () => {
  const chat = fakeChat();
  const ask = ragChain({ chat, retriever: fakeRetriever([{ id: 'c', text: 't' }]) });
  await ask('q', { maxTokens: 250 });
  assert.equal(chat.calls[0].maxTokens, 250);
});

// ---- Deduplication ----------------------------------------------------

test('ragChain: dedupes by chunk.id across expanded queries', async () => {
  const expander = async () => ['q1', 'q2', 'q3'];
  const retriever = fakeRetriever((query) => {
    // Each expanded query returns overlapping chunks by id.
    if (query === 'q1') return [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }];
    if (query === 'q2') return [{ id: 'b', text: 'B' }, { id: 'c', text: 'C' }];
    return [{ id: 'a', text: 'A' }, { id: 'd', text: 'D' }];
  });
  const chat = fakeChat();
  const ask = ragChain({ chat, retriever, queryExpander: expander });
  const result = await ask('original');
  assert.equal(result.retrievedCount, 6);
  assert.equal(result.dedupedCount, 4);
  assert.equal(result.chunks.length, 4);
  assert.deepEqual(result.chunks.map((c) => c.id), ['a', 'b', 'c', 'd']);
});

test('ragChain: dedupes by text when id absent', async () => {
  const retriever = fakeRetriever([
    { text: 'same-text' }, { text: 'same-text' }, { text: 'other' },
  ]);
  const ask = ragChain({ chat: fakeChat(), retriever });
  const result = await ask('q');
  assert.equal(result.dedupedCount, 2);
});

// ---- Reranker + query expander ---------------------------------------

test('ragChain: reranker invoked with question + deduped chunks', async () => {
  let seen;
  const reranker = async (q, chunks) => {
    seen = { q, chunks };
    return chunks.slice().reverse();   // reverse order to prove reranker output is used
  };
  const chat = fakeChat();
  const ask = ragChain({
    chat,
    retriever: fakeRetriever([
      { id: 'x', text: 'X' }, { id: 'y', text: 'Y' }, { id: 'z', text: 'Z' },
    ]),
    reranker,
  });
  const result = await ask('q');
  assert.equal(seen.q, 'q');
  assert.deepEqual(seen.chunks.map((c) => c.id), ['x', 'y', 'z']);
  assert.deepEqual(result.chunks.map((c) => c.id), ['z', 'y', 'x']);
});

test('ragChain: reranker returning non-array is ignored', async () => {
  const reranker = async () => 'not-an-array';
  const ask = ragChain({
    chat: fakeChat(),
    retriever: fakeRetriever([{ id: 'x', text: 'X' }]),
    reranker,
  });
  const result = await ask('q');
  assert.equal(result.chunks.length, 1);
  assert.equal(result.chunks[0].id, 'x');
});

test('ragChain: queryExpander adds to queriesUsed', async () => {
  const expander = async (q) => [q, `${q} rephrased`];
  const retriever = fakeRetriever([{ id: 'x', text: 'X' }]);
  const ask = ragChain({ chat: fakeChat(), retriever, queryExpander: expander });
  const result = await ask('original');
  assert.deepEqual(result.queriesUsed, ['original', 'original rephrased']);
  assert.equal(retriever.calls.length, 2);
});

test('ragChain: queryExpander returning empty falls back to original', async () => {
  const expander = async () => [];
  const retriever = fakeRetriever([{ id: 'x', text: 'X' }]);
  const ask = ragChain({ chat: fakeChat(), retriever, queryExpander: expander });
  const result = await ask('original');
  assert.deepEqual(result.queriesUsed, ['original']);
});

// ---- Truncation -------------------------------------------------------

test('ragChain: caps chunk count at maxChunks', async () => {
  const chunks = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, text: `t${i}` }));
  const ask = ragChain({ chat: fakeChat(), retriever: fakeRetriever(chunks), maxChunks: 3 });
  const result = await ask('q');
  assert.equal(result.chunks.length, 3);
});

test('ragChain: truncates each chunk text to maxCharsPerChunk', async () => {
  const big = 'x'.repeat(500);
  const ask = ragChain({
    chat: fakeChat(),
    retriever: fakeRetriever([{ id: 'c', text: big }]),
    maxCharsPerChunk: 100,
  });
  const result = await ask('q');
  assert.equal(result.chunks[0].text.length, 100);
});

// ---- Empty retrieval ------------------------------------------------

test('ragChain: onEmptyRetrieval=error throws typed error', async () => {
  const ask = ragChain({
    chat: fakeChat(),
    retriever: fakeRetriever([]),
    onEmptyRetrieval: 'error',
  });
  await assert.rejects(ask('what is X?'), (err) => {
    assert.equal(err.code, 'RAG_EMPTY_RETRIEVAL');
    assert.equal(err.question, 'what is X?');
    return true;
  });
});

test('ragChain: onEmptyRetrieval=answer-anyway calls LLM without context', async () => {
  const chat = fakeChat();
  const ask = ragChain({
    chat,
    retriever: fakeRetriever([]),
    onEmptyRetrieval: 'answer-anyway',
  });
  const result = await ask('q');
  assert.equal(result.answer, 'the answer');
  assert.equal(chat.calls.length, 1);
  // No context in user message
  assert.doesNotMatch(chat.calls[0].messages[0].content, /\[1\]/);
});

test('ragChain: onEmptyRetrieval=function returns callback result', async () => {
  const ask = ragChain({
    chat: fakeChat(),
    retriever: fakeRetriever([]),
    onEmptyRetrieval: (q) => ({ answer: `no data for ${q}`, chunks: [], usage: null, model: null }),
  });
  const result = await ask('impossible?');
  assert.equal(result.answer, 'no data for impossible?');
});

// ---- Custom template -------------------------------------------------

test('ragChain: custom template used', async () => {
  const chat = fakeChat();
  const ask = ragChain({
    chat,
    retriever: fakeRetriever([{ id: 'c', text: 'X' }]),
    template: ({ question, chunks }) => `Q=${question} N=${chunks.length}`,
  });
  await ask('hello?');
  assert.equal(chat.calls[0].messages[0].content, 'Q=hello? N=1');
});
