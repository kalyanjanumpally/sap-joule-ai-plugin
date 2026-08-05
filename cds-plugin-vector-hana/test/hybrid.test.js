const { test } = require('node:test');
const assert = require('node:assert/strict');
const SqliteVectorStore = require('../lib/backends/sqlite');
const VectorStore = require('../lib/VectorStore');
const { tokenize } = require('../lib/VectorStore');
const RAG = require('../lib/rag');

// Deterministic tiny embedding — same shape as sqlite.test.js.
function fakeEmbed(text) {
  const vec = new Array(8).fill(0);
  for (let i = 0; i < text.length; i++) vec[i % 8] += text.charCodeAt(i);
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return norm === 0 ? vec : vec.map(v => v / norm);
}
const fakeEmbedder = {
  async embed({ input }) {
    const inputs = Array.isArray(input) ? input : [input];
    return { embeddings: inputs.map(fakeEmbed), model: 'fake' };
  },
};

async function makeStore(rows = []) {
  const store = new SqliteVectorStore({
    embed: fakeEmbedder, dimension: 8, table: 'kw_test', dbPath: ':memory:',
  });
  await store.init();
  if (rows.length) await store.upsertMany(rows);
  return store;
}

// ---- tokenize ----------------------------------------------------------

test('tokenize: lowercases + splits on non-word chars', () => {
  assert.deepEqual(tokenize('Steel coils, 24k tonnes/yr'), ['steel', 'coils', '24k', 'tonnes', 'yr']);
});

test('tokenize: drops 1-char tokens and empties', () => {
  assert.deepEqual(tokenize('a bb   ccc'), ['bb', 'ccc']);
});

test('tokenize: preserves SKUs and order numbers', () => {
  assert.deepEqual(tokenize('PO-4500000123 sup-42 acme'),
    ['po-4500000123', 'sup-42', 'acme']);
});

// ---- SqliteVectorStore._keywordSearch ---------------------------------

test('keywordSearch: ranks docs by number of matching query tokens', async () => {
  const store = await makeStore([
    { id: 'd1', text: 'Steel coils rolled hot' },
    { id: 'd2', text: 'Steel bars only' },
    { id: 'd3', text: 'Aluminum bars' },
    { id: 'd4', text: 'Something else entirely' },
  ]);
  try {
    const hits = await store.keywordSearch({ text: 'steel coils', topK: 10 });
    const ids = hits.map(h => h.id);
    // d1 hits both 'steel' + 'coils' (score 2), d2 hits 'steel' only (score 1),
    // d3 and d4 do not match any query token → excluded.
    assert.deepEqual(ids, ['d1', 'd2']);
    assert.equal(hits[0].score, 2);
    assert.equal(hits[1].score, 1);
  } finally { await store.close(); }
});

test('keywordSearch: honors topK cap', async () => {
  const store = await makeStore([
    { id: 'd1', text: 'alpha' }, { id: 'd2', text: 'alpha' },
    { id: 'd3', text: 'alpha' }, { id: 'd4', text: 'alpha' },
  ]);
  try {
    const hits = await store.keywordSearch({ text: 'alpha', topK: 2 });
    assert.equal(hits.length, 2);
  } finally { await store.close(); }
});

test('keywordSearch: applies metadata filter', async () => {
  const store = await makeStore([
    { id: 'a', text: 'aluminum bars',    metadata: { region: 'EMEA' } },
    { id: 'b', text: 'aluminum sheets',  metadata: { region: 'APAC' } },
    { id: 'c', text: 'aluminum coils',   metadata: { region: 'EMEA' } },
  ]);
  try {
    const hits = await store.keywordSearch({
      text: 'aluminum', topK: 10, filter: { region: 'EMEA' },
    });
    const ids = hits.map(h => h.id).sort();
    assert.deepEqual(ids, ['a', 'c']);
  } finally { await store.close(); }
});

test('keywordSearch: exact-match SKU / order number style queries', async () => {
  const store = await makeStore([
    { id: 'r1', text: 'Framework agreement, contact acme-42 for details' },
    { id: 'r2', text: 'Nothing about acme-99 here' },
    { id: 'r3', text: 'Different vendor entirely' },
  ]);
  try {
    const hits = await store.keywordSearch({ text: 'acme-42', topK: 10 });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, 'r1');
  } finally { await store.close(); }
});

test('keywordSearch: rejects invalid inputs', async () => {
  const store = await makeStore();
  try {
    await assert.rejects(store.keywordSearch({}), /non-empty string/);
    await assert.rejects(store.keywordSearch({ text: '' }), /non-empty string/);
    await assert.rejects(store.keywordSearch({ text: 'x', topK: 0 }), /topK >= 1/);
  } finally { await store.close(); }
});

test('keywordSearch: returns [] when all query tokens are too short', async () => {
  const store = await makeStore([{ id: 'a', text: 'anything' }]);
  try {
    const hits = await store.keywordSearch({ text: 'a b c', topK: 5 });
    assert.deepEqual(hits, []);
  } finally { await store.close(); }
});

// ---- hybridSearch ------------------------------------------------------

