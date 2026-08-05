const { test } = require('node:test');
const assert = require('node:assert/strict');
const { llmRerank, DEFAULT_BATCH_SIZE } = require('../lib/llmRerank');
const RAG = require('../lib/rag');

// ---- test double: LLM that returns scripted scores ---------------------

function makeLLM(scripted) {
  const calls = [];
  return {
    calls,
    async chat(req) {
      calls.push(req);
      const scores = typeof scripted === 'function' ? scripted(calls.length - 1) : scripted;
      if (scores == null) throw new Error('boom');
      // Anthropic-shape structured output — `data` is what the plugin exposes.
      if (typeof scores === 'string') return { text: scores };
      return { data: { scores } };
    },
  };
}

const H = (id, text) => ({ id, text, metadata: null, score: 0 });

// ---- construction validation -------------------------------------------

test('llmRerank: requires an LLM with chat()', () => {
  assert.throws(() => llmRerank({}), /llm/);
  assert.throws(() => llmRerank({ llm: {} }), /chat/);
});

test('llmRerank: rejects invalid batchSize', () => {
  const llm = makeLLM([]);
  assert.throws(() => llmRerank({ llm, batchSize: 0 }), /batchSize/);
  assert.throws(() => llmRerank({ llm, batchSize: -3 }), /batchSize/);
  assert.throws(() => llmRerank({ llm, batchSize: NaN }), /batchSize/);
});

// ---- happy path --------------------------------------------------------

test('llmRerank: sorts hits by LLM score descending; attaches rerankScore', async () => {
  const llm = makeLLM([
    { index: 0, score: 3 },
    { index: 1, score: 9 },
    { index: 2, score: 6 },
  ]);
  const rerank = llmRerank({ llm });
  const hits = [H('a', 't1'), H('b', 't2'), H('c', 't3')];
  const out = await rerank(hits, 'why?');
  assert.deepEqual(out.map(h => h.id), ['b', 'c', 'a']);
  assert.equal(out[0].rerankScore, 9);
  assert.equal(out[1].rerankScore, 6);
  assert.equal(out[2].rerankScore, 3);
});

test('llmRerank: single LLM call for small batches (default 20)', async () => {
  const llm = makeLLM([{ index: 0, score: 5 }]);
  const rerank = llmRerank({ llm });
  await rerank([H('a', 't')], 'q');
  assert.equal(llm.calls.length, 1);
});

test('llmRerank: passes model + maxTokens overrides through to the LLM call', async () => {
  const llm = makeLLM([{ index: 0, score: 5 }]);
  const rerank = llmRerank({ llm, model: 'claude-haiku-4-5', maxTokens: 128 });
  await rerank([H('a', 't')], 'q');
  assert.equal(llm.calls[0].model, 'claude-haiku-4-5');
  assert.equal(llm.calls[0].maxTokens, 128);
});

test('llmRerank: emits a JSON-schema format on the request (structured output)', async () => {
  const llm = makeLLM([{ index: 0, score: 5 }]);
  const rerank = llmRerank({ llm });
  await rerank([H('a', 't')], 'q');
  const schema = llm.calls[0].format;
  assert.equal(schema.type, 'object');
  assert.equal(schema.properties.scores.type, 'array');
  assert.equal(schema.properties.scores.items.required.includes('score'), true);
});

// ---- batching ----------------------------------------------------------

test('llmRerank: batches into multiple LLM calls when hits > batchSize', async () => {
  // Scripts a different response per batch, using the batch index
  const llm = makeLLM((callIdx) => {
    // batch 0: indices 0,1 → scores 10, 5
    // batch 1: indices 0,1 → scores 8, 2   (translated to 2, 3 globally)
    if (callIdx === 0) return [{ index: 0, score: 10 }, { index: 1, score: 5 }];
    return [{ index: 0, score: 8 }, { index: 1, score: 2 }];
  });
  const rerank = llmRerank({ llm, batchSize: 2 });
  const hits = [H('a', 't1'), H('b', 't2'), H('c', 't3'), H('d', 't4')];
  const out = await rerank(hits, 'q');
  assert.equal(llm.calls.length, 2);
  // Expected order: a(10), c(8), b(5), d(2)
  assert.deepEqual(out.map(h => h.id), ['a', 'c', 'b', 'd']);
});

test('llmRerank: DEFAULT_BATCH_SIZE is exported and equals 20', () => {
  assert.equal(DEFAULT_BATCH_SIZE, 20);
});

// ---- robustness --------------------------------------------------------

test('llmRerank: missing indices default to neutral score 5; original order preserved among them', async () => {
  const llm = makeLLM([
    { index: 0, score: 10 },
    // index 1 not scored
    { index: 2, score: 1 },
  ]);
  const rerank = llmRerank({ llm });
  const hits = [H('a', 't1'), H('b', 't2'), H('c', 't3')];
  const out = await rerank(hits, 'q');
  // a (10) > b (5, default) > c (1)
  assert.deepEqual(out.map(h => h.id), ['a', 'b', 'c']);
  assert.equal(out[0].rerankScore, 10);
  assert.equal(out[1].rerankScore, 5);
  assert.equal(out[2].rerankScore, 1);
});

