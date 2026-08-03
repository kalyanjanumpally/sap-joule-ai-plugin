const { test } = require('node:test');
const assert = require('node:assert/strict');
const SqliteVectorStore = require('../lib/backends/sqlite');
const RAG = require('../lib/rag');
const { defaultPromptTemplate, DEFAULT_SYSTEM_INSTRUCTIONS } = require('../lib/rag');

// Deterministic 8-dim "embedding" — same shape as sqlite.test.js
function fakeEmbed(text) {
  const vec = new Array(8).fill(0);
  for (let i = 0; i < text.length; i++) vec[i % 8] += text.charCodeAt(i);
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return norm === 0 ? vec : vec.map(v => v / norm);
}
const fakeEmbedder = {
  async embed({ input }) {
    const inputs = Array.isArray(input) ? input : [input];
    return { embeddings: inputs.map(fakeEmbed), model: 'fake-embedder' };
  },
};

// Minimal LLMService double that records what it was asked and returns a
// fixed reply. Different tests configure the reply shape to match various
// provider envelopes (plain string, {text}, Anthropic content blocks, ...).
function makeFakeLLM(reply = 'the refund window is 30 days [doc_a]') {
  const calls = [];
  return {
    calls,
    async chat(req) { calls.push({ method: 'chat', req }); return reply; },
    async *stream(req) {
      calls.push({ method: 'stream', req });
      const chunks = String(reply).match(/.{1,10}/g) ?? [];
      for (const c of chunks) yield { text: c };
    },
  };
}

async function makeStore() {
  const store = new SqliteVectorStore({
    embed: fakeEmbedder,
    dimension: 8,
    table: 'rag_test',
    dbPath: ':memory:',
  });
  await store.init();
  await store.upsertMany([
    { id: 'doc_a', text: 'Refunds are accepted within 30 days of purchase.', metadata: { category: 'policy' } },
    { id: 'doc_b', text: 'Shipping is free for orders over 50 EUR.', metadata: { category: 'policy' } },
    { id: 'doc_c', text: 'Warranty covers manufacturing defects for 2 years.', metadata: { category: 'warranty' } },
  ]);
  return store;
}

// ---- constructor validation ---------------------------------------------

test('RAG: constructor requires llm with chat()', () => {
  assert.throws(() => new RAG({ store: {} }), /llm/);
  assert.throws(() => new RAG({ llm: {}, store: {} }), /chat/);
});

test('RAG: constructor requires store with search()', async () => {
  const llm = makeFakeLLM();
  assert.throws(() => new RAG({ llm }), /store/);
  assert.throws(() => new RAG({ llm, store: {} }), /search/);
});

test('RAG: constructor accepts custom systemInstructions + promptTemplate', async () => {
  const store = await makeStore();
  try {
    const rag = new RAG({
      llm: makeFakeLLM(),
      store,
      systemInstructions: 'Answer in French only.',
      promptTemplate: (hits) => `SOURCES=${hits.length}`,
    });
    assert.equal(rag.systemInstructions, 'Answer in French only.');
    assert.equal(rag.promptTemplate([]), 'SOURCES=0');
    assert.equal(rag.promptTemplate([{ id: 'x', text: 't', metadata: null }]), 'SOURCES=1');
  } finally { await store.close(); }
});

// ---- retrieve ------------------------------------------------------------

test('RAG.retrieve: forwards to store.search and returns hits', async () => {
  const store = await makeStore();
  try {
    const rag = new RAG({ llm: makeFakeLLM(), store });
    const hits = await rag.retrieve({ query: 'refund policy', topK: 2 });
    assert.equal(hits.length, 2);
    for (const h of hits) assert.ok(typeof h.score === 'number');
  } finally { await store.close(); }
});

test('RAG.retrieve: rejects empty query', async () => {
  const store = await makeStore();
  try {
    const rag = new RAG({ llm: makeFakeLLM(), store });
    await assert.rejects(rag.retrieve({ query: '' }), /non-empty string/);
    await assert.rejects(rag.retrieve({}), /non-empty string/);
  } finally { await store.close(); }
});

