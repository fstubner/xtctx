/**
 * The unit tests pin when the hook decides to launch a scan. This pins that
 * the launch is real: the built CLI, run exactly as a host tool runs it,
 * leaves behind a finished index that names a session from another tool —
 * after the hook itself has already returned.
 *
 * Nothing in the unit layer can see this. The launch is a detached child of
 * a process that exits immediately, and the ways that goes wrong (wrong entry
 * point, child dying with its parent, stdio kept open so the hook never
 * returns) all pass an injected launcher.
 */
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sandboxEnv, seedCodex } from "./helpers.js";

const CLI = resolve(process.cwd(), "dist", "src", "cli", "index.js");

describe("session-start hook launches a real background scan", () => {
  let projectRoot = "";
  let homeDir = "";

  beforeEach(async () => {
    // realpath, because the product canonicalises its project root and the
    // seeded session records this path as its cwd: on macOS the temp dir is a
    // symlink and on Windows CI it is an 8.3 short name, so without this the
    // scan ran, found nothing for the project, and the test failed there only.
    projectRoot = await realpath(await mkdtemp(join(tmpdir(), "xtctx-hookscan-smoke-")));
    homeDir = await mkdtemp(join(tmpdir(), "xtctx-hookscan-smoke-home-"));
    await mkdir(join(projectRoot, ".xtctx", "state"), { recursive: true });
    await writeFile(
      join(projectRoot, ".xtctx", "config.yaml"),
      ["tools:", "  codex:", "    enabled: true", ""].join("\n"),
      "utf-8",
    );
    await seedCodex(homeDir, projectRoot, "the decision only codex knows");
  });

  afterEach(async () => {
    // The scan is a detached process; give it a moment to close its handle.
    for (const dir of [projectRoot, homeDir]) {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    }
  });

  function runHook(): Promise<{ code: number; ms: number }> {
    return new Promise((resolveRun, reject) => {
      const startedAt = Date.now();
      const child = spawn(
        process.execPath,
        [CLI, "--hook", "session-start", "--tool", "claude-code"],
        { cwd: projectRoot, env: sandboxEnv(homeDir), stdio: ["pipe", "pipe", "pipe"] },
      );
      child.on("error", reject);
      child.stdout.resume();
      child.stderr.resume();
      child.on("close", (code) => resolveRun({ code: code ?? 0, ms: Date.now() - startedAt }));
      child.stdin.end(JSON.stringify({ cwd: projectRoot }));
    });
  }

  function indexed(): { lastScan: string | null; tools: string[] } {
    let db: Database.Database | undefined;
    try {
      db = new Database(join(projectRoot, ".xtctx", "state", "xtctx.db"), { readonly: true });
      const row = db.prepare("SELECT value FROM settings WHERE key = 'last_scan_at'").get() as
        | { value: string }
        | undefined;
      const rows = db.prepare("SELECT DISTINCT tool FROM sessions").all() as Array<{ tool: string }>;
      return { lastScan: row?.value ?? null, tools: rows.map((r) => r.tool) };
    } catch {
      return { lastScan: null, tools: [] };
    } finally {
      db?.close();
    }
  }

  it("returns at once and the index is complete shortly after", async () => {
    const { code, ms } = await runHook();
    expect(code).toBe(0);
    // The hook must not wait for the scan it started.
    expect(ms).toBeLessThan(10_000);

    const deadline = Date.now() + 60_000;
    let state = indexed();
    while (state.lastScan === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      state = indexed();
    }

    expect(state.lastScan).not.toBeNull();
    expect(state.tools).toContain("codex");
  }, 90_000);
});
