/**
 * A step with no readable time still has to survive a full rebuild.
 *
 * `steps.ts` falls back to `new Date(0)` when neither the step metadata nor
 * the conversation summary carries a parseable timestamp. `fullSync()` reads
 * with `since = new Date(0)`, and the filter was `timestamp <= since` with no
 * guard — so `0 <= 0` dropped exactly those steps, on every path, including
 * the rebuild that exists to recover them. Nothing recorded it.
 *
 * Every other scraper guards this. claude-code spells it out:
 * "A zero `since` means full sync: emit even epoch-sentinel timestamps."
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AntigravityScraper,
  type AntigravityRuntimeClient,
  type AntigravityRuntimeConversation,
} from "@xtctx/scrapers/antigravity";
import type { AntigravityChunk } from "@xtctx/types/scraper";

let rootDir = "";
let stateDir = "";
const projectRoot = join("H:", "projects", "private", "needs-work", "xtctx");

function runtimeClient(conversations: AntigravityRuntimeConversation[]): AntigravityRuntimeClient {
  return {
    async listConversations() {
      return { conversations };
    },
  } as unknown as AntigravityRuntimeClient;
}

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "xtctx-ag-epoch-root-"));
  stateDir = await mkdtemp(join(tmpdir(), "xtctx-ag-epoch-state-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
});

describe("AntigravityScraper full sync", () => {
  it("emits steps whose timestamp fell back to the epoch", async () => {
    const chunks: AntigravityChunk[] = [];
    const scraper = new AntigravityScraper(
      rootDir,
      stateDir,
      projectRoot,
      runtimeClient([
        {
          sessionId: "cascade-epoch",
          title: "Work with no usable timestamps",
          createdAt: new Date(0),
          workspaces: ["file:///h:/projects/private/needs-work/xtctx"],
          messages: [
            {
              sessionId: "cascade-epoch",
              // What the parser produces when nothing readable was found.
              timestamp: new Date(0),
              role: "user",
              content: "Please update src/cli/index.ts",
              referencedFiles: ["h:/projects/private/needs-work/xtctx/src/cli/index.ts"],
              metadata: {},
            },
          ],
        } as unknown as AntigravityRuntimeConversation,
      ]),
    );

    for await (const chunk of scraper.fullSync()) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain("src/cli/index.ts");
  });
});
