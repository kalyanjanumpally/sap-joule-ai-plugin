const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createQueryExpander } = require('../lib/queryExpander');
const RAG = require('../lib/rag');

// ---- test double ------------------------------------------------------

function makeLLM(reply) {
  const calls = [];
  return {
    calls,
    async chat(req) {
      calls.push(req);
      const r = typeof reply === 'function' ? reply(calls.length - 1) : reply;
      if (r === '__throw__') throw new Error('boom');
      if (typeof r === 'string') return { text: r };
      return r;
    },
  };
}

const H = (id, text) => ({ id, text, metadata: null, score: 0 });

// ---- constructor ------------------------------------------------------

test('createQueryExpander: requires llm with chat()', () => {
  assert.throws(() => createQueryExpander({}), /llm/);
  assert.throws(() => createQueryExpander({ llm: {} }), /chat/);
});

test('createQueryExpander: rejects unknown strategy', () => {
  const llm = makeLLM('x');
  assert.throws(() => createQueryExpander({ llm, strategy: 'bogus' }), /strategy/);
});

test('createQueryExpander: rejects invalid n', () => {
  const llm = makeLLM('x');
  assert.throws(() => createQueryExpander({ llm, strategy: 'multi-query', n: 0 }), /n/);
  assert.throws(() => createQueryExpander({ llm, strategy: 'multi-query', n: -3 }), /n/);
  assert.throws(() => createQueryExpander({ llm, strategy: 'multi-query', n: 1.5 }), /n/);
});

// ---- HyDE strategy ----------------------------------------------------

test('HyDE: default strategy returns [query, hypothetical_answer]', async () => {
  const hypothetical = 'The refund window is 30 days from purchase, with a receipt.';
  const llm = makeLLM(hypothetical);
  const expand = createQueryExpander({ llm });
  const out = await expand('what is the refund policy?');
  assert.deepEqual(out, ['what is the refund policy?', hypothetical]);
});

test('HyDE: LLM error → falls back to [original query]', async () => {
  const llm = makeLLM('__throw__');
  const expand = createQueryExpander({ llm, strategy: 'hyde' });
  const out = await expand('anything');
  assert.deepEqual(out, ['anything']);
});

test('HyDE: empty/whitespace reply → falls back to [original query]', async () => {
  const llm = makeLLM('   ');
  const expand = createQueryExpander({ llm, strategy: 'hyde' });
  const out = await expand('anything');
  assert.deepEqual(out, ['anything']);
});

test('HyDE: uses the shipped HyDE system prompt', async () => {
  const llm = makeLLM('hypothetical passage');
  const expand = createQueryExpander({ llm });
  await expand('q');
  assert.match(llm.calls[0].system, /plausible short passages/i);
});

// ---- multi-query strategy ---------------------------------------------

test('multi-query: parses N paraphrases into [query, ...N]', async () => {
  const llm = makeLLM(`How long can I return an item?
What is the return window duration?
Refund period policy details`);
  const expand = createQueryExpander({ llm, strategy: 'multi-query', n: 3 });
  const out = await expand('refund policy?');
  assert.deepEqual(out, [
    'refund policy?',
    'How long can I return an item?',
    'What is the return window duration?',
    'Refund period policy details',
  ]);
});

test('multi-query: strips bullets / numbers / dashes from lines', async () => {
  const llm = makeLLM(`1. First variant
2) Second variant
- Third variant
* Fourth variant`);
  const expand = createQueryExpander({ llm, strategy: 'multi-query', n: 4 });
  const out = await expand('q');
  assert.deepEqual(out.slice(1), ['First variant', 'Second variant', 'Third variant', 'Fourth variant']);
});

test('multi-query: caps output at N even if LLM returns more', async () => {
  const llm = makeLLM('a\nb\nc\nd\ne\nf');
  const expand = createQueryExpander({ llm, strategy: 'multi-query', n: 2 });
  const out = await expand('q');
  assert.equal(out.length, 3); // original + 2
  assert.deepEqual(out.slice(1), ['a', 'b']);
});

