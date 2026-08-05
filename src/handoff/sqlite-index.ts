import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { Database as DatabaseHandle } from "better-sqlite3";
import type { ConversationChunk, ConversationScraper } from "../types/scraper.js";
import {
  DEFAULT_EMBEDDING_MODEL,
  TransformersEmbeddingProvider,
  type EmbeddingProvider,
} from "./embeddings.js";
import type {
  HandoffStatus,
  RetrievalMatch,
  SessionMessage,
  SessionSearchMode,
  SessionService,
  SessionSummary,
} from "./types.js";
import { cosineSimilarity, deserializeVector, serializeVector } from "./vector.js";

interface ToolRuntime {
  tool: string;
  scraper: ConversationScraper;
}

interface SqliteHandoffIndexOptions {
  embeddingProvider?: EmbeddingProvider;
  windowSize?: number;
  windowStride?: number;
}

interface SessionRow {
  session_ref: string;
  tool: string;
  started_at: string;
  last_activity_at: string;
  message_count: number;
  preview: string | null;
  source_path: string | null;
}

interface MessageRow {
  id: string;
  timestamp: string;
  role: SessionMessage["role"];
  content: string;
  message_index: number;
  source_pointer: string | null;
}

interface RetrievalUnitRow {
  unit_id: string;
  session_ref: string;
  tool: string;
  message_start_index: number;
  message_end_index: number;
  started_at: string;
  ended_at: string;
  content: string;
  content_hash: string;
  session_started_at: string;
  session_last_activity_at: string;
  session_message_count: number;
  session_preview: string | null;
  source_path: string | null;
}

interface VectorUnitRow extends RetrievalUnitRow {
  vector: Buffer;
  dimensions: number;
}

interface CountRow {
  count: number;
}

interface ToolCountRow {
  tool: string;
  sessions: number;
  messages: number;
  last_indexed_at: string | null;
}

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 100;
const DEFAULT_WINDOW_SIZE = 8;
const DEFAULT_WINDOW_STRIDE = 4;
const MAX_MATCHES_PER_SESSION = 3;
const SOURCE_CURSOR_OVERLAP_MS = 1_000;

export class SqliteHandoffIndex implements SessionService {
  private db: DatabaseHandle | null = null;
  private readonly initialized: Promise<void>;
  private refreshPromise: Promise<void> | null = null;
  private lastRefreshMs = 0;
  private readonly refreshTtlMs = 1_000;
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly windowSize: number;
  private readonly windowStride: number;

  constructor(
    private readonly dbPath: string,
    private readonly projectRoot: string,
    private readonly tools: ToolRuntime[],
    options: SqliteHandoffIndexOptions = {},
  ) {
    this.embeddingProvider =
      options.embeddingProvider ?? new TransformersEmbeddingProvider(DEFAULT_EMBEDDING_MODEL);
    this.windowSize = Math.max(2, Math.floor(options.windowSize ?? DEFAULT_WINDOW_SIZE));
    this.windowStride = Math.max(1, Math.floor(options.windowStride ?? DEFAULT_WINDOW_STRIDE));
    this.initialized = this.initialize();
  }

  async listRecentSessions(limit: number, toolFilter?: string[]): Promise<SessionSummary[]> {
    await this.refresh({ toolFilter });
    const db = this.getDb();
    const normalizedLimit = normalizeLimit(limit, DEFAULT_LIMIT);
    const filters = normalizeToolFilter(toolFilter);
    const where = filters.length > 0 ? `WHERE tool IN (${placeholders(filters.length)})` : "";
    const rows = db
      .prepare(
        `SELECT session_ref, tool, started_at, last_activity_at, message_count, preview, source_path
         FROM sessions
         ${where}
         ORDER BY datetime(last_activity_at) DESC
         LIMIT ?`,
      )
      .all(...filters, normalizedLimit) as SessionRow[];

    return rows.map(formatSessionRow);
  }

