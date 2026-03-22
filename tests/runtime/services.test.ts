import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileConfigStore } from "@xtctx/runtime/services";

describe("FileConfigStore", () => {
  let workspaceDir = "";
  let configRoot = "";

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), "xtctx-config-store-"));
    configRoot = join(workspaceDir, ".xtctx", "tool-config");
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("loads skills from canonical path", async () => {
    await mkdir(join(configRoot, "skills"), { recursive: true });
    await writeFile(join(configRoot, "skills", "canonical.md"), "# canonical", "utf-8");

    const store = new FileConfigStore(configRoot);
    const skills = await store.list("skill");
    const names = skills.map((entry) => entry.name).sort();

    expect(names).toEqual(["canonical"]);
  });

  it("returns null for missing canonical skill", async () => {
    const store = new FileConfigStore(configRoot);
    const skill = await store.get("skill", "xtctx-usage");
    expect(skill).toBeNull();
  });
});
