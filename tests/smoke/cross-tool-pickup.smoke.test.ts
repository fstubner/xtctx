/**
 * Cross-tool pickup smoke.
 *
 * Proves the claim the product is built on: work recorded by one coding tool
 * is retrievable from another in the same project. Every tool's store is
 * seeded in its *native* format at the path the product computes for this
 * platform, then read back through the same `SessionService` the MCP tools
 * use — so a scraper that silently matches nothing on macOS or Windows shows
 * up here rather than in someone's install.
 *
 * Opt-in (`npm run test:smoke`): it builds real SQLite databases for several
 * tools and loads the embedding model.
 */

import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { createProjectServices, type ProjectServices } from "@xtctx/runtime/services";
import { SEEDERS } from "./helpers.js";

const TOOLS = Object.keys(SEEDERS);
/** One unmistakable phrase per tool, so a hit cannot be a coincidence. */
const marker = (tool: string) => `PICKUP-${tool.toUpperCase()}-MARKER decided the retry budget`;

describe("cross-tool pickup", () => {
  let sandboxRoot = "";
  let home = "";
  let projectRoot = "";
  let services: ProjectServices;

  beforeAll(async () => {
    // realpath, because the product canonicalises its project root and the
    // seeded stores must agree with it. CI temp directories are not canonical:
    // macOS gives a symlink (/var -> /private/var) and Windows an 8.3 short
    // path (RUNNER~1 -> runneradmin). Seeding against the raw path scopes
    // every session to a root the scrapers then correctly reject — which is
    // exactly how this failed on both, while passing on ubuntu and locally.
    const root = await realpath(await mkdtemp(join(tmpdir(), "xtctx-pickup-")));
    sandboxRoot = root;
    home = join(root, "home");
    projectRoot = join(root, "project");
    await mkdir(home, { recursive: true });
    await mkdir(projectRoot, { recursive: true });

    const saved = { ...process.env };
    Object.assign(process.env, {
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_CONFIG_HOME: join(home, ".config"),
    });

    try {
      for (const tool of TOOLS) {
        await SEEDERS[tool](home, projectRoot, marker(tool));
      }

      // Minimal project config: every tool enabled at its default store path,
      // which is what setup would write. Writing it directly keeps the smoke
      // focused on retrieval rather than on setup, which has its own tests.
      await mkdir(join(projectRoot, ".xtctx"), { recursive: true });
      await writeFile(
        join(projectRoot, ".xtctx", "config.yaml"),
        stringifyYaml({ tools: Object.fromEntries(TOOLS.map((tool) => [tool, { enabled: true }])) }),
        "utf-8",
      );

      services = await createProjectServices(projectRoot);
      // Start the scan, then wait for all of it. A tool call deliberately
      // stops waiting after a few seconds and lets the rest finish in the
      // background, so asserting completeness right after one call asserts
      // against a half-built index: the tools scanned last (antigravity,
      // opencode, copilot-cli) were simply missing, and whether that happened
      // depended on how fast the machine was.
      await services.sessions.listRecentSessions(50);
      await services.sessions.whenScanSettled();
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  }, 600_000);

  afterAll(async () => {
    // Close before removing: the SQLite handles hold the seeded stores open,
    // and on Windows an open handle makes the directory undeletable.
    await services?.sessions.close().catch(() => {});
    await rm(sandboxRoot, { recursive: true, force: true });
  });

  it("detects every seeded tool", async () => {
    const status = await services.sessions.getStatus();
    const undetected = status.tools.filter((tool) => !tool.detected).map((tool) => tool.tool);

    expect(undetected).toEqual([]);
  });

  it("indexes a session from every tool", async () => {
    const sessions = await services.sessions.listRecentSessions(50);
    const seen = new Set(sessions.map((session) => session.tool));

    expect([...seen].sort()).toEqual([...TOOLS].sort());
  });

  it("hands each tool's content to any other tool that asks", async () => {
    const missing: string[] = [];
    for (const tool of TOOLS) {
      const results = await services.sessions.searchSessions(
        `PICKUP-${tool.toUpperCase()}-MARKER`,
        10,
        undefined,
        "keyword",
      );
      if (!results.some((session) => session.tool === tool)) {
        missing.push(tool);
      }
    }

    expect(missing).toEqual([]);
  });

  it("returns the raw message body, not a summary of it", async () => {
    const sessions = await services.sessions.listRecentSessions(50);
    const codex = sessions.find((session) => session.tool === "codex");
    expect(codex).toBeDefined();

    const messages = await services.sessions.getSessionDetail(codex!.session_ref, 0, 20);

    expect(messages.some((message) => message.content.includes(marker("codex")))).toBe(true);
  });

  it("reports no scrape errors for any tool", async () => {
    const status = await services.sessions.getStatus();
    const failing = status.tools
      .filter((tool) => tool.last_error !== null)
      .map((tool) => `${tool.tool}: ${tool.last_error}`);

    expect(failing).toEqual([]);
  });
});
