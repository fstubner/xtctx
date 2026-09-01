/**
 * A resumed scan must never inherit "this file is ours" from a pass that
 * never decided.
 *
 * `copilot-cli` attributes a session from its `session.start` context, and
 * fails closed when there is none — but only at the point where content is
 * about to be emitted. A session file that has no content-bearing event yet
 * never reaches that guard, so the pass ends undecided and the cursor was
 * written as `projectMatch ?? true`: resume here, and trust it.
 *
 * Everything appended afterwards is then indexed on that inherited decision,
 * including turns whose only context names a different project. The index's
 * own `project_root` filter cannot catch it — the rows are stamped with *this*
 * project's root on the way in, because the scraper said they belonged.
 *
 * `codex.ts` gets the same default right (`this.projectRoot ? false : true`).
 * This is the path that fix missed, and the checklist control claiming
 * resumed scans cannot inherit a boundary decision cited only the codex test.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CopilotCliScraper } from "@xtctx/scrapers/copilot-cli";
import type { CopilotCliChunk } from "@xtctx/types/scraper";

const OURS = "H:/projects/ours";

describe("copilot-cli resume cannot inherit an undecided boundary", () => {
  let rootDir = "";
  let stateDir = "";
  let events = "";

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "xtctx-cc-resume-"));
    stateDir = await mkdtemp(join(tmpdir(), "xtctx-cc-resume-state-"));
    const sessionDir = join(rootDir, "sess-1");
    await mkdir(sessionDir, { recursive: true });
    events = join(sessionDir, "events.jsonl");
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  async function scrape(): Promise<string[]> {
    const out: CopilotCliChunk[] = [];
    const scraper = new CopilotCliScraper(rootDir, stateDir, OURS);
    for await (const chunk of scraper.scrape(new Date(0))) out.push(chunk);
    return out.map((c) => c.content);
  }

  const turn = (text: string): string =>
    JSON.stringify({
      type: "assistant.message",
      timestamp: "2026-02-24T11:00:00Z",
      data: { role: "assistant", content: text },
    });

  it("does not index content appended after an undecided first pass", async () => {
    // Nothing here decides anything: no session.start, no content. The first
    // pass has nothing to emit and nothing to attribute.
    await writeFile(
      events,
      JSON.stringify({ type: "session.meta", timestamp: "2026-02-24T10:00:00Z" }) + "\n",
    );
    expect(await scrape()).toEqual([]);

    // Content arrives, still with nothing attributing it. A fresh scan
    // refuses this — that is the `projectMatch === null` guard's whole
    // purpose. A resumed scan inherited "trusted" from the pass that never
    // decided, and indexed it.
    await appendFile(events, turn("UNATTRIBUTED CONTENT") + "\n");

    expect(await scrape()).toEqual([]);
  });

  it("does not record a trusting cursor for a file it never attributed", async () => {
    // The property behind the test above. A cursor that says "trust this"
    // about a file nothing has attributed is the whole defect.
    await writeFile(
      events,
      JSON.stringify({ type: "session.meta", timestamp: "2026-02-24T10:00:00Z" }) + "\n",
    );
    await scrape();

    const raw = await readFile(join(stateDir, "copilot-cli-state.json"), "utf-8").catch(() => "{}");
    const saved = (
      JSON.parse(raw) as {
        files?: Record<string, { context?: { projectMatched?: boolean } }>;
      }
    ).files?.[events];

    expect(saved?.context?.projectMatched ?? false).toBe(false);
  });

  it("still reads a session that does belong to this project, across a resume", async () => {
    // The fix must not turn "undecided" into "never index anything".
    await writeFile(
      events,
      JSON.stringify({
        type: "session.start",
        timestamp: "2026-02-24T10:00:00Z",
        data: { context: { cwd: OURS } },
      }) + "\n",
    );
    expect(await scrape()).toEqual([]);

    await appendFile(events, turn("ours, appended later") + "\n");
    expect(await scrape()).toEqual(["ours, appended later"]);
  });

  it("records a trusting cursor only when there is no project to scope to", async () => {
    // The unscoped branch of the default, asserted on the cursor rather than
    // on the chunks. The first version of this test did a single pass and
    // never resumed, so it never read the value it appeared to guard —
    // dropping the unscoped branch entirely left it green.
    await writeFile(events, turn("unscoped") + "\n");

    const out: CopilotCliChunk[] = [];
    const scraper = new CopilotCliScraper(rootDir, stateDir);
    for await (const chunk of scraper.scrape(new Date(0))) out.push(chunk);
    expect(out.map((c) => c.content)).toEqual(["unscoped"]);

    const raw = await readFile(join(stateDir, "copilot-cli-state.json"), "utf-8").catch(() => "{}");
    const saved = (
      JSON.parse(raw) as { files?: Record<string, { context?: { projectMatched?: boolean } }> }
    ).files?.[events];

    // Unscoped use has no boundary to fail closed on, so the cursor must say
    // so — otherwise a later scoped scan of the same store would inherit a
    // refusal nothing decided.
    expect(saved?.context?.projectMatched).toBe(true);
  });
});
