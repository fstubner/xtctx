import { cp, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiApp } from "@xtctx/api/server";
import { buildToolDefinitions, createToolHandlers } from "@xtctx/mcp/server";
import { createProjectServices } from "@xtctx/runtime/services";

const FIXTURE_PROJECT = fileURLToPath(
  new URL("./fixtures/sample-project", import.meta.url),
);

describe("Integration: MCP + API + Web data paths", () => {
  let projectDir = "";
  let workspaceDir = "";
  let apiServer: Server | null = null;
  let apiBaseUrl = "";

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), "xtctx-integration-"));
    projectDir = join(workspaceDir, "sample-project");
    await cp(FIXTURE_PROJECT, projectDir, { recursive: true });

    const { app } = await createApiApp(projectDir);
    apiServer = createServer(app);

    await new Promise<void>((resolve, reject) => {
      apiServer?.once("error", reject);
      apiServer?.listen(0, "127.0.0.1", () => {
        apiServer?.off("error", reject);
        resolve();
      });
    });

    const address = apiServer.address() as AddressInfo;
    apiBaseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (apiServer) {
      await new Promise<void>((resolve, reject) => {
        apiServer?.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      apiServer = null;
    }

    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("keeps MCP tool handlers aligned with API data responses", async () => {
    const tools = buildToolDefinitions();
    expect(tools.some((tool) => tool.name === "xtctx_search")).toBe(true);
    expect(tools.some((tool) => tool.name === "xtctx_tool_preferences")).toBe(true);

    const services = await createProjectServices(projectDir);
    const handlers = createToolHandlers({
      search: {
        search: async () => [],
      },
      sessions: services.sessions,
      knowledge: services.knowledge,
      writer: services.knowledge,
      configs: services.configs,
    });

    const projectKnowledge = handlers.get("xtctx_project_knowledge");
    const toolPreferences = handlers.get("xtctx_tool_preferences");
    expect(projectKnowledge).toBeDefined();
    expect(toolPreferences).toBeDefined();

    const mcpKnowledge = (await projectKnowledge!({
      type: "all",
      format: "json",
    })) as {
      count: number;
      records: Array<{ id: string; title: string }>;
    };

    const apiKnowledge = (await fetchJson(
      `${apiBaseUrl}/api/knowledge?type=all&format=json`,
    )) as {
      count: number;
      records: Array<{ id: string; title: string }>;
    };

    expect(apiKnowledge.count).toBe(mcpKnowledge.count);
    expect(apiKnowledge.records.map((record) => record.id)).toEqual(
      mcpKnowledge.records.map((record) => record.id),
    );

    const mcpPreferences = (await toolPreferences!({
      tool: "claude-code",
      format: "json",
    })) as {
      preferences: Record<string, unknown>;
    };
    const apiPreferences = (await fetchJson(
      `${apiBaseUrl}/api/config/preferences?tool=claude-code`,
    )) as {
      preferences: Record<string, unknown>;
    };

    expect(apiPreferences.preferences).toEqual(mcpPreferences.preferences);
  });

  it("serves dashboard and search data paths consumed by the web UI", async () => {
    const health = (await fetchJson(`${apiBaseUrl}/health`)) as { ok: boolean };
    const status = (await fetchJson(`${apiBaseUrl}/api/sources/status`)) as {
      ok: boolean;
      knowledgeRecords: number;
    };
    const search = (await fetchJson(
      `${apiBaseUrl}/api/search?query=retry&mode=keyword&limit=5`,
    )) as {
      results: Array<{ id: string }>;
    };

    expect(health.ok).toBe(true);
    expect(status.ok).toBe(true);
    expect(status.knowledgeRecords).toBeGreaterThan(0);
    expect(Array.isArray(search.results)).toBe(true);
    expect(search.results.length).toBeGreaterThan(0);
  });
});

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText} (${url})`);
  }
  return response.json();
}
