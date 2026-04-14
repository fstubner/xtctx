import * as lancedb from "@lancedb/lancedb";

export interface VectorRecord extends Record<string, unknown> {
  id: string;
  text: string;
  vector: number[];
  metadata: string;
}

export interface SearchResult {
  id: string;
  text: string;
  metadata: string;
  score: number;
}

export interface VectorSearchOptions {
  /** SQL-style prefilter applied before ANN search (e.g. `"source_type = 'decision'"`). */
  where?: string;
  /** Distance metric. "cosine" returns `1 − distance` as score; "l2" returns `1/(1+distance)`. Default: "l2". */
  metric?: "l2" | "cosine";
}

export interface QueryRowsOptions {
  where?: string;
  limit?: number;
  offset?: number;
}

export class LanceStore {
  private db: lancedb.Connection | null = null;
  /** Tables known to already have an FTS index on the "text" column. */
  private readonly ftsIndexed = new Set<string>();
  /**
   * In-flight index-creation promises keyed by table name (M4).
   * Concurrent calls to `ftsSearch` wait on the same promise rather than
   * racing to create the index twice.
   */
  private readonly ftsIndexPending = new Map<string, Promise<void>>();

  constructor(private readonly dbPath: string) {}

  async initialize(): Promise<void> {
    this.db = await lancedb.connect(this.dbPath);
  }

  async upsert(tableName: string, records: VectorRecord[]): Promise<void> {
    if (records.length === 0) {
      return;
    }

    const db = this.requireDb();

    if (await this.tableExists(tableName)) {
      const table = await db.openTable(tableName);
      // True upsert: update existing rows matched by id, insert new ones.
      await table.mergeInsert("id")
        .whenMatchedUpdateAll()
        .whenNotMatchedInsertAll()
        .execute(records);
      return;
    }

    await db.createTable(tableName, records);
  }

  async vectorSearch(
    tableName: string,
    queryVector: number[],
    limit: number,
    options: VectorSearchOptions = {},
  ): Promise<SearchResult[]> {
    const db = this.requireDb();
    if (!(await this.tableExists(tableName))) {
      return [];
    }
    const table = await db.openTable(tableName);
    const metric = options.metric ?? "l2";

    let query = table.vectorSearch(queryVector).distanceType(metric).limit(limit);
    if (options.where) {
      query = query.filter(options.where);
    }

    const results = await query.toArray();
    const toScore = metric === "cosine"
      ? (d: number) => 1 - d               // cosine distance → cosine similarity
      : (d: number) => 1 / (1 + d);        // L2 distance → bounded similarity

    return results.map((row) => ({
      id: row.id as string,
      text: row.text as string,
      metadata: row.metadata as string,
      score: row._distance != null ? toScore(Number(row._distance)) : 0,
    }));
  }

  async ftsSearch(
    tableName: string,
    query: string,
    limit: number,
  ): Promise<SearchResult[]> {
    const db = this.requireDb();
    if (!(await this.tableExists(tableName))) {
      return [];
    }
    const table = await db.openTable(tableName);

    await this.ensureFtsIndex(tableName, table);

    const results = await table.search(query, "fts", "text").limit(limit).toArray();

    return results.map((row, index) => ({
      id: row.id as string,
      text: row.text as string,
      metadata: row.metadata as string,
      score: 1 / (1 + index),
    }));
  }

  async queryRows(
    tableName: string,
    options: QueryRowsOptions = {},
  ): Promise<Array<{ id: string; text: string; metadata: string }>> {
    const db = this.requireDb();
    if (!(await this.tableExists(tableName))) {
      return [];
    }

    const table = await db.openTable(tableName);
    let query = table.query();

    if (options.where) {
      query = query.where(options.where);
    }

    if (typeof options.offset === "number" && options.offset > 0) {
      query = query.offset(Math.floor(options.offset));
    }

    if (typeof options.limit === "number" && options.limit > 0) {
      query = query.limit(Math.floor(options.limit));
    }

    const rows = await query.toArray();
    return rows.map((row) => ({
      id: String(row.id),
      text: String(row.text ?? ""),
      metadata: String(row.metadata ?? "{}"),
    }));
  }

  async tableExists(tableName: string): Promise<boolean> {
    const db = this.requireDb();
    const names = await db.tableNames();
    return names.includes(tableName);
  }

  async deleteTable(tableName: string): Promise<void> {
    const db = this.requireDb();
    await db.dropTable(tableName);
  }

  /**
   * Guarantees that the FTS index on `tableName.text` exists before any FTS
   * search runs.  Uses a per-table promise to prevent concurrent callers from
   * racing to create the index simultaneously (M4).
   */
  private async ensureFtsIndex(
    tableName: string,
    table: lancedb.Table,
  ): Promise<void> {
    if (this.ftsIndexed.has(tableName)) {
      return;
    }

    // If another concurrent call is already building the index, await the same
    // promise instead of launching a second CREATE INDEX.
    let pending = this.ftsIndexPending.get(tableName);
    if (!pending) {
      pending = (async () => {
        try {
          await table.createIndex("text", { config: lancedb.Index.fts() });
        } catch {
          // FTS index may already exist from a previous process — that's fine.
        }
        this.ftsIndexed.add(tableName);
        this.ftsIndexPending.delete(tableName);
      })();
      this.ftsIndexPending.set(tableName, pending);
    }

    await pending;
  }

  private requireDb(): lancedb.Connection {
    if (!this.db) {
      throw new Error("Store not initialized");
    }
    return this.db;
  }
}
