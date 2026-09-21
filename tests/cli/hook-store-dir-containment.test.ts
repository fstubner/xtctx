/**
 * The hook must not let its stdin choose which directory is a project's
 * transcript store.
 *
 * `transcript_path` arrives on stdin from the host tool, and `dirname()` of it
 * was recorded verbatim into `.xtctx/state/store-dirs.json` as this project's
 * claude-code store, then read on every later scan. Nothing checked where it
 * pointed.
 *
 * Reproduced before the fix: a payload whose `transcript_path` was
 * `<project>/../../../../../../evil/x.jsonl` recorded `C:\...\evil` as the
 * store. The scraper then reads a recorded store dir with
 * `exactDirectory: true` — precisely the mode that lets a record carrying no
 * `cwd` through the ownership check — so an attacker-chosen directory's
 * contents were served back as this project's own history, to the next agent,
 * with no provenance check.
 *
 * The `cwd` guard elsewhere in the hook does not cover this: it validates a
 * different field, and a payload can name this project in `cwd` while pointing
 * `transcript_path` anywhere at all. That is exactly the shape used here.
 *
 * Containment against the tool's own store root is the check that fits,
 * because a real value always sits under it as
 * `<store>/<encoded-project>/<id>.jsonl`.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHook } from "@xtctx/cli/hook";
import { defaultClaudeProjectsDir } from "@xtctx/tools/sources";

describe("the store directory a hook payload names", () => {
  let projectRoot = "";
  let statePath = "";
  const realStdin = process.stdin;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "xtctx-hook-store-"));
    await mkdir(join(projectRoot, ".xtctx", "state"), { recursive: true });
    await writeFile(
      join(projectRoot, ".xtctx", "config.yaml"),
      "tools:\n  claude-code:\n    enabled: true\n",
      "utf-8",
    );
    statePath = join(projectRoot, ".xtctx", "state", "store-dirs.json");
  });

  afterEach(async () => {
    Object.defineProperty(process, "stdin", { value: realStdin, configurable: true });
    await rm(projectRoot, { recursive: true, force: true });
  });

  /** Feed the hook a payload the way a host tool does, and report what it kept. */
  async function recordedStoreDir(transcriptPath: string): Promise<string | undefined> {
    await rm(statePath, { force: true });

    const payload = JSON.stringify({ cwd: projectRoot, transcript_path: transcriptPath });
    const stdin = Object.assign(
      (async function* () {
        yield payload;
      })(),
      {
        isTTY: false,
        setEncoding() {},
        on(event: string, handler: (chunk?: string) => void) {
          if (event === "data") handler(payload);
          if (event === "end") handler();
          return this;
        },
        removeAllListeners() {
          return this;
        },
        // A real stdin has these, and the hook now uses them to stop the
        // stream holding the event loop open. A double that omits them makes
        // the product code untestable rather than the product wrong.
        pause() {
          return this;
        },
        destroy() {
          return this;
        },
      },
    );
    Object.defineProperty(process, "stdin", { value: stdin, configurable: true });

    await runHook({ projectPath: projectRoot, tool: "claude-code", event: "session-start" });

    const raw = await readFile(statePath, "utf-8").catch(() => null);
    return raw ? (JSON.parse(raw) as Record<string, string>)["claude-code"] : undefined;
  }

  it("refuses a path that walks out of the store root", async () => {
    const escaped = join(projectRoot, "..", "..", "..", "..", "xtctx-evil-store", "x.jsonl");

    expect(await recordedStoreDir(escaped)).toBeUndefined();
  });

  it("refuses a path somewhere else entirely", async () => {
    expect(await recordedStoreDir(join(tmpdir(), "not-a-store", "x.jsonl"))).toBeUndefined();
  });

  it("follows CLAUDE_CONFIG_DIR when the tree has been moved", async () => {
    // The variable moves the whole `.claude` tree. The containment root is
    // built from the same helper, so a hook comment claiming this was followed
    // while nothing read it meant the real transcript path fell outside the
    // root, the payload was dropped, and the scraper then searched a
    // `~/.claude` holding nothing — the exact case the payload exists for.
    const moved = join(tmpdir(), "xtctx-claude-config-dir");
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = moved;
    try {
      const genuine = join(moved, "projects", "h--some-project", "abc.jsonl");
      expect(await recordedStoreDir(genuine)).toBe(
        join(moved, "projects", "h--some-project"),
      );
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });

  it("still records a genuine claude-code transcript path", async () => {
    // The case the payload exists for. Rejecting this too would be a "fix"
    // that silently turns the optimisation off for everyone.
    const genuine = join(defaultClaudeProjectsDir(), "h--some-project", "abc.jsonl");

    expect(await recordedStoreDir(genuine)).toBe(join(defaultClaudeProjectsDir(), "h--some-project"));
  });
});
