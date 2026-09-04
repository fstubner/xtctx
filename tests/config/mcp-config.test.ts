import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  inspectMcpWiring,
  removeMcpServerConfigs,
  syncToolMcpConfigs,
} from "@xtctx/config/mcp-config";

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

/**
 * A config carrying comments is the ordinary reason removal fails, and setup
 * already explains it in words the reader can act on. Disconnect answered the
 * same condition with a raw parser position, which says nothing about what to
 * do next.
 */
describe("removeMcpServerConfigs on a config it cannot parse", () => {
  let projectDir = "";
  let homeDir = "";

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "xtctx-mcp-remove-"));
    homeDir = await mkdtemp(join(tmpdir(), "xtctx-mcp-remove-home-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("explains a commented config instead of quoting the parser", async () => {
    await writeFile(
      join(projectDir, ".mcp.json"),
      ['{', '  // kept deliberately', '  "mcpServers": { "xtctx": { "command": "npx" } }', '}'].join("\n"),
      "utf-8",
    );

    const summary = await removeMcpServerConfigs(projectDir, "xtctx", ["claude-code"], { homeDir });
    const warning = summary.results.map((result) => result.warning ?? "").join("\n");

    expect(warning).toContain("contains comments");
    expect(warning).toContain("Remove the xtctx server entry manually");
    // The parser detail is kept, but as supporting evidence rather than the
    // whole message.
    expect(warning).not.toMatch(/^Failed to remove MCP config/m);
  });
});

/**
 * `xtctx status` answers one question: can an agent actually reach xtctx from
 * this tool right now?
 *
 * A config file it cannot parse is a config whose contents it does not know,
 * so the only honest answer is "not wired" — the entry may be absent, or
 * present under a typo, and either way the client is not loading it. Reporting
 * it as wired is the failure that makes status worth nothing: the user is told
 * everything is fine while no tool call reaches xtctx, and the file that would
 * have shown them why is the one nobody looked at.
 */
describe("inspectMcpWiring on a config it cannot parse", () => {
  let projectDir = "";
  let homeDir = "";

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "xtctx-mcp-inspect-"));
    homeDir = await mkdtemp(join(tmpdir(), "xtctx-mcp-inspect-home-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("never reports an unreadable config as wired", async () => {
    // Truncated, so neither the parser nor the comment-stripping retry can
    // recover it — unlike JSONC, which is read successfully on purpose.
    await writeFile(join(projectDir, ".mcp.json"), '{ "mcpServers": { "xtctx"', "utf-8");

    const [state] = await inspectMcpWiring(projectDir, "xtctx", ["claude-code"], { homeDir });

    expect(state.wired).toBe(false);
    // And distinguished from a config that is simply absent: the file is
    // there, so this is wiring to repair rather than a tool never opted into.
    expect(state.configExists).toBe(true);
  });

  it("still reports a wired config as wired", async () => {
    await writeFile(
      join(projectDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { xtctx: { command: "npx" } } }),
      "utf-8",
    );

    const [state] = await inspectMcpWiring(projectDir, "xtctx", ["claude-code"], { homeDir });

    expect(state.wired).toBe(true);
  });
});

/**
 * "Wired" meant an entry existed under the root key, and nothing looked at
 * what it said. So an entry naming no command at all — which cannot start a
 * server under any circumstances — read as healthy, and `status` said the tool
 * was wired while the agent could reach nothing.
 *
 * The command is also reported now, because `status` printed the string
 * `npx -y xtctx` as a hard-coded literal regardless of what the configs
 * actually held. A project deliberately pointed at a local build was told it
 * was running the published package.
 */
describe("inspectMcpWiring and the command an entry names", () => {
  let projectDir = "";
  let homeDir = "";

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "xtctx-mcp-cmd-"));
    homeDir = await mkdtemp(join(tmpdir(), "xtctx-mcp-cmd-home-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  async function inspect(entry: unknown, tool = "claude-code") {
    await writeFile(
      join(projectDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { xtctx: entry } }),
      "utf-8",
    );
    const [state] = await inspectMcpWiring(projectDir, "xtctx", [tool], { homeDir });
    return state;
  }

  it("reports the command and args an entry actually names", async () => {
    const state = await inspect({ type: "stdio", command: "npx", args: ["-y", "xtctx"] });

    expect(state.wired).toBe(true);
    expect(state.command).toBe("npx -y xtctx");
  });

  it("reports a command that is not the published one, rather than the published one", async () => {
    // The case that exposed this: three projects deliberately pointed at a
    // local build because the published package was too old to work.
    const state = await inspect({
      type: "stdio",
      command: "node",
      args: ["H:/checkout/dist/src/cli/index.js"],
    });

    expect(state.command).toBe("node H:/checkout/dist/src/cli/index.js");
  });

  it("refuses to call an entry that names no command wired", async () => {
    // Nothing can start from this. Reporting it as wired is the same silence
    // that let a deleted .mcp.json read as healthy.
    const state = await inspect({ type: "stdio" });

    expect(state.wired).toBe(false);
    expect(state.configExists).toBe(true);
    expect(state.detail).toMatch(/command/i);
  });

  it("reads opencode's combined command array", async () => {
    // opencode puts the executable and its args in one list, so a reader that
    // only understands `command` + `args` reports nothing for it.
    await writeFile(
      join(projectDir, "opencode.json"),
      JSON.stringify({
        mcp: { xtctx: { type: "local", command: ["npx", "-y", "xtctx"], enabled: true } },
      }),
      "utf-8",
    );

    const [state] = await inspectMcpWiring(projectDir, "xtctx", ["opencode"], { homeDir });

    expect(state.wired).toBe(true);
    expect(state.command).toBe("npx -y xtctx");
  });

  it("accepts a remote entry, which names a url instead of a command", async () => {
    const state = await inspect({ type: "streamable-http", url: "https://example.test/mcp" });

    expect(state.wired).toBe(true);
    expect(state.command).toBe("https://example.test/mcp");
  });
});
