import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CopilotCliScraper } from "@xtctx/scrapers/copilot-cli";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CopilotCliChunk } from "@xtctx/types/scraper";

describe("CopilotCliScraper", () => {
  let rootDir = "";
  let stateDir = "";

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "xtctx-copilot-cli-"));
    stateDir = await mkdtemp(join(tmpdir(), "xtctx-state-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  async function writeSessionEvents(sessionId: string, lines: string[]): Promise<void> {
    const sessionDir = join(rootDir, sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "events.jsonl"), lines.join("\n") + "\n");
  }

  it("returns no chunks when sessions root is missing", async () => {
    const scraper = new CopilotCliScraper(join(rootDir, "missing"), stateDir);
    expect(await scraper.detect()).toBe(false);
    const chunks: CopilotCliChunk[] = [];
    for await (const chunk of scraper.fullSync()) chunks.push(chunk);
    expect(chunks).toHaveLength(0);
  });

  it("returns no chunks when session has no events.jsonl", async () => {
    await mkdir(join(rootDir, "sess-empty"), { recursive: true });
    const scraper = new CopilotCliScraper(rootDir, stateDir);
    const chunks: CopilotCliChunk[] = [];
    for await (const chunk of scraper.fullSync()) chunks.push(chunk);
    expect(chunks).toHaveLength(0);
  });

  it("scrapes user/assistant message events", async () => {
    await writeSessionEvents("sess-001", [
      JSON.stringify({
        type: "message",
        role: "user",
        content: "hello copilot cli",
        timestamp: "2026-02-24T10:00:00Z",
      }),
      JSON.stringify({
        type: "message",
        role: "assistant",
        content: "hi back",
        timestamp: "2026-02-24T10:00:05Z",
      }),
    ]);

    const scraper = new CopilotCliScraper(rootDir, stateDir);
    const chunks: CopilotCliChunk[] = [];
    for await (const chunk of scraper.fullSync()) chunks.push(chunk);

    expect(chunks).toHaveLength(2);
    expect(chunks[0].role).toBe("user");
    expect(chunks[0].content).toBe("hello copilot cli");
    expect(chunks[0].sessionId).toBe("sess-001");
    expect(chunks[0].metadata.eventType).toBe("message");
    expect(chunks[1].role).toBe("assistant");
    expect(chunks[1].content).toBe("hi back");
  });

  it("skips non-conversation events silently (no warn)", async () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));

    await writeSessionEvents("sess-mix", [
      JSON.stringify({ type: "status", message: "starting" }),
      JSON.stringify({ type: "tool_call", tool: "read_file", args: {} }),
      JSON.stringify({
        type: "message",
        role: "user",
        content: "real message",
        timestamp: "2026-02-24T10:00:00Z",
      }),
      JSON.stringify({ type: "subagent", id: "sa1" }),
    ]);

    try {
      const scraper = new CopilotCliScraper(rootDir, stateDir);
      const chunks: CopilotCliChunk[] = [];
      for await (const chunk of scraper.fullSync()) chunks.push(chunk);

      expect(chunks).toHaveLength(1);
      expect(chunks[0].content).toBe("real message");
      expect(warnings).toHaveLength(0);
    } finally {
      console.warn = origWarn;
    }
  });

  it("extracts content from nested message.content array of {type,text}", async () => {
    await writeSessionEvents("sess-nested", [
      JSON.stringify({
        timestamp: "2026-02-24T10:00:00Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "alpha" },
            { type: "text", text: "beta" },
          ],
        },
      }),
    ]);

    const scraper = new CopilotCliScraper(rootDir, stateDir);
    const chunks: CopilotCliChunk[] = [];
    for await (const chunk of scraper.fullSync()) chunks.push(chunk);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].role).toBe("assistant");
    expect(chunks[0].content).toBe("alpha\nbeta");
  });

  it("warns and continues on malformed JSON lines", async () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));

    await writeSessionEvents("sess-malformed", [
      "not-json",
      JSON.stringify({
        type: "message",
        role: "user",
        content: "good after bad",
        timestamp: "2026-02-24T10:00:00Z",
      }),
    ]);

    try {
      const scraper = new CopilotCliScraper(rootDir, stateDir);
      const chunks: CopilotCliChunk[] = [];
      for await (const chunk of scraper.fullSync()) chunks.push(chunk);

      expect(chunks).toHaveLength(1);
      expect(chunks[0].content).toBe("good after bad");
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings.some((w) => w.includes("not valid JSON"))).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });

  it("respects since cursor", async () => {
    await writeSessionEvents("sess-cut", [
      JSON.stringify({
        type: "message",
        role: "user",
        content: "early",
        timestamp: "2026-02-24T09:00:00Z",
      }),
      JSON.stringify({
        type: "message",
        role: "assistant",
        content: "late",
        timestamp: "2026-02-24T11:00:00Z",
      }),
    ]);

    const scraper = new CopilotCliScraper(rootDir, stateDir);
    const chunks: CopilotCliChunk[] = [];
    for await (const chunk of scraper.scrape(new Date("2026-02-24T10:00:00Z"))) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe("late");
  });

  it("walks multiple session directories", async () => {
    await writeSessionEvents("sess-A", [
      JSON.stringify({
        type: "message",
        role: "user",
        content: "from A",
        timestamp: "2026-02-24T10:00:00Z",
      }),
    ]);
    await writeSessionEvents("sess-B", [
      JSON.stringify({
        type: "message",
        role: "user",
        content: "from B",
        timestamp: "2026-02-24T10:00:00Z",
      }),
    ]);

    const scraper = new CopilotCliScraper(rootDir, stateDir);
    const chunks: CopilotCliChunk[] = [];
    for await (const chunk of scraper.fullSync()) chunks.push(chunk);

    expect(chunks).toHaveLength(2);
    expect(new Set(chunks.map((c) => c.sessionId))).toEqual(new Set(["sess-A", "sess-B"]));
  });
});
