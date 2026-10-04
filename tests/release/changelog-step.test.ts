import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const run = promisify(execFile);

/**
 * The release workflow writes the CHANGELOG entry with a shell step, and a
 * mistake in it ships: the file is committed and tagged by the same run. This
 * runs the step's real script against sample changelogs rather than a copy of
 * it, so what is tested is what the workflow will execute.
 *
 * It exists for two reasons. The file carries an `## [Unreleased]` section, and
 * the step used to insert above the first `## ` heading, which would have put
 * the new release above Unreleased and left that section describing shipped
 * work. And the step then DROPPED that section's hand-written body in favour of
 * GitHub's generated list of pull-request titles, which is the wrong way round:
 * the hand-written text is what a reader of the changelog wants, and the
 * generated list is only a set of links to the work behind it.
 */

/** The `run:` script of the named step in release.yml, de-indented. */
async function stepScript(name: string): Promise<string> {
  const workflow = (await readFile(join(process.cwd(), ".github", "workflows", "release.yml"), "utf-8"))
    .replace(/\r\n/g, "\n");
  const start = workflow.indexOf(`      - name: ${name}\n`);
  expect(start, `release.yml has no step named "${name}"`).toBeGreaterThan(-1);
  const runAt = workflow.indexOf("        run: |\n", start);
  const end = workflow.indexOf("\n      - name:", runAt);
  return workflow
    .slice(runAt + "        run: |\n".length, end === -1 ? undefined : end)
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");
}

const GENERATED_NOTES = [
  "## What's Changed",
  "* fix: a generated title by @someone in https://github.com/o/r/pull/11",
  "* feat: another generated title by @someone-else in https://github.com/o/r/pull/12",
  "* chore(deps): bump x by @dependabot[bot] in https://github.com/o/r/pull/11",
  "",
  "**Full Changelog**: https://github.com/o/r/compare/xtctx-v1.0.0...xtctx-v1.2.3",
].join("\n");

const HEADER = "# Changelog\n\nintro\n\n";

describe("release workflow: Write the CHANGELOG entry", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "xtctx-changelog-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function release(changelog: string, notes = GENERATED_NOTES): Promise<string> {
    await writeFile(join(dir, "CHANGELOG.md"), changelog, "utf-8");
    await run("bash", ["-c", await stepScript("Write the CHANGELOG entry")], {
      cwd: dir,
      env: {
        ...process.env,
        NOTES: notes,
        VERSION: "1.2.3",
        TAG: "xtctx-v1.2.3",
        GITHUB_REPOSITORY: "o/r",
      },
    });
    return (await readFile(join(dir, "CHANGELOG.md"), "utf-8")).replace(/\r\n/g, "\n");
  }

  const headings = (text: string): string[] =>
    text.split("\n").filter((line) => line.startsWith("## ")).map((line) => line.replace(/\].*/, "]"));

  /** Everything under the heading for `version`, up to the next `## ` heading. */
  const section = (text: string, version: string): string => {
    const lines = text.split("\n");
    const at = lines.findIndex((line) => line.startsWith(`## [${version}]`));
    expect(at, `no heading for ${version}`).toBeGreaterThan(-1);
    const rest = lines.slice(at + 1);
    const next = rest.findIndex((line) => line.startsWith("## "));
    return rest.slice(0, next === -1 ? undefined : next).join("\n");
  };

  it("keeps the hand-written Unreleased body as the release notes and empties Unreleased", async () => {
    const out = await release(
      `${HEADER}## [Unreleased]\n\n### Added\n\n- hand-written item\n\n## [1.0.0](u) (2026-01-01)\n\n- old\n`,
    );

    expect(headings(out)).toEqual(["## [Unreleased]", "## [1.2.3]", "## [1.0.0]"]);
    expect(section(out, "Unreleased").trim()).toBe("");
    const entry = section(out, "1.2.3");
    expect(entry).toContain("### Added\n\n- hand-written item");
    // Written once, not copied and left behind as well.
    expect(out.split("hand-written item")).toHaveLength(2);
    expect(section(out, "1.0.0")).toContain("- old");
  });

  it("adds generated notes only as pull-request links under the hand-written body", async () => {
    const out = await release(`${HEADER}## [Unreleased]\n\n- hand-written item\n\n## [1.0.0](u) (2026-01-01)\n\n- old\n`);
    const entry = section(out, "1.2.3");

    expect(entry).toContain("**Pull requests:**");
    expect(entry).toContain("[#11](https://github.com/o/r/pull/11)");
    expect(entry).toContain("[#12](https://github.com/o/r/pull/12)");
    // #11 appears twice in the generated notes and once in the links.
    expect(entry.split("pull/11)")).toHaveLength(2);
    expect(entry).toContain("https://github.com/o/r/compare/xtctx-v1.0.0...xtctx-v1.2.3");
    // None of the generated prose.
    expect(entry).not.toContain("generated title");
    expect(entry).not.toContain("@someone");
    expect(entry.indexOf("hand-written item")).toBeLessThan(entry.indexOf("**Pull requests:**"));
  });

  it("falls back to the generated list, saying so, when Unreleased is empty", async () => {
    const out = await release(`${HEADER}## [Unreleased]\n\n\n\n## [1.0.0](u) (2026-01-01)\n\n- old\n`);

    expect(headings(out)).toEqual(["## [Unreleased]", "## [1.2.3]", "## [1.0.0]"]);
    const entry = section(out, "1.2.3");
    expect(entry).toContain("Nothing was written under Unreleased");
    expect(entry).toContain("* fix: a generated title");
    // GitHub's own `## ` heading is demoted so it is not read as a release.
    expect(entry).toContain("### What's Changed");
    expect(entry).not.toContain("**Pull requests:**");
  });

  it("puts the release beneath Unreleased and above older entries, with the header intact", async () => {
    const out = await release(`${HEADER}## [Unreleased]\n\n- item\n\n## [1.0.0](u) (2026-01-01)\n\n- old\n`);

    expect(
      out.startsWith(`${HEADER}## [Unreleased]\n\n## [1.2.3](https://github.com/o/r/releases/tag/xtctx-v1.2.3) (`),
    ).toBe(true);
    expect(out).toMatch(/\) \(\d{4}-\d{2}-\d{2}\)\n/);
  });

  it("still inserts above the newest entry when there is no Unreleased section", async () => {
    const out = await release(`${HEADER}## [1.0.0](u) (2026-01-01)\n\n- old\n`);

    expect(headings(out)).toEqual(["## [1.2.3]", "## [1.0.0]"]);
    expect(out.startsWith(`${HEADER}## [1.2.3]`)).toBe(true);
    expect(section(out, "1.2.3")).toContain("Nothing was written under Unreleased");
  });

  it("does not duplicate the Unreleased body when it is the only section", async () => {
    const out = await release(`${HEADER}## [Unreleased]\n\n- only item\n`);

    expect(headings(out)).toEqual(["## [Unreleased]", "## [1.2.3]"]);
    expect(out.split("only item")).toHaveLength(2);
    expect(section(out, "Unreleased").trim()).toBe("");
    expect(section(out, "1.2.3")).toContain("- only item");
  });

  it("builds the links from pull-request numbers only, so a title cannot inject markup", async () => {
    const out = await release(
      `${HEADER}## [Unreleased]\n\n- item\n`,
      "* evil by @x in https://github.com/o/r/pull/7)[click](http://evil.example\n",
    );

    expect(section(out, "1.2.3")).toContain("[#7](https://github.com/o/r/pull/7)");
    expect(out).not.toContain("evil.example");
  });
});

