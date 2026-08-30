import { describe, expect, it } from "vitest";
import { createHandoffManifestHandler } from "@xtctx/mcp/tools/manifest";
import type {
  HandoffStatus,
  SessionMessage,
  SessionService,
  SessionSummary,
} from "@xtctx/handoff/types";

/**
 * A fixture service that honors `limit` the way the real index does — the
 * bug this file pins was invisible to fixtures that returned everything.
 */
class LimitHonoringService implements SessionService {
  constructor(private readonly sessions: SessionSummary[]) {}

  async listRecentSessions(limit: number): Promise<SessionSummary[]> {
    return [...this.sessions]
      .sort((left, right) => right.last_activity_at.localeCompare(left.last_activity_at))
      .slice(0, limit);
  }

  async getSessionByRef(sessionRef: string): Promise<SessionSummary | null> {
    return this.sessions.find((session) => session.session_ref === sessionRef) ?? null;
  }

  async getSessionDetail(): Promise<SessionMessage[]> {
    return [];
  }

  async searchSessions(): Promise<SessionSummary[]> {
    return [];
  }

  async getStatus(): Promise<HandoffStatus> {
    return {
      project_root: "/fixture",
      db_path: "/fixture/.xtctx/state/xtctx.db",
      // Healthy embeddings: the real service reports a message here when the

      // model fails, and the status contract requires the field either way.
      embedding_error: null,
      last_scan_at: "2026-05-10T10:00:00.000Z",
      last_scan_ms: null,
      sessions: this.sessions.length,
      messages: 0,
      retrieval_units: 0,
      vectorized_units: 0,
      vector_ms_per_unit: null,
      vector_model: "fixture",
      tools: [],
    };
  }

  /** Nothing scans here, so there is never anything to wait for. */
  async whenScanSettled(): Promise<void> {
    return;
  }

  async close(): Promise<void> {
    return;
  }
}

function summary(ref: string, lastActivity: string): SessionSummary {
  return {
    session_ref: ref,
    tool: "codex",
    started_at: lastActivity,
    last_activity_at: lastActivity,
    message_count: 3,
  };
}

describe("xtctx_handoff_manifest", () => {
  it("resolves requested refs directly, even when they are not recent", async () => {
    const service = new LimitHonoringService([
      summary("codex:old-session", "2026-01-01T10:00:00.000Z"),
      summary("codex:mid-session", "2026-03-01T10:00:00.000Z"),
      summary("codex:new-session", "2026-05-01T10:00:00.000Z"),
    ]);
    const handler = createHandoffManifestHandler(service);

    const manifest = (await handler({ session_refs: ["codex:old-session"] })) as {
      sessions: Array<{ session_ref: string }>;
      missing_session_refs: string[];
    };

    expect(manifest.sessions.map((session) => session.session_ref)).toEqual([
      "codex:old-session",
    ]);
    expect(manifest.missing_session_refs).toEqual([]);
  });

  it("reports genuinely unknown refs as missing", async () => {
    const service = new LimitHonoringService([
      summary("codex:new-session", "2026-05-01T10:00:00.000Z"),
    ]);
    const handler = createHandoffManifestHandler(service);

    const manifest = (await handler({
      session_refs: ["codex:new-session", "codex:never-existed"],
    })) as {
      sessions: Array<{ session_ref: string }>;
      missing_session_refs: string[];
    };

    expect(manifest.sessions.map((session) => session.session_ref)).toEqual([
      "codex:new-session",
    ]);
    expect(manifest.missing_session_refs).toEqual(["codex:never-existed"]);
  });
});
