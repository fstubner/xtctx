import type { SessionService } from "../../handoff/types.js";

interface ContinuityStatusParams {
  format?: "markdown" | "json";
}

export function createContinuityStatusHandler(service: SessionService) {
  return async (raw: Record<string, unknown> = {}) => {
    const params = raw as unknown as ContinuityStatusParams;
    const status = await service.getStatus();

    if (params.format === "json") {
      return status;
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
      "",
      "### Tools",
    ];

    for (const tool of status.tools) {
      const detected = tool.detected ? "detected" : "not detected";
      lines.push(
        `- ${tool.tool}: ${detected}, ${tool.indexed_sessions} sessions, ` +
          `${tool.indexed_messages} messages`,
      );
    }

    return lines.join("\n");
  };
}