  async getSessionDetail(
    sessionRef: string,
    offset: number,
    limit: number,
  ): Promise<SessionMessage[]> {
    await this.refresh({ sessionRef });
    const db = this.getDb();
    const normalizedOffset = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
    const normalizedLimit = normalizeLimit(limit, 50);
    const rows = db
      .prepare(
        `SELECT id, timestamp, role, content, message_index, source_pointer
         FROM messages
         WHERE session_ref = ?
         ORDER BY datetime(timestamp) ASC, message_index ASC, id ASC
         LIMIT ? OFFSET ?`,
      )
      .all(sessionRef, normalizedLimit, normalizedOffset) as MessageRow[];

    return rows.map((row) => ({
      timestamp: row.timestamp,
      role: row.role,
      content: row.content,
      source_pointer: row.source_pointer ?? undefined,
    }));
  }

  async searchSessions(
    query: string,
    limit: number,
    toolFilter?: string[],
    mode: SessionSearchMode = "hybrid",
  ): Promise<SessionSummary[]> {
    await this.refresh({ toolFilter });
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }

    const normalizedMode = normalizeSearchMode(mode);
    if (normalizedMode === "keyword") {
      return this.keywordSearch(trimmed, limit, toolFilter);
    }

    try {
      return await this.semanticSearch(trimmed, limit, toolFilter, normalizedMode);
    } catch (error) {
      if (normalizedMode === "hybrid") {
        return this.keywordSearch(trimmed, limit, toolFilter);
      }
      throw error;
    }
  }

  async getStatus(): Promise<HandoffStatus> {
    await this.refresh({ statusOnly: true });
    const db = this.getDb();
    const sessionCount = count(db, "sessions");
    const messageCount = count(db, "messages");
    const retrievalUnitCount = count(db, "retrieval_units");
    const vectorizedUnitCount = count(db, "retrieval_unit_vectors");
    const lastScan = getSetting(db, "last_scan_at");
    const indexedByTool = new Map(
      (
        db
          .prepare(
            `SELECT s.tool,
                    COUNT(DISTINCT s.session_ref) AS sessions,
                    COUNT(m.id) AS messages,
                    MAX(m.indexed_at) AS last_indexed_at
             FROM sessions s
             LEFT JOIN messages m ON m.session_ref = s.session_ref
             GROUP BY s.tool`,
          )
          .all() as ToolCountRow[]
      ).map((row) => [row.tool, row]),
    );

    const tools = await Promise.all(
      this.tools.map(async ({ tool, scraper }) => {
        const detected = await safeDetect(scraper);
        const indexed = indexedByTool.get(tool);
        return {
          tool,
          detected,
          store_paths: scraper.getStorePaths(),
          indexed_sessions: indexed?.sessions ?? 0,
          indexed_messages: indexed?.messages ?? 0,
          last_indexed_at: indexed?.last_indexed_at ?? null,
        };
      }),
    );

    return {
      project_root: this.projectRoot,
      db_path: this.dbPath,
      last_scan_at: lastScan,
      sessions: sessionCount,
      messages: messageCount,
      retrieval_units: retrievalUnitCount,
      vectorized_units: vectorizedUnitCount,
      vector_model: this.embeddingProvider.model,
      tools,
    };
  }

  async close(): Promise<void> {
    await this.initialized;
    this.db?.close();
    this.db = null;
  }

  private async refresh(reason: {
    toolFilter?: string[];
    sessionRef?: string;
    statusOnly?: boolean;
  }): Promise<void> {
    await this.initialized;
    if (reason.statusOnly) {
      return;
    }

    if (Date.now() - this.lastRefreshMs < this.refreshTtlMs) {
      return;
    }

    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshNow().finally(() => {
        this.refreshPromise = null;
      });
    }

    await this.refreshPromise;
  }

  private async refreshNow(): Promise<void> {
    const db = this.getDb();
    const startedAt = new Date().toISOString();
    const touchedSessions = new Set<string>();

    for (const { scraper } of this.tools) {
      if (!(await safeDetect(scraper))) {
        continue;
      }

      let latestTimestamp: Date | null = null;
      try {
        for await (const chunk of scraper.scrape()) {
          const sessionRef = this.upsertChunk(chunk);
          if (sessionRef) {
            touchedSessions.add(sessionRef);
          }
          if (!latestTimestamp || chunk.timestamp > latestTimestamp) {
            latestTimestamp = chunk.timestamp;
          }
        }

        if (latestTimestamp) {
          await scraper.saveScrapedPosition({
            lastTimestamp: overlapTimestamp(latestTimestamp),
          });
        }
      } catch (error) {
        setSetting(
          db,
          `last_error:${scraper.tool}`,
          error instanceof Error ? error.message : String(error),
        );
        if (latestTimestamp) {
          try {
            await scraper.saveScrapedPosition({
              lastTimestamp: overlapTimestamp(latestTimestamp),
            });
          } catch {
            // Ignore position save failures inside catch
          }
        }
      }
    }

    for (const sessionRef of touchedSessions) {
      this.rebuildRetrievalUnitsForSession(sessionRef);
    }

    setSetting(db, "last_scan_at", startedAt);
    this.lastRefreshMs = Date.now();
  }

  private upsertChunk(chunk: ConversationChunk): string | null {
    if (!chunk.content.trim()) {
      return null;
    }

    const db = this.getDb();
    const timestamp = chunk.timestamp.toISOString();
    const sessionRef = `${chunk.tool}:${chunk.sessionId}`;
    const messageIndex = chunk.metadata.messageIndex ?? 0;
    const id = hashParts([
      chunk.tool,
      chunk.sessionId,
      timestamp,
      chunk.role,
      String(messageIndex),
      chunk.content,
    ]);
    const contentHash = hashParts([chunk.content]);
    const now = new Date().toISOString();
    const metadataJson = JSON.stringify(chunk.metadata ?? {});
    const sourcePointer = sourcePathFromMetadata(chunk.metadata);

    db.prepare(
      `INSERT INTO sessions
       (session_ref, tool, source_session_id, project_root, started_at, last_activity_at,
        message_count, preview, source_path, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)
       ON CONFLICT(session_ref) DO UPDATE SET
         started_at = CASE
           WHEN excluded.started_at < started_at THEN excluded.started_at
           ELSE started_at
         END,
         last_activity_at = CASE
           WHEN excluded.last_activity_at > last_activity_at THEN excluded.last_activity_at
           ELSE last_activity_at
         END,
         source_path = COALESCE(source_path, excluded.source_path),
         updated_at = excluded.updated_at`,
    ).run(
      sessionRef,
      chunk.tool,
      chunk.sessionId,
      this.projectRoot,
      timestamp,
      timestamp,
      sourcePointer,
      now,
    );

    db.prepare(
      `INSERT OR IGNORE INTO messages
       (id, session_ref, tool, source_session_id, timestamp, role, content,
        message_index, content_hash, metadata_json, source_pointer, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      sessionRef,
      chunk.tool,
      chunk.sessionId,
      timestamp,
      chunk.role,
      chunk.content,
      messageIndex,
      contentHash,
      metadataJson,
      sourcePointer,
      now,
    );

    db.prepare(
      `INSERT OR IGNORE INTO messages_fts(rowid, session_ref, tool, role, timestamp, content)
       SELECT rowid, session_ref, tool, role, timestamp, content
       FROM messages
       WHERE id = ?`,
    ).run(id);

    db.prepare(
      `UPDATE sessions
       SET message_count = (
             SELECT COUNT(*) FROM messages WHERE messages.session_ref = sessions.session_ref
           ),
           preview = COALESCE(
             (
               SELECT substr(content, 1, 240)
               FROM messages
               WHERE messages.session_ref = sessions.session_ref
               ORDER BY datetime(timestamp) ASC, message_index ASC, id ASC
               LIMIT 1
             ),
             preview
           )
       WHERE session_ref = ?`,
    ).run(sessionRef);

    return sessionRef;
  }

  private rebuildRetrievalUnitsForSession(sessionRef: string): void {
    const db = this.getDb();
    const messages = db
      .prepare(
        `SELECT id, timestamp, role, content, message_index, source_pointer
         FROM messages
         WHERE session_ref = ?
         ORDER BY datetime(timestamp) ASC, message_index ASC, id ASC`,
      )
      .all(sessionRef) as MessageRow[];

    db.prepare("DELETE FROM retrieval_units_fts WHERE session_ref = ?").run(sessionRef);
    db.prepare("DELETE FROM retrieval_units WHERE session_ref = ?").run(sessionRef);

    if (messages.length === 0) {
      return;
    }

    const session = db
      .prepare("SELECT tool FROM sessions WHERE session_ref = ?")
      .get(sessionRef) as { tool: string } | undefined;
    if (!session) {
      return;
    }

    const now = new Date().toISOString();
    for (const window of buildMessageWindows(messages, this.windowSize, this.windowStride)) {
      const content = formatRetrievalUnitContent(sessionRef, window.messages);
      const contentHash = hashParts([content]);
      const unitId = hashParts([
        "retrieval-unit",
        sessionRef,
        String(window.start.message_index),
        String(window.end.message_index),
        contentHash,
      ]);

      db.prepare(
        `INSERT INTO retrieval_units
         (id, session_ref, tool, message_start_index, message_end_index,
          started_at, ended_at, content, content_hash, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        unitId,
        sessionRef,
        session.tool,
        window.start.message_index,
        window.end.message_index,
        window.start.timestamp,
        window.end.timestamp,
        content,
        contentHash,
        now,
      );

      db.prepare(
        `INSERT INTO retrieval_units_fts(unit_id, session_ref, tool, content)
         VALUES (?, ?, ?, ?)`,
      ).run(unitId, sessionRef, session.tool, content);
    }
  }

  private async keywordSearch(
    query: string,
    limit: number,
    toolFilter?: string[],
  ): Promise<SessionSummary[]> {
    const rows = this.queryKeywordUnits(query, limit, toolFilter);
    return groupUnits(rows, new Map(), "keyword", normalizeLimit(limit, DEFAULT_LIMIT));
  }

  private async semanticSearch(
    query: string,
    limit: number,
    toolFilter: string[] | undefined,
    mode: Exclude<SessionSearchMode, "keyword">,
  ): Promise<SessionSummary[]> {
    const normalizedLimit = normalizeLimit(limit, DEFAULT_LIMIT);
    await this.ensureVectors(toolFilter);

    const db = this.getDb();
    const filters = normalizeToolFilter(toolFilter);
    const toolWhere = filters.length > 0 ? `AND u.tool IN (${placeholders(filters.length)})` : "";
    const rows = db
      .prepare(
        `${retrievalUnitSelect()},
                v.vector,
                v.dimensions
         FROM retrieval_units u
         JOIN retrieval_unit_vectors v ON v.unit_id = u.id
         JOIN sessions s ON s.session_ref = u.session_ref
         WHERE v.model = ? ${toolWhere}`,
      )
      .all(this.embeddingProvider.model, ...filters) as VectorUnitRow[];

    if (rows.length === 0) {
      return [];
    }

    const keywordRows = mode === "hybrid" ? this.queryKeywordUnits(query, limit, toolFilter) : [];
    const keywordScores = rankKeywordRows(keywordRows);
    const queryVector = await this.embeddingProvider.embed(query);
    const timeRange = getTimeRange(rows.map((row) => row.ended_at));
    const scored = rows
      .map((row) => {
        const semanticScore = normalizeCosine(
          cosineSimilarity(queryVector, deserializeVector(row.vector, row.dimensions)),
        );
        const keywordScore = keywordScores.get(row.unit_id) ?? 0;
        const recencyScore = scoreRecency(row.ended_at, timeRange);
        const continuityScore = scoreContinuity(row.message_end_index, row.session_message_count);
        return {
          row,
          score: blendScores(mode, semanticScore, keywordScore, recencyScore, continuityScore),
          semanticScore,
          keywordScore,
          recencyScore,
          continuityScore,
        };
      })
      .sort((left, right) => right.score - left.score);

    return groupScoredUnits(scored, mode, normalizedLimit);
  }

  private queryKeywordUnits(
    query: string,
    limit: number,
    toolFilter?: string[],
  ): RetrievalUnitRow[] {
    const ftsQuery = toFtsQuery(query);
    if (!ftsQuery) {
      return [];
    }

    const db = this.getDb();
    const normalizedLimit = normalizeLimit(limit, DEFAULT_LIMIT);
    const filters = normalizeToolFilter(toolFilter);
    const toolWhere = filters.length > 0 ? `AND u.tool IN (${placeholders(filters.length)})` : "";
    return db
      .prepare(
        `${retrievalUnitSelect()}
         FROM retrieval_units_fts f
         JOIN retrieval_units u ON u.id = f.unit_id
         JOIN sessions s ON s.session_ref = u.session_ref
         WHERE retrieval_units_fts MATCH ? ${toolWhere}
         ORDER BY bm25(retrieval_units_fts), datetime(u.ended_at) DESC
         LIMIT ?`,
      )
      .all(ftsQuery, ...filters, normalizedLimit * MAX_MATCHES_PER_SESSION) as RetrievalUnitRow[];
  }

  private async ensureVectors(toolFilter?: string[]): Promise<void> {
    const db = this.getDb();
    const filters = normalizeToolFilter(toolFilter);
    const toolWhere = filters.length > 0 ? `AND u.tool IN (${placeholders(filters.length)})` : "";
    const rows = db
      .prepare(
        `SELECT u.id AS unit_id, u.content, u.content_hash
         FROM retrieval_units u
         LEFT JOIN retrieval_unit_vectors v
           ON v.unit_id = u.id
          AND v.model = ?
          AND v.content_hash = u.content_hash
         WHERE v.unit_id IS NULL ${toolWhere}
         ORDER BY datetime(u.ended_at) DESC`,
      )
      .all(this.embeddingProvider.model, ...filters) as Array<{
        unit_id: string;
        content: string;
        content_hash: string;
      }>;

    if (rows.length === 0) {
      return;
    }

    const vectors = await this.embeddingProvider.embedBatch(rows.map((row) => row.content));
    const now = new Date().toISOString();
    const upsert = db.prepare(
      `INSERT INTO retrieval_unit_vectors
       (unit_id, model, dimensions, content_hash, vector, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(unit_id) DO UPDATE SET
         model = excluded.model,
         dimensions = excluded.dimensions,
         content_hash = excluded.content_hash,
         vector = excluded.vector,
         created_at = excluded.created_at`,
    );

    const transaction = db.transaction(() => {
      rows.forEach((row, index) => {
        const vector = vectors[index];
        upsert.run(
          row.unit_id,
          this.embeddingProvider.model,
          vector.length,
          row.content_hash,
          serializeVector(vector),
          now,
        );
      });
    });
    transaction();
  }

  private async initialize(): Promise<void> {
    await mkdir(dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    createSchema(this.db);
  }

  private getDb(): DatabaseHandle {
    if (!this.db) {
      throw new Error("xtctx handoff index is closed");
    }
    return this.db;
  }
}

