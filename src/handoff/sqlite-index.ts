import { existsSync, realpathSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Database as DatabaseHandle } from "better-sqlite3";
import type { ConversationChunk, ConversationScraper } from "../types/scraper.js";
import {
  DEFAULT_EMBEDDING_MODEL,
  TransformersEmbeddingProvider,
  poolVectors,
  splitTextForEmbedding,
  type EmbeddingProvider,
  capSegments,
} from "./embeddings.js";
import type {
  HandoffStatus,
  IndexProgress,
  SessionMessage,
  SessionSearchMode,
  SessionService,
  SessionSummary,
} from "./types.js";
import { cosineSimilarity, deserializeVector, serializeVector } from "./vector.js";
import { NullEmbeddingProvider } from "./null-embeddings.js";
import {
  DEFAULT_WINDOW_SIZE,
  DEFAULT_WINDOW_STRIDE,
  type MessageRow,
  hashParts,
  planRetrievalUnits,
} from "./retrieval-units.js";
import {
  type CountRow,
  type PreparedStatements,
  clearSetting,
  getSetting,
  openDatabase,
  prepareStatements,
  setSetting,
} from "./schema.js";
import {
  MIN_CONFIDENT_COSINE,
  MIN_SEMANTIC_COSINE,
  blendScores,
  getTimeRange,
  groupScoredUnits,
  groupUnits,
  rankKeywordRows,
  scoreContinuity,
  scoreRecency,
  type RetrievalUnitRow,
} from "./ranking.js";

interface ToolRuntime {
  tool: string;
  scraper: ConversationScraper;
}

