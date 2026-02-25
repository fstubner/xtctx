import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { KnowledgeRepository } from "@xtctx/knowledge/repository";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("KnowledgeRepository", () => {
  let repo: KnowledgeRepository;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "xtctx-knowledge-"));
    repo = new KnowledgeRepository(tempDir);
    await repo.initialize();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("saves and retrieves a decision", async () => {
    const record = {
      id: "abc123",
      type: "decision" as const,
      created_at: new Date().toISOString(),
      source_tool: "claude-code",
      referenced_files: ["vitest.config.ts"],
      domain_tags: ["testing"],
      environment: {},
      title: "Use Vitest over Jest",
      body: "Vitest has native ESM support and is faster for Vite projects.",
    };

    await repo.save(record);
    const retrieved = await repo.getById("abc123");
    expect(retrieved).not.toBeNull();
    expect(retrieved?.title).toBe("Use Vitest over Jest");
  });

  it("lists records by type", async () => {
    await repo.save({
      id: "d1",
      type: "decision" as const,
      created_at: new Date().toISOString(),
      source_tool: "claude-code",
      referenced_files: [],
      domain_tags: [],
      environment: {},
      title: "Decision 1",
      body: "Body 1",
    });
    await repo.save({
      id: "e1",
      type: "error_solution" as const,
      created_at: new Date().toISOString(),
      source_tool: "cursor",
      referenced_files: [],
      domain_tags: [],
      environment: {},
      title: "Error 1",
      body: "Solution 1",
    });

    const decisions = await repo.listByType("decision");
    expect(decisions.length).toBe(1);
    expect(decisions[0].id).toBe("d1");
  });

  it("updates supersession chain", async () => {
    await repo.save({
      id: "old",
      type: "decision" as const,
      created_at: "2026-01-01T00:00:00Z",
      source_tool: "claude-code",
      referenced_files: [],
      domain_tags: [],
      environment: {},
      title: "Old decision",
      body: "Original",
    });
    await repo.supersede("old", "new");

    const old = await repo.getById("old");
    expect(old?.superseded_by).toBe("new");
  });
});
