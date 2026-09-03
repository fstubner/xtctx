import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { writeFileAtomic } from "../utils/atomic-file.js";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { NATIVE_MCP_TOOLS, removeMcpServerConfigs, resolveConfigTarget } from "./mcp-config.js";
import { BUILT_IN_SKILL_ID, removeSyncedSkillsForTools } from "./skills.js";
import { SUPPORTED_TOOLS, getToolDefinition, type ToolId } from "../tools/sources.js";
import { removeClaudeHook, removeClaudeHookFromSettings } from "./claude-settings.js";
import { removeManagedBlocksFromFile } from "./instruction-blocks.js";
import {
  directoryIsEmpty,
  isRecord,
  pathExists,
  pruneEmptyParents,
  readUtf8IfExists,
  removeIfPresent,
} from "./file-io.js";

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
  /**
   * Also remove xtctx from the Antigravity and Copilot CLI configs.
   *
   * Those two files are machine-global: they hold one xtctx entry for every
   * project on the machine, not one per project, so there is nothing
   * project-scoped in them to remove. A project disconnect used to empty them
   * anyway — observed live, both went to `{"mcpServers": {}}` after
   * disconnecting a throwaway repo, and every other project lost xtctx in
   * those clients. Now it takes this flag, the mirror of the one `setup`
   * writes them under.
   */
  globalMcp?: boolean;
  homeDir?: string;
}

/** Tools whose MCP config is one file for the whole user account. */
const GLOBAL_MCP_TOOLS: ReadonlySet<ToolId> = new Set<ToolId>(["antigravity", "copilot-cli"]);

const GLOBAL_MCP_LEFT_IN_PLACE =
  "Antigravity and Copilot CLI read one MCP config for every project on this machine, " +
  "so their xtctx entries were left in place. Run `xtctx disconnect --all --global-mcp` " +
  "to remove xtctx from those clients too.";

export interface DisconnectResult {
  projectRoot: string;
  tools: ToolId[];
  /**
   * False when the project carried no xtctx footprint, so nothing was
   * disconnected. Callers use this to avoid reporting removals that did not
   * happen; see the guard in `disconnectProject`.
   */
  configured: boolean;
  writes: Array<{
    path: string;
    kind: string;
    changed: boolean;
    /** What happened to the file. Defaults to "removed" for real removals. */
    action?: "removed" | "updated";
    note?: string;
  }>;
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

    if (!GLOBAL_MCP_TOOLS.has(tool) || options.globalMcp) {
      writes.push(...plannedMcpWrites(projectRoot, tool, options.homeDir));
    }

    if (tool === "claude-code") {
      writes.push({ path: join(projectRoot, ".claude", "settings.json"), kind: "hook:claude-code" });
      writes.push({ path: join(projectRoot, ".claude", "hooks.json"), kind: "hook:claude-code" });
    }

    writes.push(...plannedSkillWrites(projectRoot, tool));

    if (options.globalMcp && tool === "antigravity") {
      warnings.push(
        "Antigravity stores MCP config at app level, so --global-mcp removes xtctx from Antigravity for every project on this machine.",
      );
    }