test('multi-query: LLM error → falls back to [original query]', async () => {
  const llm = makeLLM('__throw__');
  const expand = createQueryExpander({ llm, strategy: 'multi-query' });
  const out = await expand('anything');
  assert.deepEqual(out, ['anything']);
});

// ---- customization ----------------------------------------------------

test('createQueryExpander: model + maxTokens overrides passed through', async () => {
  const llm = makeLLM('x');
  const expand = createQueryExpander({ llm, model: 'claude-haiku-4-5', maxTokens: 50 });
  await expand('q');
  assert.equal(llm.calls[0].model, 'claude-haiku-4-5');
  assert.equal(llm.calls[0].maxTokens, 50);
});

test('createQueryExpander: custom systemInstructions replace the default', async () => {
  const llm = makeLLM('x');
  const expand = createQueryExpander({ llm, systemInstructions: 'Respond in French only.' });
  await expand('q');
  assert.equal(llm.calls[0].system, 'Respond in French only.');
});

test('createQueryExpander: custom buildUserPrompt receives { query, n }', async () => {
  const llm = makeLLM('x');
  const seen = [];
  const builder = ({ query, n }) => { seen.push({ query, n }); return `custom: ${query}`; };
  const expand = createQueryExpander({ llm, strategy: 'multi-query', n: 5, buildUserPrompt: builder });
  await expand('the question');
  assert.deepEqual(seen, [{ query: 'the question', n: 5 }]);
  assert.equal(llm.calls[0].messages[0].content, 'custom: the question');
});

// ---- RAG integration --------------------------------------------------

test('RAG: expand is called once per retrieve; results fused across queries', async () => {
  const expandCalls = [];
  const searchCalls = [];
  const expand = async (q) => {
    expandCalls.push(q);
    return ['q1', 'q2', 'q3'];
  };
  const store = {
    async search({ text }) {
      searchCalls.push(text);
      // Different top hits per query — d1 leads on q1, d2 on q2, d3 on q3
      const perQuery = {
        q1: [H('d1', 't1'), H('d2', 't2')],
        q2: [H('d2', 't2'), H('d3', 't3')],
        q3: [H('d3', 't3'), H('d4', 't4')],
      };
      return perQuery[text] ?? [];
    },
  };
  const llm = { async chat() { return { text: 'ok' }; } };
  const rag = new RAG({ llm, store, expand });
  const hits = await rag.retrieve({ query: 'original', topK: 3 });
  assert.equal(expandCalls.length, 1);
  assert.equal(expandCalls[0], 'original');
  // 3 searches, one per expanded query
  assert.equal(searchCalls.length, 3);
  // d2 appears in TWO lists (q1 + q2) so RRF should rank it #1
  assert.equal(hits[0].id, 'd2');
});

test('RAG: expand=null (default) → single query, direct search', async () => {
  const searchCalls = [];
  const store = {
    async search({ text }) { searchCalls.push(text); return [H('a', 't1'), H('b', 't2')]; },
  };
  const llm = { async chat() { return { text: 'ok' }; } };
  const rag = new RAG({ llm, store });
  const hits = await rag.retrieve({ query: 'original', topK: 2 });
  assert.equal(searchCalls.length, 1);
  assert.equal(searchCalls[0], 'original');
  assert.deepEqual(hits.map(h => h.id), ['a', 'b']);
});

test('RAG: expand + rerank compose — reranker sees the fused list', async () => {
  const expand = async () => ['q1', 'q2'];
  const store = {
    async search({ text }) {
      return text === 'q1'
        ? [H('a', 't1'), H('b', 't2')]
        : [H('b', 't2'), H('c', 't3')];
    },
  };
  const rerank = async (hits) => {
    // Reverse the fused order
    return [...hits].reverse();
  };
  const llm = { async chat() { return { text: 'ok' }; } };
  const rag = new RAG({ llm, store, expand, rerank });
  const hits = await rag.retrieve({ query: 'original', topK: 3 });
  // fused winner (b appears in both) would be first; reversed = last
  assert.equal(hits[hits.length - 1].id, 'b');
});

