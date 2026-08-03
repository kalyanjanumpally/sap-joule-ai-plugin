const { test } = require('node:test');
const assert = require('node:assert/strict');
const { activate, normalizeConfig, buildItem } = require('../lib/cdsPlugin');
const SqliteVectorStore = require('../lib/backends/sqlite');
const RAG = require('../lib/rag');

// ---- fake @sap/cds --------------------------------------------------------
//
// The plugin only touches: cds.log(), cds.model.definitions, cds.on('served'),
// cds.services[alias], and each service's before/after handler registration.
// Everything else is out of scope.

function makeFakeService(name) {
  const before = [];
  const after = [];
  return {
    name,
    entities: {},
    before(events, entity, handler) {
      const ev = Array.isArray(events) ? events : [events];
      for (const e of ev) before.push({ event: e, entity, handler });
    },
    after(events, entity, handler) {
      const ev = Array.isArray(events) ? events : [events];
      for (const e of ev) after.push({ event: e, entity, handler });
    },
    // Test helper: dispatch as if the CAP runtime fired the event
    async _dispatchAfter(event, entity, data) {
      for (const h of after) {
        if (h.event === event && (h.entity === entity || h.entity === undefined)) {
          await h.handler(data);
        }
      }
    },
    async _dispatchBefore(event, entity, req) {
      for (const h of before) {
        if (h.event === event && (h.entity === entity || h.entity === undefined)) {
          await h.handler(req);
        }
      }
    },
    _before: before,
    _after: after,
  };
}

function fakeEmbed(text) {
  const vec = new Array(8).fill(0);
  for (let i = 0; i < text.length; i++) vec[i % 8] += text.charCodeAt(i);
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return norm === 0 ? vec : vec.map(v => v / norm);
}
const fakeEmbedder = {
  async embed({ input }) {
    const inputs = Array.isArray(input) ? input : [input];
    return { embeddings: inputs.map(fakeEmbed), model: 'fake-embed' };
  },
};

function makeFakeCds({ definitions = {}, services = { llm: fakeEmbedder } } = {}) {
  const listeners = { served: [], loaded: [] };
  return {
    model: { definitions },
    services,
    logs: { info: [], warn: [], error: [] },
    log(_ns) {
      const self = this;
      return {
        info: (m) => self.logs.info.push(m),
        warn: (m) => self.logs.warn.push(m),
        error: (m) => self.logs.error.push(m),
        debug: () => {},
      };
    },
    on(event, fn) {
      (listeners[event] ??= []).push(fn);
    },
    async emit(event, ...args) {
      for (const fn of listeners[event] ?? []) await fn(...args);
    },
    _listeners: listeners,
  };
}

function makeSuppliersEntity(ragOverrides = {}) {
  return {
    kind: 'entity',
    name: 'AppService.Suppliers',
    _service: { name: 'AppService' },
    '@rag': {
      fields: ['name', 'description'],
      dimension: 8,
      store: 'sqlite',
      table: 'suppliers_vec',
      ...ragOverrides,
    },
  };
}

// ---- normalizeConfig ----------------------------------------------------

test('normalizeConfig: requires object form', () => {
  assert.throws(() => normalizeConfig(true, 'X'), /must be an object/);
});

test('normalizeConfig: requires fields as non-empty array', () => {
  assert.throws(() => normalizeConfig({ dimension: 8 }, 'X'), /fields/);
  assert.throws(() => normalizeConfig({ fields: [], dimension: 8 }, 'X'), /fields/);
});

test('normalizeConfig: requires dimension as positive number', () => {
  assert.throws(() => normalizeConfig({ fields: ['a'] }, 'X'), /dimension/);
  assert.throws(() => normalizeConfig({ fields: ['a'], dimension: 0 }, 'X'), /dimension/);
});

test('normalizeConfig: defaults + table derived from short entity name', () => {
  const c = normalizeConfig({ fields: ['name'], dimension: 4 }, 'AppService.Suppliers');
  assert.deepEqual(c.fields, ['name']);
  assert.equal(c.dimension, 4);
  assert.equal(c.provider, 'llm');
  assert.equal(c.chatter, 'llm');
  assert.equal(c.store, 'sqlite');
  assert.equal(c.table, 'suppliers_vec');
  assert.equal(c.topK, 5);
  assert.equal(c.idField, 'ID');
});

