import { createHash } from "node:crypto";
import { readdir, readFile, rm, stat, mkdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { writeFileAtomic } from "../utils/atomic-file.js";
import { parse as parseYaml } from "yaml";
import { SUPPORTED_TOOLS, type SkillSyncMode, type ToolId } from "../tools/sources.js";

export const BUILT_IN_SKILL_ID = "xtctx-handoff";

interface DiscoveredSkill {
  id: string;
  name: string;
  description: string;
  path: string;
  source: string;
  content: string;
}

export interface SkillSelection {
  id: string;
  hash: string;
  source: string;
  path: string;
}

interface SkillTargetState {
  mode: SkillSyncMode;
  path?: string;
}

export interface ProjectSkillConfig {
  sourceDir: string;
  selected: Record<string, { hash: string; source: string }>;
  targets: Record<string, SkillTargetState>;
}

interface SkillSyncResult {
  config: ProjectSkillConfig;
  selected: SkillSelection[];
  writes: Array<{ path: string; kind: string; changed: boolean }>;
  warnings: string[];
}

interface SkillStatus {
  sourceDir: string;
  selected: Array<{ id: string; exists: boolean; hash?: string }>;
  targets: Array<{
    tool: ToolId;
    mode: SkillSyncMode;
    skillId?: string;
    path?: string;
    state: "ok" | "missing" | "drift" | "unsupported" | "managed-block";
  }>;
}

interface ExistingSkillConfig {
  selectedIds: string[];
}

interface SkillSyncOptions {
  projectRoot: string;
  configPath: string;
  selectedSkillIds?: string[];
  homeDir?: string;
}

const HASH_PREFIX = "sha256:";
const SKILL_HASH_PATTERN = /xtctx:skill-hash\s+([a-z0-9:]+)/i;

export async function syncProjectSkills(options: SkillSyncOptions): Promise<SkillSyncResult> {
  const projectRoot = resolve(options.projectRoot);
  const sourceDir = skillSourceDir(projectRoot);
  const existing = await readExistingSkillConfig(options.configPath);
  const discovered = await discoverProjectSkills({ projectRoot, homeDir: options.homeDir });
  const selectedIds = resolveSelectedSkillIds(existing, options.selectedSkillIds);
  const writes: SkillSyncResult["writes"] = [];
  const warnings: string[] = [];

  await mkdir(sourceDir, { recursive: true });

  for (const skillId of selectedIds) {
    const sourcePath = join(sourceDir, skillId, "SKILL.md");
    const discoveredSkill = discovered.find((skill) => skill.id === skillId);
    const content = skillId === BUILT_IN_SKILL_ID ? builtInHandoffSkill() : discoveredSkill?.content;

    if (!content) {
      warnings.push(`Selected skill ${skillId} was not found in connected tool skill sources.`);
      continue;
    }

    writes.push({
      path: sourcePath,
      kind: `skill-source:${skillId}`,
      changed: await writeIfChanged(sourcePath, content, projectRoot),
    });
  }

  const selected = await readSelectedSkills(sourceDir, selectedIds);
  const targetConfig = buildTargetConfig(projectRoot);

  for (const skill of selected) {
    for (const tool of SUPPORTED_TOOLS) {
      const capability = tool.skillSync;
      if (!capability || capability.mode === "unsupported" || capability.mode === "managed-block") {
        continue;
      }

      const targetPath = capability.targetPath?.(projectRoot, skill.id);
      if (!targetPath) {
        continue;
      }

      const write = await syncSkillToTarget({
        skill,
        mode: capability.mode,
        targetPath,
        // Every skill target path is built from `projectRoot`, so that is the
        // root the write must stay inside.
        containWithin: projectRoot,
      });
      writes.push({ path: write.path, kind: `skill:${tool.id}:${skill.id}`, changed: write.changed });
    }
  }

  for (const tool of SUPPORTED_TOOLS.filter((item) => item.skillSync?.mode === "unsupported")) {
    warnings.push(`${tool.label} has no verified native skill or instruction surface; skill sync is not installed there.`);
  }

  return {
    config: {
      sourceDir: ".xtctx/skills",
      selected: Object.fromEntries(
        selected.map((skill) => [skill.id, { hash: skill.hash, source: toProjectRelative(projectRoot, skill.path) }]),
      ),
      targets: targetConfig,
    },
    selected,
    writes,
    warnings,
  };
}

export async function discoverProjectSkills(options: {
  projectRoot: string;
  homeDir?: string;
}): Promise<DiscoveredSkill[]> {
  const projectRoot = resolve(options.projectRoot);
  const home = options.homeDir ?? process.env.USERPROFILE ?? process.env.HOME ?? "";
  const codexHome = process.env.CODEX_HOME ?? (home ? join(home, ".codex") : "");
  const candidates = [
    { source: "xtctx", root: skillSourceDir(projectRoot) },
    { source: "claude-code project", root: join(projectRoot, ".claude", "skills") },
    { source: "claude-code user", root: home ? join(home, ".claude", "skills") : "" },
    { source: "codex project", root: join(projectRoot, ".codex", "skills") },
    { source: "codex user", root: codexHome ? join(codexHome, "skills") : "" },
  ].filter((candidate) => candidate.root.length > 0);

  const discovered: DiscoveredSkill[] = [
    parseSkillContent(BUILT_IN_SKILL_ID, builtInHandoffSkill(), "<built-in>", "xtctx built-in"),
  ];

  for (const candidate of candidates) {
    const entries = await readSkillDir(candidate.root, candidate.source);
    for (const entry of entries) {
      if (!discovered.some((skill) => skill.id === entry.id)) {
        discovered.push(entry);
      }
    }
  }

  return discovered.sort((left, right) => left.id.localeCompare(right.id));
}

export async function inspectSkillStatus(projectRoot: string, configPath: string): Promise<SkillStatus> {
  const root = resolve(projectRoot);
  const sourceDir = skillSourceDir(root);
  const existing = await readExistingSkillConfig(configPath);
  const selectedIds = resolveSelectedSkillIds(existing);
  const selected = await Promise.all(
    selectedIds.map(async (id) => {
      const path = join(sourceDir, id, "SKILL.md");
      const content = await readUtf8IfExists(path);
      return {
        id,
        exists: content !== null,
        hash: content ? hashContent(content) : undefined,
      };
    }),
  );

  const targets: SkillStatus["targets"] = [];
  for (const tool of SUPPORTED_TOOLS) {
    const capability = tool.skillSync;
    const mode = capability?.mode ?? "unsupported";

    if (mode === "unsupported") {
      targets.push({ tool: tool.id, mode, state: "unsupported" });
      continue;
    }

    if (mode === "managed-block") {
      targets.push({
        tool: tool.id,
        mode,
        path: capability?.targetPath?.(root, BUILT_IN_SKILL_ID),
        state: "managed-block",
      });
      continue;
    }

    for (const skill of selected) {
      const targetPath = capability?.targetPath?.(root, skill.id);
      if (!targetPath) {
        targets.push({ tool: tool.id, mode, skillId: skill.id, state: "unsupported" });
        continue;
      }

      const content = await readUtf8IfExists(targetPath);
      let state: "ok" | "missing" | "drift" = "missing";
      if (content !== null && skill.hash) {
        state = targetHasHash(content, skill.hash, mode) ? "ok" : "drift";
      }
      targets.push({ tool: tool.id, mode, skillId: skill.id, path: targetPath, state });
    }
  }

  return { sourceDir, selected, targets };
}

export async function removeSyncedSkillsForTools(
  projectRoot: string,
  tools: ToolId[],
): Promise<Array<{ path: string; kind: string; changed: boolean }>> {
  const root = resolve(projectRoot);
  const writes: Array<{ path: string; kind: string; changed: boolean }> = [];
  const selectedIds = await listCanonicalSkillIds(skillSourceDir(root));

  for (const toolId of tools) {
    const tool = SUPPORTED_TOOLS.find((item) => item.id === toolId);
    const capability = tool?.skillSync;
    if (!capability || capability.mode === "unsupported" || capability.mode === "managed-block") {
      continue;
    }

    for (const skillId of selectedIds) {
      const targetPath = capability.targetPath?.(root, skillId);
      if (!targetPath) {
        continue;
      }

      const changed = await removePath(targetPath);
      writes.push({ path: targetPath, kind: `skill:${toolId}:${skillId}`, changed });
    }
  }

  return writes;
}

export function renderSyncedSkillsBlock(selected: SkillSelection[]): string[] {
  if (selected.length === 0) {
    return [];
  }

  return [
    "## Synced Skills",
    "- Canonical project skills live in `.xtctx/skills`.",
    "- If a task matches a synced skill, read that skill file before following it.",
    ...selected.map((skill) => `- ${skill.id}: \`.xtctx/skills/${skill.id}/SKILL.md\``),
    "",
  ];
}

function resolveSelectedSkillIds(existing: ExistingSkillConfig, explicit?: string[]): string[] {
  const ids = explicit && explicit.length > 0 ? explicit : existing.selectedIds;
  return uniqueIds([BUILT_IN_SKILL_ID, ...ids]);
}

async function readSelectedSkills(sourceDir: string, selectedIds: string[]): Promise<SkillSelection[]> {
  const selected: SkillSelection[] = [];
  for (const id of selectedIds) {
    const path = join(sourceDir, id, "SKILL.md");
    const content = await readUtf8IfExists(path);
    if (content === null) {
      continue;
    }
    selected.push({ id, path, source: toPosixPath(path), hash: hashContent(content) });
  }
  return selected;
}

async function syncSkillToTarget(input: {
  skill: SkillSelection;
  mode: SkillSyncMode;
  targetPath: string;
  containWithin: string;
}): Promise<{ path: string; changed: boolean }> {
  const content = await readFile(input.skill.path, "utf-8");
  const parsed = parseSkillContent(input.skill.id, content, input.skill.path, "xtctx");
  const rendered = renderTargetContent({
    skill: parsed,
    sourceHash: input.skill.hash,
    mode: input.mode,
    content,
  });
  return {
    path: input.targetPath,
    changed: await writeIfChanged(input.targetPath, rendered, input.containWithin),
  };
}

function renderTargetContent(input: {
  skill: DiscoveredSkill;
  sourceHash: string;
  mode: SkillSyncMode;
  content: string;
}): string {
  if (input.mode === "native-skill") {
    return `${normalizeNewlines(input.content).trimEnd()}\n`;
  }

  const title = input.skill.name || input.skill.id;
  const header = [
    "<!-- xtctx:skill begin -->",
    `<!-- xtctx:skill-id ${input.skill.id} -->`,
    `<!-- xtctx:skill-hash ${input.sourceHash} -->`,
    "Generated by xtctx setup. Do not edit this file directly.",
    "",
  ].join("\n");
  const body = stripFrontmatter(input.content).trim();
  const footer = "\n\n<!-- xtctx:skill end -->\n";

  if (input.mode === "rule-adapter") {
    return [
      "---",
      `description: ${quoteYamlString(`${input.skill.description} Synced from xtctx project skills.`)}`,
      'globs: "**/*"',
      "alwaysApply: false",
      "---",
      "",
      header,
      `# ${title}`,
      "",
      body,
      footer,
    ].join("\n");
  }

  if (input.mode === "instruction-adapter") {
    return [
      "---",
      'applyTo: "**"',
      "---",
      "",
      header,
      `# ${title}`,
      "",
      body,
      footer,
    ].join("\n");
  }

  switch (input.mode) {
    case "managed-block":
    case "unsupported":
      return input.content;
    default: {
      const _exhaustive: never = input.mode;
      void _exhaustive;
      return input.content;
    }
  }
}

function targetHasHash(content: string, hash: string, mode: SkillSyncMode): boolean {
  if (mode === "native-skill") {
    return hashContent(content.replace(/\n?$/, "\n")) === hash;
  }

  const match = SKILL_HASH_PATTERN.exec(content);
  return match?.[1] === hash;
}

async function readExistingSkillConfig(configPath: string): Promise<ExistingSkillConfig> {
  const raw = await readUtf8IfExists(configPath);
  if (raw === null) {
    return { selectedIds: [] };
  }

  try {
    const parsed = parseYaml(raw) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.skills) || !isRecord(parsed.skills.selected)) {
      return { selectedIds: [] };
    }

    return { selectedIds: Object.keys(parsed.skills.selected) };
  } catch {
    return { selectedIds: [] };
  }
}

