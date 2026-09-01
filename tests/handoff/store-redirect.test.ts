/**
 * `.xtctx/config.yaml` is committable on purpose — it records which tools a
 * project uses, and that belongs in the repo. But it can also carry a
 * `storePath`, which is where transcripts are *read* from, and that is
 * resolved with no containment: point it at another project's store and xtctx
 * indexes and serves those conversations as this project's context.
 *
 * Nothing writes it any more — setup deliberately stopped — so a `storePath`
 * outside the home directory arrived either from the operator or from a repo
 * they cloned, and they cannot tell which by looking at the transcripts they
 * get back.
 *
 * `xtctx status` warned about this. Nothing else did, and status is the one
 * surface a plugin-first install may never reach: the MCP server answers
 * without setup ever being run. So the redirect has to be visible where the
 * reading happens.
 *
 * The tool name is reported and the path is not. Store paths are redacted from
 * the model-facing surface because they carry the machine's home-directory
 * layout, and that rule does not get an exception for a warning.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProjectServices } from "@xtctx/runtime/services";

describe("store path redirects are reported", () => {
  let root = "";
  let home = "";
  let elsewhere = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "xtctx-redirect-"));
    home = await mkdtemp(join(tmpdir(), "xtctx-redirect-home-"));
    elsewhere = await mkdtemp(join(tmpdir(), "xtctx-redirect-other-"));
    await mkdir(join(root, ".xtctx", "state"), { recursive: true });
  });

  afterEach(async () => {
    for (const dir of [root, home, elsewhere]) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function writeConfig(body: string): Promise<void> {
    await writeFile(join(root, ".xtctx", "config.yaml"), body, "utf-8");
  }

  async function statusFor(): Promise<{ redirected_tools: string[] }> {
    const services = await createProjectServices(root, { homeDir: home });
    try {
      return await services.sessions.getStatus();
    } finally {
      await services.sessions.close().catch(() => {});
    }
  }

  it("names a tool whose store was redirected out of the home directory", async () => {
    await writeConfig(
      ["tools:", "  claude-code:", "    enabled: true", `    storePath: ${elsewhere}`, ""].join("\n"),
    );

    expect((await statusFor()).redirected_tools).toEqual(["claude-code"]);
  });

  it("says nothing about a store inside the home directory", async () => {
    // The ordinary case: an operator pointing at a store that simply is not in
    // its default place. Warning here would train people to ignore the warning.
    const inHome = join(home, ".claude", "projects");
    await mkdir(inHome, { recursive: true });
    await writeConfig(
      ["tools:", "  claude-code:", "    enabled: true", `    storePath: ${inHome}`, ""].join("\n"),
    );

    expect((await statusFor()).redirected_tools).toEqual([]);
  });

  it("says nothing when no store path is configured at all", async () => {
    await writeConfig(["tools:", "  claude-code:", "    enabled: true", ""].join("\n"));

    expect((await statusFor()).redirected_tools).toEqual([]);
  });

  it("ignores a redirect on a tool that is switched off", async () => {
    // A disabled tool is never scraped, so its store path reads nothing.
    await writeConfig(
      ["tools:", "  claude-code:", "    enabled: false", `    storePath: ${elsewhere}`, ""].join("\n"),
    );

    expect((await statusFor()).redirected_tools).toEqual([]);
  });
});
