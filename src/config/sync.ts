import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { errorMessage } from "../utils/errors.js";
import { hasNativeMcpSupport, renderMcpServersMarkdown, type McpServerDefinition } from "./mcp-config.js";
import {
  CONTINUITY_CATEGORIES,
  DEFAULT_REGISTERED_TOOLS,
  loadEffectiveContinuityPolicy,
  resolveToolFromPolicy,
  type ContinuityCategory,
  type ContinuityScope,
  type EffectiveContinuityPolicy,
  type ToolContinuityPolicy,
} from "./policy.js";
import { hasNativeSkillSupport, type SkillDefinition } from "./skills.js";

const MARKERS = {
  markdown: {
    begin: "<!-- xtctx:begin -->",
    end: "<!-- xtctx:end -->",
  },
  text: {
    begin: "# xtctx:begin",
    end: "# xtctx:end",
  },
} as const;

type MarkerKind = keyof typeof MARKERS;

export type ToolSyncState =
  | "in_sync"
  | "drifted"
  | "missing_target"
  | "disabled_by_policy";

interface ToolDefinition {
  projectPath: string;
  globalPath: string;
  markerKind: MarkerKind;
}

interface ToolTarget {
  path: string;
  markers: { begin: string; end: string };
}

interface SyncContext {
  projectRoot: string;
  policy: EffectiveContinuityPolicy;
  inventory: ContinuityInventory;
}

export interface ContinuityInventory {
  skills: string[];
  commands: string[];
  agents: string[];
  mcp_servers: string[];
  slash_commands: string[];
  skill_definitions: SkillDefinition[];
  mcp_server_definitions: McpServerDefinition[];
}

export interface SyncedFileResult {
  tool: string;
  scope: ContinuityScope;
  path: string;
  updated: boolean;
  created: boolean;
  warning?: string;
}

export interface ToolTargetStatus {
  path: string;
  exists: boolean;
  managed_block_present: boolean;
  drifted: boolean;
  updated: boolean;
  created: boolean;
  warning?: string;
}

export interface ToolContinuityStatus {
  tool: string;
  scope: ContinuityScope;
  enabled: boolean;
  categories: Record<ContinuityCategory, boolean>;
  targets: ToolTargetStatus[];
  state: ToolSyncState;
  warnings: string[];
}

export interface SyncResult extends ToolContinuityStatus {
  categories_synced: ContinuityCategory[];
  targets_updated: number;
  targets_created: number;
  targets_unchanged: number;
  duration_ms: number;
}

export interface SyncToolConfigResult {
  updated: number;
  created: number;
  unchanged: number;
  files: SyncedFileResult[];
  warnings: string[];
  tools: SyncResult[];
}

export interface ToolRenderPreview {
  tool: string;
  scope: ContinuityScope;
  enabled: boolean;
  categories: Record<ContinuityCategory, boolean>;
  rendered_content: string;
  targets: Array<{
    path: string;
    exists: boolean;
    drifted: boolean;
    expected_managed_block: string;
    current_managed_block: string | null;
  }>;
}

const TOOL_DEFINITIONS: Record<string, ToolDefinition> = {
  claude: {
    projectPath: "CLAUDE.md",
    globalPath: ".claude/CLAUDE.md",
    markerKind: "markdown",
  },
  "claude-code": {
    projectPath: "CLAUDE.md",
    globalPath: ".claude/CLAUDE.md",
    markerKind: "markdown",
  },
  cursor: {
    projectPath: ".cursorrules",
    globalPath: ".cursor/rules/.cursorrules",
    markerKind: "text",
  },
  codex: {
    projectPath: "AGENTS.md",
    globalPath: ".codex/AGENTS.md",
    markerKind: "markdown",
  },
  copilot: {
    projectPath: ".github/copilot-instructions.md",
    globalPath: ".config/github-copilot/copilot-instructions.md",
    markerKind: "markdown",
  },
  gemini: {
    projectPath: "GEMINI.md",
    globalPath: ".gemini/GEMINI.md",
    markerKind: "markdown",
  },
};

