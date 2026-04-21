import { describe, expect, it } from "vitest";
import { CompactionIndexer } from "@xtctx/compaction/indexer";
import type { CompactedSession } from "@xtctx/types/compaction";

function makeSession(partial: Partial<CompactedSession> = {}): CompactedSession {
  return {
    sessionId: "sess-1",
    tool: "claude-code",
    timeRange: { start: "2026-04-20T10:00:00Z", end: "2026-04-20T11:00:00Z" },
    summary: "Chose LanceDB over pgvector because of offline-first requirement.",
    tasksCompleted: ["wire up lancedb", "add hybrid search path"],
    decisionsIdentified: ["use lancedb"],
    filesModified: ["src/store/lance.ts"],
    openQuestions: [],
    chunkRefs: ["chunk-a", "chunk-b"],
    chunkCount: 12,
    estimatedTokens: 4200,
    ...partial,
  };
}

class FakeEmbedder {
  constructor(public readonly dim: number = 4) {}
  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((_, i) => new Array(this.dim).fill(i + 1));
  }
}

class FakeStore {
  readonly upserts: Array<{ table: string; records: Array<Record<string, unknown>> }> = [];
  async upsert(table: string, records: Array<Record<string, unknown>>): Promise<void> {
    this.upserts.push({ table, records });
  }
}

describe("CompactionIndexer", () => {
  it("skips the store call when there are no sessions", async () => {
    const embedder = new FakeEmbedder();
    const store = new FakeStore();
    const indexer = new CompactionIndexer(embedder, store);

    const indexed = await indexer.indexSessions([]);
    expect(indexed).toBe(0);
    expect(store.upserts).toHaveLength(0);
  });

  it("produces one vector record per session with a stable id", async () => {
    const embedder = new FakeEmbedder();
    const store = new FakeStore();
    const indexer = new CompactionIndexer(embedder, store, "context");

    const indexed = await indexer.indexSessions([makeSession({ sessionId: "s-a" }), makeSession({ sessionId: "s-b" })]);

    expect(indexed).toBe(2);
    expect(store.upserts).toHaveLength(1);
    const records = store.upserts[0].records;
    expect(records).toHaveLength(2);
    expect(records[0].id).toBe("claude-code:s-a:compacted:v1:2026-04-20T10:00:00Z");
    expect(records[1].id).toBe("claude-code:s-b:compacted:v1:2026-04-20T10:00:00Z");
  });

  it("re-indexing the same session upserts under the same id (no duplicate)", async () => {
    const embedder = new FakeEmbedder();
    const store = new FakeStore();
    const indexer = new CompactionIndexer(embedder, store);

    await indexer.indexSessions([makeSession({ sessionId: "dup" })]);
    await indexer.indexSessions([makeSession({ sessionId: "dup", summary: "Revised summary" })]);

    // Both calls produce the same id; upsert contract (tested in LanceStore suite)
    // guarantees the second overwrites the first. Here we just assert the id
    // stays stable across calls, which is what allows the overwrite to work.
    const ids = store.upserts.flatMap((u) => u.records.map((r) => r.id));
    expect(ids).toEqual([
      "claude-code:dup:compacted:v1:2026-04-20T10:00:00Z",
      "claude-code:dup:compacted:v1:2026-04-20T10:00:00Z",
    ]);
  });

  it("produces the same id when re-compacting a session whose synthesized name changed groupIndex (P1 regression guard)", async () => {
    // Rule-based compaction synthesizes `{realSessionId}#{groupIndex+1}` when
    // one underlying session spans multiple groups. If chunks are added
    // between runs, groupIndex shifts even though the underlying session +
    // time window is the same, so the compacted id MUST ignore the `#N`
    // suffix — otherwise upsert can't dedupe and history accumulates.
    const embedder = new FakeEmbedder();
    const store = new FakeStore();
    const indexer = new CompactionIndexer(embedder, store);

    const window = { start: "2026-04-20T10:00:00Z", end: "2026-04-20T11:00:00Z" };
    await indexer.indexSessions([makeSession({ sessionId: "real-abc#2", timeRange: window })]);
    await indexer.indexSessions([makeSession({ sessionId: "real-abc#7", timeRange: window })]);

    const ids = store.upserts.flatMap((u) => u.records.map((r) => r.id));
    expect(ids[0]).toBe(ids[1]);
  });

  it("encodes layer=1 and structural metadata so search can filter compacted hits", async () => {
    const embedder = new FakeEmbedder();
    const store = new FakeStore();
    const indexer = new CompactionIndexer(embedder, store);

    await indexer.indexSessions([
      makeSession({
        tool: "cursor",
        sessionId: "xyz",
        timeRange: { start: "2026-04-20T00:00:00Z", end: "2026-04-20T01:00:00Z" },
        chunkCount: 7,
        estimatedTokens: 1000,
        filesModified: ["foo.ts", "bar.ts"],
      }),
    ]);

    const meta = JSON.parse(store.upserts[0].records[0].metadata as string) as Record<string, unknown>;
    expect(meta.source_tool).toBe("cursor");
    expect(meta.source_session).toBe("xyz");
    expect(meta.role).toBe("summary");
    expect(meta.timestamp).toBe("2026-04-20T01:00:00Z");
    expect(meta.layer).toBe(1);
    expect(meta.chunk_count).toBe(7);
    expect(meta.estimated_tokens).toBe(1000);
    expect(meta.referenced_files).toEqual(["foo.ts", "bar.ts"]);
  });

  it("composes text so summary, decisions, tasks, and open questions are all searchable", async () => {
    const embedder = new FakeEmbedder();
    const store = new FakeStore();
    const indexer = new CompactionIndexer(embedder, store);

    await indexer.indexSessions([
      makeSession({
        summary: "Chose LanceDB over pgvector because of offline-first requirement.",
        decisionsIdentified: ["use lancedb", "defer pgvector"],
        tasksCompleted: ["wire lance", "add bm25"],
        openQuestions: ["when to index in background"],
      }),
    ]);

    const text = String(store.upserts[0].records[0].text);
    expect(text).toContain("LanceDB");
    expect(text).toContain("use lancedb; defer pgvector");
    expect(text).toContain("wire lance; add bm25");
    expect(text).toContain("when to index in background");
  });

  it("skips section markers when a section is empty (no bare 'Tasks:' labels)", async () => {
    const embedder = new FakeEmbedder();
    const store = new FakeStore();
    const indexer = new CompactionIndexer(embedder, store);

    await indexer.indexSessions([
      makeSession({
        summary: "Just a summary.",
        decisionsIdentified: [],
        tasksCompleted: [],
        openQuestions: [],
      }),
    ]);

    const text = String(store.upserts[0].records[0].text);
    expect(text).toBe("Just a summary.");
    expect(text).not.toContain("Decisions:");
    expect(text).not.toContain("Tasks:");
    expect(text).not.toContain("Open questions:");
  });
});
