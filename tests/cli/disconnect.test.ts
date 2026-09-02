import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDisconnect } from "@xtctx/cli/disconnect";
import { setupProject } from "@xtctx/config/setup";

/**
 * `--yes` skips the prompt. It must not skip the disclosure.
 *
 * Antigravity keeps its MCP config at app level, so disconnecting it in one
 * project removes xtctx from Antigravity for every project on the machine.
 * That was only mentioned after the files had already been written — by which
 * point the reach of the command is not news, it is damage.
 */
describe("runDisconnect --yes", () => {
  let projectRoot = "";
  let homeDir = "";
  let written: string[] = [];
  let restore: (() => void) | null = null;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "xtctx-disc-cli-project-"));
    homeDir = await mkdtemp(join(tmpdir(), "xtctx-disc-cli-home-"));
    await setupProject({ projectPath: projectRoot, homeDir, yes: true });

    written = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    restore = () => {
      process.stdout.write = original;
    };
  });

  afterEach(async () => {
    restore?.();
    await rm(projectRoot, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("warns that Antigravity is machine-wide before it writes anything", async () => {
    await runDisconnect({ projectPath: projectRoot, homeDir, all: true, globalMcp: true, yes: true });

    const output = written.join("");
    const warningAt = output.indexOf("every project on this machine");
    const appliedAt = output.indexOf("disconnect complete");

    expect(warningAt).toBeGreaterThanOrEqual(0);
    expect(appliedAt).toBeGreaterThanOrEqual(0);
    expect(warningAt).toBeLessThan(appliedAt);
  });

  it("says where the local index of transcript content is left behind", async () => {
    await runDisconnect({ projectPath: projectRoot, homeDir, all: true, yes: true });

    const output = written.join("");
    expect(output).toContain(".xtctx");
    expect(output.toLowerCase()).toContain("indexed");
  });
});
