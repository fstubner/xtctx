/**
 * A project opened through WSL is the same project.
 *
 * VS Code and Cursor record a WSL workspace as
 * `vscode-remote://wsl%2B<distro>/mnt/h/projects/app`, not as a `file:` URL.
 * `workspaceMatchesProject` only decoded the `file:` scheme and compared
 * everything else verbatim, so a Windows project root could never match one —
 * the workspace was invisible, silently, with no drift warning and no empty
 * result to notice.
 *
 * Measured on the machine that exposed it. Cursor holds 25 `wsl+` workspaces
 * and VS Code 21; of those, the ones carrying any conversation at all are 5
 * and 1 respectively, every one of them under `/mnt/<drive>`. So this recovers
 * a handful of real projects rather than the fifth of the history the raw
 * workspace count first suggested — the rest are empty shells or live in the
 * Linux filesystem.
 *
 * `/mnt/<drive>` is WSL's documented default automount root, and the machine
 * this was measured on confirms it: no `[automount]` section in `/etc/wsl.conf`
 * and `H:\ on /mnt/h` in the live mount table.
 *
 * What must NOT be translated matters as much. A `vscode-remote://` authority
 * that is not `wsl+` names another machine — that store held 9 such workspaces
 * for Cursor and 5 for VS Code — and mapping one onto a local root would serve
 * a different computer's conversations as this project's. A WSL path with no
 * drive component (`/home/fstubner/repos/blog-design-system`, and two siblings
 * in the same store) lives in the Linux filesystem and has no Windows path at
 * all.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workspaceMatchesProject } from "@xtctx/scrapers/vscode-workspace";

describe("a workspace opened through WSL", () => {
  let dir = "";
  let seq = 0;
  const projectRoot = join("H:", "projects", "ours");

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "xtctx-vscode-wsl-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Writes `workspace.json` beside a (never-opened) database path. */
  async function seed(folder: unknown): Promise<string> {
    const name = `hash-${(seq += 1)}`;
    await mkdir(join(dir, name), { recursive: true });
    await writeFile(join(dir, name, "workspace.json"), JSON.stringify({ folder }), "utf-8");
    return join(dir, name, "state.vscdb");
  }

  it("is claimed when it is this project under the WSL drive mount", async () => {
    expect(
      await workspaceMatchesProject(
        await seed("vscode-remote://wsl%2Bubuntu/mnt/h/projects/ours"),
        projectRoot,
      ),
    ).toBe(true);
  });

  it("is claimed for a subdirectory of this project", async () => {
    expect(
      await workspaceMatchesProject(
        await seed("vscode-remote://wsl%2Bubuntu-24.04/mnt/h/projects/ours/packages/api"),
        projectRoot,
      ),
    ).toBe(true);
  });

  it("is not claimed for a sibling sharing a name prefix", async () => {
    expect(
      await workspaceMatchesProject(
        await seed("vscode-remote://wsl%2Bubuntu/mnt/h/projects/ours-secret"),
        projectRoot,
      ),
    ).toBe(false);
  });

  it("is not claimed for a different drive", async () => {
    expect(
      await workspaceMatchesProject(
        await seed("vscode-remote://wsl%2Bubuntu/mnt/d/projects/ours"),
        projectRoot,
      ),
    ).toBe(false);
  });

  /**
   * The bare `/<drive>/…` shape, left by an `automount root = /` config, is
   * deliberately NOT translated. It appears 17 times in each tool's store
   * here, and every one of those workspaces holds zero conversations — so
   * translating it would add this design's only ambiguity, a single-letter
   * Linux directory that looks like a drive letter, for no coverage at all.
   */
  it("is not claimed when the drive is mounted at the filesystem root", async () => {
    expect(
      await workspaceMatchesProject(
        await seed("vscode-remote://wsl%2Bubuntu/h/projects/ours"),
        projectRoot,
      ),
    ).toBe(false);
  });

  /**
   * A first segment that is not `mnt` is a Linux directory. `/home` is the
   * case that actually occurs, but `/opt`, `/srv` and the rest must fail the
   * same way rather than by being individually excluded.
   */
  it("is not claimed when the first segment is a Linux directory, not a drive", async () => {
    expect(
      await workspaceMatchesProject(
        await seed("vscode-remote://wsl%2Bubuntu/opt/projects/ours"),
        projectRoot,
      ),
    ).toBe(false);
  });

  /**
   * The Linux filesystem is not the Windows one. There is no drive component
   * to translate, so there is nothing this project could match.
   */
  it("is not claimed when it lives in the Linux filesystem", async () => {
    expect(
      await workspaceMatchesProject(
        await seed("vscode-remote://wsl%2Bubuntu/home/fstubner/repos/ours"),
        projectRoot,
      ),
    ).toBe(false);
  });

  /**
   * Another machine entirely. Translating a non-WSL remote onto a local root
   * would serve a different computer's conversations as this project's, which
   * is a worse failure than the one this fix exists for.
   */
  it.each([
    ["ssh-remote", "vscode-remote://ssh-remote%2Bbuildbox/mnt/h/projects/ours"],
    ["dev container", "vscode-remote://dev-container%2Babc123/mnt/h/projects/ours"],
    ["codespaces", "vscode-remote://codespaces%2Bfoo/mnt/h/projects/ours"],
  ])("is not claimed when the remote is %s rather than WSL", async (_label, folder) => {
    expect(await workspaceMatchesProject(await seed(folder), projectRoot)).toBe(false);
  });

  /** Not a remote at all, and not a path either. Fails closed as before. */
  it("is not claimed for a virtual filesystem workspace", async () => {
    expect(
      await workspaceMatchesProject(
        await seed("vscode-vfs://github/someone/ours"),
        projectRoot,
      ),
    ).toBe(false);
  });

  /**
   * Run inside the distro, the project root is the POSIX path itself. This did
   * not work before either — the comparison saw the whole URI, scheme and
   * authority included, so a WSL workspace was invisible from both sides, not
   * just from Windows. Offering the POSIX reading is what fixes that half.
   */
  it("is claimed by its POSIX path when xtctx itself runs inside WSL", async () => {
    expect(
      await workspaceMatchesProject(
        await seed("vscode-remote://wsl%2Bubuntu-24.04/mnt/h/projects/ours"),
        "/mnt/h/projects/ours",
      ),
    ).toBe(true);
  });
});