function createSchema(db: DatabaseHandle): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_ref TEXT PRIMARY KEY,
      tool TEXT NOT NULL,
      source_session_id TEXT NOT NULL,
      project_root TEXT NOT NULL,
      started_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      preview TEXT,
      source_path TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_ref TEXT NOT NULL REFERENCES sessions(session_ref) ON DELETE CASCADE,
      tool TEXT NOT NULL,
      source_session_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      message_index INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      source_pointer TEXT,
      indexed_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_activity ON sessions(last_activity_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_session_order
      ON messages(session_ref, timestamp, message_index, id);

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
      USING fts5(session_ref UNINDEXED, tool UNINDEXED, role UNINDEXED, timestamp UNINDEXED, content);

    CREATE TABLE IF NOT EXISTS retrieval_units (
      id TEXT PRIMARY KEY,
      session_ref TEXT NOT NULL REFERENCES sessions(session_ref) ON DELETE CASCADE,
      tool TEXT NOT NULL,
      message_start_index INTEGER NOT NULL,
      message_end_index INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_retrieval_units_session
      ON retrieval_units(session_ref, message_start_index, message_end_index);
    CREATE INDEX IF NOT EXISTS idx_retrieval_units_tool_time
      ON retrieval_units(tool, ended_at DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS retrieval_units_fts
      USING fts5(unit_id UNINDEXED, session_ref UNINDEXED, tool UNINDEXED, content);

    CREATE TABLE IF NOT EXISTS retrieval_unit_vectors (
      unit_id TEXT PRIMARY KEY REFERENCES retrieval_units(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      vector BLOB NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_retrieval_unit_vectors_model
      ON retrieval_unit_vectors(model);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function retrievalUnitSelect(): string {
  return `SELECT u.id AS unit_id,
                u.session_ref,
                u.tool,
                u.message_start_index,
                u.message_end_index,
                u.started_at,
                u.ended_at,
                u.content,
                u.content_hash,
                s.started_at AS session_started_at,
                s.last_activity_at AS session_last_activity_at,
                s.message_count AS session_message_count,
                s.preview AS session_preview,
                s.source_path`;
}

function formatSessionRow(row: SessionRow): SessionSummary {
  return {
    session_ref: row.session_ref,
    tool: row.tool,
    started_at: row.started_at,
    last_activity_at: row.last_activity_at,
    message_count: row.message_count,
    preview: row.preview ?? undefined,
    source_path: row.source_path ?? undefined,
  };
}

function buildMessageWindows(
  messages: MessageRow[],
  windowSize: number,
  windowStride: number,
): Array<{ start: MessageRow; end: MessageRow; messages: MessageRow[] }> {
  const windows: Array<{ start: MessageRow; end: MessageRow; messages: MessageRow[] }> = [];
  for (let start = 0; start < messages.length; start += windowStride) {
    const slice = messages.slice(start, start + windowSize);
    if (slice.length === 0) {
      continue;
    }

    windows.push({
      start: slice[0],
      end: slice[slice.length - 1],
      messages: slice,
    });

    if (start + windowSize >= messages.length) {
      break;
    }
  }
  return windows;
}

function formatRetrievalUnitContent(sessionRef: string, messages: MessageRow[]): string {
  const lines = [
    `Session: ${sessionRef}`,
    `Chronological window: messages ${messages[0].message_index} through ${
      messages[messages.length - 1].message_index
    }`,
  ];

  for (const [index, message] of messages.entries()) {
    lines.push(
      [
        `Turn ${index + 1}/${messages.length}`,
        `message_index=${message.message_index}`,
        `${message.role} @ ${message.timestamp}`,
      ].join(" | "),
    );
    lines.push(message.content);
  }

  return lines.join("\n");
}

function groupUnits(
  rows: RetrievalUnitRow[],
  keywordScores: Map<string, number>,
  retrieval: SessionSearchMode,
  limit: number,
): SessionSummary[] {
  const timeRange = getTimeRange(rows.map((row) => row.ended_at));
  const scored = rows.map((row) => {
    const keywordScore = keywordScores.get(row.unit_id) ?? 1;
    const recencyScore = scoreRecency(row.ended_at, timeRange);
    const continuityScore = scoreContinuity(row.message_end_index, row.session_message_count);
    return {
      row,
      score: blendScores("keyword", 0, keywordScore, recencyScore, continuityScore),
      semanticScore: 0,
      keywordScore,
      recencyScore,
      continuityScore,
    };
  });
  return groupScoredUnits(scored, retrieval, limit);
}

function groupScoredUnits(
  scored: Array<{
    row: RetrievalUnitRow;
    score: number;
    semanticScore: number;
    keywordScore: number;
    recencyScore: number;
    continuityScore: number;
  }>,
  retrieval: SessionSearchMode,
  limit: number,
): SessionSummary[] {
  const sessions = new Map<string, SessionSummary>();

  for (const item of scored) {
    const existing = sessions.get(item.row.session_ref);
    const match = formatMatch(item);

    if (existing) {
      if ((existing.matches?.length ?? 0) < MAX_MATCHES_PER_SESSION) {
        existing.matches = [...(existing.matches ?? []), match];
      }
      existing.score = Math.max(existing.score ?? 0, item.score);
      continue;
    }

    sessions.set(item.row.session_ref, {
      session_ref: item.row.session_ref,
      tool: item.row.tool,
      started_at: item.row.session_started_at,
      last_activity_at: item.row.session_last_activity_at,
      message_count: item.row.session_message_count,
      preview: item.row.session_preview ?? previewText(item.row.content),
      source_path: item.row.source_path ?? undefined,
      score: item.score,
      retrieval,
      matches: [match],
    });

    if (sessions.size >= limit) {
      break;
    }
  }

  return [...sessions.values()].sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
}

function formatMatch(item: {
  row: RetrievalUnitRow;
  score: number;
  semanticScore: number;
  keywordScore: number;
  recencyScore: number;
  continuityScore: number;
}): RetrievalMatch {
  return {
    unit_id: item.row.unit_id,
    message_start_index: item.row.message_start_index,
    message_end_index: item.row.message_end_index,
    started_at: item.row.started_at,
    ended_at: item.row.ended_at,
    preview: previewText(item.row.content),
    score: roundScore(item.score),
    semantic_score: roundScore(item.semanticScore),
    keyword_score: roundScore(item.keywordScore),
    recency_score: roundScore(item.recencyScore),
    continuity_score: roundScore(item.continuityScore),
  };
}

function rankKeywordRows(rows: RetrievalUnitRow[]): Map<string, number> {
  const scores = new Map<string, number>();
  rows.forEach((row, index) => {
    scores.set(row.unit_id, 1 / (index + 1));
  });
  return scores;
}

function blendScores(
  mode: SessionSearchMode,
  semanticScore: number,
  keywordScore: number,
  recencyScore: number,
  continuityScore: number,
): number {
  if (mode === "vector") {
    return 0.85 * semanticScore + 0.1 * recencyScore + 0.05 * continuityScore;
  }

  if (mode === "keyword") {
    return 0.75 * keywordScore + 0.15 * recencyScore + 0.1 * continuityScore;
  }

  return (
    0.65 * semanticScore +
    0.2 * keywordScore +
    0.1 * recencyScore +
    0.05 * continuityScore
  );
}

function normalizeCosine(score: number): number {
  return Math.max(0, Math.min(1, (score + 1) / 2));
}

function scoreContinuity(messageEndIndex: number, messageCount: number): number {
  if (messageCount <= 1) {
    return 1;
  }
  return Math.max(0, Math.min(1, messageEndIndex / (messageCount - 1)));
}

function scoreRecency(value: string, range: { oldest: number; newest: number }): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || range.newest <= range.oldest) {
    return 1;
  }
  return Math.max(0, Math.min(1, (timestamp - range.oldest) / (range.newest - range.oldest)));
}

function getTimeRange(values: string[]): { oldest: number; newest: number } {
  const timestamps = values
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));
  if (timestamps.length === 0) {
    return { oldest: 0, newest: 0 };
  }
  return {
    oldest: Math.min(...timestamps),
    newest: Math.max(...timestamps),
  };
}

function previewText(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 240);
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function normalizeLimit(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(value), MAX_LIMIT);
}

