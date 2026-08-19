import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderStatusBlock } from "@xtctx/cli/status";
import { setupProject } from "@xtctx/config/setup";
import { createProjectServices } from "@xtctx/runtime/services";

const execFileAsync = promisify(execFile);

describe("status", () => {
  let projectRoot = "";
  let homeDir = "";

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "xtctx-status-project-"));
    homeDir = await mkdtemp(join(tmpdir(), "xtctx-status-home-"));
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
      const status = await renderStatusBlock(services);

      expect(status).not.toContain("Wiring has drifted");
      expect(status).toContain("Ask a configured agent to call xtctx_recent_sessions");
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
      const status = await renderStatusBlock(services);

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
