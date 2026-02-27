import { Router } from "express";
import { loadEffectiveContinuityPolicy } from "../../config/policy.js";
import {
  getToolContinuityStatuses,
  syncToolConfigByName,
  syncToolConfigs,
} from "../../config/sync.js";

export interface ContinuityRouteDependencies {
  projectRoot: string;
}

export function createContinuityRouter(deps: ContinuityRouteDependencies): Router {
  const router = Router();

  router.get("/effective-policy", async (_req, res, next) => {
    try {
      const policy = await loadEffectiveContinuityPolicy(deps.projectRoot);
      res.json(policy);
    } catch (error) {
      next(error);
    }
  });

  router.get("/tools-status", async (_req, res, next) => {
    try {
      const tools = await getToolContinuityStatuses(deps.projectRoot);
      res.json({ tools });
    } catch (error) {
      next(error);
    }
  });

  router.post("/sync", async (_req, res, next) => {
    try {
      const result = await syncToolConfigs(deps.projectRoot);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/sync/:tool", async (req, res, next) => {
    try {
      const tool = String(req.params.tool ?? "").trim();
      if (!tool) {
        res.status(400).json({ error: "tool is required" });
        return;
      }

      const result = await syncToolConfigByName(tool, deps.projectRoot);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get("/warnings", async (_req, res, next) => {
    try {
      const tools = await getToolContinuityStatuses(deps.projectRoot);
      const warnings = tools.flatMap((tool) =>
        tool.warnings.map((warning) => ({
          tool: tool.tool,
          warning,
        })),
      );

      res.json({ warnings, count: warnings.length });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
