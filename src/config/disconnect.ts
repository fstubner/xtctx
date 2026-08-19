import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "../utils/atomic-file.js";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { removeMcpServerConfigs } from "./mcp-config.js";
import { BUILT_IN_SKILL_ID, removeSyncedSkillsForTools } from "./skills.js";
import { SUPPORTED_TOOLS, getToolDefinition, type ToolId } from "../tools/sources.js";

const MARKERS = {
  begin: "<!-- xtctx:begin -->",
  end: "<!-- xtctx:end -->",
};

const TOOL_ALIASES: Record<string, ToolId> = {
  claude: "claude-code",
  "claude_code": "claude-code",
  "claude-code": "claude-code",
  cursor: "cursor",
  codex: "codex",
  copilot: "copilot",
  "github-copilot": "copilot",
  antigravity: "antigravity",
  opencode: "opencode",
  "open-code": "opencode",
  "copilot-cli": "copilot-cli",
  "github-copilot-cli": "copilot-cli",
};

export interface DisconnectOptions {
  projectPath?: string;
  tool?: string;
  all?: boolean;
  homeDir?: string;
}

export interface DisconnectResult {
  projectRoot: string;
  tools: ToolId[];
  writes: Array<{ path: string; kind: string; changed: boolean; note?: string }>;
  warnings: string[];
}

export interface PlannedDisconnectWrite {
  path: string;
  kind: string;
  note?: string;
}

export function describeDisconnectPlan(options: DisconnectOptions = {}): {
  projectRoot: string;
  tools: ToolId[];
  writes: PlannedDisconnectWrite[];
  warnings: string[];
} {
  const projectRoot = resolve(options.projectPath ?? process.cwd());
  const tools = resolveToolIds(options);
  const writes: PlannedDisconnectWrite[] = [
    { path: join(projectRoot, ".xtctx", "config.yaml"), kind: "config" },
  ];
  const warnings: string[] = [];

  for (const tool of tools) {
    const definition = getToolDefinition(tool);
    if (!definition) continue;

    writes.push(...plannedMcpWrites(projectRoot, tool, options.homeDir));

    if (tool === "claude-code") {
      writes.push({ path: join(projectRoot, ".claude", "settings.json"), kind: "hook:claude-code" });
      writes.push({ path: join(projectRoot, ".claude", "hooks.json"), kind: "hook:claude-code" });
    }

    writes.push(...plannedSkillWrites(projectRoot, tool));

    if (tool === "antigravity") {
      warnings.push(
        "Antigravity stores MCP config at app level, so disconnect removes xtctx from Antigravity globally.",
      );
    }
  }

  for (const path of memoryPathsToDisconnect(projectRoot, tools, options.all === true)) {
    writes.push({ path, kind: "memory" });
  }

  return { projectRoot, tools, writes: dedupePlannedWrites(writes), warnings };
}

export async function disconnectProject(options: DisconnectOptions = {}): Promise<DisconnectResult> {
  const projectRoot = resolve(options.projectPath ?? process.cwd());
  const tools = resolveToolIds(options);
  const warnings: string[] = [];
  const writes: DisconnectResult["writes"] = [];
  const configPath = join(projectRoot, ".xtctx", "config.yaml");

  writes.push({
    path: configPath,
    kind: "config",
    changed: await disableToolsInProjectConfig(configPath, tools),
  });

  const mcpSummary = await removeMcpServerConfigs(projectRoot, "xtctx", tools, options.homeDir ? { homeDir: options.homeDir } : {});
  for (const result of mcpSummary.results) {
    writes.push({
      path: result.path,
      kind: `mcp:${result.tool}`,
      changed: result.removed,
      note: result.scope === "global" ? "global config" : undefined,
    });
    if (result.warning) warnings.push(result.warning);
  }

  for (const path of memoryPathsToDisconnect(projectRoot, tools, options.all === true)) {
    writes.push({
      path,
      kind: "memory",
      changed: await removeManagedBlocksFromFile(path),
    });
  }

  writes.push(...(await removeSyncedSkillsForTools(projectRoot, tools)));

  if (tools.includes("claude-code")) {
    const settingsPath = join(projectRoot, ".claude", "settings.json");
    writes.push({
      path: settingsPath,
      kind: "hook:claude-code",
      changed: await removeClaudeHookFromSettings(settingsPath),
    });
    const legacyHooksPath = join(projectRoot, ".claude", "hooks.json");
    writes.push({
      path: legacyHooksPath,
      kind: "hook:claude-code",
      changed: await removeClaudeHook(legacyHooksPath),
      note: "legacy hook file",
    });
  }

  if (tools.includes("antigravity")) {
    warnings.push(
      "Antigravity MCP config is app-level; xtctx was removed from the Antigravity config for this user account.",
    );
  }

  return { projectRoot, tools, writes, warnings };
}