test('llmRerank: LLM throw → falls back to original order (all neutral)', async () => {
  const llm = makeLLM(null); // triggers throw in the stub
  const rerank = llmRerank({ llm });
  const hits = [H('a', 't1'), H('b', 't2')];
  const out = await rerank(hits, 'q');
  assert.deepEqual(out.map(h => h.id), ['a', 'b']);
  assert.equal(out[0].rerankScore, 5);
  assert.equal(out[1].rerankScore, 5);
});

test('llmRerank: malformed JSON from a plain-string reply → original order', async () => {
  const llm = makeLLM('not json — the model went off script');
  const rerank = llmRerank({ llm });
  const hits = [H('a', 't1'), H('b', 't2')];
  const out = await rerank(hits, 'q');
  assert.deepEqual(out.map(h => h.id), ['a', 'b']);
});

test('llmRerank: valid JSON in a plain-string reply is parsed', async () => {
  const llm = makeLLM('prose... {"scores":[{"index":0,"score":3},{"index":1,"score":9}]} trailing...');
  const rerank = llmRerank({ llm });
  const hits = [H('a', 't1'), H('b', 't2')];
  const out = await rerank(hits, 'q');
  assert.deepEqual(out.map(h => h.id), ['b', 'a']);
});

test('llmRerank: scores are clamped to [0, 10]', async () => {
  const llm = makeLLM([
    { index: 0, score: 99 },   // clamps to 10
    { index: 1, score: -5 },   // clamps to 0
  ]);
  const rerank = llmRerank({ llm });
  const hits = [H('a', 't1'), H('b', 't2')];
  const out = await rerank(hits, 'q');
  assert.equal(out[0].rerankScore, 10);
  assert.equal(out[1].rerankScore, 0);
});

test('llmRerank: empty hits array → returns empty array without calling LLM', async () => {
  const llm = makeLLM([]);
  const rerank = llmRerank({ llm });
  const out = await rerank([], 'q');
  assert.deepEqual(out, []);
  assert.equal(llm.calls.length, 0);
});

test('llmRerank: empty query returns hits unchanged without calling LLM', async () => {
  const llm = makeLLM([]);
  const rerank = llmRerank({ llm });
  const hits = [H('a', 't1')];
  const out = await rerank(hits, '');
  assert.deepEqual(out, hits);
  assert.equal(llm.calls.length, 0);
});

// ---- prompt shape ------------------------------------------------------

test('llmRerank: default user prompt lists the passages with their indices', async () => {
  const llm = makeLLM([{ index: 0, score: 5 }]);
  const rerank = llmRerank({ llm });
  await rerank([H('a', 'the quick brown fox'), H('b', 'jumped over')], 'anything');
  const userMsg = llm.calls[0].messages[0].content;
  assert.match(userMsg, /Query: anything/);
  assert.match(userMsg, /0: the quick brown fox/);
  assert.match(userMsg, /1: jumped over/);
});

test('llmRerank: custom systemInstructions replace the default', async () => {
  const llm = makeLLM([{ index: 0, score: 5 }]);
  const rerank = llmRerank({ llm, systemInstructions: 'Score in French, très strict.' });
  await rerank([H('a', 't')], 'q');
  assert.equal(llm.calls[0].system, 'Score in French, très strict.');
});

test('llmRerank: custom buildUserPrompt is called with { query, hits, startIndex }', async () => {
  const llm = makeLLM([{ index: 0, score: 5 }]);
  const seen = [];
  const builder = ({ query, hits, startIndex }) => {
    seen.push({ query, hitCount: hits.length, startIndex });
    return `custom prompt: ${query}`;
  };
  const rerank = llmRerank({ llm, buildUserPrompt: builder, batchSize: 2 });
  await rerank([H('a', 't1'), H('b', 't2')], 'q');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].query, 'q');
  assert.equal(seen[0].hitCount, 2);
  assert.equal(seen[0].startIndex, 0);
  assert.equal(llm.calls[0].messages[0].content, 'custom prompt: q');
});

// ---- integration with RAG -----------------------------------------------

test('RAG: llmRerank plugs into RAG.rerank and produces a re-sorted answer path', async () => {
  // Cheap chatty LLM used both for the answer AND for reranking.
  let callIdx = 0;
  const llm = {
    async chat(req) {
      callIdx++;
      // First call = rerank scoring; second call = the answer.
      if (req.format?.properties?.scores) {
        return { data: { scores: [{ index: 0, score: 2 }, { index: 1, score: 9 }, { index: 2, score: 5 }] } };
      }
      return { content: [{ type: 'text', text: 'answer using [b] and [c]' }] };
    },
  };
  const store = {
    async search() { return [H('a', 't1'), H('b', 't2'), H('c', 't3')]; },
  };
  const rag = new RAG({ llm, store, rerank: llmRerank({ llm }) });
  const { answer, hits } = await rag.answer({ query: 'anything', topK: 3 });
  assert.deepEqual(hits.map(h => h.id), ['b', 'c', 'a']);
  assert.equal(answer, 'answer using [b] and [c]');
});
