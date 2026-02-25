import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CopilotScraper } from "@xtctx/scrapers/copilot";
import type { CopilotChunk } from "@xtctx/types/scraper";

describe("CopilotScraper", () => {
  let tempDir = "";
  let stateDir = "";
  let scraper: CopilotScraper;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "xtctx-copilot-"));
    stateDir = await mkdtemp(join(tmpdir(), "xtctx-state-"));

    await writeFile(
      join(tempDir, "copilot-session.json"),
      JSON.stringify(
        {
          sessionId: "copilot-session",
          messages: [
            {
              role: "user",
              content: "copilot first",
              timestamp: "2026-02-24T10:00:00Z",
              model: "gpt-4o",
              completionType: "chat",
            },
            {
              role: "assistant",
              content: "copilot second",
              timestamp: "2026-02-24T10:00:05Z",
              model: "gpt-4o",
              completionType: "chat",
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    scraper = new CopilotScraper(tempDir, stateDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  it("detects copilot history path", async () => {
    expect(await scraper.detect()).toBe(true);
  });

  it("reads copilot json conversations", async () => {
    const chunks: CopilotChunk[] = [];
    for await (const chunk of scraper.fullSync()) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(chunks[0].role).toBe("user");
    expect(chunks[1].role).toBe("assistant");
    expect(chunks[0].metadata.model).toBe("gpt-4o");
  });

  it("returns only newer messages for incremental scrape", async () => {
    const chunks: CopilotChunk[] = [];
    for await (const chunk of scraper.scrape(new Date("2026-02-24T10:00:00Z"))) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe("copilot second");
  });
});
