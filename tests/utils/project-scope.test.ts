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

  /**
   * Every project whose folder name contains `_` or `.` scraped zero Claude
   * Code sessions, silently.
   *
   * The encoder replaced `:`, `\` and `/` and stopped there, so a project at
   * `H:\projects\private\eventwall\QueHay_Net` was looked for under
   * `h--projects-private-eventwall-quehay_net` while Claude Code had written
   * `h--projects-private-eventwall-quehay-net`. `filterProjectDirs` never
   * opened the directory, so the per-record `cwd` check that would have
   * attributed those sessions correctly never ran on them. That project had
   * over 200MB of transcripts and xtctx reported an empty history.
   *
   * Found by installing xtctx on a real project rather than by testing it.
   * xtctx's own directory has no `_` or `.` in it, which is why every test and
   * every trial run to date agreed the encoder was right.
   *
   * The substitutions below are measured, not guessed: 134 directories in a
   * real `~/.claude/projects` compared against the `cwd` recorded inside their
   * own transcripts (2026-09-04) show exactly `.`, `:`, `\` and `_` collapsing
   * to `-`, plus case folding.
   */
  it("collapses the dots and underscores Claude Code also collapses", () => {
    expect(encodePathForToolDirectory("H:\\projects\\eventwall\\QueHay_Net")).toBe(
      "H--projects-eventwall-QueHay-Net",
    );
    expect(encodePathForToolDirectory("/Users/me/my_app")).toBe("-Users-me-my-app");
    expect(encodePathForToolDirectory("/Users/me/site.com")).toBe("-Users-me-site-com");
  });
});
