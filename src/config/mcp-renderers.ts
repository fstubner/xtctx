import { join } from "node:path";
import type { ConfigFormat } from "./config-file-format.js";

/**
 * Everything xtctx knows about one specific tool's MCP config: where the file
 * lives, what format it is in, which key server entries hang off, and what one
 * entry looks like.
 *
 * Adding an eighth tool should be an edit to this file and nothing else, which
 * is why the reading, merging and writing of those files lives next door in
 * `mcp-config.ts` rather than here.
 */

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
  format?: ConfigFormat;
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
export const NATIVE_MCP_TOOLS: Record<string, McpRenderer> = {
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

export function isGlobalOnlyMcpTool(tool: string): boolean {
  const renderer = NATIVE_MCP_TOOLS[tool];
  return Boolean(renderer?.globalPath && !renderer.projectPath);
}

export function resolveConfigTarget(
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
export function defaultBuildEntry(server: McpServerDefinition): Record<string, unknown> {
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
