/**
 * The same resume contract the codex scraper is held to, applied to the other
 * two JSONL readers. Each carries different head-of-file derived state —
 * claude-code decides file ownership from `cwd` fields, copilot-cli from a
 * `session.start` record — so each needed its own analysis, and each needs its
 * own proof that resuming does not quietly change what is emitted.
 */
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCodeScraper } from "@xtctx/scrapers/claude-code";
import type { ClaudeCodeChunk } from "@xtctx/types/scraper";

const PROJECT = "H:/projects/demo";

const rec = (text: string, ts: string): string =>
  JSON.stringify({ type: "human", content: text, timestamp: ts, cwd: PROJECT });

describe("claude-code incremental resume", () => {
  let projectsDir = "";
  let stateDir = "";
  let file = "";

  beforeEach(async () => {
    projectsDir = await mkdtemp(join(tmpdir(), "xtctx-cc-resume-"));
    stateDir = await mkdtemp(join(tmpdir(), "xtctx-cc-resume-state-"));
    const dir = join(projectsDir, "H--projects-demo");
    await mkdir(dir, { recursive: true });
    file = join(dir, "s.jsonl");
  });

  afterEach(async () => {
    await rm(projectsDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  const make = (): ClaudeCodeScraper =>
    new ClaudeCodeScraper(projectsDir, stateDir, PROJECT);

  async function scrape(): Promise<ClaudeCodeChunk[]> {
    const out: ClaudeCodeChunk[] = [];
    for await (const c of make().scrape(new Date(0))) out.push(c);
    return out;
  }

  it("reads only what was appended", async () => {
    await writeFile(file, rec("first", "2026-02-24T10:00:00Z") + "\n");
    expect((await scrape()).map((c) => c.content)).toEqual(["first"]);

    await appendFile(file, rec("second", "2026-02-24T11:00:00Z") + "\n");
    expect((await scrape()).map((c) => c.content)).toEqual(["second"]);
  });

  it("keeps message indices continuous across the resume", async () => {
    // Chunk ids hash the index; restarting it re-emits the session under new
    // ids instead of deduplicating against what is stored.
    await writeFile(file, rec("first", "2026-02-24T10:00:00Z") + "\n");
    const before = await scrape();
    await appendFile(file, rec("second", "2026-02-24T11:00:00Z") + "\n");
    const after = await scrape();

    expect(after[0]?.metadata.messageIndex).toBe(
      (before[before.length - 1]?.metadata.messageIndex ?? 0) + 1,
    );
  });

  it("carries file ownership, so appended records with no cwd are still ours", async () => {
    // Ownership is decided by `cwd` fields near the head of the file. A
    // resumed read sees none of them, so without the carried decision every
    // appended cwd-less record would be dropped.
    await writeFile(file, rec("first", "2026-02-24T10:00:00Z") + "\n");
    await scrape();

    await appendFile(
      file,
      JSON.stringify({ type: "human", content: "no cwd", timestamp: "2026-02-24T11:00:00Z" }) + "\n",
    );

    expect((await scrape()).map((c) => c.content)).toEqual(["no cwd"]);
  });

  it("re-reads a file rewritten to the same length", async () => {
    await writeFile(file, rec("aaaaa", "2026-02-24T10:00:00Z") + "\n");
    await scrape();

    await writeFile(file, rec("bbbbb", "2026-02-24T12:00:00Z") + "\n");
    expect((await scrape()).map((c) => c.content)).toEqual(["bbbbb"]);
  });

  it("fullSync ignores cursors and leaves none behind", async () => {
    await writeFile(file, rec("first", "2026-02-24T10:00:00Z") + "\n");
    await scrape();

    const full: ClaudeCodeChunk[] = [];
    for await (const c of make().fullSync()) full.push(c);
    expect(full.map((c) => c.content)).toEqual(["first"]);

    await appendFile(file, rec("second", "2026-02-24T11:00:00Z") + "\n");
    expect((await scrape()).map((c) => c.content)).toEqual(["second"]);
  });

  it("records a cursor at the end of the file", async () => {
    await writeFile(file, rec("first", "2026-02-24T10:00:00Z") + "\n");
    await scrape();

    const raw = await readFile(join(stateDir, "claude-code-state.json"), "utf-8");
    const cursor = (JSON.parse(raw) as { files?: Record<string, { offset: number; size: number }> })
      .files?.[file];
    expect(cursor?.offset).toBe(cursor?.size);
  });
});
