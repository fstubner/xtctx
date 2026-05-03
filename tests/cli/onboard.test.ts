/**
 * Tests for `xtctx onboard`.
 *
 * Two angles:
 *   1. The pure YAML renderer — given a set of answers, does it produce
 *      a `shared.yaml` that the existing policy loader accepts? This
 *      is the regression guard against schema drift between the wizard
 *      and the parser.
 *   2. The end-to-end non-interactive run (`--yes`) — does it scaffold
 *      `.xtctx/` and produce a parseable shared.yaml without prompting?
 *
 * The interactive path (multiselect, select, confirm) isn't covered
 * here; @clack/prompts requires a TTY which Vitest doesn't provide.
 * The non-interactive path covers the structural correctness.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runOnboard, renderSharedYaml } from "@xtctx/cli/onboard";
import { parseContinuityPolicySource } from "@xtctx/config/policy";
import { parse as parseYaml } from "yaml";

describe("renderSharedYaml", () => {
  it("produces a YAML the policy loader accepts", () => {
    const yaml = renderSharedYaml(
      {
        enabledTools: new Set(["claude-code", "cursor", "codex"]),
        scope: "project",
        advisoryLevel: "warn",
        runSyncAndServe: true,
      },
      [
        { id: "claude-code", display: "Claude Code", path: "/x", found: true },
        { id: "cursor", display: "Cursor", path: "/y", found: true },
        { id: "codex", display: "Codex", path: "/z", found: true },
        { id: "gemini", display: "Gemini", path: "/w", found: false },
      ],
    );

    const doc = parseYaml(yaml) as Record<string, unknown>;
    // Should not throw — that's the regression guard. If this throws,
    // the wizard is producing a YAML that the loader can't read, and
    // users running `xtctx onboard` would hit a startup error.
    parseContinuityPolicySource(doc, "test:onboard.yaml");

    // Spot-check the structural pieces.
    expect(yaml).toContain("scope: project");
    expect(yaml).toContain("advisory_level: warn");
    // The policy schema renames Claude Code's slug to `claude`; the
    // wizard MUST follow that or the tool stays disabled at runtime.
    expect(yaml).toContain("\n  claude:\n");
    expect(yaml).toContain("\n  cursor:\n");
    expect(yaml).toContain("\n  codex:\n");
  });

  it("encodes disabled tools rather than omitting them", () => {
    // Listing every tool with enabled:true|false (rather than only the
    // chosen ones) means a user can flip a tool on later by editing the
    // YAML, without having to remember the full schema or which slug
    // each tool uses.
    const yaml = renderSharedYaml(
      {
        enabledTools: new Set(["claude-code"]),
        scope: "project",
        advisoryLevel: "warn",
        runSyncAndServe: false,
      },
      [
        { id: "claude-code", display: "Claude Code", path: "/x", found: true },
        { id: "cursor", display: "Cursor", path: "/y", found: false },
      ],
    );

    expect(yaml).toContain("claude:\n    enabled: true");
    expect(yaml).toContain("cursor:\n    enabled: false");
  });

  it("threads scope and advisory-level choices through to the YAML", () => {
    const yaml = renderSharedYaml(
      {
        enabledTools: new Set(["claude-code"]),
        scope: "hybrid",
        advisoryLevel: "strict-hint",
        runSyncAndServe: false,
      },
      [{ id: "claude-code", display: "Claude Code", path: "/x", found: true }],
    );

    expect(yaml).toMatch(/scope: hybrid/);
    expect(yaml).toContain("advisory_level: strict-hint");
  });
});

describe("runOnboard --yes (non-interactive)", () => {
  let projectDir = "";

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "xtctx-onboard-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("scaffolds .xtctx/ and writes a parseable shared.yaml without prompting", async () => {
    // --yes avoids the @clack TTY dependency and accepts default answers.
    // --no-detect skips fs probing and forces all 7 tools "found" so the
    // test result doesn't depend on what's installed on the test machine.
    await runOnboard({ projectPath: projectDir, yes: true, noDetect: true });

    const sharedPath = join(projectDir, ".xtctx", "tool-config", "shared.yaml");
    const yaml = await readFile(sharedPath, "utf-8");

    const doc = parseYaml(yaml) as Record<string, unknown>;
    parseContinuityPolicySource(doc, "test:onboard.yaml");

    expect(yaml).toContain("scope: project");
    expect(yaml).toContain("advisory_level: warn");
    // With --no-detect all 7 known tools should be enabled.
    for (const slug of ["claude", "cursor", "codex", "copilot", "gemini", "opencode", "copilot-cli"]) {
      expect(yaml).toMatch(new RegExp(`\\n  ${slug}:\\n    enabled: true`));
    }
  });
});
