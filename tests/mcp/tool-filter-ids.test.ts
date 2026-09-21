/**
 * A tool id that names no tool is a mistake, not a filter.
 *
 * `tool_filter` reaches SQLite as `WHERE tool IN (...)`, so an unrecognised id
 * matches nothing and the answer is "No matching sessions found." — which an
 * agent reports to the user as "there is no Claude Code history in this
 * project". A wrong id and an empty index were indistinguishable.
 *
 * The ids are also not guessable. They are `claude-code` and `antigravity`,
 * while the obvious guesses from a tool's own name are `claude` and `gemini`,
 * and the MCP schema advertised only `items: { type: "string" }`.
 */
import { describe, expect, it } from "vitest";
import { validatedFilter } from "@xtctx/mcp/tools/sessions";
import { SUPPORTED_TOOLS } from "@xtctx/tools/sources";

describe("validatedFilter", () => {
  it("accepts every id the tool registry defines", () => {
    const ids = SUPPORTED_TOOLS.map((tool) => tool.id);

    expect(validatedFilter(ids, "tool_filter")).toEqual(ids);
  });

  it("rejects the natural wrong guesses instead of matching nothing", () => {
    for (const guess of ["claude", "gemini", "vscode"]) {
      expect(() => validatedFilter([guess], "tool_filter")).toThrow(/unknown tool id/);
    }
  });

  it("names the valid ids in the error, so the caller can fix its own call", () => {
    let message = "";
    try {
      validatedFilter(["claude"], "tool_filter");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("claude-code");
    expect(message).toContain("antigravity");
  });

  it("still allows no filter at all", () => {
    expect(validatedFilter(undefined, "tool_filter")).toBeUndefined();
    expect(validatedFilter(null, "tool_filter")).toBeUndefined();
  });
});
