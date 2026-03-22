import { resolve } from "node:path";
import { KnowledgeRepository } from "../knowledge/repository.js";
import type { SessionSummary } from "../mcp/tools/sessions.js";
import { createProjectServices } from "../runtime/services.js";

export interface ContextOptions {
  projectPath?: string;
  tool?: string;
  sections?: string[];
}

const DEFAULT_SECTIONS = ["sessions", "knowledge", "nudge"] as const;
type ContextSection = (typeof DEFAULT_SECTIONS)[number];

export async function runContext(options: ContextOptions = {}): Promise<void> {
  const projectRoot = resolve(options.projectPath ?? process.cwd());
  const services = await createProjectServices(projectRoot);
  const sections = parseSections(options.sections);
  const parts: string[] = [];

  if (sections.has("sessions")) {
    const sessionBlock = await renderSessions(services.sessions, options.tool);
    if (sessionBlock) {
      parts.push(sessionBlock);
    }
  }

  if (sections.has("knowledge")) {
    const knowledgeBlock = await renderKnowledge(services.knowledge);
    if (knowledgeBlock) {
      parts.push(knowledgeBlock);
    }
  }

  if (sections.has("nudge")) {
    parts.push(renderNudge());
  }

  if (parts.length > 0) {
    process.stdout.write(parts.join("\n\n") + "\n");
  }
}

function parseSections(input?: string[]): Set<ContextSection> {
  if (!input || input.length === 0) {
    return new Set(DEFAULT_SECTIONS);
  }

  const valid = new Set<ContextSection>();
  for (const s of input) {
    if (DEFAULT_SECTIONS.includes(s as ContextSection)) {
      valid.add(s as ContextSection);
    }
  }
  return valid.size > 0 ? valid : new Set(DEFAULT_SECTIONS);
}

async function renderSessions(
  sessions: { listRecentSessions(limit: number, toolFilter?: string[]): Promise<SessionSummary[]> },
  tool?: string,
): Promise<string | null> {
  const filter = tool ? [tool] : undefined;
  const recent = await sessions.listRecentSessions(3, filter);
  if (recent.length === 0) {
    return null;
  }

  const lines = ["## Recent sessions"];
  for (const session of recent) {
    const ref = session.session_ref;
    const tool = session.tool;
    const date = session.started_at;
    const summary = session.summary ?? "";

    lines.push(`\n### ${ref} (${tool}, ${date})`);
    if (summary) {
      lines.push(summary);
    }
  }

  return lines.join("\n");
}

async function renderKnowledge(knowledge: KnowledgeRepository): Promise<string | null> {
  const records = await knowledge.listAll();
  if (records.length === 0) {
    return null;
  }

  const lines = ["## Project knowledge"];
  const grouped = new Map<string, typeof records>();
  for (const record of records) {
    const type = record.type;
    if (!grouped.has(type)) {
      grouped.set(type, []);
    }
    grouped.get(type)!.push(record);
  }

  for (const [type, items] of grouped) {
    lines.push(`\n### ${type} (${items.length})`);
    for (const item of items.slice(0, 5)) {
      lines.push(`- **${item.title}**: ${item.body.slice(0, 120)}`);
    }
    if (items.length > 5) {
      lines.push(`- ...and ${items.length - 5} more`);
    }
  }

  return lines.join("\n");
}

function renderNudge(): string {
  return [
    "## xtctx continuity",
    "This project uses xtctx for cross-tool context. Use the xtctx MCP tools to:",
    "- Search past sessions and knowledge with `xtctx_search`",
    "- Save decisions with `xtctx_save_decision`",
    "- Save error solutions with `xtctx_save_error_solution`",
    "- Save insights with `xtctx_save_insight`",
  ].join("\n");
}
