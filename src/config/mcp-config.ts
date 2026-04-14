import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { errorMessage } from "../utils/errors.js";

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
 * Tools with native MCP configuration formats.
 * Other tools receive MCP connection details embedded in their managed block.
 */
const NATIVE_MCP_TOOLS: Record<
  string,
  (projectRoot: string) => string
> = {
  claude: (root) => join(root, ".mcp.json"),
  "claude-code": (root) => join(root, ".mcp.json"),
  cursor: (root) => join(root, ".cursor", "mcp.json"),
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
 */
export async function syncToolMcpConfigs(
  projectRoot: string,
  servers: McpServerDefinition[],
  enabledTools: string[],
): Promise<McpSyncSummary> {
  if (servers.length === 0) {
    return { results: [], servers_loaded: 0 };
  }

  const results: McpSyncResult[] = [];
  const written = new Set<string>();

  for (const tool of enabledTools) {
    const pathFn = NATIVE_MCP_TOOLS[tool];
    if (!pathFn) continue;

    const configPath = pathFn(projectRoot);
    // claude and claude-code share the same path; don't double-write
    if (written.has(configPath)) {
      results.push({ tool, path: configPath, updated: false, created: false, skipped: true });
      continue;
    }
    written.add(configPath);

    const result = await writeMcpConfig(tool, configPath, servers);
    results.push(result);
  }

  return { results, servers_loaded: servers.length };
}

/**
 * Render MCP server details as markdown for embedding in managed instruction blocks.
 * Used by tools without native MCP config (Codex, Copilot, Gemini).
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
      lines.push(`- Command: \`${server.command}${server.args?.length ? " " + server.args.join(" ") : ""}\``);
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

async function writeMcpConfig(
  tool: string,
  configPath: string,
  servers: McpServerDefinition[],
): Promise<McpSyncResult> {
  try {
    let existing: Record<string, unknown> | null = null;
    try {
      const raw = await readFile(configPath, "utf-8");
      existing = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // File doesn't exist or isn't valid JSON
    }

    const mcpServers = buildMcpServersObject(servers);
    const merged = mergeExistingConfig(existing, mcpServers);
    const content = JSON.stringify(merged, null, 2) + "\n";

    let existingContent: string | null = null;
    try {
      existingContent = await readFile(configPath, "utf-8");
    } catch {
      // File doesn't exist
    }

    if (existingContent !== null && normalizeNewlines(existingContent) === normalizeNewlines(content)) {
      return { tool, path: configPath, updated: false, created: false, skipped: true };
    }

    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, content, "utf-8");

    return {
      tool,
      path: configPath,
      updated: existing !== null,
      created: existing === null,
      skipped: false,
    };
  } catch (error) {
    return {
      tool,
      path: configPath,
      updated: false,
      created: false,
      skipped: false,
      warning: `Failed to write MCP config: ${errorMessage(error)}`,
    };
  }
}

function buildMcpServersObject(
  servers: McpServerDefinition[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const server of servers) {
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

    result[server.name] = entry;
  }

  return result;
}

function mergeExistingConfig(
  existing: Record<string, unknown> | null,
  mcpServers: Record<string, unknown>,
): Record<string, unknown> {
  if (!existing) {
    return { mcpServers };
  }

  const existingServers = (existing.mcpServers ?? {}) as Record<string, unknown>;
  return {
    ...existing,
    mcpServers: {
      ...existingServers,
      ...mcpServers,
    },
  };
}

function normalizeMcpServer(name: string, raw: unknown): McpServerDefinition | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const obj = raw as Record<string, unknown>;
  const command = typeof obj.command === "string" ? obj.command : "";
  const url = typeof obj.url === "string" ? obj.url : undefined;

  if (!command && !url) return null;

  return {
    name: typeof obj.name === "string" ? obj.name : name,
    command,
    args: Array.isArray(obj.args) ? obj.args.filter((a): a is string => typeof a === "string") : undefined,
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