export async function syncToolConfigs(projectPath?: string): Promise<SyncToolConfigResult> {
  const context = await loadSyncContext(projectPath);
  const toolNames = dedupeStrings([
    ...DEFAULT_REGISTERED_TOOLS,
    ...Object.keys(context.policy.tools),
  ]);

  const toolResults: SyncResult[] = [];
  for (const tool of toolNames) {
    const result = await syncSingleTool(context, tool);
    toolResults.push(result);
  }

  const files = toolResults.flatMap((result) =>
    result.targets.map((target) => ({
      tool: result.tool,
      scope: result.scope,
      path: target.path,
      updated: target.updated,
      created: target.created,
      warning: target.warning,
    })),
  );

  const updated = files.filter((entry) => entry.updated).length;
  const created = files.filter((entry) => entry.created).length;
  const unchanged = files.length - updated;
  const warnings = toolResults.flatMap((result) => result.warnings);

  return {
    updated,
    created,
    unchanged,
    files,
    warnings,
    tools: toolResults,
  };
}

export async function syncToolConfigByName(
  tool: string,
  projectPath?: string,
): Promise<SyncResult> {
  const context = await loadSyncContext(projectPath);
  return syncSingleTool(context, tool);
}

export async function getToolContinuityStatuses(
  projectPath?: string,
): Promise<ToolContinuityStatus[]> {
  const context = await loadSyncContext(projectPath);
  const tools = dedupeStrings([
    ...DEFAULT_REGISTERED_TOOLS,
    ...Object.keys(context.policy.tools),
  ]);

  const statuses: ToolContinuityStatus[] = [];
  for (const tool of tools) {
    statuses.push(await inspectSingleTool(context, tool));
  }

  return statuses;
}

export async function previewToolContinuity(
  tool: string,
  projectPath?: string,
): Promise<ToolRenderPreview> {
  const context = await loadSyncContext(projectPath);
  const policy = resolveToolFromPolicy(context.policy, tool);
  const targets = resolveToolTargets(context.projectRoot, tool, policy.scope);
  const categories = categoriesFromPolicy(policy);
  const content = renderToolContent(tool, policy, context.inventory, context.policy, context.projectRoot);

  const targetPreviews = await Promise.all(targets.map(async (target) => {
    const existing = await readUtf8IfExists(target.path);
    const expectedManaged = renderManagedSection(content, target.markers);
    const currentManaged = existing ? extractManagedSection(existing, target.markers) : null;
    const drifted = currentManaged
      ? normalizeNewlines(currentManaged).trim() !== normalizeNewlines(expectedManaged).trim()
      : false;

    return {
      path: target.path,
      exists: Boolean(existing),
      drifted,
      expected_managed_block: expectedManaged,
      current_managed_block: currentManaged,
    };
  }));

  return {
    tool,
    scope: policy.scope,
    enabled: policy.enabled,
    categories,
    rendered_content: content,
    targets: targetPreviews,
  };
}

async function loadSyncContext(projectPath?: string): Promise<SyncContext> {
  const projectRoot = resolve(projectPath ?? process.cwd());
  const policy = await loadEffectiveContinuityPolicy(projectRoot);
  const inventory = await loadContinuityInventory(join(projectRoot, ".xtctx", "tool-config"));
  return { projectRoot, policy, inventory };
}

async function syncSingleTool(context: SyncContext, tool: string): Promise<SyncResult> {
  const startedAt = Date.now();
  const toolPolicy = resolveToolFromPolicy(context.policy, tool);
  const targets = resolveToolTargets(context.projectRoot, tool, toolPolicy.scope);
  const categories = categoriesFromPolicy(toolPolicy);
  const warnings: string[] = [];

  if (!toolPolicy.enabled) {
    return {
      tool,
      scope: toolPolicy.scope,
      enabled: false,
      categories,
      targets: targets.map((target) => ({
        path: target.path,
        exists: false,
        managed_block_present: false,
        drifted: false,
        updated: false,
        created: false,
      })),
      state: "disabled_by_policy",
      warnings: [],
      categories_synced: [],
      targets_updated: 0,
      targets_created: 0,
      targets_unchanged: targets.length,
      duration_ms: Date.now() - startedAt,
    };
  }

  const content = renderToolContent(tool, toolPolicy, context.inventory, context.policy, context.projectRoot);
  const targetStatuses: ToolTargetStatus[] = [];

  for (const target of targets) {
    const result = await syncTarget(target, content);
    if (result.warning) {
      warnings.push(result.warning);
    }
    targetStatuses.push(result);
  }

  const state = deriveState(toolPolicy.enabled, targetStatuses);
  const targetsUpdated = targetStatuses.filter((target) => target.updated).length;
  const targetsCreated = targetStatuses.filter((target) => target.created).length;
  const targetsUnchanged = targetStatuses.length - targetsUpdated;

  return {
    tool,
    scope: toolPolicy.scope,
    enabled: true,
    categories,
    targets: targetStatuses,
    state,
    warnings,
    categories_synced: enabledCategories(toolPolicy),
    targets_updated: targetsUpdated,
    targets_created: targetsCreated,
    targets_unchanged: targetsUnchanged,
    duration_ms: Date.now() - startedAt,
  };
}

