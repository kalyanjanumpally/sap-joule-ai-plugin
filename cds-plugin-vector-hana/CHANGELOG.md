# Changelog

All notable changes to `@saptarishi/cds-plugin-vector-hana`.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
