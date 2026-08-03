# Changelog

All notable changes to `@saptarishi/cds-plugin-vector-hana`.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] — 2026-08-03

### Added

- **`@rag` CDS annotation — one line on your entity, auto-indexed vector search on save/update/delete.** The package now ships a real CAP plugin (`cds-plugin.js`) that inspects the compiled model on `cds.on('served')`, builds a `VectorStore` per `@rag`-annotated entity, and wires CRUD handlers so the vector table stays in lockstep with the entity's rows — the developer writes zero glue code.

  ```cds
  entity Suppliers {
    key ID     : UUID;
    name       : String;
    description: LargeString;
    country    : String;
  } @rag: {
    fields:    ['name', 'description'],  // concatenated + embedded per row
    dimension: 768,                      // your embedding model's vector size
    store:     'sqlite',                 // or 'hana'
    topK:      5,                        // default topK for searchByMeaning
  };
  ```

  ```js
  // Anywhere in a CAP handler:
  const hits    = await cds.vectorHana.searchByMeaning({ entity: 'AppService.Suppliers', query: 'steel coils' });
  const { answer, hits: sources } = await cds.vectorHana.askAbout({
    entity: 'AppService.Suppliers',
    query:  'Which suppliers ship steel from Europe?',
  });
  ```

- **Plugin handle at `cds.vectorHana`** — same ergonomic pattern as the SAP-shipped `cds.mtx` / `cds.auth` handles. Four operations:
  - `getStore(entityName)` — the underlying `VectorStore` (bypass this API and drop to raw `search()` / `upsert()` when you need to).
  - `searchByMeaning({ entity, query, topK?, filter? })` → `SearchHit[]`.
  - `askAbout({ entity, query, topK?, filter?, systemInstructions?, ...chatOpts })` → `{ answer, hits, raw }`. Uses `RAG` under the hood; the extra fields (`model`, `maxTokens`, `thinking`, ...) are forwarded to the chat provider.
  - `backfill(entityName)` — re-index every row of an entity, useful after enabling `@rag` on an existing table or bulk-imports that bypassed the service layer.

- **Automatic CRUD sync.** Handlers registered per annotated entity:
  - `after CREATE|UPDATE` → build text from `@rag.fields`, embed, upsert. Rows where every projected field is empty are silently skipped (no dead vectors).
  - `before DELETE` → remove the id from the store before CAP deletes the row (so a failing delete leaves both sides in sync).

- **Provider aliases via `cds.services[...]`.** `@rag.provider` names an alias into `cds.requires.<alias>` — the same lookup CAP uses for every other service. Defaults to `'llm'`. `@rag.chatter` overrides just the LLM used for `askAbout()` when you want cheap-embed + smart-chat (e.g., embed with `ollama`, chat with `anthropic`).

- **Fail-safe activation.** Every phase (bad `@rag` config, missing provider alias, unknown store kind, store `init()` failure) logs a specific error and skips that ONE entity — the rest of the app still boots. Silent-fail on plugin activation is the SAP-plugin convention (see `@sap/cds-mtx`).

- 26 new tests (71 total): `normalizeConfig` (7), `buildItem` (4), `activate` wiring including error paths (5), CRUD sync (5), `searchByMeaning` (3), `askAbout` including chatter option forwarding (2). Runs with a hand-rolled fake `cds` — no `@sap/cds` install required, matching the existing test isolation model.

- TS defs for `CdsRagPlugin`, `ActivateCdsPluginOptions`, and the `activateCdsPlugin(cds, options?)` factory. Power users can activate the plugin manually (embedded runtimes, tests) without going through `cds-plugin.js`.

### Notes

- Additive — the existing `VectorStore` / `HanaVectorStore` / `SqliteVectorStore` / `RAG` API is unchanged. `^0.4` consumers can bump to `^0.5` with zero code changes.
- `@sap/cds` is now declared as an **optional** peer dep. The `RAG` and `VectorStore` classes still work standalone (no cds required); the CDS plugin obviously needs cds to be present at runtime.
- Zero new production dependencies. The CDS plugin is pure composition over the existing `VectorStore` / `RAG` classes.

## [0.4.0] — 2026-08-03

### Added

- **`RAG` class — turnkey retrieval-augmented-generation on top of any `VectorStore` + `@saptarishi/cds-plugin-llm` provider.** Composes `store.search()` and `llm.chat()/stream()` into a single call that retrieves, augments the prompt with citation-tagged context, and generates an answer. No new dependencies.

  ```js
  const { RAG, SqliteVectorStore } = require('@saptarishi/cds-plugin-vector-hana');
  const { OllamaLLMService } = require('@saptarishi/cds-plugin-llm');

  const embedder = new OllamaLLMService({ credentials: { embeddingModel: 'nomic-embed-text' } });
  const chatter  = new OllamaLLMService({ credentials: { model: 'qwen2.5:14b' } });

  const store = new SqliteVectorStore({ embed: embedder, dimension: 768, table: 'policies' });
  await store.init();
  await store.upsertMany([
    { id: 'refund',   text: 'Refunds are accepted within 30 days.', metadata: { category: 'policy' } },
    { id: 'shipping', text: 'Shipping is free over 50 EUR.',         metadata: { category: 'policy' } },
  ]);

  const rag = new RAG({ llm: chatter, store });
  const { answer, hits } = await rag.answer({ query: 'How long do I have to return an item?' });
  //  → answer: "You have 30 days to return an item [refund]."
  //    hits:   [ { id: 'refund', score: 0.82, ... }, { id: 'shipping', score: 0.41, ... } ]
  ```

  API surface (`lib/rag.js`):
  - `new RAG({ llm, store, systemInstructions?, promptTemplate? })` — llm needs `chat()`; store needs `search()`; both are validated at construction.
  - `retrieve({ query, topK = 5, filter })` — thin, semantically-named pass-through to `store.search()`.
  - `augment({ query, hits, systemInstructions })` — builds the `{ system, messages }` payload without calling the LLM. Useful when the caller wants to prepend a chat history or run their own middleware first.
  - `answer({ query, topK, filter, systemInstructions, ...chatOpts })` — full RAG in one call. Returns `{ answer: string, hits: SearchHit[], raw: unknown }`. Extra fields (`model`, `maxTokens`, `thinking`, ...) are forwarded verbatim to `llm.chat()`; RAG-specific fields (`query`, `topK`, `filter`, `systemInstructions`) are stripped so provider SDKs don't see them.
  - `stream({ query, ... })` — same as `answer()` but returns `{ hits, stream }`. **Hits resolve before the first token**, so a UI can render the source list while the answer streams in.

