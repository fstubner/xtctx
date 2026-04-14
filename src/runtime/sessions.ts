import { join } from "node:path";
import { LanceStore } from "../store/lance.js";
import type { SessionMessage, SessionService, SessionSummary } from "../mcp/tools/sessions.js";

interface SessionIndexRecord {
  sessionRef: string;
  sessionId: string;
  tool: string;
  timestamp: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
}

const SESSION_SCAN_LIMIT = 10_000;

/** Default TTL for the in-memory session index cache (60 seconds). */
export const DEFAULT_SESSION_CACHE_TTL_MS = 60_000;

export class IndexedSessionService implements SessionService {
  private cache: SessionIndexRecord[] | null = null;
  /** Epoch ms at which the current cache entry expires. */
  private cacheExpiresAt = 0;
  private readonly cacheTtlMs: number;

  constructor(
    private readonly store: LanceStore,
    private readonly tableName = "context",
    cacheTtlMs: number = DEFAULT_SESSION_CACHE_TTL_MS,
  ) {
    this.cacheTtlMs = cacheTtlMs;
  }

  /**
   * Immediately invalidates the cache so the next read reloads from the store.
   * Call this after any write to the underlying context table (e.g. after an
   * ingestion cycle completes).
   */
  invalidate(): void {
    this.cache = null;
    this.cacheExpiresAt = 0;
  }

  async listRecentSessions(limit: number, toolFilter?: string[]): Promise<SessionSummary[]> {
    const records = await this.getRecords();
    const toolSet = normalizeToolFilter(toolFilter);
    const sessions = new Map<string, SessionSummary & { earliest: string; lastActivity: string }>();

    for (const record of records) {
      if (toolSet.size > 0 && !toolSet.has(record.tool)) {
        continue;
      }

      const existing = sessions.get(record.sessionRef);
      if (!existing) {
        sessions.set(record.sessionRef, {
          session_ref: record.sessionRef,
          tool: record.tool,
          started_at: record.timestamp,
          earliest: record.timestamp,
          lastActivity: record.timestamp,
          summary: summarizeContent(record.content),
          message_count: 1,
        });
        continue;
      }

      existing.message_count = (existing.message_count ?? 0) + 1;
      if (record.timestamp < existing.earliest) {
        existing.earliest = record.timestamp;
        existing.started_at = record.timestamp;
      }
      // Track the most recent message timestamp for sorting (m3).
      if (record.timestamp > existing.lastActivity) {
        existing.lastActivity = record.timestamp;
      }
    }

    return [...sessions.values()]
      // Sort by last activity (most-recent message) descending, not by start
      // time, so active sessions always appear first (m3).
      .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
      .slice(0, clamp(limit, 1, 50))
      .map(({ earliest: _ignored, lastActivity: _la, ...summary }) => summary);
  }

  async getSessionDetail(
    sessionRef: string,
    offset: number,
    limit: number,
  ): Promise<SessionMessage[]> {
    const { tool, sessionId } = parseSessionRef(sessionRef);
    const records = await this.getRecords();

    const filtered = records
      .filter((record) => {
        if (record.sessionId !== sessionId) {
          return false;
        }
        if (tool && record.tool !== tool) {
          return false;
        }
        return true;
      })
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const start = clamp(offset, 0, filtered.length);
    const end = Math.min(filtered.length, start + clamp(limit, 1, 500));
    return filtered.slice(start, end).map((record) => ({
      timestamp: record.timestamp,
      role: record.role,
      content: record.content,
    }));
  }

  async refresh(): Promise<void> {
    this.invalidate();
    this.cache = await this.loadRecords();
    this.cacheExpiresAt = Date.now() + this.cacheTtlMs;
  }

  private async getRecords(): Promise<SessionIndexRecord[]> {
    if (this.cache && Date.now() < this.cacheExpiresAt) {
      return this.cache;
    }
    this.cache = await this.loadRecords();
    this.cacheExpiresAt = Date.now() + this.cacheTtlMs;
    return this.cache;
  }

  private async loadRecords(): Promise<SessionIndexRecord[]> {
    try {
      const rows = await this.store.queryRows(this.tableName, { limit: SESSION_SCAN_LIMIT });
      const records: SessionIndexRecord[] = [];

      for (const row of rows) {
        const parsed = parseMetadata(row.metadata);
        if (!parsed.source_session || !parsed.source_tool || !parsed.timestamp || !parsed.role) {
          continue;
        }

        const sessionId = parsed.source_session;
        const tool = parsed.source_tool;
        records.push({
          sessionRef: `${tool}:${sessionId}`,
          sessionId,
          tool,
          timestamp: parsed.timestamp,
          role: parsed.role,
          content: row.text,
        });
      }

      return records;
    } catch {
      return [];
    }
  }
}

export async function createIndexedSessionService(storeDir: string): Promise<IndexedSessionService> {
  const store = new LanceStore(join(storeDir, "lancedb"));
  await store.initialize();
  return new IndexedSessionService(store);
}

function parseMetadata(metadata: string): {
  source_session?: string;
  source_tool?: string;
  timestamp?: string;
  role?: "user" | "assistant" | "system" | "tool";
} {
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    const role = parsed.role;
    return {
      source_session: asString(parsed.source_session),
      source_tool: asString(parsed.source_tool),
      timestamp: asString(parsed.timestamp),
      role:
        role === "user" || role === "assistant" || role === "system" || role === "tool"
          ? role
          : undefined,
    };
  } catch {
    return {};
  }
}

function parseSessionRef(ref: string): { tool: string | null; sessionId: string } {
  const index = ref.indexOf(":");
  if (index <= 0) {
    return { tool: null, sessionId: ref };
  }

  return {
    tool: ref.slice(0, index),
    sessionId: ref.slice(index + 1),
  };
}

function summarizeContent(content: string): string {
  const trimmed = content.replace(/\s+/g, " ").trim();
  if (trimmed.length <= 120) {
    return trimmed;
  }

  return `${trimmed.slice(0, 117)}...`;
}

function normalizeToolFilter(input?: string[]): Set<string> {
  if (!Array.isArray(input)) {
    return new Set();
  }

  return new Set(
    input.filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
  );
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, Math.floor(value)));
}