async function inspectSingleTool(context: SyncContext, tool: string): Promise<ToolContinuityStatus> {
  const toolPolicy = resolveToolFromPolicy(context.policy, tool);
  const targets = resolveToolTargets(context.projectRoot, tool, toolPolicy.scope);
  const categories = categoriesFromPolicy(toolPolicy);

  if (!toolPolicy.enabled) {
    return {
      tool,
      scope: toolPolicy.scope,
      enabled: false,
      categories,
      targets: [],
      state: "disabled_by_policy",
      warnings: [],
    };
  }

  const content = renderToolContent(tool, toolPolicy, context.inventory, context.policy, context.projectRoot);
  const statuses = await Promise.all(targets.map((target) => inspectTarget(target, content)));
  const warnings = statuses
    .map((status) => status.warning)
    .filter((warning): warning is string => typeof warning === "string");

  return {
    tool,
    scope: toolPolicy.scope,
    enabled: true,
    categories,
    targets: statuses,
    state: deriveState(true, statuses),
    warnings,
  };
}

function deriveState(enabled: boolean, targets: ToolTargetStatus[]): ToolSyncState {
  if (!enabled) {
    return "disabled_by_policy";
  }

  if (targets.some((target) => !target.exists)) {
    return "missing_target";
  }

  if (targets.some((target) => target.drifted || Boolean(target.warning))) {
    return "drifted";
  }

  return "in_sync";
}

async function syncTarget(target: ToolTarget, content: string): Promise<ToolTargetStatus> {
  const existing = await readUtf8IfExists(target.path);
  const expectedBlock = renderManagedSection(content, target.markers);
  const inspected = inspectContent(existing, expectedBlock, target.path);

  const next = existing
    ? upsertManagedSection(existing, content, target.markers)
    : renderManagedSection(content, target.markers);
  const shouldWrite = !existing || normalizeNewlines(existing) !== normalizeNewlines(next);

  if (!shouldWrite) {
    return {
      ...inspected,
      updated: false,
      created: false,
    };
  }

  try {
    await mkdir(dirname(target.path), { recursive: true });
    await writeFile(target.path, next, "utf-8");
  } catch (error) {
    return {
      ...inspected,
      updated: false,
      created: false,
      warning: `Unable to write ${target.path}: ${errorMessage(error)}. Check path and permissions.`,
    };
  }

  const refreshed = await inspectTarget(target, content);
  return {
    ...refreshed,
    updated: true,
    created: !existing,
  };
}

async function inspectTarget(target: ToolTarget, content: string): Promise<ToolTargetStatus> {
  const existing = await readUtf8IfExists(target.path);
  const expectedBlock = renderManagedSection(content, target.markers);
  return inspectContent(existing, expectedBlock, target.path);
}

function inspectContent(
  existing: string | null,
  expectedManagedBlock: string,
  filePath: string,
): ToolTargetStatus {
  if (!existing) {
    return {
      path: filePath,
      exists: false,
      managed_block_present: false,
      drifted: false,
      updated: false,
      created: false,
      warning: `Target file missing: ${filePath}. Run sync to create it.`,
    };
  }

  const isMarkdown = expectedManagedBlock.includes("<!-- xtctx:begin -->");
  const markers = isMarkdown ? MARKERS.markdown : MARKERS.text;
  const existingManagedBlock = extractManagedSection(existing, markers);
  if (!existingManagedBlock) {
    return {
      path: filePath,
      exists: true,
      managed_block_present: false,
      drifted: true,
      updated: false,
      created: false,
      warning: `Managed block missing in ${filePath}. Run sync to reconcile.`,
    };
  }

  const drifted = normalizeNewlines(existingManagedBlock).trim() !== normalizeNewlines(expectedManagedBlock).trim();
  return {
    path: filePath,
    exists: true,
    managed_block_present: true,
    drifted,
    updated: false,
    created: false,
    warning: drifted ? `Managed block drift detected in ${filePath}.` : undefined,
  };
}

