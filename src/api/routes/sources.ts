import { Router } from "express";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { SessionService } from "../../mcp/tools/sessions.js";
import type { ContextRecord } from "../../types/context.js";

export interface SourcesRouteDependencies {
  projectRoot: string;
  knowledgeDir: string;
  stateDir: string;
  ingestion: {
    scrapers: Array<{ tool: string; enabled: boolean; customStorePath?: string }>;
    watchPaths: string[];
    pollIntervalMs: number;
    excludePatterns: string[];
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

  router.get("/config", async (_req, res, next) => {
    try {
      const scraperStatuses = await buildScraperStatuses(deps.ingestion.scrapers);
      res.json({
        watchPaths: deps.ingestion.watchPaths,
        pollIntervalMs: deps.ingestion.pollIntervalMs,
        excludePatterns: deps.ingestion.excludePatterns,
        scrapers: scraperStatuses,
      });
    } catch (error) {
      next(error);
    }
  });

  router.put("/scrapers/:tool", async (req, res, next) => {
    try {
      const tool = normalizeTool(String(req.params.tool ?? "").trim());
      if (!tool) {
        res.status(400).json({ error: "tool is required" });
        return;
      }

      const patch = parseScraperPatch(req.body);
      if (!patch.hasPatch) {
        res.status(400).json({ error: "At least one of enabled or customStorePath is required." });
        return;
      }

      const runtimePath = patch.customStorePath === undefined
        ? undefined
        : patch.customStorePath
          ? resolveCustomStorePath(patch.customStorePath, deps.projectRoot)
          : null;

      upsertRuntimeScraper(deps.ingestion.scrapers, tool, patch.enabled, runtimePath);
      await upsertPersistedScraperConfig(deps.projectRoot, tool, patch.enabled, patch.customStorePath);

      const scraperStatuses = await buildScraperStatuses(deps.ingestion.scrapers);
      const scraper = scraperStatuses.find((item) => normalizeTool(item.tool) === tool);

      res.json({
        tool,
        scraper,
        scrapers: scraperStatuses,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

interface ScraperPatch {
  hasPatch: boolean;
  enabled?: boolean;
  customStorePath?: string | null;
}

function parseScraperPatch(input: unknown): ScraperPatch {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { hasPatch: false };
  }

  const raw = input as Record<string, unknown>;
  const patch: ScraperPatch = { hasPatch: false };

  if (typeof raw.enabled === "boolean") {
    patch.enabled = raw.enabled;
    patch.hasPatch = true;
  }

  if (typeof raw.customStorePath === "string") {
    const value = raw.customStorePath.trim();
    patch.customStorePath = value.length > 0 ? value : null;
    patch.hasPatch = true;
  } else if (raw.customStorePath === null) {
    patch.customStorePath = null;
    patch.hasPatch = true;
  }

  return patch;
}

function resolveCustomStorePath(input: string, projectRoot: string): string {
  return isAbsolute(input) ? input : resolve(projectRoot, input);
}

function upsertRuntimeScraper(
  scrapers: Array<{ tool: string; enabled: boolean; customStorePath?: string }>,
  tool: string,
  enabled?: boolean,
  runtimePath?: string | null,
): void {
  const index = scrapers.findIndex((item) => normalizeTool(item.tool) === tool);
  const current = index >= 0
    ? { ...scrapers[index] }
    : { tool, enabled: true };

  if (typeof enabled === "boolean") {
    current.enabled = enabled;
  }

  if (runtimePath === null) {
    delete current.customStorePath;
  } else if (typeof runtimePath === "string") {
    current.customStorePath = runtimePath;
  }

  if (index >= 0) {
    scrapers[index] = current;
  } else {
    scrapers.push(current);
  }
}

async function upsertPersistedScraperConfig(
  projectRoot: string,
  tool: string,
  enabled?: boolean,
  customStorePath?: string | null,
): Promise<void> {
  const configPath = join(projectRoot, ".xtctx", "config.yaml");
  const document = await loadConfigDocument(configPath);

  const ingestion = readRecord(document, "ingestion");
  const scraperList = Array.isArray(ingestion.scrapers) ? ingestion.scrapers : [];
  const parsedScrapers = scraperList
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map((item) => ({ ...item }));

  const index = parsedScrapers.findIndex((item) => normalizeTool(String(item.tool ?? "")) === tool);
  const current = index >= 0 ? parsedScrapers[index] : { tool };

  current.tool = tool;

  if (typeof enabled === "boolean") {
    current.enabled = enabled;
  }

  if (customStorePath === null) {
    delete current.customStorePath;
  } else if (typeof customStorePath === "string") {
    current.customStorePath = customStorePath;
  }

  if (index >= 0) {
    parsedScrapers[index] = current;
  } else {
    parsedScrapers.push(current);
  }

  ingestion.scrapers = parsedScrapers;
  document.ingestion = ingestion;
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, stringifyYaml(document), "utf-8");
}

async function loadConfigDocument(path: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = parseYaml(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore and return defaults
  }

  return {};
}

function readRecord(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = source[key];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>) };
  }

  return {};
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
