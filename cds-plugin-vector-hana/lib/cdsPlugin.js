/**
 * CAP integration for @rag-annotated entities.
 *
 *   @rag: {
 *     fields:    ['name', 'description'],  // required — projected into embedding text
 *     dimension: 768,                       // required — embedding vector size
 *     provider:  'llm',                     // optional — cds.services[provider] alias for the embedder (default: 'llm')
 *     chatter:   'llm',                     // optional — same alias for askAbout() chat calls (default: same as provider)
 *     store:     'sqlite',                  // optional — 'sqlite' | 'hana' (default: 'sqlite')
 *     table:     '<derived>',               // optional — vector table name (default: last segment of entity, lowercased + '_vec')
 *     topK:      5,                          // optional — default topK for search
 *     idField:   'ID',                       // optional — key field on the entity to use as vector id (default: 'ID')
 *   }
 *   entity Suppliers { key ID: UUID; name: String; description: LargeString; }
 *
 * What activate() does after `cds.on('served')`:
 *  - Walks cds.model.definitions, picks every entity with a truthy @rag
 *  - Builds a VectorStore per annotated entity and calls init()
 *  - Registers `after CREATE|UPDATE` + `before DELETE` handlers so the store
 *    stays in sync with the entity's rows automatically
 *  - Returns a plugin handle exposing:
 *      getStore(entityName)                                    → VectorStore
 *      searchByMeaning({ entity, query, topK, filter })         → hits
 *      askAbout({ entity, query, topK, filter, ...chatOpts })   → { answer, hits, raw }
 *      backfill(entityName)                                    → re-index all rows
 *
 * The factory takes `cds` as an argument (not a module require) so tests can
 * inject a hand-rolled fake — no @sap/cds install needed to unit-test.
 */
function activate(cds, options = {}) {
  const log = (cds.log && cds.log('vector-hana')) || silentLog();
  const stores = new Map(); // entityName -> VectorStore
  const configs = new Map(); // entityName -> normalized @rag config

  const StoreClasses = options.stores ?? {
    sqlite: require('./backends/sqlite'),
    hana: require('./backends/hana'),
  };
  const RAG = options.RAG ?? require('./rag');

  // Phase 1 (model mutation): declare bound OData actions on annotated
  // entities BEFORE services are built. This has to happen at `loaded` (or
  // immediately, if the model is already loaded) so the OData adapter sees
  // the new actions when it constructs each service's routing table.
  //
  // Idempotent: if the entity already has an `actions[name]`, we skip.
  const mutateCsn = () => {
    if (!cds.model || !cds.model.definitions) return;
    for (const [name, def] of Object.entries(cds.model.definitions)) {
      if (!def || def.kind !== 'entity') continue;
      const rag = def['@rag'];
      if (!rag || rag.enabled === false) continue;
      let config;
      try {
        config = normalizeConfig(rag, name);
      } catch { continue; } // errors are reported during phase 2
      try {
        declareActions(name, def, config, log);
      } catch (err) {
        log.error(`@rag: ${name}: action declaration failed: ${err.message}`);
      }
    }
  };
  if (cds.model?.definitions) mutateCsn();
  cds.on('loaded', mutateCsn);

  cds.on('served', async () => {
    if (!cds.model || !cds.model.definitions) {
      log.warn('@rag: cds.model.definitions not available at served — skipping');
      return;
    }
    for (const [name, def] of Object.entries(cds.model.definitions)) {
      if (!def || def.kind !== 'entity') continue;
      const rag = def['@rag'];
      if (!rag || rag.enabled === false) continue;

      let config;
      try {
        config = normalizeConfig(rag, name);
      } catch (err) {
        log.error(`@rag: invalid config on ${name}: ${err.message} — skipping entity`);
        continue;
      }

      let embedder;
      try {
        embedder = resolveService(cds, config.provider, 'embedder');
      } catch (err) {
        log.error(`@rag: ${name}: ${err.message} — skipping entity`);
        continue;
      }

      const StoreClass = StoreClasses[config.store];
      if (!StoreClass) {
        log.error(`@rag: ${name}: unknown store kind "${config.store}" (want: ${Object.keys(StoreClasses).join(', ')}) — skipping entity`);
        continue;
      }

      const store = new StoreClass({
        embed: embedder,
        dimension: config.dimension,
        table: config.table,
        ...(config.storeOptions ?? {}),
      });
      try {
        await store.init();
      } catch (err) {
        log.error(`@rag: ${name}: store init failed: ${err.message} — skipping entity`);
        continue;
      }

      stores.set(name, store);
      configs.set(name, config);
      log.info(`@rag: ${name} → ${config.store}/${config.table} (dim=${config.dimension}, fields=[${config.fields.join(',')}])`);

      wireHandlers({ cds, entityName: name, def, store, config, log });
      wireActionHandlers({ cds, entityName: name, def, store, config, log, plugin: publicApi });
    }
  });

  const publicApi = {
    getStore(entityName) { return stores.get(entityName); },

    async searchByMeaning({ entity, query, topK, filter } = {}) {
      const store = mustStore(stores, entity);
      const cfg = configs.get(entity);
      return store.search({ text: query, topK: topK ?? cfg.topK, filter });
    },

    async askAbout(params = {}) {
      const { entity, query, topK, filter, systemInstructions, ...chatOpts } = params;
      const store = mustStore(stores, entity);
      const cfg = configs.get(entity);
      const chatter = resolveService(cds, cfg.chatter, 'chatter');
      const rag = new RAG({ llm: chatter, store });
      return rag.answer({ query, topK: topK ?? cfg.topK, filter, systemInstructions, ...chatOpts });
    },

    async backfill(entityName) {
      const store = mustStore(stores, entityName);
      const cfg = configs.get(entityName);
      const rows = await cds.run(cds.parse.cql(`SELECT * FROM ${entityName}`));
      const items = rows.map(row => buildItem(row, cfg));
      if (!items.length) return { indexed: 0 };
      await store.upsertMany(items);
      return { indexed: items.length };
    },

    // Test hooks
    _stores: stores,
    _configs: configs,
  };
  return publicApi;
}

