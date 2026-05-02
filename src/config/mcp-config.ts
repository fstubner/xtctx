import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "@iarna/toml";
import { parse as parseYaml } from "yaml";
import { errorMessage } from "../utils/errors.js";

/**
 * Canonical MCP server definition stored under `.xtctx/tool-config/mcp-servers/`.
 * The same definition is rendered into each tool's native config format via
 * the renderer registry below.
 */
export interface McpServerDefinition {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  transport?: "stdio" | "sse" | "streamable-http";
  url?: string;
}

export interface McpSyncResult {
  tool: string;
  path: string;
  scope: "project" | "global";
  updated: boolean;
  created: boolean;
  skipped: boolean;
  warning?: string;
}

export interface McpSyncSummary {
  results: McpSyncResult[];
  servers_loaded: number;
}

/**
 * A renderer describes how to write MCP server config for one specific tool.
 *
 * The defaults match the Claude Code shape (JSON, root key `mcpServers`,
 * server entries with `type: "stdio" | ...`). Tools that diverge — Codex
 * uses TOML, VS Code Copilot uses `servers` instead of `mcpServers`,
 * opencode uses a nested `mcp` key with `type: "local" | "remote"` and a
 * combined-array `command`, etc. — override the relevant fields.
 *
 * `projectPath` and/or `globalPath` must be set; the writer prefers the
 * project path when both are available, with one exception: tools that
 * have ONLY a user-level config (Copilot CLI's `~/.copilot/mcp-config.json`)
 * write to `globalPath` because there is no project-scoped equivalent.
 */
export interface McpRenderer {
  /** Wire format used to read and write the file. Default: "json". */
  format?: "json" | "toml";
  /** Path resolver for project-scoped config. */
  projectPath?: (projectRoot: string) => string;
  /** Path resolver for user-scoped config. */
  globalPath?: (homeDir: string) => string;
  /**
   * Top-level key under which MCP server entries live.
   *  - "mcpServers" for Claude Code / Cursor / Gemini / Copilot CLI
   *  - "servers" for VS Code Copilot's `.vscode/mcp.json`
   *  - "mcp" for opencode's `opencode.json`
   *  - "mcp_servers" for Codex's `~/.codex/config.toml`
   * Default: "mcpServers".
   */
  rootKey?: string;
  /**
   * Render a single MCP server into the per-entry shape this tool expects.
   * Default: Claude-Code-style { type: "stdio" | ..., command, args, env, url }.
   */
  buildEntry?: (server: McpServerDefinition) => Record<string, unknown>;
}

/**
 * Tools with native MCP configuration support.
 *
 * Tools NOT listed here receive MCP connection details embedded in their
 * managed-block instructions file via `renderMcpServersMarkdown`.
 */
const NATIVE_MCP_TOOLS: Record<string, McpRenderer> = {
  // Claude Code — `.mcp.json` at project root, `mcpServers` key, stdio entries.
  // The "claude" alias matches DEFAULT_REGISTERED_TOOLS in policy.ts; the
  // "claude-code" alias matches the scraper registry name in ingestion.ts.
  claude: {
    projectPath: (root) => join(root, ".mcp.json"),
  },
  "claude-code": {
    projectPath: (root) => join(root, ".mcp.json"),
  },

  // Cursor — `.cursor/mcp.json` at project root, same JSON shape.
  cursor: {
    projectPath: (root) => join(root, ".cursor", "mcp.json"),
  },

  // VS Code GitHub Copilot — `.vscode/mcp.json`. Note: the root key is
  // `servers`, not `mcpServers` (per VS Code's MCP configuration reference).
  copilot: {
    projectPath: (root) => join(root, ".vscode", "mcp.json"),
    rootKey: "servers",
  },

  // Codex CLI — TOML at `.codex/config.toml` (project) or `~/.codex/config.toml`
  // (global). Server entries live under `[mcp_servers.<name>]` tables. Codex's
  // TOML format uses `command` + `args` + `env` and does NOT include a `type`
  // field (stdio is implicit).
  codex: {
    format: "toml",
    projectPath: (root) => join(root, ".codex", "config.toml"),
    globalPath: (home) => join(home, ".codex", "config.toml"),
    rootKey: "mcp_servers",
    buildEntry: buildCodexEntry,
  },

  // Gemini CLI — JSON at `.gemini/settings.json` (project) or
  // `~/.gemini/settings.json` (global). Uses `mcpServers` root, but entries
  // do NOT carry a `type` field per Gemini's native format.
  gemini: {
    projectPath: (root) => join(root, ".gemini", "settings.json"),
    globalPath: (home) => join(home, ".gemini", "settings.json"),
    buildEntry: buildGeminiEntry,
  },

  // opencode (sst/opencode-ai) — JSON at `opencode.json` (project) or
  // `~/.config/opencode/opencode.json` (global). Top-level `mcp` key. Entries
  // use `type: "local" | "remote"`, `command` as a combined ARRAY of
  // strings (executable + args together), `enabled: true`, and `environment`
  // (not `env`) for env vars on local servers. Remote uses `url` + `headers`.
  opencode: {
    projectPath: (root) => join(root, "opencode.json"),
    globalPath: (home) => join(home, ".config", "opencode", "opencode.json"),
    rootKey: "mcp",
    buildEntry: buildOpencodeEntry,
  },

  // GitHub Copilot CLI (the standalone `~/.copilot/`-rooted CLI, distinct
  // from VS Code Copilot) — JSON at `~/.copilot/mcp-config.json`. User-level
  // only; project-level MCP for Copilot CLI lives in `.mcp.json` at the
  // project root, which is already written by the `claude` / `claude-code`
  // renderers above (one file, two consumers).
  "copilot-cli": {
    globalPath: (home) => join(home, ".copilot", "mcp-config.json"),
    buildEntry: buildCopilotCliEntry,
  },
};

