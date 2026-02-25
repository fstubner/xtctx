import type { ContextRecord, ContextType } from "../../types/context.js";

export interface KnowledgeStore {
  listByType(type: ContextType): Promise<ContextRecord[]>;
  listAll(): Promise<ContextRecord[]>;
}

interface ProjectKnowledgeParams {
  type?: ContextType | "all";
  query?: string;
  format?: "markdown" | "json";
}

export function createProjectKnowledgeHandler(store: KnowledgeStore) {
  return async (params: ProjectKnowledgeParams = {}) => {
    const type = params.type ?? "all";
    const format = params.format ?? "markdown";

    const records =
      type === "all" ? await store.listAll() : await store.listByType(type);
    const filtered = filterByQuery(records, params.query);

    if (format === "json") {
      return { type, count: filtered.length, records: filtered };
    }

    return formatKnowledgeMarkdown(filtered, type, params.query);
  };
}

function filterByQuery(records: ContextRecord[], query?: string): ContextRecord[] {
  if (!query) {
    return records;
  }

  const needle = query.toLowerCase();
  return records.filter((record) => {
    return (
      record.title.toLowerCase().includes(needle) ||
      record.body.toLowerCase().includes(needle) ||
      record.domain_tags.some((tag) => tag.toLowerCase().includes(needle))
    );
  });
}

function formatKnowledgeMarkdown(
  records: ContextRecord[],
  type: ContextType | "all",
  query?: string,
): string {
  if (records.length === 0) {
    if (query) {
      return `No ${type} records found matching "${query}".`;
    }
    return `No ${type} records found.`;
  }

  const lines = [`## ${records.length} ${type} record(s)\n`];
  for (const [index, record] of records.entries()) {
    lines.push(`### ${index + 1}. ${record.title}`);
    lines.push(`- Type: ${record.type}`);
    lines.push(`- Created: ${record.created_at}`);
    lines.push(`- Source: ${record.source_tool}`);
    if (record.domain_tags.length > 0) {
      lines.push(`- Tags: ${record.domain_tags.join(", ")}`);
    }
    lines.push("");
    lines.push(record.body);
    lines.push("\n---\n");
  }

  return lines.join("\n").trim();
}
