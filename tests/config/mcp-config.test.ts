import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syncToolMcpConfigs } from "@xtctx/config/mcp-config";

describe("syncToolMcpConfigs", () => {
  let projectDir = "";

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "xtctx-mcp-sync-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("writes .mcp.json for Claude Code", async () => {
    const servers = [{ name: "xtctx", command: "npx", args: ["-y", "xtctx"], transport: "stdio" as const }];
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
    const servers = [{ name: "xtctx", command: "npx", args: ["-y", "xtctx"], transport: "stdio" as const }];
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
  // Antigravity, opencode, Copilot CLI)
  // ---------------------------------------------------------------------

  it("writes .vscode/mcp.json for VS Code Copilot under the `servers` root key (not mcpServers)", async () => {
    const servers = [
      { name: "xtctx", command: "npx", args: ["-y", "xtctx"], transport: "stdio" as const },
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
    expect(entry.args).toEqual(["-y", "xtctx"]);
  });

  it("writes TOML for Codex with [mcp_servers.<name>] tables and no `type` field", async () => {
    const servers = [
      {
        name: "xtctx",
        command: "npx",
        args: ["-y", "xtctx"],
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
    expect(raw).toMatch(/args\s*=\s*\[\s*"-y",\s*"xtctx"\s*\]|args = \[ "-y", "xtctx" \]/);
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

  it("writes Antigravity MCP config with `mcpServers` root and no `type` field", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "xtctx-antigravity-entry-"));
    try {
      const servers = [
        { name: "xtctx", command: "npx", args: ["xtctx"], transport: "stdio" as const },
      ];
      const result = await syncToolMcpConfigs(projectDir, servers, ["antigravity"], { homeDir: fakeHome });

      expect(result.results).toHaveLength(1);
      expect(result.results[0].path).toBe(join(fakeHome, ".gemini", "antigravity", "mcp_config.json"));

      const raw = await readFile(result.results[0].path, "utf-8");
      const parsed = JSON.parse(raw) as { mcpServers: Record<string, Record<string, unknown>> };
      expect(parsed.mcpServers.xtctx).toBeDefined();
      expect(parsed.mcpServers.xtctx.command).toBe("npx");
      expect(parsed.mcpServers.xtctx.type).toBeUndefined();
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it("leaves an unparsable MCP config unchanged and flags it as failed", async () => {
    const configPath = join(projectDir, ".mcp.json");
    await writeFile(configPath, "{ not valid json\n", "utf-8");

    const result = await syncToolMcpConfigs(
      projectDir,
      [{ name: "xtctx", command: "npx", args: ["-y", "xtctx"], transport: "stdio" }],
      ["claude"],
    );

    expect(result.results[0]?.warning).toContain("Failed to parse existing MCP config");
    expect(result.results[0]?.failed).toBe(true);
    await expect(readFile(configPath, "utf-8")).resolves.toBe("{ not valid json\n");
  });

  it("tolerates JSONC comments without clobbering them or failing setup", async () => {
    const configPath = join(projectDir, ".vscode", "mcp.json");
    await mkdir(join(projectDir, ".vscode"), { recursive: true });
    const jsonc = [
      "// my server notes",
      "{",
      '  "servers": {',
      '    "mine": { "command": "my-server" }',
      "  }",
      "}",
      "",
    ].join("\n");
    await writeFile(configPath, jsonc, "utf-8");

    const result = await syncToolMcpConfigs(
      projectDir,
      [{ name: "xtctx", command: "npx", args: ["-y", "xtctx"], transport: "stdio" }],
      ["copilot"],
    );

    const row = result.results[0];
    expect(row?.failed).not.toBe(true);
    expect(row?.skipped).toBe(true);
    expect(row?.warning).toMatch(/comment/i);
    // The user's commented file is preserved byte for byte.
    await expect(readFile(configPath, "utf-8")).resolves.toBe(jsonc);
  });

  it("does not clobber comments in a TOML config", async () => {
    // The JSONC guard above only ever fired when parsing failed. TOML parses
    // fine with comments, so codex configs were re-serialised without them:
    // four hand-written comments came back as zero, exit 0, no warning.
    const configPath = join(projectDir, ".codex", "config.toml");
    await mkdir(join(projectDir, ".codex"), { recursive: true });
    const toml = [
      "# my codex config",
      'model = "gpt-5"  # trailing note',
      "",
      "[tools]",
      "web_search = true",
      "",
    ].join("\n");
    await writeFile(configPath, toml, "utf-8");

    const result = await syncToolMcpConfigs(
      projectDir,
      [{ name: "xtctx", command: "npx", args: ["-y", "xtctx"], transport: "stdio" }],
      ["codex"],
    );

    const row = result.results[0];
    expect(row?.failed).not.toBe(true);
    expect(row?.skipped).toBe(true);
    expect(row?.warning).toMatch(/comment/i);
    await expect(readFile(configPath, "utf-8")).resolves.toBe(toml);
  });

  it("still writes a TOML config that has no comments", async () => {
    const configPath = join(projectDir, ".codex", "config.toml");
    await mkdir(join(projectDir, ".codex"), { recursive: true });
    await writeFile(configPath, 'model = "gpt-5"\n', "utf-8");

    await syncToolMcpConfigs(
      projectDir,
      [{ name: "xtctx", command: "npx", args: ["-y", "xtctx"], transport: "stdio" }],
      ["codex"],
    );

    const raw = await readFile(configPath, "utf-8");
    expect(raw).toContain("mcp_servers");
    expect(raw).toContain('model = "gpt-5"');
  });

  it("treats a # inside a TOML string as data, not a comment", async () => {
    const configPath = join(projectDir, ".codex", "config.toml");
    await mkdir(join(projectDir, ".codex"), { recursive: true });
    await writeFile(configPath, 'tag = "release#1"\n', "utf-8");

    await syncToolMcpConfigs(
      projectDir,
      [{ name: "xtctx", command: "npx", args: ["-y", "xtctx"], transport: "stdio" }],
      ["codex"],
    );

    // Nothing to preserve, so the entry is written rather than refused.
    const raw = await readFile(configPath, "utf-8");
    expect(raw).toContain("mcp_servers");
  });

  it("reports an up-to-date JSONC config as clean, with no warning", async () => {
    const configPath = join(projectDir, ".vscode", "mcp.json");
    await mkdir(join(projectDir, ".vscode"), { recursive: true });
    const jsonc = [
      "// my server notes",
      "{",
      '  "servers": {',
      '    "xtctx": { "type": "stdio", "command": "npx", "args": ["-y", "xtctx"] }',
      "  }",
      "}",
      "",
    ].join("\n");
    await writeFile(configPath, jsonc, "utf-8");

    const result = await syncToolMcpConfigs(
      projectDir,
      [{ name: "xtctx", command: "npx", args: ["-y", "xtctx"], transport: "stdio" }],
      ["copilot"],
    );

    const row = result.results[0];
    expect(row?.failed).not.toBe(true);
    expect(row?.skipped).toBe(true);
    expect(row?.warning).toBeUndefined();
    await expect(readFile(configPath, "utf-8")).resolves.toBe(jsonc);
  });

  it("writes Antigravity MCP config at the user-level app path", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "xtctx-antigravity-home-"));
    try {
      const servers = [
        { name: "xtctx", command: "npx", args: ["-y", "xtctx"], transport: "stdio" as const },
      ];
      const result = await syncToolMcpConfigs(projectDir, servers, ["antigravity"], { homeDir: fakeHome });

      expect(result.results).toHaveLength(1);
      expect(result.results[0].scope).toBe("global");
      expect(result.results[0].path).toBe(join(fakeHome, ".gemini", "antigravity", "mcp_config.json"));

      const raw = await readFile(result.results[0].path, "utf-8");
      const parsed = JSON.parse(raw) as { mcpServers: Record<string, Record<string, unknown>> };
      expect(parsed.mcpServers.xtctx.command).toBe("npx");
      expect(parsed.mcpServers.xtctx.args).toEqual(["-y", "xtctx"]);
      expect(parsed.mcpServers.xtctx.type).toBeUndefined();
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it("writes opencode.json with the nested `mcp` root key and array-style command", async () => {
    const servers = [
      {
        name: "xtctx",
        command: "npx",
        args: ["-y", "xtctx"],
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
    expect(entry.command).toEqual(["npx", "-y", "xtctx"]);
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
        { name: "xtctx", command: "npx", args: ["-y", "xtctx"], transport: "stdio" as const },
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
      expect(entry.args).toEqual(["-y", "xtctx"]);
      // Copilot CLI's native shape includes a `tools` allowlist.
      expect(entry.tools).toEqual(["*"]);
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it("writes seven distinct files for all native-MCP tools in a single call", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "xtctx-mcp-all-"));
    try {
      const servers = [
        { name: "xtctx", command: "npx", args: ["-y", "xtctx"], transport: "stdio" as const },
      ];
      const result = await syncToolMcpConfigs(
        projectDir,
        servers,
        [
          "claude",
          "claude-code",
          "cursor",
          "copilot",
          "codex",
          "antigravity",
          "opencode",
          "copilot-cli",
        ],
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
        join(fakeHome, ".gemini", "antigravity", "mcp_config.json"),
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