export function hasNativeMcpSupport(tool: string): boolean {
  return tool in NATIVE_MCP_TOOLS;
}

/**
 * Load all MCP server definitions from `.xtctx/tool-config/mcp-servers/`.
 */
export async function loadMcpServerDefinitions(configRoot: string): Promise<McpServerDefinition[]> {
  const serversDir = join(configRoot, "mcp-servers");
  let files: string[];
  try {
    files = await readdir(serversDir);
  } catch {
    return [];
  }

  const servers: McpServerDefinition[] = [];
  for (const file of files) {
    const ext = extname(file);
    if (![".json", ".yaml", ".yml"].includes(ext)) continue;

    const name = file.slice(0, file.length - ext.length);
    if (!name) continue;

    try {
      const raw = await readFile(join(serversDir, file), "utf-8");
      const parsed = ext === ".json" ? JSON.parse(raw) : parseYaml(raw);
      const server = normalizeMcpServer(name, parsed);
      if (server) servers.push(server);
    } catch {
      // Skip unparseable files
    }
  }

  return servers;
}

/**
 * Sync MCP server configs into native formats for tools that support them.
 * Called as Phase 4 of the sync pipeline.
 *
 * For each enabled tool with a renderer:
 *  - Prefer the project-scoped path if the renderer provides one
 *  - Fall back to the user-scoped path if project is unset (Copilot CLI)
 *  - Skip duplicate writes when two renderer aliases resolve to the same
 *    file path (claude + claude-code both write `.mcp.json`)
 */
export async function syncToolMcpConfigs(
  projectRoot: string,
  servers: McpServerDefinition[],
  enabledTools: string[],
  options: { homeDir?: string } = {},
): Promise<McpSyncSummary> {
  if (servers.length === 0) {
    return { results: [], servers_loaded: 0 };
  }

  const home = options.homeDir ?? homedir();
  const results: McpSyncResult[] = [];
  const writtenPaths = new Set<string>();

  for (const tool of enabledTools) {
    const renderer = NATIVE_MCP_TOOLS[tool];
    if (!renderer) continue;

    // Choose path: project preferred, fall back to global. Tools without
    // a project path (Copilot CLI) write to global only.
    let configPath: string | null = null;
    let scope: "project" | "global" = "project";
    if (renderer.projectPath) {
      configPath = renderer.projectPath(projectRoot);
      scope = "project";
    } else if (renderer.globalPath) {
      configPath = renderer.globalPath(home);
      scope = "global";
    }
    if (!configPath) continue;

    if (writtenPaths.has(configPath)) {
      results.push({
        tool,
        path: configPath,
        scope,
        updated: false,
        created: false,
        skipped: true,
      });
      continue;
    }
    writtenPaths.add(configPath);

    const result = await writeMcpConfig(tool, configPath, scope, renderer, servers);
    results.push(result);
  }

  return { results, servers_loaded: servers.length };
}

/**
 * Render MCP server details as markdown for embedding in managed instruction
 * blocks. Used by tools without native MCP config (e.g. instructions-only
 * fallbacks for any tool not in `NATIVE_MCP_TOOLS`).
 */
