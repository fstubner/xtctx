import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GeminiCliScraper } from "@xtctx/scrapers/gemini";
import type { GeminiChunk } from "@xtctx/types/scraper";

/**
 * Gemini CLI stores sessions as JSON objects under:
 *   <geminiTmpDir>/<project>/chats/session-<id>.json
 *
 * Each session file has the shape:
 *   { sessionId, startTime, lastUpdated, messages: [{id, type, timestamp, content}] }
 *
 * Message 'type' discriminates role: "user" → user, "gemini" → assistant.
 * Content is an array of {text} parts for user/gemini or a plain string for info/error.
 */

const SESSION_ID = "test-gemini-session-abc";

function makeSession(messages: object[]) {
  return JSON.stringify({
    sessionId: SESSION_ID,
    startTime: "2026-02-24T10:00:00Z",
    lastUpdated: "2026-02-24T10:00:05Z",
    messages,
  });
}

describe("GeminiCliScraper", () => {
  let tmpBase = "";
  let stateDir = "";
  let scraper: GeminiCliScraper;

  // Layout: tmpBase/<project>/chats/session-X.json  (mirrors real Gemini CLI)
  let chatDir = "";

  beforeEach(async () => {
    tmpBase = await mkdtemp(join(tmpdir(), "xtctx-gemini-"));
    stateDir = await mkdtemp(join(tmpdir(), "xtctx-state-"));

    chatDir = join(tmpBase, "my-project", "chats");
    await mkdir(chatDir, { recursive: true });

    await writeFile(
      join(chatDir, "session-test.json"),
      makeSession([
        {
          id: "msg-1",
          type: "user",
          timestamp: "2026-02-24T10:00:00Z",
          content: [{ text: "gemini first" }],
        },
        {
          id: "msg-2",
          type: "gemini",
          timestamp: "2026-02-24T10:00:05Z",
          content: "gemini answer",
          model: "gemini-2.5-pro",
        },
        // info messages should be silently skipped
        {
          id: "msg-3",
          type: "info",
          timestamp: "2026-02-24T10:00:06Z",
          content: "Session saved.",
        },
      ]),
      "utf-8",
    );

    scraper = new GeminiCliScraper(tmpBase, stateDir);
  });

  afterEach(async () => {
    await rm(tmpBase, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  it("detects gemini tmp path", async () => {
    expect(await scraper.detect()).toBe(true);
  });

  it("reads user and assistant messages, skipping info entries", async () => {
    const chunks: GeminiChunk[] = [];
    for await (const chunk of scraper.fullSync()) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);

    expect(chunks[0].role).toBe("user");
    expect(chunks[0].content).toBe("gemini first");
    expect(chunks[0].sessionId).toBe(SESSION_ID);

    expect(chunks[1].role).toBe("assistant");
    expect(chunks[1].content).toBe("gemini answer");
    // model stored inline on the gemini message
    expect(chunks[1].metadata.model).toBe("gemini-2.5-pro");
  });

  it("handles array content parts correctly", async () => {
    // Write a session where user message has multiple content parts
    await writeFile(
      join(chatDir, "session-multi.json"),
      makeSession([
        {
          id: "m1",
          type: "user",
          timestamp: "2026-02-25T09:00:00Z",
          content: [{ text: "part one" }, { text: "part two" }],
        },
      ]),
      "utf-8",
    );

    const chunks: GeminiChunk[] = [];
    for await (const chunk of scraper.fullSync()) {
      chunks.push(chunk);
    }

    // Should include all chunks from both session files
    const multiChunk = chunks.find((c) => c.content.startsWith("part one"));
    expect(multiChunk).toBeDefined();
    expect(multiChunk?.content).toBe("part one\npart two");
  });

  it("supports incremental scraping with since cutoff", async () => {
    const chunks: GeminiChunk[] = [];
    for await (const chunk of scraper.scrape(new Date("2026-02-24T10:00:00Z"))) {
      chunks.push(chunk);
    }

    // Only the assistant message at 10:00:05Z is after the cutoff
    expect(chunks).toHaveLength(1);
    expect(chunks[0].role).toBe("assistant");
    expect(chunks[0].content).toBe("gemini answer");
  });

  it("returns no chunks for empty or missing session dirs", async () => {
    const emptyScraper = new GeminiCliScraper(join(tmpBase, "nonexistent"), stateDir);
    const chunks: GeminiChunk[] = [];
    for await (const chunk of emptyScraper.fullSync()) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(0);
  });
});
