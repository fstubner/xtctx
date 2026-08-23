import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml, stringify as stringifyToml } from "@iarna/toml";
import { writeFileAtomic } from "../utils/atomic-file.js";
import { errorMessage } from "../utils/errors.js";

/**
 * MCP server definition rendered into each tool's native config format.
 * setup owns the xtctx definition directly so the project has one config path:
 * `.xtctx/config.yaml`.
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
  /** True when the config could not be read, parsed, or written at all. */
  failed?: boolean;
}

export interface McpSyncSummary {
  results: McpSyncResult[];
  servers_loaded: number;
}

export interface McpRemoveResult {
  tool: string;
  path: string;
  scope: "project" | "global";
  removed: boolean;
  skipped: boolean;
  warning?: string;
}

export interface McpRemoveSummary {
  results: McpRemoveResult[];
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
   *  - "mcpServers" for Claude Code / Cursor / Antigravity / Copilot CLI
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
  // Keep both aliases because older local setup files may refer to `claude`,
  // while the current scraper/tool id is `claude-code`.
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

  // Google Antigravity — JSON at `~/.gemini/antigravity/mcp_config.json`.
  // App-level config under the Gemini state directory; entries omit `type`.
  antigravity: {
    globalPath: (home) => join(home, ".gemini", "antigravity", "mcp_config.json"),
    buildEntry: buildAntigravityEntry,
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

export function isGlobalOnlyMcpTool(tool: string): boolean {
  const renderer = NATIVE_MCP_TOOLS[tool];
  return Boolean(renderer?.globalPath && !renderer.projectPath);
}

export interface McpWiringState {
  tool: string;
  path: string;
  scope: "project" | "global";
  /** The server entry is present under the tool's own root key. */
  wired: boolean;
  /**
   * The config file exists at all.
   *
   * Absent and present-but-empty mean different things: a global config that
   * was never written is a tool the user has not opted into, while one that
   * exists without our entry is wiring that has been lost.
   */
  configExists: boolean;
  /** Why it is not wired, when that is worth saying. */
  detail?: string;
}

/**
 * Is each tool actually wired to this server right now?
 *
 * `xtctx status` had no way to answer this: it inspected managed instruction
 * files and skill targets, so deleting `.mcp.json` outright left it reporting
 * that everything was fine while no agent could reach xtctx at all. Setup can
 * also legitimately decline to write a config — a commented TOML is left
 * alone — and that ends the same way unless something checks.
 */
export async function inspectMcpWiring(
  projectRoot: string,
  serverName: string,
  tools: string[],
  options: { homeDir?: string } = {},
): Promise<McpWiringState[]> {
  const home = options.homeDir ?? homedir();
  const states: McpWiringState[] = [];
  const seen = new Set<string>();

  for (const tool of tools) {
    const renderer = NATIVE_MCP_TOOLS[tool];
    if (!renderer) continue;

    const scope: "project" | "global" = renderer.projectPath ? "project" : "global";
    const configPath = renderer.projectPath
      ? renderer.projectPath(projectRoot)
      : renderer.globalPath?.(home);
    if (!configPath || seen.has(`${tool}:${configPath}`)) continue;
    seen.add(`${tool}:${configPath}`);

    let raw: string;
    try {
      raw = await readFile(configPath, "utf-8");
    } catch {
      states.push({ tool, path: configPath, scope, configExists: false, wired: false, detail: "config missing" });
      continue;
    }

    const format = renderer.format ?? "json";
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = parseConfig(raw, format);
    } catch {
      if (format === "json") {
        try {
          parsed = JSON.parse(stripJsonComments(raw)) as Record<string, unknown>;
        } catch {
          parsed = null;
        }
      }
    }

    if (!parsed) {
      states.push({ tool, path: configPath, scope, configExists: true, wired: false, detail: "config unparsable" });
      continue;
    }

    const rootKey = renderer.rootKey ?? "mcpServers";
    const root = parsed[rootKey];
    const wired = isRecord(root) && serverName in root;
    states.push({
      tool,
      path: configPath,
      scope,
      configExists: true,
      wired,
      detail: wired ? undefined : `no ${serverName} entry under ${rootKey}`,
    });
  }

  return states;
}

/**
 * Sync MCP server configs into native formats for tools that support them.
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

export async function removeMcpServerConfigs(
  projectRoot: string,
  serverName: string,
  tools: string[],
  options: { homeDir?: string } = {},
): Promise<McpRemoveSummary> {
  const home = options.homeDir ?? homedir();
  const results: McpRemoveResult[] = [];
  const writtenPaths = new Set<string>();

  for (const tool of tools) {
    const renderer = NATIVE_MCP_TOOLS[tool];
    if (!renderer) continue;

    const target = resolveConfigTarget(projectRoot, home, renderer);
    if (!target) continue;

    if (writtenPaths.has(target.path)) {
      results.push({
        tool,
        path: target.path,
        scope: target.scope,
        removed: false,
        skipped: true,
      });
      continue;
    }
    writtenPaths.add(target.path);

    results.push(await removeMcpConfig(tool, target.path, target.scope, renderer, serverName));
  }

  return { results };
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

    let existingContent: string | null = null;
    try {
      existingContent = await readFile(configPath, "utf-8");
    } catch (error) {
      if (!isMissingFile(error)) {
        return failedMcpSync(tool, configPath, scope, `Failed to read existing MCP config: ${errorMessage(error)}`);
      }
    }

    let existing: Record<string, unknown> | null = null;
    let hadComments = false;
    if (existingContent !== null) {
      try {
        existing = parseConfig(existingContent, format);
        // Parsing succeeding is not the same as rewriting being safe: the TOML
        // parser drops comments, so a file that reads fine still loses them.
        hadComments = format === "toml" && tomlHasComments(existingContent);
      } catch (error) {
        // VS Code-family configs are JSONC in practice: retry with comments
        // stripped before declaring the file unparsable.
        if (format === "json") {
          try {
            existing = JSON.parse(stripJsonComments(existingContent)) as Record<string, unknown>;
            hadComments = true;
          } catch {
            return failedMcpSync(
              tool,
              configPath,
              scope,
              `Failed to parse existing MCP config; leaving it unchanged: ${errorMessage(error)}`,
            );
          }
        } else {
          return failedMcpSync(
            tool,
            configPath,
            scope,
            `Failed to parse existing MCP config; leaving it unchanged: ${errorMessage(error)}`,
          );
        }
      }
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

    if (hadComments) {
      // Rewriting would destroy the user's comments. If our entries are
      // already present and identical the file is effectively up to date;
      // otherwise leave it alone and say what to do.
      if (existing && entriesUpToDate(existing, rootKey, serverEntries)) {
        return { tool, path: configPath, scope, updated: false, created: false, skipped: true };
      }
      return {
        tool,
        path: configPath,
        scope,
        updated: false,
        created: false,
        skipped: true,
        warning:
          `MCP config at ${configPath} contains comments, which xtctx will not rewrite. ` +
          `Add the xtctx server entry manually or remove the comments so xtctx can manage it.`,
      };
    }

    await writeFileAtomic(configPath, content);

    return {
      tool,
      path: configPath,
      scope,
      updated: existing !== null,
      created: existing === null,
      skipped: false,
    };
  } catch (error) {
    return failedMcpSync(tool, configPath, scope, `Failed to write MCP config: ${errorMessage(error)}`);
  }
}

function parseConfig(raw: string, format: "json" | "toml"): Record<string, unknown> {
  if (format === "toml") {
    return parseToml(raw) as Record<string, unknown>;
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

/**
 * Does this TOML carry comments we would destroy by rewriting it?
 *
 * `@iarna/toml` parses comments and drops them, so a config that parses
 * cleanly still loses every `#` line when re-serialised. That silently deleted
 * four hand-written comments from a codex config, reported as a successful
 * update. The JSONC path had a guard for exactly this; TOML never reached it
 * because it never failed to parse.
 *
 * A `#` inside a string is data, not a comment, so string state is tracked —
 * otherwise `tag = "release#1"` would make the file permanently unwritable.
 */
export function tomlHasComments(raw: string): boolean {
  // Multi-line strings are the reason this cannot be done line by line. An
  // earlier version reset string state at every newline, so line two of a
  // `"""` block was scanned as if it were outside a string — which both missed
  // a real comment after the block (setup then deleted it) and saw a comment
  // inside one (setup then refused to write a file that had none).
  let multiline: '"""' | "'''" | null = null;
  let inBasic = false;
  let inLiteral = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    if (multiline) {
      // Only the closing delimiter matters; `#` inside is content. Escapes
      // still apply in the basic form, so `\"""` does not close it.
      if (multiline === '"""' && !escaped && raw[index] === "\\") {
        escaped = true;
        continue;
      }
      if (!escaped && raw.startsWith(multiline, index)) {
        index += 2;
        multiline = null;
      }
      escaped = false;
      continue;
    }

    const char = raw[index];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (inBasic && char === "\\") {
      escaped = true;
      continue;
    }
    if (!inBasic && !inLiteral && (raw.startsWith('"""', index) || raw.startsWith("'''", index))) {
      multiline = raw.startsWith('"""', index) ? '"""' : "'''";
      index += 2;
      continue;
    }
    if (char === "\n") {
      // A single-line string cannot span lines, so an unterminated one ends
      // here rather than swallowing the rest of the file.
      inBasic = false;
      inLiteral = false;
      continue;
    }
    if (!inLiteral && char === '"') {
      inBasic = !inBasic;
      continue;
    }
    if (!inBasic && char === "'") {
      inLiteral = !inLiteral;
      continue;
    }
    if (!inBasic && !inLiteral && char === "#") {
      return true;
    }
  }

