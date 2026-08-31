/**
 * The project boundary is the whole safety story of a tool that reads private
 * developer conversations. PRODUCT.md states it outright: "content from other
 * projects on the machine never crosses the project boundary."
 *
 * `pathMatchesProject` already carries a docstring about this bug class being
 * found and fixed once — a `<root>--<suffix>` clause that made `.../app` match
 * `.../app--secret`. These are the two ways it still leaks, plus the case rule
 * that merges genuinely distinct projects on a case-sensitive filesystem.
 *
 * The candidate path is not xtctx's own: it is a `cwd` written into a
 * transcript by another tool, so it is untrusted input and traversal in it has
 * to be resolved rather than compared literally.
 */
import { describe, expect, it } from "vitest";
import { pathMatchesProject } from "@xtctx/utils/project-scope";
import { textMentionsProject } from "@xtctx/scrapers/antigravity";

describe("pathMatchesProject traversal", () => {
  it("does not match a sibling project reached through ..", () => {
    expect(
      pathMatchesProject("H:/projects/app/../other-client/secret.ts", "H:/projects/app"),
    ).toBe(false);
  });

  it("does not match an unrelated tree reached through several ..", () => {
    expect(
      pathMatchesProject("H:/projects/app/src/../../../etc/passwd", "H:/projects/app"),
    ).toBe(false);
  });

  it("still matches a real child that merely contains .. mid-path", () => {
    // `src/../src/a.ts` resolves back inside the project, so it must match:
    // resolving traversal has to mean resolving, not rejecting.
    expect(pathMatchesProject("H:/projects/app/src/../src/a.ts", "H:/projects/app")).toBe(true);
  });

  it("ignores . segments", () => {
    expect(pathMatchesProject("H:/projects/app/./src/a.ts", "H:/projects/app")).toBe(true);
  });

  it("resolves traversal in the root as well as the candidate", () => {
    expect(pathMatchesProject("H:/projects/app/a.ts", "H:/projects/lib/../app")).toBe(true);
  });

  it("keeps rejecting the sibling-suffix case the docstring records", () => {
    expect(pathMatchesProject("H:/projects/app--secret/a.ts", "H:/projects/app")).toBe(false);
    expect(pathMatchesProject("H:/projects/app-secret/a.ts", "H:/projects/app")).toBe(false);
  });

  it("still matches the ordinary cases", () => {
    expect(pathMatchesProject("H:/projects/app", "H:/projects/app")).toBe(true);
    expect(pathMatchesProject("H:/projects/app/src/a.ts", "H:/projects/app")).toBe(true);
    expect(pathMatchesProject("H:/projects/other/a.ts", "H:/projects/app")).toBe(false);
  });

  it("still handles file: URLs and backslashes", () => {
    expect(pathMatchesProject("file:///H:/projects/app/a.ts", "H:/projects/app")).toBe(true);
    expect(pathMatchesProject("H:\\projects\\app\\a.ts", "H:/projects/app")).toBe(true);
  });

  it("does not let traversal hide inside a file: URL", () => {
    expect(
      pathMatchesProject("file:///H:/projects/app/../other/a.ts", "H:/projects/app"),
    ).toBe(false);
  });

  it("does not let percent-encoded traversal through", () => {
    // The path is decoded before comparison, so %2e%2e is just `..` wearing a
    // hat and has to resolve the same way.
    expect(
      pathMatchesProject("H:/projects/app/%2e%2e/other/a.ts", "H:/projects/app"),
    ).toBe(false);
  });
});

/**
 * Antigravity gives no reliable per-conversation project field, so the scraper
 * infers ownership from paths in the text. That inference had no boundary: a
 * root of `h:/projects/app` matched `h:/projects/app-secret/…`, filing another
 * project's private transcript here. It is the only one of seven scrapers not
 * going through `pathMatchesProject`, and the two comments above it already
 * record this same edge leaking twice before.
 */
describe("antigravity textMentionsProject", () => {
  const ROOT = "H:/projects/app";

  it("does not claim a sibling whose name merely starts with the root", () => {
    expect(textMentionsProject("see H:/projects/app-secret/src/a.ts", ROOT)).toBe(false);
    expect(textMentionsProject("see H:/projects/appendix/notes.md", ROOT)).toBe(false);
    expect(textMentionsProject("see H:/projects/app--secret/a.ts", ROOT)).toBe(false);
  });

  it("still claims real paths inside the project", () => {
    expect(textMentionsProject("edited H:/projects/app/src/a.ts", ROOT)).toBe(true);
    expect(textMentionsProject("cwd is H:/projects/app", ROOT)).toBe(true);
  });

  it("claims the root when it is quoted or punctuated, as in JSON or prose", () => {
    expect(textMentionsProject('{"cwd":"H:/projects/app"}', ROOT)).toBe(true);
    expect(textMentionsProject("ran in H:/projects/app, then stopped", ROOT)).toBe(true);
  });

  it("finds a real match even when a prefix-only match appears first", () => {
    // The scan must not stop at the first hit: the decoy comes first here.
    expect(
      textMentionsProject("H:/projects/appendix/a.ts and H:/projects/app/b.ts", ROOT),
    ).toBe(true);
  });

  it("attributes nothing when the text names no path", () => {
    expect(textMentionsProject("we talked about app today", ROOT)).toBe(false);
  });
});
