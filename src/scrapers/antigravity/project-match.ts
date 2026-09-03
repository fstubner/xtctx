import { basename } from "node:path";
import { isRecord } from "../base.js";
import type { AntigravityArtifact, AntigravityRuntimeConversation } from "./shared.js";
import { toStringValue } from "./values.js";

/**
 * The workspace directories a trajectory summary names, if it names any.
 *
 * Lives here rather than with the step reader because a workspace uri is only
 * ever read to answer this module's question — whose session is this. Both the
 * top-level field and the one under `trajectoryMetadata` are tried before
 * concluding the summary names no workspace, which is a different answer from
 * it naming someone else's.
 */
export function extractWorkspaceUris(summary: Record<string, unknown>): string[] {
  const direct = extractWorkspaceUrisFromValue(summary.workspaces);
  if (direct.length > 0) {
    return direct;
  }

  const metadata = isRecord(summary.trajectoryMetadata) ? summary.trajectoryMetadata : {};
  return extractWorkspaceUrisFromValue(metadata.workspaces);
}

function extractWorkspaceUrisFromValue(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .map((workspace) => toStringValue(workspace.workspaceFolderAbsoluteUri))
    .filter((uri): uri is string => uri !== undefined);
}

/**
 * Whether a trajectory is worth fetching, decided from its summary alone.
 *
 * Antigravity's summaries carry the workspace a session belonged to, and
 * fetching a trajectory means pulling its entire transcript over the wire with
 * a 30s timeout. Doing that for every session on the machine and filtering
 * afterwards cost 155 round trips here to keep a handful.
 *
 * A summary that names workspaces and names none of ours belongs to another
 * project, so it is skipped — which also means another project's transcript is
 * never fetched at all, rather than fetched and then discarded.
 *
 * A summary with no workspace at all is not evidence of anything, so it is
 * still fetched: the message bodies may carry the only path evidence there is.
 */
export function shouldFetchTrajectory(
  summary: Record<string, unknown>,
  projectRoot?: string,
  antigravityRoot?: string,
): boolean {
  if (!projectRoot) {
    return true;
  }

  const workspaces = extractWorkspaceUris(summary);
  if (workspaces.length === 0) {
    return true;
  }

  return workspaces.some((workspace) =>
    textMentionsProject(workspace, projectRoot, antigravityRoot),
  );
}

export function artifactMatchesProject(
  artifact: AntigravityArtifact,
  projectRoot: string,
  antigravityRoot: string,
): boolean {
  const text = normalizeSearchText(
    [
      artifact.sourcePath,
      artifact.summary ?? "",
      artifact.body,
      ...artifact.referencedFiles,
    ].join("\n"),
  );
  return textMentionsProject(text, projectRoot, antigravityRoot);
}

export function runtimeConversationMatchesProject(
  conversation: AntigravityRuntimeConversation,
  projectRoot: string,
  antigravityRoot: string,
): boolean {
  if (
    conversation.workspaces.some((workspace) =>
      textMentionsProject(workspace, projectRoot, antigravityRoot),
    )
  ) {
    return true;
  }

  // Path evidence only. A previous fallback attributed a conversation when
  // the project's directory name appeared as a word anywhere in the title or
  // message text, which handed another project's private transcript to this
  // one whenever it mentioned that word — any project called `core`, `docs`,
  // or `client` collected most of the machine. A conversation Antigravity
  // gives us no path for is not attributable, so it is excluded.
  return conversation.messages.some((message) =>
    textMentionsProject(
      [
        message.content,
        message.sourcePath ?? "",
        ...message.referencedFiles,
      ].join("\n"),
      projectRoot,
      antigravityRoot,
    ),
  );
}

/**
 * Whether text records a file belonging to this project.
 *
 * The project's own path is the real evidence. Antigravity additionally keeps
 * a copy of some projects under `<its own root>/playground/<name>`, and those
 * conversations belong to the project they mirror — but only when that
 * playground is *this* install's.
 *
 * Matching `/playground/<name>/` anywhere was a name match wearing a path's
 * clothes: a conversation naming
 * `c:/Users/Someone/.gemini/antigravity/playground/api/...` was filed under a
 * project at `D:/work/api` — different drive, different user account. Any two
 * projects sharing a basename cross-contaminated, which is the boundary
 * PRODUCT.md promises and the comment above this one already says was
 * supposed to have been removed.
 *
 * What remains: a playground directory inside this reader's own Antigravity
 * install, sharing the project's name, is still treated as the project. Two
 * same-named projects in one user's own playground would still collide — that
 * case is genuinely ambiguous from a path alone, and it is a far narrower
 * claim than "anywhere on the machine".
 * @internal Exported for tests only.
 */
