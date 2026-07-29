// Type definitions for @saptarishi/cds-plugin-vector-hana

/** Any object with an embed() method — typically an @saptarishi/cds-plugin-llm provider */
export interface Embedder {
  embed(req: { input: string | string[]; model?: string }): Promise<{ embeddings: number[][]; model?: string }>;
}

export interface VectorStoreOptions {
  embed: Embedder;
  /** Embedding vector length — must match your embedding model's output */
  dimension: number;
  /** Table name. Default: 'vectors' */
  table?: string;
  /** Column names (defaults shown) */
  idColumn?: string;         // 'id'
  textColumn?: string;       // 'text'
  embeddingColumn?: string;  // 'embedding'
  metadataColumn?: string;   // 'metadata'
}

export interface UpsertParams {
  id: string;
  text: string;
  metadata?: Record<string, unknown> | null;
}

export interface SearchParams {
  text: string;
  topK?: number;
  filter?: Record<string, string | number | boolean>;
}

export interface SearchHit<M = Record<string, unknown>> {
  id: string;
  text: string;
  metadata: M | null;
  /** Cosine similarity — 1.0 = identical, 0.0 = orthogonal, -1.0 = opposite */
  score: number;
}

export class VectorStore {
  constructor(options: VectorStoreOptions);
  readonly options: VectorStoreOptions;
  readonly embed: Embedder;
  readonly table: string;
  readonly dimension: number;
  init(): Promise<void>;
  upsert(p: UpsertParams): Promise<{ id: string }>;
  /**
   * Batch upsert. Embeds all `text` values in a single embed() call and
   * persists via the backend's batched path (SQLite: prepared-stmt transaction;
   * HANA: multi-row MERGE INTO, chunked at `upsertChunkSize` — default 100).
   */
  upsertMany(items: UpsertParams[]): Promise<{ id: string }[]>;
  search<M = Record<string, unknown>>(p: SearchParams): Promise<SearchHit<M>[]>;
  delete(p: { id: string }): Promise<unknown>;
  dropTable(): Promise<void>;
  close(): Promise<void>;
}

export interface SqliteVectorStoreOptions extends VectorStoreOptions {
  /** SQLite file path. Default: ':memory:' */
  dbPath?: string;
}
export class SqliteVectorStore extends VectorStore {
  constructor(options: SqliteVectorStoreOptions);
}

export interface HanaConnection {
  host: string;
  port: number;
  user: string;
  password: string;
  [key: string]: unknown;
}
/**
 * Vector index config for the HANA backend. Creates an HNSW vector index at
 * table-creation time — required for scaling beyond a few thousand rows.
 * Requires HANA Cloud QRC 2/2024 or later.
 */
export interface HnswIndexOptions {
  type: 'hnsw';
  /** 'cosine' (default) uses COSINE_SIMILARITY; 'l2' uses L2DISTANCE. */
  similarity?: 'cosine' | 'l2';
  /** Explicit index name. Default: '<table>_<embeddingColumn>_HNSW_IDX'. */
  name?: string;
  /**
   * HANA HNSW BUILD PARAMETERS. Common keys: `ef_construction`, `M`.
   * Serialized as `k1=v1,k2=v2` inside `BUILD PARAMETERS (...)`.
   */
  buildParameters?: Record<string, string | number>;
}

export interface HanaVectorStoreOptions extends VectorStoreOptions {
  connection: HanaConnection;
  /** Max rows per multi-row MERGE INTO in upsertMany. Default: 100. */
  upsertChunkSize?: number;
  /** Create an HNSW vector index at init() time. Required for production scale. */
  index?: HnswIndexOptions;
}
export class HanaVectorStore extends VectorStore {
  constructor(options: HanaVectorStoreOptions);
}
