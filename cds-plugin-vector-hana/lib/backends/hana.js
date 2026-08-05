const VectorStore = require('../VectorStore');

/**
 * SAP HANA Cloud vector store using native REAL_VECTOR + COSINE_SIMILARITY.
 * Requires HANA Cloud QRC 1/2024 or later (when the vector engine landed GA).
 *
 * Uses the `hdb` client — pure JS, no native compilation required.
 * Install separately: `npm install hdb`.
 *
 * Configuration:
 *   {
 *     embed:      <@saptarishi/cds-plugin-llm instance>,
 *     dimension:  1536,                        // must match embedding model
 *     table:      'CONTRACTS_EMBEDDINGS',      // HANA-style uppercase preferred
 *     connection: {
 *       host:     '<subaccount>.hanacloud.ondemand.com',
 *       port:     443,
 *       user:     '<HANA user>',
 *       password: '<HANA password>',
 *       ...standard hdb options
 *     }
 *   }
 *
 * On BTP with a HANA service binding, pass `credentials` from the binding
 * as `connection` directly.
 */
class HanaVectorStore extends VectorStore {
  constructor(options = {}) {
    super(options);
    this.connection = options.connection ?? {};
    // { type: 'hnsw', similarity: 'cosine' | 'l2', name?, buildParameters? }
    this.index = options.index ?? null;
    if (this.index) {
      if (this.index.type !== 'hnsw') {
        throw new Error(`HanaVectorStore: index.type must be 'hnsw' (got ${this.index.type})`);
      }
      const sim = this.index.similarity ?? 'cosine';
      if (sim !== 'cosine' && sim !== 'l2') {
        throw new Error(`HanaVectorStore: index.similarity must be 'cosine' or 'l2' (got ${sim})`);
      }
    }
  }

  async _connect() {
    let hdb;
    try {
      hdb = require('hdb');
    } catch (e) {
      throw new Error(
        'HanaVectorStore requires the `hdb` package. Install with: ' +
        '`npm install hdb`. Or use the SQLite backend for local dev.'
      );
    }
    this.client = hdb.createClient(this.connection);
    await new Promise((resolve, reject) => {
      this.client.connect(err => (err ? reject(err) : resolve()));
    });
  }

  async _createTableIfMissing() {
    // Check for existence in SYS.TABLES (public metadata view)
    const exists = await this._exec(
      `SELECT COUNT(*) AS N FROM SYS.TABLES WHERE TABLE_NAME = ? AND SCHEMA_NAME = CURRENT_SCHEMA`,
      [this.table],
    );
    if (exists?.[0]?.N > 0) return;

    // REAL_VECTOR(dim) is HANA Cloud native (QRC 1/2024+). METADATA stored as
    // NCLOB (JSON blob) — HANA doesn't have a native JSON column type but
    // JSON functions work over NCLOB just fine.
    const sql = `
      CREATE COLUMN TABLE "${this.table}" (
        "${this.idColumn}"        NVARCHAR(256) PRIMARY KEY,
        "${this.textColumn}"      NCLOB NOT NULL,
        "${this.embeddingColumn}" REAL_VECTOR(${this.dimension}) NOT NULL,
        "${this.metadataColumn}"  NCLOB
      )
    `;
    await this._exec(sql);
    if (this.index) await this._createHnswIndex();
  }

  async _createHnswIndex() {
    const sim = this.index.similarity ?? 'cosine';
    const simFn = sim === 'cosine' ? 'COSINE_SIMILARITY' : 'L2DISTANCE';
    const idxName = this.index.name ?? `${this.table}_${this.embeddingColumn}_HNSW_IDX`;
    // HANA HNSW vector index (HANA Cloud QRC 2/2024+). BUILD PARAMETERS accept
    // a comma-separated string: e.g. 'ef_construction=200,M=64'.
    const buildParams = this.index.buildParameters
      ? Object.entries(this.index.buildParameters).map(([k, v]) => `${k}=${v}`).join(',')
      : '';
    const withClause = buildParams ? ` BUILD PARAMETERS ('${buildParams}')` : '';
    const sql = `CREATE HNSW VECTOR INDEX "${idxName}" ` +
                `ON "${this.table}" ("${this.embeddingColumn}") ` +
                `SIMILARITY FUNCTION ${simFn}${withClause}`;
    await this._exec(sql);
  }

  async _upsert({ id, text, vector, metadata }) {
    await this._exec(
      this._mergeSql(1),
      [id, text, JSON.stringify(vector), metadata ? JSON.stringify(metadata) : null],
    );
    return { id };
  }

  async _upsertMany(records) {
    // Batch in chunks — MERGE INTO accepts multi-row USING via UNION ALL of
    // DUMMY selects. Chunk size caps parameter count and query text size.
    const chunkSize = this.options.upsertChunkSize ?? 100;
    for (let start = 0; start < records.length; start += chunkSize) {
      const chunk = records.slice(start, start + chunkSize);
      const params = [];
      for (const r of chunk) {
        params.push(r.id, r.text, JSON.stringify(r.vector), r.metadata ? JSON.stringify(r.metadata) : null);
      }
      await this._exec(this._mergeSql(chunk.length), params);
    }
    return records.map(r => ({ id: r.id }));
  }