describe("release workflow: Create the GitHub release", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "xtctx-gh-release-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Runs the real step with `gh` replaced by a function that records its call. */
  async function createRelease(changelog: string): Promise<{ args: string[]; notes: string }> {
    await writeFile(join(dir, "CHANGELOG.md"), changelog, "utf-8");
    const stub = [
      "gh() {",
      '  printf "%s\\n" "$@" > "$STUB_DIR/args"',
      '  while [ "$#" -gt 0 ]; do',
      '    if [ "$1" = "--notes-file" ]; then cp "$2" "$STUB_DIR/notes.md"; fi',
      "    shift",
      "  done",
      "}",
    ].join("\n");
    await run("bash", ["-c", `${stub}\n${await stepScript("Create the GitHub release")}`], {
      cwd: dir,
      env: { ...process.env, VERSION: "1.2.3", TAG: "xtctx-v1.2.3", STUB_DIR: dir, NOTES: "SHOULD NOT BE USED" },
    });
    return {
      args: (await readFile(join(dir, "args"), "utf-8")).split("\n").filter(Boolean),
      notes: (await readFile(join(dir, "notes.md"), "utf-8")).replace(/\r\n/g, "\n"),
    };
  }

  it("uses this version's CHANGELOG section, without its heading, as the release notes", async () => {
    const { args, notes } = await createRelease(
      [
        "# Changelog",
        "",
        "## [Unreleased]",
        "",
        "## [1.2.3](https://github.com/o/r/releases/tag/xtctx-v1.2.3) (2026-02-02)",
        "",
        "A summary.",
        "",
        "### Fixed",
        "",
        "- the thing",
        "",
        "**Pull requests:** [#11](https://github.com/o/r/pull/11)",
        "",
        "## [1.0.0](u) (2026-01-01)",
        "",
        "- old",
        "",
      ].join("\n"),
    );

    expect(args.slice(0, 2)).toEqual(["release", "create"]);
    expect(args).toContain("xtctx-v1.2.3");
    expect(notes).toContain("A summary.");
    expect(notes).toContain("- the thing");
    expect(notes).toContain("**Pull requests:** [#11]");
    expect(notes).not.toContain("## [1.2.3]");
    expect(notes).not.toContain("- old");
    expect(notes).not.toContain("SHOULD NOT BE USED");
  });

  it("fails rather than publishing empty notes when the section is missing", async () => {
    await expect(
      createRelease("# Changelog\n\n## [Unreleased]\n\n## [1.0.0](u) (2026-01-01)\n\n- old\n"),
    ).rejects.toThrow();
  });
});
