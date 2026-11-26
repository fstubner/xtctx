/**
 * Extracts skill activations from transcript tool calls and commands.
 *
 * Detects:
 * - Claude Code first-class `Skill` tool calls.
 * - Tool calls (read_file, view_file, Read, read_resource, read_mcp_resource) reading a `SKILL.md`.
 * - Shell commands inspecting or running a `SKILL.md`.
 */

const SKILL_FILE_REGEX = /(?:^|[\s"'`\\/])([a-z0-9][-a-z0-9_]*)[\\/]SKILL\.md\b/i;

function extractSkillFromText(text: string): string | null {
  if (!text || typeof text !== "string") return null;
  const match = SKILL_FILE_REGEX.exec(text);
  if (!match) return null;
  const candidate = match[1].toLowerCase();
  // Filter out non-skill path segments if any
  if (candidate === "skills" || candidate === "builtin" || candidate === "agents") return null;
  return candidate;
}

function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) stringsIn(item, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) stringsIn(v, out);
  }
  return out;
}

export interface ToolCallPayload {
  name?: string;
  args?: unknown;
  input?: unknown;
}

/**
 * Extracts distinct skill names from tool calls or string arguments.
 */
export function extractSkillsFromToolCalls(toolCalls?: ToolCallPayload[]): string[] | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined;
  const skills = new Set<string>();

  for (const call of toolCalls) {
    if (!call) continue;
    const name = call.name ?? "";

    // 1. First-class Skill tool invocation (Claude Code)
    if (name === "Skill") {
      const args = (call.args || call.input) as Record<string, unknown> | undefined;
      const raw = args?.skill ?? args?.name ?? args?.skill_name;
      if (typeof raw === "string" && raw.trim()) {
        skills.add(raw.trim().toLowerCase());
        continue;
      }
    }

    // 2. File reads or commands targeting a SKILL.md
    const allStrings = stringsIn(call.args ?? call.input);
    for (const str of allStrings) {
      const found = extractSkillFromText(str);
      if (found) skills.add(found);
    }
  }

  return skills.size > 0 ? Array.from(skills).sort() : undefined;
}

/**
 * Extracts skills mentioned or read in raw text (e.g. bash commands or transcript turns).
 */
export function extractSkillsFromText(content: string): string[] | undefined {
  if (!content || !content.includes("SKILL.md")) return undefined;
  const skills = new Set<string>();
  const matches = content.matchAll(new RegExp(SKILL_FILE_REGEX.source, "gi"));
  for (const m of matches) {
    const candidate = m[1].toLowerCase();
    if (candidate !== "skills" && candidate !== "builtin" && candidate !== "agents") {
      skills.add(candidate);
    }
  }
  return skills.size > 0 ? Array.from(skills).sort() : undefined;
}
