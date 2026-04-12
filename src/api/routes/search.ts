import { Router } from "express";
import { createSearchHandler, type SearchRunner } from "../../mcp/tools/search.js";

export interface SearchRouteDependencies {
  /** LanceDB-backed hybrid search runner (same pipeline used by MCP tools). */
  search: SearchRunner;
}

export function createSearchRouter(deps: SearchRouteDependencies): Router {
  const router = Router();
  const handler = createSearchHandler(deps.search);

  router.get("/", async (req, res, next) => {
    try {
      const query = String(req.query.query ?? "");
      const mode = normalizeMode(req.query.mode);
      const limit = clampLimit(req.query.limit);
      const depth = normalizeDepth(req.query.depth);
      const format = "json";
      const result = await handler({ query, mode, limit, depth, format });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const query = String(req.body?.query ?? "");
      const mode = normalizeMode(req.body?.mode);
      const limit = clampLimit(req.body?.limit);
      const depth = normalizeDepth(req.body?.depth);
      const format = "json";
      const result = await handler({ query, mode, limit, depth, format });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function normalizeMode(value: unknown): "hybrid" | "semantic" | "keyword" {
  if (value === "semantic" || value === "keyword") {
    return value;
  }
  return "hybrid";
}

function normalizeDepth(value: unknown): "summary" | "detail" | "raw" {
  if (value === "detail" || value === "raw") {
    return value;
  }
  return "summary";
}

function clampLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 10;
  }
  return Math.max(1, Math.min(100, Math.floor(parsed)));
}
