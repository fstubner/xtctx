import { describe, expect, it } from "vitest";
import { encodePathForToolDirectory, pathMatchesProject } from "@xtctx/utils/project-scope";

describe("pathMatchesProject", () => {
  it("matches Windows drive paths from file URLs on any host OS", () => {
    expect(pathMatchesProject("/c:/some/project", "c:\\some\\project")).toBe(true);
    expect(pathMatchesProject("file:///c%3A/some/project/src/index.ts", "c:\\some\\project")).toBe(true);
  });

  it("does not match sibling paths with the same prefix", () => {
    expect(pathMatchesProject("/c:/some/projectile", "c:\\some\\project")).toBe(false);
  });

  it("does not match a sibling directory separated by a double dash", () => {
    // `<root>--<suffix>` is a *separate directory*, not a child of root. This
    // clause belonged to Claude Code's encoded-directory naming and leaked
    // into real path comparison, so a project at `.../app` indexed and served
    // the transcripts of `.../app--secret`.
    expect(pathMatchesProject("/c:/work/app--secret/src/main.ts", "c:\\work\\app")).toBe(false);
    expect(pathMatchesProject("/c:/work/app--secret", "c:\\work\\app")).toBe(false);
  });

  it("still matches real children of the project root", () => {
    expect(pathMatchesProject("/c:/work/app/src/main.ts", "c:\\work\\app")).toBe(true);
    expect(pathMatchesProject("/c:/work/app", "c:\\work\\app")).toBe(true);
  });
});

describe("encodePathForToolDirectory", () => {
  it("keeps the leading separator dash that POSIX store directories carry", () => {
    // Claude Code encodes `/Users/me/code/app` as `-Users-me-code-app`.
    // Stripping the leading dash meant the encoded name never matched the
    // directory on disk, so every macOS/Linux project scraped zero sessions.
    expect(encodePathForToolDirectory("/Users/me/code/app")).toBe("-Users-me-code-app");
  });

  it("leaves Windows drive paths unchanged", () => {
    expect(encodePathForToolDirectory("H:\\projects\\x")).toBe("H--projects-x");
  });
});
