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

describe("extractFileReferences — edge cases (m2)", () => {
  it("does not match a basename that is a substring of another filename", () => {
    // "index.ts" should not match inside "reindex.ts"
    const text = "Modified reindex.ts to speed up lookups";
    const repoFiles = ["src/index.ts", "src/reindex.ts"];
    const refs = extractFileReferences(text, repoFiles);
    expect(refs).not.toContain("src/index.ts");
    expect(refs).toContain("src/reindex.ts");
  });

  it("matches a basename surrounded by spaces", () => {
    const text = "Changed index.ts to export the new function";
    const repoFiles = ["src/index.ts"];
    const refs = extractFileReferences(text, repoFiles);
    expect(refs).toContain("src/index.ts");
  });

  it("matches a basename surrounded by backticks", () => {
    const text = "See `index.ts` for the entry point";
    const repoFiles = ["src/index.ts"];
    const refs = extractFileReferences(text, repoFiles);
    expect(refs).toContain("src/index.ts");
  });

  it("matches via full path even when basename would be ambiguous", () => {
    const text = "Updated src/utils/index.ts but not src/index.ts";
    const repoFiles = ["src/utils/index.ts", "src/index.ts"];
    const refs = extractFileReferences(text, repoFiles);
    expect(refs).toContain("src/utils/index.ts");
    expect(refs).toContain("src/index.ts");
  });

  it("does not match a basename that is a prefix of a larger identifier", () => {
    // "index.ts" should not match inside "index.tsconfig" or "index.tsc"
    const text = "Check index.tsconfig for compiler settings";
    const repoFiles = ["src/index.ts"];
    const refs = extractFileReferences(text, repoFiles);
    expect(refs).not.toContain("src/index.ts");
  });

  it("returns deduplicated results when both path and basename match", () => {
    const text = "See src/index.ts — specifically index.ts exports";
    const repoFiles = ["src/index.ts"];
    const refs = extractFileReferences(text, repoFiles);
    expect(refs).toEqual(["src/index.ts"]); // only one entry
  });

  it("returns empty array when no files match", () => {
    const text = "No relevant files changed";
    const refs = extractFileReferences(text, ["src/main.ts", "README.md"]);
    expect(refs).toHaveLength(0);
  });
});
