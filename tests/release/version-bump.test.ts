/**
 * `npm version` writes `package.json` and the lockfile. Five other files carry
 * the version too — three plugin manifests, the marketplace entry, and the
 * landing site — and Release Please used to write those. When it was removed
 * nothing took the job over.
 *
 * The consequence was not cosmetic. The release workflow bumps, commits, tags
 * and pushes; the commit it tagged would have failed its own test suite
 * (`plugin-package.test.ts` and `version-sync.test.ts` both compare against
 * `package.json`), and `publish.yml` would have refused it. The advertised
 * one-action release could not complete, and would have left a broken commit
 * tagged on main.
 *
 * These run the real bump against a copy of the repository rather than
 * asserting the script's shape, because what failed was the *lifecycle wiring*
 * — a correct script nothing invokes is the same defect.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO = process.cwd();

/** Every file that must agree, and how to read the version out of it. */
const VERSIONED: Array<[string, (raw: string) => string | undefined]> = [
  ["package.json", (raw) => JSON.parse(raw).version],
  ["plugin/plugin.json", (raw) => JSON.parse(raw).version],
  ["plugin/.claude-plugin/plugin.json", (raw) => JSON.parse(raw).version],
  ["plugin/.codex-plugin/plugin.json", (raw) => JSON.parse(raw).version],
  [
    ".claude-plugin/marketplace.json",
    (raw) => JSON.parse(raw).plugins.find((p: { name: string }) => p.name === "xtctx")?.version,
  ],
  ["landing/src/data/site.ts", (raw) => /version:\s*'([^']+)'/.exec(raw)?.[1]],
];

describe("version bump keeps every manifest in step", () => {
  const workspaces: string[] = [];

  afterEach(() => {
    for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A copy holding only the files a bump touches — no node_modules. */
  function scratchRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "xtctx-bump-"));
    workspaces.push(dir);
    for (const relative of [
      "package.json",
      "package-lock.json",
      "plugin",
      ".claude-plugin",
      "landing/src/data/site.ts",
      "scripts/sync-version.mjs",
    ]) {
      cpSync(join(REPO, relative), join(dir, relative), { recursive: true });
    }
    return dir;
  }

  function versionsIn(dir: string): Record<string, string | undefined> {
    return Object.fromEntries(
      VERSIONED.map(([relative, read]) => [
        relative,
        read(readFileSync(join(dir, relative), "utf-8")),
      ]),
    );
  }

  it("leaves every versioned file agreeing after npm version", () => {
    const dir = scratchRepo();

    // `--no-git-tag-version` is what the release workflow uses: there is no
    // git repo here to tag, and the workflow commits the result itself.
    execFileSync("npm", ["version", "patch", "--no-git-tag-version"], {
      cwd: dir,
      stdio: "pipe",
      shell: process.platform === "win32",
    });

    const versions = versionsIn(dir);
    const bumped = versions["package.json"];
    expect(bumped).toBeDefined();
    expect(bumped).not.toBe(JSON.parse(readFileSync(join(REPO, "package.json"), "utf-8")).version);

    // Named individually so a failure says which file drifted.
    for (const [relative] of VERSIONED) {
      expect(versions[relative], relative).toBe(bumped);
    }
  });

  it("checks the working tree is in sync without writing to it", () => {
    // What CI runs. It has to pass on a clean checkout, and it must not be
    // the thing that makes the checkout clean.
    const before = versionsIn(REPO);
    execFileSync(process.execPath, [join(REPO, "scripts", "sync-version.mjs"), "--check"], {
      cwd: REPO,
      stdio: "pipe",
    });
    expect(versionsIn(REPO)).toEqual(before);
  });

  it("reports which files disagree rather than failing silently", () => {
    const dir = scratchRepo();
    const pkgPath = join(dir, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    pkg.version = "99.99.99";
    // Written directly, bypassing the lifecycle hook, to simulate the drift.
    execFileSync(
      process.execPath,
      ["-e", `require("fs").writeFileSync(${JSON.stringify(pkgPath)}, ${JSON.stringify(JSON.stringify(pkg, null, 2))})`],
      { stdio: "pipe" },
    );

    expect(() =>
      execFileSync(process.execPath, [join(dir, "scripts", "sync-version.mjs"), "--check"], {
        cwd: dir,
        stdio: "pipe",
      }),
    ).toThrow();
  });
});
