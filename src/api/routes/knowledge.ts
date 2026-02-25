import { Router } from "express";
import {
  createProjectKnowledgeHandler,
  type KnowledgeStore,
} from "../../mcp/tools/knowledge.js";
import type { ContextType } from "../../types/context.js";

interface KnowledgeQuery {
  type?: string;
  query?: string;
  format?: "json" | "markdown";
}

export function createKnowledgeRouter(knowledge: KnowledgeStore): Router {
  const router = Router();
  const handler = createProjectKnowledgeHandler(knowledge);

  router.get("/", async (req, res, next) => {
    try {
      const query = req.query as KnowledgeQuery;
      const type = normalizeType(query.type);
      const format = query.format === "markdown" ? "markdown" : "json";
      const result = await handler({
        type,
        query: query.query,
        format,
      });

      if (format === "markdown" && typeof result === "string") {
        res.type("text/markdown").send(result);
        return;
      }

      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function normalizeType(value?: string): ContextType | "all" {
  if (
    value === "decision" ||
    value === "error_solution" ||
    value === "insight" ||
    value === "convention" ||
    value === "gotcha" ||
    value === "all"
  ) {
    return value;
  }

  return "all";
}