    if (options.globalMcp && tool === "copilot-cli") {
      warnings.push(
        "Copilot CLI stores MCP config at user level, so --global-mcp removes xtctx from Copilot CLI for every project on this machine.",
      );
    }
  }

  if (!options.globalMcp && tools.some((tool) => GLOBAL_MCP_TOOLS.has(tool))) {
    warnings.push(GLOBAL_MCP_LEFT_IN_PLACE);
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

  // Refuse to do anything to a project that was never set up.
  //
  // Disconnect is project-scoped except for one machine-wide effect:
  // Antigravity keeps its MCP config at app level, so removing xtctx from it
  // removes it for every project. That is correct when this project was
  // configured, and it is warned about. Running in a directory that never had
  // xtctx — a `cd` to the wrong place — emptied the user's global Antigravity
  // config anyway, for a project with nothing to disconnect.
  //
  // The global config holds no per-project entry, so it cannot say which
  // project configured it. The project's own footprint is the only signal
  // available, which is what makes the destructive path conditional on there
  // being something to destroy.
  if (!(await hasXtctxFootprint(projectRoot))) {
    return {
      projectRoot,
      tools,
      configured: false,
      writes: [],
      warnings: [
        `${projectRoot} is not configured for xtctx — nothing to disconnect. ` +
          "No project or global config was changed.",
      ],
    };
  }

  writes.push({
    path: configPath,
    kind: "config",
    // config.yaml is rewritten with the tools disabled, never deleted — it is
    // the record that xtctx was disconnected.
    action: "updated",
    changed: await disableToolsInProjectConfig(configPath, tools, projectRoot),
  });

  const mcpTools = options.globalMcp ? tools : tools.filter((tool) => !GLOBAL_MCP_TOOLS.has(tool));
  const mcpSummary = await removeMcpServerConfigs(projectRoot, "xtctx", mcpTools, options.homeDir ? { homeDir: options.homeDir } : {});
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
      changed: await removeManagedBlocksFromFile(path, projectRoot),
    });
  }

  writes.push(...(await removeSyncedSkillsForTools(projectRoot, tools)));

  if (options.all === true) {
    // Nothing is left managing skills, so the synced source setup wrote is
    // xtctx's own scaffolding, not user content.
    writes.push({
      path: join(projectRoot, ".xtctx", "skills"),
      kind: "skill-source",
      changed: await removeIfPresent(join(projectRoot, ".xtctx", "skills")),
    });

    // The ignore file only goes when the index it protects has gone too.
    // Transcript data under .xtctx/state is deliberately untouched, and that
    // index holds raw conversation text — so removing its ignore rule while
    // leaving it in place hands the user a repo whose next `git add` commits
    // their transcripts. The two are removed together or not at all.
    //
    // Judged on what the directory holds, not on whether it exists: `setup`
    // always creates it, so an existence check made the removal unreachable
    // and reported "still holds the transcript index" over an empty directory.
    const stateDir = join(projectRoot, ".xtctx", "state");
    const gitignorePath = join(projectRoot, ".xtctx", ".gitignore");
    if (await directoryIsEmpty(stateDir)) {
      writes.push({
        path: gitignorePath,
        kind: "gitignore",
        changed: await removeIfPresent(gitignorePath),
      });
    } else {
      writes.push({
        path: gitignorePath,
        kind: "gitignore",
        changed: false,
        note: "kept: .xtctx/state still holds the transcript index",
      });
    }
  }

  if (tools.includes("claude-code")) {
    const settingsPath = join(projectRoot, ".claude", "settings.json");
    writes.push({
      path: settingsPath,
      kind: "hook:claude-code",
      changed: await removeClaudeHookFromSettings(settingsPath, projectRoot),
    });
    const legacyHooksPath = join(projectRoot, ".claude", "hooks.json");
    writes.push({
      path: legacyHooksPath,
      kind: "hook:claude-code",
      changed: await removeClaudeHook(legacyHooksPath, projectRoot),
      note: "legacy hook file",
    });
  }

  if (tools.some((tool) => GLOBAL_MCP_TOOLS.has(tool))) {
    warnings.push(
      options.globalMcp
        ? "Antigravity and Copilot CLI MCP configs are machine-global; xtctx was removed from them for this user account."
        : GLOBAL_MCP_LEFT_IN_PLACE,
    );
  }

  // Files are removed by several different paths above, so pruning happens
  // once at the end over every write path.
  //
  // Not gated on `changed`: several removal paths report false even when they
  // deleted something. The guards are that the directory is empty and that it
  // lies strictly inside the project — a directory holding anything else, or
  // the project root itself, is never touched.
  //
  // Deepest first, so a nested directory is gone before its parent is judged.
  const parents = writes
    .map((write) => write.path)
    .sort((left, right) => right.split(/[\\/]/).length - left.split(/[\\/]/).length);
  for (const path of parents) {
    await pruneEmptyParents(dirname(path), projectRoot);
  }

  return { projectRoot, tools, configured: true, writes, warnings };
}

export function printDisconnectResult(result: DisconnectResult): void {
  const changed = result.writes.filter((write) => write.changed).length;
  process.stdout.write(`xtctx disconnect complete (${changed} changed, ${result.writes.length - changed} unchanged)\n`);
  process.stdout.write(`Project: ${result.projectRoot}\n`);
  process.stdout.write(`Tools: ${result.tools.join(", ")}\n`);
  for (const write of result.writes) {
    const marker = write.changed ? (write.action ?? "removed") : "ok";
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

async function disableToolsInProjectConfig(
  configPath: string,
  tools: ToolId[],
  projectRoot: string,
): Promise<boolean> {
  const raw = await readUtf8IfExists(configPath);
  if (raw === null) {
    return false;
  }

  // Every other reader of this file degrades on unparseable YAML rather than
  // throwing; this one did not, so a stray tab made uninstalling impossible.
  // Disconnect is the command someone reaches for when things are already
  // wrong, which is the worst moment to require a well-formed config.
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    parsed = null;
  }
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
  await writeFileAtomic(configPath, stringifyYaml(config), { containWithin: projectRoot });
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
  const renderer = NATIVE_MCP_TOOLS[tool];
  if (!renderer) {
    return [];
  }

  const home = homeDir ?? process.env.USERPROFILE ?? process.env.HOME;
  const target = resolveConfigTarget(projectRoot, home ?? "", renderer);
  if (!target || (target.scope === "global" && !home)) {
    return [];
  }

  return [
    target.scope === "global"
      ? { path: target.path, kind: `mcp:${tool}`, note: "global config" }
      : { path: target.path, kind: `mcp:${tool}` },
  ];
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

/**
 * Cheap check for any sign that setup ran here.
 *
 * Deliberately broader than `.xtctx/config.yaml`: a user who deleted that
 * directory but still has managed blocks in their memory files needs
 * disconnect to keep working, so any one signal is enough. What it refuses is
 * the genuinely empty directory.
 */
async function hasXtctxFootprint(projectRoot: string): Promise<boolean> {
  if (await pathExists(join(projectRoot, ".xtctx", "config.yaml"))) {
    return true;
  }

  const candidates = new Set<string>();
  for (const tool of SUPPORTED_TOOLS) {
    for (const target of tool.memoryTargets) {
      candidates.add(join(projectRoot, target));
    }
  }
  candidates.add(join(projectRoot, ".mcp.json"));
  candidates.add(join(projectRoot, ".cursor", "mcp.json"));

  for (const path of candidates) {
    const content = await readFile(path, "utf-8").catch(() => null);
    if (content && content.includes("xtctx")) {
      return true;
    }
  }

  return false;
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