test('RAG.retrieve: defaults topK to 5', async () => {
  const store = await makeStore();
  const seen = [];
  const wrapped = { search: (p) => { seen.push(p); return store.search(p); } };
  try {
    const rag = new RAG({ llm: makeFakeLLM(), store: wrapped });
    await rag.retrieve({ query: 'anything' });
    assert.equal(seen[0].topK, 5);
  } finally { await store.close(); }
});

// ---- augment -------------------------------------------------------------

test('RAG.augment: default template includes id + metadata + text', () => {
  const rag = new RAG({ llm: makeFakeLLM(), store: { search: () => [] } });
  const { system, messages } = rag.augment({
    query: 'What is the refund window?',
    hits: [
      { id: 'doc_a', text: 'Refunds within 30 days.', metadata: { category: 'policy' } },
      { id: 'doc_b', text: 'Free shipping over 50 EUR.', metadata: null },
    ],
  });
  assert.equal(system, DEFAULT_SYSTEM_INSTRUCTIONS);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  const content = messages[0].content;
  assert.match(content, /<context>/);
  assert.match(content, /\[doc_a\]/);
  assert.match(content, /\(metadata: \{"category":"policy"\}\)/);
  assert.match(content, /Refunds within 30 days\./);
  assert.match(content, /\[doc_b\]/);
  // No metadata block when metadata is null
  assert.doesNotMatch(content, /\[doc_b\] \(metadata/);
  assert.match(content, /Question: What is the refund window\?/);
});

test('RAG.augment: empty hits still produces a valid prompt', () => {
  const rag = new RAG({ llm: makeFakeLLM(), store: { search: () => [] } });
  const { messages } = rag.augment({ query: 'anything', hits: [] });
  assert.match(messages[0].content, /no relevant sources found/);
});

test('RAG.augment: per-call systemInstructions override constructor default', () => {
  const rag = new RAG({
    llm: makeFakeLLM(), store: { search: () => [] },
    systemInstructions: 'DEFAULT',
  });
  const { system } = rag.augment({
    query: 'q', hits: [], systemInstructions: 'PER_CALL',
  });
  assert.equal(system, 'PER_CALL');
});

test('RAG.augment: validates inputs', () => {
  const rag = new RAG({ llm: makeFakeLLM(), store: { search: () => [] } });
  assert.throws(() => rag.augment({ hits: [] }), /query/);
  assert.throws(() => rag.augment({ query: 'q' }), /hits/);
  assert.throws(() => rag.augment({ query: 'q', hits: 'nope' }), /hits/);
});

// ---- answer --------------------------------------------------------------

test('RAG.answer: retrieve → augment → llm.chat → { answer, hits, raw }', async () => {
  const store = await makeStore();
  const llm = makeFakeLLM('30 days [doc_a]');
  try {
    const rag = new RAG({ llm, store });
    const result = await rag.answer({ query: 'refund window?', topK: 2 });
    assert.equal(result.answer, '30 days [doc_a]');
    assert.equal(result.hits.length, 2);
    assert.equal(result.raw, '30 days [doc_a]');
    // llm.chat received the augmented prompt
    assert.equal(llm.calls.length, 1);
    assert.equal(llm.calls[0].method, 'chat');
    assert.equal(llm.calls[0].req.system, DEFAULT_SYSTEM_INSTRUCTIONS);
    assert.match(llm.calls[0].req.messages[0].content, /Question: refund window\?/);
  } finally { await store.close(); }
});

test('RAG.answer: forwards extra fields to llm.chat (model, maxTokens, etc.)', async () => {
  const store = await makeStore();
  const llm = makeFakeLLM();
  try {
    const rag = new RAG({ llm, store });
    await rag.answer({
      query: 'q', topK: 1,
      model: 'gpt-4', maxTokens: 512, thinking: { budget: 200 },
    });
    const req = llm.calls[0].req;
    assert.equal(req.model, 'gpt-4');
    assert.equal(req.maxTokens, 512);
    assert.deepEqual(req.thinking, { budget: 200 });
    // topK is a RAG option — NOT forwarded to the LLM
    assert.equal(req.topK, undefined);
    // query is a RAG option — NOT forwarded (would confuse providers)
    assert.equal(req.query, undefined);
  } finally { await store.close(); }
});

test('RAG.answer: extractText handles plain-string reply', async () => {
  const store = await makeStore();
  try {
    const rag = new RAG({ llm: makeFakeLLM('just a string'), store });
    const { answer } = await rag.answer({ query: 'q', topK: 1 });
    assert.equal(answer, 'just a string');
  } finally { await store.close(); }
});

test('RAG.answer: extractText handles { text } shape', async () => {
  const store = await makeStore();
  try {
    const rag = new RAG({ llm: makeFakeLLM({ text: 'from text field' }), store });
    const { answer } = await rag.answer({ query: 'q', topK: 1 });
    assert.equal(answer, 'from text field');
  } finally { await store.close(); }
});

test('RAG.answer: extractText handles Anthropic content-block array', async () => {
  const store = await makeStore();
  const anthropicReply = {
    content: [
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'world.' },
      { type: 'tool_use', id: 't1', name: 'noop', input: {} }, // filtered out
    ],
  };
  try {
    const rag = new RAG({ llm: makeFakeLLM(anthropicReply), store });
    const { answer, raw } = await rag.answer({ query: 'q', topK: 1 });
    assert.equal(answer, 'Hello world.');
    assert.equal(raw, anthropicReply);
  } finally { await store.close(); }
});