  return false;
}

/** Remove // and /* *\/ comments outside strings (JSONC tolerance). */
function stripJsonComments(raw: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      out += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && raw[index + 1] === "/") {
      while (index < raw.length && raw[index] !== "\n") index += 1;
      out += "\n";
      continue;
    }
    if (char === "/" && raw[index + 1] === "*") {
      index += 2;
      while (index < raw.length && !(raw[index] === "*" && raw[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }
    out += char;
  }
  return out;
}

function entriesUpToDate(
  existing: Record<string, unknown>,
  rootKey: string,
  serverEntries: Record<string, unknown>,
): boolean {
  const root = existing[rootKey];
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    return false;
  }
  return Object.entries(serverEntries).every(([name, entry]) =>
    isDeepStrictEqual((root as Record<string, unknown>)[name], entry),
  );
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

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT");
}

function failedMcpSync(
  tool: string,
  configPath: string,
  scope: "project" | "global",
  warning: string,
): McpSyncResult {
  return {
    tool,
    path: configPath,
    scope,
    updated: false,
    created: false,
    skipped: false,
    warning,
    failed: true,
  };
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
 *   args = ["-y", "xtctx"]
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
 * Antigravity MCP entry shape. Same as Codex (no `type` field) but JSON.
 *
 *   "mcpServers": {
 *     "xtctx": { "command": "npx", "args": [...] }
 *   }
 */
function buildAntigravityEntry(server: McpServerDefinition): Record<string, unknown> {
  return buildCodexEntry(server);
}

/**
 * opencode entry shape (sst/opencode-ai).
 *
 *   "mcp": {
 *     "xtctx": {
 *       "type": "local",
 *       "command": ["npx", "-y", "xtctx"],
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
 *       "args": ["-y", "xtctx"],
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

function normalizeNewlines(input: string): string {
  return input.replace(/\r\n/g, "\n");
}

async function removeMcpConfig(
  tool: string,
  configPath: string,
  scope: "project" | "global",
  renderer: McpRenderer,
  serverName: string,
): Promise<McpRemoveResult> {
  try {
    const format = renderer.format ?? "json";
    const rootKey = renderer.rootKey ?? "mcpServers";

    let existingContent: string;
    try {
      existingContent = await readFile(configPath, "utf-8");
    } catch {
      return {
        tool,
        path: configPath,
        scope,
        removed: false,
        skipped: true,
      };
    }

    const existing = parseConfig(existingContent, format);
    const existingEntries =
      isRecord(existing[rootKey]) ? { ...(existing[rootKey] as Record<string, unknown>) } : {};

    if (!(serverName in existingEntries)) {
      return {
        tool,
        path: configPath,
        scope,
        removed: false,
        skipped: true,
      };
    }

    delete existingEntries[serverName];
    const updated = { ...existing, [rootKey]: existingEntries };

    // If removing our entry leaves a project file that is nothing but an
    // empty xtctx container, setup created it and disconnect owns removing it
    // — leaving `{"mcp":{}}` behind is litter, not preservation. User-global
    // app configs are left in place: they belong to the tool, not to us.
    const onlyEmptyContainer =
      scope === "project" &&
      Object.keys(existingEntries).length === 0 &&
      Object.keys(updated).length === 1 &&
      Object.prototype.hasOwnProperty.call(updated, rootKey);
    if (onlyEmptyContainer) {
      await rm(configPath, { force: true });
      return { tool, path: configPath, scope, removed: true, skipped: false };
    }

    const content = serializeConfig(updated, format);

    if (normalizeNewlines(existingContent) !== normalizeNewlines(content)) {
      await writeFileAtomic(configPath, content);
    }

    return {
      tool,
      path: configPath,
      scope,
      removed: true,
      skipped: false,
    };
  } catch (error) {
    return {
      tool,
      path: configPath,
      scope,
      removed: false,
      skipped: false,
      warning: `Failed to remove MCP config: ${errorMessage(error)}`,
    };
  }
}

function resolveConfigTarget(
  projectRoot: string,
  home: string,
  renderer: McpRenderer,
): { path: string; scope: "project" | "global" } | null {
  if (renderer.projectPath) {
    return { path: renderer.projectPath(projectRoot), scope: "project" };
  }

  if (renderer.globalPath) {
    return { path: renderer.globalPath(home), scope: "global" };
  }

  return null;
}
