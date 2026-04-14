import Database from "better-sqlite3";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CopilotScraper } from "@xtctx/scrapers/copilot";
import type { CopilotChunk } from "@xtctx/types/scraper";

/**
 * VS Code stores Copilot Chat sessions in SQLite workspaceStorage files:
 *   <workspaceStoragePath>/<hash>/state.vscdb
 *
 * The table is ItemTable with a single key "interactive.sessions".
 * The value is a JSON object mapping numeric indices to session objects:
 *   {
 *     "0": {
 *       sessionId: string,
 *       creationDate: number (unix ms),
 *       requests: [{
 *         message: { parts: [{text: string}] },
 *         response: [{value: string}],
 *         isCanceled?: boolean,
 *         model?: string,
 *         agentId?: string,
 *       }]
 *     }
 *   }
 *
 * The scraper discovers db files via glob("*\/state.vscdb").
 */

const SESSION_UUID = "copilot-session-test-uuid";

/** Creates a workspaceStorage-style SQLite db under a hash subdirectory. */
async function createWorkspaceDb(
  workspaceStorageDir: string,
  hashDir: string,
  sessions: Record<string, unknown>,
): Promise<string> {
  const subdir = join(workspaceStorageDir, hashDir);
  await mkdir(subdir, { recursive: true });

  const dbPath = join(subdir, "state.vscdb");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value TEXT)");
  db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
    "interactive.sessions",
    JSON.stringify(sessions),
  );
  db.close();
  return dbPath;
}

