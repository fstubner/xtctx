import { describe, it, expect } from "vitest";
import { buildToolDefinitions } from "@xtctx/mcp/server";

describe("MCP Server", () => {
  it("exposes all expected tools", () => {
    const tools = buildToolDefinitions();
    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).toContain("xtctx_search");
    expect(toolNames).toContain("xtctx_recent_sessions");
    expect(toolNames).toContain("xtctx_session_detail");
    expect(toolNames).toContain("xtctx_project_knowledge");
    expect(toolNames).toContain("xtctx_save_decision");
    expect(toolNames).toContain("xtctx_save_error_solution");
    expect(toolNames).toContain("xtctx_save_insight");
    expect(toolNames).toContain("xtctx_list_configs");
    expect(toolNames).toContain("xtctx_get_config");
    expect(toolNames).toContain("xtctx_tool_preferences");
  });

  it("xtctx_search has correct parameter schema", () => {
    const tools = buildToolDefinitions();
    const search = tools.find((tool) => tool.name === "xtctx_search");
    const props = search?.inputSchema.properties as Record<string, unknown>;

    expect(props).toHaveProperty("query");
    expect(props).toHaveProperty("mode");
    expect(props).toHaveProperty("depth");
    expect(props).toHaveProperty("format");
  });
});
