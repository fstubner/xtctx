import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteHandoffIndex } from "@xtctx/handoff/sqlite-index";
import type { ConversationChunk, ConversationScraper, ScraperState } from "@xtctx/types/scraper";

class SkillsTestScraper implements ConversationScraper {
  readonly tool: string;

  constructor(tool: string, private readonly chunks: ConversationChunk[]) {
    this.tool = tool;
  }

  async detect(): Promise<boolean> {
    return true;
  }

  getStorePaths(): string[] {
    return [`fixture://${this.tool}`];
  }

  async *scrape(): AsyncIterable<ConversationChunk> {
    for (const chunk of this.chunks) {
      yield chunk;
    }
  }

  async *fullSync(): AsyncIterable<ConversationChunk> {
    yield* this.scrape();
  }

  async getLastScrapedPosition(): Promise<ScraperState> {
    return { lastTimestamp: new Date(0) };
  }

  async saveScrapedPosition(): Promise<void> {}
}

describe("SqliteHandoffIndex getSkillUsage", () => {
  let projectDir = "";
  let dbPath = "";

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "xtctx-skill-usage-proj-"));
    dbPath = join(projectDir, ".xtctx", "state", "xtctx.db");
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("aggregates skill usage across multiple agents and sessions", async () => {
    const codexChunks: ConversationChunk[] = [
      {
        tool: "codex",
        sessionId: "session-1",
        timestamp: new Date("2026-10-30T10:00:00Z"),
        role: "assistant",
        content: "Working on product",
        metadata: { messageIndex: 0, skills: ["product-build", "release-engineering"] },
      },
      {
        tool: "codex",
        sessionId: "session-1",
        timestamp: new Date("2026-10-30T11:00:00Z"),
        role: "assistant",
        content: "Still working on product",
        metadata: { messageIndex: 1, skills: ["product-build"] },
      },
      {
        tool: "codex",
        sessionId: "session-2",
        timestamp: new Date("2026-10-31T09:00:00Z"),
        role: "assistant",
        content: "Acceptance check",
        metadata: { messageIndex: 0, skills: ["product-acceptance"] },
      },
    ];

    const claudeChunks: ConversationChunk[] = [
      {
        tool: "claude-code",
        sessionId: "session-3",
        timestamp: new Date("2026-11-01T08:00:00Z"),
        role: "assistant",
        content: "Building product with claude",
        metadata: { messageIndex: 0, skills: ["product-build"] },
      },
    ];

    const codexScraper = new SkillsTestScraper("codex", codexChunks);
    const claudeScraper = new SkillsTestScraper("claude-code", claudeChunks);

    const tools = [
      { tool: "codex", scraper: codexScraper },
      { tool: "claude-code", scraper: claudeScraper },
    ];

    const index = new SqliteHandoffIndex(dbPath, projectDir, tools);

    try {
      // Force initial scan
      await index.listRecentSessions(10);

      const allStats = await index.getSkillUsage();
      expect(allStats.length).toBe(3);

      // product-build has 3 total invocations (2 in codex session-1, 1 in claude session-3)
      const productBuild = allStats.find((s) => s.skill === "product-build");
      expect(productBuild).toBeDefined();
      expect(productBuild?.total_count).toBe(3);
      expect(productBuild?.session_count).toBe(2);
      expect(productBuild?.by_tool).toEqual({ codex: 2, "claude-code": 1 });
      expect(productBuild?.last_used_at).toBe("2026-11-01T08:00:00.000Z");

      // release-engineering has 1 invocation
      const releaseEng = allStats.find((s) => s.skill === "release-engineering");
      expect(releaseEng).toBeDefined();
      expect(releaseEng?.total_count).toBe(1);
      expect(releaseEng?.session_count).toBe(1);
      expect(releaseEng?.by_tool).toEqual({ codex: 1 });

      // Filtering by tool
      const codexOnly = await index.getSkillUsage({ tool: "codex" });
      expect(codexOnly.length).toBe(3);
      expect(codexOnly.every((s) => Object.keys(s.by_tool).every((t) => t === "codex"))).toBe(true);

      const claudeOnly = await index.getSkillUsage({ tool: "claude-code" });
      expect(claudeOnly.length).toBe(1);
      expect(claudeOnly[0].skill).toBe("product-build");
      expect(claudeOnly[0].total_count).toBe(1);

      // Filtering by specific skill
      const acceptanceOnly = await index.getSkillUsage({ skill: "product-acceptance" });
      expect(acceptanceOnly.length).toBe(1);
      expect(acceptanceOnly[0].skill).toBe("product-acceptance");

      // Filtering by since date
      const recentOnly = await index.getSkillUsage({ since: "2026-11-01T00:00:00Z" });
      expect(recentOnly.length).toBe(1);
      expect(recentOnly[0].skill).toBe("product-build");
      expect(recentOnly[0].total_count).toBe(1);
    } finally {
      await index.close();
    }
  });
});
