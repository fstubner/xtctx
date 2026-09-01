/**
 * What xtctx does in a project nobody has set up.
 *
 * This matters more than it looks, because two of the seven clients wire xtctx
 * *machine-globally* — Antigravity always, Copilot CLI under `--global-mcp`.
 * So the server is reachable from every directory on the machine, whether or
 * not anyone opted that directory in.
 *
 * It used to answer `No matching sessions found.`, which is indistinguishable
 * from a configured project that has no history yet — so the one moment an
 * agent could usefully offer setup passed silently. And it scanned every
 * transcript store on the machine to produce that answer (17 seconds
 * measured), then wrote a 168 KB SQLite index into a directory nobody had
 * asked it to touch.
 *
 * Both are fixed here: an unconfigured project is named as such, and nothing
 * is written until someone opts in.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sandboxEnv } from "./helpers.js";

const CLI = resolve(process.cwd(), "dist", "src", "cli", "index.js");

/** The five tools an agent can reach. */
const TOOLS = [
  ["xtctx_recent_sessions", { limit: 5 }],
  ["xtctx_session_detail", { session_ref: "codex:whatever" }],
  ["xtctx_search_sessions", { query: "anything" }],
  ["xtctx_continuity_status", {}],
  ["xtctx_handoff_manifest", { limit: 5 }],
] as const;

describe("a project that has not been set up", () => {
  let projectRoot = "";
  let homeDir = "";

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "xtctx-unconfigured-"));
    homeDir = await mkdtemp(join(tmpdir(), "xtctx-unconfigured-home-"));
  });

  afterEach(async () => {
    for (const dir of [projectRoot, homeDir]) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /** Drive the real server over stdio, as a host client does. */
  async function callTools(): Promise<Map<string, string>> {
    const child = spawn(process.execPath, [CLI], {
      cwd: projectRoot,
      env: { ...sandboxEnv(homeDir), XTCTX_NO_AUTO_MCP: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const results = new Map<string, string>();
    const pending = new Map<number, (value: string) => void>();
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line) as { id?: number; result?: unknown };
          const resolveOne = message.id === undefined ? undefined : pending.get(message.id);
          if (resolveOne) {
            pending.delete(message.id as number);
            resolveOne(JSON.stringify(message.result ?? {}));
          }
        } catch {
          // Not a complete JSON-RPC frame; keep buffering.
        }
      }
    });
    child.stderr.resume();

    let id = 0;
    const call = (method: string, params: unknown): Promise<string> =>
      new Promise((resolveCall) => {
        const myId = ++id;
        pending.set(myId, resolveCall);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: myId, method, params })}\n`);
      });

    try {
      await call("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      for (const [name, args] of TOOLS) {
        results.set(name, await call("tools/call", { name, arguments: args }));
      }
    } finally {
      // Awaited, not just signalled: the child's cwd is the temp project, and
      // Windows refuses to remove a directory a live process is sitting in.
      // Without this the assertions passed and the cleanup failed the test.
      const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
      child.kill();
      await exited;
    }
    return results;
  }

  it("tells every tool's caller that the project is not configured", async () => {
    const results = await callTools();

    for (const [name] of TOOLS) {
      const body = results.get(name) ?? "";
      // Named, and actionable: the agent reading this is the one that can
      // offer setup to the person.
      expect(body, name).toMatch(/not (yet )?configured|not set up/i);
      expect(body, name).toMatch(/xtctx setup/);
      // And not the answer that reads like an empty-but-configured project.
      expect(body, name).not.toMatch(/No matching sessions found/);
    }
  });

  it("writes nothing into a project it was never invited into", async () => {
    await callTools();

    expect(existsSync(join(projectRoot, ".xtctx"))).toBe(false);
  });
});
