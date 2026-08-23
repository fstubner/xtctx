import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Drives the real MCP server over stdio.
 *
 * `tests/integration/handoff-mcp.test.ts` calls the tool handlers directly
 * against a fake `SessionService` — useful, but it never starts a process,
 * never speaks JSON-RPC, and never touches SQLite. Nothing in the suite
 * exercised the transport, so the acceptance reviewer had to write its own
 * harness to check the thing users actually connect to.
 *
 * Run through `tsx` rather than `dist/`, because CI runs the smoke suite
 * before the build step.
 */
describe("MCP server over stdio", () => {
  let projectRoot = "";
  let proc: ChildProcessWithoutNullStreams;
  let buffer = "";
  const pending = new Map<number, (message: Record<string, unknown>) => void>();

  function send(message: Record<string, unknown>): void {
    proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function request(id: number, method: string, params: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error(`${method} did not answer within 60s`)), 60_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolvePromise(message);
      });
      send({ jsonrpc: "2.0", id, method, params });
    });
  }

  beforeAll(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "xtctx-stdio-"));
    proc = spawn(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), resolve("src/cli/index.ts")], {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    proc.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          try {
            const message = JSON.parse(line) as { id?: number };
            if (typeof message.id === "number") {
              pending.get(message.id)?.(message as Record<string, unknown>);
              pending.delete(message.id);
            }
          } catch {
            // Not a JSON-RPC line; the transport owns stdout, so ignore.
          }
        }
        newline = buffer.indexOf("\n");
      }
    });

    await request(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "stdio-smoke", version: "1" },
    });
  }, 120_000);

  afterAll(async () => {
    // Wait for the process to actually exit before deleting its project.
    // On Windows the server still holds the SQLite handle for a moment after
    // the kill, and the directory removal fails with EBUSY.
    if (proc && proc.exitCode === null) {
      const exited = new Promise<void>((resolvePromise) => proc.once("exit", () => resolvePromise()));
      proc.stdin.end();
      const force = setTimeout(() => proc.kill("SIGKILL"), 5_000);
      await exited;
      clearTimeout(force);
    }
    await rm(projectRoot, { recursive: true, force: true });
  }, 30_000);

  it("advertises exactly the five read-only tools", async () => {
    const response = (await request(2, "tools/list", {})) as {
      result?: { tools?: Array<{ name: string }> };
    };

    const names = (response.result?.tools ?? []).map((tool) => tool.name).sort();
    expect(names).toEqual([
      "xtctx_continuity_status",
      "xtctx_handoff_manifest",
      "xtctx_recent_sessions",
      "xtctx_search_sessions",
      "xtctx_session_detail",
    ]);
  }, 60_000);

  it("answers a tool call with content, not an error", async () => {
    const response = (await request(3, "tools/call", {
      name: "xtctx_recent_sessions",
      arguments: { limit: 2 },
    })) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };

    expect(response.result?.isError).not.toBe(true);
    // An empty project has nothing indexed, and saying so is the contract.
    expect(response.result?.content?.[0]?.text).toContain("No matching sessions found");
  }, 120_000);

  it("reports a bad argument as a caller error rather than crashing", async () => {
    const response = (await request(4, "tools/call", {
      name: "xtctx_search_sessions",
      arguments: { query: "" },
    })) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };

    expect(response.result?.isError).toBe(true);
    expect(response.result?.content?.[0]?.text).toMatch(/query/i);

    // Still alive and serving after a rejected call.
    const after = (await request(5, "tools/call", {
      name: "xtctx_continuity_status",
      arguments: {},
    })) as { result?: { isError?: boolean } };
    expect(after.result?.isError).not.toBe(true);
  }, 120_000);
});
