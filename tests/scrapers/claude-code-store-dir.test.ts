/**
 * Claude Code hands its hooks a `transcript_path` — a documented input field —
 * which resolves to `<store>/<project>/<session-id>.jsonl`. Its directory is
 * therefore the authoritative store directory for the project, stated by the
 * tool rather than reconstructed by us.
 *
 * xtctx reconstructed it instead, by re-implementing the tool's own path
 * encoding and then matching directory names by prefix. That encoding is lossy
 * — `:`, `\` and `/` all become `-` — so two different projects can produce one
 * directory name, and the prefix rule widens the match further. It is also
 * defeated outright by `CLAUDE_CONFIG_DIR`, which moves the whole tree
 * somewhere the derived path never looks.
 *
 * Given the real directory there is nothing to derive and nothing to guess.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCodeScraper } from "@xtctx/scrapers/claude-code";
import type { ClaudeCodeChunk } from "@xtctx/types/scraper";

function record(content: string, cwd: string): string {
  return JSON.stringify({ type: "human", content, timestamp: "2026-02-24T10:00:00Z", cwd });
}

describe("claude-code explicit store directory", () => {
  let projectsDir = "";
  let stateDir = "";

  beforeEach(async () => {
    projectsDir = await mkdtemp(join(tmpdir(), "xtctx-cc-store-"));
    stateDir = await mkdtemp(join(tmpdir(), "xtctx-cc-store-state-"));
  });

  afterEach(async () => {
    await rm(projectsDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  async function seed(dirName: string, file: string, lines: string[]): Promise<string> {
    const dir = join(projectsDir, dirName);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, file), lines.join("\n") + "\n");
    return dir;
  }

  async function collect(scraper: ClaudeCodeScraper): Promise<string[]> {
    const out: ClaudeCodeChunk[] = [];
    for await (const c of scraper.fullSync()) out.push(c);
    return out.map((c) => c.content);
  }

  it("reads only the directory it was given, ignoring a prefix-matching sibling", async () => {
    // `H--projects-a` is what the encoder produces for BOTH `H:/projects/a`
    // and `H:/projects-a`; the prefix rule then also admits `H--projects-a-v2`.
    const ours = await seed("H--projects-a", "s1.jsonl", [record("ours", "H:/projects/a")]);
    await seed("H--projects-a-v2", "s2.jsonl", [record("a different project", "H:/projects/a-v2")]);

    const scraper = new ClaudeCodeScraper(projectsDir, stateDir, "H:/projects/a", ours);

    expect(await collect(scraper)).toEqual(["ours"]);
  });

  it("works when the store is somewhere the derived path would never look", async () => {
    // What `CLAUDE_CONFIG_DIR` does. The directory name here encodes nothing
    // about the project, so reconstruction cannot find it at all.
    const moved = await seed("relocated-by-config-dir", "s.jsonl", [
      record("still ours", "H:/projects/a"),
    ]);

    const scraper = new ClaudeCodeScraper(projectsDir, stateDir, "H:/projects/a", moved);

    expect(await collect(scraper)).toEqual(["still ours"]);
  });

  it("treats the given directory as provenance for records with no cwd", async () => {
    // The directory was named by the tool, so it is evidence in a way a
    // reconstructed name never was: nothing else can collide with it.
    const ours = await seed("H--projects-a", "s.jsonl", [
      JSON.stringify({ type: "human", content: "no cwd here", timestamp: "2026-02-24T10:00:00Z" }),
    ]);

    const scraper = new ClaudeCodeScraper(projectsDir, stateDir, "H:/projects/a", ours);

    expect(await collect(scraper)).toEqual(["no cwd here"]);
  });

  it("falls back to reconstruction when no directory is given", async () => {
    // Every other caller — `xtctx status`, a manual scrape, the MCP server
    // started outside a hook — has no hook payload to draw on.
    await seed("H--projects-a", "s.jsonl", [record("found by encoding", "H:/projects/a")]);

    const scraper = new ClaudeCodeScraper(projectsDir, stateDir, "H:/projects/a");

    expect(await collect(scraper)).toEqual(["found by encoding"]);
  });
});
