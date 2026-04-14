import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { errorMessage } from "../utils/errors.js";

export interface SkillDefinition {
  name: string;
  content: string;
}

export interface SkillSyncResult {
  tool: string;
  path: string;
  updated: boolean;
  created: boolean;
  skipped: boolean;
  warning?: string;
}

export interface SkillSyncSummary {
  results: SkillSyncResult[];
  skills_loaded: number;
}

/**
 * Tools that support native skill files get content written into their
 * own format. Tools listed here have a dedicated renderer; all others
 * receive skill content embedded inside the managed instruction block
 * (handled by sync.ts renderToolContent).
 */
const NATIVE_SKILL_TOOLS: Record<
  string,
  (projectRoot: string, skill: SkillDefinition) => { path: string; content: string }
> = {
  claude: renderClaudeSkill,
  "claude-code": renderClaudeSkill,
  cursor: renderCursorSkill,
};

export function hasNativeSkillSupport(tool: string): boolean {
  return tool in NATIVE_SKILL_TOOLS;
}

/**
 * Load all skill definitions from `.xtctx/tool-config/skills/`.
 * Returns name + full markdown content for each file.
 */
export async function loadSkillDefinitions(configRoot: string): Promise<SkillDefinition[]> {
  const skillsDir = join(configRoot, "skills");
  let files: string[];
  try {
    files = await readdir(skillsDir);
  } catch {
    return [];
  }

  const skills: SkillDefinition[] = [];
  for (const file of files) {
    const ext = extname(file);
    if (!ext || ![".md", ".yaml", ".yml", ".txt"].includes(ext)) {
      continue;
    }

    const name = file.slice(0, file.length - ext.length);
    if (!name) continue;

    try {
      const content = await readFile(join(skillsDir, file), "utf-8");
      skills.push({ name, content });
    } catch {
      // Skip unreadable files
    }
  }

  return skills;
}

/**
 * Sync skill content into native formats for tools that support them.
 * Called as Phase 3 of the sync pipeline.
 */
export async function syncToolSkills(
  projectRoot: string,
  skills: SkillDefinition[],
  enabledTools: string[],
): Promise<SkillSyncSummary> {
  const results: SkillSyncResult[] = [];

  for (const tool of enabledTools) {
    const renderer = NATIVE_SKILL_TOOLS[tool];
    if (!renderer) continue;

    for (const skill of skills) {
      const { path, content } = renderer(projectRoot, skill);
      const result = await writeSkillFile(tool, path, content);
      results.push(result);
    }
  }

  return { results, skills_loaded: skills.length };
}

function renderClaudeSkill(
  projectRoot: string,
  skill: SkillDefinition,
): { path: string; content: string } {
  const path = join(projectRoot, ".claude", "skills", skill.name, "SKILL.md");
  const content = [
    "---",
    `name: ${skill.name}`,
    `description: xtctx shared skill — ${skill.name}`,
    "---",
    "",
    skill.content.trim(),
    "",
  ].join("\n");

  return { path, content };
}

function renderCursorSkill(
  projectRoot: string,
  skill: SkillDefinition,
): { path: string; content: string } {
  const path = join(projectRoot, ".cursor", "rules", `xtctx-skill-${skill.name}.mdc`);
  const content = [
    "---",
    `description: xtctx shared skill — ${skill.name}`,
    "globs: *",
    "alwaysApply: true",
    "---",
    "",
    skill.content.trim(),
    "",
  ].join("\n");

  return { path, content };
}

async function writeSkillFile(
  tool: string,
  filePath: string,
  content: string,
): Promise<SkillSyncResult> {
  try {
    let existing: string | null = null;
    try {
      existing = await readFile(filePath, "utf-8");
    } catch {
      // File doesn't exist yet
    }

    if (existing !== null && normalizeNewlines(existing) === normalizeNewlines(content)) {
      return { tool, path: filePath, updated: false, created: false, skipped: true };
    }

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf-8");

    return {
      tool,
      path: filePath,
      updated: existing !== null,
      created: existing === null,
      skipped: false,
    };
  } catch (error) {
    return {
      tool,
      path: filePath,
      updated: false,
      created: false,
      skipped: false,
      warning: `Failed to write skill file: ${errorMessage(error)}`,
    };
  }
}

function normalizeNewlines(input: string): string {
  return input.replace(/\r\n/g, "\n");
}
