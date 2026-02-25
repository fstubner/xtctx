import { describe, it, expect } from "vitest";
import { ScraperRegistry } from "@xtctx/scrapers/registry";
import type { ConversationScraper, ConversationChunk } from "@xtctx/types/scraper";

class MockScraper implements ConversationScraper {
  readonly tool = "mock-tool";

  async detect() {
    return true;
  }

  getStorePaths() {
    return ["/tmp/mock"];
  }

  async *scrape() {
    // empty
  }

  async *fullSync() {
    // empty
  }

  parseRaw(raw: unknown) {
    return raw as ConversationChunk;
  }

  async getLastScrapedPosition() {
    return { lastTimestamp: new Date() };
  }

  async saveScrapedPosition() {
    // noop
  }
}

describe("ScraperRegistry", () => {
  it("registers and retrieves scrapers", () => {
    const registry = new ScraperRegistry();
    registry.register(new MockScraper());
    expect(registry.get("mock-tool")).toBeDefined();
    expect(registry.getAll()).toHaveLength(1);
  });

  it("detects available scrapers", async () => {
    const registry = new ScraperRegistry();
    registry.register(new MockScraper());
    const available = await registry.detectAvailable();
    expect(available).toHaveLength(1);
    expect(available[0].tool).toBe("mock-tool");
  });
});
