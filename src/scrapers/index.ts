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

export { AbstractScraper, ScraperStateManager, estimateTokens } from "./base.js";
