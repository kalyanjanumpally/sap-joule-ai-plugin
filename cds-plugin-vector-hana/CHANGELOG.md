# Changelog

All notable changes to `@saptarishi/cds-plugin-vector-hana`.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-07-29

Initial release.

### Added

- **`VectorStore` abstract base class** — defines the `init` / `upsert` / `search` / `delete` interface. Delegates embedding computation to any `@saptarishi/cds-plugin-llm` provider instance.
- **`SqliteVectorStore` backend** — stores vectors as JSON in a TEXT column; cosine similarity computed in JavaScript at query time. Uses `better-sqlite3` (optional peer dep). Integration-tested end-to-end (7 tests).
- **`HanaVectorStore` backend** — SAP HANA Cloud's native `REAL_VECTOR(N)` column type + `COSINE_SIMILARITY()` function. `MERGE INTO` for upsert semantics; `TOP N ... ORDER BY score DESC` for ranked retrieval; `JSON_VALUE()` for metadata filters. Uses `hdb` client (optional peer dep, pure JS — no native compile). Wire-protocol-verified against a mocked `hdb` (6 tests) but not yet live-verified against a real HANA Cloud instance.
- TypeScript definitions in `lib/index.d.ts` (typed `SearchHit<M>` generic on metadata shape).
- README with SQLite + HANA usage, backend comparison table, and the raw SQL that the HANA backend generates (for reviewers who want to see the wire protocol).
