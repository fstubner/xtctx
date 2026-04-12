import { describe, expect, it, vi } from "vitest";
import { createSearchRouter } from "@xtctx/api/routes/search";
import type { SearchRunner } from "@xtctx/mcp/tools/search";
import type { HybridSearchResult } from "@xtctx/store/search";
import express from "express";
import { createServer } from "node:http";

/**
 * C1 — Verify that the search route delegates to the provided SearchRunner
 * (i.e., the LanceDB hybrid-search pipeline) rather than doing its own
 * in-memory substring matching.
 */
describe("createSearchRouter", () => {
  function makeResult(id: string, text: string, score: number): HybridSearchResult {
    return {
      id,
      text,
      metadata: JSON.stringify({ title: `Title ${id}`, source_tool: "test" }),
      score,
      fusedScore: score,
    };
  }

  it("delegates search to the supplied SearchRunner (C1)", async () => {
    const mockRunner: SearchRunner = {
      search: vi.fn().mockResolvedValue([
        makeResult("r1", "LanceDB result", 0.9),
      ]),
    };

    const router = createSearchRouter({ search: mockRunner });
    const app = express();
    app.use(express.json());
    app.use("/api/search", router);

    const server = createServer(app);
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    const port = (server.address() as { port: number }).port;

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/search?query=test&format=json`,
      );
      expect(response.ok).toBe(true);
      const body = (await response.json()) as { results: HybridSearchResult[] };
      expect(body.results).toHaveLength(1);
      expect(body.results[0].id).toBe("r1");

      // The runner MUST have been called — not bypassed (C1 regression guard).
      expect(mockRunner.search).toHaveBeenCalledWith(
        "context",
        "test",
        "hybrid",
        10,
      );
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  it("passes mode and limit from query params to the runner", async () => {
    const mockRunner: SearchRunner = {
      search: vi.fn().mockResolvedValue([]),
    };
    const router = createSearchRouter({ search: mockRunner });
    const app = express();
    app.use("/api/search", router);

    const server = createServer(app);
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    const port = (server.address() as { port: number }).port;

    try {
      await fetch(`http://127.0.0.1:${port}/api/search?query=hello&mode=semantic&limit=5`);
      expect(mockRunner.search).toHaveBeenCalledWith("context", "hello", "semantic", 5);
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });
});