test('normalizeConfig: chatter falls back to provider', () => {
  const c = normalizeConfig({ fields: ['a'], dimension: 4, provider: 'llm-cheap' }, 'X');
  assert.equal(c.provider, 'llm-cheap');
  assert.equal(c.chatter, 'llm-cheap');
});

test('normalizeConfig: rejects unknown store kind', () => {
  assert.throws(() => normalizeConfig({ fields: ['a'], dimension: 4, store: 'pinecone' }, 'X'), /sqlite.*hana/);
});

// ---- buildItem -----------------------------------------------------------

test('buildItem: concatenates configured fields with blank-line separator', () => {
  const item = buildItem(
    { ID: 'sup-1', name: 'Acme', description: 'Global widgets.', country: 'DE' },
    { fields: ['name', 'description'], idField: 'ID' },
  );
  assert.equal(item.id, 'sup-1');
  assert.equal(item.text, 'Acme\n\nGlobal widgets.');
  assert.deepEqual(item.metadata, { entity: undefined });
});

test('buildItem: skips null/empty fields', () => {
  const item = buildItem(
    { ID: 'sup-2', name: 'X', description: null, terms: '' },
    { fields: ['name', 'description', 'terms'], idField: 'ID' },
  );
  assert.equal(item.text, 'X');
});

test('buildItem: metadata is null when no text was produced (all fields empty)', () => {
  const item = buildItem(
    { ID: 'sup-3', name: null, description: '' },
    { fields: ['name', 'description'], idField: 'ID' },
  );
  assert.equal(item.text, '');
  assert.equal(item.metadata, null);
});

test('buildItem: throws when id field missing', () => {
  assert.throws(
    () => buildItem({ name: 'x' }, { fields: ['name'], idField: 'ID' }),
    /missing id field 'ID'/,
  );
});

// ---- activate: wiring ---------------------------------------------------

test('activate: skips entities without @rag', async () => {
  const cds = makeFakeCds({
    definitions: {
      'AppService.Plain': { kind: 'entity', name: 'AppService.Plain' },
    },
    services: { llm: fakeEmbedder, AppService: makeFakeService('AppService') },
  });
  const plugin = activate(cds);
  await cds.emit('served');
  assert.equal(plugin._stores.size, 0);
});

test('activate: respects @rag.enabled === false', async () => {
  const def = makeSuppliersEntity({ enabled: false });
  const cds = makeFakeCds({
    definitions: { 'AppService.Suppliers': def },
    services: { llm: fakeEmbedder, AppService: makeFakeService('AppService') },
  });
  const plugin = activate(cds);
  await cds.emit('served');
  assert.equal(plugin._stores.size, 0);
});

test('activate: builds store, calls init(), registers CRUD handlers', async () => {
  const def = makeSuppliersEntity();
  const svc = makeFakeService('AppService');
  const cds = makeFakeCds({
    definitions: { 'AppService.Suppliers': def },
    services: { llm: fakeEmbedder, AppService: svc },
  });
  const plugin = activate(cds);
  await cds.emit('served');
  assert.equal(plugin._stores.size, 1);
  const store = plugin.getStore('AppService.Suppliers');
  assert.ok(store instanceof SqliteVectorStore);
  const afterEvents = svc._after.map(h => h.event).sort();
  assert.deepEqual(afterEvents, ['CREATE', 'UPDATE']);
  assert.equal(svc._before.length, 1);
  assert.equal(svc._before[0].event, 'DELETE');
});

test('activate: logs + skips when embedder alias not registered', async () => {
  const def = makeSuppliersEntity({ provider: 'ghost' });
  const cds = makeFakeCds({
    definitions: { 'AppService.Suppliers': def },
    services: { llm: fakeEmbedder, AppService: makeFakeService('AppService') },
  });
  const plugin = activate(cds);
  await cds.emit('served');
  assert.equal(plugin._stores.size, 0);
  assert.ok(cds.logs.error.some(m => /cds\.services\['ghost'\]/.test(m)));
});

test('activate: skips (does not throw) when @rag is malformed', async () => {
  const def = { kind: 'entity', name: 'AppService.Broken', '@rag': { fields: 'not-an-array' } };
  const cds = makeFakeCds({
    definitions: { 'AppService.Broken': def },
    services: { llm: fakeEmbedder, AppService: makeFakeService('AppService') },
  });
  const plugin = activate(cds);
  await cds.emit('served');
  assert.equal(plugin._stores.size, 0);
  assert.ok(cds.logs.error.some(m => /invalid config/.test(m)));
});

