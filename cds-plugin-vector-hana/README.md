# @saptarishi/cds-plugin-vector-hana

[![npm](https://img.shields.io/npm/v/@saptarishi/cds-plugin-vector-hana.svg)](https://www.npmjs.com/package/@saptarishi/cds-plugin-vector-hana)
[![license](https://img.shields.io/npm/l/@saptarishi/cds-plugin-vector-hana.svg)](./LICENSE)

Vector store for SAP CAP that speaks HANA Cloud's native `REAL_VECTOR` + `COSINE_SIMILARITY`. Ships with a **SQLite fallback** so you can build and test semantic-search features on your laptop without paying for HANA.

Composes with [`@saptarishi/cds-plugin-llm`](https://www.npmjs.com/package/@saptarishi/cds-plugin-llm) for embeddings — bring any provider (Ollama, OpenAI, Groq, GenAI Hub).

## Install

```sh
npm install @saptarishi/cds-plugin-vector-hana @saptarishi/cds-plugin-llm

# then choose a backend:
npm install better-sqlite3    # for local dev
# OR
npm install hdb               # for HANA Cloud
```

Both drivers are optional peer deps — install only what you need.

## Use — SQLite (dev)

```js
const { GroqLLMService } = require('@saptarishi/cds-plugin-llm');
const { SqliteVectorStore } = require('@saptarishi/cds-plugin-vector-hana');

// Any embed()-capable LLMService — Ollama is a good local pick, but Groq /
// OpenAI-compat work too.
const embed = new GroqLLMService('emb', null, { modelId: 'text-embedding-3-small' });
await embed.init();

const store = new SqliteVectorStore({
  embed,
  dimension: 1536,                  // must match your embedding model's output
  table: 'supplier_contracts',
  dbPath: './contracts.sqlite',     // or ':memory:' for tests
});
await store.init();

// Index some documents
await store.upsert({
  id: 'C-4711',
  text: 'Master supply agreement with Acme Steel GmbH for cold-rolled coils, EUR pricing, Incoterms 2020 DDP, valid through 2027-12-31.',
  metadata: { supplier: 'Acme Steel', category: 'raw-materials', region: 'EMEA' },
});

// Query
const hits = await store.search({
  text: 'which contracts cover steel supply in Europe?',
  topK: 5,
  filter: { region: 'EMEA' },       // optional metadata filter
});

hits.forEach(h => {
  console.log(`${h.score.toFixed(3)}  ${h.id}  ${h.text.slice(0, 60)}...`);
});
```

## Use — HANA Cloud (production)

Identical API — only the class name changes:

```js
const { HanaVectorStore } = require('@saptarishi/cds-plugin-vector-hana');

const store = new HanaVectorStore({
  embed,
  dimension: 1536,
  table: 'SUPPLIER_CONTRACTS',
  connection: {                     // standard hdb options
    host: '<subaccount>.hanacloud.ondemand.com',
    port: 443,
    user: process.env.HANA_USER,
    password: process.env.HANA_PASSWORD,
  },
});
await store.init();

// Same upsert / search / delete API as SQLite backend.
```

**On BTP with a HANA service binding:** extract `credentials` from the binding and pass as `connection` directly — same shape.

### HNSW vector index (new in v0.3.0)

For production-scale corpora (tens of thousands of rows and up), exhaustive `COSINE_SIMILARITY` scans over every row will eventually become the bottleneck. Pass an `index` option and `init()` creates an HNSW graph index for approximate-nearest-neighbor search:

```js
const store = new HanaVectorStore({
  embed,
  dimension: 1536,
  table: 'SUPPLIER_CONTRACTS',
  connection: { /* ... */ },
  index: {
    type: 'hnsw',
    similarity: 'cosine',                       // or 'l2'
    // name: 'MY_IDX',                          // defaults to '<table>_<column>_HNSW_IDX'
    buildParameters: { ef_construction: 200, M: 64 },
  },
});
await store.init();
```

Emits:

```sql
CREATE HNSW VECTOR INDEX "SUPPLIER_CONTRACTS_embedding_HNSW_IDX"
  ON "SUPPLIER_CONTRACTS" ("embedding")
  SIMILARITY FUNCTION COSINE_SIMILARITY
  BUILD PARAMETERS ('ef_construction=200,M=64')
```

Requires HANA Cloud QRC 2/2024 or later (when HNSW GA'd). Search queries are unchanged — HANA transparently uses the index when `COSINE_SIMILARITY` is in the `ORDER BY`.

### `@rag` actions auto-declared on OData (new in v0.6.0 / v0.7.0)

Every `@rag`-annotated entity gets **two** collection-bound OData actions out of the box — zero handler code:

```http
POST /odata/v4/app/Suppliers/AppService.searchByMeaning
Content-Type: application/json

{ "query": "steel coils shipped from Europe", "topK": 5 }
```

→ `value: [ <Suppliers row>, ... ]` in relevance order. The plugin runs the vector search, projects hit IDs back to the entity via `SELECT ... WHERE ID IN (...)`, and re-sorts to match the hit ranking (SQL doesn't preserve it).

```http
POST /odata/v4/app/Suppliers/AppService.askAbout
Content-Type: application/json

{ "query": "Which suppliers can ship steel coils to Germany within two weeks?", "topK": 5 }
```

→ `{ answer: "...", sources: [ <Suppliers row>, ... ] }`. Handler runs the full RAG pipeline (retrieve → augment → chat) and returns both the LLM answer AND the source rows (in hit-rank order) so the caller can render citations. Optional `systemInstructions` field on the request body overrides the default "answer from context only, cite by [id]" instruction per-call.

Opt-outs and overrides via `@rag.actions`:

```cds
} @rag: {
  fields:    ['name', 'description'],
  dimension: 768,
  actions: false                                    // disable ALL auto-declared actions
  // or:  actions: { ask: false }                   // disable just askAbout
  // or:  actions: { search: false, ask: false }    // disable both
  // or:  actions: { search: 'findSuppliers',
                     ask:    'answerAbout' }        // custom action names
};
```

If the entity already declares its own `actions.searchByMeaning` or `actions.askAbout` (user-written, or another plugin's), the auto-declaration is skipped with a warning — the plugin never overwrites developer code.

The synthesized return type for `askAbout` — `<ServiceName>.<EntityShort>AskAboutResult` — is added to `cds.model.definitions` at load time. Bring your own type by that name if you want a richer shape (e.g., adding a `citations` field); the plugin will re-use it.

### `@rag` annotation — auto-indexed entities (new in v0.5.0)

Skip the boilerplate. Annotate a CDS entity with `@rag` and the plugin builds a vector table, keeps it in sync on every CRUD, and hands you two ergonomic operations on `cds.vectorHana`:

```cds
entity Suppliers {
  key ID     : UUID;
  name       : String;
  description: LargeString;
  country    : String;
} @rag: {
  fields:    ['name', 'description'],  // projected + embedded per row
  dimension: 768,                      // your embedding model's vector size
  store:     'sqlite',                 // or 'hana'
  topK:      5,                        // default topK for searchByMeaning
};
```

```js
// Anywhere in a CAP handler
const hits = await cds.vectorHana.searchByMeaning({
  entity: 'AppService.Suppliers',
  query:  'steel coils shipped from Europe',
});

const { answer, hits: sources } = await cds.vectorHana.askAbout({
  entity: 'AppService.Suppliers',
  query:  'Which suppliers can ship steel coils to Germany within two weeks?',
});
```

The plugin registers `after CREATE|UPDATE` handlers so every save embeds + upserts the row's projected text into the vector table, and a `before DELETE` handler so the vector goes when the row does. Rows where every projected field is empty are silently skipped — no dead vectors clogging your search.

Optional bits:

- `@rag.provider` — cds.services alias for the embedder (default `'llm'`).
- `@rag.chatter` — separate alias for `askAbout()`'s chat provider (default: same as `provider`). Useful when you want to embed with a cheap local model and chat with a smart one.
- `@rag.table` — override the derived table name (default: `<entity>_vec`).
- `cds.vectorHana.backfill('AppService.Suppliers')` — re-index every existing row. Use when enabling `@rag` on an already-populated table.

### RAG in one call (new in v0.4.0)

Compose the store with any `@saptarishi/cds-plugin-llm` provider to get retrieval + citation-tagged prompt + chat generation in a single call:

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
//    hits:   [ { id: 'refund', score: 0.82, ... }, ... ]

// Streaming variant — hits available before the first token
const { hits: streamHits, stream } = await rag.stream({ query: '...', topK: 3 });
// render `streamHits` immediately as sources; consume `stream` as chunks arrive
for await (const chunk of stream) process.stdout.write(chunk.text ?? '');
```

The default system instruction tells the model to answer from context only and cite by `[id]`. Both the instruction and the context template are overridable per-instance (via the constructor) or per-call (via `systemInstructions`).

### Batch upsert (new in v0.2.0)

For loading many rows at once — one embed call for the whole batch, one round-trip to persist:

```js
await store.upsertMany([
  { id: 'contract-1', text: '...', metadata: { region: 'EMEA' } },
  { id: 'contract-2', text: '...', metadata: { region: 'APAC' } },
  // ...
]);
```

SQLite backend runs a prepared statement inside a transaction. HANA backend uses a multi-row `MERGE INTO` (`UNION ALL` of DUMMY selects), chunked at `upsertChunkSize` (default 100).

## What the SQL actually does (HANA backend)

```sql
-- Table creation (init)
CREATE COLUMN TABLE "SUPPLIER_CONTRACTS" (
  "id"        NVARCHAR(256) PRIMARY KEY,
  "text"      NCLOB NOT NULL,
  "embedding" REAL_VECTOR(1536) NOT NULL,
  "metadata"  NCLOB
);

-- Upsert (via MERGE INTO)
MERGE INTO "SUPPLIER_CONTRACTS" AS T
USING (SELECT ? AS "id", ? AS "text", TO_REAL_VECTOR(?) AS "embedding", ? AS "metadata" FROM DUMMY) AS S
ON T."id" = S."id"
WHEN MATCHED THEN UPDATE SET "text" = S."text", "embedding" = S."embedding", "metadata" = S."metadata"
WHEN NOT MATCHED THEN INSERT VALUES (S."id", S."text", S."embedding", S."metadata");

-- Search (with metadata filter)
SELECT TOP 5
  "id", "text", "metadata",
  COSINE_SIMILARITY("embedding", TO_REAL_VECTOR(?)) AS "score"
FROM "SUPPLIER_CONTRACTS"
WHERE JSON_VALUE("metadata", '$.region') = ?
ORDER BY "score" DESC;
```

## Backend comparison

|                       | `SqliteVectorStore` | `HanaVectorStore` |
|---|---|---|
| Storage               | JSON array in TEXT column | Native `REAL_VECTOR(N)` |
| Similarity            | JS cosine at query time | Native `COSINE_SIMILARITY()` |
| Scan pattern          | Full table scan (JS-side) | SQL-level `TOP N` push-down |
| Scale ceiling         | ~10K rows before latency hurts | Millions (HNSW index in HANA Cloud) |
| Metadata filter       | `json_extract(...)` | `JSON_VALUE(...)` |
| Additional install    | `better-sqlite3` (native compile) | `hdb` (pure JS) |
| Live-verified         | Yes — integration tests exercise it | No — mock-verified (see below) |

## Stability

`0.1.0`. API expected to remain stable through `0.x` for the SQLite backend (integration-tested end-to-end). The HANA backend is wire-protocol-verified against a mock `hdb` client and matches SAP HANA Cloud's documented vector engine SQL. Live-verification against a real HANA Cloud instance is the top open item — welcome as a community PR.

## FAQ

**Do I need HANA Cloud to develop with this?**
No. The SQLite backend has the identical API and works out of the box. Build + test + demo locally, then swap `SqliteVectorStore` for `HanaVectorStore` at deploy time.

**Which embedding model should I use?**
Match the vector size to your dataset scale:
- `nomic-embed-text` (Ollama, 768-dim) — free, local, fine for demos
- `text-embedding-3-small` (OpenAI, 1536-dim) — good balance
- `text-embedding-3-large` (OpenAI, 3072-dim) — best retrieval quality, higher cost
- `mxbai-embed-large` (Ollama, 1024-dim) — strong local option

**How does this differ from CAP's `@sap/cds-dbs` HANA driver?**
`@sap/cds-dbs` gives you full CAP entity mapping over HANA. This plugin is scoped narrowly to vector storage + semantic search — it's a small library, not a CAP database adapter. Use both together in a CAP app.

**Can I use this without the `@saptarishi/cds-plugin-llm` plugin?**
Technically yes — pass any object with an `embed()` method matching the plugin's shape. But the plugin's uniform interface across providers is the whole reason this composes cleanly.

**Where's the HNSW index configuration?**
Not exposed in `0.1.0`. HANA Cloud's vector engine can build HNSW indexes for large tables — for now, add the index via a manual DDL step after `init()`. HNSW auto-provisioning is a follow-up item.

## License

Apache-2.0
