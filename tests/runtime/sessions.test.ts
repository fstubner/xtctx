import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IndexedSessionService } from "@xtctx/runtime/sessions";
import { LanceStore } from "@xtctx/store/lance";

describe("IndexedSessionService", () => {
  let tempDir = "";
  let store: LanceStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "xtctx-session-service-"));
    store = new LanceStore(join(tempDir, "lancedb"));
    await store.initialize();

    await store.upsert("context", [
      {
        id: "r1",
        text: "First user message",
        vector: [0.1, 0.2],
        metadata: JSON.stringify({
          source_tool: "codex",
          source_session: "session-a",
          role: "user",
          timestamp: "2026-01-01T10:00:00.000Z",
        }),
      },
      {
        id: "r2",
        text: "Assistant response",
        vector: [0.1, 0.2],
        metadata: JSON.stringify({
          source_tool: "codex",
          source_session: "session-a",
          role: "assistant",
          timestamp: "2026-01-01T10:01:00.000Z",
        }),
      },
      {
        id: "r3",
        text: "Cursor session message",
        vector: [0.1, 0.2],
        metadata: JSON.stringify({
          source_tool: "cursor",
          source_session: "session-b",
          role: "user",
          timestamp: "2026-01-02T08:00:00.000Z",
        }),
      },
    ]);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("lists recent sessions from indexed context rows", async () => {
    const service = new IndexedSessionService(store);
    const sessions = await service.listRecentSessions(5);

    expect(sessions.length).toBe(2);
    expect(sessions[0].session_ref).toBe("cursor:session-b");
    expect(sessions[1].session_ref).toBe("codex:session-a");
    expect(sessions[1].message_count).toBe(2);
  });

  it("returns session detail with offset and limit", async () => {
    const service = new IndexedSessionService(store);
    const messages = await service.getSessionDetail("codex:session-a", 1, 10);

    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe("assistant");
    expect(messages[0].content).toContain("Assistant response");
  });
});