function normalizeConfig(rag, entityName) {
  if (rag === true) throw new Error('@rag must be an object, not `true` — specify at least { fields, dimension }');
  if (!Array.isArray(rag.fields) || rag.fields.length === 0) {
    throw new Error('@rag.fields must be a non-empty array of field names');
  }
  if (typeof rag.dimension !== 'number' || rag.dimension < 1) {
    throw new Error('@rag.dimension must be a positive number (embedding vector size)');
  }
  const shortName = entityName.split('.').pop().toLowerCase();
  const store = rag.store ?? 'sqlite';
  if (store !== 'sqlite' && store !== 'hana') {
    throw new Error(`@rag.store must be 'sqlite' or 'hana', got '${store}'`);
  }
  return {
    fields: rag.fields.slice(),
    dimension: rag.dimension,
    provider: rag.provider ?? 'llm',
    chatter: rag.chatter ?? rag.provider ?? 'llm',
    store,
    table: rag.table ?? `${shortName}_vec`,
    topK: rag.topK ?? 5,
    idField: rag.idField ?? 'ID',
    storeOptions: rag.storeOptions,
    actions: normalizeActionsConfig(rag.actions),
  };
}

// `@rag.actions` shapes:
//   undefined            → { search: 'searchByMeaning' }  (default: on, default name)
//   false                → false                          (all auto-actions off)
//   { search: false }    → { search: false }              (skip searchByMeaning)
//   { search: 'foo' }    → { search: 'foo' }              (custom action name)
function normalizeActionsConfig(input) {
  if (input === false) return false;
  if (input == null) return { search: 'searchByMeaning' };
  if (typeof input !== 'object') {
    throw new Error(`@rag.actions must be false or an object, got ${typeof input}`);
  }
  const search = input.search === undefined ? 'searchByMeaning' : input.search;
  if (search !== false && (typeof search !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(search))) {
    throw new Error(`@rag.actions.search must be a valid identifier or false, got ${JSON.stringify(search)}`);
  }
  return { search };
}

function resolveService(cds, alias, role) {
  const svc = cds.services?.[alias];
  if (!svc) throw new Error(`cds.services['${alias}'] not found (${role} lookup) — check cds.requires.${alias} in your config`);
  return svc;
}

function mustStore(stores, entity) {
  if (!entity) throw new Error('entity is required');
  const store = stores.get(entity);
  if (!store) throw new Error(`no @rag store registered for entity '${entity}' — check the @rag annotation and that cds.on('served') has fired`);
  return store;
}

function buildItem(row, config) {
  const id = row[config.idField];
  if (id == null) {
    throw new Error(`@rag: row missing id field '${config.idField}' — cannot upsert`);
  }
  const parts = [];
  for (const f of config.fields) {
    const v = row[f];
    if (v != null && v !== '') parts.push(String(v));
  }
  const text = parts.join('\n\n');
  const metadata = { entity: config.entityName ?? undefined };
  return { id: String(id), text, metadata: text ? metadata : null };
}

