import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderStatusBlock, storePathNotes } from "@xtctx/cli/status";
import { setupProject } from "@xtctx/config/setup";
import { createProjectServices } from "@xtctx/runtime/services";

const execFileAsync = promisify(execFile);

describe("status", () => {
  let projectRoot = "";
  let homeDir = "";

  beforeEach(async () => {
    // realpath: the CLI canonicalises the project root, and the temp dir is a
    // symlink on macOS (/var -> /private/var) and an 8.3 short path on
    // Windows (RUNNER~1). Comparing against the raw mkdtemp path asserts a
    // form the product deliberately no longer reports.
    projectRoot = await realpath(await mkdtemp(join(tmpdir(), "xtctx-status-project-")));
    homeDir = await realpath(await mkdtemp(join(tmpdir(), "xtctx-status-home-")));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("does not report drift on a freshly wired project", async () => {
    // `managed-block` and `unsupported` are healthy skill-target states for
    // codex/antigravity/opencode/copilot-cli, not drift. Treating any
    // non-"ok" state as drift told every correctly-wired project to run
    // `setup --repair`, a command that then changed nothing.
    await setupProject({ projectPath: projectRoot, homeDir, yes: true });

    const services = await createProjectServices(projectRoot);
    try {
      const status = await renderStatusBlock(services, { homeDir });

      expect(status).not.toContain("Wiring has drifted");
      expect(status).toContain("Ask a configured agent to call xtctx_recent_sessions");
    } finally {
      await services.sessions.close();
    }
  });

  /**
   * Status exists to tell someone what state their handoff is in, so a line
   * that always reports the same thing is worse than no line: it reads as an
   * answer. A mutation sweep found the scan line could be hard-wired to
   * "never" with the whole suite green, which would tell every user their
   * transcripts had never been read.
   *
   * Asserted through the two states rather than on a timestamp, so the format
   * stays free to change.
   */
  it("distinguishes an index that has been scanned from one that has not", async () => {
    await setupProject({ projectPath: projectRoot, homeDir, yes: true });
    // Every tool switched off, so the scan completes with nothing to read.
    // Left on, this reads every transcript store on the machine — a real one
    // ran past two minutes here before it was capped.
    await writeFile(
      join(projectRoot, ".xtctx", "config.yaml"),
      [
        "tools:",
        ...["claude-code", "cursor", "codex", "copilot", "antigravity", "opencode", "copilot-cli"].flatMap(
          (tool) => [`  ${tool}:`, "    enabled: false"],
        ),
        "",
      ].join("\n"),
      "utf-8",
    );

    const before = await createProjectServices(projectRoot);
    try {
      expect(await renderStatusBlock(before, { homeDir })).toMatch(/Scan\s+never/);
    } finally {
      await before.sessions.close();
    }

    const scanned = await createProjectServices(projectRoot);
    try {
      await scanned.sessions.listRecentSessions(1);
      await scanned.sessions.whenScanSettled?.();
      const status = await renderStatusBlock(scanned, { homeDir });

      expect(status).not.toMatch(/Scan\s+never/);
      expect(status).toMatch(/Scan\s+\d{4}-\d{2}-\d{2}/);
    } finally {
      await scanned.sessions.close();
    }
  }, 60_000);

  /**
   * A persisted drift log nobody surfaces is the same dead end as the stderr
   * it replaced. Status is where a person looks, so it is where a reader's
   * complaints about another tool's format have to show up.
   */
  it("surfaces a reader's persisted format surprises", async () => {
    await setupProject({ projectPath: projectRoot, homeDir, yes: true });
    await writeFile(
      join(projectRoot, ".xtctx", "state", "codex-drift.json"),
      JSON.stringify({
        tool: "codex",
        updatedAt: "2026-08-23T10:00:00.000Z",
        droppedSurprises: 0,
        surprises: [
          {
            surprise: "unknown 'type' value \"world_state\"",
            firstLocation: "/store/a.jsonl:4",
            firstSeen: "2026-08-20T10:00:00.000Z",
            // Deliberately older than the file's updatedAt above.
            lastSeen: "2026-08-21T10:00:00.000Z",
            records: 12,
          },
        ],
      }),
      "utf-8",
    );

    const services = await createProjectServices(projectRoot);
    try {
      const status = await renderStatusBlock(services, { homeDir });

      expect(status).toContain("Format surprises:");
      expect(status).toContain("world_state");
      // "sightings", not "records": the count accumulates across scans, so a
      // re-scan of the same file raises it without any new transcript record.
      expect(status).toContain("12 sightings");
      // Each entry's own last sighting, not the file's write time — otherwise
      // a surprise fixed months ago reads exactly like a live one.
      expect(status).toContain("2026-08-21T10:00:00.000Z");
    } finally {
      await services.sessions.close();
    }
  });

  it("says nothing about surprises when no reader has hit one", async () => {
    await setupProject({ projectPath: projectRoot, homeDir, yes: true });

    const services = await createProjectServices(projectRoot);
    try {
      expect(await renderStatusBlock(services, { homeDir })).not.toContain("Format surprises:");
    } finally {
      await services.sessions.close();
    }
  });

  it("reports synced skill inventory and target drift", async () => {
    await setupProject({ projectPath: projectRoot, homeDir, yes: true });
    await writeFile(
      join(projectRoot, ".cursor", "rules", "xtctx-skills", "xtctx-handoff.mdc"),
      "stale generated file\n",
      "utf-8",
    );

    const services = await createProjectServices(projectRoot);
    try {
      const status = await renderStatusBlock(services, { homeDir });

      expect(status).toContain("Skills:");
      // This fixture deliberately drifts a skill target, so the closing hint
      // must point at repair rather than at indexing.
      expect(status).toContain("Next     Wiring has drifted. Run: xtctx setup --repair");
      expect(status).toContain("xtctx-handoff");
      expect(status).toContain("claude-code native-skill xtctx-handoff");
      expect(status).toContain("drift         cursor rule-adapter xtctx-handoff");
      expect(status).toContain("managed-block antigravity");
      expect(status).not.toContain("unsupported   antigravity unsupported");
      await expect(readFile(join(projectRoot, ".xtctx", "state", "xtctx.db"), "utf-8")).resolves.toBeDefined();
    } finally {
      await (services.sessions as { close(): Promise<void> }).close();
    }
  });

  it("honors the --project option in the public CLI", async () => {
    await setupProject({ projectPath: projectRoot, homeDir, yes: true });

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(process.cwd(), "src", "cli", "index.ts"),
        "status",
        "--project",
        projectRoot,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, XTCTX_NO_AUTO_MCP: "1" },
      },
    );

    expect(stdout).toContain(`Project  ${projectRoot}`);
    expect(stdout).not.toContain(`Project  ${process.cwd()}`);
  }, 15_000);
});

