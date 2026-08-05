const { test } = require('node:test');
const assert = require('node:assert/strict');
const { activate, normalizeConfig, buildItem, declareActions, readRagAnnotation } = require('../lib/cdsPlugin');
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
  const on = [];
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
    on(event, entity, handler) {
      on.push({ event, entity, handler });
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
    async _dispatchAction(event, entity, req) {
      for (const h of on) {
        if (h.event === event && (h.entity === entity || h.entity === undefined)) {
          return h.handler(req);
        }
      }
      throw new Error(`no handler for action ${event} on ${entity}`);
    },
    _before: before,
    _after: after,
    _on: on,
  };
}

// Chainable SELECT builder that captures { from, where } into a plain spec
// for the fake cds.run() to execute against a synthetic table.
function makeFakeSelect() {
  return {
    from(entity) {
      const spec = { from: entity };
      return {
        _spec: spec,
        where(clause) { spec.where = clause; return this; },
      };
    },
  };
}

function makeFakeRun(tables) {
  return async function run(query) {
    const spec = query._spec;
    if (!spec) throw new Error('fake cds.run: query has no _spec');
    const rows = tables[spec.from] ?? [];
    if (!spec.where) return rows;
    return rows.filter(r => {
      for (const [k, v] of Object.entries(spec.where)) {
        if (v && typeof v === 'object' && Array.isArray(v.in)) {
          if (!v.in.includes(r[k])) return false;
        } else if (r[k] !== v) return false;
      }
      return true;
    });
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

function makeFakeCds({ definitions = {}, services = { llm: fakeEmbedder }, tables = {} } = {}) {
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
    SELECT: makeFakeSelect(),
    run: makeFakeRun(tables),
    _listeners: listeners,
    _tables: tables,
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

// ---- readRagAnnotation (nested vs flat CSN forms) ----------------------

test('readRagAnnotation: nested form (from cds.linked or test doubles)', () => {
  const def = {
    '@rag': { fields: ['a'], dimension: 4, store: 'sqlite' },
  };
  const rag = readRagAnnotation(def);
  assert.deepEqual(rag, { fields: ['a'], dimension: 4, store: 'sqlite' });
});

test('readRagAnnotation: flat form (from cdsc / raw CSN)', () => {
  const def = {
    '@rag.fields': ['name', 'description'],
    '@rag.dimension': 768,
    '@rag.store': 'sqlite',
    '@rag.topK': 5,
    '@rag.provider': 'llm-embed',
  };
  const rag = readRagAnnotation(def);
  assert.deepEqual(rag, {
    fields: ['name', 'description'],
    dimension: 768,
    store: 'sqlite',
    topK: 5,
    provider: 'llm-embed',
  });
});

test('readRagAnnotation: flat form with nested keys (e.g., @rag.actions.search)', () => {
  const def = {
    '@rag.fields': ['a'],
    '@rag.dimension': 4,
    '@rag.actions.search': 'findX',
    '@rag.actions.ask': false,
  };
  const rag = readRagAnnotation(def);
  assert.deepEqual(rag, {
    fields: ['a'],
    dimension: 4,
    actions: { search: 'findX', ask: false },
  });
});

test('readRagAnnotation: returns null when no @rag annotation present', () => {
  assert.equal(readRagAnnotation({ '@Common.Label': 'x' }), null);
  assert.equal(readRagAnnotation({}), null);
});

test('readRagAnnotation: nested form wins if both nested + flat coexist', () => {
  const def = {
    '@rag': { fields: ['x'], dimension: 8 },
    '@rag.dimension': 16, // ignored — nested wins
  };
  const rag = readRagAnnotation(def);
  assert.deepEqual(rag, { fields: ['x'], dimension: 8 });
});

test('readRagAnnotation: @rag: true / false shorthand → { enabled: ... }', () => {
  assert.deepEqual(readRagAnnotation({ '@rag': true }), { enabled: true });
  assert.deepEqual(readRagAnnotation({ '@rag': false }), { enabled: false });
});

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

test('activate: works with flat @rag.* annotations (raw CSN from cdsc)', async () => {
  const def = {
    kind: 'entity',
    name: 'AppService.Suppliers',
    _service: { name: 'AppService' },
    '@rag.fields': ['name', 'description'],
    '@rag.dimension': 8,
    '@rag.store': 'sqlite',
    '@rag.table': 'suppliers_vec',
  };
  const svc = makeFakeService('AppService');
  const cds = makeFakeCds({
    definitions: { 'AppService.Suppliers': def },
    services: { llm: fakeEmbedder, AppService: svc },
  });
  const plugin = activate(cds);
  await cds.emit('served');
  assert.equal(plugin._stores.size, 1);
  assert.ok(plugin.getStore('AppService.Suppliers') instanceof SqliteVectorStore);
  // OData actions also get declared for flat-annotated entities
  assert.ok(def.actions?.searchByMeaning);
  assert.ok(def.actions?.askAbout);
});

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

// ---- OData action auto-declaration (v0.6.0) ----------------------------

test('normalizeConfig: default actions = { search: "searchByMeaning", ask: "askAbout" }', () => {
  const c = normalizeConfig({ fields: ['a'], dimension: 4 }, 'X');
  assert.deepEqual(c.actions, { search: 'searchByMeaning', ask: 'askAbout' });
});

test('normalizeConfig: actions === false disables all auto-declaration', () => {
  const c = normalizeConfig({ fields: ['a'], dimension: 4, actions: false }, 'X');
  assert.equal(c.actions, false);
});

test('normalizeConfig: actions.search === false disables just the search action', () => {
  const c = normalizeConfig({ fields: ['a'], dimension: 4, actions: { search: false } }, 'X');
  assert.deepEqual(c.actions, { search: false, ask: 'askAbout' });
});

test('normalizeConfig: actions.ask === false disables just the ask action', () => {
  const c = normalizeConfig({ fields: ['a'], dimension: 4, actions: { ask: false } }, 'X');
  assert.deepEqual(c.actions, { search: 'searchByMeaning', ask: false });
});

test('normalizeConfig: actions.search accepts a valid identifier', () => {
  const c = normalizeConfig({ fields: ['a'], dimension: 4, actions: { search: 'findSuppliers' } }, 'X');
  assert.deepEqual(c.actions, { search: 'findSuppliers', ask: 'askAbout' });
});

test('normalizeConfig: actions.ask accepts a valid identifier', () => {
  const c = normalizeConfig({ fields: ['a'], dimension: 4, actions: { ask: 'answerAbout' } }, 'X');
  assert.deepEqual(c.actions, { search: 'searchByMeaning', ask: 'answerAbout' });
});

test('normalizeConfig: actions.search rejects invalid identifier', () => {
  assert.throws(
    () => normalizeConfig({ fields: ['a'], dimension: 4, actions: { search: 'not valid!' } }, 'X'),
    /valid identifier/,
  );
});

test('normalizeConfig: actions.ask rejects invalid identifier', () => {
  assert.throws(
    () => normalizeConfig({ fields: ['a'], dimension: 4, actions: { ask: 'no spaces' } }, 'X'),
    /valid identifier/,
  );
});

test('declareActions: adds searchByMeaning bound-to-collection action to the entity CSN', () => {
  const def = makeSuppliersEntity();
  const definitions = { 'AppService.Suppliers': def };
  const config = normalizeConfig(def['@rag'], 'AppService.Suppliers');
  const log = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} };
  declareActions(definitions, 'AppService.Suppliers', def, config, log);
  assert.ok(def.actions, 'entity.actions should be created');
  const action = def.actions.searchByMeaning;
  assert.ok(action, 'searchByMeaning action should be declared');
  assert.equal(action.kind, 'action');
  assert.deepEqual(action.params, {
    query: { type: 'cds.String' },
    topK: { type: 'cds.Integer' },
  });
  assert.deepEqual(action.returns, { items: { type: 'AppService.Suppliers' } });
  // Collection-bound (not instance-bound) so `POST /Entity/Action` works
  // without callers supplying a dummy id.
  assert.equal(action['@cds.odata.bindingparameter.collection'], true);
});

test('declareActions: askAbout also carries the @cds.odata.bindingparameter.collection annotation', () => {
  const def = makeSuppliersEntity();
  const definitions = { 'AppService.Suppliers': def };
  const config = normalizeConfig(def['@rag'], 'AppService.Suppliers');
  declareActions(definitions, 'AppService.Suppliers', def, config, { warn: () => {} });
  assert.equal(def.actions.askAbout['@cds.odata.bindingparameter.collection'], true);
});

test('declareActions: adds askAbout action AND synthesizes result type in model.definitions', () => {
  const def = makeSuppliersEntity();
  const definitions = { 'AppService.Suppliers': def };
  const config = normalizeConfig(def['@rag'], 'AppService.Suppliers');
  declareActions(definitions, 'AppService.Suppliers', def, config, { warn: () => {} });

  // Result type synthesized at the model level
  const resultType = definitions['AppService.SuppliersAskAboutResult'];
  assert.ok(resultType, 'result type should be added to model.definitions');
  assert.equal(resultType.kind, 'type');
  assert.deepEqual(resultType.elements, {
    answer: { type: 'cds.String' },
    sources: { items: { type: 'AppService.Suppliers' } },
  });

  // Action references the synthesized type
  const askAction = def.actions.askAbout;
  assert.ok(askAction, 'askAbout action should be declared');
  assert.deepEqual(askAction.params, {
    query: { type: 'cds.String' },
    topK: { type: 'cds.Integer' },
    systemInstructions: { type: 'cds.String' },
  });
  assert.deepEqual(askAction.returns, { type: 'AppService.SuppliersAskAboutResult' });
});

test('declareActions: is idempotent — searchByMeaning already declared', () => {
  const def = makeSuppliersEntity();
  def.actions = { searchByMeaning: { kind: 'action', __marker: 'original' } };
  const definitions = { 'AppService.Suppliers': def };
  const config = normalizeConfig(def['@rag'], 'AppService.Suppliers');
  const warns = [];
  const log = { warn: (m) => warns.push(m), info: () => {}, error: () => {}, debug: () => {} };
  declareActions(definitions, 'AppService.Suppliers', def, config, log);
  assert.equal(def.actions.searchByMeaning.__marker, 'original');
  assert.ok(warns.some(m => /searchByMeaning.*already declared/.test(m)));
  // askAbout should still be added
  assert.ok(def.actions.askAbout);
});

test('declareActions: is idempotent — askAbout already declared', () => {
  const def = makeSuppliersEntity();
  def.actions = { askAbout: { kind: 'action', __marker: 'original' } };
  const definitions = { 'AppService.Suppliers': def };
  const config = normalizeConfig(def['@rag'], 'AppService.Suppliers');
  const warns = [];
  const log = { warn: (m) => warns.push(m), info: () => {}, error: () => {}, debug: () => {} };
  declareActions(definitions, 'AppService.Suppliers', def, config, log);
  assert.equal(def.actions.askAbout.__marker, 'original');
  assert.ok(warns.some(m => /askAbout.*already declared/.test(m)));
});

test('declareActions: does not double-synthesize the result type on re-run', () => {
  const def = makeSuppliersEntity();
  const definitions = { 'AppService.Suppliers': def };
  const config = normalizeConfig(def['@rag'], 'AppService.Suppliers');
  declareActions(definitions, 'AppService.Suppliers', def, config, { warn: () => {} });
  const firstType = definitions['AppService.SuppliersAskAboutResult'];
  // Second call — action already exists so it warns, but the pre-existing
  // result type must not be replaced.
  declareActions(definitions, 'AppService.Suppliers', def, config, { warn: () => {} });
  assert.equal(definitions['AppService.SuppliersAskAboutResult'], firstType);
});

test('declareActions: uses custom action names from @rag.actions', () => {
  const def = makeSuppliersEntity({ actions: { search: 'findSuppliers', ask: 'answerAbout' } });
  const definitions = { 'AppService.Suppliers': def };
  const config = normalizeConfig(def['@rag'], 'AppService.Suppliers');
  declareActions(definitions, 'AppService.Suppliers', def, config, { warn: () => {} });
  assert.ok(def.actions.findSuppliers);
  assert.ok(def.actions.answerAbout);
  assert.equal(def.actions.searchByMeaning, undefined);
  assert.equal(def.actions.askAbout, undefined);
});

test('declareActions: skipped entirely when @rag.actions === false', () => {
  const def = makeSuppliersEntity({ actions: false });
  const definitions = { 'AppService.Suppliers': def };
  const config = normalizeConfig(def['@rag'], 'AppService.Suppliers');
  declareActions(definitions, 'AppService.Suppliers', def, config, { warn: () => {} });
  assert.equal(def.actions, undefined);
  assert.equal(definitions['AppService.SuppliersAskAboutResult'], undefined);
});

test('declareActions: skipped when @rag.actions.search === false (ask still added)', () => {
  const def = makeSuppliersEntity({ actions: { search: false } });
  const definitions = { 'AppService.Suppliers': def };
  const config = normalizeConfig(def['@rag'], 'AppService.Suppliers');
  declareActions(definitions, 'AppService.Suppliers', def, config, { warn: () => {} });
  assert.equal(def.actions.searchByMeaning, undefined);
  assert.ok(def.actions.askAbout);
});

test('declareActions: skipped when @rag.actions.ask === false (search still added)', () => {
  const def = makeSuppliersEntity({ actions: { ask: false } });
  const definitions = { 'AppService.Suppliers': def };
  const config = normalizeConfig(def['@rag'], 'AppService.Suppliers');
  declareActions(definitions, 'AppService.Suppliers', def, config, { warn: () => {} });
  assert.ok(def.actions.searchByMeaning);
  assert.equal(def.actions.askAbout, undefined);
  assert.equal(definitions['AppService.SuppliersAskAboutResult'], undefined);
});

test('declareActions: does nothing when BOTH search and ask are false', () => {
  const def = makeSuppliersEntity({ actions: { search: false, ask: false } });
  const definitions = { 'AppService.Suppliers': def };
  const config = normalizeConfig(def['@rag'], 'AppService.Suppliers');
  declareActions(definitions, 'AppService.Suppliers', def, config, { warn: () => {} });
  assert.equal(def.actions, undefined);
});

test('activate: mutates CSN when model is already loaded (immediate pass)', async () => {
  const def = makeSuppliersEntity();
  const svc = makeFakeService('AppService');
  const cds = makeFakeCds({
    definitions: { 'AppService.Suppliers': def },
    services: { llm: fakeEmbedder, AppService: svc },
  });
  activate(cds); // model is already in cds.model.definitions — mutate happens synchronously
  assert.ok(def.actions?.searchByMeaning, 'CSN action should be declared before served');
});

test('activate: mutates CSN when model loads later (via cds.on(loaded))', async () => {
  const def = makeSuppliersEntity();
  const svc = makeFakeService('AppService');
  const cds = makeFakeCds({
    definitions: {}, // start empty
    services: { llm: fakeEmbedder, AppService: svc },
  });
  activate(cds);
  assert.equal(def.actions, undefined);
  cds.model.definitions['AppService.Suppliers'] = def;
  await cds.emit('loaded');
  assert.ok(def.actions?.searchByMeaning, 'CSN action should be declared after loaded fires');
});

test('activate: registers OData action handler on served', async () => {
  const def = makeSuppliersEntity();
  const svc = makeFakeService('AppService');
  const cds = makeFakeCds({
    definitions: { 'AppService.Suppliers': def },
    services: { llm: fakeEmbedder, AppService: svc },
  });
  activate(cds);
  await cds.emit('served');
  const actionHandlers = svc._on.filter(h => h.event === 'searchByMeaning' && h.entity === 'AppService.Suppliers');
  assert.equal(actionHandlers.length, 1);
});

test('OData action handler: returns entity rows in hit-rank order', async () => {
  const def = makeSuppliersEntity();
  const svc = makeFakeService('AppService');
  const tables = {
    'AppService.Suppliers': [
      { ID: 'sup-3', name: 'C', description: 'gamma' },
      { ID: 'sup-1', name: 'A', description: 'alpha' },
      { ID: 'sup-2', name: 'B', description: 'beta' },
    ],
  };
  const cds = makeFakeCds({
    definitions: { 'AppService.Suppliers': def },
    services: { llm: fakeEmbedder, AppService: svc },
    tables,
  });
  const plugin = activate(cds);
  await cds.emit('served');
  // Prime the vector store — matches what the CRUD handler would have done
  for (const row of tables['AppService.Suppliers']) {
    await svc._dispatchAfter('CREATE', 'AppService.Suppliers', row);
  }
  // Get the deterministic hit order (fake embedder), then check the action
  // returns the entity rows in that same order.
  const hits = await plugin.searchByMeaning({ entity: 'AppService.Suppliers', query: 'alpha' });
  const expectedOrderIds = hits.map(h => h.id);
  const result = await svc._dispatchAction('searchByMeaning', 'AppService.Suppliers', {
    data: { query: 'alpha', topK: 3 },
  });
  assert.deepEqual(result.map(r => r.ID), expectedOrderIds);
});

test('OData action handler: empty query rejects with 400', async () => {
  const def = makeSuppliersEntity();
  const svc = makeFakeService('AppService');
  const cds = makeFakeCds({
    definitions: { 'AppService.Suppliers': def },
    services: { llm: fakeEmbedder, AppService: svc },
  });
  activate(cds);
  await cds.emit('served');
  let rejected;
  const req = { data: { query: '' }, reject(code, msg) { rejected = { code, msg }; } };
  await svc._dispatchAction('searchByMeaning', 'AppService.Suppliers', req);
  assert.deepEqual(rejected, { code: 400, msg: 'query is required' });
});

test('OData action handler: empty hits returns []', async () => {
  const def = makeSuppliersEntity();
  const svc = makeFakeService('AppService');
  const cds = makeFakeCds({
    definitions: { 'AppService.Suppliers': def },
    services: { llm: fakeEmbedder, AppService: svc },
    tables: { 'AppService.Suppliers': [] },
  });
  activate(cds);
  await cds.emit('served');
  const result = await svc._dispatchAction('searchByMeaning', 'AppService.Suppliers', {
    data: { query: 'anything' },
  });
  assert.deepEqual(result, []);
});

test('OData action handler: not registered when @rag.actions === false', async () => {
  const def = makeSuppliersEntity({ actions: false });
  const svc = makeFakeService('AppService');
  const cds = makeFakeCds({
    definitions: { 'AppService.Suppliers': def },
    services: { llm: fakeEmbedder, AppService: svc },
  });
  activate(cds);
  await cds.emit('served');
  const actionHandlers = svc._on.filter(h => h.event === 'searchByMeaning');
  assert.equal(actionHandlers.length, 0);
});

test('OData action handler: custom action name from @rag.actions.search', async () => {
  const def = makeSuppliersEntity({ actions: { search: 'findSuppliers' } });
  const svc = makeFakeService('AppService');
  const tables = {
    'AppService.Suppliers': [{ ID: 'sup-1', name: 'X', description: 'y' }],
  };
  const cds = makeFakeCds({
    definitions: { 'AppService.Suppliers': def },
    services: { llm: fakeEmbedder, AppService: svc },
    tables,
  });
  activate(cds);
  await cds.emit('served');
  await svc._dispatchAfter('CREATE', 'AppService.Suppliers', tables['AppService.Suppliers'][0]);
  const result = await svc._dispatchAction('findSuppliers', 'AppService.Suppliers', {
    data: { query: 'anything' },
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].ID, 'sup-1');
});

// ---- OData askAbout action handler (v0.7.0) ---------------------------

function makeChatterEmbedder(answer = 'Refunds are 30 days [sup-1].') {
  const calls = [];
  return {
    calls,
    async embed({ input }) {
      const inputs = Array.isArray(input) ? input : [input];
      return { embeddings: inputs.map(fakeEmbed), model: 'fake' };
    },
    async chat(req) { calls.push(req); return answer; },
  };
}

test('activate: registers askAbout handler alongside searchByMeaning on served', async () => {
  const def = makeSuppliersEntity();
  const svc = makeFakeService('AppService');
  const cds = makeFakeCds({
    definitions: { 'AppService.Suppliers': def },
    services: { llm: makeChatterEmbedder(), AppService: svc },
  });
  activate(cds);
  await cds.emit('served');
  const events = svc._on.map(h => h.event).sort();
  assert.deepEqual(events, ['askAbout', 'searchByMeaning']);
});

test('askAbout handler: returns { answer, sources } with sources in hit-rank order', async () => {
  const def = makeSuppliersEntity();
  const svc = makeFakeService('AppService');
  const chatter = makeChatterEmbedder('You have 30 days [sup-1].');
  const tables = {
    'AppService.Suppliers': [
      { ID: 'sup-1', name: 'Refund policy', description: 'Refunds within 30 days.' },
      { ID: 'sup-2', name: 'Shipping', description: 'Free over 50 EUR.' },
    ],
  };
  const cds = makeFakeCds({
    definitions: { 'AppService.Suppliers': def },
    services: { llm: chatter, AppService: svc },
    tables,
  });
  const plugin = activate(cds);
  await cds.emit('served');
  for (const row of tables['AppService.Suppliers']) {
    await svc._dispatchAfter('CREATE', 'AppService.Suppliers', row);
  }

  // Match hit-rank order the plugin will actually produce with the same fake
  // embedder so we can assert the exact sources array.
  const expectedHits = await plugin.searchByMeaning({
    entity: 'AppService.Suppliers', query: 'refund window', topK: 5,
  });
  const expectedOrderIds = expectedHits.map(h => h.id);

  const result = await svc._dispatchAction('askAbout', 'AppService.Suppliers', {
    data: { query: 'refund window' },
  });
  assert.equal(result.answer, 'You have 30 days [sup-1].');
  assert.deepEqual(result.sources.map(r => r.ID), expectedOrderIds);
});

test('askAbout handler: empty query rejects with 400', async () => {
  const def = makeSuppliersEntity();
  const svc = makeFakeService('AppService');
  const cds = makeFakeCds({
    definitions: { 'AppService.Suppliers': def },
    services: { llm: makeChatterEmbedder(), AppService: svc },
  });
  activate(cds);
  await cds.emit('served');
  let rejected;
  await svc._dispatchAction('askAbout', 'AppService.Suppliers', {
    data: { query: '' },
    reject(code, msg) { rejected = { code, msg }; },
  });
  assert.deepEqual(rejected, { code: 400, msg: 'query is required' });
});

test('askAbout handler: empty hits returns { answer, sources: [] }', async () => {
  const def = makeSuppliersEntity();
  const svc = makeFakeService('AppService');
  const chatter = makeChatterEmbedder('I do not know.');
  const cds = makeFakeCds({
    definitions: { 'AppService.Suppliers': def },
    services: { llm: chatter, AppService: svc },
    tables: { 'AppService.Suppliers': [] },
  });
  activate(cds);
  await cds.emit('served');
  const result = await svc._dispatchAction('askAbout', 'AppService.Suppliers', {
    data: { query: 'anything' },
  });
  assert.equal(result.answer, 'I do not know.');
  assert.deepEqual(result.sources, []);
});

test('askAbout handler: passes systemInstructions through to the RAG call', async () => {
  const def = makeSuppliersEntity();
  const svc = makeFakeService('AppService');
  const chatter = makeChatterEmbedder('OK.');
  const cds = makeFakeCds({
    definitions: { 'AppService.Suppliers': def },
    services: { llm: chatter, AppService: svc },
    tables: { 'AppService.Suppliers': [{ ID: 'sup-1', name: 'X', description: 'y' }] },
  });
  activate(cds);
  await cds.emit('served');
  await svc._dispatchAfter('CREATE', 'AppService.Suppliers', { ID: 'sup-1', name: 'X', description: 'y' });
  await svc._dispatchAction('askAbout', 'AppService.Suppliers', {
    data: { query: 'q', systemInstructions: 'Answer in French only.' },
  });
  assert.equal(chatter.calls.length, 1);
  assert.equal(chatter.calls[0].system, 'Answer in French only.');
});

test('askAbout handler: not registered when @rag.actions.ask === false', async () => {
  const def = makeSuppliersEntity({ actions: { ask: false } });
  const svc = makeFakeService('AppService');
  const cds = makeFakeCds({
    definitions: { 'AppService.Suppliers': def },
    services: { llm: makeChatterEmbedder(), AppService: svc },
  });
  activate(cds);
  await cds.emit('served');
  const askHandlers = svc._on.filter(h => h.event === 'askAbout');
  assert.equal(askHandlers.length, 0);
  // search handler still there
  assert.ok(svc._on.some(h => h.event === 'searchByMeaning'));
});

test('askAbout handler: custom action name from @rag.actions.ask', async () => {
  const def = makeSuppliersEntity({ actions: { ask: 'answerAbout' } });
  const svc = makeFakeService('AppService');
  const chatter = makeChatterEmbedder('Answer.');
  const cds = makeFakeCds({
    definitions: { 'AppService.Suppliers': def },
    services: { llm: chatter, AppService: svc },
    tables: { 'AppService.Suppliers': [{ ID: 'sup-1', name: 'X', description: 'y' }] },
  });
  activate(cds);
  await cds.emit('served');
  await svc._dispatchAfter('CREATE', 'AppService.Suppliers', { ID: 'sup-1', name: 'X', description: 'y' });
  const result = await svc._dispatchAction('answerAbout', 'AppService.Suppliers', {
    data: { query: 'q' },
  });
  assert.equal(result.answer, 'Answer.');
});
