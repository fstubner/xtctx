/**
 * The session-start hook is handed a JSON payload on stdin by the host tool,
 * and takes `transcript_path` from it as the authoritative store directory.
 * That value is worth having — it is the tool's own answer, better than
 * re-deriving a lossy path encoding — but it is also arbitrary text arriving
 * on a pipe, so it is only trustworthy when the payload is describing *this*
 * project.
 *
 * The guard that checks this was wrong twice over, and both mistakes are only
 * visible when the real binary runs the real wiring:
 *
 *  - It compared `payload.cwd` against a project root *derived from*
 *    `payload.cwd`, because the hook is registered without `--project`. In
 *    production that is a value compared with itself, so it never rejected. A
 *    unit test of the comparison would have passed; the defect was the wiring.
 *  - A payload with no `cwd` at all was accepted.
 *
 * So this spawns the built CLI and pipes real payloads at it. The check is
 * whether `.xtctx/state/store-dirs.json` — the file that carries the store
 * location across to the MCP server process — gets written.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sandboxEnv } from "./helpers.js";

const CLI = resolve(process.cwd(), "dist", "src", "cli", "index.js");

describe("session-start hook payload trust", () => {
  let projectRoot = "";
  let homeDir = "";
  let foreignStore = "";

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "xtctx-hookpay-"));
    homeDir = await mkdtemp(join(tmpdir(), "xtctx-hookpay-home-"));
    foreignStore = await mkdtemp(join(tmpdir(), "xtctx-hookpay-foreign-"));
    await mkdir(join(projectRoot, ".xtctx", "state"), { recursive: true });
    await writeFile(
      join(projectRoot, ".xtctx", "config.yaml"),
      ["tools:", "  claude-code:", "    enabled: true", ""].join("\n"),
      "utf-8",
    );
  });

  afterEach(async () => {
    for (const dir of [projectRoot, homeDir, foreignStore]) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /** Run the hook exactly as a host tool does: cwd at the project root. */
  function runHook(payload: unknown): Promise<number> {
    return new Promise((resolveExit, reject) => {
      const child = spawn(
        process.execPath,
        [CLI, "--hook", "session-start", "--tool", "claude-code"],
        { cwd: projectRoot, env: sandboxEnv(homeDir), stdio: ["pipe", "pipe", "pipe"] },
      );
      child.on("error", reject);
      child.stdout.resume();
      child.stderr.resume();
      child.on("close", (code) => resolveExit(code ?? 0));
      child.stdin.end(JSON.stringify(payload));
    });
  }

  async function recordedStoreDirs(): Promise<Record<string, string> | null> {
    try {
      return JSON.parse(
        await readFile(join(projectRoot, ".xtctx", "state", "store-dirs.json"), "utf-8"),
      ) as Record<string, string>;
    } catch {
      return null;
    }
  }

  it("records the store directory when the payload describes this project", async () => {
    const ours = join(homeDir, ".claude", "projects", "encoded-root");
    await mkdir(ours, { recursive: true });

    expect(
      await runHook({ cwd: projectRoot, transcript_path: join(ours, "session.jsonl") }),
    ).toBe(0);

    expect(await recordedStoreDirs()).toMatchObject({ "claude-code": ours });
  });

  it("accepts a payload naming the same directory by a different path", async () => {
    // The other direction of the same guard, and the one that reached CI
    // rather than this machine: `process.cwd()` is reported canonically by the
    // OS while the payload carries whatever the host wrote. On macOS the temp
    // directory is a symlink, so those two spellings differ on every run and a
    // lexical comparison rejected the legitimate payload the guard exists to
    // accept — silently, since the hook fails open.
    //
    // Forced here on every platform rather than left to whichever OS happens
    // to symlink its temp directory.
    const ours = join(homeDir, ".claude", "projects", "encoded-root");
    await mkdir(ours, { recursive: true });

    const link = join(homeDir, "link-to-project");
    try {
      await symlink(projectRoot, link, "dir");
    } catch {
      await symlink(projectRoot, link, "junction");
    }

    expect(await runHook({ cwd: link, transcript_path: join(ours, "session.jsonl") })).toBe(0);

    expect(await recordedStoreDirs()).toMatchObject({ "claude-code": ours });
  });

  it("does not let a payload move the hook onto another project", async () => {
    // Asserted on the *foreign* side, which is where the two behaviours
    // differ. The old guard did not poison this project — it acted on the
    // payload's project entirely, creating and reading an index there. A test
    // that only checked this project's state passed either way, which is how
    // it first read as covered.
    expect(
      await runHook({
        cwd: foreignStore,
        transcript_path: join(foreignStore, "store", "session.jsonl"),
      }),
    ).toBe(0);

    expect(existsSync(join(foreignStore, ".xtctx"))).toBe(false);
    expect(await recordedStoreDirs()).toBeNull();
  });

  it("ignores a payload with no cwd to check against", async () => {
    // Fails closed. This was accepted, and it is the easier of the two to
    // send: omit a field rather than forge one.
    expect(await runHook({ transcript_path: join(foreignStore, "store", "s.jsonl") })).toBe(0);

    expect(await recordedStoreDirs()).toBeNull();
    expect(existsSync(join(foreignStore, ".xtctx"))).toBe(false);
  });

  it("still exits 0 on a hostile payload, so the host session starts", async () => {
    // The hook runs inside the host agent's startup. Rejecting a payload must
    // never become a startup error there.
    expect(await runHook({ cwd: 42, transcript_path: ["not", "a", "string"] })).toBe(0);
  });
});
