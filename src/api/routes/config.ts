import { Router } from "express";
import {
  createGetConfigHandler,
  createListConfigsHandler,
  createToolPreferencesHandler,
  type ConfigStore,
  type ConfigType,
} from "../../mcp/tools/config.js";

export function createConfigRouter(store: ConfigStore): Router {
  const router = Router();
  const listConfigs = createListConfigsHandler(store);
  const getConfig = createGetConfigHandler(store);
  const toolPreferences = createToolPreferencesHandler(store);

  router.get("/list", async (req, res, next) => {
    try {
      const type = normalizeListType(req.query.type);
      const result = await listConfigs({ type, format: "json" });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get("/get", async (req, res, next) => {
    try {
      const type = normalizeConfigType(req.query.type);
      const name = String(req.query.name ?? "");
      if (!type || !name) {
        res.status(400).json({ error: "type and name are required" });
        return;
      }

      const result = await getConfig({ type, name, format: "json" });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get("/preferences", async (req, res, next) => {
    try {
      const tool = String(req.query.tool ?? "");
      if (!tool) {
        res.status(400).json({ error: "tool is required" });
        return;
      }

      const result = await toolPreferences({ tool, format: "json" });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function normalizeListType(value: unknown): ConfigType | "all" {
  if (value === "skill" || value === "command" || value === "agent" || value === "all") {
    return value;
  }
  return "all";
}

function normalizeConfigType(value: unknown): ConfigType | null {
  if (value === "skill" || value === "command" || value === "agent") {
    return value;
  }
  return null;
}
