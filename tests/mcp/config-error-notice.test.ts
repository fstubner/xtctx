/**
 * A config that will not parse is not an empty project.
 *
 * `.xtctx/config.yaml` records which transcript stores the user allowed to be
 * read, so a file that cannot be parsed yields zero scrapers rather than
 * defaults — which is the right call, and it meant every MCP tool answered
 * "No matching sessions found." An agent reads that as "this project has no
 * cross-tool history" and tells the user so, while the real answer is "xtctx
 * is reading nothing at all until you fix one file".
 *
 * `xtctx status` has printed `UNREADABLE` for a while. Agents never run the
 * CLI, and the MCP surface is the only one they see.
 */
import { describe, expect, it } from "vitest";
import { createToolHandlers } from "@xtctx/mcp/server";

const DETAILS = {
  projectRoot: "/repo",
  configPath: "/repo/.xtctx/config.yaml",
  message: "Flow sequence must end with a ] at line 2, column 1",
};

describe("an unreadable config over MCP", () => {
  it("answers every tool with the broken file rather than with nothing found", async () => {
    const handlers = createToolHandlers({ configError: DETAILS });

    expect(handlers.size).toBeGreaterThan(0);
    for (const [name, handler] of handlers) {
      const answer = String(await handler({}));

      expect(answer, name).toContain(".xtctx/config.yaml");
      expect(answer, name).toContain("Flow sequence must end with a ]");
      expect(answer, name).not.toContain("No matching sessions found");
    }
  });

  it("says the history is unread rather than absent", async () => {
    const [, handler] = [...createToolHandlers({ configError: DETAILS })][0];

    const answer = String(await handler({}));

    expect(answer).toMatch(/not an empty history/);
    expect(answer).toContain("Nothing has been changed.");
  });

  it("tells the agent not to edit the file unprompted", async () => {
    // It records which transcript stores the user allowed to be read, so an
    // agent "helpfully" rewriting it would be widening their own access.
    const [, handler] = [...createToolHandlers({ configError: DETAILS })][0];

    expect(String(await handler({}))).toMatch(/Do not edit it unprompted/);
  });

  it("leaves the not-configured case alone, which means something different", async () => {
    // Nobody opted this directory in, against somebody did and the file broke.
    const handlers = createToolHandlers({ unconfiguredProjectRoot: "/repo" });
    const [, handler] = [...handlers][0];

    expect(String(await handler({}))).toContain("not configured for xtctx");
  });
});
