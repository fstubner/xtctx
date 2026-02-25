import { describe, it, expect } from "vitest";
import { extractFileReferences, classifyDomains } from "@xtctx/knowledge/autotag";

describe("autotag", () => {
  it("extracts file references from text", () => {
    const text = "I modified src/utils/hash.ts and vitest.config.ts to fix the issue";
    const repoFiles = ["src/utils/hash.ts", "vitest.config.ts", "package.json"];
    const refs = extractFileReferences(text, repoFiles);
    expect(refs).toContain("src/utils/hash.ts");
    expect(refs).toContain("vitest.config.ts");
    expect(refs).not.toContain("package.json");
  });

  it("classifies domains from content", () => {
    const defaultMap = {
      cicd: ["github actions", "ci/cd", "pipeline", "workflow", "deploy"],
      database: ["postgres", "mysql", "sqlite", "migration", "schema"],
      testing: ["test", "vitest", "jest", "spec", "assert"],
    };

    const tags = classifyDomains(
      "Fixed the GitHub Actions workflow for running vitest tests",
      defaultMap,
    );
    expect(tags).toContain("cicd");
    expect(tags).toContain("testing");
    expect(tags).not.toContain("database");
  });
});
