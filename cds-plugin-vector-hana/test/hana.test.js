const { test } = require('node:test');
const assert = require('node:assert/strict');

// Stub `hdb` before requiring the HANA backend
const Module = require('module');
const STUB_PATH = '/tmp/__hdb_stub__';

const state = { executed: [] };
require.cache[STUB_PATH] = {
  exports: {
    createClient: () => ({
      connect: (cb) => cb(null),
      prepare: (sql, cb) => {
        cb(null, {
          exec: (params, cb2) => {
            state.executed.push({ sql, params });
            // Return canned rows for SELECT COUNT queries (table-exists check)
            if (/COUNT\(\*\)/i.test(sql)) return cb2(null, [{ N: 0 }]);
            // Canned rows for SELECT similarity
            if (/COSINE_SIMILARITY/i.test(sql)) {
              return cb2(null, [
                { id: 'a', text: 'hello world', metadata: null, score: 0.95 },
                { id: 'b', text: 'goodbye',     metadata: '{"tag":"x"}', score: 0.42 },
              ]);
            }
            cb2(null, []);
          },
        });
      },
      end: (cb) => cb && cb(),
    }),
  },
  loaded: true,
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function(request, ...rest) {
  if (request === 'hdb') return STUB_PATH;
  return origResolve.call(this, request, ...rest);
};

const HanaVectorStore = require('../lib/backends/hana');

const fakeEmbedder = {
  async embed({ input }) {
    const inputs = Array.isArray(input) ? input : [input];
    return { embeddings: inputs.map(() => [0.1, 0.2, 0.3, 0.4]), model: 'x' };
  },
};

function makeStore() {
  return new HanaVectorStore({
    embed: fakeEmbedder,
    dimension: 4,
    table: 'CONTRACTS',
    connection: { host: 'x', port: 443, user: 'u', password: 'p' },
  });
}

test('HanaVectorStore: init creates a column table with REAL_VECTOR(dim)', async () => {
  state.executed = [];
  const store = makeStore();
  await store.init();
  const create = state.executed.find(x => /CREATE COLUMN TABLE/i.test(x.sql));
  assert.ok(create, 'CREATE TABLE was not issued');
  assert.match(create.sql, /"CONTRACTS"/);
  assert.match(create.sql, /REAL_VECTOR\(4\)/);
  assert.match(create.sql, /NVARCHAR\(256\) PRIMARY KEY/);
  assert.match(create.sql, /NCLOB/);
});

test('HanaVectorStore: upsert uses MERGE INTO with TO_REAL_VECTOR', async () => {
  state.executed = [];
  const store = makeStore();
  await store.init();
  await store.upsert({ id: 'a', text: 'hello', metadata: { k: 'v' } });
  const merge = state.executed.find(x => /MERGE INTO/i.test(x.sql));
  assert.ok(merge, 'MERGE was not issued');
  assert.match(merge.sql, /TO_REAL_VECTOR\(\?\)/);
  assert.match(merge.sql, /WHEN MATCHED THEN UPDATE/);
  assert.match(merge.sql, /WHEN NOT MATCHED THEN INSERT/);
  // Params: id, text, vector-as-json, metadata-as-json
  assert.equal(merge.params[0], 'a');
  assert.equal(merge.params[1], 'hello');
  assert.equal(merge.params[2], JSON.stringify([0.1, 0.2, 0.3, 0.4]));
  assert.equal(merge.params[3], '{"k":"v"}');
});

test('HanaVectorStore: search uses COSINE_SIMILARITY + TOP N + ORDER BY DESC', async () => {
  state.executed = [];
  const store = makeStore();
  await store.init();
  const hits = await store.search({ text: 'query', topK: 5 });
  const sel = state.executed.find(x => /COSINE_SIMILARITY/i.test(x.sql));
  assert.ok(sel);
  assert.match(sel.sql, /TOP 5/);
  assert.match(sel.sql, /COSINE_SIMILARITY\("embedding", TO_REAL_VECTOR\(\?\)\)/);
  assert.match(sel.sql, /ORDER BY "score" DESC/);
  // Verify result shape
  assert.equal(hits.length, 2);
  assert.equal(hits[0].id, 'a');
  assert.equal(hits[0].score, 0.95);
  assert.equal(hits[1].metadata.tag, 'x');
});

test('HanaVectorStore: filter adds JSON_VALUE clauses', async () => {
  state.executed = [];
  const store = makeStore();
  await store.init();
  await store.search({ text: 'q', topK: 3, filter: { region: 'EMEA', priority: '1' } });
  const sel = state.executed.find(x => /COSINE_SIMILARITY/i.test(x.sql));
  assert.match(sel.sql, /JSON_VALUE\("metadata", '\$.region'\) = \?/);
  assert.match(sel.sql, /JSON_VALUE\("metadata", '\$.priority'\) = \?/);
  // Params order: vector JSON first, then filter values in insertion order
  assert.equal(sel.params[0], JSON.stringify([0.1, 0.2, 0.3, 0.4]));
  assert.equal(sel.params[1], 'EMEA');
  assert.equal(sel.params[2], '1');
});

test('HanaVectorStore: delete issues DELETE WHERE id = ?', async () => {
  state.executed = [];
  const store = makeStore();
  await store.init();
  await store.delete({ id: 'zzz' });
  const del = state.executed.find(x => /^\s*DELETE FROM/i.test(x.sql));
  assert.ok(del);
  assert.match(del.sql, /WHERE "id" = \?/);
  assert.equal(del.params[0], 'zzz');
});

test('HanaVectorStore.upsertMany: single chunk uses multi-row MERGE with UNION ALL', async () => {
  state.executed = [];
  const store = makeStore();
  await store.init();
  await store.upsertMany([
    { id: 'a', text: 'one', metadata: { i: 1 } },
    { id: 'b', text: 'two', metadata: { i: 2 } },
    { id: 'c', text: 'three' },
  ]);
  const merges = state.executed.filter(x => /MERGE INTO/i.test(x.sql));
  assert.equal(merges.length, 1, 'expected exactly one MERGE for 3 rows within chunk size');
  const sql = merges[0].sql;
  const unionAllCount = (sql.match(/UNION ALL/g) || []).length;
  assert.equal(unionAllCount, 2, 'expected 2 UNION ALL joins for 3 rows');
  assert.equal(merges[0].params.length, 12); // 4 params per row * 3 rows
  assert.equal(merges[0].params[0], 'a');
  assert.equal(merges[0].params[4], 'b');
  assert.equal(merges[0].params[8], 'c');
  assert.equal(merges[0].params[11], null); // c has no metadata
});

test('HanaVectorStore.upsertMany: chunks large batches at upsertChunkSize', async () => {
  state.executed = [];
  const store = new HanaVectorStore({
    embed: fakeEmbedder,
    dimension: 4,
    table: 'BIG',
    upsertChunkSize: 10,
    connection: { host: 'x', port: 443, user: 'u', password: 'p' },
  });
  await store.init();
  const items = Array.from({ length: 25 }, (_, i) => ({ id: `id-${i}`, text: `t-${i}` }));
  await store.upsertMany(items);
  const merges = state.executed.filter(x => /MERGE INTO/i.test(x.sql));
  assert.equal(merges.length, 3, 'expected 3 chunks (10 + 10 + 5)');
  assert.equal(merges[0].params.length, 40); // 4 * 10
  assert.equal(merges[1].params.length, 40);
  assert.equal(merges[2].params.length, 20); // 4 * 5
});

test('HanaVectorStore: rejects invalid index.type', () => {
  assert.throws(
    () => new HanaVectorStore({
      embed: fakeEmbedder, dimension: 4, table: 'X',
      connection: { host: 'x', port: 443, user: 'u', password: 'p' },
      index: { type: 'ivf', similarity: 'cosine' },
    }),
    /index\.type must be 'hnsw'/,
  );
});

test('HanaVectorStore: rejects invalid index.similarity', () => {
  assert.throws(
    () => new HanaVectorStore({
      embed: fakeEmbedder, dimension: 4, table: 'X',
      connection: { host: 'x', port: 443, user: 'u', password: 'p' },
      index: { type: 'hnsw', similarity: 'jaccard' },
    }),
    /index\.similarity must be/,
  );
});

test('HanaVectorStore: init creates HNSW index with default similarity=cosine', async () => {
  state.executed = [];
  const store = new HanaVectorStore({
    embed: fakeEmbedder, dimension: 4, table: 'CONTRACTS',
    connection: { host: 'x', port: 443, user: 'u', password: 'p' },
    index: { type: 'hnsw' },
  });
  await store.init();
  const idx = state.executed.find(x => /CREATE HNSW VECTOR INDEX/i.test(x.sql));
  assert.ok(idx, 'HNSW index CREATE was not issued');
  assert.match(idx.sql, /"CONTRACTS_embedding_HNSW_IDX"/);
  assert.match(idx.sql, /ON "CONTRACTS" \("embedding"\)/);
  assert.match(idx.sql, /SIMILARITY FUNCTION COSINE_SIMILARITY/);
  assert.doesNotMatch(idx.sql, /BUILD PARAMETERS/);
});

test('HanaVectorStore: HNSW index honors similarity=l2 + buildParameters + custom name', async () => {
  state.executed = [];
  const store = new HanaVectorStore({
    embed: fakeEmbedder, dimension: 4, table: 'DOCS',
    connection: { host: 'x', port: 443, user: 'u', password: 'p' },
    index: {
      type: 'hnsw',
      similarity: 'l2',
      name: 'MY_CUSTOM_IDX',
      buildParameters: { ef_construction: 200, M: 64 },
    },
  });
  await store.init();
  const idx = state.executed.find(x => /CREATE HNSW VECTOR INDEX/i.test(x.sql));
  assert.ok(idx);
  assert.match(idx.sql, /"MY_CUSTOM_IDX"/);
  assert.match(idx.sql, /SIMILARITY FUNCTION L2DISTANCE/);
  assert.match(idx.sql, /BUILD PARAMETERS \('ef_construction=200,M=64'\)/);
});

test('HanaVectorStore: no index option => no HNSW CREATE issued', async () => {
  state.executed = [];
  const store = makeStore();
  await store.init();
  const idx = state.executed.find(x => /CREATE HNSW/i.test(x.sql));
  assert.equal(idx, undefined);
});

test('HanaVectorStore: dropTable issues DROP TABLE', async () => {
  state.executed = [];
  const store = makeStore();
  await store.init();
  await store.dropTable();
  const drop = state.executed.find(x => /DROP TABLE/i.test(x.sql));
  assert.ok(drop);
});
