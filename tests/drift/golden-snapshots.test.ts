/**
 * Golden snapshot tests for each scraper.
 *
 * A known-good fixture is constructed deterministically, the scraper runs,
 * and the normalized output is compared against the committed snapshot JSON.
 *
 * To regenerate (deliberately) after a legitimate scraper change:
 *   XTCTX_UPDATE_SNAPSHOTS=1 npm run test:drift
 */

import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ClaudeCodeScraper } from "@xtctx/scrapers/claude-code";
import { CodexCliScraper } from "@xtctx/scrapers/codex";
import { CopilotScraper } from "@xtctx/scrapers/copilot";
import { CursorScraper } from "@xtctx/scrapers/cursor";
import { GeminiCliScraper } from "@xtctx/scrapers/gemini";
import type { ConversationChunk, ConversationScraper } from "@xtctx/types/scraper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = resolve(__dirname, "snapshots");

function normalise(chunks: ConversationChunk[]): unknown {
  return chunks
    .map((chunk) => ({
      tool: chunk.tool,
      sessionId: chunk.sessionId,
      role: chunk.role,
      content: chunk.content,
      timestamp: chunk.timestamp.toISOString(),
      messageIndex: chunk.metadata.messageIndex,
      tokenEstimate: chunk.metadata.tokenEstimate,
    }))
    .sort((a, b) => {
      if (a.sessionId !== b.sessionId) return a.sessionId.localeCompare(b.sessionId);
      if (a.timestamp !== b.timestamp) return a.timestamp.localeCompare(b.timestamp);
      return a.messageIndex - b.messageIndex;
    });
}

async function collectChunks(scraper: ConversationScraper): Promise<ConversationChunk[]> {
  const chunks: ConversationChunk[] = [];
  for await (const chunk of scraper.fullSync()) {
    chunks.push(chunk);
  }
  return chunks;
}

async function assertSnapshot(tool: string, normalized: unknown): Promise<void> {
  const snapshotPath = join(SNAPSHOT_DIR, `${tool}.json`);
  const update = process.env.XTCTX_UPDATE_SNAPSHOTS === "1" || !existsSync(snapshotPath);

  if (update) {
    await mkdir(dirname(snapshotPath), { recursive: true });
    await writeFile(snapshotPath, JSON.stringify(normalized, null, 2) + "\n", "utf-8");
    return;
  }

  const committed = JSON.parse(await readFile(snapshotPath, "utf-8")) as unknown;
  expect(normalized).toEqual(committed);
}

const tempDirs: string[] = [];

beforeEach(() => {
  tempDirs.length = 0;
});

afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function mkTemp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("Golden snapshots", () => {
  it("claude-code", async () => {
    const tempDir = await mkTemp("xtctx-snap-claude-");
    const stateDir = await mkTemp("xtctx-snap-state-");
    const project = join(tempDir, "proj");
    await mkdir(project, { recursive: true });
    await writeFile(
      join(project, "session-snap.jsonl"),
      [
        JSON.stringify({
          type: "human",
          content: "snapshot question one",
          timestamp: "2026-02-24T10:00:00Z",
        }),
        JSON.stringify({
          type: "assistant",
          content: "snapshot answer one",
          timestamp: "2026-02-24T10:00:05Z",
        }),
        JSON.stringify({
          type: "human",
          content: "snapshot question two",
          timestamp: "2026-02-24T10:01:00Z",
        }),
      ].join("\n") + "\n",
    );

    const scraper = new ClaudeCodeScraper(tempDir, stateDir);
    const chunks = await collectChunks(scraper);
    await assertSnapshot("claude-code", normalise(chunks));
  });

  it("codex", async () => {
    const tempDir = await mkTemp("xtctx-snap-codex-");
    const stateDir = await mkTemp("xtctx-snap-state-");
    await writeFile(
      join(tempDir, "session-snap.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-02-24T09:59:00Z",
          type: "session_meta",
          payload: { id: "snap-codex-uuid" },
        }),
        JSON.stringify({
          timestamp: "2026-02-24T09:59:01Z",
          type: "turn_context",
          payload: {
            approval_policy: "suggest",
            sandbox_policy: { type: "workspace-write" },
          },
        }),
        JSON.stringify({
          timestamp: "2026-02-24T10:00:00Z",
          type: "event_msg",
          payload: { type: "user_message", message: "snap q" },
        }),
        JSON.stringify({
          timestamp: "2026-02-24T10:00:05Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "snap a" }],
          },
        }),
      ].join("\n") + "\n",
    );

    const scraper = new CodexCliScraper(tempDir, stateDir);
    const chunks = await collectChunks(scraper);
    await assertSnapshot("codex", normalise(chunks));
  });

  it("copilot", async () => {
    const tempDir = await mkTemp("xtctx-snap-copilot-");
    const stateDir = await mkTemp("xtctx-snap-state-");
    const wsStorage = join(tempDir, "workspaceStorage");
    await mkdir(join(wsStorage, "hash-snap"), { recursive: true });
    const db = new Database(join(wsStorage, "hash-snap", "state.vscdb"));
    db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
      "interactive.sessions",
      JSON.stringify({
        "0": {
          sessionId: "snap-copilot-session",
          creationDate: new Date("2026-02-24T10:00:00Z").getTime(),
          requests: [
            {
              message: { parts: [{ text: "q1" }] },
              response: [{ value: "a1" }],
              isCanceled: false,
              model: "gpt-4o-copilot",
            },
            {
              message: { parts: [{ text: "q2" }] },
              response: [{ value: "a2" }],
              isCanceled: false,
              model: "gpt-4o-copilot",
            },
          ],
        },
      }),
    );
    db.close();

    const scraper = new CopilotScraper(wsStorage, stateDir);
    const chunks = await collectChunks(scraper);
    await assertSnapshot("copilot", normalise(chunks));
  });

  it("cursor", async () => {
    const rootDir = await mkTemp("xtctx-snap-cursor-");
    const stateDir = await mkTemp("xtctx-snap-state-");
    const workspaceDir = join(rootDir, "workspaceStorage", "hash-snap");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(join(rootDir, "globalStorage"), { recursive: true });

    const wsDb = new Database(join(workspaceDir, "state.vscdb"));
    wsDb.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    wsDb.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
      "composer.composerData",
      JSON.stringify({ allComposers: [{ composerId: "snap-composer" }] }),
    );
    wsDb.close();

    const composer = {
      composerId: "snap-composer",
      fullConversationHeadersOnly: [
        { bubbleId: "sb1", type: 1 },
        { bubbleId: "sb2", type: 2 },
      ],
      createdAt: new Date("2026-02-24T10:00:00Z").getTime(),
      modelConfig: { modelName: "gpt-4.1" },
      unifiedMode: "agent",
    };
    const globalDb = new Database(join(rootDir, "globalStorage", "state.vscdb"));
    globalDb.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const ins = globalDb.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
    ins.run(`composerData:snap-composer`, JSON.stringify(composer));
    ins.run(
      `bubbleId:snap-composer:sb1`,
      JSON.stringify({ type: 1, text: "cursor snap q", createdAt: "2026-02-24T10:00:00Z" }),
    );
    ins.run(
      `bubbleId:snap-composer:sb2`,
      JSON.stringify({ type: 2, text: "cursor snap a", createdAt: "2026-02-24T10:00:05Z" }),
    );
    globalDb.close();

    const scraper = new CursorScraper(workspaceDir, stateDir);
    const chunks = await collectChunks(scraper);
    await assertSnapshot("cursor", normalise(chunks));
  });

  it("gemini", async () => {
    const tempDir = await mkTemp("xtctx-snap-gemini-");
    const stateDir = await mkTemp("xtctx-snap-state-");
    const chatDir = join(tempDir, "proj", "chats");
    await mkdir(chatDir, { recursive: true });
    await writeFile(
      join(chatDir, "session-snap.json"),
      JSON.stringify({
        sessionId: "snap-gemini-session",
        startTime: "2026-02-24T10:00:00Z",
        lastUpdated: "2026-02-24T10:01:00Z",
        messages: [
          {
            id: "g1",
            type: "user",
            timestamp: "2026-02-24T10:00:00Z",
            content: [{ text: "gemini snap q" }],
          },
          {
            id: "g2",
            type: "gemini",
            timestamp: "2026-02-24T10:00:05Z",
            content: "gemini snap a",
            model: "gemini-2.5-pro",
          },
        ],
      }),
    );

    const scraper = new GeminiCliScraper(tempDir, stateDir);
    const chunks = await collectChunks(scraper);
    await assertSnapshot("gemini", normalise(chunks));
  });
});
