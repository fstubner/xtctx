/**
 * Codex records the working directory per turn, in `turn_context`. When one
 * names a directory outside this project the reader stops, which is right:
 * the rest of the file belongs to somewhere else.
 *
 * Stopping was not enough once cursors arrived. The byte offset is advanced at
 * the top of the loop, before the record is classified, so by the time the
 * reader breaks it has already moved past the mismatching line — and
 * `projectMatched` still holds whatever the *previous*, matching turn set. The
 * cursor was then written with both: resume here, and trust it.
 *
 * The next scan therefore starts after the mismatch with the boundary check
 * already satisfied, and every message of the foreign turn is indexed and
 * served as this project's context. `cd` mid-session is all it takes, and it
 * leaks a further turn on each scan.
 *
 * `PRODUCT.md` promises content from other projects never crosses the
 * boundary, so this is the contract, not a hardening nicety.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexCliScraper } from "@xtctx/scrapers/codex";
import type { CodexChunk } from "@xtctx/types/scraper";

const META = (id: string, cwd: string): string =>
  JSON.stringify({
    timestamp: "2026-02-24T09:00:00Z",
    type: "session_meta",
    payload: { id, cwd },
  });

const TURN = (cwd: string): string =>
  JSON.stringify({
    timestamp: "2026-02-24T09:30:00Z",
    type: "turn_context",
    payload: { cwd, approval_policy: "on-request" },
  });

const MSG = (text: string, ts: string): string =>
  JSON.stringify({
    timestamp: ts,
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
  });

describe("codex project boundary survives a resume", () => {
  let sessionsDir = "";
  let stateDir = "";
  let file = "";
  const ours = "H:/projects/ours";
  const theirs = "H:/projects/someone-else";

  beforeEach(async () => {
    sessionsDir = await mkdtemp(join(tmpdir(), "xtctx-codex-boundary-"));
    stateDir = await mkdtemp(join(tmpdir(), "xtctx-codex-boundary-state-"));
    file = join(sessionsDir, "rollout-2026-02-24T09-00-00-abc.jsonl");
  });

  afterEach(async () => {
    await rm(sessionsDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  const make = (): CodexCliScraper => new CodexCliScraper(sessionsDir, stateDir, ours);

  async function scrape(): Promise<string[]> {
    const out: CodexChunk[] = [];
    for await (const c of make().scrape(new Date(0))) out.push(c);
    return out.map((c) => c.content);
  }

  /** A session that starts here and moves elsewhere part-way through. */
  async function seedSessionThatMovesAway(): Promise<void> {
    await writeFile(
      file,
      [
        META("abc", ours),
        TURN(ours),
        MSG("ours, before the move", "2026-02-24T10:00:00Z"),
        TURN(theirs),
        MSG("THEIRS: a secret from another project", "2026-02-24T11:00:00Z"),
        MSG("THEIRS: more of someone else's work", "2026-02-24T12:00:00Z"),
      ].join("\n") + "\n",
    );
  }

  it("does not serve the other project's turn on a later scan", async () => {
    await seedSessionThatMovesAway();

    const first = await scrape();
    expect(first).toEqual(["ours, before the move"]);

    // The leak: resuming past the mismatch with the trust flag still set.
    const second = await scrape();
    expect(second.filter((c) => c.includes("THEIRS"))).toEqual([]);
  });

  it("still leaks nothing after several scans", async () => {
    // It leaked a turn at a time, so one extra scan is not proof of a fix.
    await seedSessionThatMovesAway();

    const seen: string[] = [];
    for (let i = 0; i < 4; i++) seen.push(...(await scrape()));

    expect(seen.filter((c) => c.includes("THEIRS"))).toEqual([]);
    expect(seen).toEqual(["ours, before the move"]);
  });

  it("does not record a resumable position past the boundary it refused", async () => {
    // The property behind both tests above, asserted directly: whatever the
    // cursor says, it must not say "carry on from here, and trust it".
    await seedSessionThatMovesAway();
    await scrape();

    const raw = await readFile(join(stateDir, "codex-state.json"), "utf-8").catch(() => "{}");
    const saved = (
      JSON.parse(raw) as {
        files?: Record<string, { offset: number; context?: { projectMatched?: boolean } }>;
      }
    ).files?.[file];

    expect(saved?.context?.projectMatched ?? false).toBe(false);
  });

  it("keeps reading a session that stays in this project", async () => {
    // The fix must not turn every `turn_context` into a stop.
    await writeFile(
      file,
      [
        META("abc", ours),
        TURN(ours),
        MSG("first", "2026-02-24T10:00:00Z"),
        TURN(ours),
        MSG("second", "2026-02-24T11:00:00Z"),
      ].join("\n") + "\n",
    );

    expect(await scrape()).toEqual(["first", "second"]);
  });
});
