import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "../utils/atomic-file.js";
import { stringify as stringifyYaml } from "yaml";
import {
  isGlobalOnlyMcpTool,
  syncToolMcpConfigs,
  type McpServerDefinition,
} from "./mcp-config.js";
import {
  renderSyncedSkillsBlock,
  syncProjectSkills,
  type ProjectSkillConfig,
  type SkillSelection,
} from "./skills.js";
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
  selectedSkillIds?: string[];
  includeGlobalMcp?: boolean;
}

export interface SetupResult {
  projectRoot: string;
  configPath: string;
  writes: Array<{ path: string; kind: string; changed: boolean }>;
  warnings: string[];
  /** Hard failures (unreadable/unwritable configs); setup exits nonzero. */
  failures: string[];
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
  const failures: string[] = [];

  if (options.repair) {
    await rm(join(xtctxDir, ".store"), { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
    await rm(join(xtctxDir, "tool-config"), { recursive: true, force: true });
  }

  await mkdir(stateDir, { recursive: true });

  const skillSync = await syncProjectSkills({
    projectRoot,
    configPath,
    selectedSkillIds: options.selectedSkillIds,
    homeDir: options.homeDir,
  });
  writes.push(...skillSync.writes);
  warnings.push(...skillSync.warnings);

  writes.push({
    path: configPath,
    kind: "config",
    changed: await writeIfChanged(configPath, renderProjectConfig(projectRoot, skillSync.config)),
  });

  const serverDefinition = xtctxServerDefinition();
  const mcpSummary = await syncToolMcpConfigs(
    projectRoot,
    [serverDefinition],
    supportedMcpTools(options.includeGlobalMcp),
    options.homeDir ? { homeDir: options.homeDir } : {},
  );

  for (const file of mcpSummary.results) {
    writes.push({
      path: file.path,
      kind: `mcp:${file.tool}`,
      changed: file.updated || file.created,
    });
    if (file.failed && file.warning) {
      failures.push(file.warning);
    } else if (file.warning) {
      warnings.push(file.warning);
    }
  }

  for (const target of memoryTargets(projectRoot)) {
    const block = renderManagedBlock({
      projectRoot,
      tool: target.tool,
      hookMode: target.hookMode,
      serverDefinition,
      skills: skillSync.selected,
    });
    writes.push({
      path: target.path,
      kind: `memory:${target.tool}`,
      changed: await upsertManagedBlock(target.path, block, target.prelude),
    });
  }

  writes.push({
    path: join(projectRoot, ".claude", "settings.json"),
    kind: "hook:claude-code",
    changed: await installClaudeHook(projectRoot),
  });

  return { projectRoot, configPath, writes, warnings, failures };
}

export function describeSetupPlan(
  projectPath?: string,
  selectedSkillIds: string[] = ["xtctx-handoff"],
  includeGlobalMcp = false,
): {
  projectRoot: string;
  writes: PlannedSetupWrite[];
} {
  const projectRoot = resolve(projectPath ?? process.cwd());
  const skillIds = [...new Set(["xtctx-handoff", ...selectedSkillIds])];
  const writes: PlannedSetupWrite[] = [
    { path: join(projectRoot, ".xtctx", "config.yaml"), kind: "config" },
    { path: join(projectRoot, ".mcp.json"), kind: "mcp:claude-code" },
    { path: join(projectRoot, ".cursor", "mcp.json"), kind: "mcp:cursor" },
    { path: join(projectRoot, ".vscode", "mcp.json"), kind: "mcp:copilot" },
    { path: join(projectRoot, ".codex", "config.toml"), kind: "mcp:codex" },
    { path: join(projectRoot, "opencode.json"), kind: "mcp:opencode" },
    { path: join(projectRoot, "AGENTS.md"), kind: "memory:codex/opencode" },
    { path: join(projectRoot, "CLAUDE.md"), kind: "memory:claude-code" },
    { path: join(projectRoot, "GEMINI.md"), kind: "memory:antigravity" },
    { path: join(projectRoot, ".cursor", "rules", "xtctx.mdc"), kind: "memory:cursor" },
    { path: join(projectRoot, ".github", "copilot-instructions.md"), kind: "memory:copilot" },
    { path: join(projectRoot, ".claude", "settings.json"), kind: "hook:claude-code" },
  ];

  for (const skillId of skillIds) {
    writes.push(
      { path: join(projectRoot, ".xtctx", "skills", skillId, "SKILL.md"), kind: `skill-source:${skillId}` },
      { path: join(projectRoot, ".claude", "skills", skillId, "SKILL.md"), kind: `skill:claude-code:${skillId}` },
      { path: join(projectRoot, ".cursor", "rules", "xtctx-skills", `${skillId}.mdc`), kind: `skill:cursor:${skillId}` },
      {
        path: join(projectRoot, ".github", "instructions", `xtctx-${skillId}.instructions.md`),
        kind: `skill:copilot:${skillId}`,
      },
    );
  }
  const home = process.env.USERPROFILE ?? process.env.HOME;
  if (home) {
    writes.push({
      path: join(home, ".gemini", "antigravity", "mcp_config.json"),
      kind: "mcp:antigravity",
    });
  }
  if (includeGlobalMcp && home) {
    writes.push({ path: join(home, ".copilot", "mcp-config.json"), kind: "mcp:copilot-cli" });
  }

  return { projectRoot, writes };
}

function supportedMcpTools(includeGlobalMcp = false): string[] {
  return SUPPORTED_TOOLS
    .filter((tool) => {
      if (!isGlobalOnlyMcpTool(tool.id)) {
        return true;
      }
      // Antigravity only has app-level MCP config; always wire it on setup.
      if (tool.id === "antigravity") {
        return true;
      }
      return includeGlobalMcp;
    })
    .map((tool) => tool.id);
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

function renderProjectConfig(projectRoot: string, skills: ProjectSkillConfig): string {
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
    skills,
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
      tool: "antigravity",
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
  skills: SkillSelection[];
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
    "- External orchestrators can call `xtctx_handoff_manifest` for stable session references and raw-detail pointers; it does not persist task state.",
    "",
    ...renderSyncedSkillsBlock(input.skills),
    "## MCP",
    `- Command: \`${command}\``,
    "- Transport: stdio",
    "",
    "## Notes",
    "- Indexing is on-demand from MCP recent, detail, and search calls.",
    "- There is no xtctx daemon, API server, dashboard, durable memory, or generated brief.",
    "- Content outside this managed block is preserved.",
    MARKERS.end,
    "",
  ].join("\n");
}

const CLAUDE_HOOK_MARKER = "xtctx --hook session-start";
// Claude Code runs hooks with cwd = project root, so the command stays
// path-independent — no shell-quoted absolute path to get injection wrong.
const CLAUDE_HOOK_COMMAND = "npx -y xtctx --hook session-start --tool claude-code";

async function installClaudeHook(projectRoot: string): Promise<boolean> {
  // Claude Code reads hooks from .claude/settings.json (matcher-group shape).
  // Earlier xtctx versions wrote a flat array to .claude/hooks.json, which
  // Claude Code never loads — migrate those entries out.
  const legacyChanged = await removeLegacyClaudeHook(join(projectRoot, ".claude", "hooks.json"));

  const settingsPath = join(projectRoot, ".claude", "settings.json");
  const existing = await readJsonIfExists(settingsPath);
  const root = isRecord(existing) ? existing : {};
  const hooks = isRecord(root.hooks) ? root.hooks : {};
  const sessionStart = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : [];
  const alreadyInstalled = sessionStart.some(
    (group) =>
      isRecord(group) &&
      Array.isArray(group.hooks) &&
      group.hooks.some(
        (hook) =>
          isRecord(hook) &&
          typeof hook.command === "string" &&
          hook.command.includes(CLAUDE_HOOK_MARKER),
      ),
  );

  if (alreadyInstalled) {
    return legacyChanged;
  }

  hooks.SessionStart = [
    ...sessionStart,
    { hooks: [{ type: "command", command: CLAUDE_HOOK_COMMAND }] },
  ];
  root.hooks = hooks;
  const changed = await writeIfChanged(settingsPath, JSON.stringify(root, null, 2) + "\n");
  return changed || legacyChanged;
}

async function removeLegacyClaudeHook(hooksPath: string): Promise<boolean> {
  const existing = await readJsonIfExists(hooksPath);
  if (!isRecord(existing) || !isRecord(existing.hooks)) {
    return false;
  }

  const hooks = existing.hooks;
  const sessionStart = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : [];
  const kept = sessionStart.filter(
    (entry) =>
      !(
        isRecord(entry) &&
        typeof entry.command === "string" &&
        entry.command.includes(CLAUDE_HOOK_MARKER)
      ),
  );
  if (kept.length === sessionStart.length) {
    return false;
  }

  const otherHookKeys = Object.keys(hooks).filter((key) => key !== "SessionStart");
  const otherRootKeys = Object.keys(existing).filter((key) => key !== "hooks");
  if (kept.length === 0 && otherHookKeys.length === 0 && otherRootKeys.length === 0) {
    // The file held nothing but the entry we wrote; remove it entirely.
    await rm(hooksPath, { force: true });
    return true;
  }

  hooks.SessionStart = kept;
  return writeIfChanged(hooksPath, JSON.stringify(existing, null, 2) + "\n");
}

async function upsertManagedBlock(
  filePath: string,
  block: string,
  prelude = "",
): Promise<boolean> {
  const existing = await readUtf8IfExists(filePath);
  const repaired = existing ? removeManagedBlocks(existing).trimEnd() : "";
  // A file that already opens with YAML frontmatter keeps it — prepending
  // the prelude again would produce a second, invalid frontmatter block.
  const hasFrontmatter = repaired.startsWith("---");
  const prefix =
    prelude && !hasFrontmatter && !repaired.startsWith(prelude.trimEnd()) ? prelude : "";
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
  const existing = await readUtf8IfExists(filePath);
  // Preserve the existing file's dominant line endings instead of silently
  // converting a CRLF-authored file to LF.
  const finalContent =
    existing !== null && isCrlfDominant(existing)
      ? content.replace(/\r?\n/g, "\r\n")
      : content;
  if (existing !== null && existing === finalContent) {
    return false;
  }

  await writeFileAtomic(filePath, finalContent);
  return true;
}

function isCrlfDominant(content: string): boolean {
  const crlf = content.match(/\r\n/g)?.length ?? 0;
  const lf = content.match(/\n/g)?.length ?? 0;
  return crlf > 0 && crlf * 2 > lf;
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
  for (const failure of result.failures) {
    process.stdout.write(`  error   ${failure}\n`);
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
