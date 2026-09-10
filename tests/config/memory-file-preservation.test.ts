/**
 * Disconnect must not destroy a file the user wrote.
 *
 * Two ways it did, both found by driving a real setup/disconnect round trip
 * rather than by reading the code:
 *
 * 1. A `CLAUDE.md` containing nothing but the author's own YAML frontmatter
 *    was DELETED. Removal asked "is the remainder any frontmatter?" and
 *    deleted the file when it was — which cannot tell xtctx's own Cursor-rule
 *    prelude from a metadata stub someone wrote themselves.
 *
 * 2. A file with one orphaned `begin` marker lost every line between that
 *    marker and the next block's `end`, because the removal pattern paired an
 *    opening marker with the nearest close whatever lay between.
 *
 * Both are asserted here through `setupProject` + `disconnectProject`, not
 * through the splicing helpers, because that is the layer where the loss
 * happened: the unit helpers were individually defensible and the round trip
 * still ate the file.
 *
 * `homeDir` is a temp directory throughout. `setupProject` always wires
 * Antigravity's machine-global MCP config, so a test that let it reach the
 * real home would edit a file shared by every project on the machine.
 */
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupProject } from "@xtctx/config/setup";
import { disconnectProject } from "@xtctx/config/disconnect";

describe("a user's memory file survives setup and disconnect", () => {
  let projectRoot = "";
  let homeDir = "";

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "xtctx-memory-"));
    homeDir = await mkdtemp(join(tmpdir(), "xtctx-memory-home-"));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  async function roundTrip(): Promise<void> {
    await setupProject({ projectPath: projectRoot, homeDir, yes: true });
    await disconnectProject({ projectPath: projectRoot, homeDir, all: true });
  }

  async function exists(path: string): Promise<boolean> {
    return stat(path).then(
      () => true,
      () => false,
    );
  }

  it("does not delete a file that is only the author's own frontmatter", async () => {
    const path = join(projectRoot, "CLAUDE.md");
    const original = "---\ntitle: My own notes\ncustom_field: true\n---\n";
    await writeFile(path, original, "utf-8");

    await roundTrip();

    expect(await exists(path), "CLAUDE.md was deleted").toBe(true);
    expect(await readFile(path, "utf-8")).toBe(original);
  });

  it("does not eat content sitting after an orphaned begin marker", async () => {
    const path = join(projectRoot, "CLAUDE.md");
    const original = [
      "TOP LINE THE USER WROTE",
      "<!-- xtctx:begin -->",
      "stale text whose end marker was deleted",
      "",
      "## The user's own heading",
      "Content the user cares about.",
      "",
    ].join("\n");
    await writeFile(path, original, "utf-8");

    await roundTrip();

    expect(await readFile(path, "utf-8")).toBe(original);
  });

  it("still removes a file that held nothing but xtctx's own block", async () => {
    // The behaviour the deletion exists for, which the fix must not lose:
    // setup created this file, so disconnect owns removing it rather than
    // leaving a stub behind.
    const path = join(projectRoot, "CLAUDE.md");
    expect(await exists(path)).toBe(false);

    await roundTrip();

    expect(await exists(path), "an xtctx-created file was left behind").toBe(false);
  });

  it("leaves the user's prose exactly as written", async () => {
    const path = join(projectRoot, "AGENTS.md");
    // Trailing spaces are a markdown hard break, and blank lines at EOF are
    // the author's: both have been destroyed by trimming here before.
    const original = "# My notes\n\nA line with a hard break  \nand the next one.\n\n\n";
    await writeFile(path, original, "utf-8");

    await roundTrip();

    expect(await readFile(path, "utf-8")).toBe(original);
  });
});