  _mergeSql(rowCount) {
    // HANA has no native UPSERT — MERGE INTO with USING is the idiomatic path.
    // TO_REAL_VECTOR converts a JSON array string into the native vector type.
    const oneRow = `SELECT ? AS "${this.idColumn}", ? AS "${this.textColumn}",
                    TO_REAL_VECTOR(?) AS "${this.embeddingColumn}",
                    ? AS "${this.metadataColumn}" FROM DUMMY`;
    const using = Array.from({ length: rowCount }, () => oneRow).join(' UNION ALL ');
    return `
      MERGE INTO "${this.table}" AS T
      USING (${using}) AS S
      ON T."${this.idColumn}" = S."${this.idColumn}"
      WHEN MATCHED THEN UPDATE SET
        "${this.textColumn}" = S."${this.textColumn}",
        "${this.embeddingColumn}" = S."${this.embeddingColumn}",
        "${this.metadataColumn}" = S."${this.metadataColumn}"
      WHEN NOT MATCHED THEN INSERT VALUES (
        S."${this.idColumn}", S."${this.textColumn}",
        S."${this.embeddingColumn}", S."${this.metadataColumn}"
      )
    `;
  }

  async _search({ queryVector, topK, filter }) {
    // COSINE_SIMILARITY returns [-1, 1] where 1 = identical, -1 = opposite.
    // Sort DESC for closest matches first. TOP N limits at the SQL level.
    let where = '';
    const params = [JSON.stringify(queryVector)];
    if (filter && Object.keys(filter).length > 0) {
      const clauses = [];
      for (const [key, value] of Object.entries(filter)) {
        clauses.push(`JSON_VALUE("${this.metadataColumn}", '$.${key}') = ?`);
        params.push(value);
      }
      where = 'WHERE ' + clauses.join(' AND ');
    }
    const sql = `
      SELECT TOP ${Math.floor(topK)}
        "${this.idColumn}" AS "id",
        "${this.textColumn}" AS "text",
        "${this.metadataColumn}" AS "metadata",
        COSINE_SIMILARITY("${this.embeddingColumn}", TO_REAL_VECTOR(?)) AS "score"
      FROM "${this.table}"
      ${where}
      ORDER BY "score" DESC
    `;
    const rows = await this._exec(sql, params);
    return (rows ?? []).map(r => ({
      id: r.id ?? r.ID,
      text: r.text ?? r.TEXT,
      metadata: (r.metadata ?? r.METADATA) ? JSON.parse(r.metadata ?? r.METADATA) : null,
      score: r.score ?? r.SCORE,
    }));
  }

  async _keywordSearch({ terms, topK, filter }) {
    // Simple case-insensitive substring keyword scoring. Same shape as the
    // SQLite backend for consistency across environments. For production
    // scale, override with HANA's native `CONTAINS()` fuzzy search once
    // you've created a text index on the `text` column.
    // Placeholder order: LIKE params (in the score expression, appears
    // first in the SQL) → filter params (WHERE clause).
    const params = [];
    const termClauses = terms.map(t => {
      params.push(`%${t.toLowerCase()}%`);
      return `(CASE WHEN LOWER("${this.textColumn}") LIKE ? THEN 1 ELSE 0 END)`;
    });
    const scoreExpr = termClauses.join(' + ');

    const filterClauses = [];
    if (filter && Object.keys(filter).length > 0) {
      for (const [key, value] of Object.entries(filter)) {
        filterClauses.push(`JSON_VALUE("${this.metadataColumn}", '$.${key}') = ?`);
        params.push(value);
      }
    }
    const innerWhere = filterClauses.length ? 'WHERE ' + filterClauses.join(' AND ') : '';

    const sql = `
      SELECT TOP ${Math.floor(topK)} * FROM (
        SELECT "${this.idColumn}" AS "id",
               "${this.textColumn}" AS "text",
               "${this.metadataColumn}" AS "metadata",
               (${scoreExpr}) AS "score"
        FROM "${this.table}"
        ${innerWhere}
      )
      WHERE "score" > 0
      ORDER BY "score" DESC, "id" ASC
    `;
    const rows = await this._exec(sql, params);
    return (rows ?? []).map(r => ({
      id: r.id ?? r.ID,
      text: r.text ?? r.TEXT,
      metadata: (r.metadata ?? r.METADATA) ? JSON.parse(r.metadata ?? r.METADATA) : null,
      score: r.score ?? r.SCORE,
    }));
  }

  async _delete({ id }) {
    const sql = `DELETE FROM "${this.table}" WHERE "${this.idColumn}" = ?`;
    await this._exec(sql, [id]);
    return { id };
  }

  async _dropTable() {
    await this._exec(`DROP TABLE "${this.table}"`);
  }

  async _close() {
    if (this.client) {
      await new Promise(resolve => this.client.end(() => resolve()));
    }
  }

  // ---- internal helpers ---------------------------------------------------

  _exec(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.client.prepare(sql, (err, stmt) => {
        if (err) return reject(err);
        stmt.exec(params, (err2, rows) => {
          if (err2) return reject(err2);
          resolve(rows);
        });
      });
    });
  }
}

module.exports = HanaVectorStore;
