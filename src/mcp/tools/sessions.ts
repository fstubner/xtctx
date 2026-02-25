export interface SessionSummary {
  session_ref: string;
  tool: string;
  started_at: string;
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

export function createRecentSessionsHandler(service: SessionService) {
  return async (params: RecentSessionsParams = {}) => {
    const limit = params.limit ?? 3;
    const format = params.format ?? "markdown";
    const sessions = await service.listRecentSessions(limit, params.tool_filter);

    if (format === "json") {
      return { sessions };
    }

    return formatRecentSessionsMarkdown(sessions);
  };
}

export function createSessionDetailHandler(service: SessionService) {
  return async (params: SessionDetailParams) => {
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