export function textMentionsProject(
  value: string,
  projectRoot: string,
  antigravityRoot?: string,
): boolean {
  const text = normalizeSearchText(value);
  if (mentionsPathWithBoundary(text, normalizeSearchText(projectRoot))) {
    return true;
  }

  if (!antigravityRoot) {
    return false;
  }

  const playground = `${normalizeSearchText(antigravityRoot)}/playground/${normalizeSearchText(basename(projectRoot))}`;
  return text.includes(`${playground}/`) || text.endsWith(playground);
}

/**
 * Whether `text` records `path` as a whole path rather than as a prefix of a
 * longer one.
 *
 * A bare `includes` filed every sibling whose name merely starts with this
 * project's: a root of `h:/projects/app` matched `h:/projects/app-secret/…`
 * and `h:/projects/appendix/…`, handing their transcripts to this project.
 * That is the third time this comparison has leaked along the same edge — the
 * two comments above record a `<name>` word match and a `/playground/<name>/`
 * match — and each previous fix tightened the pattern without adding the
 * boundary the pattern needed.
 *
 * A match counts when the next character cannot continue the final path
 * segment: end of text, a `/`, or a delimiter. Anything a filename could
 * contain — a letter, digit, `-`, `.`, `_` — means this is a different
 * directory that happens to share a prefix.
 */
function mentionsPathWithBoundary(text: string, path: string): boolean {
  if (!path) {
    return false;
  }

  // Whitespace, quotes and brackets end a path in prose, JSON and stack
  // traces alike; the set is an allowlist so an unlisted character is treated
  // as a continuation and rejected.
  const DELIMITERS = new Set([" ", "\t", "\n", "\r", '"', "'", "`", ")", "]", "}", ">", ",", ";", "|"]);

  // What may sit immediately *before* a path. Without this only the right-hand
  // side was bounded, so any foreign path ending with ours matched — a backup
  // under `/mnt/backup/<root>`, a container mount, a copy under another name —
  // and admitted the whole conversation that mentioned it.
  //
  // `:` is here because `normalizeSearchText` collapses `file:///x` to
  // `file:/x`, so a POSIX path is routinely preceded by the scheme's colon.
  const OPENERS = new Set([
    " ", "\t", "\n", "\r", '"', "'", "`", "(", "[", "{", "<", ",", ";", "|", ":", "=",
  ]);

  // A `/` before a POSIX absolute path means it is a *suffix* of a longer
  // path, which is the escape. A Windows path starts with its drive letter, so
  // there the same `/` is the legitimate one from `file:/h:/...`.
  const absolutePosix = path.startsWith("/");

  let from = 0;
  for (;;) {
    const at = text.indexOf(path, from);
    if (at === -1) {
      return false;
    }
    const next = text[at + path.length];
    const prev = at === 0 ? undefined : text[at - 1];
    const rightBounded = next === undefined || next === "/" || DELIMITERS.has(next);
    // A Windows path starts at its drive letter, so the `/` of `file:/h:/…`
    // sits immediately before it and is legitimate. `/mnt/backup/h:/…` looks
    // identical one character back, so the slash itself has to be bounded
    // too: what precedes it must open a path rather than continue one.
    const beforeSlash = at >= 2 ? text[at - 2] : undefined;
    const leftBounded =
      prev === undefined ||
      OPENERS.has(prev) ||
      (!absolutePosix &&
        prev === "/" &&
        (beforeSlash === undefined || OPENERS.has(beforeSlash)));
    if (rightBounded && leftBounded) {
      return true;
    }
    from = at + 1;
  }
}

function normalizeSearchText(value: string): string {
  return safeDecode(value).replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/g, "").toLowerCase();
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