export function printDisconnectResult(result: DisconnectResult): void {
  const changed = result.writes.filter((write) => write.changed).length;
  process.stdout.write(`xtctx disconnect complete (${changed} changed, ${result.writes.length - changed} unchanged)\n`);
  process.stdout.write(`Project: ${result.projectRoot}\n`);
  process.stdout.write(`Tools: ${result.tools.join(", ")}\n`);
  for (const write of result.writes) {
    const marker = write.changed ? "removed" : "ok";
    const note = write.note ? ` (${write.note})` : "";
    process.stdout.write(`  ${marker.padEnd(8)} ${write.kind} ${write.path}${note}\n`);
  }
  for (const warning of result.warnings) {
    process.stdout.write(`  warning ${warning}\n`);
  }
}

function resolveToolIds(options: DisconnectOptions): ToolId[] {
  if (options.all && options.tool) {
    throw new Error("Use either a tool name or --all, not both.");
  }

  if (options.all) {
    return SUPPORTED_TOOLS.map((tool) => tool.id);
  }

  if (!options.tool) {
    throw new Error(`Choose a tool to disconnect, or use --all. Supported tools: ${supportedToolList()}`);
  }

  const canonical = TOOL_ALIASES[options.tool.trim().toLowerCase()];
  if (!canonical || !getToolDefinition(canonical)) {
    throw new Error(`Unknown tool "${options.tool}". Supported tools: ${supportedToolList()}`);
  }

  return [canonical];
}

function supportedToolList(): string {
  return SUPPORTED_TOOLS.map((tool) => tool.id).join(", ");
}

async function disableToolsInProjectConfig(configPath: string, tools: ToolId[]): Promise<boolean> {
  const raw = await readUtf8IfExists(configPath);
  if (raw === null) {
    return false;
  }

  const parsed = parseYaml(raw) as unknown;
  const config = isRecord(parsed) ? parsed : {};
  const currentTools = isRecord(config.tools) ? { ...config.tools } : {};
  let changed = false;

  for (const tool of tools) {
    const existing = isRecord(currentTools[tool]) ? { ...(currentTools[tool] as Record<string, unknown>) } : {};
    if (existing.enabled !== false) {
      existing.enabled = false;
      changed = true;
    }
    currentTools[tool] = existing;
  }

  if (!changed) {
    return false;
  }

  config.tools = currentTools;
  await writeFileAtomic(configPath, stringifyYaml(config));
  return true;
}

function memoryPathsToDisconnect(projectRoot: string, tools: ToolId[], all: boolean): string[] {
  const targetTools = new Set(tools);
  const sharedPaths = new Map<string, ToolId[]>();

  for (const tool of SUPPORTED_TOOLS) {
    for (const path of tool.memoryTargets) {
      const absolute = join(projectRoot, path);
      sharedPaths.set(absolute, [...(sharedPaths.get(absolute) ?? []), tool.id]);
    }
  }

  const paths: string[] = [];
  for (const [path, owners] of sharedPaths.entries()) {
    const ownerSet = new Set(owners);
    const selectedOwners = owners.filter((owner) => targetTools.has(owner));
    if (selectedOwners.length === 0) continue;
    if (!all && [...ownerSet].some((owner) => !targetTools.has(owner))) continue;
    paths.push(path);
  }

  return paths;
}

function plannedMcpWrites(projectRoot: string, tool: ToolId, homeDir?: string): PlannedDisconnectWrite[] {
  const home = homeDir ?? process.env.USERPROFILE ?? process.env.HOME;
  const writes: PlannedDisconnectWrite[] = [];

  switch (tool) {
    case "claude-code":
      writes.push({ path: join(projectRoot, ".mcp.json"), kind: "mcp:claude-code" });
      break;
    case "cursor":
      writes.push({ path: join(projectRoot, ".cursor", "mcp.json"), kind: "mcp:cursor" });
      break;
    case "copilot":
      writes.push({ path: join(projectRoot, ".vscode", "mcp.json"), kind: "mcp:copilot" });
      break;
    case "codex":
      writes.push({ path: join(projectRoot, ".codex", "config.toml"), kind: "mcp:codex" });
      break;
    case "opencode":
      writes.push({ path: join(projectRoot, "opencode.json"), kind: "mcp:opencode" });
      break;
    case "antigravity":
      if (home) {
        writes.push({
          path: join(home, ".gemini", "antigravity", "mcp_config.json"),
          kind: "mcp:antigravity",
          note: "global config",
        });
      }
      break;
    case "copilot-cli":
      if (home) {
        writes.push({
          path: join(home, ".copilot", "mcp-config.json"),
          kind: "mcp:copilot-cli",
          note: "global config",
        });
      }
      break;
    default: {
      const _exhaustive: never = tool;
      void _exhaustive;
      break;
    }
  }

  return writes;
}