// Mutate the entity's CSN to declare a collection-bound OData action per
// @rag config. Runs at `cds.on('loaded')` — before service construction —
// so the OData adapter sees the action when it builds routes.
function declareActions(entityName, def, config, log) {
  if (config.actions === false) return;
  const searchName = config.actions?.search;
  if (searchName === false) return;

  def.actions = def.actions ?? {};
  if (def.actions[searchName]) {
    log.warn(`@rag: ${entityName}: action '${searchName}' already declared — skipping OData declaration`);
    return;
  }
  def.actions[searchName] = {
    kind: 'action',
    params: {
      query: { type: 'cds.String' },
      topK: { type: 'cds.Integer' },
    },
    returns: { items: { type: entityName } },
    '@Common.Label': `Search ${entityName.split('.').pop()} by meaning`,
  };
}

// Register the OData action handler on the entity's service. Called at
// `cds.on('served')` after the store is up.
function wireActionHandlers({ cds, entityName, def, store, config, log, plugin }) {
  if (config.actions === false) return;
  const searchName = config.actions?.search;
  if (searchName === false) return;

  const svcName = def._service?.name ?? null;
  const service = svcName ? cds.services?.[svcName] : findService(cds, entityName);
  if (!service || typeof service.on !== 'function') {
    log.warn(`@rag: ${entityName}: no service.on() available (skipping ${searchName} handler)`);
    return;
  }

  const entityRef = def.name ?? entityName;
  service.on(searchName, entityRef, async (req) => {
    const query = req?.data?.query;
    if (!query || typeof query !== 'string') {
      if (typeof req.reject === 'function') return req.reject(400, 'query is required');
      throw new Error('query is required');
    }
    const topK = req?.data?.topK ?? config.topK;
    let hits;
    try {
      hits = await plugin.searchByMeaning({ entity: entityName, query, topK });
    } catch (err) {
      log.error(`@rag: ${entityName}: ${searchName} handler failed: ${err.message}`);
      if (typeof req.reject === 'function') return req.reject(500, `search failed: ${err.message}`);
      throw err;
    }
    if (!hits.length) return [];
    const ids = hits.map(h => h.id);
    const rows = await projectToEntity(cds, entityRef, config.idField, ids);
    // Preserve hit-rank order (SQL WHERE ID IN (...) doesn't guarantee order).
    const byId = new Map(rows.map(r => [String(r[config.idField]), r]));
    return ids.map(id => byId.get(String(id))).filter(Boolean);
  });
}

async function projectToEntity(cds, entityRef, idField, ids) {
  if (typeof cds.run !== 'function' || !cds.SELECT) {
    // Older CAP / test doubles that don't expose SELECT — fall back to a
    // read on the service if available.
    return [];
  }
  return cds.run(cds.SELECT.from(entityRef).where({ [idField]: { in: ids } }));
}

function wireHandlers({ cds, entityName, def, store, config, log }) {
  const svcName = def._service?.name ?? null;
  const service = svcName ? cds.services?.[svcName] : findService(cds, entityName);
  if (!service || typeof service.after !== 'function' || typeof service.before !== 'function') {
    log.warn(`@rag: ${entityName}: no service handlers available (no CRUD sync will happen)`);
    return;
  }
  const entityRef = def.name ?? entityName;

  service.after(['CREATE', 'UPDATE'], entityRef, async (data) => {
    const rows = Array.isArray(data) ? data : [data];
    const items = rows
      .map(row => buildItem(row, config))
      .filter(item => item.text.length > 0);
    if (!items.length) return;
    try {
      if (items.length === 1) await store.upsert(items[0]);
      else await store.upsertMany(items);
    } catch (err) {
      log.error(`@rag: ${entityName}: upsert after CREATE/UPDATE failed: ${err.message}`);
    }
  });

  service.before('DELETE', entityRef, async (req) => {
    const id = req?.data?.[config.idField] ?? req?.params?.[0]?.[config.idField] ?? req?.params?.[0];
    if (id == null) return;
    try {
      await store.delete({ id: String(id) });
    } catch (err) {
      log.error(`@rag: ${entityName}: delete failed: ${err.message}`);
    }
  });
}

function findService(cds, entityName) {
  if (!cds.services) return null;
  const prefix = entityName.includes('.') ? entityName.split('.')[0] : null;
  if (prefix && cds.services[prefix]) return cds.services[prefix];
  for (const svc of Object.values(cds.services)) {
    if (svc?.entities?.[entityName]) return svc;
  }
  return null;
}

function silentLog() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

module.exports = { activate, normalizeConfig, buildItem, declareActions };
