import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInit } from "@xtctx/cli/init";

describe("runInit", () => {
  let projectDir = "";

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "xtctx-init-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("scaffolds canonical tool-config skill files and shared references", async () => {
    await runInit({ projectPath: projectDir });

    const sharedPath = join(projectDir, ".xtctx", "tool-config", "shared.yaml");
    const skillPath = join(projectDir, ".xtctx", "tool-config", "skills", "xtctx-usage.md");
    const commandsDir = join(projectDir, ".xtctx", "tool-config", "commands");
    const agentsDir = join(projectDir, ".xtctx", "tool-config", "agents");
    const mcpServersDir = join(projectDir, ".xtctx", "tool-config", "mcp-servers");
    const slashCommandsDir = join(projectDir, ".xtctx", "tool-config", "slash-commands");

    const shared = await readFile(sharedPath, "utf-8");
    const skill = await readFile(skillPath, "utf-8");

    expect(shared).toContain("categories_enabled");
    expect(shared).toContain("context_feed");
    expect(shared).toContain("tools:");
    expect(shared).toContain("whitelist:");
    expect(skill).toContain("xtctx_search");
    await expect(access(commandsDir)).resolves.toBeUndefined();
    await expect(access(agentsDir)).resolves.toBeUndefined();
    await expect(access(mcpServersDir)).resolves.toBeUndefined();
    await expect(access(slashCommandsDir)).resolves.toBeUndefined();
  });
});
