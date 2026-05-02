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

  // ---------------------------------------------------------------------
  // New native MCP renderers (Phase 1: Copilot VS Code, Codex, Gemini,
  // opencode, Copilot CLI)
  // ---------------------------------------------------------------------

  it("writes .vscode/mcp.json for VS Code Copilot under the `servers` root key (not mcpServers)", async () => {
    const servers = [
      { name: "xtctx", command: "npx", args: ["xtctx", "serve"], transport: "stdio" as const },
    ];
    const result = await syncToolMcpConfigs(projectDir, servers, ["copilot"]);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].created).toBe(true);
    expect(result.results[0].path).toContain(join(".vscode", "mcp.json"));

    const raw = await readFile(join(projectDir, ".vscode", "mcp.json"), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Critical: VS Code's MCP reference uses `servers`, not `mcpServers`.
    expect(parsed.servers).toBeDefined();
    expect(parsed.mcpServers).toBeUndefined();
    const entry = (parsed.servers as Record<string, Record<string, unknown>>).xtctx;
    expect(entry.type).toBe("stdio");
    expect(entry.command).toBe("npx");
    expect(entry.args).toEqual(["xtctx", "serve"]);
  });

  it("writes TOML for Codex with [mcp_servers.<name>] tables and no `type` field", async () => {
    const servers = [
      {
        name: "xtctx",
        command: "npx",
        args: ["xtctx", "serve", "--mcp-only"],
        transport: "stdio" as const,
        env: { XTCTX_DEBUG: "1" },
      },
    ];
    const result = await syncToolMcpConfigs(projectDir, servers, ["codex"]);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].created).toBe(true);
    expect(result.results[0].path).toContain(join(".codex", "config.toml"));

    const raw = await readFile(join(projectDir, ".codex", "config.toml"), "utf-8");
    // Should contain a [mcp_servers.xtctx] table with command/args/env.
    expect(raw).toMatch(/\[mcp_servers\.xtctx\]/);
    expect(raw).toContain('command = "npx"');
    expect(raw).toMatch(/args\s*=\s*\[\s*"xtctx",\s*"xtctx",?\s*"serve",?\s*"--mcp-only"\s*\]|args = \[ "xtctx", "serve", "--mcp-only" \]/);
    expect(raw).toContain("XTCTX_DEBUG");
    // Codex's TOML format omits the `type` field (stdio is implicit).
    expect(raw).not.toMatch(/^type =/m);
  });

  it("preserves Codex user-managed TOML keys outside [mcp_servers]", async () => {
    const codexDir = join(projectDir, ".codex");
    await mkdir(codexDir, { recursive: true });
    await writeFile(
      join(codexDir, "config.toml"),
      [
        'model_provider = "openai"',
        'approval_mode = "always"',
        "",
        "[mcp_servers.legacy-server]",
        'command = "old-cmd"',
        "",
      ].join("\n"),
      "utf-8",
    );

    const servers = [
      { name: "xtctx", command: "npx", args: ["xtctx"], transport: "stdio" as const },
    ];
    await syncToolMcpConfigs(projectDir, servers, ["codex"]);

    const raw = await readFile(join(codexDir, "config.toml"), "utf-8");
    expect(raw).toContain('model_provider = "openai"');
    expect(raw).toContain('approval_mode = "always"');
    // Existing legacy-server entry preserved alongside new xtctx entry.
    expect(raw).toMatch(/\[mcp_servers\.legacy-server\]/);
    expect(raw).toMatch(/\[mcp_servers\.xtctx\]/);
  });

  it("writes .gemini/settings.json for Gemini with `mcpServers` root and no `type` field", async () => {
    const servers = [
      { name: "xtctx", command: "npx", args: ["xtctx"], transport: "stdio" as const },
    ];
    const result = await syncToolMcpConfigs(projectDir, servers, ["gemini"]);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].path).toContain(join(".gemini", "settings.json"));

    const raw = await readFile(join(projectDir, ".gemini", "settings.json"), "utf-8");
    const parsed = JSON.parse(raw) as { mcpServers: Record<string, Record<string, unknown>> };
    expect(parsed.mcpServers.xtctx).toBeDefined();
    expect(parsed.mcpServers.xtctx.command).toBe("npx");
    // Gemini's native MCP entry shape omits `type`.
    expect(parsed.mcpServers.xtctx.type).toBeUndefined();
  });

  it("writes opencode.json with the nested `mcp` root key and array-style command", async () => {
    const servers = [
      {
        name: "xtctx",
        command: "npx",
        args: ["xtctx", "serve", "--mcp-only"],
        transport: "stdio" as const,
      },
    ];
    const result = await syncToolMcpConfigs(projectDir, servers, ["opencode"]);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].path).toContain("opencode.json");

    const raw = await readFile(join(projectDir, "opencode.json"), "utf-8");
    const parsed = JSON.parse(raw) as { mcp: Record<string, Record<string, unknown>> };
    const entry = parsed.mcp.xtctx;
    expect(entry.type).toBe("local");
    // opencode's `command` is a combined ARRAY (executable + args).
    expect(entry.command).toEqual(["npx", "xtctx", "serve", "--mcp-only"]);
    expect(entry.enabled).toBe(true);
  });

  it("preserves opencode user-managed top-level keys outside `mcp`", async () => {
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        model: "anthropic/claude-sonnet-4-5",
        mcp: { existing: { type: "local", command: ["existing-cmd"], enabled: true } },
      }),
      "utf-8",
    );

    const servers = [
      { name: "xtctx", command: "npx", args: ["xtctx"], transport: "stdio" as const },
    ];
    await syncToolMcpConfigs(projectDir, servers, ["opencode"]);

    const raw = await readFile(join(projectDir, "opencode.json"), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // User's $schema and model survive.
    expect(parsed.$schema).toBe("https://opencode.ai/config.json");
    expect(parsed.model).toBe("anthropic/claude-sonnet-4-5");
    // Existing mcp entry survives alongside the new xtctx entry.
    const mcp = parsed.mcp as Record<string, unknown>;
    expect(mcp.existing).toBeDefined();
    expect(mcp.xtctx).toBeDefined();
  });

  it("writes ~/.copilot/mcp-config.json for Copilot CLI at the user-level path with tools allowlist", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "xtctx-mcp-home-"));
    try {
      const servers = [
        { name: "xtctx", command: "npx", args: ["xtctx", "serve"], transport: "stdio" as const },
      ];
      const result = await syncToolMcpConfigs(projectDir, servers, ["copilot-cli"], { homeDir: fakeHome });

      expect(result.results).toHaveLength(1);
      expect(result.results[0].scope).toBe("global");
      expect(result.results[0].path).toBe(join(fakeHome, ".copilot", "mcp-config.json"));

      const raw = await readFile(result.results[0].path, "utf-8");
      const parsed = JSON.parse(raw) as { mcpServers: Record<string, Record<string, unknown>> };
      const entry = parsed.mcpServers.xtctx;
      expect(entry.type).toBe("local");
      expect(entry.command).toBe("npx");
      expect(entry.args).toEqual(["xtctx", "serve"]);
      // Copilot CLI's native shape includes a `tools` allowlist.
      expect(entry.tools).toEqual(["*"]);
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it("writes seven distinct files for all 7 native-MCP tools in a single call", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "xtctx-mcp-all-"));
    try {
      const servers = [
        { name: "xtctx", command: "npx", args: ["xtctx", "serve"], transport: "stdio" as const },
      ];
      const result = await syncToolMcpConfigs(
        projectDir,
        servers,
        ["claude", "claude-code", "cursor", "copilot", "codex", "gemini", "opencode", "copilot-cli"],
        { homeDir: fakeHome },
      );

      // 8 enabled tools; claude/claude-code share .mcp.json (one is skipped), so
      // 7 unique files actually get written.
      const written = result.results.filter((r) => !r.skipped);
      expect(written).toHaveLength(7);
      const skipped = result.results.filter((r) => r.skipped);
      expect(skipped).toHaveLength(1);

      // Verify each file exists with at least the xtctx server entry present.
      const expectedPaths = [
        join(projectDir, ".mcp.json"),
        join(projectDir, ".cursor", "mcp.json"),
        join(projectDir, ".vscode", "mcp.json"),
        join(projectDir, ".codex", "config.toml"),
        join(projectDir, ".gemini", "settings.json"),
        join(projectDir, "opencode.json"),
        join(fakeHome, ".copilot", "mcp-config.json"),
      ];
      for (const p of expectedPaths) {
        const content = await readFile(p, "utf-8");
        expect(content).toContain("xtctx");
      }
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
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
