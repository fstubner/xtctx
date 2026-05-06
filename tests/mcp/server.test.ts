import { describe, it, expect } from "vitest";
import { buildToolDefinitions } from "@xtctx/mcp/server";

describe("MCP Server", () => {
  it("exposes the post-pivot handoff-scope tool surface", () => {
    const tools = buildToolDefinitions();
    const toolNames = tools.map((tool) => tool.name);

    // Session/handoff trio — the user-facing surface for cross-tool pickup.
    expect(toolNames).toContain("xtctx_recent_sessions");
    expect(toolNames).toContain("xtctx_session_detail");
    expect(toolNames).toContain("xtctx_last_session_brief");

    // Operational surface — continuity introspection + config queries.
    expect(toolNames).toContain("xtctx_continuity_status");
    expect(toolNames).toContain("xtctx_effective_policy");
    expect(toolNames).toContain("xtctx_list_configs");
    expect(toolNames).toContain("xtctx_get_config");
    expect(toolNames).toContain("xtctx_tool_preferences");

    // Negative assertions: durable-knowledge surface is gone.
    // (Handoff-scope only — durable knowledge belongs in construct.)
    expect(toolNames).not.toContain("xtctx_search");
    expect(toolNames).not.toContain("xtctx_project_knowledge");
    expect(toolNames).not.toContain("xtctx_save_decision");
    expect(toolNames).not.toContain("xtctx_save_error_solution");
    expect(toolNames).not.toContain("xtctx_save_insight");
    expect(toolNames).not.toContain("xtctx_save_faq");
  });

  it("xtctx_last_session_brief has the expected parameter schema", () => {
    const tools = buildToolDefinitions();
    const brief = tools.find((tool) => tool.name === "xtctx_last_session_brief");
    const props = brief?.inputSchema.properties as Record<string, unknown>;

    expect(props).toHaveProperty("current_tool");
    expect(props).toHaveProperty("format");
    expect(props).toHaveProperty("stale_threshold_days");
  });
});
