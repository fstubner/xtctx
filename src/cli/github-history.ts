import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ArchivedMessage, ArchivedSession } from "../handoff/archive.js";
import { endLine, headerLine, sessionLine } from "../handoff/export-file.js";
import { hashParts } from "../handoff/hash.js";
import { createProjectServices } from "../runtime/services.js";
import { runDiffSync } from "../sync/diff-sync.js";
import { getCanonicalRepoId } from "../sync/normalizer.js";
import { writeFileAtomic } from "../utils/atomic-file.js";

export interface GithubImportOptions {
  projectPath?: string;
  repo?: string;
  limit?: number;
  full?: boolean;
  dryRun?: boolean;
  sync?: boolean;
}

interface GithubUser {
  login?: string;
}

interface GithubIssueItem {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  created_at: string;
  updated_at: string;
  comments: number;
  html_url?: string;
  user?: GithubUser | null;
  pull_request?: { url?: string } | null;
}

interface GithubCommentItem {
  id: number;
  body: string | null;
  created_at: string;
  updated_at?: string;
  user?: GithubUser | null;
}

interface GithubPullDetail {
  head?: {
    ref?: string;
    sha?: string;
  };
}

interface GithubSyncState {
  repos?: Record<string, { lastUpdatedAt?: string }>;
}

const VALID_SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/;

export function parseGithubRepo(input: string): { owner: string; repo: string } {
  const cleaned = input.trim().replace(/^https?:\/\//i, "").replace(/^github\.com\//i, "").replace(/\.git$/i, "");
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length !== 2 || !VALID_SEGMENT.test(parts[0]) || !VALID_SEGMENT.test(parts[1])) {
    throw new Error(`Expected GitHub repository as owner/repo (got "${input}"). Pass --repo owner/repo.`);
  }
  return { owner: parts[0], repo: parts[1] };
}

async function resolveGithubRepo(projectRoot: string, explicit?: string): Promise<{ owner: string; repo: string }> {
  if (explicit) return parseGithubRepo(explicit);
  const { repoId } = await getCanonicalRepoId(projectRoot);
  if (!repoId.toLowerCase().startsWith("github.com/")) {
    throw new Error("Project remote is not a GitHub repository. Pass --repo owner/repo explicitly.");
  }
  return parseGithubRepo(repoId);
}

async function githubFetchJson<T>(url: string, token?: string): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "xtctx-github-importer",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, { headers });
  if (res.status === 401 || res.status === 403 || res.status === 429) {
    throw new Error(
      `GitHub API refused request (${res.status}). Set GITHUB_TOKEN or GH_TOKEN for private repos or higher rate limits.`,
    );
  }
  if (!res.ok) {
    throw new Error(`GitHub API request failed (${res.status}) for ${new URL(url).pathname}`);
  }
  return (await res.json()) as T;
}

