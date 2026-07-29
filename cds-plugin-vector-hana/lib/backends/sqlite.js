const VectorStore = require('../VectorStore');

/**
 * SQLite backend. Stores vectors as JSON in a TEXT column and does cosine
 * similarity in JavaScript at query time.
 *
 * Trade-offs:
 *   - Fine for dev, demos, and small datasets (<10K rows fits in memory)
 *   - Not ideal for production — scans the full table on every search
 *   - For production, use the HANA backend (uses native REAL_VECTOR +
 *     COSINE_SIMILARITY, supports HNSW index)
 *
 * Dependencies: better-sqlite3 (optional peer dep). Install separately:
 *   npm install better-sqlite3
 */
class SqliteVectorStore extends VectorStore {
  constructor(options = {}) {
    super(options);
    this.dbPath = options.dbPath ?? ':memory:';
  }

  async _connect() {
    let Database;
    try {
      Database = require('better-sqlite3');
    } catch (e) {
      throw new Error(
        'SqliteVectorStore requires the `better-sqlite3` package. Install with: ' +
        '`npm install better-sqlite3`. Or use the HANA backend for production.'
      );
    }
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
  }

  async _createTableIfMissing() {
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS "${this.table}" (
        "${this.idColumn}"        TEXT PRIMARY KEY,
        "${this.textColumn}"      TEXT NOT NULL,
        "${this.embeddingColumn}" TEXT NOT NULL,
        "${this.metadataColumn}"  TEXT
      )
    `).run();
  }

  async _upsert({ id, text, vector, metadata }) {
    const stmt = this.db.prepare(`
      INSERT INTO "${this.table}" ("${this.idColumn}", "${this.textColumn}", "${this.embeddingColumn}", "${this.metadataColumn}")
      VALUES (?, ?, ?, ?)
      ON CONFLICT("${this.idColumn}") DO UPDATE SET
        "${this.textColumn}" = excluded."${this.textColumn}",
        "${this.embeddingColumn}" = excluded."${this.embeddingColumn}",
        "${this.metadataColumn}" = excluded."${this.metadataColumn}"
    `);
    stmt.run(id, text, JSON.stringify(vector), metadata ? JSON.stringify(metadata) : null);
    return { id };
  }

  async _search({ queryVector, topK, filter }) {
    // Fetch all rows and compute cosine similarity in JS.
    // Not scalable; documented limitation.
    let where = '';
    const params = [];
    if (filter && Object.keys(filter).length > 0) {
      // Simple metadata filter — JSON extract per key
      const clauses = [];
      for (const [key, value] of Object.entries(filter)) {
        clauses.push(`json_extract("${this.metadataColumn}", '$.${key}') = ?`);
        params.push(value);
      }
      where = 'WHERE ' + clauses.join(' AND ');
    }
    const rows = this.db.prepare(`
      SELECT "${this.idColumn}" AS id, "${this.textColumn}" AS text,
             "${this.embeddingColumn}" AS embedding, "${this.metadataColumn}" AS metadata
      FROM "${this.table}" ${where}
    `).all(...params);

    const scored = rows.map(row => {
      const vec = JSON.parse(row.embedding);
      return {
        id: row.id,
        text: row.text,
        metadata: row.metadata ? JSON.parse(row.metadata) : null,
        score: cosineSimilarity(queryVector, vec),
      };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  async _delete({ id }) {
    const info = this.db.prepare(`DELETE FROM "${this.table}" WHERE "${this.idColumn}" = ?`).run(id);
    return { deleted: info.changes };
  }

  async _dropTable() {
    this.db.prepare(`DROP TABLE IF EXISTS "${this.table}"`).run();
  }

  async _close() {
    if (this.db) this.db.close();
  }
}

function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

module.exports = SqliteVectorStore;