async function readSkillDir(root: string, source: string): Promise<DiscoveredSkill[]> {
  if (!(await pathExists(root))) {
    return [];
  }

  const entries = await readdir(root, { withFileTypes: true });
  const skills: DiscoveredSkill[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const skillId = normalizeSkillId(entry.name);
    if (!skillId) {
      continue;
    }

    const skillPath = join(root, entry.name, "SKILL.md");
    const content = await readUtf8IfExists(skillPath);
    if (!content) {
      continue;
    }

    skills.push(parseSkillContent(skillId, content, skillPath, source));
  }

  return skills;
}

function parseSkillContent(id: string, content: string, path: string, source: string): DiscoveredSkill {
  const frontmatter = /^---\n([\s\S]*?)\n---\n?/.exec(normalizeNewlines(content));
  let name = id;
  let description = `Synced project skill ${id}`;

  if (frontmatter) {
    try {
      const parsed = parseYaml(frontmatter[1]) as unknown;
      if (isRecord(parsed)) {
        if (typeof parsed.name === "string" && parsed.name.trim()) {
          name = parsed.name.trim();
        }
        if (typeof parsed.description === "string" && parsed.description.trim()) {
          description = parsed.description.trim();
        }
      }
    } catch {
      // Invalid skill frontmatter should not stop setup from repairing other surfaces.
    }
  }

  return { id, name, description, path, source, content: normalizeNewlines(content) };
}