test('RAG.answer: extractText handles Ollama { message: { content } } shape', async () => {
  const store = await makeStore();
  try {
    const rag = new RAG({
      llm: makeFakeLLM({ message: { role: 'assistant', content: 'ollama reply' } }),
      store,
    });
    const { answer } = await rag.answer({ query: 'q', topK: 1 });
    assert.equal(answer, 'ollama reply');
  } finally { await store.close(); }
});

test('RAG.answer: extractText handles OpenAI-style choices[0].message.content', async () => {
  const store = await makeStore();
  try {
    const rag = new RAG({
      llm: makeFakeLLM({ choices: [{ message: { content: 'openai reply' } }] }),
      store,
    });
    const { answer } = await rag.answer({ query: 'q', topK: 1 });
    assert.equal(answer, 'openai reply');
  } finally { await store.close(); }
});

test('RAG.answer: filter passes through to store.search', async () => {
  const store = await makeStore();
  const seen = [];
  const wrapped = {
    search: (p) => { seen.push(p); return store.search(p); },
  };
  try {
    const rag = new RAG({ llm: makeFakeLLM(), store: wrapped });
    await rag.answer({ query: 'q', topK: 1, filter: { category: 'policy' } });
    assert.deepEqual(seen[0].filter, { category: 'policy' });
  } finally { await store.close(); }
});

// ---- stream --------------------------------------------------------------

test('RAG.stream: returns { hits, stream } — hits available before first token', async () => {
  const store = await makeStore();
  const llm = makeFakeLLM('streamed answer text');
  try {
    const rag = new RAG({ llm, store });
    const { hits, stream } = await rag.stream({ query: 'q', topK: 2 });
    assert.equal(hits.length, 2);
    let out = '';
    for await (const chunk of stream) out += chunk.text;
    assert.equal(out, 'streamed answer text');
    assert.equal(llm.calls[0].method, 'stream');
  } finally { await store.close(); }
});

test('RAG.stream: throws when the llm has no stream() method', async () => {
  const store = await makeStore();
  try {
    const llmNoStream = { chat: async () => 'x' };
    const rag = new RAG({ llm: llmNoStream, store });
    await assert.rejects(rag.stream({ query: 'q' }), /stream\(\) method/);
  } finally { await store.close(); }
});

// ---- defaultPromptTemplate exported ------------------------------------

test('defaultPromptTemplate: exported for reuse', () => {
  assert.equal(typeof defaultPromptTemplate, 'function');
  const out = defaultPromptTemplate([{ id: 'x', text: 'hello', metadata: null }]);
  assert.match(out, /<context>/);
  assert.match(out, /\[x\]: hello/);
  assert.match(out, /<\/context>/);
});
