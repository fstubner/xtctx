import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LanceStore } from "@xtctx/store/lance";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("LanceStore", () => {
  let store: LanceStore;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "xtctx-test-"));
    store = new LanceStore(tempDir);
    await store.initialize();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("stores and retrieves vectors", async () => {
    await store.upsert("test-table", [
      {
        id: "rec-1",
        text: "Use Vitest for testing",
        vector: new Array(384).fill(0.1),
        metadata: JSON.stringify({ type: "decision" }),
      },
    ]);

    const results = await store.vectorSearch(
      "test-table",
      new Array(384).fill(0.1),
      5,
    );

    expect(results.length).toBe(1);
    expect(results[0].id).toBe("rec-1");
  });

  it("performs full-text search", async () => {
    await store.upsert("test-table", [
      {
        id: "rec-1",
        text: "ECONNREFUSED port 5432 postgres",
        vector: new Array(384).fill(0.1),
        metadata: JSON.stringify({ type: "error_solution" }),
      },
      {
        id: "rec-2",
        text: "Use Vitest for testing",
        vector: new Array(384).fill(0.2),
        metadata: JSON.stringify({ type: "decision" }),
      },
    ]);

    const results = await store.ftsSearch("test-table", "ECONNREFUSED", 5);

    expect(results.length).toBe(1);
    expect(results[0].id).toBe("rec-1");
  });

  it("queries raw rows with where clause", async () => {
    await store.upsert("test-table", [
      {
        id: "rec-1",
        text: "Session A",
        vector: new Array(384).fill(0.1),
        metadata: JSON.stringify({ source_session: "a" }),
      },
      {
        id: "rec-2",
        text: "Session B",
        vector: new Array(384).fill(0.2),
        metadata: JSON.stringify({ source_session: "b" }),
      },
    ]);

    const rows = await store.queryRows("test-table", { where: "id = 'rec-2'", limit: 1 });
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe("rec-2");
  });

  describe("purgeByTool", () => {
    it("deletes only rows whose metadata has source_tool === tool", async () => {
      await store.upsert("test-table", [
        {
          id: "copilot-1",
          text: "copilot chunk 1",
          vector: new Array(384).fill(0.1),
          metadata: JSON.stringify({ source_tool: "copilot", source_session: "a" }),
        },
        {
          id: "copilot-2",
          text: "copilot chunk 2",
          vector: new Array(384).fill(0.2),
          metadata: JSON.stringify({ source_tool: "copilot", source_session: "b" }),
        },
        {
          id: "cursor-1",
          text: "cursor chunk",
          vector: new Array(384).fill(0.3),
          metadata: JSON.stringify({ source_tool: "cursor", source_session: "c" }),
        },
      ]);

      const purged = await store.purgeByTool("test-table", "copilot");
      expect(purged).toBe(2);

      // Survivor still there
      const rows = await store.queryRows("test-table", { where: "id = 'cursor-1'", limit: 1 });
      expect(rows).toHaveLength(1);

      // Copilot rows gone
      const gone = await store.queryRows("test-table", {
        where: "id = 'copilot-1' OR id = 'copilot-2'",
        limit: 10,
      });
      expect(gone).toHaveLength(0);
    });

    it("does not false-match when text content mentions the tool name", async () => {
      await store.upsert("test-table", [
        {
          id: "rec-1",
          text: "we decided to drop copilot support",
          vector: new Array(384).fill(0.1),
          // Note: source_tool is NOT copilot — text mentions it but metadata doesn't.
          metadata: JSON.stringify({ source_tool: "cursor" }),
        },
      ]);

      const purged = await store.purgeByTool("test-table", "copilot");
      expect(purged).toBe(0);

      const rows = await store.queryRows("test-table", { where: "id = 'rec-1'", limit: 1 });
      expect(rows).toHaveLength(1);
    });

    it("returns 0 and does not throw when the table does not exist", async () => {
      const purged = await store.purgeByTool("missing-table", "copilot");
      expect(purged).toBe(0);
    });

    it("rejects tool names that could break the LIKE predicate or match unintended rows", async () => {
      await store.upsert("test-table", [
        {
          id: "keep-1",
          text: "keep",
          vector: new Array(384).fill(0.1),
          metadata: JSON.stringify({ source_tool: "cursor" }),
        },
      ]);

      // Single quote — would break the SQL literal if unescaped.
      await expect(store.purgeByTool("test-table", "bad'tool")).rejects.toThrow(/unsafe tool name/);
      // Wildcard character — would match unintended rows.
      await expect(store.purgeByTool("test-table", "copi%")).rejects.toThrow(/unsafe tool name/);
      await expect(store.purgeByTool("test-table", "copi_ot")).rejects.toThrow(/unsafe tool name/);
      // Empty / leading non-alphanumeric.
      await expect(store.purgeByTool("test-table", "")).rejects.toThrow(/unsafe tool name/);
      await expect(store.purgeByTool("test-table", "-leading-dash")).rejects.toThrow(/unsafe tool name/);

      // The unrelated row is untouched because every bad call threw.
      const rows = await store.queryRows("test-table", { where: "id = 'keep-1'", limit: 1 });
      expect(rows).toHaveLength(1);
    });

    it("accepts alphanumeric tool names with allowed separators", async () => {
      // All of these should be accepted (not throw); purge returns 0 on empty table.
      for (const name of ["cursor", "claude-code", "codex", "gemini", "my.tool.v2", "team:scraper-01"]) {
        await expect(store.purgeByTool("test-table", name)).resolves.toBeTypeOf("number");
      }
    });
  });
});
