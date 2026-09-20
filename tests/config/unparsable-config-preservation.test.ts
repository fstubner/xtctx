/**
 * What setup and disconnect do with a file they cannot parse.
 *
 * The rule the rest of the codebase already follows: a file that fails to
 * parse is left alone and reported. `mcp-config.ts` does exactly that --
 * "Failed to parse existing MCP config; leaving it unchanged". Two paths did
 * not, and both destroyed the file instead.
 *
 * `readJsonIfExists` returns `null` for a missing file AND for an unparsable
 * one, so a caller that treats `null` as "nothing there yet" writes a fresh
 * document over whatever the user had. In `.claude/settings.json` that is
 * their hooks, env, model and permissions -- gone because of a trailing comma.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installClaudeHook } from "@xtctx/config/claude-settings";

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "xtctx-unparsable-"));
  await mkdir(join(projectRoot, ".claude"), { recursive: true });
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

describe("installClaudeHook with an unparsable settings file", () => {
  /**
   * A real settings.json people write by hand: a trailing comma. Everything
   * in it is the user's, and none of it is recoverable once overwritten.
   */
  const HAND_WRITTEN = `{
  "model": "opus",
  "env": { "FOO": "bar" },
  "permissions": { "deny": ["Bash(rm:*)"] },
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "echo mine" }] }
    ],
  }
}
`;

  it("leaves the file byte-for-byte and reports the failure", async () => {
    const settingsPath = join(projectRoot, ".claude", "settings.json");
    await writeFile(settingsPath, HAND_WRITTEN, "utf-8");

    const result = await installClaudeHook(projectRoot);

    expect(await readFile(settingsPath, "utf-8")).toBe(HAND_WRITTEN);
    expect(result.failure).toMatch(/parse/i);
    expect(result.changed).toBe(false);
  });

  it("still writes a fresh file when there is genuinely nothing there", async () => {
    const settingsPath = join(projectRoot, ".claude", "settings.json");

    const result = await installClaudeHook(projectRoot);

    expect(result.failure).toBeUndefined();
    expect(result.changed).toBe(true);
    const written = JSON.parse(await readFile(settingsPath, "utf-8")) as {
      hooks: { SessionStart: unknown[] };
    };
    expect(written.hooks.SessionStart).toHaveLength(1);
  });

  it("keeps the user's own settings when the file parses", async () => {
    const settingsPath = join(projectRoot, ".claude", "settings.json");
    await writeFile(
      settingsPath,
      JSON.stringify({ model: "opus", env: { FOO: "bar" } }, null, 2),
      "utf-8",
    );

    const result = await installClaudeHook(projectRoot);

    expect(result.failure).toBeUndefined();
    const written = JSON.parse(await readFile(settingsPath, "utf-8")) as {
      model: string;
      env: Record<string, string>;
    };
    expect(written.model).toBe("opus");
    expect(written.env).toEqual({ FOO: "bar" });
  });
});
