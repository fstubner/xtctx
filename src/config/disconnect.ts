import { readdir, readFile, rm, rmdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative as relativePath, resolve } from "node:path";
import { writeFileAtomic } from "../utils/atomic-file.js";
import { matchLineEndings, normalizeNewlines, removeManagedBlocks } from "./managed-block.js";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { removeMcpServerConfigs } from "./mcp-config.js";
import { BUILT_IN_SKILL_ID, removeSyncedSkillsForTools } from "./skills.js";
import { SUPPORTED_TOOLS, getToolDefinition, type ToolId } from "../tools/sources.js";
import { CLAUDE_HOOK_MARKER } from "./setup.js";

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
    // config.yaml is rewritten with the tools disabled, never deleted — it is
    // the record that xtctx was disconnected.
    action: "updated",
    changed: await disableToolsInProjectConfig(configPath, tools, projectRoot),
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

  if (tools.includes("antigravity")) {
    warnings.push(
      "Antigravity MCP config is app-level; xtctx was removed from the Antigravity config for this user account.",
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

  return { projectRoot, tools, writes, warnings };
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

async function removeManagedBlocksFromFile(filePath: string, projectRoot: string): Promise<boolean> {
  const existing = await readUtf8IfExists(filePath);
  if (existing === null) {
    return false;
  }

  // Untrimmed: `removeManagedBlocks` gives back exactly the bytes that were
  // there before setup added its separator, and trimming here would undo that
  // by editing the tail of the user's own content.
  const repaired = removeManagedBlocks(existing);
  if (normalizeNewlines(existing) === repaired) {
    return false;
  }

  if (!repaired.trim() || isOnlyFrontmatter(repaired)) {
    // The file held nothing but the xtctx block — or the YAML frontmatter
    // xtctx itself wrote above it, which Cursor would keep loading as an
    // xtctx rule. Either way setup created it and disconnect owns removing
    // it, rather than leaving a stub behind.
    await rm(filePath, { force: true });
    return true;
  }

  // Put the author's line endings back: removal must not reformat the file.
  // No trailing newline is appended — whatever the file ended with is already
  // in `repaired`, and adding one is an edit to content xtctx does not own.
  await writeFileAtomic(filePath, matchLineEndings(repaired, existing), {
    containWithin: projectRoot,
  });
  return true;
}

/** True when the directory is missing or holds nothing. */
async function directoryIsEmpty(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length === 0;
  } catch {
    // Missing, or not a directory: either way there is no index to protect.
    return true;
  }
}

async function removeIfPresent(path: string): Promise<boolean> {
  try {
    await stat(path);
  } catch {
    return false;
  }
  await rm(path, { recursive: true, force: true });
  return true;
}

/**
 * Remove directories that only existed to hold what was just deleted.
 *
 * Disconnect left `.vscode/`, `.github/instructions/` and
 * `.cursor/rules/xtctx-skills/` standing empty — directories xtctx created,
 * now holding nothing, in projects that never had them. It walks upward while
 * each directory is genuinely empty, so anything the user keeps alongside our
 * files stops it immediately.
 */
/** Strictly below the project root — the root itself is never a candidate. */
function isInsideProject(candidate: string, projectRoot: string): boolean {
  const relative = relativePath(projectRoot, candidate);
  return relative.length > 0 && !relative.startsWith("..") && !isAbsolute(relative);
}

async function pruneEmptyParents(directory: string, projectRoot: string): Promise<void> {
  let current = directory;

  // Hard floor at the project root. Several write paths sit at the root
  // itself — `.mcp.json`, `CLAUDE.md`, `AGENTS.md` — so `dirname` is the root,
  // and without this the walk climbed straight out of the project and deleted
  // it along with its empty ancestors. Emptiness is not a licence to delete
  // something xtctx never created.
  if (!isInsideProject(current, projectRoot)) {
    return;
  }

  // Bounded: three levels covers the deepest xtctx creates
  // (`.cursor/rules/xtctx-skills`), and a bound is cheaper than reasoning
  // about how far up an unexpected path could walk.
  for (let depth = 0; depth < 3; depth += 1) {
    if (!isInsideProject(current, projectRoot)) {
      return;
    }

    let entries: string[];
    try {
      entries = await readdir(current);
    } catch {
      return;
    }
    if (entries.length > 0) {
      return;
    }
    try {
      // `rmdir`, not `rm`: it refuses a non-empty directory, so it is its own
      // safety net. (`rm` without `recursive` throws on any directory at all,
      // which the catch below silently turned into "give up" — the prune
      // looked implemented and did nothing.)
      await rmdir(current);
    } catch {
      return;
    }
    current = dirname(current);
  }
}

/** True when nothing survives but a single YAML frontmatter block. */
function isOnlyFrontmatter(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed.startsWith("---")) {
    return false;
  }
  const end = trimmed.indexOf("\n---", 3);
  return end !== -1 && trimmed.slice(end + 4).trim().length === 0;
}

/** Strip xtctx SessionStart matcher groups from .claude/settings.json. */
async function removeClaudeHookFromSettings(
  settingsPath: string,
  projectRoot: string,
): Promise<boolean> {
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
          !hook.command.includes(CLAUDE_HOOK_MARKER),
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

  // A settings file left holding nothing but an empty SessionStart list was
  // created by setup for that hook alone; remove it rather than leave litter.
  const hooksOnly =
    Object.keys(parsed).length === 1 &&
    Object.keys(parsed.hooks).length === 1 &&
    kept.length === 0;
  if (hooksOnly) {
    await rm(settingsPath, { force: true });
    return true;
  }

  await writeFileAtomic(settingsPath, JSON.stringify(parsed, null, 2) + "\n", {
    containWithin: projectRoot,
  });
  return true;
}

async function removeClaudeHook(hooksPath: string, projectRoot: string): Promise<boolean> {
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
      !entry.command.includes(CLAUDE_HOOK_MARKER),
  );

  if (nextSessionStart.length === sessionStart.length) {
    return false;
  }

  parsed.hooks.SessionStart = nextSessionStart;
  await writeFileAtomic(hooksPath, JSON.stringify(parsed, null, 2) + "\n", {
    containWithin: projectRoot,
  });
  return true;
}

async function readUtf8IfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
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
