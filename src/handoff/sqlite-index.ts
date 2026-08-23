import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import type { Database as DatabaseHandle, Statement, Transaction } from "better-sqlite3";
import type { ConversationChunk, ConversationScraper } from "../types/scraper.js";
import {
  DEFAULT_EMBEDDING_MODEL,
  TransformersEmbeddingProvider,
  poolVectors,
  splitTextForEmbedding,
  type EmbeddingProvider,
} from "./embeddings.js";
import type {
  HandoffStatus,
  IndexProgress,
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

interface PreparedStatements {
  upsertSession: Statement;
  insertMessage: Statement;
  upsertChunkTxn: Transaction<(sessionArgs: unknown[], messageArgs: unknown[]) => void>;
  sessionRollup: Statement;
  selectSessionMessages: Statement;
  selectSessionTool: Statement;
  selectUnitIds: Statement;
  insertUnit: Statement;
  insertUnitFts: Statement;
  deleteUnit: Statement;
  deleteUnitFts: Statement;
}

interface SqliteHandoffIndexOptions {
  embeddingProvider?: EmbeddingProvider;
  windowSize?: number;
  windowStride?: number;
  /** How long a caller waits for a scan before taking what is indexed so far. */
  refreshBudgetMs?: number;
  /** How long one search spends building vectors before answering with what it has. */
  vectorBudgetMs?: number;
  /**
   * Whether opening the index may create it.
   *
   * `xtctx status` is a diagnostic — it should be able to report on a
   * project without leaving a database behind in one it was only asked to
   * look at. When false and no index exists, reads run against an in-memory
   * database and report zeros, which is the truth for a project that has
   * never been set up.
   */
  createIfMissing?: boolean;
}

/**
 * How long a tool call will wait for a scan of every transcript store on the
 * machine.
 *
 * A cold scan here takes about 55 seconds — 18GB of codex history is most of
 * it — and it used to run inside the caller's first tool call. MCP servers are
 * spawned per agent session, so that was paid on every handoff, and a host
 * with a 30s tool timeout never got a first answer at all.
 *
 * The scan is not cancelled when the budget expires; the caller just stops
 * waiting for it. Everything it has already written stays written, so the next
 * call sees more, and the call after that sees all of it.
 */
const DEFAULT_REFRESH_BUDGET_MS = 4_000;

/**
 * How long one search spends building vectors before answering.
 *
 * The first semantic search used to vectorize the entire corpus inline: 530
 * seconds on a 1,145-window index, inside a single tool call, with no cap and
 * nothing to show for the wait. Each batch commits on its own, so stopping
 * early costs nothing — the next search picks up where this one stopped, and
 * recall improves call over call until the corpus is covered.
 */
const DEFAULT_VECTOR_BUDGET_MS = 6_000;

interface SessionRow {
  session_ref: string;
  tool: string;
  started_at: string;
  last_activity_at: string;
  message_count: number;
  preview: string | null;
  source_path: string | null;
  git_branch: string | null;
  git_commit: string | null;
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

/**
 * Bumped whenever the schema shape changes. The index is derived data, so a
 * version mismatch (older or newer) triggers a full rebuild rather than a
 * migration — the transcript stores remain authoritative.
 */
const SCHEMA_VERSION = 2;

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 100;
const DEFAULT_WINDOW_SIZE = 8;
const DEFAULT_WINDOW_STRIDE = 4;
const MAX_MATCHES_PER_SESSION = 3;
/**
 * Minimum raw cosine similarity for a retrieval window to count as a semantic
 * match.
 *
 * Unrelated sentence-transformer pairs sit near 0; related ones are
 * comfortably above this.
 */
const MIN_SEMANTIC_COSINE = 0.15;

/**
 * How similar the *best* window has to be before a query counts as having
 * found anything semantically.
 *
 * The per-window floor above cannot do this job. Raising it high enough to
 * reject a nonsense query — which cleared 0.15 on 927 of 1,145 windows, 81% of
 * the corpus — also discards genuine mid-range matches, and pure vector search
 * has no keyword hits to fall back on: at a 0.35 per-window floor the eval
 * lost recall@5 from 0.70 to 0.50.
 *
 * Whether a query found anything is a property of the query, not of each
 * window. So when nothing clears this bar, semantic matches are dropped
 * wholesale and only keyword hits remain — usually meaning "no matching
 * sessions", which is the honest answer. When something does clear it, the
 * weaker windows around it are kept.
 *
 * The value is bounded from both sides, and as the corpus has grown those
 * bounds have crossed. Genuine queries reach 0.44-0.59, but gibberish now
 * reaches 0.331 — and every value above 0.32 costs the eval real vector
 * recall, measured: 0.34 takes recall@5 from 0.70 to 0.60, 0.36 to 0.55, 0.40
 * to 0.40. So 0.32 is not a comfortable gap any more, it is the best available
 * compromise, and a nonsense query can clear it.
 *
 * Separating those cases needs something a single global cosine cannot give —
 * a per-query sense of whether the best match stands out from the rest of the
 * corpus, rather than an absolute number. Worth doing when it matters enough;
 * raising this constant is not that, and costs recall people rely on.
 *
 * If it needs to move, move it against the eval rather than against one query.
 */
const MIN_CONFIDENT_COSINE = 0.32;
/**
 * Weight of the recency/continuity tie-break in the relevance modes. Small
 * enough that it only ever separates candidates that are otherwise equal.
 */
const TIE_BREAK_WEIGHT = 0.005;
const SOURCE_CURSOR_OVERLAP_MS = 1_000;

export class SqliteHandoffIndex implements SessionService {
  private db: DatabaseHandle | null = null;
  private stmts: PreparedStatements | null = null;
  private readonly initialized: Promise<void>;
  private refreshPromise: Promise<void> | null = null;
  private lastRefreshMs = 0;
  /**
   * How long an indexed view is treated as current.
   *
   * A scan re-reads every transcript store on the machine, so at five seconds
   * almost every tool call in a session started a fresh one and paid the wait
   * budget again. The transcripts being read belong to sessions that ended
   * before this one started; they do not change second to second.
   */
  private readonly refreshTtlMs = 30_000;
  private readonly refreshBudgetMs: number;
  private readonly vectorBudgetMs: number;
  private scanStartedMs = 0;
  private readonly createIfMissing: boolean;
  /** Windows still waiting to be vectorized after the last search gave up its budget. */
  private vectorBacklog = 0;
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
    this.refreshBudgetMs = Math.max(0, options.refreshBudgetMs ?? DEFAULT_REFRESH_BUDGET_MS);
    this.vectorBudgetMs = Math.max(0, options.vectorBudgetMs ?? DEFAULT_VECTOR_BUDGET_MS);
    this.createIfMissing = options.createIfMissing ?? true;
    this.initialized = this.initialize();
    // Attach a no-op handler so a failed open cannot become an unhandled
    // rejection (which would kill the process) before the first caller
    // awaits; each awaiter of `initialized` still observes the rejection.
    this.initialized.catch(() => {});
  }

  async listRecentSessions(
    limit: number,
    toolFilter?: string[],
    branchFilter?: string[],
  ): Promise<SessionSummary[]> {
    await this.refresh({ toolFilter });
    const db = this.getDb();
    const normalizedLimit = normalizeLimit(limit, DEFAULT_LIMIT);
    const filters = normalizeToolFilter(toolFilter);
    const branches = normalizeToolFilter(branchFilter);
    const clauses: string[] = [];
    if (filters.length > 0) {
      clauses.push(`tool IN (${placeholders(filters.length)})`);
    }
    if (branches.length > 0) {
      // A session with no recorded branch is not evidence that it was on the
      // requested one, so it is excluded rather than assumed in.
      clauses.push(`git_branch IN (${placeholders(branches.length)})`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db
      .prepare(
        `SELECT session_ref, tool, started_at, last_activity_at, message_count, preview, source_path,
                git_branch, git_commit
         FROM sessions
         ${where}
         ORDER BY last_activity_at DESC
         LIMIT ?`,
      )
      .all(...filters, ...branches, normalizedLimit) as SessionRow[];

    return rows.map(formatSessionRow);
  }

  /**
   * What is already indexed, with no scan and no waiting.
   *
   * The SessionStart hook runs before the user has typed anything, so it
   * cannot afford the scan `listRecentSessions` starts — even bounded, that
   * is four seconds added to every agent startup. Priming with slightly
   * stale context instantly beats priming with fresh context late.
   */
  async listIndexedSessions(limit: number): Promise<SessionSummary[]> {
    await this.initialized;
    const db = this.getDb();
    const rows = db
      .prepare(
        `SELECT session_ref, tool, started_at, last_activity_at, message_count, preview, source_path,
                git_branch, git_commit
         FROM sessions
         ORDER BY last_activity_at DESC
         LIMIT ?`,
      )
      .all(normalizeLimit(limit, DEFAULT_LIMIT)) as SessionRow[];

    return rows.map(formatSessionRow);
  }
  async getSessionByRef(sessionRef: string): Promise<SessionSummary | null> {
    await this.refresh({ sessionRef });
    const db = this.getDb();
    const row = db
      .prepare(
        `SELECT session_ref, tool, started_at, last_activity_at, message_count, preview, source_path,
                git_branch, git_commit
         FROM sessions
         WHERE session_ref = ?`,
      )
      .get(sessionRef) as SessionRow | undefined;

    return row ? formatSessionRow(row) : null;
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
         ORDER BY timestamp ASC, message_index ASC, id ASC
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
    branchFilter?: string[],
  ): Promise<SessionSummary[]> {
    await this.refresh({ toolFilter });
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }

    const normalizedMode = normalizeSearchMode(mode);
    if (normalizedMode === "keyword") {
      return this.keywordSearch(trimmed, limit, toolFilter, branchFilter);
    }

    // Loading the embedding model is a one-off that takes minutes on a cold
    // cache. Hybrid is the default mode, so blocking it on that made the first
    // search of a session look broken. Start the load, answer from keyword,
    // and let the next search use the model. An explicit `vector` request is a
    // different matter: there is no other route, so that one waits.
    if (normalizedMode === "hybrid" && this.embeddingProvider.isReady?.() === false) {
      this.embeddingProvider.warm?.();
      return this.keywordSearch(trimmed, limit, toolFilter, branchFilter);
    }

    try {
      const results = await this.semanticSearch(
        trimmed,
        limit,
        toolFilter,
        normalizedMode,
        branchFilter,
      );
      clearSetting(this.getDb(), "last_error:embeddings");
      return results;
    } catch (error) {
      if (normalizedMode === "hybrid") {
        // Degrading to keyword keeps search useful, but a broken embedding
        // path must not be invisible: it silently returned keyword-only
        // results for every user while status still read healthy.
        const message = error instanceof Error ? error.message : String(error);
        setSetting(this.getDb(), "last_error:embeddings", message);
        process.stderr.write(`xtctx: semantic search unavailable, using keyword only (${message})\n`);
        return this.keywordSearch(trimmed, limit, toolFilter, branchFilter);
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
          last_error: getSetting(db, `last_error:${tool}`),
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
      embedding_error: getSetting(db, "last_error:embeddings"),
      tools,
    };
  }

  async close(): Promise<void> {
    await this.initialized.catch(() => {});
    // A scan may still be running because a caller stopped waiting for it.
    // Closing the database underneath it would turn an ordinary shutdown into
    // a write to a closed handle.
    await this.whenScanSettled();
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
      const running = this.refreshNow().finally(() => {
        // Stamp the TTL on failure as well as success so a persistently
        // broken refresh backs off instead of re-running on every call.
        this.lastRefreshMs = Date.now();
        this.refreshPromise = null;
      });
      // A caller may stop waiting on this promise, so it needs its own
      // handler: an unhandled rejection would take the process down.
      running.catch(() => {});
      this.refreshPromise = running;
      this.scanStartedMs = Date.now();
    }

    await this.waitWithBudget(this.refreshPromise);
  }

  /**
   * Wait for the scan, but not past the budget. Nothing is cancelled on
   * timeout — the scan keeps running and keeps committing — so a caller that
   * stops waiting costs the index nothing, and the next call finds more.
   */
  private async waitWithBudget(scan: Promise<void>): Promise<void> {
    if (this.refreshBudgetMs === 0) {
      return;
    }

    // The budget is spent by the scan, not by each caller. Measuring it from
    // when the scan started means one call pays the wait and the calls behind
    // it return straight away with whatever has landed so far — rather than
    // every call in a session paying the full budget over again.
    const remaining = this.scanStartedMs + this.refreshBudgetMs - Date.now();
    if (remaining <= 0) {
      return;
    }

    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, remaining);
      // Do not hold the process open just to enforce a deadline.
      timer.unref?.();
    });

    try {
      await Promise.race([scan.catch(() => {}), budget]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** True when a scan started by an earlier call is still running. */
  isScanning(): boolean {
    return this.refreshPromise !== null;
  }

  getIndexProgress(): IndexProgress {
    return {
      scanning: this.isScanning(),
      vectorBacklog: this.countUnvectorizedUnits(),
      // Asked, not remembered. The flag was only ever written by a search, so
      // the scan-time warm left it reading false while the model was loading —
      // and two more tools now publish it.
      embeddingWarming: this.embeddingProvider.isReady?.() === false,
    };
  }

  /**
   * Windows with no vector for the current model.
   *
   * Counted from the index rather than remembered from the last vectorizing
   * pass: that pass only runs inside a search, so anything that had not run
   * one yet reported a backlog of zero — which a JSON consumer reads as
   * "nothing outstanding" while thousands of windows are unvectorized.
   */
  private countUnvectorizedUnits(): number {
    try {
      const row = this.getDb()
        .prepare(
          `SELECT COUNT(*) AS count
           FROM retrieval_units u
           LEFT JOIN retrieval_unit_vectors v
             ON v.unit_id = u.id
            AND v.model = ?
            AND v.content_hash = u.content_hash
           WHERE v.unit_id IS NULL`,
        )
        .get(this.embeddingProvider.model) as CountRow | undefined;
      return row?.count ?? 0;
    } catch {
      // Progress reporting must never be the thing that fails a tool call.
      return 0;
    }
  }

  /** Resolves when no scan is in flight. Used by close() and by tests. */
  async whenScanSettled(): Promise<void> {
    while (this.refreshPromise) {
      await this.refreshPromise.catch(() => {});
    }
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
        clearSetting(db, `last_error:${scraper.tool}`);
      } catch (error) {
        setSetting(
          db,
          `last_error:${scraper.tool}`,
          error instanceof Error ? error.message : String(error),
        );
        // Deliberately do NOT advance the cursor here: chunks yielded before
        // the failure may sort after content in files never reached, and
        // advancing would skip that content permanently. Re-scraping the
        // same window is safe (message ids are deterministic hashes).
      }
    }

    for (const sessionRef of touchedSessions) {
      // Roll up message_count/preview once per touched session rather than
      // once per inserted message (which made indexing O(N²) per session).
      this.prepared().sessionRollup.run(sessionRef);
      this.rebuildRetrievalUnitsForSession(sessionRef);
    }

    setSetting(db, "last_scan_at", startedAt);

    // Warm vectors here too, not only inside a search.
    //
    // Vectorizing used to happen exclusively in `searchSessions`, where it is
    // capped so the caller is not left waiting. On a real corpus that means
    // about 80 searches — each paying the cap — before semantic search covers
    // the index, and an index nobody has searched yet reports zero vectors
    // against thousands of windows. A scan already runs in the background with
    // nobody waiting on it, which is the right place to spend the time.
    //
    // Same cap as a search, so this cannot become an unbounded CPU burn, and
    // failures are swallowed: warming is opportunistic, and a broken embedding
    // provider is already reported by the search path that depends on it.
    //
    // It does not finish quickly, and raising the cap would not change that:
    // embedding runs at roughly 1.3 windows a second here, so a cold
    // 1300-window index is about 17 minutes of CPU however it is spent — at
    // this cap, ~8 windows a scan. What makes that acceptable is the order:
    // `ensureVectors` takes the most recent windows first, so the history a
    // handoff actually reaches for is covered long before the archive is.
    // Only when the model is already loaded. Loading it is a one-off that can
    // take minutes on a cold cache and is not covered by the cap, and `close()`
    // waits for the scan — so warming through an unloaded model would turn
    // shutting the server down into a multi-minute hang. Start the load and
    // leave the vectors to the next scan instead.
    if (this.embeddingProvider.isReady?.() === false) {
      this.embeddingProvider.warm?.();
      return;
    }

    try {
      await this.ensureVectors();
    } catch {
      // Nothing to do here — search reports embedding failures where they matter.
    }
  }

  private upsertChunk(chunk: ConversationChunk): string | null {
    if (!chunk.content.trim()) {
      return null;
    }

    const stmts = this.prepared();
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

    stmts.upsertChunkTxn(
      [
        sessionRef,
        chunk.tool,
        chunk.sessionId,
        this.projectRoot,
        chunk.metadata?.gitBranch ?? null,
        chunk.metadata?.gitCommit ?? null,
        timestamp,
        timestamp,
        sourcePointer,
        now,
      ],
      [
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
      ],
    );

    return sessionRef;
  }

  private rebuildRetrievalUnitsForSession(sessionRef: string): void {
    const db = this.getDb();
    const stmts = this.prepared();
    const messages = stmts.selectSessionMessages.all(sessionRef) as MessageRow[];

    if (messages.length === 0) {
      db.prepare("DELETE FROM retrieval_units_fts WHERE session_ref = ?").run(sessionRef);
      db.prepare("DELETE FROM retrieval_units WHERE session_ref = ?").run(sessionRef);
      return;
    }

    const session = stmts.selectSessionTool.get(sessionRef) as { tool: string } | undefined;
    if (!session) {
      return;
    }

    // Diff the desired windows against what is stored instead of deleting
    // everything: unit ids are deterministic content hashes, so unchanged
    // windows (and, via the FK, their vectors) survive a re-index untouched.
    const now = new Date().toISOString();
    const desired = new Map<
      string,
      {
        start: MessageRow;
        end: MessageRow;
        content: string;
        searchableText: string;
        contentHash: string;
      }
    >();
    for (const window of buildMessageWindows(messages, this.windowSize, this.windowStride)) {
      const content = formatRetrievalUnitContent(sessionRef, window.messages);
      const searchableText = window.messages.map((message) => message.content).join("\n");
      const contentHash = hashParts([content]);
      const unitId = hashParts([
        "retrieval-unit",
        sessionRef,
        String(window.start.message_index),
        String(window.end.message_index),
        contentHash,
      ]);
      desired.set(unitId, {
        start: window.start,
        end: window.end,
        content,
        searchableText,
        contentHash,
      });
    }

    const existing = new Set(
      (stmts.selectUnitIds.all(sessionRef) as Array<{ id: string }>).map((row) => row.id),
    );

    const applyDiff = db.transaction(() => {
      for (const unitId of existing) {
        if (!desired.has(unitId)) {
          stmts.deleteUnitFts.run(unitId);
          stmts.deleteUnit.run(unitId);
        }
      }
      for (const [unitId, unit] of desired) {
        if (existing.has(unitId)) {
          continue;
        }
        stmts.insertUnit.run(
          unitId,
          sessionRef,
          session.tool,
          unit.start.message_index,
          unit.end.message_index,
          unit.start.timestamp,
          unit.end.timestamp,
          unit.content,
          unit.contentHash,
          now,
        );
        // Only the transcript text is keyword-indexed. `unit.content` also
        // carries the window scaffolding ("Session: …", "Turn 1/8 |
        // message_index=0 | user @ …") that gives the embedding model
        // ordering context; indexing it made `message_index` or a tool name
        // match every session.
        stmts.insertUnitFts.run(unitId, sessionRef, session.tool, unit.searchableText);
      }
    });
    applyDiff();
  }

  private prepared(): PreparedStatements {
    if (this.stmts) {
      return this.stmts;
    }

    const db = this.getDb();
    const upsertSession = db.prepare(
      `INSERT INTO sessions
       (session_ref, tool, source_session_id, project_root, git_branch, git_commit,
        started_at, last_activity_at, message_count, preview, source_path, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)
       ON CONFLICT(session_ref) DO UPDATE SET
         started_at = CASE
           WHEN excluded.started_at < started_at THEN excluded.started_at
           ELSE started_at
         END,
         last_activity_at = CASE
           WHEN excluded.last_activity_at > last_activity_at THEN excluded.last_activity_at
           ELSE last_activity_at
         END,
         -- First non-null wins: a session keeps the branch it started on
         -- even if later records omit it.
         git_branch = COALESCE(git_branch, excluded.git_branch),
         git_commit = COALESCE(git_commit, excluded.git_commit),
         source_path = COALESCE(source_path, excluded.source_path),
         updated_at = excluded.updated_at`,
    );
    const insertMessage = db.prepare(
      `INSERT OR IGNORE INTO messages
       (id, session_ref, tool, source_session_id, timestamp, role, content,
        message_index, content_hash, metadata_json, source_pointer, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this.stmts = {
      upsertSession,
      insertMessage,
      upsertChunkTxn: db.transaction((sessionArgs: unknown[], messageArgs: unknown[]) => {
        upsertSession.run(...sessionArgs);
        insertMessage.run(...messageArgs);
      }),
      sessionRollup: db.prepare(
        `UPDATE sessions
         SET message_count = (
               SELECT COUNT(*) FROM messages WHERE messages.session_ref = sessions.session_ref
             ),
             preview = COALESCE(
               (
                 SELECT substr(content, 1, 240)
                 FROM messages
                 WHERE messages.session_ref = sessions.session_ref
                 ORDER BY timestamp ASC, message_index ASC, id ASC
                 LIMIT 1
               ),
               preview
             )
         WHERE session_ref = ?`,
      ),
      selectSessionMessages: db.prepare(
        `SELECT id, timestamp, role, content, message_index, source_pointer
         FROM messages
         WHERE session_ref = ?
         ORDER BY timestamp ASC, message_index ASC, id ASC`,
      ),
      selectSessionTool: db.prepare("SELECT tool FROM sessions WHERE session_ref = ?"),
      selectUnitIds: db.prepare("SELECT id FROM retrieval_units WHERE session_ref = ?"),
      insertUnit: db.prepare(
        `INSERT INTO retrieval_units
         (id, session_ref, tool, message_start_index, message_end_index,
          started_at, ended_at, content, content_hash, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      insertUnitFts: db.prepare(
        `INSERT INTO retrieval_units_fts(unit_id, session_ref, tool, content)
         VALUES (?, ?, ?, ?)`,
      ),
      deleteUnit: db.prepare("DELETE FROM retrieval_units WHERE id = ?"),
      deleteUnitFts: db.prepare("DELETE FROM retrieval_units_fts WHERE unit_id = ?"),
    };
    return this.stmts;
  }

  private async keywordSearch(
    query: string,
    limit: number,
    toolFilter?: string[],
    branchFilter?: string[],
  ): Promise<SessionSummary[]> {
    const rows = this.queryKeywordUnits(query, limit, toolFilter, branchFilter);
    // Rank by BM25 position so relevance, not recency, dominates ordering.
    return groupUnits(rows, rankKeywordRows(rows), "keyword", normalizeLimit(limit, DEFAULT_LIMIT));
  }

  private async semanticSearch(
    query: string,
    limit: number,
    toolFilter: string[] | undefined,
    mode: Exclude<SessionSearchMode, "keyword">,
    branchFilter?: string[],
  ): Promise<SessionSummary[]> {
    const normalizedLimit = normalizeLimit(limit, DEFAULT_LIMIT);
    await this.ensureVectors(toolFilter);

    const db = this.getDb();
    const filters = normalizeToolFilter(toolFilter);
    const toolWhere = filters.length > 0 ? `AND u.tool IN (${placeholders(filters.length)})` : "";
    const branches = normalizeToolFilter(branchFilter);
    // Sessions with no recorded branch are excluded rather than assumed in:
    // no branch is not evidence of this branch.
    const branchWhere =
      branches.length > 0 ? `AND s.git_branch IN (${placeholders(branches.length)})` : "";
    const rows = db
      .prepare(
        `${retrievalUnitSelect()},
                v.vector,
                v.dimensions
         FROM retrieval_units u
         JOIN retrieval_unit_vectors v ON v.unit_id = u.id
         JOIN sessions s ON s.session_ref = u.session_ref
         WHERE v.model = ? ${toolWhere} ${branchWhere}`,
      )
      .all(this.embeddingProvider.model, ...filters, ...branches) as VectorUnitRow[];

    if (rows.length === 0) {
      return [];
    }

    const keywordRows =
      mode === "hybrid" ? this.queryKeywordUnits(query, limit, toolFilter, branchFilter) : [];
    const keywordScores = rankKeywordRows(keywordRows);
    const queryVector = await this.embeddingProvider.embed(query);
    const timeRange = getTimeRange(rows.map((row) => row.ended_at));
    const candidates = rows
      .map((row) => {
        const rawCosine = cosineSimilarity(
          queryVector,
          deserializeVector(row.vector, row.dimensions),
        );
        return {
          row,
          rawCosine,
          keywordScore: keywordScores.get(row.unit_id) ?? 0,
          recencyScore: scoreRecency(row.ended_at, timeRange),
          continuityScore: scoreContinuity(row.message_end_index, row.session_message_count),
        };
      })
      // Require actual evidence. Raw cosine sits near zero for unrelated
      // content, so without this the entire corpus came back for a query
      // matching nothing, formatted exactly like a real hit. A unit qualifies
      // on semantic similarity or a keyword match; "no matching sessions" is
      // a more useful answer than a nearest vector.
      .filter((item) => item.rawCosine >= MIN_SEMANTIC_COSINE || item.keywordScore > 0);

    // Nothing here is actually similar to the query — keep only what matched
    // on words. For a query that means nothing to this corpus that leaves
    // nothing at all, which is the answer.
    const bestCosine = candidates.reduce((best, item) => Math.max(best, item.rawCosine), 0);
    const semanticallyConfident = bestCosine >= MIN_CONFIDENT_COSINE;
    const surviving = semanticallyConfident
      ? candidates
      : candidates.filter((item) => item.keywordScore > 0);

    if (surviving.length === 0) {
      return [];
    }

    // Ordering and reporting are two different jobs, and conflating them is
    // what made the score meaningless.
    //
    // Ordering wants contrast: rescaling this query's survivors onto [0,1]
    // spreads them out and measurably ranks better (hybrid MRR 0.566 -> 0.613
    // on the eval). Reporting wants an absolute: the rescale forces the best
    // survivor to exactly 1.0 however weak it is, so three nonsense words
    // scored 0.901 against a real query's 0.872 and an agent had no way to
    // tell a find from a shrug.
    //
    // So candidates are ranked on the rescaled value and reported with the
    // cosine itself.
    const cosines = surviving.map((item) => item.rawCosine);
    const lowest = Math.min(...cosines);
    const highest = Math.max(...cosines);
    const spread = highest - lowest;

    const scored = surviving
      .map((item) => {
        // A lone survivor is the best match by definition, not the worst.
        const semanticScore = spread > 0 ? (item.rawCosine - lowest) / spread : 1;
        return {
          ...item,
          semanticScore,
          relevance: Math.max(0, Math.min(1, item.rawCosine)),
          score: blendScores(
            mode,
            semanticScore,
            item.keywordScore,
            item.recencyScore,
            item.continuityScore,
          ),
        };
      })
      .sort((left, right) => right.score - left.score);

    return groupScoredUnits(scored, mode, normalizedLimit);
  }

  private queryKeywordUnits(
    query: string,
    limit: number,
    toolFilter?: string[],
    branchFilter?: string[],
  ): RetrievalUnitRow[] {
    const ftsQuery = toFtsQuery(query);
    if (!ftsQuery) {
      return [];
    }

    const db = this.getDb();
    const normalizedLimit = normalizeLimit(limit, DEFAULT_LIMIT);
    const filters = normalizeToolFilter(toolFilter);
    const toolWhere = filters.length > 0 ? `AND u.tool IN (${placeholders(filters.length)})` : "";
    const branches = normalizeToolFilter(branchFilter);
    // Sessions with no recorded branch are excluded rather than assumed in:
    // no branch is not evidence of this branch.
    const branchWhere =
      branches.length > 0 ? `AND s.git_branch IN (${placeholders(branches.length)})` : "";
    return db
      .prepare(
        `${retrievalUnitSelect()}
         FROM retrieval_units_fts f
         JOIN retrieval_units u ON u.id = f.unit_id
         JOIN sessions s ON s.session_ref = u.session_ref
         WHERE retrieval_units_fts MATCH ? ${toolWhere} ${branchWhere}
         ORDER BY bm25(retrieval_units_fts), u.ended_at DESC
         LIMIT ?`,
      )
      .all(ftsQuery, ...filters, ...branches, normalizedLimit * MAX_MATCHES_PER_SESSION) as RetrievalUnitRow[];
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
         ORDER BY u.ended_at DESC`,
      )
      .all(this.embeddingProvider.model, ...filters) as Array<{
        unit_id: string;
        content: string;
        content_hash: string;
      }>;

    this.vectorBacklog = 0;
    if (rows.length === 0) {
      return;
    }

    const upsert = db.prepare(
      `INSERT INTO retrieval_unit_vectors
       (unit_id, model, dimensions, content_hash, vector, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(unit_id, model) DO UPDATE SET
         dimensions = excluded.dimensions,
         content_hash = excluded.content_hash,
         vector = excluded.vector,
         created_at = excluded.created_at`,
    );

    // Bounded batches keep memory flat on a first-time index of a large
    // history, and each batch commits before the next one embeds.
    // Small enough that the budget below can actually bite. At 64 windows a
    // single batch took 20-30s on the real index, so the deadline — checked
    // between batches — could not stop a search from blowing straight past it.
    const unitBatchSize = 8;
    // Answer with the vectors that exist rather than making the caller wait
    // for the whole corpus. Every batch below commits before the next starts,
    // so an unfinished pass is progress, not wasted work.
    const deadline = this.vectorBudgetMs > 0 ? Date.now() + this.vectorBudgetMs : Infinity;
    for (let start = 0; start < rows.length; start += unitBatchSize) {
      if (Date.now() >= deadline) {
        this.vectorBacklog = rows.length - start;
        break;
      }
      const batch = rows.slice(start, start + unitBatchSize);
      // Long windows are segmented to the model's sequence budget and
      // mean-pooled, so content beyond the window's opening still shapes
      // the unit's vector.
      const segmented = batch.map((row) => splitTextForEmbedding(row.content));
      const segmentVectors = await this.embeddingProvider.embedBatch(segmented.flat());

      let cursor = 0;
      const pooled = segmented.map((segments) => {
        const slice = segmentVectors.slice(cursor, cursor + segments.length);
        cursor += segments.length;
        return poolVectors(slice);
      });

      const now = new Date().toISOString();
      const transaction = db.transaction(() => {
        batch.forEach((row, index) => {
          const vector = pooled[index];
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
  }

  private async initialize(): Promise<void> {
    if (!this.createIfMissing && !existsSync(this.dbPath)) {
      // Nothing to read and nothing to leave behind.
      this.db = openDatabase(":memory:");
      return;
    }

    await mkdir(dirname(this.dbPath), { recursive: true });
    try {
      this.db = openDatabase(this.dbPath);
    } catch {
      // The index is derived data: a corrupt or schema-incompatible database
      // is discarded and rebuilt from the transcript stores on next refresh.
      await this.deleteDatabaseFiles();
      this.db = openDatabase(this.dbPath);
    }

    // One rule covers every way the index can end up empty — deleted by a
    // user (the recovery the docs invite), rebuilt after corruption, or
    // wiped by hand: an empty index cannot honour a scraper cursor, because
    // the cursor would skip straight past history still sitting on disk.
    // On a genuine first run there are no cursor files, so this is a no-op.
    const sessionCount = (
      this.db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as CountRow
    ).count;
    if (sessionCount === 0) {
      await this.clearScraperCursors();
    }
  }

  private async deleteDatabaseFiles(): Promise<void> {
    for (const suffix of ["", "-wal", "-shm"]) {
      await rm(`${this.dbPath}${suffix}`, { force: true });
    }
  }

  /**
   * Drop every scraper's saved position so the next refresh re-scans from the
   * beginning. Called whenever the index is empty; see initialize().
   */
  private async clearScraperCursors(): Promise<void> {
    const stateDir = dirname(this.dbPath);
    try {
      for (const entry of await readdir(stateDir)) {
        if (entry.endsWith("-state.json")) {
          await rm(join(stateDir, entry), { force: true });
        }
      }
    } catch {
      // No state directory yet: nothing to reset.
    }
  }

  private getDb(): DatabaseHandle {
    if (!this.db) {
      throw new Error("xtctx handoff index is closed");
    }
    return this.db;
  }
}

function openDatabase(dbPath: string): DatabaseHandle {
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    const objectCount = (
      db.prepare("SELECT COUNT(*) AS count FROM sqlite_master").get() as CountRow
    ).count;
    const version = db.pragma("user_version", { simple: true }) as number;
    if (objectCount > 0 && version !== SCHEMA_VERSION) {
      throw new Error(
        `xtctx index schema version ${version} does not match supported version ${SCHEMA_VERSION}`,
      );
    }
    createSchema(db);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function createSchema(db: DatabaseHandle): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_ref TEXT PRIMARY KEY,
      tool TEXT NOT NULL,
      source_session_id TEXT NOT NULL,
      project_root TEXT NOT NULL,
      git_branch TEXT,
      git_commit TEXT,
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
      unit_id TEXT NOT NULL REFERENCES retrieval_units(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      vector BLOB NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (unit_id, model)
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
    git_branch: row.git_branch ?? undefined,
    git_commit: row.git_commit ?? undefined,
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
    const keywordScore = keywordScores.get(row.unit_id) ?? 0;
    const recencyScore = scoreRecency(row.ended_at, timeRange);
    const continuityScore = scoreContinuity(row.message_end_index, row.session_message_count);
    return {
      row,
      score: blendScores("keyword", 0, keywordScore, recencyScore, continuityScore),
      // Deliberately no relevance: keyword scores are reciprocal rank, so the
      // top FTS hit is 1.0 whatever it actually matched. Reporting that as a
      // strength of match is the same lie the cosine rescale was telling.
      relevance: undefined,
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
    relevance: number | undefined;
    semanticScore: number;
    keywordScore: number;
    recencyScore: number;
    continuityScore: number;
  }>,
  retrieval: SessionSearchMode,
  limit: number,
): SessionSummary[] {
  // `score` orders; `relevance` is what the caller is told. Kept apart here so
  // the ranking the eval measures and the number an agent reads about a match
  // can each be the right thing.
  const ranks = new Map<string, number>();
  const sessions = new Map<string, SessionSummary>();

  for (const item of scored) {
    const existing = sessions.get(item.row.session_ref);
    const match = formatMatch(item);

    if (existing) {
      if ((existing.matches?.length ?? 0) < MAX_MATCHES_PER_SESSION) {
        existing.matches = [...(existing.matches ?? []), match];
      }
      existing.score =
        item.relevance === undefined
          ? existing.score
          : Math.max(existing.score ?? 0, item.relevance);
      ranks.set(item.row.session_ref, Math.max(ranks.get(item.row.session_ref) ?? 0, item.score));
      continue;
    }

    ranks.set(item.row.session_ref, item.score);
    sessions.set(item.row.session_ref, {
      session_ref: item.row.session_ref,
      tool: item.row.tool,
      started_at: item.row.session_started_at,
      last_activity_at: item.row.session_last_activity_at,
      message_count: item.row.session_message_count,
      preview: item.row.session_preview ?? previewText(item.row.content),
      source_path: item.row.source_path ?? undefined,
      score: item.relevance,
      retrieval,
      matches: [match],
    });

    if (sessions.size >= limit) {
      break;
    }
  }

  return [...sessions.values()].sort(
    (left, right) => (ranks.get(right.session_ref) ?? 0) - (ranks.get(left.session_ref) ?? 0),
  );
}

function formatMatch(item: {
  row: RetrievalUnitRow;
  score: number;
  relevance: number | undefined;
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
    // The blended value orders results; it is not a strength of match, and
    // reporting it here reproduced the "best is always 1.0" problem one level
    // down from where it was fixed.
    score: item.relevance === undefined ? undefined : roundScore(item.relevance),
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
  // Recency and continuity are deliberately absent from the two relevance
  // modes. `xtctx_recent_sessions` already answers "what was I just doing";
  // mixing that signal into search made it answer a question nobody asked,
  // and measurably worse — recency swung across its full range while the
  // semantic term barely moved, so it decided orderings it should not have.
  // Keyword mode keeps both: they are its only tie-breakers, and the eval
  // shows its recall is best with them.
  // Recency and continuity survive only as a tie-break, at a weight too small
  // to reorder anything that differs on relevance. Two windows can score
  // identically — they overlap, and they share the scaffolding header — and
  // the later, more complete one is the better answer; but as a *ranking*
  // signal recency swung across its full range while the semantic term barely
  // moved, so it decided orderings it had no business deciding.
  const tieBreak = TIE_BREAK_WEIGHT * (0.5 * recencyScore + 0.5 * continuityScore);

  if (mode === "vector") {
    return semanticScore + tieBreak;
  }

  if (mode === "keyword") {
    return 0.75 * keywordScore + 0.15 * recencyScore + 0.1 * continuityScore;
  }

  return 0.8 * semanticScore + 0.2 * keywordScore + tieBreak;
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

/**
 * Words too common to be evidence of anything.
 *
 * Terms are OR-ed, so one match anywhere returns a session. That made a
 * question about sourdough bread return five results from a corpus about a
 * TypeScript project, because it contains "how", "do" and "make" — and hybrid
 * then presented them beside a similarity of 0.130 as though they were finds.
 * Deliberately short: it holds words that carry no signal in any corpus, not a
 * general English stoplist, because a term like "test" or "index" is exactly
 * what someone searching a transcript means.
 */
const FTS_STOPWORDS = new Set([
  "a", "about", "all", "an", "and", "any", "are", "as", "at", "be", "been", "but", "by", "can",
  "did", "do", "does", "for", "from", "get", "had", "has", "have", "how", "i", "if", "in", "into",
  "is", "it", "its", "just", "make", "me", "my", "no", "not", "of", "on", "or", "our", "out",
  "should", "so", "some", "than", "that", "the", "their", "them", "then", "there", "these",
  "they", "this", "to", "up", "us", "want", "was", "we", "were", "what", "when", "which", "who",
  "why", "will", "with", "would", "you", "your",
]);

function toFtsQuery(query: string): string {
  const terms = query.toLowerCase().match(/[a-z0-9_./:-]{2,}/g) ?? [];
  const meaningful = terms.filter((term) => !FTS_STOPWORDS.has(term));

  // A query of nothing but common words has nothing to search for. Returning
  // no results is the honest answer; matching on "how" is not.
  return meaningful.map((term) => `"${term.replace(/"/g, '""')}"`).join(" OR ");
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

function clearSetting(db: DatabaseHandle, key: string): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
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
