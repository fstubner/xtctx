import { resolve } from "node:path";
import { createProjectServices } from "../runtime/services.js";
import type { ContextRecord, ContextType } from "../types/context.js";
import { CONTEXT_TYPES } from "../types/context.js";

export interface KnowledgeLsOptions {
  projectPath?: string;
  type?: string;
  query?: string;
  limit?: number;
}

export async function runKnowledgeLs(options: KnowledgeLsOptions = {}): Promise<void> {
  const projectRoot = resolve(options.projectPath ?? process.cwd());
  const services = await createProjectServices(projectRoot);
  const all = await services.knowledge.listAll();

  const filtered = filterRecords(all, options.type, options.query);
  const limit = parseLimit(options.limit);
  const rows = limit ? filtered.slice(0, limit) : filtered;

  if (rows.length === 0) {
    process.stdout.write("No matching knowledge records.\n");
    return;
  }

  printTable(rows);
  if (filtered.length > rows.length) {
    process.stdout.write(`\n... ${filtered.length - rows.length} more (use --limit to widen).\n`);
  }
}

function filterRecords(
  records: ContextRecord[],
  typeFilter: string | undefined,
  query: string | undefined,
): ContextRecord[] {
  let out = records;

  if (typeFilter && typeFilter !== "all") {
    if (!CONTEXT_TYPES.includes(typeFilter as ContextType)) {
      throw new Error(
        `Unknown --type '${typeFilter}'. Valid: ${[...CONTEXT_TYPES, "all"].join(", ")}.`,
      );
    }
    out = out.filter((record) => record.type === typeFilter);
  }

  if (query && query.trim().length > 0) {
    const needle = query.trim().toLowerCase();
    out = out.filter((record) => record.title.toLowerCase().includes(needle));
  }

  return out;
}

function parseLimit(input: number | string | undefined): number | null {
  if (input == null) return 50;
  const numeric = typeof input === "number" ? input : Number(input);
  if (!Number.isFinite(numeric) || numeric <= 0) return 50;
  return Math.floor(numeric);
}

function printTable(records: ContextRecord[]): void {
  const headers = ["TYPE", "TITLE", "AGE", "SOURCE"];
  const rows = records.map((record) => [
    record.type,
    truncate(record.title, 60),
    formatAge(record.created_at),
    record.source_tool || "—",
  ]);

  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => row[i]!.length)),
  );

  const formatRow = (cells: string[]): string =>
    cells.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd();

  process.stdout.write(formatRow(headers) + "\n");
  for (const row of rows) {
    process.stdout.write(formatRow(row) + "\n");
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max - 1) + "…";
}

function formatAge(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours >= 1) return `${hours}h`;
  const minutes = Math.floor(ms / (60 * 1000));
  if (minutes >= 1) return `${minutes}m`;
  return "<1m";
}