interface SqliteHandoffIndexOptions {
  embeddingProvider?: EmbeddingProvider;
  windowSize?: number;
  windowStride?: number;
  /** How long a caller waits for a scan before taking what is indexed so far. */
  refreshBudgetMs?: number;
  /** How long a scan waits for the embedding model to load. */
  embeddingWarmBudgetMs?: number;
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
  /**
   * Enabled tools whose store this project's config redirects outside the
   * home directory. Reported in status; see `redirectedTools` in
   * `runtime/services.ts` for why it is worth saying.
   */
  redirectedTools?: string[];
  /**
   * Stop searches from vectorizing anything they find unvectorized.
   *
   * For measuring how retrieval behaves at a given fraction of the corpus
   * embedded, which is the ordinary state of a fresh index and cannot be held
   * still otherwise: `vectorBudgetMs` bounds a pass but the deadline is
   * checked between batches, so one full batch always runs and the fraction
   * under test refills before it can be scored.
   *
   * Not a product setting. Nothing in `src/` passes it — an index that never
   * embeds is a search that degrades to keyword forever.
   */
  freezeVectors?: boolean;
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

interface VectorUnitRow extends RetrievalUnitRow {
  vector: Buffer;
  dimensions: number;
}

interface ToolCountRow {
  tool: string;
  sessions: number;
  messages: number;
  last_indexed_at: string | null;
}

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 100;

/**
 * Sessions repaired per scan by `reconcileRetrievalUnits`.
 *
 * Small on purpose: rebuilding reads every message in a session, and scans
 * here are routinely cut short by the client disconnecting, so a large batch
 * would be killed before finishing and would repeat the same prefix next time.
 * A backlog drains over a few scans instead, newest first.
 */
const RETRIEVAL_UNIT_RECONCILE_LIMIT = 4;

/**
 * How long a scan waits for the embedding model to finish loading.
 *
 * Sized against both failure modes. A warm cache loads in about a second, so
 * this clears it comfortably and every run after the first vectorises — the
 * case that was never happening. A cold cache takes minutes, misses this, and
 * is left to load in the background, which is correct: `close()` waits for the
 * scan, so this budget is also shutdown latency and cannot be generous.
 */
const DEFAULT_EMBEDDING_WARM_BUDGET_MS = 5_000;

/**
 * Override for the warm budget, in milliseconds; `0` disables the wait.
 *
 * The wait exists because this process is usually the only one there will be,
 * so deferring vectorising to "the next scan" meant never. That reasoning does
 * not apply to a test, where every scan would block on a model load nothing in
 * the test is asserting — and with a suite fanned out across workers, each one
 * paying that separately is contention rather than coverage.
 */
/**
 * The real model unless `XTCTX_DISABLE_EMBEDDINGS=1`.
 *
 * The switch is for the test suite, where several workers each loading a
 * ~100MB ONNX model exhausted memory and killed the worker rather than
 * failing an embedding. Search already degrades to keyword without vectors,
 * so a suite that is not asserting embeddings loses no coverage by skipping
 * the load — and the one test that is asserting them constructs the real
 * provider directly, so it still exercises the real thing.
 */
function defaultEmbeddingProvider(): EmbeddingProvider {
  return process.env.XTCTX_DISABLE_EMBEDDINGS === "1"
    ? new NullEmbeddingProvider()
    : new TransformersEmbeddingProvider(DEFAULT_EMBEDDING_MODEL);
}

function embeddingWarmBudgetFromEnv(): number | undefined {
  const raw = Number.parseInt(process.env.XTCTX_EMBEDDING_WARM_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : undefined;
}

/**
 * How often a session still streaming in from a scraper has its count and
 * preview rolled up. See the scan loop in `refreshNow` for why it is not
 * "only at the end" and not "on every message".
 */
const INCREMENTAL_ROLLUP_INTERVAL_MS = 1_000;

/** Poll interval while waiting for the model; see `waitUntilEmbeddingReady`. */
const EMBEDDING_WARM_POLL_MS = 100;
/**
 * Candidate windows fetched per requested session.
 *
 * Not the same number as the matches shown. The keyword pass fetches windows,
 * and the ranker groups them into sessions afterwards — so a corpus where
 * sessions have many windows can spend the whole candidate budget on a
 * handful of them and cut the answering session before ranking ever sees it.
 * At `limit * 3` on sessions of four windows, fifteen candidates could not
 * reliably span five distinct sessions.
 *
 * Swept against the eval; see the table on `blendScores`.
 */
const CANDIDATE_WINDOWS_PER_SESSION = 12;
const SOURCE_CURSOR_OVERLAP_MS = 1_000;

/**
 * SQL that reduces a stored `project_root` to a comparable form, and the JS
 * that does the same to the value compared against it.
 *
 * Raw string equality was too strict, and the way it failed is the dangerous
 * direction: rows silently stop being returned. One directory has several
 * legitimate spellings — `/var/...` and `/private/var/...` for a macOS temp
 * dir, `H:\` and `H:/` separators on Windows, and case differences on both — and
 * rows written under one spelling are read under another whenever the writer
 * canonicalised and the reader did not, or vice versa. Any row written before
 * the root was canonicalised at all would have vanished from every read.
 */
const PROJECT_ROOT_SQL = `rtrim(replace(lower(project_root), '\\', '/'), '/')`;

function normalizeRootForCompare(value: string): string {
  return value.replace(/\\/g, "/").replace(/[/]+$/, "").toLowerCase();
}

/**
 * The project root as the filesystem reports it, so writes and reads agree.
 *
 * Resolving at both ends is what makes the comparison work at all. One
 * directory has two names whenever a symlink is involved — a macOS temp
 * directory is `/var/...` and `/private/var/...`, and `createProjectServices`
 * already resolves it while a directly-constructed index did not. Rows
 * written under one name were then invisible under the other, which reads as
 * an empty project rather than as a bug.
 *
 * Falls back to the given path when it is not on disk, which is the case for
 * diagnostics and for a project that has moved.
 */
function canonicalRoot(projectRoot: string): string {
  try {
    return realpathSync(projectRoot);
  } catch {
    return projectRoot;
  }
}

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
  private readonly embeddingWarmBudgetMs: number;
  private readonly vectorBudgetMs: number;
  private scanStartedMs = 0;
  private readonly createIfMissing: boolean;
  /** Canonical, and compared normalized; see `canonicalRoot`. */
  private readonly scopedRoot: string;
  /**
   * Tools whose store this process has finished reading at least once.
   *
   * The answer budget stops the *caller* waiting, not the scan — so a first
   * call routinely returns before every store has been read, and used to
   * report only that indexing was "in progress". An agent asking whether
   * another tool had history here saw a plausible list with no sign that the
   * tool it cared about had not been looked at, and concluded there was
   * nothing to find. Naming the outstanding tools is what makes a partial
   * answer legible as partial.
   *
   * Per process, not persisted: it answers "have I read this yet, now", which
   * a previous run cannot vouch for.
   */
  private readonly scannedTools = new Set<string>();
  private readonly redirectedTools: string[];
  private readonly freezeVectors: boolean;
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
      options.embeddingProvider ?? defaultEmbeddingProvider();
    this.windowSize = Math.max(2, Math.floor(options.windowSize ?? DEFAULT_WINDOW_SIZE));
    this.windowStride = Math.max(1, Math.floor(options.windowStride ?? DEFAULT_WINDOW_STRIDE));
    this.refreshBudgetMs = Math.max(0, options.refreshBudgetMs ?? DEFAULT_REFRESH_BUDGET_MS);
    this.embeddingWarmBudgetMs = Math.max(
      0,
      options.embeddingWarmBudgetMs ??
        embeddingWarmBudgetFromEnv() ??
        DEFAULT_EMBEDDING_WARM_BUDGET_MS,
    );
    this.vectorBudgetMs = Math.max(0, options.vectorBudgetMs ?? DEFAULT_VECTOR_BUDGET_MS);
    this.createIfMissing = options.createIfMissing ?? true;
    this.scopedRoot = normalizeRootForCompare(canonicalRoot(projectRoot));
    this.redirectedTools = options.redirectedTools ?? [];
    this.freezeVectors = options.freezeVectors ?? false;
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
    // Always first, and not optional. `project_root` was written on every
    // insert and read by nothing, so an index that outlived its project —
    // a renamed directory, a copied `.xtctx/`, a worktree made from a
    // checkout that already had one — served the old path's conversations as
    // this project's. Defence in depth behind the scrapers' own attribution.
    const clauses: string[] = [`${PROJECT_ROOT_SQL} = ?`];
    if (filters.length > 0) {
      clauses.push(`tool IN (${placeholders(filters.length)})`);
    }
    if (branches.length > 0) {
      // A session with no recorded branch is not evidence that it was on the
      // requested one, so it is excluded rather than assumed in.
      clauses.push(`git_branch IN (${placeholders(branches.length)})`);
    }
    const where = `WHERE ${clauses.join(" AND ")}`;
    const rows = db
      .prepare(
        `SELECT session_ref, tool, started_at, last_activity_at, message_count, preview, source_path,
                git_branch, git_commit
         FROM sessions
         ${where}
         ORDER BY last_activity_at DESC
         LIMIT ?`,
      )
      .all(this.scopedRoot, ...filters, ...branches, normalizedLimit) as SessionRow[];

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
         WHERE ${PROJECT_ROOT_SQL} = ?
         ORDER BY last_activity_at DESC
         LIMIT ?`,
      )
      .all(this.scopedRoot, normalizeLimit(limit, DEFAULT_LIMIT)) as SessionRow[];

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
         WHERE session_ref = ?
           AND ${PROJECT_ROOT_SQL} = ?`,
      )
      .get(sessionRef, this.scopedRoot) as SessionRow | undefined;

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
           AND session_ref IN (
                 SELECT session_ref FROM sessions
                 WHERE ${PROJECT_ROOT_SQL} = ?
               )
         ORDER BY timestamp ASC, message_index ASC, id ASC
         LIMIT ? OFFSET ?`,
      )
      .all(sessionRef, this.scopedRoot, normalizedLimit, normalizedOffset) as MessageRow[];

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
    // Scoped like the read paths. Unscoped counts disagreed with what the
    // retrieval tools return, and a status saying "3 sessions" for a project
    // whose searches return one is the report that makes a scoping bug look
    // like a search bug.
    const scoped = `WHERE session_ref IN (
      SELECT session_ref FROM sessions WHERE ${PROJECT_ROOT_SQL} = ?
    )`;
    const sessionCount = countWhere(
      db,
      "sessions",
      `WHERE ${PROJECT_ROOT_SQL} = ?`,
      this.scopedRoot,
    );
    const messageCount = countWhere(db, "messages", scoped, this.scopedRoot);
    const retrievalUnitCount = countWhere(db, "retrieval_units", scoped, this.scopedRoot);
    const vectorizedUnitCount = countWhere(
      db,
      "retrieval_unit_vectors",
      `WHERE unit_id IN (SELECT id FROM retrieval_units ${scoped})`,
      this.scopedRoot,
    );
    const lastScan = getSetting(db, "last_scan_at");
    // Settings are text; a value written by an older version, or by hand, must
    // not turn a status report into NaN.
    const numericSetting = (key: string): number | null => {
      const raw = getSetting(db, key);
      if (raw === null) return null;
      const value = Number(raw);
      return Number.isFinite(value) ? value : null;
    };
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
             WHERE ${PROJECT_ROOT_SQL.replace("project_root", "s.project_root")} = ?
             GROUP BY s.tool`,
          )
          .all(this.scopedRoot) as ToolCountRow[]
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
      // The root as given, not `scopedRoot`. That one is lowercased and
      // separator-folded for comparison; showing it to a person or an agent
      // would report a path that is not how their project is spelled.
      project_root: this.projectRoot,
      db_path: this.dbPath,
      last_scan_at: lastScan,
      last_scan_ms: numericSetting("last_scan_ms"),
      sessions: sessionCount,
      messages: messageCount,
      retrieval_units: retrievalUnitCount,
      vectorized_units: vectorizedUnitCount,
      vector_ms_per_unit: numericSetting("vector_ms_per_unit"),
      vector_model: this.embeddingProvider.model,
      embedding_error: getSetting(db, "last_error:embeddings"),
      redirected_tools: this.redirectedTools,
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
      unreadTools: this.tools
        .map(({ tool }) => tool)
        .filter((tool) => !this.scannedTools.has(tool)),
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

    // First, not last: this repairs roll-ups a previous scan died before
    // reaching, and doing it up front means the repair survives even if this
    // scan is interrupted in the same way. Rows that already agree are not
    // written, so on a healthy index this costs one indexed count per session.
    this.prepared().reconcileSessionRollups.run();
    this.reconcileRetrievalUnits();

    for (const { scraper } of this.tools) {
      if (!(await safeDetect(scraper))) {
        // Not installed here, so there is nothing to wait for — read, rather
        // than outstanding forever.
        this.scannedTools.add(scraper.tool);
        continue;
      }

      let latestTimestamp: Date | null = null;
      // The session the scraper is currently yielding. It is rolled up when
      // the scraper moves on to another, and at most once a second while it
      // is still streaming in, so a scan cut short — the normal case when a
      // 20-second agent session ends before a 20-second scan does — leaves a
      // count and a preview behind rather than "0 messages" and nothing. The
      // timer matters more than the switch: the session the next agent wants
      // is the newest one, which is the last file a scraper reads, so nothing
      // ever moves past it before an interruption. Once per second keeps the
      // roll-up from being paid per message, which is what made indexing
      // O(N²) per session before it was deferred to the end. Retrieval units
      // still wait for the end: only search reads them, and search scans for
      // itself.
      let openSession: string | null = null;
      let openSessionRolledUpAt = 0;
      try {
        for await (const chunk of scraper.scrape()) {
          const sessionRef = this.upsertChunk(chunk);
          if (sessionRef) {
            touchedSessions.add(sessionRef);
            if (openSession !== null && openSession !== sessionRef) {
              this.prepared().sessionRollup.run(openSession);
              openSessionRolledUpAt = 0;
            }
            openSession = sessionRef;
            if (Date.now() - openSessionRolledUpAt >= INCREMENTAL_ROLLUP_INTERVAL_MS) {
              this.prepared().sessionRollup.run(openSession);
              openSessionRolledUpAt = Date.now();
            }
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
      } finally {
        // The last session a scraper yielded has nobody to move past it.
        if (openSession !== null) {
          this.prepared().sessionRollup.run(openSession);
        }
        // Read, whether or not it succeeded: a tool whose scrape failed has
        // an error recorded against it and is not something the caller should
        // be told to wait for. "Outstanding" here means "not looked at yet in
        // this process", nothing more.
        this.scannedTools.add(scraper.tool);
      }
    }

    for (const sessionRef of touchedSessions) {
      // Roll up message_count/preview once per touched session rather than
      // once per inserted message (which made indexing O(N²) per session).
      this.prepared().sessionRollup.run(sessionRef);
      this.rebuildRetrievalUnitsForSession(sessionRef);
    }

    setSetting(db, "last_scan_at", startedAt);
    setSetting(db, "last_scan_ms", String(Date.now() - Date.parse(startedAt)));

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
      // Warm and *wait*, bounded — do not defer to "the next scan".
      //
      // There usually is no next scan. The CLI is spawned per MCP session and
      // exits shortly after the client disconnects, so `isReady()` is false at
      // the start of every process. Returning here meant vectorising never
      // happened at all: a real index sat at 0 vectors against 1,770 windows
      // for 25 days, reporting them as merely "outstanding" while semantic
      // search silently fell back to keyword on every query.
      //
      // The hazard the early return was protecting against is real and kept:
      // `close()` waits for the scan, so an unbounded load would turn shutting
      // the server down into a multi-minute hang on a cold model cache. The
      // wait is bounded rather than skipped, and a model that misses the
      // deadline keeps loading in the background for the next caller.
      this.embeddingProvider.warm?.();
      if (!(await this.waitUntilEmbeddingReady())) {
        return;
      }
    }

    try {
      await this.ensureVectors();
    } catch {
      // Nothing to do here — search reports embedding failures where they matter.
    }
  }

  /**
   * Poll until the embedding model is loaded, or the budget runs out.
   *
   * Polling rather than awaiting the load: `warm()` returns void by design, so
   * that a caller cannot accidentally block on it. The interval is short
   * relative to a model load and the whole wait is capped, so the cost of a
   * provider that never becomes ready is one bounded delay per scan.
   */
  private async waitUntilEmbeddingReady(): Promise<boolean> {
    const isReady = this.embeddingProvider.isReady;
    if (!isReady) {
      return true;
    }

    const deadline = Date.now() + this.embeddingWarmBudgetMs;
    while (Date.now() < deadline) {
      if (isReady.call(this.embeddingProvider)) {
        return true;
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, EMBEDDING_WARM_POLL_MS);
        // Never hold the process open purely to keep polling.
        timer.unref?.();
      });
    }

    return isReady.call(this.embeddingProvider);
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
        // Canonical and normalized, matching what the read filter compares
        // against. Writing the raw root here is what made rows invisible when
        // the reader resolved a symlink and the writer had not.
        this.scopedRoot,
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

  /**
   * Rebuild retrieval units for sessions whose windows do not reach their last
   * message.
   *
   * Units are otherwise built only for the sessions a scan touched, at the end,
   * after every scraper — while each scraper advances its cursor as soon as it
   * finishes and the CLI exits shortly after a client disconnects. A scan that
   * dies in that gap leaves the messages committed, the cursor past them, and
   * the tail of the session in no window: reachable through
   * `xtctx_session_detail`, invisible to search, and never repaired because
   * nothing re-reads the store.
   *
   * `reconcileSessionRollups` above handles the same gap for `message_count`.
   * This is its counterpart, and the two run together for the same reason: at
   * the start, so the repair survives an interruption of the same kind.
   *
   * Bounded per scan. Rebuilding reads every message in a session, and scans
   * here are routinely cut short, so an unbounded pass over a large backlog
   * would spend the whole scan and be killed before finishing. Most-recently
   * active first, matching `ensureVectors`: the history a handoff reaches for
   * is covered before the archive is, and the backlog drains over a few scans.
   */
  private reconcileRetrievalUnits(): void {
    const drifted = this.prepared().selectSessionsMissingUnits.all(
      RETRIEVAL_UNIT_RECONCILE_LIMIT,
    ) as Array<{ session_ref: string }>;

    for (const { session_ref: sessionRef } of drifted) {
      this.rebuildRetrievalUnitsForSession(sessionRef);
    }
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
    const desired = planRetrievalUnits(sessionRef, messages, this.windowSize, this.windowStride);

    const existing = new Set(
      (stmts.selectUnitIds.all(sessionRef) as Array<{ id: string }>).map((row) => row.id),
    );

    const stale = [...existing].filter((unitId) => !desired.has(unitId));

    const applyDiff = db.transaction(() => {
      // The FTS delete goes out once for the whole batch rather than once per
      // unit. `unit_id` is an UNINDEXED column of an FTS5 table, so every
      // delete against it scans the virtual table — measured at ~9ms across
      // 1,770 rows, which a rebuild of a few hundred units turns into seconds.
      // Batching makes that one scan instead of N. (The scan itself is
      // inherent to UNINDEXED columns; removing it needs an external-content
      // FTS keyed on rowid, which is a schema migration, not a patch.)
      if (stale.length > 0) {
        db.prepare(
          `DELETE FROM retrieval_units_fts WHERE unit_id IN (${placeholders(stale.length)})`,
        ).run(...stale);
      }
      for (const unitId of stale) {
        stmts.deleteUnit.run(unitId);
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

    this.stmts = prepareStatements(this.getDb());
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
         WHERE v.model = ? AND ${PROJECT_ROOT_SQL.replace("project_root", "s.project_root")} = ?
               ${toolWhere} ${branchWhere}`,
      )
      .all(
        this.embeddingProvider.model,
        this.scopedRoot,
        ...filters,
        ...branches,
      ) as VectorUnitRow[];

    const keywordRows =
      mode === "hybrid" ? this.queryKeywordUnits(query, limit, toolFilter, branchFilter) : [];

    /**
     * Windows that matched on words but have no vector yet.
     *
     * These used to be unreachable. The query above inner-joins the vector
     * table, so hybrid could only ever return units that were already
     * embedded, and a keyword hit on anything else was invisible. Vectorizing
     * is budgeted and runs eight windows at a time on semantic searches only,
     * so a partly-embedded index is the ordinary state rather than an edge
     * case — this project sat at 8 vectorized windows out of 1,770.
     *
     * Measured on the eval by freezing the vectorized fraction, hybrid recall
     * tracked coverage almost exactly — 0.500 at half embedded, 0.250 at a
     * quarter, nothing at all at zero — while keyword held 0.850 throughout.
     * Hybrid is the default mode, so the default was a strict subset of the
     * cheaper one it is supposed to improve on.
     */
    const vectorized = new Set(rows.map((row) => row.unit_id));
    const keywordOnly = keywordRows.filter((row) => !vectorized.has(row.unit_id));

    if (rows.length === 0 && keywordOnly.length === 0) {
      return [];
    }

    const keywordScores = rankKeywordRows(keywordRows);
    // Only needed to score vectors; skip the model entirely when there are none.
    const queryVector = rows.length > 0 ? await this.embeddingProvider.embed(query) : null;
    const timeRange = getTimeRange([...rows, ...keywordOnly].map((row) => row.ended_at));
    const candidates = [
      ...rows.map((row) => ({
        row: row as RetrievalUnitRow,
        rawCosine: queryVector
          ? cosineSimilarity(queryVector, deserializeVector(row.vector, row.dimensions))
          : 0,
        keywordScore: keywordScores.get(row.unit_id) ?? 0,
        recencyScore: scoreRecency(row.ended_at, timeRange),
        continuityScore: scoreContinuity(row.message_end_index, row.session_message_count),
      })),
      // No semantic evidence yet — carried on the keyword match alone, which
      // the filter below still requires.
      ...keywordOnly.map((row) => ({
        row,
        rawCosine: 0,
        keywordScore: keywordScores.get(row.unit_id) ?? 0,
        recencyScore: scoreRecency(row.ended_at, timeRange),
        continuityScore: scoreContinuity(row.message_end_index, row.session_message_count),
      })),
    ]
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
        // A window with no vector has *unknown* similarity, not zero. Blending
        // it as zero docks it 60% of the available score for not having been
        // embedded yet, so a mediocre vectorized match outranked a strong
        // keyword one purely by being earlier in the queue: at half coverage
        // that held recall to 0.600 against keyword's 0.850. Scoring those on
        // the evidence they do have — the keyword blend — removes the penalty
        // without inventing a similarity for them.
        const unvectorized = !vectorized.has(item.row.unit_id);
        return {
          ...item,
          semanticScore,
          relevance: unvectorized ? undefined : Math.max(0, Math.min(1, item.rawCosine)),
          score: blendScores(
            unvectorized ? "keyword" : mode,
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
         WHERE retrieval_units_fts MATCH ?
               AND ${PROJECT_ROOT_SQL.replace("project_root", "s.project_root")} = ?
               ${toolWhere} ${branchWhere}
         ORDER BY bm25(retrieval_units_fts), u.ended_at DESC
         LIMIT ?`,
      )
      .all(
        ftsQuery,
        this.scopedRoot,
        ...filters,
        ...branches,
        normalizedLimit * CANDIDATE_WINDOWS_PER_SESSION,
      ) as RetrievalUnitRow[];
  }

  private async ensureVectors(toolFilter?: string[]): Promise<void> {
    if (this.freezeVectors) {
      return;
    }
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
    const passStartedAt = Date.now();
    let embedded = 0;
    for (let start = 0; start < rows.length; start += unitBatchSize) {
      if (Date.now() >= deadline) {
        this.vectorBacklog = rows.length - start;
        break;
      }
      const batch = rows.slice(start, start + unitBatchSize);
      embedded += batch.length;
      // Long windows are segmented to the model's sequence budget and
      // mean-pooled, so content beyond the window's opening still shapes
      // the unit's vector.
      const segmented = batch.map((row) => capSegments(splitTextForEmbedding(row.content)));
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

    // Per window rather than per pass, so a pass that embedded eight and one
    // that embedded eight hundred report a comparable figure — and so the
    // backlog can be read as a duration rather than a count.
    if (embedded > 0) {
      const perUnit = Math.round(((Date.now() - passStartedAt) / embedded) * 10) / 10;
      setSetting(db, "vector_ms_per_unit", String(perUnit));
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
    // Counted for *this* project, not for the file. An index shared with a
    // path this project no longer has — after a rename, a move, or a copied
    // `.xtctx/` — is empty as far as this project is concerned, and the
    // unscoped count made it look populated. The cursors were then honoured,
    // so the scan skipped the history that would have re-attributed those
    // sessions and the project stayed dark permanently.
    const sessionCount = countWhere(
      this.db,
      "sessions",
      `WHERE ${PROJECT_ROOT_SQL} = ?`,
      this.scopedRoot,
    );
    if (sessionCount === 0) {
      await this.clearScraperCursors();
    }

    this.dropVectorsFromOtherModels();
  }

  /**
   * Discard vectors built by any model other than the one now in use.
   *
   * Every read filters on `model`, so stale rows are already inert — but
   * nothing deletes them, and changing the default model would otherwise
   * leave a whole second copy of the corpus in the index permanently. The
   * vectors are derived data that the next searches rebuild, so dropping
   * them costs re-embedding, which is budgeted and incremental, and no
   * transcript content is lost either way.
   */
  private dropVectorsFromOtherModels(): void {
    this.getDb()
      .prepare("DELETE FROM retrieval_unit_vectors WHERE model != ?")
      .run(this.embeddingProvider.model);
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

/**
 * How much of a window's text the search paths load.
 *
 * They use it for one thing: a 240-character preview, produced by collapsing
 * whitespace and slicing. Selecting the whole column meant every search read
 * the entire vectorised corpus into memory — 1,770 windows measured at 22.6MB
 * on a modest index, growing linearly, paid on every query, in a process
 * spawned per agent session.
 *
 * Four times the preview so whitespace collapsing cannot leave it short, and
 * still a small fraction of a window, which holds eight messages.
 */
const PREVIEW_SOURCE_CHARS = 960;

function retrievalUnitSelect(): string {
  return `SELECT u.id AS unit_id,
                u.session_ref,
                u.tool,
                u.message_start_index,
                u.message_end_index,
                u.started_at,
                u.ended_at,
                substr(u.content, 1, ${PREVIEW_SOURCE_CHARS}) AS content,
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
  "did", "do", "does", "for", "from", "had", "has", "have", "how", "i", "if", "in", "into",
  "is", "it", "its", "just", "me", "my", "no", "not", "of", "on", "or", "our", "out",
  "should", "so", "some", "than", "that", "the", "their", "them", "then", "there", "these",
  "they", "this", "to", "up", "us", "want", "was", "we", "were", "what", "when",
  "why", "will", "with", "would", "you", "your",
]);

/**
 * `make`, `get` and `which` were on this list and should not have been. Each is
 * a real search term in a corpus of developer transcripts — a keyword search
 * for `make` returned nothing at all against 1475 windows. A stoplist that
 * swallows the vocabulary of the thing being searched is worse than the noise
 * it removes.
 *
 * The rest stay because they carry no signal as bare words. `so` is on the list
 * and `libfoo.so` still searches fine: the tokenizer keeps dotted and
 * hyphenated terms whole, so only the bare word is dropped.
 */

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

/**
 * A row count restricted to this project. The `where` clause is built from
 * literals in this module and the value is bound, never interpolated.
 *
 * There is no unscoped variant: the one that existed reported totals that
 * disagreed with what every retrieval path returned.
 */
function countWhere(
  db: DatabaseHandle,
  table: "sessions" | "messages" | "retrieval_units" | "retrieval_unit_vectors",
  where: string,
  scopedRoot: string,
): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`).get(scopedRoot) as
    | CountRow
    | undefined;
  return row?.count ?? 0;
}

function sourcePathFromMetadata(metadata: ConversationChunk["metadata"]): string | null {
  const value = (metadata as { sourcePath?: unknown }).sourcePath;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function overlapTimestamp(value: Date): Date {
  return new Date(Math.max(0, value.getTime() - SOURCE_CURSOR_OVERLAP_MS));
}

async function safeDetect(scraper: ConversationScraper): Promise<boolean> {
  try {
    return await scraper.detect();
  } catch {
    return false;
  }
}
