import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiApp } from "@xtctx/api/server";
import { runInit } from "@xtctx/cli/init";

describe("Continuity API routes", () => {
  let workspaceDir = "";
  let projectDir = "";
  let server: Server | null = null;
  let baseUrl = "";

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), "xtctx-api-continuity-"));
    projectDir = join(workspaceDir, "project");
    await runInit({ projectPath: projectDir, force: true });

    const { app } = await createApiApp(projectDir);
    server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server?.once("error", reject);
      server?.listen(0, "127.0.0.1", () => {
        server?.off("error", reject);
        resolve();
      });
    });

    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => (error ? reject(error) : resolve()));
      });
      server = null;
    }

    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("returns effective policy, tool status, sync results, and warnings", async () => {
    const policy = await fetchJson(`${baseUrl}/api/continuity/effective-policy`) as {
      defaults: { sync_enabled: boolean };
      tools: Record<string, { enabled: boolean }>;
      source_layers: Array<{ layer: string; loaded: boolean }>;
    };
    expect(policy.defaults.sync_enabled).toBe(true);
    expect(Array.isArray(policy.source_layers)).toBe(true);
    expect(policy.tools.codex?.enabled).toBe(true);

    const status = await fetchJson(`${baseUrl}/api/continuity/tools-status`) as {
      tools: Array<{ tool: string; state: string }>;
    };
    expect(status.tools.some((tool) => tool.tool === "codex")).toBe(true);

    const syncAll = await fetchJson(`${baseUrl}/api/continuity/sync`, {
      method: "POST",
    }) as { tools: Array<{ tool: string; state: string }> };
    expect(syncAll.tools.length).toBeGreaterThan(0);

    const syncCodex = await fetchJson(`${baseUrl}/api/continuity/sync/codex`, {
      method: "POST",
    }) as { tool: string; state: string };
    expect(syncCodex.tool).toBe("codex");

    const warnings = await fetchJson(`${baseUrl}/api/continuity/warnings`) as {
      warnings: Array<{ tool: string; warning: string }>;
      count: number;
    };
    expect(Array.isArray(warnings.warnings)).toBe(true);
    expect(typeof warnings.count).toBe("number");
  });
});

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}
