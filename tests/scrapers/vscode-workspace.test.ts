/**
 * The project boundary for every VS Code-shaped store.
 *
 * `workspace.json` beside a `state.vscdb` is the only evidence of which project
 * a workspace belongs to, and Cursor and Copilot both filter on it through this
 * one function. Its call sites are pinned elsewhere (a `storePath` naming a
 * database directly, and the directory walk each scraper does) — what was not
 * pinned is what the function itself answers when the file does not say.
 *
 * A mutation sweep found the gap: making the no-folder branch return `true`
 * left the whole suite green. That branch fails open on exactly the workspaces
 * a real machine has plenty of — an empty `workspace.json`, a multi-root
 * `.code-workspace` entry that names `workspace` rather than `folder`, a
 * newer VS Code that renames the key — and a fail-open there serves another
 * project's conversations as this project's answers.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workspaceMatchesProject } from "@xtctx/scrapers/vscode-workspace";

describe("workspaceMatchesProject fails closed when workspace.json does not name our folder", () => {
  let dir = "";
  const projectRoot = join("H:", "projects", "ours");

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "xtctx-vscode-ws-"));
    await mkdir(join(dir, "hash"), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Writes `workspace.json` beside a (never-opened) database path. */
  async function seed(contents: string): Promise<string> {
    const dbPath = join(dir, "hash", "state.vscdb");
    await writeFile(join(dir, "hash", "workspace.json"), contents, "utf-8");
    return dbPath;
  }

  it.each([
    ["an empty object", "{}"],
    ["a workspace that names no folder", JSON.stringify({ id: "abc", configPath: "x" })],
    ["a multi-root workspace naming 'workspace' instead", JSON.stringify({ workspace: "file:///H:/projects/ours" })],
    ["a folder that is not a string", JSON.stringify({ folder: 42 })],
    ["a folder that is null", JSON.stringify({ folder: null })],
  ])("does not claim a workspace with %s", async (_label, contents) => {
    expect(await workspaceMatchesProject(await seed(contents), projectRoot)).toBe(false);
  });

  it("does not claim a workspace whose workspace.json is unparseable", async () => {
    expect(await workspaceMatchesProject(await seed("{ not json"), projectRoot)).toBe(false);
  });

  it("does not claim a workspace with no workspace.json at all", async () => {
    expect(
      await workspaceMatchesProject(join(dir, "hash", "state.vscdb"), projectRoot),
    ).toBe(false);
  });

  /**
   * The other half: fail-closed must not become refuse-everything. A
   * `workspace.json` that does name this project's folder is the case the
   * filter exists to admit, in both the shapes VS Code writes it.
   */
  it("claims a workspace whose folder is this project", async () => {
    expect(
      await workspaceMatchesProject(
        await seed(JSON.stringify({ folder: "file:///H%3A/projects/ours" })),
        projectRoot,
      ),
    ).toBe(true);
    expect(
      await workspaceMatchesProject(
        await seed(JSON.stringify({ folder: join("H:", "projects", "ours") })),
        projectRoot,
      ),
    ).toBe(true);
  });

  it("does not claim a sibling that merely shares a name prefix", async () => {
    expect(
      await workspaceMatchesProject(
        await seed(JSON.stringify({ folder: "file:///H%3A/projects/ours-secret" })),
        projectRoot,
      ),
    ).toBe(false);
  });
});
