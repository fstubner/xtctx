import type { ConversationChunk, ConversationScraper } from "../types/scraper.js";

export class ScraperRegistry {
  private readonly scrapers = new Map<string, ConversationScraper>();

  register<T extends ConversationChunk>(scraper: ConversationScraper<T>): void {
    this.scrapers.set(scraper.tool, scraper as ConversationScraper);
  }

  get(tool: string): ConversationScraper | undefined {
    return this.scrapers.get(tool);
  }

  getAll(): ConversationScraper[] {
    return [...this.scrapers.values()];
  }

  async detectAvailable(): Promise<ConversationScraper[]> {
    const available: ConversationScraper[] = [];

    for (const scraper of this.scrapers.values()) {
      if (await scraper.detect()) {
        available.push(scraper);
      }
    }

    return available;
  }
}
