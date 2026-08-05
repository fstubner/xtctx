import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runSetup } from "@xtctx/cli/setup";
import { runSetup as setup } from "@xtctx/config/setup";

vi.mock("@xtctx/config/setup", () => {
  return {
    runSetup: vi.fn(),
    discoverProjectSkills: vi.fn().mockResolvedValue([]),
    describeSetupPlan: vi.fn().mockReturnValue({ writes: [] }),
  };
});

describe("runSetup CLI wrapper", () => {
  let originalExitCode: number | undefined;

  beforeEach(() => {
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it("does not set process.exitCode when setup succeeds without critical warnings", async () => {
    vi.mocked(setup).mockResolvedValue({
      projectRoot: "/some/root",
      configPath: "/some/root/.xtctx/config.yaml",
      writes: [],
      warnings: ["Some harmless warning"],
    });

    await runSetup({ yes: true });

    expect(process.exitCode).toBeUndefined();
  });

  it("sets process.exitCode to 1 when setup has critical 'Failed to' warnings", async () => {
    vi.mocked(setup).mockResolvedValue({
      projectRoot: "/some/root",
      configPath: "/some/root/.xtctx/config.yaml",
      writes: [],
      warnings: ["Failed to write MCP config for zed"],
    });

    await runSetup({ yes: true });

    expect(process.exitCode).toBe(1);
  });
});
