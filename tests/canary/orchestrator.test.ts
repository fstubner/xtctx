/**
 * Unit tests for the drift-canary orchestrator.
 *
 * The canary itself hits real APIs when run for real, so these tests mock
 * the two DI seams (invokers + scraperFactories) and exercise the pure
 * orchestration logic: does it dispatch to the right scraper, do the
 * assertions fire on wrong/empty output, and are the error messages
 * actually useful.
 */
import { describe, it, expect } from "vitest";

// @ts-expect-error - .mjs with no type definitions; we use it as JS here.
import { runCanary } from "../../scripts/drift-canary.mjs";

type Chunk = {
  tool: string;
  sessionId: string;
  timestamp: Date;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  metadata: Record<string, unknown>;
};

function fakeScraper(chunks: Chunk[]) {
  return {
    async *fullSync() {
      for (const c of chunks) yield c;
    },
  };
}

function makeChunk(partial: Partial<Chunk>): Chunk {
  return {
    tool: "test",
    sessionId: "s1",
    timestamp: new Date(),
    role: "user",
    content: "hi",
    metadata: { messageIndex: 0 },
    ...partial,
  };
}

const baseArgs = {
  sandboxHome: "/tmp/fake-home",
  stateDir: "/tmp/fake-state",
  timeoutMs: 1000,
};

describe("runCanary", () => {
  it("dispatches to the scraper factory keyed by --tool", async () => {
    let picked: string | null = null;
    const invokers = {
      "claude-code": async () => ({ sessionPath: "/x", invocationMs: 10 }),
      codex: async () => ({ sessionPath: "/x", invocationMs: 10 }),
      gemini: async () => ({ sessionPath: "/x", invocationMs: 10 }),
    };
    const chunks = [
      makeChunk({ role: "user", content: "hi" }),
      makeChunk({ role: "assistant", content: "sure" }),
    ];
    const scraperFactories = {
      "claude-code": () => {
        picked = "claude-code";
        return fakeScraper(chunks);
      },
      codex: () => {
        picked = "codex";
        return fakeScraper(chunks);
      },
      gemini: () => {
        picked = "gemini";
        return fakeScraper(chunks);
      },
    };

    const result = await runCanary({
      tool: "codex",
      invokers,
      scraperFactories,
      ...baseArgs,
    });

    expect(picked).toBe("codex");
    expect(result.ok).toBe(true);
    expect(result.counts).toEqual({ total: 2, user: 1, assistant: 1 });
  });

  it("fails when the scraper returns zero chunks", async () => {
    const result = await runCanary({
      tool: "claude-code",
      invokers: {
        "claude-code": async () => ({ sessionPath: "/x", invocationMs: 5 }),
      },
      scraperFactories: {
        "claude-code": () => fakeScraper([]),
      },
      ...baseArgs,
    });

    expect(result.ok).toBe(false);
    // Both user and assistant are missing, so two structured failures.
    expect(result.failures.length).toBeGreaterThanOrEqual(2);
    expect(result.failures.join("\n")).toMatch(/user chunk/);
    expect(result.failures.join("\n")).toMatch(/assistant chunk/);
  });

  it("fails when only one role is present", async () => {
    const result = await runCanary({
      tool: "claude-code",
      invokers: {
        "claude-code": async () => ({ sessionPath: "/x", invocationMs: 5 }),
      },
      scraperFactories: {
        "claude-code": () => fakeScraper([makeChunk({ role: "user", content: "ping" })]),
      },
      ...baseArgs,
    });

    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toMatch(/assistant chunk/);
    expect(result.failures.join("\n")).not.toMatch(/expected .* user chunk/);
  });

  it("fails when chunks exist but content is empty", async () => {
    const result = await runCanary({
      tool: "claude-code",
      invokers: {
        "claude-code": async () => ({ sessionPath: "/x", invocationMs: 5 }),
      },
      scraperFactories: {
        "claude-code": () =>
          fakeScraper([
            makeChunk({ role: "user", content: "   " }),
            makeChunk({ role: "assistant", content: "" }),
          ]),
      },
      ...baseArgs,
    });

    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toMatch(/user chunk/);
    expect(result.failures.join("\n")).toMatch(/assistant chunk/);
  });

  it("fails when all timestamps are stale (>10 minutes old)", async () => {
    const stale = new Date(Date.now() - 60 * 60_000); // 1h ago
    const result = await runCanary({
      tool: "claude-code",
      invokers: {
        "claude-code": async () => ({ sessionPath: "/x", invocationMs: 5 }),
      },
      scraperFactories: {
        "claude-code": () =>
          fakeScraper([
            makeChunk({ role: "user", content: "old", timestamp: stale }),
            makeChunk({ role: "assistant", content: "older", timestamp: stale }),
          ]),
      },
      ...baseArgs,
    });

    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toMatch(/last 10 minutes/);
  });

  it("propagates invoker errors with a message naming the tool", async () => {
    await expect(
      runCanary({
        tool: "gemini",
        invokers: {
          gemini: async () => {
            throw new Error("gemini CLI not found on PATH");
          },
        },
        scraperFactories: {
          gemini: () => fakeScraper([]),
        },
        ...baseArgs,
      }),
    ).rejects.toThrow(/gemini CLI not found/);
  });

  it("rejects unknown tool names with a helpful list", async () => {
    await expect(
      runCanary({
        tool: "bogus",
        invokers: {
          "claude-code": async () => ({ sessionPath: "/x", invocationMs: 1 }),
        },
        scraperFactories: {
          "claude-code": () => fakeScraper([]),
        },
        ...baseArgs,
      }),
    ).rejects.toThrow(/unknown tool: bogus/);
  });

  it("accepts a passing run: user + assistant, non-empty, recent", async () => {
    const now = new Date("2026-04-20T12:00:00Z");
    const result = await runCanary({
      tool: "claude-code",
      invokers: {
        "claude-code": async () => ({ sessionPath: "/x", invocationMs: 1234 }),
      },
      scraperFactories: {
        "claude-code": () =>
          fakeScraper([
            makeChunk({
              role: "user",
              content: "What is 17 * 23?",
              timestamp: new Date(now.getTime() - 30_000),
            }),
            makeChunk({
              role: "assistant",
              content: "391 — because 17 * 23 = 17 * 20 + 17 * 3.",
              timestamp: new Date(now.getTime() - 15_000),
            }),
          ]),
      },
      ...baseArgs,
      now: () => now,
    });

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.invocationMs).toBe(1234);
    expect(result.counts.user).toBe(1);
    expect(result.counts.assistant).toBe(1);
  });
});