function normalizeSearchMode(value: SessionSearchMode): SessionSearchMode {
  return value === "keyword" || value === "vector" || value === "hybrid" ? value : "hybrid";
}

function normalizeToolFilter(value?: string[]): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.filter((item) => typeof item === "string" && item.length > 0))];
}

function toFtsQuery(query: string): string {
  return (
    query
      .toLowerCase()
      .match(/[a-z0-9_./:-]{2,}/g)
      ?.map((term) => `"${term.replace(/"/g, "\"\"")}"`)
      .join(" OR ") ?? ""
  );
}

function placeholders(countValue: number): string {
  return Array.from({ length: countValue }, () => "?").join(", ");
}

function count(
  db: DatabaseHandle,
  table: "sessions" | "messages" | "retrieval_units" | "retrieval_unit_vectors",
): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as CountRow;
  return row.count;
}

function getSetting(db: DatabaseHandle, key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function setSetting(db: DatabaseHandle, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings(key, value)
     VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

function sourcePathFromMetadata(metadata: ConversationChunk["metadata"]): string | null {
  const value = (metadata as { sourcePath?: unknown }).sourcePath;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function overlapTimestamp(value: Date): Date {
  return new Date(Math.max(0, value.getTime() - SOURCE_CURSOR_OVERLAP_MS));
}

function hashParts(parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function safeDetect(scraper: ConversationScraper): Promise<boolean> {
  try {
    return await scraper.detect();
  } catch {
    return false;
  }
}