test('RAG: expander throws → falls back to [original], search still runs', async () => {
  const expand = async () => { throw new Error('boom'); };
  let searchCount = 0;
  const store = {
    async search({ text }) {
      searchCount++;
      assert.equal(text, 'original', 'fallback should search the original query');
      return [H('a', 't1')];
    },
  };
  const llm = { async chat() { return { text: 'ok' }; } };
  const rag = new RAG({ llm, store, expand });
  const hits = await rag.retrieve({ query: 'original', topK: 1 });
  assert.equal(searchCount, 1);
  assert.equal(hits.length, 1);
});

test('RAG: expander returns empty array → falls back to [original]', async () => {
  const expand = async () => [];
  const searchCalls = [];
  const store = {
    async search({ text }) { searchCalls.push(text); return [H('a', 't1')]; },
  };
  const llm = { async chat() { return { text: 'ok' }; } };
  const rag = new RAG({ llm, store, expand });
  await rag.retrieve({ query: 'original', topK: 1 });
  assert.deepEqual(searchCalls, ['original']);
});

test('RAG: constructor rejects non-function expand', () => {
  const store = { search: () => [] };
  const llm = { chat: async () => ({}) };
  assert.throws(() => new RAG({ llm, store, expand: 'not a fn' }), /expand/);
});

// ---- end-to-end story with real Sqlite store (integration) -----------

test('End-to-end: HyDE expander → hybrid → rerank → answer (mocked LLM)', async () => {
  const SqliteVectorStore = require('../lib/backends/sqlite');
  const { llmRerank } = require('../lib/llmRerank');

  // Deterministic 8-dim embedding
  function embed(text) {
    const v = new Array(8).fill(0);
    for (let i = 0; i < text.length; i++) v[i % 8] += text.charCodeAt(i);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return norm === 0 ? v : v.map(x => x / norm);
  }
  const embedder = {
    async embed({ input }) {
      const arr = Array.isArray(input) ? input : [input];
      return { embeddings: arr.map(embed), model: 'fake' };
    },
  };
  const store = new SqliteVectorStore({ embed: embedder, dimension: 8, table: 'e2e', dbPath: ':memory:' });
  await store.init();
  await store.upsertMany([
    { id: 'refund', text: 'Refunds accepted within 30 days.' },
    { id: 'ship',   text: 'Free shipping over 50 EUR.' },
    { id: 'warr',   text: 'Warranty 24 months.' },
  ]);

  // LLM handles three different call shapes:
  //   1. expand — HyDE prompt → returns a hypothetical passage
  //   2. rerank — structured-output prompt → returns scores
  //   3. answer — normal chat → returns text
  const llm = {
    async chat(req) {
      const isRerank = req.format?.properties?.scores;
      const isExpand = /plausible short passages/i.test(req.system ?? '');
      if (isRerank) {
        return { data: { scores: [
          { index: 0, score: 9 },
          { index: 1, score: 2 },
          { index: 2, score: 4 },
        ] } };
      }
      if (isExpand) return { text: 'You can return items within thirty days for a full refund.' };
      return { content: [{ type: 'text', text: 'answer with sources' }] };
    },
  };

  const rag = new RAG({
    llm, store,
    expand: createQueryExpander({ llm }),
    rerank: llmRerank({ llm }),
  });
  const { answer, hits } = await rag.answer({ query: 'refund window?', topK: 3 });
  assert.equal(answer, 'answer with sources');
  assert.equal(hits.length, 3);
  // rerank scores put index-0-in-list (whatever it is) at position 0
  assert.ok(hits[0].rerankScore >= hits[1].rerankScore);
});
