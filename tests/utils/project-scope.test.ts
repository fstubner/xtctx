import { describe, expect, it } from "vitest";
import { pathMatchesProject } from "@xtctx/utils/project-scope";

describe("pathMatchesProject", () => {
  it("matches Windows drive paths from file URLs on any host OS", () => {
    expect(pathMatchesProject("/c:/some/project", "c:\\some\\project")).toBe(true);
    expect(pathMatchesProject("file:///c%3A/some/project/src/index.ts", "c:\\some\\project")).toBe(true);
  });

  it("does not match sibling paths with the same prefix", () => {
    expect(pathMatchesProject("/c:/some/projectile", "c:\\some\\project")).toBe(false);
  });
});
