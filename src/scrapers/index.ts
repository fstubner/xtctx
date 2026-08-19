/**
 * Public API for building xtctx-compatible scrapers.
 *
 * External scraper packages should import from "xtctx/scrapers":
 *
 * ```ts
 * import { AbstractScraper, estimateTokens } from "xtctx/scrapers";
 * import type { ConversationChunk, ScraperState } from "xtctx/scrapers";
 * ```
 *
 * See `AbstractScraper` for the full authoring guide.
 */

export type {
  ChunkMetadata,
  ConversationChunk,
  ConversationScraper,
  ScraperState,
} from "../types/scraper.js";

export { AbstractScraper, ScraperStateManager, estimateTokens, toDate } from "./base.js";
export { ScraperRegistry } from "./registry.js";

export { AntigravityScraper } from "./antigravity.js";
export { ClaudeCodeScraper } from "./claude-code.js";
export { CodexCliScraper } from "./codex.js";
export { CopilotScraper } from "./copilot.js";
export { CopilotCliScraper } from "./copilot-cli.js";
export { CursorScraper } from "./cursor.js";
export { OpenCodeScraper } from "./opencode.js";