function stripFrontmatter(content: string): string {
  return normalizeNewlines(content).replace(/^---\n[\s\S]*?\n---\n?/, "");
}

function buildTargetConfig(projectRoot: string): Record<string, SkillTargetState> {
  return Object.fromEntries(
    SUPPORTED_TOOLS.map((tool) => [
      tool.id,
      {
        mode: tool.skillSync?.mode ?? "unsupported",
        path: tool.skillSync?.targetPath
          ? toProjectRelative(projectRoot, tool.skillSync.targetPath(projectRoot, BUILT_IN_SKILL_ID))
          : undefined,
      },
    ]),
  );
}

async function listCanonicalSkillIds(sourceDir: string): Promise<string[]> {
  const entries = await readSkillDir(sourceDir, "xtctx");
  return entries.map((entry) => entry.id);
}

/**
 * The handoff skill `setup` writes into `.xtctx/skills`.
 *
 * Exported because the plugin package under `plugin/` ships the same skill as
 * a committed file, and a plugin whose skill has drifted from the one setup
 * writes would tell two agents different things about the same tool.
 * @internal Reached only by tests and `scripts/sync-plugin-skill.mjs`.
 */
export function builtInHandoffSkill(): string {
  return [
    "---",
    "name: xtctx-handoff",
    "description: Retrieve cross-tool handoff context with the xtctx MCP tools. Use when switching AI coding tools, resuming work another agent started, or picking up a project without knowing what was last done in it. Works in any project the tools are available in; no xtctx setup is required.",
    "---",
    "",
    "# xtctx Handoff",
    "",
    "Use the xtctx MCP tools to retrieve recent local transcript context for this project.",
    "",
    "The project is resolved from the working directory, so these tools work whether",
    "or not `xtctx setup` has been run here. If `xtctx_continuity_status` reports the",
    "config as missing, that refers to managed instruction blocks and hooks — the",
    "retrieval tools are unaffected and worth calling anyway.",
    "",
    "## Workflow",
    "",
    "1. Call `xtctx_recent_sessions` to list recent sessions for the current project.",
    "2. Call `xtctx_session_detail` with a relevant `session_ref` before continuing the work.",
    "3. Call `xtctx_search_sessions` when keyword or semantic search is more useful than recency.",
    "4. Use `xtctx_continuity_status` only for wiring, cache, and freshness diagnostics.",
    "",
    "The first call in a project with a large history builds the index and returns",
    "with whatever has landed so far while the scan continues in the background. A",
    "thin first result means the index is still filling, not that the history is",
    "empty — call again rather than concluding there is nothing to recover.",
    "",
    "Raw transcript files remain authoritative. Do not invent a summary when raw detail is available.",
    "",
  ].join("\n");
}

