/**
 * `.xtctx/config.yaml` is committable on purpose — it records which tools a
 * project uses, and that belongs in the repo. But it can also carry a
 * `storePath`, which is where transcripts are *read* from, and that is
 * resolved with no containment: point it at another project's store and xtctx
 * indexes and serves those conversations as this project's context.
 *
 * Nothing writes it any more — setup deliberately stopped — so a `storePath`
 * that is present arrived either from the operator or from a repo they cloned,
 * and they cannot tell which by looking at the transcripts they get back.
 * Reporting it is the mitigation: the reading still happens, but it stops
 * being silent.
 *
 * The boundary used to be the home directory, and that let through the exact
 * attack the docstring describes. Every Claude Code project's transcripts live
 * under `~/.claude/projects/`, so a config redirecting one project's scraper
 * at another project's store names a path *inside* home — and was reported as
 * nothing at all. The mitigation missed its own stated case. It now compares
 * against the tool's own default store instead.
 *
 * The tool name is reported and the path is not. Store paths are redacted from
 * the model-facing surface because they carry the machine's home-directory
 * layout, and that rule does not get an exception for a warning.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProjectServices } from "@xtctx/runtime/services";
import { SUPPORTED_TOOLS } from "@xtctx/tools/sources";

/** Where Claude Code actually keeps transcripts on this machine. */
function claudeCodeDefaultStore(): string {
  const definition = SUPPORTED_TOOLS.find((tool) => tool.id === "claude-code");
  if (!definition) {
    throw new Error("claude-code is not a supported tool any more; this test needs updating");
  }
  return definition.defaultStorePath();
}

describe("store path redirects are reported", () => {
  let root = "";
  let elsewhere = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "xtctx-redirect-"));
    elsewhere = await mkdtemp(join(tmpdir(), "xtctx-redirect-other-"));
    await mkdir(join(root, ".xtctx", "state"), { recursive: true });
  });

  afterEach(async () => {
    for (const dir of [root, elsewhere]) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function writeConfig(body: string): Promise<void> {
    await writeFile(join(root, ".xtctx", "config.yaml"), body, "utf-8");
  }

  async function redirected(): Promise<string[]> {
    const services = await createProjectServices(root);
    try {
      return (await services.sessions.getStatus()).redirected_tools;
    } finally {
      await services.sessions.close().catch(() => {});
    }
  }

  async function configureStore(storePath: string): Promise<void> {
    await writeConfig(
      ["tools:", "  claude-code:", "    enabled: true", `    storePath: ${storePath}`, ""].join("\n"),
    );
  }

  it("names a tool whose store was moved somewhere else entirely", async () => {
    await configureStore(elsewhere);

    expect(await redirected()).toEqual(["claude-code"]);
  });

  /**
   * The case the old home-directory boundary missed, and the one the mitigation
   * exists for: a sibling directory beside the real store holds a *different*
   * project's transcripts. It is inside the home directory, so it used to be
   * reported as nothing.
   */
  it("names a redirect at a sibling of the real store, which is inside home", async () => {
    const sibling = join(dirname(claudeCodeDefaultStore()), "projects-someone-elses");
    await configureStore(sibling);

    expect(await redirected()).toEqual(["claude-code"]);
  });

  it("says nothing when the store path is the tool's own default", async () => {
    // Writing the default explicitly is legal and means nothing has moved, so
    // warning about it would be the noise that trains people to ignore this.
    await configureStore(claudeCodeDefaultStore());

    expect(await redirected()).toEqual([]);
  });

  it("says nothing when no store path is configured at all", async () => {
    await writeConfig(["tools:", "  claude-code:", "    enabled: true", ""].join("\n"));

    expect(await redirected()).toEqual([]);
  });

  it("ignores a redirect on a tool that is switched off", async () => {
    // A disabled tool is never scraped, so its store path reads nothing.
    await writeConfig(
      ["tools:", "  claude-code:", "    enabled: false", `    storePath: ${elsewhere}`, ""].join("\n"),
    );

    expect(await redirected()).toEqual([]);
  });
});