// ---- CRUD sync ----------------------------------------------------------

test('CRUD sync: after CREATE upserts a single row', async () => {
  const def = makeSuppliersEntity();
  const svc = makeFakeService('AppService');
  const cds = makeFakeCds({
    definitions: { 'AppService.Suppliers': def },
    services: { llm: fakeEmbedder, AppService: svc },
  });
  const plugin = activate(cds);
  await cds.emit('served');
  const store = plugin.getStore('AppService.Suppliers');

  await svc._dispatchAfter('CREATE', 'AppService.Suppliers', {
    ID: 'sup-1', name: 'Acme', description: 'widgets',
  });
  const hits = await store.search({ text: 'widgets', topK: 5 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'sup-1');
});

test('CRUD sync: after UPDATE overwrites the vector', async () => {
  const def = makeSuppliersEntity();
  const svc = makeFakeService('AppService');
  const cds = makeFakeCds({
    definitions: { 'AppService.Suppliers': def },
    services: { llm: fakeEmbedder, AppService: svc },
  });
  const plugin = activate(cds);
  await cds.emit('served');
  const store = plugin.getStore('AppService.Suppliers');

  await svc._dispatchAfter('CREATE', 'AppService.Suppliers', { ID: 'sup-1', name: 'Original', description: 'text' });
  await svc._dispatchAfter('UPDATE', 'AppService.Suppliers', { ID: 'sup-1', name: 'Updated', description: 'text' });
  const hits = await store.search({ text: 'Updated', topK: 5 });
  assert.equal(hits.filter(h => h.id === 'sup-1').length, 1);
  assert.match(hits.find(h => h.id === 'sup-1').text, /Updated/);
});

test('CRUD sync: after CREATE handles an array of rows via upsertMany', async () => {
  const def = makeSuppliersEntity();
  const svc = makeFakeService('AppService');
  const cds = makeFakeCds({
    definitions: { 'AppService.Suppliers': def },
    services: { llm: fakeEmbedder, AppService: svc },
  });
  const plugin = activate(cds);
  await cds.emit('served');
  const store = plugin.getStore('AppService.Suppliers');

  await svc._dispatchAfter('CREATE', 'AppService.Suppliers', [
    { ID: 'sup-1', name: 'One', description: 'a' },
    { ID: 'sup-2', name: 'Two', description: 'b' },
    { ID: 'sup-3', name: 'Three', description: 'c' },
  ]);
  const hits = await store.search({ text: 'anything', topK: 10 });
  assert.equal(hits.length, 3);
});

test('CRUD sync: rows with empty projected text are skipped (not upserted)', async () => {
  const def = makeSuppliersEntity();
  const svc = makeFakeService('AppService');
  const cds = makeFakeCds({
    definitions: { 'AppService.Suppliers': def },
    services: { llm: fakeEmbedder, AppService: svc },
  });
  const plugin = activate(cds);
  await cds.emit('served');
  const store = plugin.getStore('AppService.Suppliers');

  await svc._dispatchAfter('CREATE', 'AppService.Suppliers', { ID: 'sup-1', name: null, description: '' });
  const hits = await store.search({ text: 'x', topK: 5 });
  assert.equal(hits.length, 0);
});

test('CRUD sync: before DELETE removes the row from the store', async () => {
  const def = makeSuppliersEntity();
  const svc = makeFakeService('AppService');
  const cds = makeFakeCds({
    definitions: { 'AppService.Suppliers': def },
    services: { llm: fakeEmbedder, AppService: svc },
  });
  const plugin = activate(cds);
  await cds.emit('served');
  const store = plugin.getStore('AppService.Suppliers');

  await svc._dispatchAfter('CREATE', 'AppService.Suppliers', { ID: 'sup-1', name: 'Doomed', description: 'x' });
  await svc._dispatchAfter('CREATE', 'AppService.Suppliers', { ID: 'sup-2', name: 'Kept',    description: 'x' });
  await svc._dispatchBefore('DELETE', 'AppService.Suppliers', { data: { ID: 'sup-1' } });

  const hits = await store.search({ text: 'anything', topK: 10 });
  const ids = hits.map(h => h.id);
  assert.ok(!ids.includes('sup-1'));
  assert.ok(ids.includes('sup-2'));
});

test('CRUD sync: DELETE without an id in req is a no-op (does not throw)', async () => {
  const def = makeSuppliersEntity();
  const svc = makeFakeService('AppService');
  const cds = makeFakeCds({
    definitions: { 'AppService.Suppliers': def },
    services: { llm: fakeEmbedder, AppService: svc },
  });
  const plugin = activate(cds);
  await cds.emit('served');
  await svc._dispatchBefore('DELETE', 'AppService.Suppliers', {});
});

// ---- searchByMeaning + askAbout ----------------------------------------

test('searchByMeaning: returns hits from the entity store', async () => {
  const def = makeSuppliersEntity();
  const svc = makeFakeService('AppService');
  const cds = makeFakeCds({
    definitions: { 'AppService.Suppliers': def },
    services: { llm: fakeEmbedder, AppService: svc },
  });
  const plugin = activate(cds);
  await cds.emit('served');
  await svc._dispatchAfter('CREATE', 'AppService.Suppliers', { ID: 'sup-1', name: 'Steel', description: 'coils' });
  await svc._dispatchAfter('CREATE', 'AppService.Suppliers', { ID: 'sup-2', name: 'Paper', description: 'sheets' });

  const hits = await plugin.searchByMeaning({ entity: 'AppService.Suppliers', query: 'coils', topK: 2 });
  assert.equal(hits.length, 2);
  const ids = hits.map(h => h.id).sort();
  assert.deepEqual(ids, ['sup-1', 'sup-2']);
});

test('searchByMeaning: applies default topK from annotation when caller omits it', async () => {
  const def = makeSuppliersEntity({ topK: 2 });
  const svc = makeFakeService('AppService');
  const cds = makeFakeCds({
    definitions: { 'AppService.Suppliers': def },
    services: { llm: fakeEmbedder, AppService: svc },
  });
  const plugin = activate(cds);
  await cds.emit('served');
  const rows = ['a','b','c','d','e','f'].map((c, i) => ({ ID: `s${i}`, name: c, description: c }));
  await svc._dispatchAfter('CREATE', 'AppService.Suppliers', rows);
  const hits = await plugin.searchByMeaning({ entity: 'AppService.Suppliers', query: 'x' });
  assert.equal(hits.length, 2, 'should cap at annotation-configured topK=2');
});

test('searchByMeaning: throws on unknown entity', async () => {
  const cds = makeFakeCds({ services: { llm: fakeEmbedder } });
  const plugin = activate(cds);
  await cds.emit('served');
  await assert.rejects(
    plugin.searchByMeaning({ entity: 'AppService.Nope', query: 'x' }),
    /no @rag store registered/,
  );
});

test('askAbout: runs full retrieve → augment → chat pipeline', async () => {
  const chatterCalls = [];
  const chatter = {
    ...fakeEmbedder,
    async chat(req) { chatterCalls.push(req); return 'The top supplier is Acme [sup-1].'; },
  };
  const def = makeSuppliersEntity();
  const svc = makeFakeService('AppService');
  const cds = makeFakeCds({
    definitions: { 'AppService.Suppliers': def },
    services: { llm: chatter, AppService: svc },
  });
  const plugin = activate(cds);
  await cds.emit('served');
  await svc._dispatchAfter('CREATE', 'AppService.Suppliers', { ID: 'sup-1', name: 'Acme', description: 'widgets' });

  const result = await plugin.askAbout({ entity: 'AppService.Suppliers', query: 'top supplier?' });
  assert.equal(result.answer, 'The top supplier is Acme [sup-1].');
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].id, 'sup-1');
  assert.equal(chatterCalls.length, 1);
  assert.match(chatterCalls[0].messages[0].content, /Question: top supplier\?/);
});

test('askAbout: passes-through model/maxTokens to the chatter', async () => {
  const chatterCalls = [];
  const chatter = {
    ...fakeEmbedder,
    async chat(req) { chatterCalls.push(req); return 'ok'; },
  };
  const def = makeSuppliersEntity();
  const svc = makeFakeService('AppService');
  const cds = makeFakeCds({
    definitions: { 'AppService.Suppliers': def },
    services: { llm: chatter, AppService: svc },
  });
  const plugin = activate(cds);
  await cds.emit('served');
  await svc._dispatchAfter('CREATE', 'AppService.Suppliers', { ID: 'sup-1', name: 'x', description: 'y' });
  await plugin.askAbout({ entity: 'AppService.Suppliers', query: 'q', model: 'gpt-4', maxTokens: 128 });
  assert.equal(chatterCalls[0].model, 'gpt-4');
  assert.equal(chatterCalls[0].maxTokens, 128);
});
