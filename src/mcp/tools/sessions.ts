import type { SessionSearchMode, SessionService } from "../../handoff/types.js";

interface RecentSessionsParams {
  limit?: number;
  tool_filter?: string[];
  format?: "markdown" | "json";
}

interface SessionDetailParams {
  session_ref: string;
  offset?: number;
  limit?: number;
  format?: "markdown" | "json";
}

interface SearchSessionsParams {
  query: string;
  limit?: number;
  tool_filter?: string[];
  mode?: SessionSearchMode;
  format?: "markdown" | "json";
}

export type { SessionService };

export function createRecentSessionsHandler(service: SessionService) {
  return async (raw: Record<string, unknown> = {}) => {
    const params = raw as unknown as RecentSessionsParams;
    const limit = numberOrDefault(params.limit, 5);
    const format = params.format ?? "markdown";
    const sessions = await service.listRecentSessions(limit, params.tool_filter);

    if (format === "json") {
      return { sessions };
    }

    return formatRecentSessionsMarkdown(sessions);
  };
}

export function createSessionDetailHandler(service: SessionService) {
  return async (raw: Record<string, unknown>) => {
    const params = raw as unknown as SessionDetailParams;
    const offset = numberOrDefault(params.offset, 0);
    const limit = numberOrDefault(params.limit, 50);
    const format = params.format ?? "markdown";
    const messages = await service.getSessionDetail(params.session_ref, offset, limit);

    if (format === "json") {
      return { session_ref: params.session_ref, offset, limit, messages };
    }

    return formatSessionDetailMarkdown(params.session_ref, messages, offset, limit);
  };
}

export function createSearchSessionsHandler(service: SessionService) {
  return async (raw: Record<string, unknown>) => {
    const params = raw as unknown as SearchSessionsParams;
    const query = typeof params.query === "string" ? params.query : "";
    const limit = numberOrDefault(params.limit, 5);
    const mode = normalizeSearchMode(params.mode);
    const format = params.format ?? "markdown";
    const sessions = await service.searchSessions(query, limit, params.tool_filter, mode);

    if (format === "json") {
      return { query, mode, sessions };
    }

    return formatRecentSessionsMarkdown(sessions, `## Search Results: ${query}`);
  };
}

function formatRecentSessionsMarkdown(
  sessions: Awaited<ReturnType<SessionService["listRecentSessions"]>>,
  heading = "## Recent Sessions",
): string {
  if (sessions.length === 0) {
    return "No matching sessions found.";
  }

  const lines = [heading, ""];
  for (const [index, session] of sessions.entries()) {
    lines.push(`### ${index + 1}. ${session.session_ref}`);
    lines.push(`- Tool: ${session.tool}`);
    lines.push(`- Started: ${session.started_at}`);
    lines.push(`- Last activity: ${session.last_activity_at}`);
    lines.push(`- Messages: ${session.message_count}`);
    if (typeof session.score === "number") {
      lines.push(`- Score: ${session.score.toFixed(3)} (${session.retrieval ?? "hybrid"})`);
    }
    if (session.source_path) {
      lines.push(`- Source: ${session.source_path}`);
    }
    if (session.preview) {
      lines.push(`- Preview: ${session.preview}`);
    }
    for (const match of session.matches ?? []) {
      lines.push(
        `- Match ${match.message_start_index}-${match.message_end_index}: ${match.preview}`,
      );
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

function formatSessionDetailMarkdown(
  sessionRef: string,
  messages: Awaited<ReturnType<SessionService["getSessionDetail"]>>,
  offset: number,
  limit: number,
): string {
  if (messages.length === 0) {
    return `No messages found for session "${sessionRef}" (offset=${offset}, limit=${limit}).`;
  }

  const lines = [`## Session ${sessionRef}`, `Showing ${messages.length} messages`, ""];
  for (const message of messages) {
    lines.push(`### ${message.role} @ ${message.timestamp}`);
    if (message.source_pointer) {
      lines.push(`Source: ${message.source_pointer}`);
    }
    lines.push(message.content);
    lines.push("");
  }

  return lines.join("\n").trim();
}

function numberOrDefault(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeSearchMode(value: unknown): SessionSearchMode {
  return value === "keyword" || value === "vector" || value === "hybrid" ? value : "hybrid";
}
