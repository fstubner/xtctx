import { Router } from "express";
import { createSearchHandler, type SearchRunner } from "../../mcp/tools/search.js";
import type { ContextRecord } from "../../types/context.js";

export interface SearchRouteDependencies {
  knowledgeRecords: () => Promise<ContextRecord[]>;
}

interface SearchRecord {
  id: string;
  text: string;
  metadata: string;
  score: number;
  fusedScore: number;
}

class KnowledgeSearchRunner implements SearchRunner {
  constructor(private readonly knowledgeRecords: () => Promise<ContextRecord[]>) {}

  async search(
    _tableName: string,
    query: string,
    _mode: "hybrid" | "semantic" | "keyword",
    limit: number,
  ): Promise<SearchRecord[]> {
    const records = await this.knowledgeRecords();
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return [];
    }

    const ranked = records
      .map((record) => {
        const haystack = `${record.title} ${record.body} ${record.domain_tags.join(" ")}`.toLowerCase();
        const score = relevanceScore(needle, haystack);
        return { record, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return ranked.map(({ record, score }) => ({
      id: record.id,
      text: record.body,
      metadata: JSON.stringify({
        title: record.title,
        type: record.type,
        source_tool: record.source_tool,
        created_at: record.created_at,
      }),
      score,
      fusedScore: score,
    }));
  }
}

export function createSearchRouter(deps: SearchRouteDependencies): Router {
  const router = Router();
  const runner = new KnowledgeSearchRunner(deps.knowledgeRecords);
  const handler = createSearchHandler(runner);

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

function relevanceScore(needle: string, haystack: string): number {
  const words = needle.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return 0;
  }

  let hits = 0;
  for (const word of words) {
    if (haystack.includes(word)) {
      hits += 1;
    }
  }

  if (hits === 0) {
    return 0;
  }

  const coverage = hits / words.length;
  const exactBonus = haystack.includes(needle) ? 0.25 : 0;
  return Math.min(1, coverage + exactBonus);
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
