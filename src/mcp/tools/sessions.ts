export interface SessionSummary {
  session_ref: string;
  tool: string;
  started_at: string;
  /**
   * ISO timestamp of the most-recent message in the session. Distinct
   * from `started_at` because long sessions with bursty activity look
   * very different to a "minutes ago" formatter depending on which
   * timestamp you read. The handoff brief generator uses this to
   * compute "X minutes ago" honestly.
   */
  last_activity_at?: string;
  summary?: string;
  message_count?: number;
}

export interface SessionMessage {
  timestamp: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
}

export interface SessionService {
  listRecentSessions(limit: number, toolFilter?: string[]): Promise<SessionSummary[]>;
  getSessionDetail(sessionRef: string, offset: number, limit: number): Promise<SessionMessage[]>;
}

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

interface LastSessionBriefParams {
  /**
   * The tool the agent considers itself to be running in. The brief
   * is filtered to skip same-tool sessions because the agent already
   * has its own immediate context. Defaults to undefined → first
   * non-stale session regardless of tool.
   */
  current_tool?: string;
  format?: "markdown" | "json";
  /** Override the default 7-day staleness threshold. */
  stale_threshold_days?: number;
}

export function createRecentSessionsHandler(service: SessionService) {
  return async (raw: Record<string, unknown> = {}) => {
    const params = raw as unknown as RecentSessionsParams;
    const limit = params.limit ?? 3;
    const format = params.format ?? "markdown";
    const sessions = await service.listRecentSessions(limit, params.tool_filter);

    if (format === "json") {
      return { sessions };
    }

    return formatRecentSessionsMarkdown(sessions);
  };
}

/**
 * Returns the same handoff brief that gets injected into each tool's
 * memory file by `xtctx serve`'s sync ticks, but as a programmatic
 * MCP response. Useful for agents that prefer not to parse the
 * managed block out of `CLAUDE.md` / `AGENTS.md` / etc.
 *
 * The default brief is identical to what's in the memory file at the
 * last sync tick. Tools can request it explicitly to:
 *   - Confirm freshness (the brief in the memory file might be stale
 *     if the agent ran before the next sync tick)
 *   - Get the brief in JSON form for programmatic processing
 *   - Adjust the staleness threshold per-call
 */
export function createLastSessionBriefHandler(service: SessionService) {
  return async (raw: Record<string, unknown> = {}) => {
    // Lazy require to keep this module's import graph independent of the
    // handoff feature being shipped. Avoids cycles if brief.ts ever
    // grows to depend on session types beyond `HandoffSession`.
    const { generateHandoffBrief, sessionSummaryToHandoff, pickHandoffSession } =
      await import("../../handoff/brief.js");

    const params = raw as unknown as LastSessionBriefParams;
    const format = params.format ?? "markdown";
    const currentTool = params.current_tool ?? "__no_filter__";
    const staleThresholdMs =
      params.stale_threshold_days !== undefined
        ? params.stale_threshold_days * 24 * 60 * 60 * 1000
        : undefined;

    // Pull a generous window so the brief generator can pick the most-
    // recent qualifying session even if a few same-tool entries top the
    // list.
    const sessions = await service.listRecentSessions(20);
    const handoffSessions = sessions.map(sessionSummaryToHandoff);

    const briefOptions =
      staleThresholdMs !== undefined ? { staleThresholdMs } : {};
    const brief = generateHandoffBrief(handoffSessions, currentTool, briefOptions);
    const session = pickHandoffSession(handoffSessions, currentTool, briefOptions);

    if (format === "json") {
      return {
        brief: brief.length > 0 ? brief : null,
        session: session ?? null,
      };
    }

    return brief.length > 0
      ? brief
      : "No qualifying recent session in another tool (within staleness window).";
  };
}

export function createSessionDetailHandler(service: SessionService) {
  return async (raw: Record<string, unknown>) => {
    const params = raw as unknown as SessionDetailParams;
    const offset = params.offset ?? 0;
    const limit = params.limit ?? 50;
    const format = params.format ?? "markdown";
    const messages = await service.getSessionDetail(params.session_ref, offset, limit);

    if (format === "json") {
      return { session_ref: params.session_ref, offset, limit, messages };
    }

    return formatSessionDetailMarkdown(params.session_ref, messages, offset, limit);
  };
}

function formatRecentSessionsMarkdown(sessions: SessionSummary[]): string {
  if (sessions.length === 0) {
    return "No recent sessions found.";
  }

  const lines = ["## Recent Sessions\n"];
  for (const [index, session] of sessions.entries()) {
    lines.push(`### ${index + 1}. ${session.session_ref}`);
    lines.push(`- Tool: ${session.tool}`);
    lines.push(`- Started: ${session.started_at}`);
    if (session.message_count != null) {
      lines.push(`- Messages: ${session.message_count}`);
    }
    if (session.summary) {
      lines.push(`- Summary: ${session.summary}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

function formatSessionDetailMarkdown(
  sessionRef: string,
  messages: SessionMessage[],
  offset: number,
  limit: number,
): string {
  if (messages.length === 0) {
    return `No messages found for session "${sessionRef}" (offset=${offset}, limit=${limit}).`;
  }

  const lines = [`## Session ${sessionRef}`, `Showing ${messages.length} messages\n`];
  for (const message of messages) {
    lines.push(`### ${message.role} @ ${message.timestamp}`);
    lines.push(message.content);
    lines.push("");
  }

  return lines.join("\n").trim();
}