function skillSourceDir(projectRoot: string): string {
  return join(projectRoot, ".xtctx", "skills");
}

function hashContent(content: string): string {
  return `${HASH_PREFIX}${createHash("sha256").update(normalizeNewlines(content).trimEnd() + "\n").digest("hex")}`;
}

/**
 * `containWithin` is passed by every caller rather than defaulted: every skill
 * write here is project-scoped, but making the root explicit is what stops a
 * later home-scoped caller from silently inheriting the wrong one.
 */
async function writeIfChanged(
  filePath: string,
  content: string,
  containWithin: string,
): Promise<boolean> {
  const normalized = normalizeNewlines(content);
  const existing = await readUtf8IfExists(filePath);
  if (existing !== null && normalizeNewlines(existing) === normalized) {
    return false;
  }

  await writeFileAtomic(filePath, normalized, { containWithin });
  return true;
}

async function removePath(path: string): Promise<boolean> {
  if (!(await pathExists(path))) {
    return false;
  }

  await rm(path, { force: true });
  return true;
}

async function readUtf8IfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function quoteYamlString(value: string): string {
  return JSON.stringify(value);
}

function normalizeSkillId(value: string): string | null {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : null;
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids.map(normalizeSkillId).filter((id): id is string => Boolean(id)))];
}

function toProjectRelative(projectRoot: string, path: string): string {
  const rel = relative(projectRoot, path);
  if (!rel.startsWith("..")) {
    return toPosixPath(rel);
  }
  return toPosixPath(path);
}

function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function normalizeNewlines(input: string): string {
  return input.replace(/\r\n/g, "\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