async function readState(statePath: string): Promise<GithubSyncState> {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf-8")) as GithubSyncState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function runGithubImport(options: GithubImportOptions = {}): Promise<{
  repo: string;
  importedSessions: number;
  importedMessages: number;
  createdSessions: number;
  addedMessages: number;
}> {
  const projectRoot = resolve(options.projectPath ?? process.cwd());
  const { owner, repo } = await resolveGithubRepo(projectRoot, options.repo);
  const repoSlug = `${owner}/${repo}`;
  const limit = Math.min(500, Math.max(1, Math.trunc(options.limit ?? 50)));
  const token = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim() || undefined;

  const statePath = join(projectRoot, ".xtctx", "state", "github-state.json");
  const state = await readState(statePath);
  const since = !options.full ? state.repos?.[repoSlug]?.lastUpdatedAt : undefined;

  const items: GithubIssueItem[] = [];
  for (let page = 1; items.length < limit; page += 1) {
    const perPage = Math.min(100, limit - items.length);
    const params = new URLSearchParams({
      state: "all",
      sort: "updated",
      direction: "desc",
      per_page: String(perPage),
      page: String(page),
      ...(since ? { since } : {}),
    });
    const batch = await githubFetchJson<GithubIssueItem[]>(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?${params}`,
      token,
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    items.push(...batch);
    if (batch.length < perPage) break;
  }

  const sessions: ArchivedSession[] = [];
  let maxUpdatedAt = since ?? "";

  for (const item of items.slice(0, limit)) {
    const isPr = Boolean(item.pull_request);
    const tool = isPr ? "github-pr" : "github-issue";
    const sourceSessionId = isPr ? `pr-${item.number}` : `issue-${item.number}`;
    const sessionRef = `${tool}:${sourceSessionId}`;

    let gitBranch: string | null = null;
    let gitCommit: string | null = null;
    if (isPr) {
      const detail = await githubFetchJson<GithubPullDetail>(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${item.number}`,
        token,
      ).catch(() => null);
      gitBranch = typeof detail?.head?.ref === "string" ? detail.head.ref : null;
      gitCommit = typeof detail?.head?.sha === "string" ? detail.head.sha : null;
    }

    const author = item.user?.login ?? "unknown";
    const bodyText = item.body?.trim() ? `\n\n${item.body.trim()}` : "";
    const rootContent = `#${item.number} [${item.state}] ${item.title}\nAuthor: @${author}${bodyText}`;
    const rootMeta = JSON.stringify({
      source_provider: "github",
      source_message_id: String(item.id),
      source_role: "author",
      untrusted_transcript_data: true,
    });
    const messages: ArchivedMessage[] = [
      {
        id: hashParts([sessionRef, "root", String(item.number), rootContent]),
        timestamp: item.created_at,
        role: "user",
        content: rootContent,
        message_index: 0,
        content_hash: hashParts([rootContent]),
        metadata_json: rootMeta,
        source_pointer: item.html_url ?? null,
      },
    ];

    if (item.comments > 0) {
      const comments = await githubFetchJson<GithubCommentItem[]>(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${item.number}/comments?per_page=100`,
        token,
      );
      for (let i = 0; i < comments.length; i += 1) {
        const comment = comments[i];
        const cUser = comment.user?.login ?? "unknown";
        const cBody = (comment.body ?? "").trim();
        const cContent = `@${cUser} commented:\n\n${cBody}`;
        messages.push({
          id: hashParts([sessionRef, "comment", String(comment.id), cContent]),
          timestamp: comment.created_at,
          role: "user",
          content: cContent,
          message_index: i + 1,
          content_hash: hashParts([cContent]),
          metadata_json: JSON.stringify({
            source_provider: "github",
            source_message_id: String(comment.id),
            source_role: "comment",
            untrusted_transcript_data: true,
          }),
          source_pointer: item.html_url ?? null,
        });
      }
    }

    const lastActivity = messages.reduce((latest, m) => (m.timestamp > latest ? m.timestamp : latest), item.updated_at || item.created_at);
    if (item.updated_at && item.updated_at > maxUpdatedAt) maxUpdatedAt = item.updated_at;

    sessions.push({
      session_ref: sessionRef,
      tool,
      source_session_id: sourceSessionId,
      project_root: projectRoot,
      git_branch: gitBranch,
      git_commit: gitCommit,
      started_at: item.created_at,
      last_activity_at: lastActivity,
      preview: `#${item.number}: ${item.title}`.slice(0, 160),
      source_path: null,
      messages,
    });
  }

  const totalMessages = sessions.reduce((sum, s) => sum + s.messages.length, 0);
  if (options.dryRun) {
    const out = { dryRun: true, repo: repoSlug, importedSessions: sessions.length, importedMessages: totalMessages, createdSessions: 0, addedMessages: 0 };
    console.log(JSON.stringify(out));
    return out;
  }

  const services = await createProjectServices(projectRoot);
  let createdSessions = 0;
  let addedMessages = 0;
  try {
    if (!services.config.present || services.config.error || !services.sessions.importSessions) {
      throw new Error("Configure this project with `xtctx setup` before importing GitHub Issues/PRs.");
    }
    if (sessions.length > 0) {
      async function* lines() {
        yield headerLine(services.projectRoot);
        for (const s of sessions) yield sessionLine(s);
        yield endLine(sessions.length, totalMessages);
      }
      const summary = await services.sessions.importSessions(lines());
      if (!summary.complete || summary.invalidLines.length > 0) {
        throw new Error("GitHub import did not complete cleanly; rerun to resume safely.");
      }
      createdSessions = summary.sessionsAdded;
      addedMessages = summary.messagesAdded;
    }
  } finally {
    await services.sessions.close();
  }

  if (maxUpdatedAt) {
    await writeFileAtomic(
      statePath,
      JSON.stringify({ repos: { ...state.repos, [repoSlug]: { lastUpdatedAt: maxUpdatedAt } } }, null, 2),
      { containWithin: projectRoot },
    );
  }

  const result = { repo: repoSlug, importedSessions: sessions.length, importedMessages: totalMessages, createdSessions, addedMessages };
  console.log(JSON.stringify(result));
  if (options.sync) {
    console.log(JSON.stringify({ sync: await runDiffSync({ projectDir: projectRoot }) }));
  }
  return result;
}
