/**
 * Claude Code names its store directories by replacing every `:`, `\` and `/`
 * with `-`, which is lossy: `H:/projects/a` and `H:/projects-a` both encode to
 * `H--projects-a`. Two different projects therefore share one directory.
 *
 * That matters because a record with no `cwd` was admitted on the strength of
 * an exact directory match — the code called it "provenance". It is not: with
 * a collision, the directory says nothing about which of the two projects a
 * record came from, and 26% of real records carry no `cwd`, so this is the
 * common case rather than an edge.
 *
 * Failing closed would drop that quarter of the corpus. The directory's own
 * contents are the better evidence: the records that *do* carry a `cwd` say
 * which project the file belongs to, and the ones that do not belong to
 * whichever project that is.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCodeScraper } from "@xtctx/scrapers/claude-code";
import type { ClaudeCodeChunk } from "@xtctx/types/scraper";

const COLLIDING_DIR = "H--projects-a";

function record(content: string, cwd?: string): string {
  return JSON.stringify({
    type: "human",
    content,
    timestamp: "2026-02-24T10:00:00Z",
    ...(cwd ? { cwd } : {}),
  });
}

describe("claude-code provenance under an encoded-directory collision", () => {
  let projectsDir = "";
  let stateDir = "";

  beforeEach(async () => {
    projectsDir = await mkdtemp(join(tmpdir(), "xtctx-cc-prov-"));
    stateDir = await mkdtemp(join(tmpdir(), "xtctx-cc-state-"));
    await mkdir(join(projectsDir, COLLIDING_DIR), { recursive: true });
  });

  afterEach(async () => {
    await rm(projectsDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  async function collect(projectRoot: string): Promise<string[]> {
    const scraper = new ClaudeCodeScraper(projectsDir, stateDir, projectRoot);
    const out: ClaudeCodeChunk[] = [];
    for await (const c of scraper.fullSync()) out.push(c);
    return out.map((c) => c.content);
  }

  it("does not hand another project's cwd-less records to this one", async () => {
    // One file, in the directory both projects encode to, whose own records
    // say it belongs to `H:/projects-a`. A session for `H:/projects/a` must
    // take nothing from it — including the cwd-less line.
    await writeFile(
      join(projectsDir, COLLIDING_DIR, "other.jsonl"),
      [
        record("belongs to the other project", "H:/projects-a"),
        record("no cwd on this one, but same file"),
      ].join("\n") + "\n",
    );

    expect(await collect("H:/projects/a")).toEqual([]);
  });

  it("still takes cwd-less records from a file that is genuinely this project's", async () => {
    // The 26% case. Dropping these would gut the scraper, so evidence that the
    // file is ours has to carry them.
    await writeFile(
      join(projectsDir, COLLIDING_DIR, "ours.jsonl"),
      [
        record("belongs to us", "H:/projects/a"),
        record("no cwd, and ours by association"),
      ].join("\n") + "\n",
    );

    const got = await collect("H:/projects/a");
    expect(got).toContain("belongs to us");
    expect(got).toContain("no cwd, and ours by association");
  });

  it("resolves ownership from a cwd that appears after the cwd-less records", async () => {
    // Ownership is not known when the first line is read, so a decision made
    // eagerly on line one would be made without evidence.
    await writeFile(
      join(projectsDir, COLLIDING_DIR, "late.jsonl"),
      [
        record("first, no cwd"),
        record("second, no cwd"),
        record("third, with cwd", "H:/projects-a"),
      ].join("\n") + "\n",
    );

    expect(await collect("H:/projects/a")).toEqual([]);
  });

  it("keeps taking records whose own cwd matches, whatever else is in the file", async () => {
    await writeFile(
      join(projectsDir, COLLIDING_DIR, "mixed.jsonl"),
      [
        record("theirs", "H:/projects-a"),
        record("ours", "H:/projects/a"),
      ].join("\n") + "\n",
    );

    const got = await collect("H:/projects/a");
    expect(got).toEqual(["ours"]);
  });
});
