import { join } from "node:path";
import { AntigravityScraper } from "../scrapers/antigravity.js";
import { ClaudeCodeScraper } from "../scrapers/claude-code.js";
import { CodexCliScraper } from "../scrapers/codex.js";
import { CopilotCliScraper } from "../scrapers/copilot-cli.js";
import { CopilotScraper } from "../scrapers/copilot.js";
import { CursorScraper } from "../scrapers/cursor.js";
import { OpenCodeScraper } from "../scrapers/opencode.js";
import type { ConversationScraper } from "../types/scraper.js";

export type ToolId =
  | "claude-code"
  | "cursor"
  | "codex"
  | "copilot"
  | "antigravity"
  | "opencode"
  | "copilot-cli";

export type HookMode = "executable" | "instruction-only" | "mcp-only";
export type SkillSyncMode =
  | "native-skill"
  | "rule-adapter"
  | "instruction-adapter"
  | "managed-block"
  | "unsupported";

export interface ToolSkillCapability {
  mode: SkillSyncMode;
  targetPath?: (projectRoot: string, skillId: string) => string;
}

export interface ToolSourceDefinition {
  id: ToolId;
  label: string;
  defaultStorePath: () => string;
  createScraper: (
    storePath: string,
    stateDir: string,
    projectRoot?: string,
  ) => ConversationScraper;
  memoryTargets: string[];
  hookMode: HookMode;
  skillSync?: ToolSkillCapability;
}

export const SUPPORTED_TOOLS: ToolSourceDefinition[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    defaultStorePath: defaultClaudeProjectsDir,
    createScraper: (storePath, stateDir, projectRoot) =>
      new ClaudeCodeScraper(storePath, stateDir, projectRoot),
    memoryTargets: ["CLAUDE.md"],
    hookMode: "executable",
    skillSync: {
      mode: "native-skill",
      targetPath: (projectRoot, skillId) => join(projectRoot, ".claude", "skills", skillId, "SKILL.md"),
    },
  },
  {
    id: "cursor",
    label: "Cursor",
    defaultStorePath: defaultCursorStorePath,
    createScraper: (storePath, stateDir, projectRoot) =>
      new CursorScraper(storePath, stateDir, projectRoot),
    memoryTargets: [join(".cursor", "rules", "xtctx.mdc")],
    hookMode: "instruction-only",
    skillSync: {
      mode: "rule-adapter",
      targetPath: (projectRoot, skillId) => join(projectRoot, ".cursor", "rules", "xtctx-skills", `${skillId}.mdc`),
    },
  },
  {
    id: "codex",
    label: "Codex",
    defaultStorePath: defaultCodexSessionsPath,
    createScraper: (storePath, stateDir, projectRoot) =>
      new CodexCliScraper(storePath, stateDir, projectRoot),
    memoryTargets: ["AGENTS.md"],
    hookMode: "instruction-only",
    skillSync: {
      mode: "managed-block",
      targetPath: (projectRoot) => join(projectRoot, "AGENTS.md"),
    },
  },
  {
    id: "copilot",
    label: "GitHub Copilot",
    defaultStorePath: defaultCopilotHistoryPath,
    createScraper: (storePath, stateDir, projectRoot) =>
      new CopilotScraper(storePath, stateDir, projectRoot),
    memoryTargets: [join(".github", "copilot-instructions.md")],
    hookMode: "instruction-only",
    skillSync: {
      mode: "instruction-adapter",
      targetPath: (projectRoot, skillId) =>
        join(projectRoot, ".github", "instructions", `xtctx-${skillId}.instructions.md`),
    },
  },
  {
    id: "antigravity",
    label: "Google Antigravity",
    defaultStorePath: defaultAntigravityStorePath,
    createScraper: (storePath, stateDir, projectRoot) =>
      new AntigravityScraper(storePath, stateDir, projectRoot),
    // Antigravity CLI keeps project-memory compatibility with GEMINI.md.
    memoryTargets: ["GEMINI.md"],
    hookMode: "instruction-only",
    skillSync: {
      mode: "managed-block",
      targetPath: (projectRoot) => join(projectRoot, "GEMINI.md"),
    },
  },
  {
    id: "opencode",
    label: "opencode",
    defaultStorePath: defaultOpenCodeStorePath,
    createScraper: (storePath, stateDir, projectRoot) =>
      new OpenCodeScraper(storePath, stateDir, projectRoot),
    memoryTargets: ["AGENTS.md"],
    hookMode: "instruction-only",
    skillSync: {
      mode: "managed-block",
      targetPath: (projectRoot) => join(projectRoot, "AGENTS.md"),
    },
  },
  {
    id: "copilot-cli",
    label: "GitHub Copilot CLI",
    defaultStorePath: defaultCopilotCliSessionPath,
    createScraper: (storePath, stateDir, projectRoot) =>
      new CopilotCliScraper(storePath, stateDir, projectRoot),
    memoryTargets: [join(".github", "copilot-instructions.md")],
    hookMode: "mcp-only",
    skillSync: {
      mode: "managed-block",
      targetPath: (projectRoot) => join(projectRoot, ".github", "copilot-instructions.md"),
    },
  },
];

export function createDefaultScrapers(
  stateDir: string,
  overrides: Record<string, string | undefined> = {},
  projectRoot?: string,
): ConversationScraper[] {
  return SUPPORTED_TOOLS.map((tool) =>
    tool.createScraper(overrides[tool.id] ?? tool.defaultStorePath(), stateDir, projectRoot),
  );
}

export function getToolDefinition(toolId: string): ToolSourceDefinition | undefined {
  return SUPPORTED_TOOLS.find((tool) => tool.id === toolId);
}

export function defaultClaudeProjectsDir(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  return join(home, ".claude", "projects");
}

export function defaultCursorStorePath(): string {
  const appData = process.env.APPDATA;
  if (appData) {
    return join(appData, "Cursor", "User", "workspaceStorage");
  }

  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  return join(home, ".cursor", "workspaceStorage");
}

export function defaultCodexSessionsPath(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  return join(home, ".codex", "sessions");
}

export function defaultCopilotHistoryPath(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";

  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    return join(appData, "Code", "User", "workspaceStorage");
  }

  if (process.platform === "linux") {
    return join(home, ".config", "Code", "User", "workspaceStorage");
  }

  return join(home, "Library", "Application Support", "Code", "User", "workspaceStorage");
}

export function defaultAntigravityStorePath(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  return join(home, ".gemini", "antigravity");
}

export function defaultOpenCodeStorePath(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";

  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    return join(appData, "opencode", "opencode.db");
  }

  if (process.platform === "linux") {
    const xdgDataHome = process.env.XDG_DATA_HOME ?? join(home, ".local", "share");
    return join(xdgDataHome, "opencode", "opencode.db");
  }

  return join(home, "Library", "Application Support", "opencode", "opencode.db");
}

export function defaultCopilotCliSessionPath(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  return join(home, ".copilot", "session-state");
}
