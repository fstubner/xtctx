import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadMcpServerDefinitions,
  renderMcpServersMarkdown,
  syncToolMcpConfigs,
} from "@xtctx/config/mcp-config";

describe("loadMcpServerDefinitions", () => {
  let configRoot = "";

  beforeEach(async () => {
    configRoot = await mkdtemp(join(tmpdir(), "xtctx-mcp-"));
    await mkdir(join(configRoot, "mcp-servers"), { recursive: true });
  });

  afterEach(async () => {
    await rm(configRoot, { recursive: true, force: true });
  });

  it("loads MCP server definitions from JSON files", async () => {
    await writeFile(
      join(configRoot, "mcp-servers", "my-server.json"),
      JSON.stringify({ command: "npx", args: ["my-server"], transport: "stdio" }),
      "utf-8",
    );

    const servers = await loadMcpServerDefinitions(configRoot);
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe("my-server");
    expect(servers[0].command).toBe("npx");
    expect(servers[0].args).toEqual(["my-server"]);
  });

  it("loads MCP server definitions from YAML files", async () => {
    await writeFile(
      join(configRoot, "mcp-servers", "yaml-server.yaml"),
      "command: node\nargs:\n  - server.js\ntransport: stdio\n",
      "utf-8",
    );

    const servers = await loadMcpServerDefinitions(configRoot);
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe("yaml-server");
    expect(servers[0].command).toBe("node");
  });

  it("returns empty array when directory is missing", async () => {
    const emptyRoot = await mkdtemp(join(tmpdir(), "xtctx-mcp-empty-"));
    try {
      const servers = await loadMcpServerDefinitions(emptyRoot);
      expect(servers).toEqual([]);
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  });

  it("skips files without command or url", async () => {
    await writeFile(
      join(configRoot, "mcp-servers", "empty.json"),
      JSON.stringify({ name: "empty" }),
      "utf-8",
    );

    const servers = await loadMcpServerDefinitions(configRoot);
    expect(servers).toHaveLength(0);
  });
});

describe("syncToolMcpConfigs", () => {
  let projectDir = "";

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "xtctx-mcp-sync-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("writes .mcp.json for Claude Code", async () => {
    const servers = [{ name: "xtctx", command: "npx", args: ["xtctx", "serve", "--mcp"], transport: "stdio" as const }];
    const result = await syncToolMcpConfigs(projectDir, servers, ["claude"]);

    expect(result.servers_loaded).toBe(1);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].created).toBe(true);

    const configPath = join(projectDir, ".mcp.json");
    const raw = await readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as { mcpServers: Record<string, unknown> };
    expect(parsed.mcpServers.xtctx).toBeDefined();
  });

  it("writes .cursor/mcp.json for Cursor", async () => {
    const servers = [{ name: "xtctx", command: "npx", args: ["xtctx", "serve"], transport: "stdio" as const }];
    const result = await syncToolMcpConfigs(projectDir, servers, ["cursor"]);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].created).toBe(true);

    const configPath = join(projectDir, ".cursor", "mcp.json");
    const raw = await readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as { mcpServers: Record<string, unknown> };
    expect(parsed.mcpServers.xtctx).toBeDefined();
  });

  it("merges with existing MCP config without overwriting", async () => {
    const configPath = join(projectDir, ".mcp.json");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({ mcpServers: { existing: { type: "stdio", command: "existing-cmd" } } }),
      "utf-8",
    );

    const servers = [{ name: "xtctx", command: "npx", args: ["xtctx"], transport: "stdio" as const }];
    await syncToolMcpConfigs(projectDir, servers, ["claude"]);

    const raw = await readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as { mcpServers: Record<string, unknown> };
    expect(parsed.mcpServers.existing).toBeDefined();
    expect(parsed.mcpServers.xtctx).toBeDefined();
  });

  it("is idempotent — second sync skips unchanged configs", async () => {
    const servers = [{ name: "xtctx", command: "npx", args: ["xtctx"], transport: "stdio" as const }];
    await syncToolMcpConfigs(projectDir, servers, ["claude"]);
    const second = await syncToolMcpConfigs(projectDir, servers, ["claude"]);

    expect(second.results[0].skipped).toBe(true);
  });

  it("deduplicates claude and claude-code (same config path)", async () => {
    const servers = [{ name: "xtctx", command: "npx", args: ["xtctx"], transport: "stdio" as const }];
    const result = await syncToolMcpConfigs(projectDir, servers, ["claude", "claude-code"]);

    expect(result.results).toHaveLength(2);
    const skipped = result.results.filter((r) => r.skipped);
    expect(skipped).toHaveLength(1);
  });

  it("returns empty results when no servers defined", async () => {
    const result = await syncToolMcpConfigs(projectDir, [], ["claude"]);
    expect(result.results).toHaveLength(0);
    expect(result.servers_loaded).toBe(0);
  });
});

describe("renderMcpServersMarkdown", () => {
  it("renders connection details for embedding", () => {
    const servers = [
      { name: "xtctx", command: "npx", args: ["xtctx", "serve", "--mcp"], transport: "stdio" as const },
    ];
    const lines = renderMcpServersMarkdown(servers);
    const text = lines.join("\n");

    expect(text).toContain("### xtctx");
    expect(text).toContain("Transport: stdio");
    expect(text).toContain("`npx xtctx serve --mcp`");
  });

  it("returns empty for no servers", () => {
    expect(renderMcpServersMarkdown([])).toEqual([]);
  });
});
