/**
 * Codex transcripts are append-only logs that were re-read in full on every
 * scan. A real store here holds 18GB across 841 files, with 94% of it in 17
 * files that never change again, so almost all of that work was finding a
 * handful of new lines at the end.
 *
 * The cursor records a byte offset per file and resumes from it. What these
 * tests pin is that resuming never costs correctness: a rewritten file is
 * re-read whole, `fullSync` ignores cursors entirely, and the derived state a
 * resumed read cannot see is carried across.
 */
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexCliScraper } from "@xtctx/scrapers/codex";
import type { CodexChunk } from "@xtctx/types/scraper";

const META = (id: string): string =>
  JSON.stringify({ timestamp: "2026-02-24T09:00:00Z", type: "session_meta", payload: { id } });

const MSG = (text: string, ts: string): string =>
  JSON.stringify({
    timestamp: ts,
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
  });

describe("codex incremental resume", () => {
  let sessionsDir = "";
  let stateDir = "";
  let file = "";

  beforeEach(async () => {
    sessionsDir = await mkdtemp(join(tmpdir(), "xtctx-codex-resume-"));
    stateDir = await mkdtemp(join(tmpdir(), "xtctx-codex-resume-state-"));
    file = join(sessionsDir, "rollout-2026-02-24T09-00-00-abc.jsonl");
  });

  afterEach(async () => {
    await rm(sessionsDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  const make = (): CodexCliScraper => new CodexCliScraper(sessionsDir, stateDir);

  async function scrape(s: CodexCliScraper): Promise<string[]> {
    const out: CodexChunk[] = [];
    for await (const c of s.scrape(new Date(0))) out.push(c);
    return out.map((c) => c.content);
  }

  async function cursor(): Promise<{ offset: number; size: number } | undefined> {
    const raw = await readFile(join(stateDir, "codex-state.json"), "utf-8").catch(() => "{}");
    return (JSON.parse(raw) as { files?: Record<string, { offset: number; size: number }> })
      .files?.[file];
  }

  it("records a cursor at the end of the file it read", async () => {
    await writeFile(file, [META("abc"), MSG("first", "2026-02-24T10:00:00Z")].join("\n") + "\n");
    expect(await scrape(make())).toContain("first");

    const c = await cursor();
    expect(c?.offset).toBeGreaterThan(0);
    expect(c?.offset).toBe(c?.size);
  });

  it("reads only what was appended on the next scrape", async () => {
    await writeFile(file, [META("abc"), MSG("first", "2026-02-24T10:00:00Z")].join("\n") + "\n");
    await scrape(make());

    await appendFile(file, MSG("second", "2026-02-24T11:00:00Z") + "\n");
    const again = await scrape(make());

    expect(again).toEqual(["second"]);
  });

  it("re-reads from the start when the file has shrunk", async () => {
    // The append-only assumption is an observation about how Codex behaves,
    // not something it guarantees. A rewritten file must cost a re-read rather
    // than silently skipped records.
    await writeFile(file, [META("abc"), MSG("first", "2026-02-24T10:00:00Z")].join("\n") + "\n");
    await scrape(make());

    await writeFile(file, [META("abc"), MSG("replaced", "2026-02-24T12:00:00Z")].join("\n") + "\n");
    expect(await scrape(make())).toEqual(["replaced"]);
  });

  it("keeps message indices continuous across a resume", async () => {
    // Chunk ids hash the index, so restarting it would re-emit the session
    // under new ids instead of deduplicating against what is already stored.
    await writeFile(file, [META("abc"), MSG("first", "2026-02-24T10:00:00Z")].join("\n") + "\n");
    const s1 = make();
    const before: CodexChunk[] = [];
    for await (const c of s1.scrape(new Date(0))) before.push(c);

    await appendFile(file, MSG("second", "2026-02-24T11:00:00Z") + "\n");
    const s2 = make();
    const after: CodexChunk[] = [];
    for await (const c of s2.scrape(new Date(0))) after.push(c);

    expect(after[0]?.metadata.messageIndex).toBe(
      (before[before.length - 1]?.metadata.messageIndex ?? 0) + 1,
    );
  });

  it("fullSync ignores cursors and leaves none behind", async () => {
    await writeFile(file, [META("abc"), MSG("first", "2026-02-24T10:00:00Z")].join("\n") + "\n");
    await scrape(make());

    const full: CodexChunk[] = [];
    for await (const c of make().fullSync()) full.push(c);
    // Reads everything despite the cursor sitting at end-of-file...
    expect(full.map((c) => c.content)).toEqual(["first"]);

    // ...and the next incremental scrape is not suppressed by it.
    await appendFile(file, MSG("second", "2026-02-24T11:00:00Z") + "\n");
    expect(await scrape(make())).toEqual(["second"]);
  });
});
