import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { writeFileAtomic } from "../utils/atomic-file.js";
import { errorMessage } from "../utils/errors.js";
import {
  parseConfig,
  serializeConfig,
  stripJsonComments,
  tomlHasComments,
} from "./config-file-format.js";
import {
  NATIVE_MCP_TOOLS,
  defaultBuildEntry,
  resolveConfigTarget,
  type McpRenderer,
  type McpServerDefinition,
} from "./mcp-renderers.js";

// Re-exported so callers and tests keep one import path for "MCP config":
// which tools are supported and how they are rendered lives in
// `mcp-renderers.ts`, the wire formats in `config-file-format.ts`, and this
// file owns reading, merging and writing an entry into a config on disk.
export {
  NATIVE_MCP_TOOLS,
  hasNativeMcpSupport,
  isGlobalOnlyMcpTool,
  resolveConfigTarget,
  type McpRenderer,
  type McpServerDefinition,
} from "./mcp-renderers.js";
export { tomlHasComments } from "./config-file-format.js";

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
  options: { homeDir?: string; globalServers?: McpServerDefinition[] } = {},
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

    // Project configs are contained by the project root; user-level ones
    // (Antigravity, Copilot CLI, global Codex) by the home directory they were
    // built from. Containing a global write by the project root would refuse a
    // perfectly legitimate write.
    // A machine-global config is not about this project, so it must not carry
    // a path into this project. Callers pass the published form for global
    // scope; without it a self-hosted checkout wrote its own `dist/` into a
    // file that applies to every directory for this user account.
    const result = await writeMcpConfig(
      tool,
      configPath,
      scope,
      renderer,
      scope === "global" ? (options.globalServers ?? servers) : servers,
      scope === "project" ? projectRoot : home,
    );
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

    results.push(
      await removeMcpConfig(
        tool,
        target.path,
        target.scope,
        renderer,
        serverName,
        target.scope === "project" ? projectRoot : home,
      ),
    );
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
  containWithin: string,
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

    await writeFileAtomic(configPath, content, { containWithin });

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

function normalizeNewlines(input: string): string {
  return input.replace(/\r\n/g, "\n");
}

async function removeMcpConfig(
  tool: string,
  configPath: string,
  scope: "project" | "global",
  renderer: McpRenderer,
  serverName: string,
  containWithin: string,
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
      await writeFileAtomic(configPath, content, { containWithin });
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
      warning: describeRemovalFailure(configPath, error),
    };
  }
}

/**
 * A parser error is not an explanation.
 *
 * A config carrying comments is the ordinary reason this fails, and `setup`
 * already says so in words the reader can act on. Disconnect answered the same
 * condition with `Expected property name or '}' in JSON at position 4`, which
 * says nothing about what to do. The two now agree.
 */
function describeRemovalFailure(configPath: string, error: unknown): string {
  const message = errorMessage(error);
  const looksLikeJsonSyntax = /JSON at position|Unexpected token|Expected property name/i.test(
    message,
  );
  if (looksLikeJsonSyntax) {
    return (
      `MCP config at ${configPath} could not be parsed, which usually means it contains ` +
      `comments — xtctx will not rewrite those. Remove the xtctx server entry manually ` +
      `(underlying error: ${message}).`
    );
  }
  return `Failed to remove MCP config: ${message}`;
}
