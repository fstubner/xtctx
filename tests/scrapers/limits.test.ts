/**
 * Transcript stores belong to other tools, so their size is not xtctx's to
 * trust — anything that can drop a file into `~/.claude/projects/<p>/` chooses
 * how large it is. Nothing capped a line's length, so a single unterminated
 * one was buffered whole before `JSON.parse` saw it, and the MCP server is a
 * long-lived process that wears that as resident memory.
 *
 * The cap is deliberately far above any real turn; these tests use a small
 * explicit limit rather than allocating 8MB to prove the boundary.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCodeScraper } from "@xtctx/scrapers/claude-code";
import { MAX_LINE_BYTES, isWithinFileLimit, isWithinLineLimit } from "@xtctx/scrapers/limits";
import type { ClaudeCodeChunk } from "@xtctx/types/scraper";

describe("transcript size limits", () => {
  it("accepts a line at the limit and rejects one past it", () => {
    expect(isWithinLineLimit("x".repeat(10), 10)).toBe(true);
    expect(isWithinLineLimit("x".repeat(11), 10)).toBe(false);
  });

  it("reports a missing file as within limit so size does not mask absence", async () => {
    // The caller's own error handling owns "file is gone"; silently
    // reclassifying it as "too big" would hide a real fault.
    expect(await isWithinFileLimit(join(tmpdir(), "xtctx-definitely-absent-000"))).toBe(true);
  });

  it("measures real files against the ceiling", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xtctx-limit-"));
    try {
      const p = join(dir, "f.txt");
      await writeFile(p, "12345", "utf-8");
      expect(await isWithinFileLimit(p, 5)).toBe(true);
      expect(await isWithinFileLimit(p, 4)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ClaudeCodeScraper oversized lines", () => {
  let tempDir = "";
  let stateDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "xtctx-claude-limit-"));
    stateDir = await mkdtemp(join(tmpdir(), "xtctx-state-limit-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  it("skips an oversized line but keeps parsing the rest of the file", async () => {
    const projectDir = join(tempDir, "oversized");
    await mkdir(projectDir, { recursive: true });

    // One line past the cap, sandwiched between two ordinary ones. Skipping
    // must not abandon the file — a poisoned line should cost that line only.
    const huge = JSON.stringify({
      type: "human",
      content: "x".repeat(MAX_LINE_BYTES + 1),
      timestamp: "2026-02-24T10:00:01Z",
    });

    await writeFile(
      join(projectDir, "s.jsonl"),
      [
        '{"type":"human","content":"before","timestamp":"2026-02-24T10:00:00Z"}',
        huge,
        '{"type":"human","content":"after","timestamp":"2026-02-24T10:00:02Z"}',
      ].join("\n") + "\n",
    );

    const scraper = new ClaudeCodeScraper(tempDir, stateDir);
    const chunks: ClaudeCodeChunk[] = [];
    for await (const chunk of scraper.fullSync()) chunks.push(chunk);

    const contents = chunks.map((c) => c.content);
    expect(contents).toContain("before");
    expect(contents).toContain("after");
    expect(contents.some((c) => c.length > MAX_LINE_BYTES)).toBe(false);
  });
});
