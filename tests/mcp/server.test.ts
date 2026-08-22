import { describe, expect, it } from "vitest";
import { buildToolDefinitions, startMcpServer } from "@xtctx/mcp/server";

describe("MCP Server", () => {
  it("exposes only the handoff-scope tool surface", () => {
    const toolNames = buildToolDefinitions().map((tool) => tool.name);

    expect(toolNames).toEqual([
      "xtctx_recent_sessions",
      "xtctx_session_detail",
      "xtctx_search_sessions",
      "xtctx_continuity_status",
      "xtctx_handoff_manifest",
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
    const manifest = tools.find((tool) => tool.name === "xtctx_handoff_manifest");

    expect(detail?.inputSchema.required).toEqual(["session_ref"]);
    expect(search?.inputSchema.required).toEqual(["query"]);
    expect(manifest?.inputSchema.required).toBeUndefined();
  });
});

/**
 * An MCP host ends a server by closing stdin. `server.onclose` does not fire
 * for that, so the shutdown callback never ran and the process lived on until
 * the event loop happened to drain — measured at 69-108 seconds while a scan
 * of every transcript store on the machine finished. A host that starts a
 * server per agent session accumulates those.
 */
describe("startMcpServer shutdown wiring", () => {
  it("runs the close callback when stdin ends", async () => {
    let closes = 0;
    await startMcpServer({}, () => {
      closes += 1;
    });

    try {
      process.stdin.emit("end");

      expect(closes).toBe(1);
    } finally {
      process.stdin.removeAllListeners("end");
      process.stdin.removeAllListeners("close");
      process.stdin.pause();
    }
  });
});
