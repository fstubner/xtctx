import type { Database as DatabaseHandle } from "better-sqlite3";
import type { ConversationChunk, ConversationScraper } from "../types/scraper.js";
import { hashParts } from "./hash.js";
import { type PreparedStatements, clearSetting, setSetting } from "./schema.js";

/**
 * How often a session still streaming in from a scraper has its count and
 * preview rolled up. See the scan loop in `scanTool` for why it is not
 * "only at the end" and not "on every message".
 */
const INCREMENTAL_ROLLUP_INTERVAL_MS = 1_000;

const SOURCE_CURSOR_OVERLAP_MS = 1_000;

/**
 * Wait for the scan, but not past the budget. Nothing is cancelled on
 * timeout — the scan keeps running and keeps committing — so a caller that
 * stops waiting costs the index nothing, and the next call finds more.
 */
export async function waitWithBudget(
  scan: Promise<void>,
  scanStartedMs: number,
  refreshBudgetMs: number,
): Promise<void> {
  if (refreshBudgetMs === 0) {
    return;
  }

  // The budget is spent by the scan, not by each caller. Measuring it from
  // when the scan started means one call pays the wait and the calls behind
  // it return straight away with whatever has landed so far — rather than
  // every call in a session paying the full budget over again.
  const remaining = scanStartedMs + refreshBudgetMs - Date.now();
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

interface ScanToolDeps {
  db: DatabaseHandle;
  stmts: PreparedStatements;
  /** Canonical and normalized; see `canonicalRoot` in sqlite-index. */
  scopedRoot: string;
}

interface ScanToolResult {
  /** Every session this scan wrote to; the caller rolls them up at the end. */
  touchedSessions: string[];
  /**
   * The tool that was read, in the sense of "looked at in this process" —
   * reported whether or not the read succeeded; see `scannedTools` on the
   * index.
   */
  tool: string;
}

/**
 * Read one tool's store into the index, advancing its cursor on success.
 *
 * Reports the tool as scanned whether or not the read succeeded, and records
 * a failure under `last_error:<tool>` without moving the cursor.
 */
export async function scanTool(
  scraper: ConversationScraper,
  deps: ScanToolDeps,
): Promise<ScanToolResult> {
  const { db, stmts, scopedRoot } = deps;
  // Insertion-ordered and de-duplicated, so folding this into the caller's
  // own set preserves the order the caller used to build it in.
  const touchedSessions = new Set<string>();
  if (!(await safeDetect(scraper))) {
    // Not installed here, so there is nothing to wait for — read, rather
    // than outstanding forever.
    return { touchedSessions: [], tool: scraper.tool };
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
      const sessionRef = upsertChunk(stmts, scopedRoot, chunk);
      if (sessionRef) {
        touchedSessions.add(sessionRef);
        if (openSession !== null && openSession !== sessionRef) {
          stmts.sessionRollup.run(openSession);
          openSessionRolledUpAt = 0;
        }
        openSession = sessionRef;
        if (Date.now() - openSessionRolledUpAt >= INCREMENTAL_ROLLUP_INTERVAL_MS) {
          stmts.sessionRollup.run(openSession);
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
      stmts.sessionRollup.run(openSession);
    }
  }

  // Read, whether or not it succeeded: a tool whose scrape failed has
  // an error recorded against it and is not something the caller should
  // be told to wait for. "Outstanding" here means "not looked at yet in
  // this process", nothing more.
  return { touchedSessions: [...touchedSessions], tool: scraper.tool };
}

/** Writes one chunk; returns its session ref, or null for an empty chunk. */
function upsertChunk(
  stmts: PreparedStatements,
  scopedRoot: string,
  chunk: ConversationChunk,
): string | null {
  if (!chunk.content.trim()) {
    return null;
  }

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
      scopedRoot,
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

function sourcePathFromMetadata(metadata: ConversationChunk["metadata"]): string | null {
  const value = (metadata as { sourcePath?: unknown }).sourcePath;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function overlapTimestamp(value: Date): Date {
  return new Date(Math.max(0, value.getTime() - SOURCE_CURSOR_OVERLAP_MS));
}

export async function safeDetect(scraper: ConversationScraper): Promise<boolean> {
  try {
    return await scraper.detect();
  } catch {
    return false;
  }
}
