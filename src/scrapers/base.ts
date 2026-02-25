import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ScraperState } from "../types/scraper.js";

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
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(state, null, 2), "utf-8");
  }

  private statePath(tool: string): string {
    return join(this.stateDir, `${tool}-state.json`);
  }
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
