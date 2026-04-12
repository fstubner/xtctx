import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("sorts sessions by last activity, not by start time (m3)", async () => {
    // session-b has a later timestamp than session-a so it should appear first.
    const service = new IndexedSessionService(store);
    const sessions = await service.listRecentSessions(5);

    expect(sessions[0].session_ref).toBe("cursor:session-b");
    expect(sessions[1].session_ref).toBe("codex:session-a");
  });
});

describe("IndexedSessionService cache behaviour (C2)", () => {
  let tempDir = "";
  let store: LanceStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "xtctx-session-cache-"));
    store = new LanceStore(join(tempDir, "lancedb"));
    await store.initialize();

    await store.upsert("context", [
      {
        id: "c1",
        text: "Initial record",
        vector: [0.1, 0.2],
        metadata: JSON.stringify({
          source_tool: "cursor",
          source_session: "sess-x",
          role: "user",
          timestamp: "2026-03-01T08:00:00.000Z",
        }),
      },
    ]);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns cached results on repeated reads within TTL", async () => {
    const service = new IndexedSessionService(store, "context", 60_000);
    const first = await service.listRecentSessions(10);

    // Modify the store without going through the service.
    await store.upsert("context", [
      {
        id: "c2",
        text: "New record after cache was populated",
        vector: [0.1, 0.2],
        metadata: JSON.stringify({
          source_tool: "cursor",
          source_session: "sess-y",
          role: "user",
          timestamp: "2026-03-02T08:00:00.000Z",
        }),
      },
    ]);

    // A second read within TTL should return the cached (stale) data.
    const second = await service.listRecentSessions(10);
    expect(second.length).toBe(first.length);
  });

  it("invalidate() forces a fresh load on next read (C2 write-invalidation)", async () => {
    const service = new IndexedSessionService(store, "context", 60_000);
    const before = await service.listRecentSessions(10);
    expect(before).toHaveLength(1);

    await store.upsert("context", [
      {
        id: "c2",
        text: "Another record",
        vector: [0.1, 0.2],
        metadata: JSON.stringify({
          source_tool: "cursor",
          source_session: "sess-z",
          role: "user",
          timestamp: "2026-03-03T08:00:00.000Z",
        }),
      },
    ]);

    service.invalidate();

    const after = await service.listRecentSessions(10);
    expect(after.length).toBeGreaterThan(before.length);
  });

  it("re-fetches after TTL expiry (C2 TTL fallback)", async () => {
    vi.useFakeTimers();

    // Short TTL of 1 000 ms.
    const service = new IndexedSessionService(store, "context", 1_000);
    const before = await service.listRecentSessions(10);
    expect(before).toHaveLength(1);

    // Insert a new record while the cache is still warm.
    await store.upsert("context", [
      {
        id: "c3",
        text: "TTL test record",
        vector: [0.1, 0.2],
        metadata: JSON.stringify({
          source_tool: "cursor",
          source_session: "sess-ttl",
          role: "user",
          timestamp: "2026-03-04T08:00:00.000Z",
        }),
      },
    ]);

    // Advance time past the TTL.
    vi.advanceTimersByTime(2_000);

    // Keep fake timers active so Date.now() still returns the advanced time
    // when the service checks whether the cache has expired.
    const after = await service.listRecentSessions(10);
    expect(after.length).toBeGreaterThan(before.length);

    vi.useRealTimers();
  });
});
