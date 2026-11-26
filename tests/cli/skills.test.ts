import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSkills } from "@xtctx/cli/skills";
import * as runtimeServices from "@xtctx/runtime/services";
import { defaultEmbeddingConfig } from "@xtctx/handoff/embedding-config";
import type { SessionService, SkillUsageStat } from "@xtctx/handoff/types";

describe("runSkills CLI", () => {
  let originalExitCode: typeof process.exitCode;
  let stdoutWritten: string[] = [];
  let stderrWritten: string[] = [];
  let restoreStdout: (() => void) | null = null;
  let restoreStderr: (() => void) | null = null;

  beforeEach(() => {
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    stdoutWritten = [];
    stderrWritten = [];

    const originalStdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutWritten.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    restoreStdout = () => {
      process.stdout.write = originalStdout;
    };

    const originalStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrWritten.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    restoreStderr = () => {
      process.stderr.write = originalStderr;
    };
  });

  afterEach(() => {
    restoreStdout?.();
    restoreStderr?.();
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it("reports error when directory does not exist", async () => {
    await runSkills({ projectPath: "/nonexistent/path/xyz" });
    expect(process.exitCode).toBe(1);
    expect(stderrWritten.join("")).toContain("No such directory");
  });

  it("reports error when xtctx is not configured", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "xtctx-skills-test-"));
    try {
      await runSkills({ projectPath: tempDir });
      expect(process.exitCode).toBe(1);
      expect(stderrWritten.join("")).toContain("not configured");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("prints table format when skills exist", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "xtctx-skills-test-"));
    try {
      const sampleStats: SkillUsageStat[] = [
        {
          skill: "agent-skills:product-build",
          total_count: 7,
          last_used_at: "2026-11-01T12:00:00.000Z",
          by_tool: { "claude-code": 5, codex: 2 },
          session_count: 4,
        },
      ];

      vi.spyOn(runtimeServices, "createProjectServices").mockResolvedValue({
        projectRoot: tempDir,
        xtctxDir: join(tempDir, ".xtctx"),
        stateDir: join(tempDir, ".xtctx", "state"),
        dbPath: join(tempDir, ".xtctx", "state", "xtctx.db"),
        configPath: join(tempDir, ".xtctx", "config.yaml"),
        config: { present: true, tools: {}, embedding: defaultEmbeddingConfig() },
        sessions: {
          getSkillUsage: vi.fn().mockResolvedValue(sampleStats),
          close: vi.fn().mockResolvedValue(undefined),
        } as unknown as SessionService,
      });

      await runSkills({ projectPath: tempDir });

      const output = stdoutWritten.join("");
      expect(output).toContain("Skill Usage Telemetry");
      expect(output).toContain("SKILL");
      expect(output).toContain("USES");
      expect(output).toContain("agent-skills:product-build");
      expect(output).toContain("claude-code: 5, codex: 2");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("prints JSON when --json is passed", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "xtctx-skills-test-"));
    try {
      const sampleStats: SkillUsageStat[] = [
        {
          skill: "product-build",
          total_count: 3,
          last_used_at: "2026-11-01T12:00:00.000Z",
          by_tool: { codex: 3 },
          session_count: 2,
        },
      ];

      vi.spyOn(runtimeServices, "createProjectServices").mockResolvedValue({
        projectRoot: tempDir,
        xtctxDir: join(tempDir, ".xtctx"),
        stateDir: join(tempDir, ".xtctx", "state"),
        dbPath: join(tempDir, ".xtctx", "state", "xtctx.db"),
        configPath: join(tempDir, ".xtctx", "config.yaml"),
        config: { present: true, tools: {}, embedding: defaultEmbeddingConfig() },
        sessions: {
          getSkillUsage: vi.fn().mockResolvedValue(sampleStats),
          close: vi.fn().mockResolvedValue(undefined),
        } as unknown as SessionService,
      });

      await runSkills({ projectPath: tempDir, json: true });

      const output = stdoutWritten.join("");
      const parsed = JSON.parse(output);
      expect(parsed).toEqual(sampleStats);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports when no skill usage is found", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "xtctx-skills-test-"));
    try {
      vi.spyOn(runtimeServices, "createProjectServices").mockResolvedValue({
        projectRoot: tempDir,
        xtctxDir: join(tempDir, ".xtctx"),
        stateDir: join(tempDir, ".xtctx", "state"),
        dbPath: join(tempDir, ".xtctx", "state", "xtctx.db"),
        configPath: join(tempDir, ".xtctx", "config.yaml"),
        config: { present: true, tools: {}, embedding: defaultEmbeddingConfig() },
        sessions: {
          getSkillUsage: vi.fn().mockResolvedValue([]),
          close: vi.fn().mockResolvedValue(undefined),
        } as unknown as SessionService,
      });

      await runSkills({ projectPath: tempDir });

      const output = stdoutWritten.join("");
      expect(output).toContain("No skill usage found for the specified criteria.");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
