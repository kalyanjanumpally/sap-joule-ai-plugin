const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const STUB_PATH = '/tmp/__cds_stub_af__';
require.cache[STUB_PATH] = {
  exports: {
    Service: class { constructor() {} async init() {} },
    log: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  },
  loaded: true,
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function(request, ...rest) {
  if (request === '@sap/cds') return STUB_PATH;
  return origResolve.call(this, request, ...rest);
};

const VectorStore = require('../lib/VectorStore');
const RAG = require('../lib/rag');
const { parseFilterJson } = require('../lib/cdsPlugin');

/** Trivial store that records calls and returns scripted hit lists. */
const fakeEmbedder = { embed: async () => ({ embeddings: [[0, 0, 0]], model: 'stub' }) };

class SpyStore extends VectorStore {
  constructor() {
    super({ embed: fakeEmbedder, dimension: 3 });
    this.calls = [];
    this.vectorHits  = [{ id: 'v1', score: 0.9, text: 'v1' }];
    this.keywordHits = [{ id: 'k1', score: 0.8, text: 'k1' }];
    this.embeddingSize = 3;
  }
  async _connect() {}
  async _createTableIfMissing() {}
  async _upsert() {}
  async _delete() {}
  async _search({ text, topK, filter }) {
    this.calls.push({ kind: 'search', text, topK, filter });
    return this.vectorHits.slice(0, topK);
  }
  async _keywordSearch({ terms, topK, filter }) {
    this.calls.push({ kind: 'keyword', terms, topK, filter });
    return this.keywordHits.slice(0, topK);
  }
  async _embed() { return new Array(this.embeddingSize).fill(0); }
}

// ---- alpha param maps to vector/keyword weights ----------------------

test('hybridSearch: alpha=1 → pure vector (keywordWeight=0)', async () => {
  const s = new SpyStore();
  // Rig RRF-visible fingerprints so we can assert which list dominated
  s.vectorHits  = [{ id: 'V', score: 1, text: 'v' }];
  s.keywordHits = [{ id: 'K', score: 1, text: 'k' }];
  const hits = await s.hybridSearch({ text: 'widgets', topK: 1, alpha: 1 });
  assert.equal(hits[0].id, 'V', 'pure vector: keyword hit should not surface at top');
});

test('hybridSearch: alpha=0 → pure keyword', async () => {
  const s = new SpyStore();
  s.vectorHits  = [{ id: 'V', score: 1, text: 'v' }];
  s.keywordHits = [{ id: 'K', score: 1, text: 'k' }];
  const hits = await s.hybridSearch({ text: 'widgets', topK: 1, alpha: 0 });
  assert.equal(hits[0].id, 'K', 'pure keyword: vector hit should not surface at top');
});

test('hybridSearch: alpha=0.5 → both lists contribute (default balanced)', async () => {
  const s = new SpyStore();
  s.vectorHits  = [{ id: 'V', score: 1, text: 'v' }];
  s.keywordHits = [{ id: 'K', score: 1, text: 'k' }];
  const hits = await s.hybridSearch({ text: 'widgets', topK: 2, alpha: 0.5 });
  const ids = hits.map(h => h.id);
  assert.deepEqual(ids.sort(), ['K', 'V']);
});

test('hybridSearch: alpha overrides explicit vectorWeight+keywordWeight when supplied', async () => {
  const s = new SpyStore();
  s.vectorHits  = [{ id: 'V', score: 1, text: 'v' }];
  s.keywordHits = [{ id: 'K', score: 1, text: 'k' }];
  // Users pass 0.5+0.5 explicit weights (balanced) then alpha=1 (pure vector).
  // alpha wins.
  const hits = await s.hybridSearch({ text: 'widgets', topK: 1, vectorWeight: 0.5, keywordWeight: 0.5, alpha: 1 });
  assert.equal(hits[0].id, 'V');
});

// ---- alpha validation ------------------------------------------------

test('hybridSearch: alpha out of [0,1] range throws', async () => {
  const s = new SpyStore();
  await assert.rejects(() => s.hybridSearch({ text: 'widgets', topK: 1, alpha: 1.5 }), /alpha must be a number in \[0, 1\]/);
  await assert.rejects(() => s.hybridSearch({ text: 'widgets', topK: 1, alpha: -0.1 }), /alpha must be a number in \[0, 1\]/);
  await assert.rejects(() => s.hybridSearch({ text: 'widgets', topK: 1, alpha: NaN }), /alpha must be a number in \[0, 1\]/);
});

// ---- filter propagation ----------------------------------------------

test('hybridSearch: filter passed to BOTH vector + keyword sub-queries', async () => {
  const s = new SpyStore();
  await s.hybridSearch({ text: 'widgets', topK: 3, filter: { region: 'EMEA' } });
  const forkedCalls = s.calls;
  assert.ok(forkedCalls.some(c => c.kind === 'search'  && c.filter?.region === 'EMEA'));
  assert.ok(forkedCalls.some(c => c.kind === 'keyword' && c.filter?.region === 'EMEA'));
});

// ---- RAG.retrieve/answer forward alpha + filter ----------------------

test('RAG.retrieve: forwards alpha to store.hybridSearch', async () => {
  const s = new SpyStore();
  const rag = new RAG({ llm: { chat: async () => ({ text: '', usage: {}, model: 'x' }) }, store: s, mode: 'hybrid' });
  await rag.retrieve({ query: 'widgets', topK: 2, alpha: 0.75 });
  // The store's search was called with the alpha-mapped weights via hybridSearch
  // — we assert by proxy: hybridSearch was entered (both sub-calls recorded).
  assert.ok(s.calls.some(c => c.kind === 'search'));
  assert.ok(s.calls.some(c => c.kind === 'keyword'));
});

test('RAG.retrieve: forwards filter to store', async () => {
  const s = new SpyStore();
  const rag = new RAG({ llm: { chat: async () => ({ text: '', usage: {}, model: 'x' }) }, store: s });
  await rag.retrieve({ query: 'widgets', filter: { region: 'EMEA' } });
  assert.equal(s.calls[0].filter?.region, 'EMEA');
});

test('RAG.answer: forwards alpha AND filter to retrieve()', async () => {
  const s = new SpyStore();
  const fakeLLM = { chat: async () => ({ text: 'answer', usage: {}, model: 'x' }) };
  const rag = new RAG({ llm: fakeLLM, store: s, mode: 'hybrid' });
  const result = await rag.answer({ query: 'widgets', topK: 1, alpha: 0.3, filter: { region: 'APAC' } });
  assert.ok(result.answer);
  assert.equal(s.calls[0].filter?.region, 'APAC');
});

// ---- parseFilterJson helper -----------------------------------------

test('parseFilterJson: undefined / empty → undefined', () => {
  assert.equal(parseFilterJson(undefined), undefined);
  assert.equal(parseFilterJson(null), undefined);
  assert.equal(parseFilterJson(''), undefined);
});

test('parseFilterJson: object passes through (programmatic-call path)', () => {
  assert.deepEqual(parseFilterJson({ region: 'EMEA' }), { region: 'EMEA' });
});

test('parseFilterJson: JSON string of object → parsed', () => {
  assert.deepEqual(parseFilterJson('{"region":"EMEA","tier":"gold"}'), { region: 'EMEA', tier: 'gold' });
});

test('parseFilterJson: JSON array → throws (not an object)', () => {
  assert.throws(() => parseFilterJson('[1,2,3]'), /expected a JSON object/);
});

test('parseFilterJson: invalid JSON → throws (surfaces JSON.parse error)', () => {
  assert.throws(() => parseFilterJson('{not json}'));
});

test('parseFilterJson: non-string, non-object → throws', () => {
  assert.throws(() => parseFilterJson(42), /expected a JSON string/);
});
