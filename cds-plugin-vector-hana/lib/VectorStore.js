/**
 * Abstract vector store base class. Subclasses implement _connect, _upsert,
 * _search, _delete, and _dropTable using their backend (HANA, SQLite, etc.).
 *
 * All embedding computation is delegated to an @saptarishi/cds-plugin-llm
 * provider instance — the vector store composes with any embed()-capable
 * provider (Ollama, OpenAI, Groq, etc.).
 *
 * Public interface:
 *   const store = new SomeVectorStore({
 *     embed,                       // LLMService with embed() method
 *     table: 'supplier_contracts',
 *     dimension: 1536,             // embedding vector size — must match your model
 *     ...backend-specific options
 *   });
 *   await store.init();            // creates table + index if missing
 *   await store.upsert({ id, text, metadata });
 *   const hits = await store.search({ text, topK: 5, filter });
 *   await store.delete({ id });
 */
class VectorStore {
  constructor(options = {}) {
    this.options = options;
    this.embed = options.embed;
    this.table = options.table ?? 'vectors';
    this.dimension = options.dimension;
    this.idColumn = options.idColumn ?? 'id';
    this.textColumn = options.textColumn ?? 'text';
    this.embeddingColumn = options.embeddingColumn ?? 'embedding';
    this.metadataColumn = options.metadataColumn ?? 'metadata';

    if (!this.embed || typeof this.embed.embed !== 'function') {
      throw new Error(
        'VectorStore requires an `embed` option — an @saptarishi/cds-plugin-llm ' +
        'provider instance with an embed() method (Ollama, OpenAI-compat, Groq, ' +
        'or GenAI Hub with embeddingDeploymentId).'
      );
    }
    if (!this.dimension || typeof this.dimension !== 'number') {
      throw new Error('VectorStore requires a `dimension` option (embedding vector size).');
    }
  }

  async init() {
    await this._connect();
    await this._createTableIfMissing();
  }

  async upsert({ id, text, metadata }) {
    if (!id) throw new Error('upsert() requires { id }');
    if (typeof text !== 'string' || text.length === 0) {
      throw new Error('upsert() requires { text: non-empty string }');
    }
    const { embeddings } = await this.embed.embed({ input: text });
    const vector = embeddings[0];
    if (!Array.isArray(vector) || vector.length !== this.dimension) {
      throw new Error(
        `Embedding dimension mismatch: expected ${this.dimension}, got ${vector?.length}. ` +
        'Check that the embedding model matches the configured dimension.'
      );
    }
    return this._upsert({ id, text, vector, metadata: metadata ?? null });
  }

  /**
   * Batch upsert. Embeds all `text` values in a single embed() call (providers
   * that accept `input: string[]` return N vectors in one round-trip) and
   * persists them via the backend's `_upsertMany` — backends override this
   * to use a transaction (SQLite) or batched MERGE (HANA).
   *
   *   await store.upsertMany([
   *     { id: 'doc1', text: '...', metadata: { category: 'legal' } },
   *     { id: 'doc2', text: '...', metadata: { category: 'finance' } },
   *   ]);
   */
  async upsertMany(items) {
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('upsertMany() requires a non-empty array of { id, text, metadata } items');
    }
    for (const [i, item] of items.entries()) {
      if (!item?.id) throw new Error(`upsertMany() item[${i}] missing { id }`);
      if (typeof item.text !== 'string' || item.text.length === 0) {
        throw new Error(`upsertMany() item[${i}] requires { text: non-empty string }`);
      }
    }
    const texts = items.map(it => it.text);
    const { embeddings } = await this.embed.embed({ input: texts });
    if (!Array.isArray(embeddings) || embeddings.length !== items.length) {
      throw new Error(
        `Embedding provider returned ${embeddings?.length} vectors for ${items.length} inputs. ` +
        'Check that the provider supports batched embed() with string[] input.'
      );
    }
    const records = items.map((it, i) => {
      const vec = embeddings[i];
      if (!Array.isArray(vec) || vec.length !== this.dimension) {
        throw new Error(
          `Embedding dimension mismatch on item[${i}] (id=${it.id}): expected ${this.dimension}, got ${vec?.length}.`
        );
      }
      return { id: it.id, text: it.text, vector: vec, metadata: it.metadata ?? null };
    });
    return this._upsertMany(records);
  }

  async search({ text, topK = 10, filter } = {}) {
    if (typeof text !== 'string' || text.length === 0) {
      throw new Error('search() requires { text: non-empty string }');
    }
    if (topK < 1) throw new Error('search() requires topK >= 1');
    const { embeddings } = await this.embed.embed({ input: text });
    const queryVector = embeddings[0];
    return this._search({ queryVector, topK, filter });
  }

  async delete({ id }) {
    if (!id) throw new Error('delete() requires { id }');
    return this._delete({ id });
  }

  // ---- backend hooks (subclasses override) --------------------------------

  async _connect() { throw new Error(`${this.constructor.name} must implement _connect()`); }
  async _createTableIfMissing() { throw new Error(`${this.constructor.name} must implement _createTableIfMissing()`); }
  async _upsert() { throw new Error(`${this.constructor.name} must implement _upsert()`); }

  // Default: sequential upsert. Backends should override for a real batch path.
  async _upsertMany(records) {
    const results = [];
    for (const r of records) results.push(await this._upsert(r));
    return results;
  }
  async _search() { throw new Error(`${this.constructor.name} must implement _search()`); }
  async _delete() { throw new Error(`${this.constructor.name} must implement _delete()`); }

  async dropTable() { return this._dropTable ? this._dropTable() : undefined; }
  async close() { return this._close ? this._close() : undefined; }
}

module.exports = VectorStore;
