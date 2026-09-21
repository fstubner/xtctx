/**
 * What `disconnect` does with files it cannot safely rewrite.
 *
 * Both cases here share a shape: the read degrades correctly, and the
 * degraded value was then used as the base for a write. Setup already
 * refuses in both situations; disconnect did not, so uninstalling destroyed
 * what installing had carefully left alone.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { disconnectProject } from "@xtctx/config/disconnect";

let projectRoot: string;
let homeDir: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "xtctx-disc-keep-"));
  homeDir = await mkdtemp(join(tmpdir(), "xtctx-disc-home-"));
  await mkdir(join(projectRoot, ".xtctx"), { recursive: true });
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
  await rm(homeDir, { recursive: true, force: true });
});

describe("disconnect with an unparsable project config", () => {
  // A stray tab: the exact break the read path was made tolerant of.
  const BROKEN = `project:
  root: .
tools:
\tcursor:
    storePath: D:/elsewhere/cursor
`;

  it("leaves the file alone and says so", async () => {
    const configPath = join(projectRoot, ".xtctx", "config.yaml");
    await writeFile(configPath, BROKEN, "utf-8");

    const result = await disconnectProject({ projectPath: projectRoot, all: true, homeDir });

    expect(await readFile(configPath, "utf-8")).toBe(BROKEN);
    expect(result.warnings.join(" ")).toMatch(/could not be parsed/i);
  });
});

describe("disconnect with a commented TOML config", () => {
  const COMMENTED = `# Codex config, hand-written.
# The comments are the point.
[mcp_servers.xtctx]
command = "npx"
args = ["-y", "xtctx"]

[mcp_servers.other]
command = "other-server"
`;

  it("refuses to rewrite it and keeps the comments", async () => {
    await writeFile(
      join(projectRoot, ".xtctx", "config.yaml"),
      "project:\n  root: .\ntools:\n  codex:\n    enabled: true\n",
      "utf-8",
    );
    await mkdir(join(projectRoot, ".codex"), { recursive: true });
    const tomlPath = join(projectRoot, ".codex", "config.toml");
    await writeFile(tomlPath, COMMENTED, "utf-8");

    const result = await disconnectProject({ projectPath: projectRoot, tool: "codex", homeDir });

    expect(await readFile(tomlPath, "utf-8")).toBe(COMMENTED);
    expect(result.warnings.join(" ")).toMatch(/comments/i);
  });
});
