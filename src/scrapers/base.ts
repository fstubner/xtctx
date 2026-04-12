import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ConversationChunk, ConversationScraper, ScraperState } from "../types/scraper.js";

export class ScraperStateManager {
  constructor(private readonly stateDir: string) {}

  async load(tool: string): Promise<ScraperState> {
    const path = this.statePath(tool);

    try {
      const raw = await readFile(path, "utf-8");
      const data = JSON.parse(raw) as ScraperState;
      return {
        ...data,
        lastTimestamp: new Date(data.lastTimestamp),
      };
    } catch {
      return { lastTimestamp: new Date(0) };
    }
  }

  async save(tool: string, state: ScraperState): Promise<void> {
    const path = this.statePath(tool);
    const tmpPath = `${path}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    // Write to a temp file first, then atomically rename it over the target
    // so a mid-write crash never leaves a corrupt state file (M3).
    await writeFile(tmpPath, JSON.stringify(state, null, 2), "utf-8");
    await rename(tmpPath, path);
  }

  private statePath(tool: string): string {
    return join(this.stateDir, `${tool}-state.json`);
  }
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Coerce an unknown value to a Date.
 * Handles: Date objects, numeric timestamps (seconds or milliseconds),
 * numeric strings, ISO strings. Returns new Date(0) as sentinel for
 * unrecognised values.
 */
export function toDate(value: unknown): Date {
  if (value instanceof Date) {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 10_000_000_000 ? value : value * 1000;
    return new Date(millis);
  }

  if (typeof value === "string" && value.length > 0) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && value.trim() !== "") {
      const millis = numeric > 10_000_000_000 ? numeric : numeric * 1000;
      return new Date(millis);
    }

    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return new Date(0);
}

/**
 * Base class for all conversation scrapers — both built-in and community ones.
 *
 * Extend this class to add a new data source. You only need to implement five
 * members:
 *
 *   - `tool`           — unique string identifier (e.g. `"zed"`, `"aider"`)
 *   - `detect()`       — returns true when the data source is present on disk
 *   - `getStorePaths()` — paths the daemon should watch for changes
 *   - `scrape(since?)` — yield chunks newer than the given date (incremental)
 *   - `fullSync()`     — yield all chunks from the beginning of time
 *
 * State persistence (position tracking between scrape cycles) is handled
 * automatically by this base class via `ScraperStateManager`.
 *
 * @example
 * ```ts
 * import { AbstractScraper, estimateTokens } from "xtctx/scrapers";
 * import type { ConversationChunk } from "xtctx/scrapers";
 *
 * export class ZedScraper extends AbstractScraper {
 *   readonly tool = "zed";
 *
 *   constructor(private readonly historyDir: string, stateDir: string) {
 *     super(stateDir);
 *   }
 *
 *   async detect() { ... }
 *   getStorePaths() { return [this.historyDir]; }
 *   async *scrape(since?: Date) { ... }
 *   async *fullSync() { ... }
 * }
 * ```
 */
export abstract class AbstractScraper<T extends ConversationChunk = ConversationChunk>
  implements ConversationScraper<T>
{
  abstract readonly tool: string;

  private readonly stateManager: ScraperStateManager;

  constructor(stateDir: string) {
    this.stateManager = new ScraperStateManager(stateDir);
  }

  abstract detect(): Promise<boolean>;
  abstract getStorePaths(): string[];
  abstract scrape(since?: Date): AsyncIterable<T>;
  abstract fullSync(): AsyncIterable<T>;

  async getLastScrapedPosition(): Promise<ScraperState> {
    return this.stateManager.load(this.tool);
  }

  async saveScrapedPosition(state: ScraperState): Promise<void> {
    await this.stateManager.save(this.tool, state);
  }
}
