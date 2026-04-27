import { resolve } from "node:path";
import { KnowledgeRepository } from "../knowledge/repository.js";
import type { SessionSummary } from "../mcp/tools/sessions.js";
import { createProjectServices } from "../runtime/services.js";

export interface ContextOptions {
  projectPath?: string;
  tool?: string;
  sections?: string[];
  watch?: boolean;
  watchIntervalMs?: number;
}

export interface RecentContextOptions {
  projectPath?: string;
  tool?: string;
  watch?: boolean;
  watchIntervalMs?: number;
  limit?: number;
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

export async function runContextRecent(options: RecentContextOptions = {}): Promise<void> {
  const projectRoot = resolve(options.projectPath ?? process.cwd());
  const services = await createProjectServices(projectRoot);
  const limit = options.limit && options.limit > 0 ? Math.floor(options.limit) : 10;
  const filter = options.tool ? [options.tool] : undefined;

  const renderOnce = async (): Promise<string> => {
    const sessions = await services.sessions.listRecentSessions(limit, filter);
    return formatRecentTable(sessions, limit);
  };

  if (!options.watch) {
    process.stdout.write((await renderOnce()) + "\n");
    return;
  }

  const intervalMs = Math.max(500, options.watchIntervalMs ?? 2000);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    process.stdout.write("\n");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const draw = async (): Promise<void> => {
    if (stopping) return;
    const block = await renderOnce();
    // Clear screen + move cursor home so each cycle replaces the previous render.
    process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write(`xtctx context recent --watch  (refreshing every ${intervalMs}ms, Ctrl+C to exit)\n\n`);
    process.stdout.write(block + "\n");
  };

  await draw();
  const timer: NodeJS.Timeout = setInterval(() => {
    void draw();
  }, intervalMs);
  // Keep node alive until SIGINT.
  await new Promise<void>(() => {
    void timer;
  });
}

function formatRecentTable(sessions: SessionSummary[], limit: number): string {
  if (sessions.length === 0) {
    return `(no recent sessions; ingestion may not have run yet)`;
  }

  const headers = ["TOOL", "STARTED", "MSGS", "REF", "SUMMARY"];
  const rows = sessions.slice(0, limit).map((session) => [
    session.tool,
    formatDate(session.started_at),
    session.message_count != null ? String(session.message_count) : "—",
    truncate(session.session_ref, 32),
    truncate(session.summary ?? "", 60),
  ]);

  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => row[i]!.length)),
  );

  const formatRow = (cells: string[]): string =>
    cells.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd();

  const lines = [formatRow(headers)];
  for (const row of rows) {
    lines.push(formatRow(row));
  }
  return lines.join("\n");
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || "—";
  return d.toISOString().slice(0, 16).replace("T", " ");
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max - 1) + "…";
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
