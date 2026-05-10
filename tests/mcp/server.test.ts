import { describe, expect, it } from "vitest";
import { buildToolDefinitions } from "@xtctx/mcp/server";

describe("MCP Server", () => {
  it("exposes only the handoff-scope tool surface", () => {
    const toolNames = buildToolDefinitions().map((tool) => tool.name);

    expect(toolNames).toEqual([
      "xtctx_recent_sessions",
      "xtctx_session_detail",
      "xtctx_search_sessions",
      "xtctx_continuity_status",
    ]);

    expect(toolNames).not.toContain("xtctx_last_session_brief");
    expect(toolNames).not.toContain("xtctx_effective_policy");
    expect(toolNames).not.toContain("xtctx_list_configs");
    expect(toolNames).not.toContain("xtctx_get_config");
    expect(toolNames).not.toContain("xtctx_tool_preferences");
    expect(toolNames).not.toContain("xtctx_search");
    expect(toolNames).not.toContain("xtctx_project_knowledge");
    expect(toolNames).not.toContain("xtctx_save_decision");
  });

  it("requires session_ref for session detail and query for search", () => {
    const tools = buildToolDefinitions();
    const detail = tools.find((tool) => tool.name === "xtctx_session_detail");
    const search = tools.find((tool) => tool.name === "xtctx_search_sessions");

    expect(detail?.inputSchema.required).toEqual(["session_ref"]);
    expect(search?.inputSchema.required).toEqual(["query"]);
  });
});
