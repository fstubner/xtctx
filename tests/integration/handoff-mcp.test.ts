import { describe, expect, it } from "vitest";
import { createToolHandlers } from "@xtctx/mcp/server";
import type { HandoffStatus, SessionMessage, SessionService, SessionSummary } from "@xtctx/handoff/types";

class FixtureSessionService implements SessionService {
  async listRecentSessions(): Promise<SessionSummary[]> {
    return [
      {
        session_ref: "codex:session-a",
        tool: "codex",
        started_at: "2026-05-10T10:00:00.000Z",
        last_activity_at: "2026-05-10T10:01:00.000Z",
        message_count: 1,
        preview: "continue the setup refactor",
      },
    ];
  }

  async getSessionByRef(sessionRef: string): Promise<SessionSummary | null> {
    const sessions = await this.listRecentSessions();
    return sessions.find((session) => session.session_ref === sessionRef) ?? null;
  }

  async getSessionDetail(): Promise<SessionMessage[]> {
    return [
      {
        timestamp: "2026-05-10T10:01:00.000Z",
        role: "user",
        content: "continue the setup refactor",
      },
    ];
  }

  async searchSessions(): Promise<SessionSummary[]> {
    return this.listRecentSessions();
  }

  async getStatus(): Promise<HandoffStatus> {
    return {
      project_root: "/repo",
      db_path: "/repo/.xtctx/state/xtctx.db",
      last_scan_at: "2026-05-10T10:02:00.000Z",
      sessions: 1,
      messages: 1,
      retrieval_units: 1,
      vectorized_units: 1,
      vector_model: "fixture-embedding",
      tools: [
        {
          tool: "codex",
          detected: true,
          last_error: null,
          store_paths: ["/home/user/.codex/sessions"],
          indexed_sessions: 1,
          indexed_messages: 1,
          last_indexed_at: "2026-05-10T10:02:00.000Z",
        },
      ],
    };
  }

  async close(): Promise<void> {
    return;
  }
}

describe("handoff MCP integration", () => {
  it("returns recent sessions, detail, search, status, and handoff manifests through handlers", async () => {
    const handlers = createToolHandlers({ sessions: new FixtureSessionService() });

    await expect(handlers.get("xtctx_recent_sessions")?.({ format: "json" })).resolves.toMatchObject({
      sessions: [{ session_ref: "codex:session-a" }],
    });
    await expect(
      handlers.get("xtctx_session_detail")?.({ session_ref: "codex:session-a", format: "json" }),
    ).resolves.toMatchObject({
      messages: [{ content: "continue the setup refactor" }],
    });
    await expect(
      handlers.get("xtctx_search_sessions")?.({ query: "setup", format: "json" }),
    ).resolves.toMatchObject({
      sessions: [{ session_ref: "codex:session-a" }],
    });
    await expect(handlers.get("xtctx_continuity_status")?.({ format: "json" })).resolves.toMatchObject({
      sessions: 1,
      messages: 1,
    });
    await expect(
      handlers.get("xtctx_handoff_manifest")?.({
        format: "json",
        correlation_id: "orchestrator:task-42",
        session_refs: ["codex:session-a"],
      }),
    ).resolves.toMatchObject({
      schema_version: "xtctx/handoff-manifest/v1",
      correlation_id: "orchestrator:task-42",
      sessions: [
        {
          handoff_id: "codex:session-a",
          retrieve: { tool: "xtctx_session_detail", arguments: { session_ref: "codex:session-a" } },
        },
      ],
      contract: { authority: "raw-transcript" },
    });
  });
});
