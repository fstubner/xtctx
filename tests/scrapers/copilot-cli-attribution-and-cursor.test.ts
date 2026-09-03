/**
 * Four copilot-cli behaviours that a mutation sweep found nothing defending.
 *
 * **A `session.start` with no context is not a match.** Attribution reads
 * `data.context.cwd` and `data.context.gitRoot`; when either level is missing
 * there is nothing to compare against, and the answer has to be no. Returning
 * `true` there served every session whose start record lost its payload —
 * which is also what a field rename looks like, so the failure arrives on the
 * day the format changes and takes the project boundary with it.
 *
 * **`gitRoot` is a real attribution source, not a spare one.** Copilot CLI
 * records the repository root alongside the working directory, and the working
 * directory is the one that can be absent. Dropping `gitRoot` from the
 * candidates loses every session that recorded only the repo.
 *
 * **A record below the incremental cutoff still consumes a message index.**
 * Chunk ids hash the index, so an index that counts differently on a full sync
 * and an incremental one re-emits the same turn under a second id instead of
 * deduplicating against what is already stored.
 *
 * **The cursor stops at the last complete line.** These files are appended to
 * while they are read, so the final line often has no newline yet, and
 * `readJsonlLines` stops short of it on purpose. Recording the file's *size*
 * instead moves the next scan into the middle of that record, and it is never
 * yielded — lost permanently, and silently.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CopilotCliScraper } from "@xtctx/scrapers/copilot-cli";
import type { CopilotCliChunk } from "@xtctx/types/scraper";

const OURS = "H:/projects/ours";

const turn = (text: string, ts: string): string =>
  JSON.stringify({
    type: "assistant.message",
    timestamp: ts,
    data: { role: "assistant", content: text },
  });

const start = (context: unknown): string =>
  JSON.stringify({
    type: "session.start",
    timestamp: "2026-02-24T09:00:00Z",
    ...(context === undefined ? {} : { data: { context } }),
  });

interface SavedCursor {
  offset: number;
  size: number;
  context?: { projectMatched?: boolean };
}

describe("copilot-cli session.start attribution", () => {
  let rootDir = "";
  let stateDir = "";
  let events = "";

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "xtctx-cp-attr-"));
    stateDir = await mkdtemp(join(tmpdir(), "xtctx-cp-attr-state-"));
    const sessionDir = join(rootDir, "sess-1");
    await mkdir(sessionDir, { recursive: true });
    events = join(sessionDir, "events.jsonl");
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  async function scrape(projectRoot?: string): Promise<string[]> {
    const out: CopilotCliChunk[] = [];
    const scraper = new CopilotCliScraper(rootDir, stateDir, projectRoot);
    for await (const chunk of scraper.fullSync()) out.push(chunk);
    return out.map((c) => c.content);
  }

  it("does not attribute a session whose start record carries no context", async () => {
    await writeFile(
      events,
      [
        JSON.stringify({ type: "session.start", timestamp: "2026-02-24T09:00:00Z", data: {} }),
        turn("UNATTRIBUTED: could be anyone's", "2026-02-24T10:00:00Z"),
      ].join("\n") + "\n",
    );

    expect(await scrape(OURS)).toEqual([]);
  });

  it("does not attribute a session whose start record carries no data at all", async () => {
    await writeFile(
      events,
      [start(undefined), turn("UNATTRIBUTED: could be anyone's", "2026-02-24T10:00:00Z")].join(
        "\n",
      ) + "\n",
    );

    expect(await scrape(OURS)).toEqual([]);
  });

  it("attributes a session that recorded only its gitRoot", async () => {
    // `cwd` is the field that can be absent. Reading only `cwd` loses the whole
    // session rather than mis-serving it, which is why dropping `gitRoot` was
    // silent — nothing appears wrong, the history is just not there.
    await writeFile(
      events,
      [start({ gitRoot: OURS }), turn("ours, by gitRoot", "2026-02-24T10:00:00Z")].join("\n") + "\n",
    );

    expect(await scrape(OURS)).toEqual(["ours, by gitRoot"]);
  });

  it("still refuses a gitRoot belonging to another project", async () => {
    await writeFile(
      events,
      [
        start({ gitRoot: "H:/projects/someone-else" }),
        turn("THEIRS: someone else's work", "2026-02-24T10:00:00Z"),
      ].join("\n") + "\n",
    );

    expect(await scrape(OURS)).toEqual([]);
  });
});

describe("copilot-cli message index is the same on a full and an incremental read", () => {
  let rootDir = "";
  let stateDir = "";
  let events = "";

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "xtctx-cp-index-"));
    stateDir = await mkdtemp(join(tmpdir(), "xtctx-cp-index-state-"));
    const sessionDir = join(rootDir, "sess-1");
    await mkdir(sessionDir, { recursive: true });
    events = join(sessionDir, "events.jsonl");
    await writeFile(
      events,
      [
        start({ cwd: OURS }),
        turn("first", "2026-02-24T10:00:00Z"),
        turn("second", "2026-02-24T11:00:00Z"),
      ].join("\n") + "\n",
    );
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  it("gives a turn the same index whether or not the turns before it were emitted", async () => {
    const full: CopilotCliChunk[] = [];
    for await (const chunk of new CopilotCliScraper(rootDir, stateDir, OURS).fullSync()) {
      full.push(chunk);
    }
    const secondOnFullSync = full.find((c) => c.content === "second");

    // A separate state directory, so this is a first incremental read rather
    // than a resume of the one above.
    const otherState = await mkdtemp(join(tmpdir(), "xtctx-cp-index-state2-"));
    const partial: CopilotCliChunk[] = [];
    try {
      const scraper = new CopilotCliScraper(rootDir, otherState, OURS);
      for await (const chunk of scraper.scrape(new Date("2026-02-24T10:30:00Z"))) {
        partial.push(chunk);
      }
    } finally {
      await rm(otherState, { recursive: true, force: true });
    }

    expect(partial.map((c) => c.content)).toEqual(["second"]);
    expect(secondOnFullSync?.metadata.messageIndex).toBe(1);
    expect(partial[0]?.metadata.messageIndex).toBe(secondOnFullSync?.metadata.messageIndex);
  });
});

describe("copilot-cli cursor stops at the last complete line", () => {
  let rootDir = "";
  let stateDir = "";
  let events = "";
  const head = [start({ cwd: OURS }), turn("first", "2026-02-24T10:00:00Z")].join("\n") + "\n";
  const second = turn("second", "2026-02-24T11:00:00Z");

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "xtctx-cp-partial-"));
    stateDir = await mkdtemp(join(tmpdir(), "xtctx-cp-partial-state-"));
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

  it("yields a record that was still being written when the last scan ran", async () => {
    await writeFile(events, head + second.slice(0, 30));
    expect(await scrape()).toEqual(["first"]);

    // The append finishes. Nothing was rewritten, only completed.
    await writeFile(events, head + second + "\n");

    expect(await scrape()).toEqual(["second"]);
  });

  it("records the boundary it read to, not the size of the file", async () => {
    await writeFile(events, head + second.slice(0, 30));
    await scrape();

    const raw = await readFile(join(stateDir, "copilot-cli-state.json"), "utf-8");
    const cursor = (JSON.parse(raw) as { files?: Record<string, SavedCursor> }).files?.[events];

    expect(cursor?.offset).toBe(Buffer.byteLength(head));
    expect(cursor?.offset).toBeLessThan(cursor?.size ?? 0);
  });
});
