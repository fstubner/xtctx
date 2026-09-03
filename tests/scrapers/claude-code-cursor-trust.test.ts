/**
 * Two things a claude-code resume cursor must not do, both found by mutation.
 *
 * **It must not record ownership it never established.** A store directory
 * whose encoded name merely shares this project's prefix is opened — the
 * encoding maps `:`, `\` and `/` all to `-`, so the name alone cannot decide
 * anything — and a file in it whose records carry no `cwd` is refused. The
 * cursor then has to say so. Recording `projectMatched: true` regardless made
 * the *next* scan resume with the refusal already overturned, and every record
 * appended to that sibling's transcript was served as this project's. The
 * index's own `project_root` filter cannot catch it: the rows carry this
 * project's root because the scraper said they belonged.
 *
 * **It must not record a position past the last complete line.** These files
 * are being appended to while they are read, so the final line frequently has
 * no newline yet. `readJsonlLines` deliberately stops short of it; recording
 * the file's *size* instead of the boundary it actually reached moves the next
 * scan into the middle of that record, and the record is never yielded — a
 * permanent loss, silent, one per interrupted append.
 */
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCodeScraper } from "@xtctx/scrapers/claude-code";
import type { ClaudeCodeChunk } from "@xtctx/types/scraper";

const PROJECT = "H:/projects/demo";

/** A record that names no project, so only the file's own history can place it. */
const noCwd = (text: string, ts: string): string =>
  JSON.stringify({ type: "human", content: text, timestamp: ts });

const withCwd = (text: string, ts: string): string =>
  JSON.stringify({ type: "human", content: text, timestamp: ts, cwd: PROJECT });

interface SavedCursor {
  offset: number;
  size: number;
  context?: { projectMatched?: boolean };
}

describe("claude-code cursor cannot manufacture ownership", () => {
  let projectsDir = "";
  let stateDir = "";
  let file = "";

  beforeEach(async () => {
    projectsDir = await mkdtemp(join(tmpdir(), "xtctx-cc-trust-"));
    stateDir = await mkdtemp(join(tmpdir(), "xtctx-cc-trust-state-"));
    // Not this project's directory: a sibling whose encoded name shares the
    // prefix, which is exactly what the coarse directory filter lets through.
    const dir = join(projectsDir, "H--projects-demo-secret");
    await mkdir(dir, { recursive: true });
    file = join(dir, "s.jsonl");
  });

  afterEach(async () => {
    await rm(projectsDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  async function scrape(): Promise<string[]> {
    const out: ClaudeCodeChunk[] = [];
    const scraper = new ClaudeCodeScraper(projectsDir, stateDir, PROJECT);
    for await (const chunk of scraper.scrape(new Date(0))) out.push(chunk);
    return out.map((c) => c.content);
  }

  async function savedCursor(): Promise<SavedCursor | undefined> {
    const raw = await readFile(join(stateDir, "claude-code-state.json"), "utf-8").catch(() => "{}");
    return (JSON.parse(raw) as { files?: Record<string, SavedCursor> }).files?.[file];
  }

  it("does not serve a sibling's records appended after a refusing pass", async () => {
    await writeFile(file, noCwd("SIBLING: first", "2026-02-24T10:00:00Z") + "\n");
    expect(await scrape()).toEqual([]);

    // The leak: a resumed scan sees no `cwd` either — they are all behind the
    // cursor — so it can only act on what the cursor recorded.
    await appendFile(file, noCwd("SIBLING: appended later", "2026-02-24T11:00:00Z") + "\n");

    expect(await scrape()).toEqual([]);
  });

  it("records the refusal rather than a trusting default", async () => {
    // The property behind the test above, asserted where it is stored.
    await writeFile(file, noCwd("SIBLING: first", "2026-02-24T10:00:00Z") + "\n");
    await scrape();

    expect((await savedCursor())?.context?.projectMatched).toBe(false);
  });

  it("still carries a decision the file did make", async () => {
    // The refusal must not become "never trust a cursor": a file that names
    // this project settles its own ownership, and the cursor has to keep it or
    // every appended cwd-less record is dropped instead.
    await writeFile(file, withCwd("ours", "2026-02-24T10:00:00Z") + "\n");
    expect(await scrape()).toEqual(["ours"]);

    await appendFile(file, noCwd("ours, appended later", "2026-02-24T11:00:00Z") + "\n");
    expect(await scrape()).toEqual(["ours, appended later"]);
    expect((await savedCursor())?.context?.projectMatched).toBe(true);
  });
});

describe("claude-code cursor stops at the last complete line", () => {
  let projectsDir = "";
  let stateDir = "";
  let file = "";

  beforeEach(async () => {
    projectsDir = await mkdtemp(join(tmpdir(), "xtctx-cc-partial-"));
    stateDir = await mkdtemp(join(tmpdir(), "xtctx-cc-partial-state-"));
    const dir = join(projectsDir, "H--projects-demo");
    await mkdir(dir, { recursive: true });
    file = join(dir, "s.jsonl");
  });

  afterEach(async () => {
    await rm(projectsDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  async function scrape(): Promise<string[]> {
    const out: ClaudeCodeChunk[] = [];
    const scraper = new ClaudeCodeScraper(projectsDir, stateDir, PROJECT);
    for await (const chunk of scraper.scrape(new Date(0))) out.push(chunk);
    return out.map((c) => c.content);
  }

  it("yields a record that was still being written when the last scan ran", async () => {
    const second = withCwd("second", "2026-02-24T11:00:00Z");
    // Claude Code was mid-append: a complete first record, then half of the
    // second with no newline behind it.
    await writeFile(file, withCwd("first", "2026-02-24T10:00:00Z") + "\n" + second.slice(0, 30));
    expect(await scrape()).toEqual(["first"]);

    // The append finishes. Nothing has been rewritten, only completed.
    await writeFile(file, withCwd("first", "2026-02-24T10:00:00Z") + "\n" + second + "\n");

    expect(await scrape()).toEqual(["second"]);
  });

  it("records the boundary it read to, not the size of the file", async () => {
    const second = withCwd("second", "2026-02-24T11:00:00Z");
    const head = withCwd("first", "2026-02-24T10:00:00Z") + "\n";
    await writeFile(file, head + second.slice(0, 30));
    await scrape();

    const raw = await readFile(join(stateDir, "claude-code-state.json"), "utf-8");
    const cursor = (JSON.parse(raw) as { files?: Record<string, SavedCursor> }).files?.[file];

    expect(cursor?.offset).toBe(Buffer.byteLength(head));
    expect(cursor?.offset).toBeLessThan(cursor?.size ?? 0);
  });
});
