# Changelog

All notable changes to `@saptarishi/cds-plugin-vector-hana`.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.10.0] — 2026-08-05

### Added

- **`createQueryExpander({ llm, strategy, n?, ... })` — query-side amplification.** The 0.9.0 CHANGELOG explicitly noted "query reformulation is not included" — this fills the gap. Two strategies:

  - `'hyde'` (default) — **Hypothetical Document Embeddings.** The LLM writes a plausible short answer to the question; both the question AND the hypothetical answer get embedded and retrieved on. Works because a plausible answer clusters near real source documents in embedding space even when the question doesn't. Boosts recall on abstract / under-specified queries where the vocabulary gap between question and source is large.
  - `'multi-query'` — Generate N distinct paraphrases of the question, retrieve for each in parallel, fuse via RRF. Boosts recall on ambiguous queries by covering multiple phrasings the user might not have used.

  ```js
  const { createQueryExpander, llmRerank, RAG } = require('@saptarishi/cds-plugin-vector-hana');

  const rag = new RAG({
    llm, store,
    mode:   'hybrid',
    expand: createQueryExpander({ llm, strategy: 'hyde' }),
    rerank: llmRerank({ llm }),
  });
  const { answer, hits } = await rag.answer({ query: 'refund policy?', topK: 5 });
  ```

- **RAG.expand hook**. New `expand?: QueryExpander` option on the `RAG` constructor. `retrieve()` now:
  1. Calls `expand(query)` → gets `string[]` of related queries (typically 2-4).
  2. Runs each through `store.search()` or `store.hybridSearch()` in parallel with `candidateK = max(topK * 4, 10)`.
  3. Fuses all lists via RRF.
  4. Optionally reranks with `rerank`.
  5. Returns top-K.

  Per-query `candidateK` is only expanded when there's more than one query — the single-query fast path (no expander) is unchanged from 0.9.0.

- **Robust to LLM failures.** Any error / empty reply from the expander collapses back to `[originalQuery]`. Malformed multi-query responses (< N valid lines) still produce the original + whatever parsed. Nothing worse than "no expansion" ever ships.

- **Customization**:
  - `model`, `maxTokens` — passed through to the expansion LLM call.
  - `systemInstructions` — override the strategy's default rubric.
  - `buildUserPrompt: ({ query, n }) => string` — write your own template.

- **Line-cleaning for multi-query**: leading `1.`, `2)`, `-`, `*`, `•`, and similar markers are stripped from each paraphrase. Users don't need to add "no numbering" to their custom system prompts.

- Exports: `createQueryExpander`. TS defs added: `QueryExpander`, `QueryExpanderOptions`, plus `expand?: QueryExpander` on `RAGOptions` and `readonly expand: QueryExpander | null` on the `RAG` class.

- **21 new tests (182 total)**: construction validation (llm/strategy/n bounds), HyDE (returns `[query, hypothetical]`, LLM error fallback, empty-reply fallback, system-prompt shape), multi-query (parse N lines, strip bullets/numbering, cap at N even when LLM over-produces, LLM error fallback), customization (model + maxTokens forwarding, systemInstructions override, buildUserPrompt receives `{ query, n }`), RAG integration (expand called once per retrieve, results fused across queries, expand=null skips fusion, expand + rerank compose, expander throw → falls back cleanly, empty-array reply → falls back), constructor rejection of non-function expand, and one end-to-end integration test wiring HyDE → hybrid → llmRerank → answer with a real SqliteVectorStore + mock LLM.

### Notes

