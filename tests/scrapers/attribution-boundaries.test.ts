/**
 * Two ways a scraper admitted another project's conversations.
 *
 * Cursor: `resolveWorkspaceDatabasePaths` scopes every database it *finds* by
 * walking a directory, but the branch that handles a `storePath` pointing
 * straight at a `state.vscdb` returned it unscoped. `.xtctx/config.yaml` is
 * committable and its `storePath` is resolved with no containment, so a
 * cloned repo could name any workspace database on the machine and have every
 * composer in it read as this project's.
 *
 * Antigravity: attribution is a substring search over whole message bodies,
 * with a boundary check on the right-hand side only. Any foreign path that
 * *ends with* this project's path — a backup, a container mount, a copy under
 * another name — matched, and admitted the conversation that mentioned it.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CursorScraper } from "@xtctx/scrapers/cursor";
import { textMentionsProject } from "@xtctx/scrapers/antigravity";

describe("cursor storePath pointing at a database file is still scoped", () => {
  let dir = "";
  const COMPOSER = "comp-scope-1";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "xtctx-cursor-scope-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * A real workspace database, with the `workspace.json` beside it naming a
   * project that is not ours — the arrangement scoping exists to reject.
   */
  async function seedForeignWorkspace(): Promise<string> {
    const wsDir = join(dir, "workspaceStorage", "abc");
    await mkdir(wsDir, { recursive: true });
    await writeFile(
      join(wsDir, "workspace.json"),
      JSON.stringify({ folder: "file:///H%3A/projects/someone-else" }),
      "utf-8",
    );

    // The workspace database lists which composers belong to it…
    const dbPath = join(wsDir, "state.vscdb");
    const ws = new Database(dbPath);
    ws.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    ws.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
      "composer.composerData",
      JSON.stringify({ allComposers: [{ composerId: COMPOSER }] }),
    );
    ws.close();

    // …and the message bodies live in globalStorage, a sibling of
    // workspaceStorage. Both halves are needed or the scraper reads nothing
    // and the test cannot tell scoping from an empty fixture.
    const globalDir = join(dir, "globalStorage");
    await mkdir(globalDir, { recursive: true });
    const global = new Database(join(globalDir, "state.vscdb"));
    global.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const insert = global.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
    insert.run(
      `composerData:${COMPOSER}`,
      JSON.stringify({
        composerId: COMPOSER,
        fullConversationHeadersOnly: [{ bubbleId: "b1", type: 1 }],
        createdAt: new Date("2026-02-24T10:00:00Z").getTime(),
        lastUpdatedAt: new Date("2026-02-24T10:00:00Z").getTime(),
      }),
    );
    insert.run(
      `bubbleId:${COMPOSER}:b1`,
      JSON.stringify({ type: 1, text: "someone else's work", createdAt: "2026-02-24T10:00:00Z" }),
    );
    global.close();
    return dbPath;
  }

  async function collect(scraper: CursorScraper): Promise<string[]> {
    const out: string[] = [];
    for await (const chunk of scraper.fullSync()) out.push(chunk.content);
    return out;
  }

  it("does not read a database whose workspace belongs to another project", async () => {
    const dbPath = await seedForeignWorkspace();

    // Named directly, which is what a committed `storePath` does. The
    // directory-walking branch scopes every database it finds; this one
    // returned the path unchecked.
    const scraper = new CursorScraper(dbPath, dir, "H:/projects/ours");

    expect(await collect(scraper)).toEqual([]);
  });

  it("reads it when the workspace does belong to this project", async () => {
    const dbPath = await seedForeignWorkspace();
    const scraper = new CursorScraper(dbPath, dir, "H:/projects/someone-else");

    expect(await collect(scraper)).toContain("someone else's work");
  });

  it("reads it when there is no project to scope to", async () => {
    // Unscoped construction is a real mode — diagnostics and `parseRaw` use
    // it — and must not become an unconditional refusal.
    const dbPath = await seedForeignWorkspace();
    const scraper = new CursorScraper(dbPath, dir);

    expect(await collect(scraper)).toContain("someone else's work");
  });
});

describe("antigravity path mentions need a boundary on both sides", () => {
  const ours = "H:/projects/app";

  it("does not match a foreign path that ends with this project's path", () => {
    // The half that was missing. Only the character *after* the match was
    // checked, so anything ending in the project path was accepted.
    expect(textMentionsProject("editing /mnt/backup/H:/projects/app/src/a.ts", ours)).toBe(false);
    expect(textMentionsProject("see D:/copies/H:/projects/app", ours)).toBe(false);
  });

  it("still matches the project's own path", () => {
    expect(textMentionsProject("editing H:/projects/app/src/a.ts", ours)).toBe(true);
    expect(textMentionsProject("cwd is H:/projects/app", ours)).toBe(true);
    expect(textMentionsProject('"H:/projects/app/README.md"', ours)).toBe(true);
  });

  it("still matches inside a file URI", () => {
    // The normaliser collapses `file:///` to `file:/`, so the character before
    // a POSIX path is `:` and before a Windows drive path is `/`. Both are
    // legitimate openers and neither may be treated as a continuation.
    expect(textMentionsProject("file:///H:/projects/app/src/a.ts", ours)).toBe(true);
    expect(textMentionsProject("file:///home/me/app/src/a.ts", "/home/me/app")).toBe(true);
  });

  it("still rejects a sibling that merely shares a prefix", () => {
    expect(textMentionsProject("editing H:/projects/app-secret/a.ts", ours)).toBe(false);
  });
});
