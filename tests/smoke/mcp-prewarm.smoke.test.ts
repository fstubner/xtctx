/**
 * The MCP server scans when it starts, not only when it is asked.
 *
 * The first agent session after another tool's work used to start cold: the
 * session-start hook reads the index without scanning, and the server scanned
 * only on its first tool call. Measured live, that lost a decision Codex had
 * deliberately made. So the server, which the host starts at session start
 * and keeps for the whole session, begins a scan on its own — and the next
 * session's hook has something to show.
 *
 * Driven over stdio like a host: initialize, then nothing. The check is on
 * the index the server leaves behind. The `scan` command is exercised here
 * too, as the by-hand form of the same thing.
 */
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sandboxEnv, seedCodex } from "./helpers.js";

const CLI = resolve(process.cwd(), "dist", "src", "cli", "index.js");

describe("MCP server warms the index on startup", () => {
  let projectRoot = "";
  let homeDir = "";

  beforeEach(async () => {
    // realpath: the product canonicalises its project root and the seeded
    // session records this path as its cwd. macOS temp dirs are symlinks and
    // Windows CI hands out 8.3 short names; without this the scan finds
    // nothing for the project on those runners only.
    projectRoot = await realpath(await mkdtemp(join(tmpdir(), "xtctx-prewarm-")));
    homeDir = await mkdtemp(join(tmpdir(), "xtctx-prewarm-home-"));
    await mkdir(join(projectRoot, ".xtctx", "state"), { recursive: true });
    await writeFile(
      join(projectRoot, ".xtctx", "config.yaml"),
      ["tools:", "  codex:", "    enabled: true", ""].join("\n"),
      "utf-8",
    );
    await seedCodex(homeDir, projectRoot, "the decision only codex knows");
  });

  afterEach(async () => {
    for (const dir of [projectRoot, homeDir]) {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    }
  });

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

  async function untilScanned(): Promise<ReturnType<typeof indexed>> {
    const deadline = Date.now() + 60_000;
    let state = indexed();
    while (state.lastScan === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      state = indexed();
    }
    return state;
  }

  it("indexes another tool's session without being asked", async () => {
    const child = spawn(process.execPath, [CLI], {
      cwd: projectRoot,
      env: { ...sandboxEnv(homeDir), XTCTX_NO_AUTO_MCP: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.resume();
    child.stderr.resume();
    try {
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
        })}\n`,
      );
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      // No tools/call. That is the point.

      const state = await untilScanned();

      expect(state.lastScan).not.toBeNull();
      expect(state.tools).toContain("codex");
    } finally {
      const exited = new Promise<void>((r) => child.once("exit", () => r()));
      child.kill();
      await exited;
    }
  }, 90_000);

  it("scans by hand with `xtctx scan`", async () => {
    const output = await new Promise<string>((resolveRun, reject) => {
      const child = spawn(process.execPath, [CLI, "scan"], {
        cwd: projectRoot,
        env: sandboxEnv(homeDir),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (c: Buffer) => (out += c.toString()));
      child.stderr.resume();
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolveRun(out) : reject(new Error(`exit ${code}: ${out}`))));
    });

    expect(output).toMatch(/Scanned 1 session/);
    expect(indexed().tools).toContain("codex");
  }, 60_000);
});
