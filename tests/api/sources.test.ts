import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiApp } from "@xtctx/api/server";
import { runInit } from "@xtctx/cli/init";

describe("Sources API routes", () => {
  let workspaceDir = "";
  let projectDir = "";
  let server: Server | null = null;
  let baseUrl = "";

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), "xtctx-api-sources-"));
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

  it("returns source config and persists scraper updates", async () => {
    const config = await fetchJson(`${baseUrl}/api/sources/config`) as {
      watchPaths: string[];
      pollIntervalMs: number;
      excludePatterns: string[];
      scrapers: Array<{ tool: string; enabled: boolean; path: string }>;
    };

    expect(Array.isArray(config.watchPaths)).toBe(true);
    expect(typeof config.pollIntervalMs).toBe("number");
    expect(config.scrapers.some((scraper) => scraper.tool === "codex")).toBe(true);

    const updated = await fetchJson(`${baseUrl}/api/sources/scrapers/codex`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: false,
        customStorePath: ".xtctx/custom-codex-history",
      }),
    }) as {
      tool: string;
      scraper: { tool: string; enabled: boolean; path: string } | null;
    };

    expect(updated.tool).toBe("codex");
    expect(updated.scraper?.enabled).toBe(false);
    expect(updated.scraper?.path).toContain("custom-codex-history");

    const configYaml = await readFile(join(projectDir, ".xtctx", "config.yaml"), "utf-8");
    expect(configYaml).toContain("tool: codex");
    expect(configYaml).toContain("customStorePath: .xtctx/custom-codex-history");
  });
});

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}