function resolveToolTargets(projectRoot: string, tool: string, scope: ContinuityScope): ToolTarget[] {
  const definition = resolveToolDefinition(tool);
  const markers = MARKERS[definition.markerKind];
  const projectTarget: ToolTarget = {
    path: join(projectRoot, definition.projectPath),
    markers,
  };

  const home = resolveHomeDir();
  const globalTarget = home
    ? {
        path: join(home, definition.globalPath),
        markers,
      }
    : null;

  if (scope === "project") {
    return [projectTarget];
  }

  if (scope === "global") {
    return globalTarget ? [globalTarget] : [projectTarget];
  }

  if (scope === "hybrid") {
    return globalTarget ? [projectTarget, globalTarget] : [projectTarget];
  }

  return [projectTarget];
}

function resolveToolDefinition(tool: string): ToolDefinition {
  const direct = TOOL_DEFINITIONS[tool];
  if (direct) {
    return direct;
  }

  return {
    projectPath: `${tool.toUpperCase()}.md`,
    globalPath: `.xtctx/tool-outputs/${tool}.md`,
    markerKind: "markdown",
  };
}

function renderToolContent(
  tool: string,
  toolPolicy: ToolContinuityPolicy,
  inventory: ContinuityInventory,
  policy: EffectiveContinuityPolicy,
  projectRoot: string,
): string {
  const enabled = enabledCategories(toolPolicy);
  const lines: string[] = [
    "# xtctx Continuity Policy",
    "",
    `Tool: ${tool}`,
    `Scope: ${toolPolicy.scope}`,
    "",
    "This block is generated by xtctx sync from .xtctx/tool-config/shared.yaml.",
    "Do not edit lines inside this managed block.",
  ];

  if (enabled.length === 0) {
    lines.push("", "No continuity categories enabled for this tool.");
    return lines.join("\n").trimEnd();
  }

  if (toolPolicy.categories.context_feed) {
    lines.push(
      "",
      "## Context feed",
      "- Session opener: xtctx_search -> xtctx_project_knowledge",
      "- Writeback tools: xtctx_save_decision, xtctx_save_error_solution, xtctx_save_faq",
      `- Project root: ${projectRoot}`,
    );
  }

  if (toolPolicy.categories.skills) {
    lines.push("", "## Skills", ...formatMarkdownList(inventory.skills));

    // For tools without native skill files, embed full skill content
    if (!hasNativeSkillSupport(tool) && inventory.skill_definitions.length > 0) {
      for (const skill of inventory.skill_definitions) {
        if (skill.content.trim()) {
          lines.push("", `### Skill: ${skill.name}`, "", skill.content.trim());
        }
      }
    }
  }

  if (toolPolicy.categories.commands) {
    lines.push("", "## Commands", ...formatMarkdownList(inventory.commands));
  }

  if (toolPolicy.categories.agents) {
    lines.push("", "## Agents", ...formatMarkdownList(inventory.agents));
  }

  if (toolPolicy.categories.mcp_servers) {
    lines.push("", "## MCP servers", ...formatMarkdownList(inventory.mcp_servers));
    lines.push("- xtctx (required for recall/writeback continuity)");

    // For tools without native MCP config, embed connection details
    if (!hasNativeMcpSupport(tool) && inventory.mcp_server_definitions.length > 0) {
      lines.push(...renderMcpServersMarkdown(inventory.mcp_server_definitions));
    }
  }

  if (toolPolicy.categories.slash_commands) {
    lines.push("", "## Slash commands", ...formatMarkdownList(inventory.slash_commands));
  }

  if (toolPolicy.categories.whitelist_policy) {
    const whitelist = policy.policy.whitelist;
    lines.push(
      "",
      "## Whitelist policy",
      `- advisory_level: ${whitelist.advisory_level}`,
      "- allowed_patterns:",
      ...formatIndentedList(whitelist.allowed_patterns),
      "- denied_patterns:",
      ...formatIndentedList(whitelist.denied_patterns),
    );
  }

  if (Object.keys(toolPolicy.preferences).length > 0) {
    lines.push(
      "",
      "## Tool preferences",
      "```json",
      JSON.stringify(toolPolicy.preferences, null, 2),
      "```",
    );
  }

  return lines.join("\n").trimEnd();
}

