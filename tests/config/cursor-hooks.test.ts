import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installCursorHook, removeCursorHook } from "@xtctx/config/cursor-hooks";

describe("cursor hooks", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "xtctx-cursor-hook-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("installs .cursor/hooks.json sessionStart hook and removes the file cleanly when empty on disconnect", async () => {
    const first = await installCursorHook(root);
    expect(first).toEqual({ changed: true });

    const parsed = JSON.parse(await readFile(join(root, ".cursor", "hooks.json"), "utf-8")) as {
      version: number;
      hooks: { sessionStart: Array<{ command: string }> };
    };
    expect(parsed.version).toBe(1);
    expect(parsed.hooks.sessionStart).toHaveLength(1);
    expect(parsed.hooks.sessionStart[0].command).toContain("--hook session-start --tool cursor");

    const second = await installCursorHook(root);
    expect(second).toEqual({ changed: false });

    const removed = await removeCursorHook(root);
    expect(removed).toBe(true);
    expect(existsSync(join(root, ".cursor", "hooks.json"))).toBe(false);
  });

  it("preserves user hooks and other hook events across install and disconnect", async () => {
    await mkdir(join(root, ".cursor"), { recursive: true });
    await writeFile(
      join(root, ".cursor", "hooks.json"),
      JSON.stringify({
        version: 1,
        hooks: {
          sessionStart: [{ command: "./custom-start.sh" }],
          preToolUse: [{ command: "./guard.sh", matcher: "Shell" }],
        },
      }),
      "utf-8",
    );

    await installCursorHook(root);
    const afterInstall = JSON.parse(await readFile(join(root, ".cursor", "hooks.json"), "utf-8")) as {
      hooks: { sessionStart: Array<{ command: string }>; preToolUse: Array<{ command: string }> };
    };
    expect(afterInstall.hooks.sessionStart).toHaveLength(2);
    expect(afterInstall.hooks.preToolUse).toEqual([{ command: "./guard.sh", matcher: "Shell" }]);

    await removeCursorHook(root);
    const afterRemove = JSON.parse(await readFile(join(root, ".cursor", "hooks.json"), "utf-8")) as {
      hooks: { sessionStart: Array<{ command: string }>; preToolUse: Array<{ command: string }> };
    };
    expect(afterRemove.hooks.sessionStart).toEqual([{ command: "./custom-start.sh" }]);
    expect(afterRemove.hooks.preToolUse).toEqual([{ command: "./guard.sh", matcher: "Shell" }]);
  });

  it("refuses to overwrite unparsable .cursor/hooks.json", async () => {
    await mkdir(join(root, ".cursor"), { recursive: true });
    await writeFile(join(root, ".cursor", "hooks.json"), "{ invalid json", "utf-8");

    const res = await installCursorHook(root);
    expect(res.changed).toBe(false);
    expect(res.failure).toMatch(/Failed to parse/);
    expect(await readFile(join(root, ".cursor", "hooks.json"), "utf-8")).toBe("{ invalid json");
  });
});
