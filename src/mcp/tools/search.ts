import type { HybridSearchResult, SearchMode } from "../../store/search.js";

export interface SearchRunner {
  search(
    tableName: string,
    query: string,
    mode: SearchMode,
    limit: number,
  ): Promise<HybridSearchResult[]>;
}

interface SearchParams {
  query: string;
  mode?: SearchMode;
  depth?: "summary" | "detail" | "raw";
  source_filter?: string[];
  type_filter?: string[];
  time_range?: { after?: string; before?: string };
  format?: "markdown" | "json";
  limit?: number;
}

export function createSearchHandler(search: SearchRunner) {
  return async (params: SearchParams) => {
    const mode = params.mode ?? "hybrid";
    const format = params.format ?? "markdown";
    const limit = params.limit ?? 10;

    const results = await search.search("context", params.query, mode, limit);

    if (format === "markdown") {
      return formatAsMarkdown(results, params.query);
    }

    return { results };
  };
}

function formatAsMarkdown(results: any[], query: string): string {
  if (results.length === 0) {
    return `No results found for "${query}".`;
  }

  const lines = [`## ${results.length} results for "${query}"\n`];

  for (const [index, result] of results.entries()) {
    const meta = JSON.parse(result.metadata || "{}") as Record<string, unknown>;
    lines.push(`### ${index + 1}. ${String(meta.title ?? "Untitled")}`);
    lines.push(
      `**Source:** ${String(meta.source_tool ?? "unknown")} | **Score:** ${result.fusedScore?.toFixed(3)}\n`,
    );
    lines.push(result.text);

    if (meta.session_ref) {
      lines.push(`\n> Session ref: \`${String(meta.session_ref)}\``);
    }

    lines.push("\n---\n");
  }

  return lines.join("\n");
}
