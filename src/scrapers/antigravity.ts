/**
 * Antigravity reader, split by seam:
 *
 * - `antigravity/shared.ts`: the types the modules pass between them, and the drift reporter
 * - `antigravity/values.ts`: the coercions every module applies to untyped JSON
 * - `antigravity/steps.ts`: language-server trajectory steps to messages
 * - `antigravity/artifacts.ts`: brain artifacts to chunk content
 * - `antigravity/project-match.ts`: which sessions belong to this project
 * - `antigravity/store.ts`: the on-disk store (brain artifacts, conversation ids)
 * - `antigravity/runtime-client.ts`: the local language-server RPC client
 * - `antigravity/scraper.ts`: the scraper that ties them together
 *
 * This file is the public surface; test-only helpers are imported from the
 * sub-module they live in.
 */
export { AntigravityScraper } from "./antigravity/scraper.js";
export type {
  AntigravityRuntimeClient,
  AntigravityRuntimeConversation,
  AntigravityRuntimeListing,
  AntigravityRuntimeMessage,
} from "./antigravity/shared.js";