test('hybridSearch: combines vector + keyword via RRF', async () => {
  const store = await makeStore([
    { id: 'd1', text: 'Steel coils' },
    { id: 'd2', text: 'Aluminum sheets' },
    { id: 'd3', text: 'Copper wire' },
  ]);
  try {
    const hits = await store.hybridSearch({ text: 'steel coils', topK: 3 });
    // d1 wins both searches, so it should be #1
    assert.equal(hits[0].id, 'd1');
    // Every returned hit has a fusionScore
    for (const h of hits) assert.ok(typeof h.fusionScore === 'number');
  } finally { await store.close(); }
});

test('hybridSearch: candidateK controls per-list fetch size', async () => {
  const store = await makeStore([
    { id: 'a', text: 'alpha token' }, { id: 'b', text: 'alpha token beta' },
    { id: 'c', text: 'alpha token gamma' }, { id: 'd', text: 'alpha token delta' },
  ]);
  try {
    const wide = await store.hybridSearch({ text: 'alpha', topK: 2, candidateK: 4 });
    assert.ok(wide.length <= 2);
    assert.ok(wide.length > 0);
  } finally { await store.close(); }
});

test('hybridSearch: weights lean toward vector or keyword', async () => {
  const store = await makeStore([
    { id: 'd1', text: 'exact literal PO-4500000123 match' },
    { id: 'd2', text: 'roughly related purchase order text' },
    { id: 'd3', text: 'unrelated content' },
  ]);
  try {
    // Heavy keyword weight — exact literal should win
    const kw = await store.hybridSearch({
      text: 'PO-4500000123', topK: 2, vectorWeight: 0.1, keywordWeight: 1.0,
    });
    assert.equal(kw[0].id, 'd1');
  } finally { await store.close(); }
});

test('hybridSearch: falls back gracefully when the store has no keyword impl', async () => {
  // Override the instance's _keywordSearch to the base-class default so
  // hybridSearch's built-in fallback path fires (returns [] for keyword,
  // vector still contributes). Prototype chain untouched so close() and
  // other SQLite specifics still work.
  const store = await makeStore([
    { id: 'a', text: 'alpha' }, { id: 'b', text: 'beta' },
  ]);
  try {
    store._keywordSearch = VectorStore.prototype._keywordSearch;
    const hits = await store.hybridSearch({ text: 'alpha', topK: 5 });
    assert.ok(hits.length >= 1);
  } finally {
    await store.close();
  }
});

test('hybridSearch: rejects invalid inputs', async () => {
  const store = await makeStore();
  try {
    await assert.rejects(store.hybridSearch({}), /non-empty string/);
    await assert.rejects(store.hybridSearch({ text: 'x', topK: 0 }), /topK >= 1/);
  } finally { await store.close(); }
});

// ---- RAG hybrid mode + rerank ------------------------------------------

const fakeLLM = {
  async chat({ messages }) { return { content: [{ type: 'text', text: 'answer text' }] }; },
};

test('RAG: mode="hybrid" routes retrieve through hybridSearch', async () => {
  const seen = [];
  const wrapped = {
    search: async (p) => { seen.push({ kind: 'search', ...p }); return []; },
    hybridSearch: async (p) => { seen.push({ kind: 'hybrid', ...p }); return [{ id: 'x' }]; },
  };
  const rag = new RAG({ llm: fakeLLM, store: wrapped, mode: 'hybrid' });
  const hits = await rag.retrieve({ query: 'q', topK: 3 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, 'hybrid');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'x');
});

test('RAG: per-call mode overrides constructor mode', async () => {
  const seen = [];
  const store = {
    search: async () => { seen.push('search'); return []; },
    hybridSearch: async () => { seen.push('hybrid'); return []; },
  };
  const rag = new RAG({ llm: fakeLLM, store, mode: 'vector' });
  await rag.retrieve({ query: 'q', topK: 3, mode: 'hybrid' });
  assert.deepEqual(seen, ['hybrid']);
});

test('RAG: mode="hybrid" against a store without hybridSearch throws a helpful error', async () => {
  const store = { search: async () => [] };
  const rag = new RAG({ llm: fakeLLM, store, mode: 'hybrid' });
  await assert.rejects(
    () => rag.retrieve({ query: 'q' }),
    /hybridSearch/,
  );
});

test('RAG: rerank hook receives (hits, query) and its output is used', async () => {
  const store = { search: async () => [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
  const reranker = async (hits, query) => {
    // Reverse order
    return hits.slice().reverse();
  };
  const rag = new RAG({ llm: fakeLLM, store, rerank: reranker });
  const hits = await rag.retrieve({ query: 'anything', topK: 3 });
  assert.deepEqual(hits.map(h => h.id), ['c', 'b', 'a']);
});

test('RAG: rerank output over topK is trimmed', async () => {
  const store = { search: async () => [{ id: 'a' }, { id: 'b' }] };
  const reranker = async () => [{ id: 'x' }, { id: 'y' }, { id: 'z' }];
  const rag = new RAG({ llm: fakeLLM, store, rerank: reranker });
  const hits = await rag.retrieve({ query: 'anything', topK: 2 });
  assert.deepEqual(hits.map(h => h.id), ['x', 'y']);
});

test('RAG: constructor rejects invalid mode / rerank', () => {
  const store = { search: () => [] };
  assert.throws(() => new RAG({ llm: fakeLLM, store, mode: 'wat' }), /mode/);
  assert.throws(() => new RAG({ llm: fakeLLM, store, rerank: 'not a fn' }), /rerank/);
});
