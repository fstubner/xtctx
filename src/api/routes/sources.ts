import { Router } from "express";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { SessionService } from "../../mcp/tools/sessions.js";
import type { ContextRecord } from "../../types/context.js";

export interface SourcesRouteDependencies {
  projectRoot: string;
  knowledgeDir: string;
  stateDir: string;
  ingestion: {
    scrapers: Array<{ tool: string; enabled: boolean; customStorePath?: string }>;
  };
  sessions: SessionService;
  knowledgeRecords: () => Promise<ContextRecord[]>;
}

interface ScraperStatus {
  tool: string;
  path: string;
  enabled: boolean;
  detected: boolean;
}

export function createSourcesRouter(deps: SourcesRouteDependencies): Router {
  const router = Router();

  router.get("/", async (_req, res, next) => {
    try {
      const knowledge = await deps.knowledgeRecords();
      const scraperStatuses = await buildScraperStatuses(deps.ingestion.scrapers);
      const recentSessions = await deps.sessions.listRecentSessions(5);

      res.json({
        projectRoot: deps.projectRoot,
        sources: [
          {
            name: "knowledge",
            kind: "filesystem",
            path: deps.knowledgeDir,
            records: knowledge.length,
          },
          {
            name: "conversation-scrapers",
            kind: "scraper-group",
            tools: scraperStatuses,
          },
          {
            name: "scraper-state",
            kind: "filesystem",
            path: deps.stateDir,
          },
        ],
        sessions: recentSessions,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/status", async (_req, res, next) => {
    try {
      const scraperStatuses = await buildScraperStatuses(deps.ingestion.scrapers);
      const records = await deps.knowledgeRecords();

      res.json({
        ok: true,
        scrapers: scraperStatuses,
        toolPortabilityReady: scraperStatuses.some((scraper) => scraper.enabled && scraper.detected),
        connectedSources: scraperStatuses.filter((scraper) => scraper.enabled).length,
        knowledgeRecords: records.length,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function resolveClaudeProjectsDir(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  return join(home, ".claude", "projects");
}

function resolveCursorStorePath(): string {
  const appData = process.env.APPDATA;
  if (appData) {
    return join(appData, "Cursor", "User", "workspaceStorage");
  }

  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  return join(home, ".cursor", "workspaceStorage");
}

function resolveCodexSessionsPath(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  return join(home, ".codex", "sessions");
}

function resolveCopilotHistoryPath(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  return join(home, ".copilot", "history");
}

function resolveGeminiHistoryPath(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  return join(home, ".gemini", "history");
}

async function buildScraperStatuses(
  scraperConfig: Array<{ tool: string; enabled: boolean; customStorePath?: string }>,
): Promise<ScraperStatus[]> {
  const defaults: Record<string, string> = {
    "claude-code": resolveClaudeProjectsDir(),
    cursor: resolveCursorStorePath(),
    codex: resolveCodexSessionsPath(),
    copilot: resolveCopilotHistoryPath(),
    gemini: resolveGeminiHistoryPath(),
  };

  const configByTool = new Map<string, { tool: string; enabled: boolean; customStorePath?: string }>();
  for (const config of scraperConfig) {
    configByTool.set(normalizeTool(config.tool), config);
  }

  const tools = dedupeTools([
    ...Object.keys(defaults),
    ...scraperConfig.map((config) => normalizeTool(config.tool)),
  ]);

  const statuses: ScraperStatus[] = [];
  for (const tool of tools) {
    const config = configByTool.get(tool);
    const enabled = config ? config.enabled : true;
    const path = config?.customStorePath ?? defaults[tool] ?? "not-configured";
    const detected = enabled && path !== "not-configured" ? await isPathPresent(path) : false;
    statuses.push({
      tool,
      path,
      enabled,
      detected,
    });
  }

  return statuses;
}

async function isPathPresent(path: string): Promise<boolean> {
  try {
    const result = await stat(path);
    return result.isDirectory() || result.isFile();
  } catch {
    return false;
  }
}

function normalizeTool(tool: string): string {
  if (tool === "claude") {
    return "claude-code";
  }

  return tool;
}

function dedupeTools(tools: string[]): string[] {
  return [...new Set(tools)];
}
