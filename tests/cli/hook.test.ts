import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHook } from "@xtctx/cli/hook";
import { SqliteHandoffIndex } from "@xtctx/handoff/sqlite-index";
import type { ConversationChunk, ConversationScraper, ScraperState } from "@xtctx/types/scraper";

class SeedScraper implements ConversationScraper {
  readonly tool = "codex";

  constructor(private readonly chunks: ConversationChunk[]) {}

  async detect(): Promise<boolean> {
    return true;
  }

  getStorePaths(): string[] {
    return ["fixture://codex"];
  }

  async *scrape(): AsyncIterable<ConversationChunk> {
    yield* this.fullSync();
  }

  async *fullSync(): AsyncIterable<ConversationChunk> {
    yield* this.chunks;
  }

  async getLastScrapedPosition(): Promise<ScraperState> {
    return { lastTimestamp: new Date(0) };
  }

  async saveScrapedPosition(_state: ScraperState): Promise<void> {
    return;
  }
}

function chunk(minutesAgo: number, content: string): ConversationChunk {
  return {
    tool: "codex",
    sessionId: "turn-zero",
    timestamp: new Date(Date.now() - minutesAgo * 60_000),
    role: "user",
    content,
    metadata: { messageIndex: 0, gitBranch: "feat/turn-zero", gitCommit: "abc12345" },
  };
}

/**
 * The SessionStart hook runs before the user's first turn, so whatever it
 * costs is added to every agent startup. A scan of every transcript store on
 * the machine takes 4 seconds even with the budget that bounds it, so the hook
 * reads what is already indexed and never waits for one.
 */
describe("session-start hook", () => {
  let projectRoot = "";
  let written: string[] = [];
  let restore: (() => void) | null = null;

  async function seedIndex(chunks: ConversationChunk[]): Promise<void> {
    const index = new SqliteHandoffIndex(
      join(projectRoot, ".xtctx", "state", "xtctx.db"),
      projectRoot,
      [{ tool: "codex", scraper: new SeedScraper(chunks) }],
      { refreshBudgetMs: 10_000 },
    );
    await index.listRecentSessions(5);
    await index.close();
  }

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "xtctx-hook-"));
    written = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((value: string | Uint8Array) => {
      written.push(String(value));
      return true;
    }) as typeof process.stdout.write;
    restore = () => {
      process.stdout.write = original;
    };
  });

  afterEach(async () => {
    restore?.();
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("names the most recent session, its branch, and how to read it", async () => {
    await seedIndex([chunk(5, "wire up the parser fallback")]);

    await runHook({ projectPath: projectRoot, tool: "claude-code", event: "session-start" });

    const output = written.join("");
    expect(output).toContain("codex:turn-zero");
    expect(output).toContain("feat/turn-zero");
    expect(output).toContain("wire up the parser fallback");
    expect(output).toContain("xtctx_session_detail");
  });

  it("does not offer a stale session as active context", async () => {
    await seedIndex([chunk(60 * 24 * 9, "something from last week")]);

    await runHook({ projectPath: projectRoot, tool: "claude-code", event: "session-start" });

    const output = written.join("");
    expect(output).not.toContain("something from last week");
    // Still points at the tools; there just is no active frame to prime with.
    expect(output).toContain("xtctx_recent_sessions");
  });

  it("returns promptly rather than waiting for a scan", async () => {
    await seedIndex([chunk(5, "recent work")]);

    const startedAt = Date.now();
    await runHook({ projectPath: projectRoot, tool: "claude-code", event: "session-start" });

    expect(Date.now() - startedAt).toBeLessThan(1_500);
  });

  it("stays silent rather than failing the host startup", async () => {
    await runHook({ projectPath: join(projectRoot, "does", "not", "exist") });

    // No index, no crash: a broken hook must not break the agent it runs in.
    expect(written.join("")).not.toContain("Error");
  });
});
