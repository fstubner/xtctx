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

export class LanceStore {
  private db: lancedb.Connection | null = null;

  constructor(private readonly dbPath: string) {}

  async initialize(): Promise<void> {
    this.db = await lancedb.connect(this.dbPath);
  }

  async upsert(tableName: string, records: VectorRecord[]): Promise<void> {
    if (records.length === 0) {
      return;
    }

    const db = this.requireDb();
    const tableNames = await db.tableNames();

    if (tableNames.includes(tableName)) {
      const table = await db.openTable(tableName);
      await table.add(records);
      return;
    }

    await db.createTable(tableName, records);
  }

  async vectorSearch(
    tableName: string,
    queryVector: number[],
    limit: number,
  ): Promise<SearchResult[]> {
    const db = this.requireDb();
    const table = await db.openTable(tableName);
    const results = await table.vectorSearch(queryVector).limit(limit).toArray();

    return results.map((row) => ({
      id: row.id as string,
      text: row.text as string,
      metadata: row.metadata as string,
      score: row._distance != null ? 1 / (1 + Number(row._distance)) : 0,
    }));
  }

  async ftsSearch(
    tableName: string,
    query: string,
    limit: number,
  ): Promise<SearchResult[]> {
    const db = this.requireDb();
    const table = await db.openTable(tableName);

    try {
      await table.createIndex("text", { config: lancedb.Index.fts() });
    } catch {
      // FTS index may already exist.
    }

    const results = await table.search(query, "fts", "text").limit(limit).toArray();

    return results.map((row, index) => ({
      id: row.id as string,
      text: row.text as string,
      metadata: row.metadata as string,
      score: 1 / (1 + index),
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

  private requireDb(): lancedb.Connection {
    if (!this.db) {
      throw new Error("Store not initialized");
    }
    return this.db;
  }
}
