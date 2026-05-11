import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { syncToolMcpConfigs, type McpServerDefinition } from "./mcp-config.js";
import { SUPPORTED_TOOLS, type HookMode } from "../tools/sources.js";

const MARKERS = {
  begin: "<!-- xtctx:begin -->",
  end: "<!-- xtctx:end -->",
};

export interface SetupOptions {
  projectPath?: string;
  yes?: boolean;
  repair?: boolean;
  homeDir?: string;
}

export interface SetupResult {
  projectRoot: string;
  configPath: string;
  writes: Array<{ path: string; kind: string; changed: boolean }>;
  warnings: string[];
}

export interface PlannedSetupWrite {
  path: string;
  kind: string;
}

interface MemoryTarget {
  tool: string;
  path: string;
  hookMode: HookMode;
  prelude?: string;
}

export async function runSetup(options: SetupOptions = {}): Promise<SetupResult> {
  const result = await setupProject(options);
  printSetupResult(result);
  return result;
}

export async function setupProject(options: SetupOptions = {}): Promise<SetupResult> {
  const projectRoot = resolve(options.projectPath ?? process.cwd());
  const xtctxDir = join(projectRoot, ".xtctx");
  const stateDir = join(xtctxDir, "state");
  const configPath = join(xtctxDir, "config.yaml");
  const writes: SetupResult["writes"] = [];
  const warnings: string[] = [];

  if (options.repair) {
    await rm(join(xtctxDir, ".store"), { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
    await rm(join(xtctxDir, "tool-config"), { recursive: true, force: true });
    await rm(join(xtctxDir, "skills"), { recursive: true, force: true });
  }

  await mkdir(stateDir, { recursive: true });

  writes.push({
    path: configPath,
    kind: "config",
    changed: await writeIfChanged(configPath, renderProjectConfig(projectRoot)),
  });

  const serverDefinition = xtctxServerDefinition();
  const mcpSummary = await syncToolMcpConfigs(
    projectRoot,
    [serverDefinition],
    SUPPORTED_TOOLS.map((tool) => tool.id),
    options.homeDir ? { homeDir: options.homeDir } : {},
  );

  for (const file of mcpSummary.results) {
    writes.push({
      path: file.path,
      kind: `mcp:${file.tool}`,
      changed: file.updated || file.created,
    });
    if (file.warning) {
      warnings.push(file.warning);
    }
  }

  for (const target of memoryTargets(projectRoot)) {
    const block = renderManagedBlock({
      projectRoot,
      tool: target.tool,
      hookMode: target.hookMode,
      serverDefinition,
    });
    writes.push({
      path: target.path,
      kind: `memory:${target.tool}`,
      changed: await upsertManagedBlock(target.path, block, target.prelude),
    });
  }

  writes.push({
    path: join(projectRoot, ".claude", "hooks.json"),
    kind: "hook:claude-code",
    changed: await installClaudeHook(projectRoot),
  });

  return { projectRoot, configPath, writes, warnings };
}

export function describeSetupPlan(projectPath?: string): {
  projectRoot: string;
  writes: PlannedSetupWrite[];
} {
  const projectRoot = resolve(projectPath ?? process.cwd());
  const writes: PlannedSetupWrite[] = [
    { path: join(projectRoot, ".xtctx", "config.yaml"), kind: "config" },
    { path: join(projectRoot, ".mcp.json"), kind: "mcp:claude-code" },
    { path: join(projectRoot, ".cursor", "mcp.json"), kind: "mcp:cursor" },
    { path: join(projectRoot, ".vscode", "mcp.json"), kind: "mcp:copilot" },
    { path: join(projectRoot, ".codex", "config.toml"), kind: "mcp:codex" },
    { path: join(projectRoot, ".gemini", "settings.json"), kind: "mcp:gemini" },
    { path: join(projectRoot, "opencode.json"), kind: "mcp:opencode" },
    { path: join(projectRoot, "AGENTS.md"), kind: "memory:codex/opencode" },
    { path: join(projectRoot, "CLAUDE.md"), kind: "memory:claude-code" },
    { path: join(projectRoot, "GEMINI.md"), kind: "memory:gemini" },
    { path: join(projectRoot, ".cursor", "rules", "xtctx.mdc"), kind: "memory:cursor" },
    { path: join(projectRoot, ".github", "copilot-instructions.md"), kind: "memory:copilot" },
    { path: join(projectRoot, ".claude", "hooks.json"), kind: "hook:claude-code" },
  ];
  const home = process.env.USERPROFILE ?? process.env.HOME;
  if (home) {
    writes.push({ path: join(home, ".copilot", "mcp-config.json"), kind: "mcp:copilot-cli" });
    writes.push({
      path: join(home, ".gemini", "antigravity", "mcp_config.json"),
      kind: "mcp:antigravity",
    });
  }

  return { projectRoot, writes };
}


export async function inspectManagedFile(filePath: string): Promise<{
  exists: boolean;
  blockCount: number;
  staleReferences: string[];
}> {
  const content = await readUtf8IfExists(filePath);
  if (content === null) {
    return { exists: false, blockCount: 0, staleReferences: [] };
  }

  return {
    exists: true,
    blockCount: countManagedBlocks(content),
    staleReferences: findStaleReferences(content),
  };
}

export function xtctxServerDefinition(): McpServerDefinition {
  return {
    name: "xtctx",
    command: "npx",
    args: ["-y", "xtctx"],
    transport: "stdio",
  };
}

function renderProjectConfig(projectRoot: string): string {
  const config = {
    project: {
      root: projectRoot,
    },
    handoff: {
      mode: "raw-transcript-pointer",
      indexing: "on-demand",
      summaries: false,
    },
    mcp: {
      command: "npx",
      args: ["-y", "xtctx"],
    },
    tools: Object.fromEntries(
      SUPPORTED_TOOLS.map((tool) => [
        tool.id,
        {
          enabled: true,
          storePath: tool.defaultStorePath(),
          hook: tool.hookMode,
        },
      ]),
    ),
  };

  return stringifyYaml(config);
}

function memoryTargets(projectRoot: string): MemoryTarget[] {
  return [
    {
      tool: "codex",
      path: join(projectRoot, "AGENTS.md"),
      hookMode: "instruction-only",
    },
    {
      tool: "claude-code",
      path: join(projectRoot, "CLAUDE.md"),
      hookMode: "executable",
    },
    {
      tool: "gemini",
      path: join(projectRoot, "GEMINI.md"),
      hookMode: "instruction-only",
    },
    {
      tool: "cursor",
      path: join(projectRoot, ".cursor", "rules", "xtctx.mdc"),
      hookMode: "instruction-only",
      prelude:
        "---\ndescription: xtctx cross-tool handoff\nglobs: \"**/*\"\nalwaysApply: true\n---\n\n",
    },
    {
      tool: "copilot",
      path: join(projectRoot, ".github", "copilot-instructions.md"),
      hookMode: "instruction-only",
    },
  ];
}

function renderManagedBlock(input: {
  projectRoot: string;
  tool: string;
  hookMode: HookMode;
  serverDefinition: McpServerDefinition;
}): string {
  const command = [input.serverDefinition.command, ...(input.serverDefinition.args ?? [])].join(" ");
  return [
    MARKERS.begin,
    "Generated by xtctx setup. Do not edit inside this block.",
    "",
    "# xtctx Handoff",
    "",
    `Tool: ${input.tool}`,
    `Project root: ${input.projectRoot}`,
    `Integration mode: ${input.hookMode}`,
    "",
    "xtctx is configured for cross-tool handoff in this project.",
    "Do not rely on this block for a generated summary; raw local transcripts are authoritative.",
    "",
    "## Session Retrieval",
    "- Call `xtctx_recent_sessions` to list recent local sessions.",
    "- Call `xtctx_session_detail` with a `session_ref` for the raw transcript messages.",
    "- Call `xtctx_search_sessions` only when you need semantic or keyword search across chronological transcript windows.",
    "- Use `xtctx_continuity_status` for wiring and freshness diagnostics.",
    "",
    "## MCP",
    `- Command: \`${command}\``,
    "- Transport: stdio",
    "",
    "## Notes",
    "- Indexing is on-demand from MCP calls and real startup hooks.",
    "- There is no xtctx daemon, API server, dashboard, durable memory, or generated brief.",
    "- Content outside this managed block is preserved.",
    MARKERS.end,
    "",
  ].join("\n");
}

async function installClaudeHook(projectRoot: string): Promise<boolean> {
  const hooksPath = join(projectRoot, ".claude", "hooks.json");
  const command = `npx -y xtctx --hook session-start --tool claude-code --project "${projectRoot.replace(/"/g, '\\"')}"`;
  const existing = await readJsonIfExists(hooksPath);
  const root = isRecord(existing) ? existing : {};
  const hooks = isRecord(root.hooks) ? root.hooks : {};
  const sessionStart = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : [];
  const alreadyInstalled = sessionStart.some(
    (entry) => isRecord(entry) && typeof entry.command === "string" && entry.command.includes("xtctx --hook session-start"),
  );

  if (alreadyInstalled) {
    return false;
  }

  hooks.SessionStart = [...sessionStart, { type: "command", command }];
  root.hooks = hooks;
  return writeIfChanged(hooksPath, JSON.stringify(root, null, 2) + "\n");
}

async function upsertManagedBlock(
  filePath: string,
  block: string,
  prelude = "",
): Promise<boolean> {
  const existing = await readUtf8IfExists(filePath);
  const repaired = existing ? removeManagedBlocks(existing).trimEnd() : "";
  const prefix = prelude && !repaired.startsWith(prelude.trimEnd()) ? prelude : "";
  const separator = repaired.length > 0 ? "\n\n" : "";
  const content = `${prefix}${repaired}${separator}${block}`;
  return writeIfChanged(filePath, content);
}

function removeManagedBlocks(content: string): string {
  const normalized = normalizeNewlines(content);
  const pattern = new RegExp(
    `${escapeRegExp(MARKERS.begin)}[\\s\\S]*?${escapeRegExp(MARKERS.end)}\\n?`,
    "g",
  );
  return normalized.replace(pattern, "").replace(/\n{3,}/g, "\n\n");
}

function countManagedBlocks(content: string): number {
  const pattern = new RegExp(
    `${escapeRegExp(MARKERS.begin)}[\\s\\S]*?${escapeRegExp(MARKERS.end)}`,
    "g",
  );
  return content.match(pattern)?.length ?? 0;
}

function findStaleReferences(content: string): string[] {
  const stale: Array<{ label: string; pattern: RegExp }> = [
    { label: "xtctx serve", pattern: /\bxtctx\s+serve\b/ },
    { label: "xtctx_search", pattern: /\bxtctx_search\b/ },
    { label: "xtctx_project_knowledge", pattern: /\bxtctx_project_knowledge\b/ },
    { label: "xtctx_save_decision", pattern: /\bxtctx_save_decision\b/ },
    { label: "xtctx_save_error_solution", pattern: /\bxtctx_save_error_solution\b/ },
    { label: "xtctx_save_faq", pattern: /\bxtctx_save_faq\b/ },
    { label: "xtctx_last_session_brief", pattern: /\bxtctx_last_session_brief\b/ },
  ];
  return stale.filter((value) => value.pattern.test(content)).map((value) => value.label);
}

async function writeIfChanged(filePath: string, content: string): Promise<boolean> {
  const normalized = normalizeNewlines(content);
  const existing = await readUtf8IfExists(filePath);
  if (existing !== null && normalizeNewlines(existing) === normalized) {
    return false;
  }

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, normalized, "utf-8");
  return true;
}

async function readUtf8IfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

async function readJsonIfExists(filePath: string): Promise<unknown> {
  const raw = await readUtf8IfExists(filePath);
  if (raw === null) {
    return null;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function printSetupResult(result: SetupResult): void {
  const changed = result.writes.filter((write) => write.changed).length;
  process.stdout.write(`xtctx setup complete (${changed} changed, ${result.writes.length - changed} unchanged)\n`);
  process.stdout.write(`Project: ${result.projectRoot}\n`);
  for (const write of result.writes) {
    const marker = write.changed ? "updated" : "ok";
    process.stdout.write(`  ${marker.padEnd(7)} ${write.kind} ${write.path}\n`);
  }
  for (const warning of result.warnings) {
    process.stdout.write(`  warning ${warning}\n`);
  }
}

function normalizeNewlines(input: string): string {
  return input.replace(/\r\n/g, "\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
