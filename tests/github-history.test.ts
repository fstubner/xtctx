import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseGithubRepo, runGithubImport } from "@xtctx/cli/github-history";
import { openDatabase } from "@xtctx/handoff/schema";

describe("parseGithubRepo", () => {
  it("normalizes github.com remotes and owner/repo slugs", () => {
    expect(parseGithubRepo("github.com/fstubner/xtctx")).toEqual({ owner: "fstubner", repo: "xtctx" });
    expect(parseGithubRepo("https://github.com/fstubner/xtctx.git")).toEqual({ owner: "fstubner", repo: "xtctx" });
    expect(parseGithubRepo("fstubner/xtctx")).toEqual({ owner: "fstubner", repo: "xtctx" });
    expect(() => parseGithubRepo("not-a-repo")).toThrow(/owner\/repo/);
  });
});

describe("runGithubImport", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "xtctx-gh-"));
    mkdirSync(join(root, ".xtctx", "state"), { recursive: true });
    writeFileSync(join(root, ".xtctx", "config.yaml"), "handoff:\n  mode: raw-transcript-pointer\n");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it("indexes issues, PR branch metadata, and comments idempotently with incremental cursor", async () => {
    const issuePayload = [
      {
        id: 101,
        number: 12,
        title: "Add Cursor sessionStart hook",
        body: "Support .cursor/hooks.json",
        state: "open",
        created_at: "2026-11-20T10:00:00Z",
        updated_at: "2026-11-20T12:00:00Z",
        comments: 1,
        html_url: "https://github.com/acme/app/pull/12",
        user: { login: "alice" },
        pull_request: { url: "https://api.github.com/repos/acme/app/pulls/12" },
      },
      {
        id: 102,
        number: 11,
        title: "Bug in search",
        body: "Repro steps",
        state: "closed",
        created_at: "2026-11-19T10:00:00Z",
        updated_at: "2026-11-19T11:00:00Z",
        comments: 0,
        html_url: "https://github.com/acme/app/issues/11",
        user: { login: "bob" },
      },
    ];
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        requestedUrls.push(url);
        if (url.includes("/issues?")) {
          return Response.json(url.includes("since=") ? [] : issuePayload);
        }
        if (url.endsWith("/pulls/12")) {
          return Response.json({ head: { ref: "feat/cursor-hook", sha: "deadbeef" } });
        }
        if (url.includes("/issues/12/comments")) {
          return Response.json([
            { id: 500, body: "Looks good", created_at: "2026-11-20T11:00:00Z", user: { login: "carol" } },
          ]);
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const first = await runGithubImport({ projectPath: root, repo: "acme/app" });
    expect(first).toEqual({
      repo: "acme/app",
      importedSessions: 2,
      importedMessages: 3,
      createdSessions: 2,
      addedMessages: 3,
    });

    const db = openDatabase(join(root, ".xtctx", "state", "xtctx.db"));
    try {
      const pr = db.prepare("SELECT tool, git_branch, git_commit, preview FROM sessions WHERE session_ref = 'github-pr:pr-12'").get() as {
        tool: string;
        git_branch: string;
        git_commit: string;
        preview: string;
      };
      expect(pr).toMatchObject({
        tool: "github-pr",
        git_branch: "feat/cursor-hook",
        git_commit: "deadbeef",
      });
      expect(pr.preview).toContain("#12 [open] Add Cursor sessionStart hook");
      const msgs = db.prepare("SELECT content FROM messages WHERE session_ref = 'github-pr:pr-12' ORDER BY message_index").all() as Array<{
        content: string;
      }>;
      expect(msgs.map((m) => m.content)).toEqual([
        "#12 [open] Add Cursor sessionStart hook\nAuthor: @alice\n\nSupport .cursor/hooks.json",
        "@carol commented:\n\nLooks good",
      ]);
    } finally {
      db.close();
    }

    // Second run uses saved `since` cursor and adds nothing duplicate.
    const second = await runGithubImport({ projectPath: root, repo: "acme/app" });
    expect(second.importedSessions).toBe(0);
    expect(requestedUrls.some((u) => u.includes("since=2026-11-20T12%3A00%3A00Z"))).toBe(true);
  });
});
