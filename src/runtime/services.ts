import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { SqliteHandoffIndex } from "../handoff/sqlite-index.js";
import type { SessionService } from "../handoff/types.js";
import { createDefaultScrapers } from "../tools/sources.js";

export interface ProjectConfig {
  tools: Record<string, { enabled?: boolean; storePath?: string }>;
}

export interface ProjectServices {
  projectRoot: string;
  xtctxDir: string;
  stateDir: string;
  dbPath: string;
  configPath: string;
  config: ProjectConfig;
  sessions: SessionService;
}

export async function createProjectServices(projectPath?: string): Promise<ProjectServices> {
  const projectRoot = resolve(projectPath ?? process.cwd());
  const xtctxDir = join(projectRoot, ".xtctx");
  const stateDir = join(xtctxDir, "state");
  const dbPath = join(stateDir, "xtctx.db");
  const configPath = join(xtctxDir, "config.yaml");
  const config = await loadProjectConfig(configPath);
  const overrides = Object.fromEntries(
    Object.entries(config.tools)
      .filter(([, value]) => value.enabled !== false)
      .map(([tool, value]) => [tool, value.storePath]),
  );
  const scrapers = createDefaultScrapers(stateDir, overrides).filter((scraper) => {
    const toolConfig = config.tools[scraper.tool];
    return toolConfig?.enabled !== false;
  });

  const sessions = new SqliteHandoffIndex(
    dbPath,
    projectRoot,
    scrapers.map((scraper) => ({ tool: scraper.tool, scraper })),
  );

  return {
    projectRoot,
    xtctxDir,
    stateDir,
    dbPath,
    configPath,
    config,
    sessions,
  };
}

export async function loadProjectConfig(configPath: string): Promise<ProjectConfig> {
  try {
    const raw = await readFile(configPath, "utf-8");
    const parsed = parseYaml(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const root = parsed as Record<string, unknown>;
      return {
        tools: normalizeTools(root.tools),
      };
    }
  } catch {
    // Missing config is valid: setup owns writing it, MCP can still run.
  }

  return { tools: {} };
}

function normalizeTools(input: unknown): ProjectConfig["tools"] {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  const tools: ProjectConfig["tools"] = {};
  for (const [tool, rawConfig] of Object.entries(input as Record<string, unknown>)) {
    if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
      continue;
    }

    const value = rawConfig as Record<string, unknown>;
    const config: { enabled?: boolean; storePath?: string } = {};
    if (typeof value.enabled === "boolean") {
      config.enabled = value.enabled;
    }
    if (typeof value.storePath === "string" && value.storePath.trim().length > 0) {
      config.storePath = resolve(value.storePath);
    }
    tools[tool] = config;
  }

  return tools;
}
