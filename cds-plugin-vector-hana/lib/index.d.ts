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

// ---- RAG glue (0.4.0) ----------------------------------------------------

/** Any object with a chat() method — typically an @saptarishi/cds-plugin-llm provider. */
export interface ChatLLM {
  chat(req: { system?: string; messages: Array<{ role: string; content: unknown }>; [k: string]: unknown }): Promise<unknown>;
  stream?(req: { system?: string; messages: Array<{ role: string; content: unknown }>; [k: string]: unknown }): AsyncIterable<unknown>;
}

export interface RAGOptions {
  llm: ChatLLM;
  store: VectorStore;
  /** Override the default "answer from context only, cite by [id]" instruction. */
  systemInstructions?: string;
  /** Custom formatter for the retrieved context block. Receives the hits, returns a string. */
  promptTemplate?: (hits: SearchHit[]) => string;
}

export interface RAGAnswerParams {
  query: string;
  topK?: number;
  filter?: Record<string, string | number | boolean>;
  systemInstructions?: string;
  /** Any additional field is forwarded verbatim to llm.chat() (model, maxTokens, etc). */
  [k: string]: unknown;
}

export interface RAGAnswer<M = Record<string, unknown>> {
  answer: string;
  hits: SearchHit<M>[];
  /** Raw provider reply — use this when you need usage/metadata that isn't the plain text. */
  raw: unknown;
}

export interface RAGStreamResult<M = Record<string, unknown>> {
  hits: SearchHit<M>[];
  stream: AsyncIterable<unknown>;
}

export class RAG {
  constructor(options: RAGOptions);
  readonly llm: ChatLLM;
  readonly store: VectorStore;
  readonly systemInstructions: string;
  readonly promptTemplate: (hits: SearchHit[]) => string;
  retrieve<M = Record<string, unknown>>(p: { query: string; topK?: number; filter?: Record<string, string | number | boolean> }): Promise<SearchHit<M>[]>;
  augment(p: { query: string; hits: SearchHit[]; systemInstructions?: string }): { system: string; messages: Array<{ role: string; content: string }> };
  answer<M = Record<string, unknown>>(p: RAGAnswerParams): Promise<RAGAnswer<M>>;
  stream<M = Record<string, unknown>>(p: RAGAnswerParams): Promise<RAGStreamResult<M>>;
}

// ---- CDS @rag annotation plugin (0.5.0) --------------------------------

/** Handle returned by `activateCdsPlugin(cds)` and also attached at `cds.vectorHana`. */
export interface CdsRagPlugin {
  /** VectorStore for a given `@rag`-annotated entity name (e.g. `'AppService.Suppliers'`). Returns undefined if not annotated or before `cds.on('served')` fires. */
  getStore(entityName: string): VectorStore | undefined;

  /** Retrieve top-K hits for an annotated entity by natural-language query. */
  searchByMeaning<M = Record<string, unknown>>(p: {
    entity: string;
    query: string;
    topK?: number;
    filter?: Record<string, string | number | boolean>;
  }): Promise<SearchHit<M>[]>;

  /** Full RAG: retrieve hits, augment prompt, ask the configured chat LLM. Extra fields are forwarded to `llm.chat()`. */
  askAbout<M = Record<string, unknown>>(p: {
    entity: string;
    query: string;
    topK?: number;
    filter?: Record<string, string | number | boolean>;
    systemInstructions?: string;
    [k: string]: unknown;
  }): Promise<RAGAnswer<M>>;

  /** Re-index every row of an annotated entity (useful after enabling `@rag` on an existing table). */
  backfill(entityName: string): Promise<{ indexed: number }>;
}

export interface ActivateCdsPluginOptions {
  /** Override the store class registry (mainly for testing). */
  stores?: Record<string, new (opts: unknown) => VectorStore>;
  /** Override the RAG class (mainly for testing). */
  RAG?: typeof RAG;
}

/**
 * Activate the `@rag` annotation plugin against an @sap/cds handle. The
 * package's `cds-plugin.js` calls this automatically at boot and attaches the
 * result at `cds.vectorHana` — you only need to call it yourself in tests or
 * embedded scenarios where the auto-load didn't run.
 */
export function activateCdsPlugin(cds: unknown, options?: ActivateCdsPluginOptions): CdsRagPlugin;
