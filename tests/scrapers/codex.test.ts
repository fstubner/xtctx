import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexCliScraper } from "@xtctx/scrapers/codex";
import type { CodexChunk } from "@xtctx/types/scraper";

describe("CodexCliScraper", () => {
  let tempDir = "";
  let stateDir = "";
  let scraper: CodexCliScraper;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "xtctx-codex-"));
    stateDir = await mkdtemp(join(tmpdir(), "xtctx-state-"));
    await mkdir(tempDir, { recursive: true });
    await writeFile(
      join(tempDir, "session-a.jsonl"),
      [
        JSON.stringify({
          role: "user",
          content: "codex first",
          timestamp: "2026-02-24T10:00:00Z",
          approval_mode: "suggest",
          sandboxed: true,
        }),
        JSON.stringify({
          role: "assistant",
          content: "codex second",
          timestamp: "2026-02-24T10:00:05Z",
          approval_mode: "auto-edit",
          sandboxed: false,
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    scraper = new CodexCliScraper(tempDir, stateDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  it("detects codex session path", async () => {
    expect(await scraper.detect()).toBe(true);
  });

  it("reads codex jsonl records", async () => {
    const chunks: CodexChunk[] = [];
    for await (const chunk of scraper.fullSync()) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(chunks[0].role).toBe("user");
    expect(chunks[1].metadata.approvalMode).toBe("auto-edit");
    expect(chunks[0].metadata.sandboxed).toBe(true);
  });

  it("filters incremental results by timestamp", async () => {
    const chunks: CodexChunk[] = [];
    for await (const chunk of scraper.scrape(new Date("2026-02-24T10:00:00Z"))) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe("codex second");
  });
});
