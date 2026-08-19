import type { SessionService } from "../../handoff/types.js";

interface ContinuityStatusParams {
  format?: "markdown" | "json";
}

export function createContinuityStatusHandler(service: SessionService) {
  return async (raw: Record<string, unknown> = {}) => {
    const params = raw as unknown as ContinuityStatusParams;
    const status = await service.getStatus();

    if (params.format === "json") {
      // Deliberate allowlist: store_paths are machine-wide absolute paths
      // (home directory layout) that the model-facing surface must not leak.
      // The markdown branch below omits them for the same reason.
      return {
        ...status,
        tools: status.tools.map((tool) => ({
          tool: tool.tool,
          detected: tool.detected,
          last_error: tool.last_error,
          indexed_sessions: tool.indexed_sessions,
          indexed_messages: tool.indexed_messages,
          last_indexed_at: tool.last_indexed_at,
        })),
      };
    }

    const lines = [
      "## xtctx Continuity Status",
      "",
      `- Project root: ${status.project_root}`,
      `- Index: ${status.db_path}`,
      `- Last scan: ${status.last_scan_at ?? "never"}`,
      `- Sessions: ${status.sessions}`,
      `- Messages: ${status.messages}`,
      `- Retrieval windows: ${status.retrieval_units}`,
      `- Vectorized windows: ${status.vectorized_units}`,
      `- Vector model: ${status.vector_model}`,
      ...(status.embedding_error
        ? [`- Semantic search unavailable (keyword only): ${status.embedding_error}`]
        : []),
      "",
      "### Tools",
    ];

    for (const tool of status.tools) {
      const detected = tool.detected ? "detected" : "not detected";
      const error = tool.last_error ? `, last scrape error: ${tool.last_error}` : "";
      lines.push(
        `- ${tool.tool}: ${detected}, ${tool.indexed_sessions} sessions, ` +
          `${tool.indexed_messages} messages${error}`,
      );
    }

    return lines.join("\n");
  };
}
