import { readdir, readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { KnowledgeRepository } from "../knowledge/repository.js";
import type { ConfigStore, ConfigType, NamedConfig } from "../mcp/tools/config.js";
import type { SessionMessage, SessionService, SessionSummary } from "../mcp/tools/sessions.js";

export class EmptySessionService implements SessionService {
  async listRecentSessions(_limit: number, _toolFilter?: string[]): Promise<SessionSummary[]> {
    return [];
  }

  async getSessionDetail(
    _sessionRef: string,
    _offset: number,
    _limit: number,
  ): Promise<SessionMessage[]> {
    return [];
  }
}

export class FileConfigStore implements ConfigStore {
  constructor(private readonly configRoot: string) {}

  async list(type?: ConfigType): Promise<NamedConfig[]> {
    const types: ConfigType[] = type ? [type] : ["skill", "command", "agent"];
    const all: NamedConfig[] = [];

    for (const configType of types) {
      const dir = join(this.configRoot, `${configType}s`);
      let files: string[];

      try {
        files = await readdir(dir);
      } catch {
        continue;
      }

      for (const file of files) {
        const parsed = await this.parseFile(join(dir, file), configType);
        if (parsed) {
          all.push(parsed);
        }
      }
    }

    return all;
  }

  async get(type: ConfigType, name: string): Promise<NamedConfig | null> {
    const items = await this.list(type);
    return items.find((item) => item.name === name) ?? null;
  }

  async toolPreferences(tool: string): Promise<Record<string, unknown>> {
    const filePath = join(this.configRoot, "shared.yaml");

    try {
      const raw = await readFile(filePath, "utf-8");
      const parsed = parseYaml(raw) as Record<string, unknown>;
      const prefs = parsed.toolPreferences;

      if (prefs && typeof prefs === "object" && !Array.isArray(prefs)) {
        const toolPrefs = (prefs as Record<string, unknown>)[tool];
        if (toolPrefs && typeof toolPrefs === "object" && !Array.isArray(toolPrefs)) {
          return toolPrefs as Record<string, unknown>;
        }
      }
    } catch {
      // fall through
    }

    return {};
  }

  private async parseFile(filePath: string, type: ConfigType): Promise<NamedConfig | null> {
    try {
      const raw = await readFile(filePath, "utf-8");
      const name = filePath
        .split(/[\\/]/)
        .pop()
        ?.replace(/\.(json|ya?ml|md|txt)$/i, "");

      if (!name) {
        return null;
      }

      const extension = extname(filePath).toLowerCase();
      if (extension === ".json") {
        return { type, name, content: JSON.parse(raw) as Record<string, unknown> };
      }

      if (extension === ".yaml" || extension === ".yml") {
        const parsed = parseYaml(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return { type, name, content: parsed as Record<string, unknown> };
        }
      }

      return { type, name, content: { text: raw } };
    } catch {
      return null;
    }
  }
}

export interface ProjectServices {
  projectRoot: string;
  xtctxDir: string;
  storeDir: string;
  knowledgeDir: string;
  configRoot: string;
  stateDir: string;
  webPort: number;
  ingestion: {
    scrapers: Array<{ tool: string; enabled: boolean; customStorePath?: string }>;
    watchPaths: string[];
    pollIntervalMs: number;
    excludePatterns: string[];
  };
  knowledge: KnowledgeRepository;
  sessions: EmptySessionService;
  configs: FileConfigStore;
}

export async function createProjectServices(projectPath?: string): Promise<ProjectServices> {
  const projectRoot = resolve(projectPath ?? process.cwd());
  const xtctxDir = join(projectRoot, ".xtctx");
  const storeDir = join(xtctxDir, ".store");
  const knowledgeDir = join(xtctxDir, "knowledge");
  const configRoot = join(xtctxDir, "tool-config");
  const stateDir = join(xtctxDir, "state");
  const config = await loadProjectConfig(xtctxDir);
  const webPort = parseWebPort(config);
  const ingestion = parseIngestionConfig(config, projectRoot);

  const knowledge = new KnowledgeRepository(knowledgeDir);
  await knowledge.initialize();

  return {
    projectRoot,
    xtctxDir,
    storeDir,
    knowledgeDir,
    configRoot,
    stateDir,
    webPort,
    ingestion,
    knowledge,
    sessions: new EmptySessionService(),
    configs: new FileConfigStore(configRoot),
  };
}

async function loadProjectConfig(xtctxDir: string): Promise<Record<string, unknown>> {
  const configPath = join(xtctxDir, "config.yaml");

  try {
    const raw = await readFile(configPath, "utf-8");
    const parsed = parseYaml(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }

  return {};
}

function parseWebPort(config: Record<string, unknown>): number {
  const web = config.web;
  if (web && typeof web === "object" && !Array.isArray(web)) {
    const port = Number((web as Record<string, unknown>).port);
    if (Number.isFinite(port) && port > 0 && port < 65536) {
      return port;
    }
  }

  return 3232;
}

function parseIngestionConfig(
  config: Record<string, unknown>,
  projectRoot: string,
): {
  scrapers: Array<{ tool: string; enabled: boolean; customStorePath?: string }>;
  watchPaths: string[];
  pollIntervalMs: number;
  excludePatterns: string[];
} {
  const ingestion = config.ingestion;
  const defaults = {
    scrapers: [] as Array<{ tool: string; enabled: boolean; customStorePath?: string }>,
    watchPaths: [projectRoot],
    pollIntervalMs: 30_000,
    excludePatterns: ["node_modules/**", "dist/**"],
  };

  if (!ingestion || typeof ingestion !== "object" || Array.isArray(ingestion)) {
    return defaults;
  }

  const value = ingestion as Record<string, unknown>;

  const watchPaths = Array.isArray(value.watchPaths)
    ? value.watchPaths
        .filter((item): item is string => typeof item === "string" && item.length > 0)
        .map((item) => resolve(projectRoot, item))
    : defaults.watchPaths;

  const pollIntervalMs = Number(value.pollIntervalMs);

  const excludePatterns = Array.isArray(value.excludePatterns)
    ? value.excludePatterns.filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      )
    : defaults.excludePatterns;

  const scrapers = Array.isArray(value.scrapers)
    ? value.scrapers
        .map((item): { tool: string; enabled: boolean; customStorePath?: string } | null => {
          if (!item || typeof item !== "object" || Array.isArray(item)) {
            return null;
          }
          const scraper = item as Record<string, unknown>;
          const tool = typeof scraper.tool === "string" ? scraper.tool : "";
          if (!tool) {
            return null;
          }

          const enabled = scraper.enabled !== false;
          if (typeof scraper.customStorePath === "string") {
            return {
              tool,
              enabled,
              customStorePath: resolve(projectRoot, scraper.customStorePath),
            };
          }

          return { tool, enabled };
        })
        .filter((item): item is { tool: string; enabled: boolean; customStorePath?: string } =>
          item !== null,
        )
    : defaults.scrapers;

  return {
    scrapers,
    watchPaths: watchPaths.length > 0 ? watchPaths : defaults.watchPaths,
    pollIntervalMs:
      Number.isFinite(pollIntervalMs) && pollIntervalMs > 0
        ? Math.floor(pollIntervalMs)
        : defaults.pollIntervalMs,
    excludePatterns,
  };
}