/**
 * A store path recorded by setup is a snapshot of where a tool kept its data
 * that day. When the tool moves — opencode turned out to write to the XDG
 * location on Windows, not %APPDATA% — the recorded path silently stops
 * matching anything, and status reports "not detected" forever while a real
 * store sits elsewhere. Fixing the default only helps new setups, so status
 * has to say something to everyone else.
 */
describe("storePathNotes", () => {
  let home = "";

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "xtctx-storenotes-")));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function definitionFor(defaultPath: string) {
    return { id: "opencode", defaultStorePath: () => defaultPath } as never;
  }

  it("flags a configured path that no longer exists when the default does", async () => {
    const real = join(home, "real-store.db");
    await writeFile(real, "", "utf-8");
    const stale = join(home, "gone", "opencode.db");

    const notes = storePathNotes(definitionFor(real), [stale]);

    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(stale);
    expect(notes[0]).toContain(real);
    expect(notes[0]).toContain("setup");
  });

  it("leaves a deliberate override alone when it exists", async () => {
    const real = join(home, "real-store.db");
    const override = join(home, "override.db");
    await writeFile(real, "", "utf-8");
    await writeFile(override, "", "utf-8");

    const notes = storePathNotes(definitionFor(real), [override]);

    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("custom store path");
  });

  it("says nothing when the configured path is the default", () => {
    const real = join(home, "real-store.db");

    expect(storePathNotes(definitionFor(real), [real])).toEqual([]);
  });
});

/**
 * `enabled: false` is the only control a user has over which transcript stores
 * xtctx reads. A YAML typo used to make the whole file parse as "no
 * preferences expressed", which silently re-enabled every tool they had
 * switched off — and `status` said nothing about it.
 */
describe("status with a config that cannot be parsed", () => {
  let projectRoot = "";
  let homeDir = "";

  beforeEach(async () => {
    projectRoot = await realpath(await mkdtemp(join(tmpdir(), "xtctx-badconfig-")));
    homeDir = await realpath(await mkdtemp(join(tmpdir(), "xtctx-badconfig-home-")));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("says so, and scans nothing, rather than falling back to defaults", async () => {
    await setupProject({ projectPath: projectRoot, homeDir, yes: true });
    // A tab where YAML requires spaces: one keystroke, whole file unreadable.
    await writeFile(
      join(projectRoot, ".xtctx", "config.yaml"),
      "tools:\n  cursor:\n\tenabled: false\n",
      "utf-8",
    );

    const services = await createProjectServices(projectRoot);
    try {
      const status = await renderStatusBlock(services, { homeDir });

      expect(services.config.error).toBeDefined();
      expect(status).toContain("UNREADABLE");
      expect(status).toContain("No transcripts are being read");
      // Nothing is scanned while the file is broken, so no tool reports as
      // detected off the back of a guess.
      expect(status).not.toMatch(/\+ cursor\s+detected/);
    } finally {
      await services.sessions.close();
    }
  });

  it("still reads a valid config normally", async () => {
    await setupProject({ projectPath: projectRoot, homeDir, yes: true });
    await writeFile(
      join(projectRoot, ".xtctx", "config.yaml"),
      "tools:\n  cursor:\n    enabled: false\n",
      "utf-8",
    );

    const services = await createProjectServices(projectRoot);
    try {
      expect(services.config.error).toBeUndefined();
      expect(services.config.tools.cursor?.enabled).toBe(false);
      expect(await renderStatusBlock(services, { homeDir })).not.toContain("UNREADABLE");
    } finally {
      await services.sessions.close();
    }
  });
});
