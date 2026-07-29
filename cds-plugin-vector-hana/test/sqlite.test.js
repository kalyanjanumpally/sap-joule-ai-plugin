const { test } = require('node:test');
const assert = require('node:assert/strict');
const SqliteVectorStore = require('../lib/backends/sqlite');

// Deterministic 8-dim "embedding" — just for tests
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

async function makeStore() {
  const store = new SqliteVectorStore({
    embed: fakeEmbedder,
    dimension: 8,
    table: 'test_vectors',
    dbPath: ':memory:',
  });
  await store.init();
  return store;
}

test('SqliteVectorStore: upsert + search returns ranked results', async () => {
  const store = await makeStore();
  try {
    await store.upsert({ id: 'a', text: 'purchase order for steel coils' });
    await store.upsert({ id: 'b', text: 'invoice for office supplies' });
    await store.upsert({ id: 'c', text: 'supplier onboarding contract' });
    await store.upsert({ id: 'd', text: 'purchase order for aluminum sheets' });

    const hits = await store.search({ text: 'purchase order steel', topK: 4 });
    assert.equal(hits.length, 4);
    // Most similar should be a and d (share "purchase order")
    const topIds = hits.slice(0, 2).map(h => h.id);
    assert.ok(topIds.includes('a'), 'expected "a" in top 2, got ' + topIds.join(','));
    // Sorted by score descending
    for (let i = 0; i < hits.length - 1; i++) {
      assert.ok(hits[i].score >= hits[i + 1].score, 'scores not sorted DESC');
    }
  } finally {
    await store.close();
  }
});

test('SqliteVectorStore: upsert overwrites existing row', async () => {
  const store = await makeStore();
  try {
    await store.upsert({ id: 'x', text: 'original text' });
    await store.upsert({ id: 'x', text: 'updated text' });
    const hits = await store.search({ text: 'updated', topK: 10 });
    assert.equal(hits.filter(h => h.id === 'x').length, 1);
    assert.equal(hits.find(h => h.id === 'x').text, 'updated text');
  } finally {
    await store.close();
  }
});

test('SqliteVectorStore: metadata is round-tripped', async () => {
  const store = await makeStore();
  try {
    await store.upsert({
      id: 'p1',
      text: 'sample',
      metadata: { category: 'contracts', region: 'EMEA', priority: 3 },
    });
    const hits = await store.search({ text: 'sample', topK: 1 });
    assert.deepEqual(hits[0].metadata, { category: 'contracts', region: 'EMEA', priority: 3 });
  } finally {
    await store.close();
  }
});

test('SqliteVectorStore: filter by metadata field', async () => {
  const store = await makeStore();
  try {
    await store.upsert({ id: '1', text: 'contract A', metadata: { region: 'EMEA' } });
    await store.upsert({ id: '2', text: 'contract B', metadata: { region: 'APAC' } });
    await store.upsert({ id: '3', text: 'contract C', metadata: { region: 'EMEA' } });

    const hits = await store.search({ text: 'contract', topK: 10, filter: { region: 'EMEA' } });
    assert.equal(hits.length, 2);
    assert.ok(hits.every(h => h.metadata.region === 'EMEA'));
  } finally {
    await store.close();
  }
});

test('SqliteVectorStore: delete removes row', async () => {
  const store = await makeStore();
  try {
    await store.upsert({ id: 'k', text: 'to be deleted' });
    const before = await store.search({ text: 'deleted', topK: 5 });
    assert.equal(before.length, 1);

    const res = await store.delete({ id: 'k' });
    assert.equal(res.deleted, 1);

    const after = await store.search({ text: 'deleted', topK: 5 });
    assert.equal(after.length, 0);
  } finally {
    await store.close();
  }
});

test('VectorStore: dimension mismatch is caught', async () => {
  const store = new SqliteVectorStore({
    embed: {
      async embed() { return { embeddings: [[1, 2, 3]] }; },  // 3-dim
    },
    dimension: 8,   // configured 8-dim
    table: 't',
    dbPath: ':memory:',
  });
  await store.init();
  await assert.rejects(
    () => store.upsert({ id: 'x', text: 'y' }),
    /dimension mismatch/,
  );
  await store.close();
});

test('VectorStore: requires embed + dimension', () => {
  assert.throws(() => new SqliteVectorStore({ dimension: 8 }), /embed/);
  assert.throws(() => new SqliteVectorStore({ embed: fakeEmbedder }), /dimension/);
});
