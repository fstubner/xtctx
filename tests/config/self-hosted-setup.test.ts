/**
 * Setting xtctx up inside its own repo is the one case where `npx -y xtctx` is
 * actively wrong. npx resolves the *local* package, and installing it runs
 * `prepare` — which is `npm run build`, which begins by deleting `dist/`. So
 * the SessionStart hook wiped the very file the MCP config points at, and a
 * client spawning the server in that window got "Connection closed".
 *
 * The subtle half is the marker. It used to be the literal string
 * "xtctx --hook session-start", which the self-hosted command
 * (`node ./dist/src/cli/index.js …`) does not contain — so setup would have
 * appended a second hook on every run and disconnect could not have removed
 * either. These tests pin both halves.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLAUDE_HOOK_MARKER, setupProject, xtctxServerDefinition } from "@xtctx/config/setup";

/** The real package.json shape that identifies this repo. */
const SELF_PKG = JSON.stringify({
  name: "xtctx",
  version: "0.0.0-test",
  bin: { xtctx: "dist/src/cli/index.js" },
});

describe("self-hosted project detection", () => {
  let root = "";
  let home = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "xtctx-self-"));
    home = await mkdtemp(join(tmpdir(), "xtctx-self-home-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it("runs the built entry point instead of npx inside the xtctx repo", async () => {
    await writeFile(join(root, "package.json"), SELF_PKG, "utf-8");

    const def = await xtctxServerDefinition(root);

    expect(def.command).toBe("node");
    expect(def.args ?? []).toHaveLength(1);
    expect((def.args ?? []).join(" ")).toContain("cli");
    // Absolute: an MCP client's cwd when spawning a server is not guaranteed
    // to be the project root, unlike a Claude Code hook's.
    expect((def.args ?? [])[0]?.startsWith(root)).toBe(true);
  });

  it("uses npx everywhere else", async () => {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "some-app", version: "1.0.0" }),
      "utf-8",
    );

    const def = await xtctxServerDefinition(root);

    expect(def.command).toBe("npx");
    expect(def.args).toEqual(["-y", "xtctx"]);
  });

  it("uses npx for a project merely named xtctx without this package's bin", async () => {
    // Name alone is not enough: someone else's project can be called xtctx,
    // and pointing its MCP config at a dist/ that does not exist would break
    // a working setup rather than fix one.
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "xtctx", version: "1.0.0" }),
      "utf-8",
    );

    expect((await xtctxServerDefinition(root)).command).toBe("npx");
  });

  it("uses npx when there is no package.json at all", async () => {
    expect((await xtctxServerDefinition(root)).command).toBe("npx");
  });

  it("writes a self-hosted hook and does not duplicate it on a second run", async () => {
    // The regression the marker change guards. With the old marker the
    // self-hosted command matched nothing, so every setup appended another
    // hook and the file grew without bound.
    await writeFile(join(root, "package.json"), SELF_PKG, "utf-8");
    await mkdir(join(root, ".xtctx"), { recursive: true });

    await setupProject({ projectPath: root, homeDir: home });
    const first = JSON.parse(
      await readFile(join(root, ".claude", "settings.json"), "utf-8"),
    ) as { hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> } };

    const commands = first.hooks.SessionStart.flatMap((g) => g.hooks.map((h) => h.command));
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("node ");
    expect(commands[0]).not.toContain("npx");
    // The marker has to match what setup just wrote, or nothing downstream
    // can find this hook again.
    expect(commands[0]).toContain(CLAUDE_HOOK_MARKER);

    await setupProject({ projectPath: root, homeDir: home });
    const second = JSON.parse(
      await readFile(join(root, ".claude", "settings.json"), "utf-8"),
    ) as { hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> } };

    expect(second.hooks.SessionStart.flatMap((g) => g.hooks)).toHaveLength(1);
  });

  it("matches the npx hook form too, so existing installs stay recognised", async () => {
    // Every already-configured project has the npx command written. If the
    // marker stopped matching it, setup would add a duplicate there instead.
    expect("npx -y xtctx --hook session-start --tool claude-code").toContain(
      CLAUDE_HOOK_MARKER,
    );
    expect("node ./dist/src/cli/index.js --hook session-start --tool claude-code").toContain(
      CLAUDE_HOOK_MARKER,
    );
  });
});