- Additive — `^0.9` consumers bump to `^0.10` with zero code changes. `expand` is opt-in; nothing changes for callers not using it.
- The full recommended pipeline is now: **expand (HyDE or multi-query) → hybrid retrieve per query → RRF fuse → llmRerank → augment prompt → LLM answer**. Every stage is a separately shipped primitive that you can enable or disable independently.
- Latency-wise: HyDE adds one LLM call (the hypothetical answer). Multi-query adds one LLM call PLUS N-fold retrieval fan-out. Point the expander at a fast small model (Haiku, Gemini Flash, Groq's `llama-3.1-8b-instant`) and the added latency stays under a second even in the worst case.
- HyDE and multi-query are complementary; a future release may add `strategy: 'both'` that runs both and fuses everything. For now, pick one — HyDE typically wins on abstract/conceptual queries, multi-query on entity/keyword queries.

## [0.9.0] — 2026-08-05

### Added

- **`llmRerank({ llm, model?, batchSize?, systemInstructions?, buildUserPrompt? })` — built-in LLM reranker factory.** 0.8.0 shipped the `RAG.rerank` hook as pluggable infrastructure with no built-in impl; this fills the gap. Given a query and a list of retrieved hits, the returned `Reranker` asks the LLM to score each hit on a 0-10 scale via structured output, then re-sorts descending and attaches a `rerankScore` field.

  ```js
  const { llmRerank, RAG } = require('@saptarishi/cds-plugin-vector-hana');

  const rerank = llmRerank({
    llm,                         // required — any LLMService with chat()
    model: 'claude-haiku-4-5',   // optional — cheap fast model recommended for reranking
    batchSize: 20,               // optional — hits per LLM call (default 20)
  });

  const rag = new RAG({ llm, store, mode: 'hybrid', rerank });
  const { answer, hits } = await rag.answer({ query: 'refund policy?', topK: 5 });
  // hits sorted by LLM relevance score; each hit gains a rerankScore field
  ```

- **Robust to LLM failures.** Malformed JSON, throwing calls, or partial responses never regress the answer path below "vanilla hybrid":
  - LLM throws → all hits get the neutral score 5 (original order preserved).
  - Malformed JSON → parse falls back to the original order.
  - Indices missing from the response → those hits get the neutral score 5.
  - Scores outside `[0, 10]` are clamped.

- **Batching** for long candidate lists — hits are split into `batchSize`-sized slices and scored in parallel Promise.all calls. Default 20 fits comfortably in most models' structured-output limits and keeps per-batch latency low.

- **Structured output.** Every rerank call sets `format` to a `{ scores: [{ index, score }] }` schema, so providers that support strict JSON mode (OpenAI, Anthropic, Gemini) never need lenient parsing. The plugin's `data`-shape output from Anthropic is honored on the fast path.

- **Custom prompt hook.** `buildUserPrompt: ({ query, hits, startIndex }) => string` for domain-specific scoring criteria — e.g. "prefer contracts still valid this quarter" or "weight the terms column more than the supplier name". `systemInstructions` overrides the default scoring rubric.

- **Passage truncation** to 500 chars per hit inside the default prompt so a large `hit.text` doesn't blow the context window. Consumers with longer passages can override `buildUserPrompt` to control this precisely.

- Exports: `llmRerank` + `DEFAULT_BATCH_SIZE`. TS defs added — `LlmRerankOptions` — with `@since 0.9.0`.

- 19 new tests (161 total): construction validation (llm requirement, batchSize bounds), happy path (score-based sorting + `rerankScore` field + single LLM call for small batches + model/maxTokens forwarding + structured-output schema shape), batching (multiple LLM calls with correct global-index translation), robustness (missing indices default to 5 with original order preserved, LLM throw → fallback, malformed JSON → fallback, JSON embedded in a plain-string reply parsed, scores clamped to [0,10], empty hits + empty query short-circuit before the LLM call), prompt shape (default lists passages by index, systemInstructions override, custom buildUserPrompt gets `{ query, hits, startIndex }`), RAG integration (rerank sorts hits + the answer prompt then cites the re-sorted top).

### Notes

- Additive — `^0.8` consumers bump to `^0.9` with zero code changes. `llmRerank` is opt-in via `new RAG({ ..., rerank: llmRerank({ llm }) })`; nothing changes for callers not using it.
- Recommended pairing: **hybrid retrieval → llmRerank(cheap model)**. Hybrid pulls a wider candidate set with `candidateK` (default 4×topK); reranker scores them and picks the winners. Latency stays manageable if you point the reranker at a fast small model (Haiku, Gemini Flash, `llama-3.1-8b-instant`) — the rerank prompt is short and structured.
- The `llmRerank` hook shipped here is for post-retrieval reranking. Query reformulation ("HyDE" / multi-query expansion) is a separate concern, not included in this release — write your own preprocessing step if you need it.

## [0.8.1] — 2026-08-05

### Fixed

- **Auto-declared OData actions (`searchByMeaning`, `askAbout`) were emitted as instance-bound** — the EDMX had `Parameter Name="in" Type="ProcurementService.SupplierContracts"` (single entity) instead of `Collection(...)`. Callers who tried the collection URL (`POST /Suppliers/Service.searchByMeaning`) got `Error: Action ... must be called on a single instance`; the actions only worked via `POST /Suppliers(<dummy-id>)/Service.searchByMeaning` — a UX regression nobody caught because the plugin's own tests only checked the CSN mutation, not what CAP compiled to EDMX.
- Fix: add `'@cds.odata.bindingparameter.collection': true` to both auto-declared actions. Verified via `cds.compile.to.edmx()` — the parameter now becomes `Type="Collection(...)"` and both URL patterns work. This was already the intent in 0.6.0 (see the CHANGELOG entry there — "collection-bound `searchByMeaning`"); the CSN just missed the specific annotation CAP requires to emit `Collection`.
- 1 new test (142 total) pinning the annotation on both `searchByMeaning` and `askAbout`.

### Notes

- Behavior on the CAP handler side is unchanged — the handler always looked up the store by entity name (ignoring the instance id). This fix only changes what CAP compiles into the OData metadata + which URL pattern it accepts. Existing consumers who worked around the bug by supplying a dummy id will still work after this fix; the collection URL now also works.

## [0.8.0] — 2026-08-05

### Added

- **Hybrid retrieval via Reciprocal Rank Fusion (RRF)** — new `store.hybridSearch()` runs vector + keyword in parallel and fuses per-list ranks. Directly improves recall on messy S/4 text where cosine-only misses: SKUs, PO numbers, exact identifiers, jargon queries.

  ```js
  const hits = await store.hybridSearch({
    text: 'refund window PO-4500000123',
    topK: 5,
    candidateK: 20,        // fetch top-20 from each retrieval before fusion
    vectorWeight: 1,
    keywordWeight: 1,
    k: 60,                 // canonical RRF constant from Cormack et al. 2009
    filter: { region: 'EMEA' },
  });
  // → hits[i].fusionScore alongside the original .score
  ```

- **`store.keywordSearch()`** — new public method + `_keywordSearch` backend hook. Naive token-match count on the text column (case-insensitive substring LIKE, one hit per query token). Implemented on both SqliteVectorStore and HanaVectorStore. Backends without a keyword impl (custom stores extending the base class) fall back to `[]` — hybrid degrades to vector-only, no error. For production scale, override `_keywordSearch` with a real FTS index (SQLite FTS5, HANA CONTAINS(), etc.).

- **`reciprocalRankFusion({ lists, weights?, k? })`** — pure utility exported from `lib/rrf.js`. Handles doc canonicalization by id, merges metadata across lists (later lists enrich fields the earlier didn't have), preserves the first-seen list's text and score. Weights let callers bias one retrieval over another; `k` controls how much the multi-list bonus dominates over single-list top-ranks.

- **RAG hybrid mode + rerank hook**:
  ```js
  const rag = new RAG({
    llm, store,
    mode: 'hybrid',               // 'vector' (default) or 'hybrid'
    rerank: async (hits, query) => // optional post-retrieval hook
      llmRerankOrCrossEncoder(hits, query),
  });
  const { answer, hits } = await rag.answer({ query: '...', mode: 'hybrid' });
  ```
  The reranker runs after fusion. Return `hits` in the desired final order; RAG trims to `topK` if the reranker returns more than that.

- **`@rag.search` annotation** — `'vector'` (default) or `'hybrid'`. Opts an annotated entity's `cds.vectorHana.searchByMeaning()` and `.askAbout()` into hybrid retrieval at every call site without any handler code:
  ```cds
  entity Suppliers {
    key ID     : UUID;
    name       : String;
    description: LargeString;
  } @rag: {
    fields:    ['name', 'description'],
    dimension: 768,
    search:    'hybrid',           // ← new
  };
  ```
  Per-call override via `plugin.searchByMeaning({ entity, query, mode: 'vector' })` still works if a specific query needs one strategy over the other.

- **New exports**: `reciprocalRankFusion`, `tokenize` (from `lib/VectorStore.js`). TS defs added: `HybridSearchParams`, `HybridSearchHit`, `RetrievalMode`, `Reranker`.

- **30 new tests (141 total)**: RRF utility (validation, basic fusion, weight bias, multi-list bonus, metadata merging, null-id handling, fusionScore surfacing), SqliteVectorStore keyword search (token ranking, topK cap, metadata filter, SKU-style exact match, invalid inputs, all-short-tokens edge case), hybrid search (vector+keyword combination, candidateK, weight bias, no-keyword-impl fallback, input validation), RAG hybrid mode (routing to hybridSearch, per-call override, missing-hybridSearch error), RAG rerank (hook invocation, over-topK trimming), constructor validation (bad mode / rerank).

### Notes

- Additive — `store.search()` shape is unchanged; existing consumers can stay on it. `hybridSearch()` is opt-in. `^0.7` consumers can bump to `^0.8` with zero code changes.
- The SQLite `_keywordSearch` uses `LIKE` for substring matching — deliberately dumb so exact SKUs / order numbers (like `PO-4500000123`, `sup-42`) match literally without needing stemming or a stopword list. For high-volume production, override with an FTS5 virtual table.
- The HANA `_keywordSearch` uses the same `LIKE` fallback for portability. On a production HANA with a text index, override with `CONTAINS()` for fuzzy + linguistic-aware matching.
- The `rerank` hook is opt-in and pluggable — this release ships the infrastructure but no built-in reranker. Consumers can plug their own LLM-scoring, cross-encoder inference, or business-logic filter. A future release may ship an `llmRerank({ llm })` factory.

## [0.7.4] — 2026-08-03

### Fixed

- **Auto-declared OData actions never actually appeared in `$metadata`.** The plugin's CSN mutation ran at `cds.on('loaded')` — but CAP fires `loaded` BEFORE assigning `cds.model = m`. The plugin's guard `if (!cds.model?.definitions) return;` was falsy, so `mutateCsn` silently no-op'd and the actions were never declared. The mutation code, the action shape, the type synthesis — all correct. Just never ran. Fix: read the model from the `loaded` event argument (which CAP always passes as the raw model) instead of relying on `cds.model` being assigned yet. Verified end-to-end: `Action Name="searchByMeaning"` and `Action Name="askAbout"` now appear in the OData $metadata document.

### Notes

- Together with 0.7.1 (flat-annotation form), 0.7.2 (quiet reboots), and 0.7.3 (lazy `cds.connect.to`), this is the fourth patch closing gaps discovered while wiring `@rag` into a real CAP app (`joule-project-api`). If you were on any of 0.7.0–0.7.3 and wondered why nothing appeared on the OData surface — bump to 0.7.4 and it will.

## [0.7.3] — 2026-08-03

### Fixed

- **`@rag` entities were skipped at boot with "cds.services['<alias>'] not found".** The plugin looked up the embedder via `cds.services[alias]`, but CAP populates that dict lazily on first `cds.connect.to(alias)`. When the plugin's `served` handler ran before any app code had touched the service, the lookup returned undefined and the plugin skipped the entity — meaning `@rag`-annotated entities never got their vector store or OData actions in production apps that didn't happen to touch the LLM elsewhere. Now `resolveService()` falls back to `cds.connect.to(alias)` (awaited) to force-instantiate the service, matching the standard CAP pattern. Test doubles that pre-populate `cds.services` still work — they hit the fast path.

## [0.7.2] — 2026-08-03

### Fixed

- **Silenced spurious "action already declared" warnings on normal boots.** `activate()` calls the CSN mutation twice — once immediately (in case the model is already loaded) and once via `cds.on('loaded')`. When both fired against the same model, the second run hit its own already-declared actions and logged idempotency warnings, even though nothing was wrong. Now the plugin tracks which entity defs it has already mutated via a `WeakSet` and skips them silently on re-entry. Genuine collisions (a user-declared `actions.searchByMeaning` or a competing plugin) still warn — that's a real signal worth surfacing.

## [0.7.1] — 2026-08-03

### Fixed

- **`@rag` annotation was silently ignored in real CAP apps.** The CDS compiler flattens `@rag: { fields: [...], dimension, ... }` into top-level keys `@rag.fields`, `@rag.dimension`, ..., which the plugin's `def['@rag']` check couldn't see — so the plugin walked past every annotated entity without doing anything. Test doubles that passed a nested object worked fine, but every actual `cds compile`-produced CSN hit the flat form. Both forms are now supported:
  - Nested (from `cds.linked` or hand-authored CSN): `def['@rag'] = { ... }`
  - Flat (from `cdsc` or the CAP runtime pre-`linked`): `def['@rag.fields'] = ...`, `def['@rag.dimension'] = ...`
  - Flat with nested keys: `def['@rag.actions.search'] = 'findX'` reconstructs into `actions: { search: 'findX' }`
- New exported helper `readRagAnnotation(def)` — reconstructs the config regardless of shape; useful for third-party plugins that want to introspect the annotation.
- 7 new tests (111 total) covering both annotation forms including the nested-wins-if-both-present rule and the shorthand `@rag: true / false`.

### Notes

- Behaviorally identical to 0.7.0 for anyone whose tests worked. If you noticed `@rag`-annotated entities booting quietly without OData actions appearing on `/odata/v4/...`, this is the fix — bump and restart.

## [0.7.0] — 2026-08-03

### Added

- **`askAbout` as an OData action — RAG conversation over your entity, no glue code.** Completes the `@rag` OData surface started in 0.6.0. Every `@rag`-annotated entity now gets a second auto-declared action alongside `searchByMeaning`: `askAbout(query, topK, systemInstructions)` returning a synthesized `{ answer: String; sources: array of <Entity> }` type. Handler runs the full RAG pipeline (retrieve → augment → chat) and projects hit IDs back to the entity via `SELECT ... WHERE ID IN (...)` in hit-rank order.

  ```http
  POST /odata/v4/app/Suppliers/AppService.askAbout
  Content-Type: application/json

  { "query": "Which suppliers can ship steel coils to Germany within two weeks?", "topK": 5 }
  ```

  Returns:

  ```jsonc
  {
    "answer":  "Based on the sources, Acme Steel and Nord Metallwerke can meet that lead time [sup-42], [sup-101].",
    "sources": [
      { "ID": "sup-42",  "name": "Acme Steel",       "description": "...", "country": "DE" },
      { "ID": "sup-101", "name": "Nord Metallwerke", "description": "...", "country": "DE" }
    ]
  }
  ```

- **Synthesized `<Entity>AskAboutResult` types added to `cds.model.definitions` at load time.** Structured returns need a top-level named type in CSN (inline anonymous structs aren't legal in action returns). The plugin adds `<ServiceName>.<EntityShort>AskAboutResult` per annotated entity with `{ answer: cds.String, sources: array of <Entity> }`. Idempotent — pre-existing types are never overwritten.

- **Config knobs (extended `@rag.actions`)**:
  - `@rag.actions: false` — disable ALL auto-declared actions (still applies).
  - `@rag.actions.ask: false` — disable just `askAbout` (keep `searchByMeaning`).
  - `@rag.actions.ask: 'answerAbout'` — custom action name. Validated as a JS identifier at boot.
  - `@rag.actions.search` (from 0.6.0) — unchanged.

- **Idempotent everywhere.** If the entity already declares its own `actions.askAbout` (user-written, or another plugin), the auto-declaration is skipped with a warning — same policy as `searchByMeaning`. Re-running `declareActions` on an entity where the result type already exists does NOT replace it (protects downstream code that may hold references).

- 15 new tests (104 total): expanded `normalizeActionsConfig` (default shape, per-action false, custom names, invalid name for both), `declareActions` (result type synthesis, action shape, idempotency for search + ask independently, no double-synthesis of the type, custom names, all opt-out combinations), OData handler behavior (registration alongside search, `{ answer, sources }` shape with sources in hit-rank order, empty-query 400, empty hits `{ answer, sources: [] }`, `systemInstructions` pass-through to RAG, per-action opt-out honored, custom name).

### Notes

- Additive — existing `@rag`-annotated entities gain the new action automatically without config changes. If your app already declared its own `askAbout` action on an entity, the plugin sees it and steps aside (logs a warning) — nothing breaks.
- The synthesized result type name is `<ServiceName>.<EntityShort>AskAboutResult`. Because the full entity name is service-qualified, there's no collision between entities sharing a short name across services. If you already have a type by that name, the plugin will re-use it — bring your own if you want a richer shape (e.g., adding a `citations` field).
- Handler uses `cds.vectorHana.askAbout()` under the hood, so per-request options that flow through (`systemInstructions`, `topK`) work the same in both APIs. The chatter LLM alias defaults to `@rag.provider` (or `'llm'`); override with `@rag.chatter: '<alias>'` when you want cheap-embed + smart-chat.

## [0.6.0] — 2026-08-03

### Added

- **`@rag` now auto-declares a bound OData action on every annotated entity — zero handler code, callable from Joule / any OData client.** The plugin now mutates the CSN at `cds.on('loaded')` (or immediately if the model is already loaded), adding a collection-bound `searchByMeaning(query: String, topK: Integer)` action that returns `array of <Entity>`. The action handler is registered on `served`: it runs the vector search, projects the hit IDs back to entity rows via `SELECT.from(<Entity>).where({ ID: { in: [...] } })`, and returns them in hit-rank order (SQL `WHERE ID IN` doesn't preserve order, so the handler re-sorts).

  ```cds
  entity Suppliers {
    key ID     : UUID;
    name       : String;
    description: LargeString;
  } @rag: {
    fields:    ['name', 'description'],
    dimension: 768,
  };
  ```

  ```http
  POST /odata/v4/app/Suppliers/AppService.searchByMeaning
  Content-Type: application/json

  { "query": "steel coils from Europe", "topK": 5 }
  ```

  Returns `value: [ <Suppliers row>, <Suppliers row>, ... ]` in relevance order — exactly as if the user had written the action + handler by hand.

- **Configurable via `@rag.actions`**:
  - `@rag.actions: false` — disable ALL auto-declared actions on this entity.
  - `@rag.actions.search: false` — disable just `searchByMeaning` (keep the JS API + auto-index alive).
  - `@rag.actions.search: 'findSuppliers'` — custom action name. Validated as a JS identifier at boot.

- **Idempotent CSN mutation.** If the entity already declares an `actions[<name>]` (user-written, or another plugin), the auto-declaration is skipped with a warning — the plugin never silently overwrites developer code. The mutation runs BOTH immediately (in case the model is already loaded) AND on `cds.on('loaded')` (in case it wasn't); the idempotency guard keeps this safe.

- **New helper exported from `lib/cdsPlugin.js`**: `declareActions(entityName, def, config, log)` — the low-level CSN mutation used internally. Exposed for tests and for embedded scenarios where a plugin author wants to declare the action without running the full `activate()` lifecycle.

- 18 new tests (89 total): `normalizeActionsConfig` (default / false / per-action false / custom name / invalid name), `declareActions` (mutation shape, idempotency, custom name, both opt-out shapes), `activate` (mutation immediate vs deferred), handler registration on served, handler behavior (rank order, empty-query 400, empty hits [], opt-out, custom action name).

### Notes

- Additive — existing `@rag`-annotated entities gain the new action automatically without config changes. If your app already declared its own `searchByMeaning` action on an entity, the plugin sees it and steps aside (logs a warning) — nothing breaks.
- The action returns `array of <Entity>`, not `SearchHit`. Score / metadata are not exposed via OData in this release — callers who need them use the direct `cds.vectorHana.searchByMeaning()` JS API. A future release may synthesize `<Entity>SearchResult` types that include score.
- `askAbout` as an OData action is NOT in 0.6.0 (structured return types across N entities add CSN complexity worth scoping separately). Keep using the JS API for now: `cds.vectorHana.askAbout({ entity, query })`.

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
