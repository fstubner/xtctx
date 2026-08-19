import type { SessionService } from "../../handoff/types.js";
import { sanitizeErrorMessage } from "../../utils/errors.js";

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
        embedding_error: status.embedding_error
          ? sanitizeErrorMessage(status.embedding_error)
          : null,
        tools: status.tools.map((tool) => ({
          tool: tool.tool,
          detected: tool.detected,
          // Scrape errors quote the store path they failed on, which is
          // machine-wide (home directory layout) like store_paths above.
          last_error: tool.last_error ? sanitizeErrorMessage(tool.last_error) : null,
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
      const error = tool.last_error
        ? `, last scrape error: ${sanitizeErrorMessage(tool.last_error)}`
        : "";
      lines.push(
        `- ${tool.tool}: ${detected}, ${tool.indexed_sessions} sessions, ` +
          `${tool.indexed_messages} messages${error}`,
      );
    }

    return lines.join("\n");
  };
}