describe("CopilotScraper", () => {
  let workspaceStorageDir = "";
  let stateDir = "";
  let scraper: CopilotScraper;

  // Base sessions data: two requests (one user+assistant pair each).
  const baseSessions = {
    "0": {
      sessionId: SESSION_UUID,
      creationDate: new Date("2026-02-24T10:00:00Z").getTime(),
      requests: [
        {
          message: { parts: [{ text: "copilot first" }] },
          response: [{ value: "copilot second" }],
          isCanceled: false,
          model: "gpt-4o-copilot",
        },
      ],
    },
  };

  beforeEach(async () => {
    workspaceStorageDir = await mkdtemp(join(tmpdir(), "xtctx-copilot-ws-"));
    stateDir = await mkdtemp(join(tmpdir(), "xtctx-state-"));

    await createWorkspaceDb(workspaceStorageDir, "abc123hash", baseSessions);

    scraper = new CopilotScraper(workspaceStorageDir, stateDir);
  });

  afterEach(async () => {
    await rm(workspaceStorageDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  it("detects workspaceStorage directory", async () => {
    expect(await scraper.detect()).toBe(true);
  });

  it("returns false for non-existent path", async () => {
    const absent = new CopilotScraper(join(workspaceStorageDir, "nonexistent"), stateDir);
    expect(await absent.detect()).toBe(false);
  });

  it("reads user and assistant messages from SQLite", async () => {
    const chunks: CopilotChunk[] = [];
    for await (const chunk of scraper.fullSync()) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);

    expect(chunks[0].role).toBe("user");
    expect(chunks[0].content).toBe("copilot first");
    expect(chunks[0].sessionId).toBe(SESSION_UUID);
    expect(chunks[0].metadata.model).toBe("gpt-4o-copilot");

    expect(chunks[1].role).toBe("assistant");
    expect(chunks[1].content).toBe("copilot second");
    expect(chunks[1].sessionId).toBe(SESSION_UUID);
  });

  it("skips canceled requests", async () => {
    const canceledSessions = {
      "0": {
        sessionId: "cancel-session",
        creationDate: new Date("2026-02-25T09:00:00Z").getTime(),
        requests: [
          {
            message: { parts: [{ text: "this was canceled" }] },
            response: [{ value: "never shown" }],
            isCanceled: true,
          },
          {
            message: { parts: [{ text: "real question" }] },
            response: [{ value: "real answer" }],
            isCanceled: false,
          },
        ],
      },
    };

    await createWorkspaceDb(workspaceStorageDir, "def456hash", canceledSessions);

    const chunks: CopilotChunk[] = [];
    for await (const chunk of scraper.fullSync()) {
      chunks.push(chunk);
    }

    const canceled = chunks.find((c) => c.content.includes("canceled"));
    expect(canceled).toBeUndefined();

    const real = chunks.find((c) => c.content === "real question");
    expect(real).toBeDefined();
  });

  it("concatenates multiple text parts in user message", async () => {
    const multiPartSessions = {
      "0": {
        sessionId: "multi-part",
        creationDate: new Date("2026-02-26T08:00:00Z").getTime(),
        requests: [
          {
            message: {
              parts: [{ text: "first part" }, { text: "second part" }],
            },
            response: [{ value: "ok" }],
          },
        ],
      },
    };

    await createWorkspaceDb(workspaceStorageDir, "ghi789hash", multiPartSessions);

    const chunks: CopilotChunk[] = [];
    for await (const chunk of scraper.fullSync()) {
      chunks.push(chunk);
    }

    const multiChunk = chunks.find((c) => c.content.startsWith("first part"));
    expect(multiChunk).toBeDefined();
    expect(multiChunk?.content).toBe("first part\nsecond part");
  });

  it("concatenates multiple response segments", async () => {
    const multiResponseSessions = {
      "0": {
        sessionId: "multi-response",
        creationDate: new Date("2026-02-26T09:00:00Z").getTime(),
        requests: [
          {
            message: { parts: [{ text: "question" }] },
            response: [{ value: "part A " }, { value: "part B" }],
          },
        ],
      },
    };

    await createWorkspaceDb(workspaceStorageDir, "jkl012hash", multiResponseSessions);

    const chunks: CopilotChunk[] = [];
    for await (const chunk of scraper.fullSync()) {
      chunks.push(chunk);
    }

    const assistant = chunks.find((c) => c.role === "assistant" && c.sessionId === "multi-response");
    expect(assistant).toBeDefined();
    expect(assistant?.content).toBe("part A part B");
  });

  it("discovers databases across multiple workspace hashes", async () => {
    const otherSessions = {
      "0": {
        sessionId: "other-workspace-session",
        creationDate: new Date("2026-02-27T10:00:00Z").getTime(),
        requests: [
          {
            message: { parts: [{ text: "from second workspace" }] },
            response: [{ value: "answered" }],
          },
        ],
      },
    };

    await createWorkspaceDb(workspaceStorageDir, "second-workspace-hash", otherSessions);

    const chunks: CopilotChunk[] = [];
    for await (const chunk of scraper.fullSync()) {
      chunks.push(chunk);
    }

    // Chunks from both workspace dirs
    expect(chunks.length).toBeGreaterThan(2);
    const fromSecond = chunks.find((c) => c.content === "from second workspace");
    expect(fromSecond).toBeDefined();
    expect(fromSecond?.sessionId).toBe("other-workspace-session");
  });

  it("returns sessions at or after the since cursor on incremental scrape", async () => {
    // Base session has creationDate = 2026-02-24T10:00:00Z.
    // Passing since = 2026-02-24T10:00:00Z uses >= comparison, so the base session
    // is still returned (boundary-inclusive).
    const chunks: CopilotChunk[] = [];
    for await (const chunk of scraper.scrape(new Date("2026-02-24T10:00:00Z"))) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.some((c) => c.sessionId === SESSION_UUID)).toBe(true);
  });

  it("filters out sessions older than the since cursor", async () => {
    // Passing a since value strictly after the base session's creationDate
    // should exclude it.
    const chunks: CopilotChunk[] = [];
    for await (const chunk of scraper.scrape(new Date("2026-02-25T00:00:00Z"))) {
      chunks.push(chunk);
    }

    // Base session (2026-02-24) is older than the cursor, so it is excluded.
    const baseChunk = chunks.find((c) => c.sessionId === SESSION_UUID);
    expect(baseChunk).toBeUndefined();
  });

  it("returns only newer session when since cursor is after base session", async () => {
    const newerSessions = {
      "0": {
        sessionId: "newer-session",
        creationDate: new Date("2026-02-25T12:00:00Z").getTime(),
        requests: [
          {
            message: { parts: [{ text: "newer question" }] },
            response: [{ value: "newer answer" }],
          },
        ],
      },
    };

    await createWorkspaceDb(workspaceStorageDir, "newer-ws-hash", newerSessions);

    const chunks: CopilotChunk[] = [];
    // Cursor is between the base session (2026-02-24) and the newer session (2026-02-25).
    for await (const chunk of scraper.scrape(new Date("2026-02-25T00:00:00Z"))) {
      chunks.push(chunk);
    }

    // Base session is filtered out; only the newer session is returned.
    const baseChunk = chunks.find((c) => c.sessionId === SESSION_UUID);
    expect(baseChunk).toBeUndefined();

    const newerChunk = chunks.find((c) => c.sessionId === "newer-session");
    expect(newerChunk).toBeDefined();
  });

  it("returns no chunks for workspace dir with no vscdb files", async () => {
    const emptyScraper = new CopilotScraper(
      await mkdtemp(join(tmpdir(), "xtctx-empty-")),
      stateDir,
    );
    const chunks: CopilotChunk[] = [];
    for await (const chunk of emptyScraper.fullSync()) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(0);
    await rm((emptyScraper as unknown as { workspaceStoragePath: string }).workspaceStoragePath, {
      recursive: true,
      force: true,
    });
  });

  it("gracefully skips databases without interactive.sessions key", async () => {
    const subdir = join(workspaceStorageDir, "empty-db-hash");
    await mkdir(subdir, { recursive: true });
    const emptyDbPath = join(subdir, "state.vscdb");
    const emptyDb = new Database(emptyDbPath);
    emptyDb.exec("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    emptyDb.close();

    const chunks: CopilotChunk[] = [];
    for await (const chunk of scraper.fullSync()) {
      chunks.push(chunk);
    }

    // Original base session should still appear
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it("detects agent completionType when agentId is present", async () => {
    const agentSessions = {
      "0": {
        sessionId: "agent-session",
        creationDate: new Date("2026-02-28T08:00:00Z").getTime(),
        requests: [
          {
            message: { parts: [{ text: "run my tests" }] },
            response: [{ value: "tests passed" }],
            model: "gpt-4o-copilot",
            agentId: "@workspace",
          },
        ],
      },
    };

    await createWorkspaceDb(workspaceStorageDir, "agent-ws-hash", agentSessions);

    const chunks: CopilotChunk[] = [];
    for await (const chunk of scraper.fullSync()) {
      chunks.push(chunk);
    }

    const agentChunk = chunks.find((c) => c.sessionId === "agent-session");
    expect(agentChunk).toBeDefined();
    expect(agentChunk?.metadata.completionType).toBe("agent");
  });
});
