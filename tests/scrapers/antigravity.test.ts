import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AntigravityScraper } from "@xtctx/scrapers/antigravity";
import type { ConversationChunk } from "@xtctx/types/scraper";

async function collect(scraper: AntigravityScraper): Promise<ConversationChunk[]> {
  const chunks: ConversationChunk[] = [];
  for await (const chunk of scraper.fullSync()) {
    chunks.push(chunk);
  }
  return chunks;
}

describe("AntigravityScraper", () => {
  let rootDir = "";
  let stateDir = "";
  let projectRoot = "";

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "xtctx-antigravity-root-"));
    stateDir = await mkdtemp(join(tmpdir(), "xtctx-antigravity-state-"));
    projectRoot = join("H:", "projects", "private", "needs-work", "xtctx");
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  it("detects Antigravity state when brain artifacts are present", async () => {
    await mkdir(join(rootDir, "brain"), { recursive: true });

    const scraper = new AntigravityScraper(rootDir, stateDir, projectRoot);

    await expect(scraper.detect()).resolves.toBe(true);
    expect(scraper.getStorePaths()).toEqual([rootDir]);
  });

  it("reads readable brain artifacts as handoff chunks", async () => {
    const sessionDir = join(rootDir, "brain", "session-a");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "implementation_plan.md"),
      [
        "# Implementation Plan",
        "",
        "Modify [src/index.ts](file:///h%3A/projects/private/needs-work/xtctx/src/index.ts).",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      join(sessionDir, "implementation_plan.md.metadata.json"),
      JSON.stringify({
        artifactType: "ARTIFACT_TYPE_IMPLEMENTATION_PLAN",
        summary: "Implement xtctx support.",
        updatedAt: "2026-05-10T12:00:00.000Z",
        version: "2",
      }),
      "utf-8",
    );
    await writeFile(join(sessionDir, "implementation_plan.md.resolved"), "duplicate", "utf-8");

    const chunks = await collect(new AntigravityScraper(rootDir, stateDir, projectRoot));

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      tool: "antigravity",
      sessionId: "session-a",
      role: "assistant",
      timestamp: new Date("2026-05-10T12:00:00.000Z"),
    });
    expect(chunks[0].content).toContain("Antigravity artifact: implementation_plan.md");
    expect(chunks[0].content).toContain("Implement xtctx support.");
    expect(chunks[0].metadata).toMatchObject({
      messageIndex: 0,
      artifactType: "ARTIFACT_TYPE_IMPLEMENTATION_PLAN",
      artifactName: "implementation_plan.md",
      summary: "Implement xtctx support.",
    });
    expect(chunks[0].metadata.referencedFiles).toEqual([
      "h:/projects/private/needs-work/xtctx/src/index.ts",
    ]);
  });

  it("filters artifacts to the project root or Antigravity playground project", async () => {
    const matchedSessionDir = join(rootDir, "brain", "session-matched");
    const playgroundSessionDir = join(rootDir, "brain", "session-playground");
    const unrelatedSessionDir = join(rootDir, "brain", "session-unrelated");
    await mkdir(matchedSessionDir, { recursive: true });
    await mkdir(playgroundSessionDir, { recursive: true });
    await mkdir(unrelatedSessionDir, { recursive: true });

    await writeArtifact(
      matchedSessionDir,
      "task.md",
      "Use file:///h:/projects/private/needs-work/xtctx/src/cli/index.ts",
      "2026-05-10T12:00:00.000Z",
    );
    await writeArtifact(
      playgroundSessionDir,
      "task.md",
      "Use file:///c:/Users/Felix/.gemini/antigravity/playground/xtctx/src/cli/index.ts",
      "2026-05-10T12:01:00.000Z",
    );
    await writeArtifact(
      unrelatedSessionDir,
      "task.md",
      "Use file:///h:/projects/private/other/src/index.ts",
      "2026-05-10T12:02:00.000Z",
    );

    const chunks = await collect(new AntigravityScraper(rootDir, stateDir, projectRoot));

    expect(chunks.map((chunk) => chunk.sessionId).sort()).toEqual([
      "session-matched",
      "session-playground",
    ]);
  });

  it("supports incremental cutoff by artifact timestamp", async () => {
    const sessionDir = join(rootDir, "brain", "session-a");
    await mkdir(sessionDir, { recursive: true });
    await writeArtifact(
      sessionDir,
      "task.md",
      "Use file:///h:/projects/private/needs-work/xtctx/src/cli/index.ts",
      "2026-05-10T12:00:00.000Z",
    );
    await writeArtifact(
      sessionDir,
      "walkthrough.md",
      "Use file:///h:/projects/private/needs-work/xtctx/README.md",
      "2026-05-10T12:05:00.000Z",
    );

    const scraper = new AntigravityScraper(rootDir, stateDir, projectRoot);
    const chunks: ConversationChunk[] = [];
    for await (const chunk of scraper.scrape(new Date("2026-05-10T12:00:00.000Z"))) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0].metadata.artifactName).toBe("walkthrough.md");
    expect(chunks[0].metadata.messageIndex).toBe(1);
  });
});

async function writeArtifact(
  sessionDir: string,
  name: string,
  body: string,
  updatedAt: string,
): Promise<void> {
  await writeFile(join(sessionDir, name), body, "utf-8");
  await writeFile(
    join(sessionDir, `${name}.metadata.json`),
    JSON.stringify({ artifactType: "ARTIFACT_TYPE_TASK", updatedAt }),
    "utf-8",
  );
}
