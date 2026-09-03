/**
 * A codex transcript that never names a working directory belongs to nobody,
 * and must not be served to this project.
 *
 * Every existing boundary test gives the file a `cwd` somewhere — in
 * `session_meta` or in a `turn_context` — and then checks the right decision is
 * made about it. That leaves the *default* untested, and the default is what
 * decides a file with no `cwd` at all. Both halves of it survived a mutation
 * sweep:
 *
 *   - `matchesProject` returns `undefined` for a payload carrying no `cwd`,
 *     which must not be read as a match. Returning `true` there served every
 *     session whose `session_meta` omits the field.
 *   - the initial `projectMatched` is `false` whenever a project is being
 *     scoped to, so a file with neither a `session_meta` nor a `turn_context`
 *     is refused. Defaulting to `true` served it.
 *
 * Either way the records are stamped with this project's root on the way into
 * the index, so the index's own filter cannot catch them afterwards.
 *
 * The refusal also has to be *audible*. A whole transcript disappearing with
 * no signal is indistinguishable from the scraper working, which is why the
 * warning exists — and it survived being removed.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexCliScraper } from "@xtctx/scrapers/codex";
import type { CodexChunk } from "@xtctx/types/scraper";

const OURS = "H:/projects/ours";

const MSG = (text: string, ts: string): string =>
  JSON.stringify({
    timestamp: ts,
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
  });

describe("codex refuses a session that names no project", () => {
  let sessionsDir = "";
  let stateDir = "";
  let file = "";

  beforeEach(async () => {
    sessionsDir = await mkdtemp(join(tmpdir(), "xtctx-codex-unattr-"));
    stateDir = await mkdtemp(join(tmpdir(), "xtctx-codex-unattr-state-"));
    file = join(sessionsDir, "rollout-2026-02-24T09-00-00-abc.jsonl");
  });

  afterEach(async () => {
    await rm(sessionsDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  async function scrape(projectRoot?: string): Promise<string[]> {
    const out: CodexChunk[] = [];
    const scraper = new CodexCliScraper(sessionsDir, stateDir, projectRoot);
    for await (const chunk of scraper.fullSync()) out.push(chunk);
    return out.map((c) => c.content);
  }

  /** Captures drift warnings for the duration of one scrape. */
  async function scrapeCapturingWarnings(
    projectRoot?: string,
  ): Promise<{ content: string[]; warnings: string[] }> {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    try {
      return { content: await scrape(projectRoot), warnings };
    } finally {
      console.warn = original;
    }
  }

  it("does not serve a session whose session_meta carries no cwd", async () => {
    await writeFile(
      file,
      [
        JSON.stringify({
          timestamp: "2026-02-24T09:00:00Z",
          type: "session_meta",
          payload: { id: "abc" },
        }),
        MSG("UNATTRIBUTED: could be anyone's", "2026-02-24T10:00:00Z"),
      ].join("\n") + "\n",
    );

    expect(await scrape(OURS)).toEqual([]);
  });

  it("does not serve a session with no session_meta or turn_context at all", async () => {
    await writeFile(
      file,
      [
        MSG("UNATTRIBUTED: could be anyone's", "2026-02-24T10:00:00Z"),
        MSG("UNATTRIBUTED: and more of it", "2026-02-24T11:00:00Z"),
      ].join("\n") + "\n",
    );

    expect(await scrape(OURS)).toEqual([]);
  });

  it("says so, once, rather than dropping the transcript in silence", async () => {
    await writeFile(
      file,
      [
        MSG("UNATTRIBUTED: could be anyone's", "2026-02-24T10:00:00Z"),
        MSG("UNATTRIBUTED: and more of it", "2026-02-24T11:00:00Z"),
      ].join("\n") + "\n",
    );

    const { content, warnings } = await scrapeCapturingWarnings(OURS);

    expect(content).toEqual([]);
    const named = warnings.filter((w) => w.includes("no record names a project directory"));
    // Once per file. Per record is the crying-wolf failure this project has
    // already made once, and a real session holds thousands.
    expect(named).toHaveLength(1);
  });

  it("still serves a session whose session_meta does name this project", async () => {
    // The refusal must not become "refuse everything": a `cwd` that matches is
    // the ordinary case, and it has to keep working.
    await writeFile(
      file,
      [
        JSON.stringify({
          timestamp: "2026-02-24T09:00:00Z",
          type: "session_meta",
          payload: { id: "abc", cwd: OURS },
        }),
        MSG("ours", "2026-02-24T10:00:00Z"),
      ].join("\n") + "\n",
    );

    expect(await scrape(OURS)).toEqual(["ours"]);
  });

  it("still serves an unattributed session when there is no project to scope to", async () => {
    // Unscoped use — diagnostics, `xtctx status` — has no boundary to fail
    // closed on, so the default must not refuse there.
    await writeFile(file, MSG("no project scoping here", "2026-02-24T10:00:00Z") + "\n");

    expect(await scrape()).toEqual(["no project scoping here"]);
  });
});
