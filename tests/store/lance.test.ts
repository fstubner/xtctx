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
});
