import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexCliScraper } from "../../src/scrapers/codex.js";

describe("Codex canonical source inventory", () => {
  it("uses canonical IDs, deduplicates copies and retains metadata-only sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-inventory-"));
    try {
      const meta = (id: string) => JSON.stringify({ type: "session_meta", payload: { id } }) + "\n";
      await writeFile(join(root, "rollout-wrong-name.jsonl"), meta("canonical") + "x".repeat(1024 * 1024));
      await writeFile(join(root, "rollout-copy.jsonl"), meta("canonical"));
      await writeFile(join(root, "rollout-empty-session.jsonl"), meta("metadata-only"));
      expect(await new CodexCliScraper(root, join(root, "state")).listSessionIds())
        .toEqual(new Set(["canonical", "metadata-only"]));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it.each(["not json\n", "{}\n", '{"type":"session_meta","payload":{}}\n', "x".repeat(65537)])(
    "keeps malformed, missing and oversized headers unknown", async (content) => {
      const root = await mkdtemp(join(tmpdir(), "codex-inventory-"));
      try {
        await writeFile(join(root, "rollout-test.jsonl"), content);
        expect(await new CodexCliScraper(root, join(root, "state")).listSessionIds()).toBeNull();
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  it("propagates discovery IO errors rather than reporting an empty source", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-inventory-"));
    try {
      await expect(new CodexCliScraper(join(root, "absent"), join(root, "state")).listSessionIds())
        .rejects.toMatchObject({ code: "ENOENT" });
      expect(await new CodexCliScraper(root, join(root, "state")).listSessionIds()).toEqual(new Set());
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("keeps linked discovery trees unknown instead of silently skipping them", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-inventory-"));
    try {
      await mkdir(join(root, "source"));
      await symlink(join(root, "source"), join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
      expect(await new CodexCliScraper(root, join(root, "state")).listSessionIds()).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("does not claim whole-store identity for a project-scoped reader", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-inventory-"));
    try {
      expect(await new CodexCliScraper(root, join(root, "state"), root).listSessionIds()).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
