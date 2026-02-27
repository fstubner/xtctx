import { Router } from "express";
import {
  CONTINUITY_CATEGORIES,
  CONTINUITY_SCOPES,
  loadEffectiveContinuityPolicy,
  loadRepoContinuityPolicyLayer,
  writeRepoContinuityPolicyLayer,
  type ContinuityCategory,
  type ContinuityScope,
} from "../../config/policy.js";
import {
  getToolContinuityStatuses,
  previewToolContinuity,
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

  router.get("/render/:tool", async (req, res, next) => {
    try {
      const tool = String(req.params.tool ?? "").trim();
      if (!tool) {
        res.status(400).json({ error: "tool is required" });
        return;
      }

      const preview = await previewToolContinuity(tool, deps.projectRoot);
      res.json(preview);
    } catch (error) {
      next(error);
    }
  });

  router.put("/tools/:tool", async (req, res, next) => {
    try {
      const tool = String(req.params.tool ?? "").trim();
      if (!tool) {
        res.status(400).json({ error: "tool is required" });
        return;
      }

      const patch = parseToolPatch(req.body);
      const repoLayer = await loadRepoContinuityPolicyLayer(deps.projectRoot);
      const existing = repoLayer.tools[tool] ?? {};

      repoLayer.tools[tool] = {
        enabled: patch.enabled ?? existing.enabled,
        scope: patch.scope ?? existing.scope,
        categories: {
          ...(existing.categories ?? {}),
          ...(patch.categories ?? {}),
        },
        preferences:
          patch.preferences
            ? {
                ...(existing.preferences ?? {}),
                ...patch.preferences,
              }
            : (existing.preferences ?? {}),
      };

      await writeRepoContinuityPolicyLayer(repoLayer, deps.projectRoot);
      const [effectivePolicy, toolStatus] = await Promise.all([
        loadEffectiveContinuityPolicy(deps.projectRoot),
        syncToolConfigByName(tool, deps.projectRoot),
      ]);

      res.json({
        tool,
        updated: true,
        effectivePolicy,
        toolStatus,
      });
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

interface ToolPatch {
  enabled?: boolean;
  scope?: ContinuityScope;
  categories?: Partial<Record<ContinuityCategory, boolean>>;
  preferences?: Record<string, unknown>;
}

function parseToolPatch(input: unknown): ToolPatch {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  const raw = input as Record<string, unknown>;
  const patch: ToolPatch = {};

  if (typeof raw.enabled === "boolean") {
    patch.enabled = raw.enabled;
  }

  if (
    typeof raw.scope === "string"
    && CONTINUITY_SCOPES.includes(raw.scope as ContinuityScope)
  ) {
    patch.scope = raw.scope as ContinuityScope;
  }

  if (raw.categories && typeof raw.categories === "object" && !Array.isArray(raw.categories)) {
    const categories: Partial<Record<ContinuityCategory, boolean>> = {};
    for (const category of CONTINUITY_CATEGORIES) {
      const value = (raw.categories as Record<string, unknown>)[category];
      if (typeof value === "boolean") {
        categories[category] = value;
      }
    }

    patch.categories = categories;
  }

  if (raw.preferences && typeof raw.preferences === "object" && !Array.isArray(raw.preferences)) {
    patch.preferences = raw.preferences as Record<string, unknown>;
  }

  return patch;
}
