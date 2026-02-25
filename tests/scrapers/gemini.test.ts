import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GeminiCliScraper } from "@xtctx/scrapers/gemini";
import type { GeminiChunk } from "@xtctx/types/scraper";

describe("GeminiCliScraper", () => {
  let tempDir = "";
  let stateDir = "";
  let scraper: GeminiCliScraper;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "xtctx-gemini-"));
    stateDir = await mkdtemp(join(tmpdir(), "xtctx-state-"));

    await writeFile(
      join(tempDir, "gemini-session.json"),
      JSON.stringify(
        {
          sessions: [
            {
              sessionId: "gemini-session",
              turns: [
                {
                  timestamp: "2026-02-24T10:00:00Z",
                  prompt: "gemini first",
                  response: "gemini answer",
                  model: "gemini-2.5-pro",
                  prompt_tokens: 12,
                  response_tokens: 24,
                },
              ],
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    scraper = new GeminiCliScraper(tempDir, stateDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  it("detects gemini history path", async () => {
    expect(await scraper.detect()).toBe(true);
  });

  it("expands gemini turns into user and assistant chunks", async () => {
    const chunks: GeminiChunk[] = [];
    for await (const chunk of scraper.fullSync()) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(chunks[0].role).toBe("user");
    expect(chunks[1].role).toBe("assistant");
    expect(chunks[1].metadata.model).toBe("gemini-2.5-pro");
  });

  it("filters by incremental timestamp", async () => {
    const chunks: GeminiChunk[] = [];
    for await (const chunk of scraper.scrape(new Date("2026-02-24T10:00:00Z"))) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(0);
  });
});