async function loadContinuityInventory(configRoot: string): Promise<ContinuityInventory> {
  const { loadSkillDefinitions } = await import("./skills.js");
  const { loadMcpServerDefinitions } = await import("./mcp-config.js");

  const [
    skills,
    commands,
    agents,
    mcpServers,
    slashCommands,
    skillDefinitions,
    mcpServerDefinitions,
  ] = await Promise.all([
    listDirectoryNames(join(configRoot, "skills")),
    listDirectoryNames(join(configRoot, "commands")),
    listDirectoryNames(join(configRoot, "agents")),
    listDirectoryNames(join(configRoot, "mcp-servers")),
    listDirectoryNames(join(configRoot, "slash-commands")),
    loadSkillDefinitions(configRoot),
    loadMcpServerDefinitions(configRoot),
  ]);

  return {
    skills,
    commands,
    agents,
    mcp_servers: mcpServers,
    slash_commands: slashCommands,
    skill_definitions: skillDefinitions,
    mcp_server_definitions: mcpServerDefinitions,
  };
}

function enabledCategories(policy: ToolContinuityPolicy): ContinuityCategory[] {
  return CONTINUITY_CATEGORIES.filter((category) => policy.categories[category]);
}

function categoriesFromPolicy(
  policy: ToolContinuityPolicy,
): Record<ContinuityCategory, boolean> {
  return {
    context_feed: policy.categories.context_feed,
    skills: policy.categories.skills,
    commands: policy.categories.commands,
    agents: policy.categories.agents,
    mcp_servers: policy.categories.mcp_servers,
    slash_commands: policy.categories.slash_commands,
    whitelist_policy: policy.categories.whitelist_policy,
  };
}

function formatMarkdownList(values: string[]): string[] {
  if (values.length === 0) {
    return ["- none"];
  }

  return values.map((value) => `- ${value}`);
}

function formatIndentedList(values: string[]): string[] {
  if (values.length === 0) {
    return ["  - none"];
  }

  return values.map((value) => `  - ${value}`);
}

function upsertManagedSection(
  existing: string,
  blockContent: string,
  markers: { begin: string; end: string },
): string {
  const normalized = normalizeNewlines(existing);
  const sectionPattern = new RegExp(
    `${escapeRegExp(markers.begin)}[\\s\\S]*?${escapeRegExp(markers.end)}\\n?`,
    "g",
  );
  const withoutManagedSection = normalized.replace(sectionPattern, "").trimEnd();
  const managedSection = renderManagedSection(blockContent, markers).trimEnd();

  if (withoutManagedSection.length === 0) {
    return `${managedSection}\n`;
  }

  return `${withoutManagedSection}\n\n${managedSection}\n`;
}

function renderManagedSection(
  blockContent: string,
  markers: { begin: string; end: string },
): string {
  return [
    markers.begin,
    "Generated by xtctx sync. Do not edit inside this block.",
    "",
    blockContent,
    markers.end,
    "",
  ].join("\n");
}

function extractManagedSection(
  content: string,
  markers: { begin: string; end: string },
): string | null {
  const pattern = new RegExp(
    `${escapeRegExp(markers.begin)}[\\s\\S]*?${escapeRegExp(markers.end)}\\n?`,
    "m",
  );
  const match = content.match(pattern);
  return match ? match[0] : null;
}

function normalizeNewlines(input: string): string {
  return input.replace(/\r\n/g, "\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readUtf8IfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

async function listDirectoryNames(path: string): Promise<string[]> {
  try {
    const files = await readdir(path);
    return dedupeStrings(
      files
        .map((name) => normalizeConfigName(name))
        .filter((name): name is string => name.length > 0),
    );
  } catch {
    return [];
  }
}

function normalizeConfigName(fileName: string): string {
  const extension = extname(fileName);
  if (!extension) {
    return fileName;
  }

  return fileName.slice(0, Math.max(0, fileName.length - extension.length));
}

function resolveHomeDir(): string | null {
  const home = process.env.USERPROFILE ?? process.env.HOME;
  return home ? resolve(home) : null;
}

function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