function plannedSkillWrites(projectRoot: string, tool: ToolId): PlannedDisconnectWrite[] {
  const definition = getToolDefinition(tool);
  const capability = definition?.skillSync;
  if (!capability || capability.mode === "managed-block" || capability.mode === "unsupported") {
    return [];
  }

  const targetPath = capability.targetPath?.(projectRoot, BUILT_IN_SKILL_ID);
  if (!targetPath) {
    return [];
  }

  const writes: PlannedDisconnectWrite[] = [{ path: targetPath, kind: `skill:${tool}:${BUILT_IN_SKILL_ID}` }];
  return writes;
}

async function removeManagedBlocksFromFile(filePath: string): Promise<boolean> {
  const existing = await readUtf8IfExists(filePath);
  if (existing === null) {
    return false;
  }

  const repaired = removeManagedBlocks(existing).trimEnd();
  if (normalizeNewlines(existing).trimEnd() === repaired) {
    return false;
  }

  await writeFileAtomic(filePath, repaired ? `${repaired}\n` : "");
  return true;
}

/** Strip xtctx SessionStart matcher groups from .claude/settings.json. */
async function removeClaudeHookFromSettings(settingsPath: string): Promise<boolean> {
  const raw = await readUtf8IfExists(settingsPath);
  if (raw === null) {
    return false;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return false;
  }

  if (!isRecord(parsed) || !isRecord(parsed.hooks)) {
    return false;
  }

  const sessionStart = Array.isArray(parsed.hooks.SessionStart) ? parsed.hooks.SessionStart : [];
  const kept = sessionStart
    .map((group) => {
      if (!isRecord(group) || !Array.isArray(group.hooks)) {
        return group;
      }
      const hooks = group.hooks.filter(
        (hook) =>
          !isRecord(hook) ||
          typeof hook.command !== "string" ||
          !hook.command.includes("xtctx --hook session-start"),
      );
      return hooks.length === group.hooks.length ? group : { ...group, hooks };
    })
    .filter(
      (group) => !isRecord(group) || !Array.isArray(group.hooks) || group.hooks.length > 0,
    );

  if (JSON.stringify(kept) === JSON.stringify(sessionStart)) {
    return false;
  }

  parsed.hooks.SessionStart = kept;
  await writeFileAtomic(settingsPath, JSON.stringify(parsed, null, 2) + "\n");
  return true;
}

async function removeClaudeHook(hooksPath: string): Promise<boolean> {
  const raw = await readUtf8IfExists(hooksPath);
  if (raw === null) {
    return false;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return false;
  }

  if (!isRecord(parsed) || !isRecord(parsed.hooks)) {
    return false;
  }

  const sessionStart = Array.isArray(parsed.hooks.SessionStart) ? parsed.hooks.SessionStart : [];
  const nextSessionStart = sessionStart.filter(
    (entry) => !isRecord(entry) ||
      typeof entry.command !== "string" ||
      !entry.command.includes("xtctx --hook session-start"),
  );

  if (nextSessionStart.length === sessionStart.length) {
    return false;
  }

  parsed.hooks.SessionStart = nextSessionStart;
  await writeFileAtomic(hooksPath, JSON.stringify(parsed, null, 2) + "\n");
  return true;
}

function removeManagedBlocks(content: string): string {
  const normalized = normalizeNewlines(content);
  const pattern = new RegExp(
    `${escapeRegExp(MARKERS.begin)}[\\s\\S]*?${escapeRegExp(MARKERS.end)}\\n?`,
    "g",
  );
  const parts = normalized.split(pattern);
  if (parts.length === 1) {
    return normalized;
  }

  // Collapse whitespace only at the splice seams — never inside user
  // content, which the managed block promises to preserve.
  let result = parts[0];
  for (let index = 1; index < parts.length; index += 1) {
    const left = result.replace(/\n+$/, "");
    const right = parts[index].replace(/^\n+/, "");
    if (!left) {
      result = right;
    } else if (!right) {
      result = left;
    } else {
      result = `${left}\n\n${right}`;
    }
  }
  return result;
}

async function readUtf8IfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
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

function dedupePlannedWrites(writes: PlannedDisconnectWrite[]): PlannedDisconnectWrite[] {
  const seen = new Set<string>();
  const result: PlannedDisconnectWrite[] = [];
  for (const write of writes) {
    const key = `${write.kind}\0${write.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(write);
  }
  return result;
}