export function renderMcpServersMarkdown(servers: McpServerDefinition[]): string[] {
  if (servers.length === 0) return [];

  const lines: string[] = [
    "",
    "## MCP server connection details",
    "",
    "Connect these MCP servers to enable xtctx continuity:",
    "",
  ];

  for (const server of servers) {
    lines.push(`### ${server.name}`);
    lines.push(`- Transport: ${server.transport ?? "stdio"}`);
    if (server.command) {
      lines.push(
        `- Command: \`${server.command}${
          server.args?.length ? " " + server.args.join(" ") : ""
        }\``,
      );
    }
    if (server.url) {
      lines.push(`- URL: ${server.url}`);
    }
    if (server.env && Object.keys(server.env).length > 0) {
      lines.push("- Environment variables:");
      for (const [key, value] of Object.entries(server.env)) {
        lines.push(`  - \`${key}=${value}\``);
      }
    }
    lines.push("");
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Generic writer + merge
// ---------------------------------------------------------------------------

async function writeMcpConfig(
  tool: string,
  configPath: string,
  scope: "project" | "global",
  renderer: McpRenderer,
  servers: McpServerDefinition[],
): Promise<McpSyncResult> {
  try {
    const format = renderer.format ?? "json";
    const rootKey = renderer.rootKey ?? "mcpServers";
    const buildEntry = renderer.buildEntry ?? defaultBuildEntry;

    let existing: Record<string, unknown> | null = null;
    let existingContent: string | null = null;
    try {
      existingContent = await readFile(configPath, "utf-8");
      existing = parseConfig(existingContent, format);
    } catch {
      // File doesn't exist or isn't parseable; treat as empty.
    }

    const serverEntries = buildServerEntries(servers, buildEntry);
    const merged = mergeUnderRootKey(existing, rootKey, serverEntries);
    const content = serializeConfig(merged, format);

    if (existingContent !== null && normalizeNewlines(existingContent) === normalizeNewlines(content)) {
      return {
        tool,
        path: configPath,
        scope,
        updated: false,
        created: false,
        skipped: true,
      };
    }

    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, content, "utf-8");

    return {
      tool,
      path: configPath,
      scope,
      updated: existing !== null,
      created: existing === null,
      skipped: false,
    };
  } catch (error) {
    return {
      tool,
      path: configPath,
      scope,
      updated: false,
      created: false,
      skipped: false,
      warning: `Failed to write MCP config: ${errorMessage(error)}`,
    };
  }
}

function parseConfig(raw: string, format: "json" | "toml"): Record<string, unknown> {
  if (format === "toml") {
    return parseToml(raw) as Record<string, unknown>;
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

function serializeConfig(
  value: Record<string, unknown>,
  format: "json" | "toml",
): string {
  if (format === "toml") {
    // @iarna/toml emits a final newline already; normalise to single trailing.
    return stringifyToml(value as Parameters<typeof stringifyToml>[0]).replace(/\n*$/, "\n");
  }
  return JSON.stringify(value, null, 2) + "\n";
}

function buildServerEntries(
  servers: McpServerDefinition[],
  buildEntry: (server: McpServerDefinition) => Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const server of servers) {
    result[server.name] = buildEntry(server);
  }
  return result;
}

function mergeUnderRootKey(
  existing: Record<string, unknown> | null,
  rootKey: string,
  serverEntries: Record<string, unknown>,
): Record<string, unknown> {
  if (!existing) {
    return { [rootKey]: serverEntries };
  }
  const existingEntries =
    isRecord(existing[rootKey]) ? (existing[rootKey] as Record<string, unknown>) : {};
  return {
    ...existing,
    [rootKey]: { ...existingEntries, ...serverEntries },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Per-tool entry builders
// ---------------------------------------------------------------------------

/**
 * Default Claude-Code-style entry shape.
 *
 *  { type: "stdio" | "sse" | "streamable-http", command, args, env, url }
 *
 * Used by Claude Code, Cursor, and (with rootKey override) VS Code Copilot.
 */
function defaultBuildEntry(server: McpServerDefinition): Record<string, unknown> {
  const entry: Record<string, unknown> = {};

  if (server.transport === "sse" || server.transport === "streamable-http") {
    entry.type = server.transport;
    if (server.url) entry.url = server.url;
  } else {
    entry.type = "stdio";
    entry.command = server.command;
    if (server.args?.length) entry.args = server.args;
  }

  if (server.env && Object.keys(server.env).length > 0) {
    entry.env = { ...server.env };
  }

  return entry;
}

/**
 * Codex TOML entry. No `type` field (stdio is implicit). Renders as:
 *
 *   [mcp_servers.xtctx]
 *   command = "npx"
 *   args = ["xtctx", "serve", "--mcp-only"]
 */
function buildCodexEntry(server: McpServerDefinition): Record<string, unknown> {
  const entry: Record<string, unknown> = {};

  if (server.transport === "sse" || server.transport === "streamable-http") {
    if (server.url) entry.url = server.url;
  } else {
    entry.command = server.command;
    if (server.args?.length) entry.args = server.args;
  }

  if (server.env && Object.keys(server.env).length > 0) {
    entry.env = { ...server.env };
  }

  return entry;
}

/**
 * Gemini CLI entry shape. Same as Codex (no `type` field) but JSON.
 *
 *   "mcpServers": {
 *     "xtctx": { "command": "npx", "args": [...] }
 *   }
 */
function buildGeminiEntry(server: McpServerDefinition): Record<string, unknown> {
  return buildCodexEntry(server);
}

/**
 * opencode entry shape (sst/opencode-ai).
 *
 *   "mcp": {
 *     "xtctx": {
 *       "type": "local",
 *       "command": ["npx", "xtctx", "serve", "--mcp-only"],
 *       "enabled": true
 *     }
 *   }
 *
 * Note that opencode's `command` is a combined array (executable + args),
 * env vars use the key `environment`, and remote servers use `type: "remote"`
 * + `url` + optional `headers`.
 */
function buildOpencodeEntry(server: McpServerDefinition): Record<string, unknown> {
  if (server.transport === "sse" || server.transport === "streamable-http") {
    const remote: Record<string, unknown> = {
      type: "remote",
      url: server.url ?? "",
      enabled: true,
    };
    if (server.env && Object.keys(server.env).length > 0) {
      remote.headers = { ...server.env };
    }
    return remote;
  }

  const command = [server.command, ...(server.args ?? [])];
  const local: Record<string, unknown> = {
    type: "local",
    command,
    enabled: true,
  };
  if (server.env && Object.keys(server.env).length > 0) {
    local.environment = { ...server.env };
  }
  return local;
}

/**
 * GitHub Copilot CLI entry shape (`~/.copilot/mcp-config.json`).
 *
 *   "mcpServers": {
 *     "xtctx": {
 *       "type": "local",
 *       "command": "npx",
 *       "args": ["xtctx", "serve", "--mcp-only"],
 *       "tools": ["*"]
 *     }
 *   }
 *
 * Copilot CLI uses `type: "local" | "http"` and a `tools` allowlist
 * (`["*"]` = allow all tools the server exposes). The defaults grant
 * full access; tighten by editing the file post-sync if needed.
 */
function buildCopilotCliEntry(server: McpServerDefinition): Record<string, unknown> {
  if (server.transport === "sse" || server.transport === "streamable-http") {
    const http: Record<string, unknown> = {
      type: "http",
      url: server.url ?? "",
      tools: ["*"],
    };
    if (server.env && Object.keys(server.env).length > 0) {
      http.env = { ...server.env };
    }
    return http;
  }

  const local: Record<string, unknown> = {
    type: "local",
    command: server.command,
    args: server.args ?? [],
    tools: ["*"],
  };
  if (server.env && Object.keys(server.env).length > 0) {
    local.env = { ...server.env };
  }
  return local;
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function normalizeMcpServer(name: string, raw: unknown): McpServerDefinition | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const obj = raw as Record<string, unknown>;
  const command = typeof obj.command === "string" ? obj.command : "";
  const url = typeof obj.url === "string" ? obj.url : undefined;

  if (!command && !url) return null;

  return {
    name: typeof obj.name === "string" ? obj.name : name,
    command,
    args: Array.isArray(obj.args)
      ? obj.args.filter((a): a is string => typeof a === "string")
      : undefined,
    env: isStringRecord(obj.env) ? obj.env : undefined,
    transport: isTransport(obj.transport) ? obj.transport : "stdio",
    url,
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((v) => typeof v === "string");
}

function isTransport(value: unknown): value is "stdio" | "sse" | "streamable-http" {
  return value === "stdio" || value === "sse" || value === "streamable-http";
}

function normalizeNewlines(input: string): string {
  return input.replace(/\r\n/g, "\n");
}