- **Provider-agnostic reply extraction.** `answer()` normalizes the LLM reply to a plain string regardless of provider shape (plain string, `{ text }`, Anthropic content blocks, Ollama `{ message: { content } }`, OpenAI `choices[0].message.content`). The full envelope is still exposed on `raw` for callers that need usage/metadata.

- **Default prompt tells the model to cite by `[id]`.** The default system instruction is "answer from context only, cite sources by their bracketed id"; the default context template renders each hit as `[hit_id] (metadata: {...}): hit_text`. Both are overridable per-instance or per-call. `defaultPromptTemplate` and `DEFAULT_SYSTEM_INSTRUCTIONS` are exported so callers can compose with the built-ins.

- 21 new tests (45 total): constructor validation (llm/store/methods), `retrieve` defaults + validation, `augment` with default + custom template + empty hits + per-call override, `answer` end-to-end + reply-shape normalization (5 provider shapes) + option forwarding + filter pass-through, `stream` streams and returns hits eagerly + rejects when llm has no `stream()`.

### Notes

- Additive — the existing `VectorStore` / `HanaVectorStore` / `SqliteVectorStore` API is unchanged. `^0.3` consumers can bump to `^0.4` with zero code changes.
- Zero new dependencies. `RAG` is 100% composition over the surfaces the two plugins already expose.

## [0.3.0] — 2026-07-29

### Added

- **`index` option on `HanaVectorStore` — creates an HNSW vector index at table-creation time.** Required for scaling beyond a few thousand rows: HANA's HNSW graph index enables approximate-nearest-neighbor (ANN) search that stays fast even on millions of vectors, versus the exhaustive scan of vanilla `COSINE_SIMILARITY`. Requires HANA Cloud QRC 2/2024 or later.
  - `index.type` — must be `'hnsw'`
  - `index.similarity` — `'cosine'` (default, `COSINE_SIMILARITY`) or `'l2'` (`L2DISTANCE`)
  - `index.name` — explicit index name (default: `'<table>_<embeddingColumn>_HNSW_IDX'`)
  - `index.buildParameters` — dict serialized into HANA's `BUILD PARAMETERS ('k=v,...')` clause (common keys: `ef_construction`, `M`)
- 5 new tests (24 total) verifying: default naming + `COSINE_SIMILARITY`, custom `L2DISTANCE` + name + build params, no-op when `index` is unset, constructor validation of `type`/`similarity`.

### Notes

- Additive — existing tables and existing `HanaVectorStore` constructions without `index` behave exactly as in 0.2.0.

## [0.2.0] — 2026-07-29

### Added

- **`upsertMany(items)` batch API.** Embeds all `text` values in a single `embed()` round-trip (providers that support `input: string[]` return N vectors at once) and persists via a backend-specific batched path.
  - **SQLite backend**: prepared-statement inside a `db.transaction()` — atomic and fast.
  - **HANA backend**: multi-row `MERGE INTO` via `UNION ALL` of `DUMMY` SELECTs. Chunked at `upsertChunkSize` (default 100) to cap query text size / parameter count.
- New tests (19 total): SQLite batch insert / update / validation / provider-count mismatch; HANA multi-row MERGE SQL shape + chunking behavior.
- TS defs: `upsertMany` on `VectorStore`, `upsertChunkSize` on `HanaVectorStoreOptions`.

### Notes

- Additive — existing `upsert()` unchanged. Consumers on `^0.1` can bump to `^0.2` with zero code changes.

## [0.1.0] — 2026-07-29

Initial release.

### Added

- **`VectorStore` abstract base class** — defines the `init` / `upsert` / `search` / `delete` interface. Delegates embedding computation to any `@saptarishi/cds-plugin-llm` provider instance.
- **`SqliteVectorStore` backend** — stores vectors as JSON in a TEXT column; cosine similarity computed in JavaScript at query time. Uses `better-sqlite3` (optional peer dep). Integration-tested end-to-end (7 tests).
- **`HanaVectorStore` backend** — SAP HANA Cloud's native `REAL_VECTOR(N)` column type + `COSINE_SIMILARITY()` function. `MERGE INTO` for upsert semantics; `TOP N ... ORDER BY score DESC` for ranked retrieval; `JSON_VALUE()` for metadata filters. Uses `hdb` client (optional peer dep, pure JS — no native compile). Wire-protocol-verified against a mocked `hdb` (6 tests) but not yet live-verified against a real HANA Cloud instance.
- TypeScript definitions in `lib/index.d.ts` (typed `SearchHit<M>` generic on metadata shape).
- README with SQLite + HANA usage, backend comparison table, and the raw SQL that the HANA backend generates (for reviewers who want to see the wire protocol).
