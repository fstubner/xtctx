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
  knowledgeDir: string;
  configRoot: string;
  stateDir: string;
  webPort: number;
  knowledge: KnowledgeRepository;
  sessions: EmptySessionService;
  configs: FileConfigStore;
}

export async function createProjectServices(projectPath?: string): Promise<ProjectServices> {
  const projectRoot = resolve(projectPath ?? process.cwd());
  const xtctxDir = join(projectRoot, ".xtctx");
  const knowledgeDir = join(xtctxDir, "knowledge");
  const configRoot = join(xtctxDir, "tool-config");
  const stateDir = join(xtctxDir, "state");
  const webPort = await loadWebPort(xtctxDir);

  const knowledge = new KnowledgeRepository(knowledgeDir);
  await knowledge.initialize();

  return {
    projectRoot,
    xtctxDir,
    knowledgeDir,
    configRoot,
    stateDir,
    webPort,
    knowledge,
    sessions: new EmptySessionService(),
    configs: new FileConfigStore(configRoot),
  };
}

async function loadWebPort(xtctxDir: string): Promise<number> {
  const configPath = join(xtctxDir, "config.yaml");
  try {
    const raw = await readFile(configPath, "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown>;
    const web = parsed.web;

    if (web && typeof web === "object" && !Array.isArray(web)) {
      const port = Number((web as Record<string, unknown>).port);
      if (Number.isFinite(port) && port > 0 && port < 65536) {
        return port;
      }
    }
  } catch {
    // default if missing
  }

  return 3232;
}
