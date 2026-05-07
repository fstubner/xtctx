/**
 * Handoff brief generator.
 *
 * Takes the most-recent session from any tool other than the one being
 * synced into, and produces a short markdown brief that gets injected
 * into the destination tool's memory file (CLAUDE.md / AGENTS.md /
 * .cursor/rules/xtctx-managed.mdc / etc.).
 *
 * Why this is a pure function with no I/O:
 *   - The caller (sync engine, runtime) decides where session data
 *     comes from (LanceDB index today, simpler SQLite store later, or
 *     direct scraper reads in the post-pivot architecture).
 *   - This module just formats. Tests are fast and deterministic.
 *   - Replacing the data source (LanceDB → SQLite + FTS5) doesn't
 *     require touching this file.
 *
 * Why it's "the most-recent session not in the current tool":
 *   - The brief is for *handoff* — telling tool B what just happened
 *     in tool A. Including tool B's own session in tool B's brief is
 *     redundant; the agent already has its own immediate context.
 *
 * Failure modes that produce empty output (intentional):
 *   - No sessions at all (fresh project)
 *   - Only sessions in the current tool (no handoff to brief)
 *   - All sessions are stale (> staleThresholdMs old, default 7 days)
 *
 * Falsy output is a signal to the caller to skip the brief section
 * entirely rather than render an empty header.
 */

export interface HandoffSession {
  /** Tool slug — e.g. "claude-code", "cursor", "codex". */
  tool: string;
  /** Stable session reference returned by the indexer. */
  sessionRef: string;
  /** ISO 8601 timestamp of the *last* activity in the session. */
  lastActivityAt: string;
  /** Optional: short text excerpt to include verbatim in the brief. */
  summary?: string;
  /** Optional: the source URI / path the agent can read for the full transcript. */
  sourcePath?: string;
  /** Optional: number of messages in the session (informational). */
  messageCount?: number;
}

export interface HandoffBriefOptions {
  /**
   * Reference time for "how long ago was this session" calculations.
   * Defaults to the wall clock. Tests inject a fixed time for
   * deterministic output.
   */
  now?: () => Date;
  /**
   * Sessions older than this in milliseconds are considered stale and
   * a brief from them is suppressed (returns "" → caller skips the
   * section). Defaults to 7 days.
   *
   * Stale sessions are usually evidence the user moved away from the
   * project; auto-injecting a multi-week-old brief into a fresh tool's
   * memory file is noise, not signal.
   */
  staleThresholdMs?: number;
}

const DEFAULT_STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Pick the most-recent session that is NOT in `currentTool` and is
 * within the staleness threshold. Returns null if no such session.
 */
export function pickHandoffSession(
  sessions: readonly HandoffSession[],
  currentTool: string,
  options: HandoffBriefOptions = {},
): HandoffSession | null {
  const now = options.now ?? (() => new Date());
  const threshold = options.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
  const cutoff = now().getTime() - threshold;

  // The session list is conventionally ordered most-recent-first by the
  // indexer, but we don't assume that — sort defensively so a future
  // change to the upstream ordering doesn't silently break briefing.
  const sorted = [...sessions].sort(
    (a, b) =>
      Date.parse(b.lastActivityAt || "") - Date.parse(a.lastActivityAt || ""),
  );

  for (const session of sorted) {
    if (session.tool === currentTool) {
      continue;
    }
    const ts = Date.parse(session.lastActivityAt);
    if (Number.isNaN(ts)) {
      continue;
    }
    if (ts < cutoff) {
      continue;
    }
    return session;
  }

  return null;
}

/**
 * Render a handoff brief as markdown, ready to be embedded in a
 * destination tool's managed block.
 *
 * Returns an empty string when no qualifying session exists. The
 * caller should treat empty-string as "skip this section entirely"
 * rather than rendering a bare header.
 */
export function generateHandoffBrief(
  sessions: readonly HandoffSession[],
  currentTool: string,
  options: HandoffBriefOptions = {},
): string {
  const session = pickHandoffSession(sessions, currentTool, options);
  if (!session) {
    return "";
  }

  const now = options.now ?? (() => new Date());
  const ageLabel = formatAge(
    now().getTime() - Date.parse(session.lastActivityAt),
  );

  const lines: string[] = [
    "## Last session in another tool",
    "",
    `**Tool:** ${formatToolName(session.tool)} · **When:** ${ageLabel}`,
  ];

  if (session.messageCount !== undefined && session.messageCount > 0) {
    lines.push(
      `**Messages:** ${session.messageCount} · **Session:** \`${session.sessionRef}\``,
    );
  } else {
    lines.push(`**Session:** \`${session.sessionRef}\``);
  }

  if (session.summary && session.summary.trim().length > 0) {
    lines.push("", session.summary.trim());
  }

  if (session.sourcePath) {
    lines.push("", `_Full transcript: \`${session.sourcePath}\`_`);
  }

  return lines.join("\n");
}

/**
 * Human-readable "X minutes ago" / "X hours ago" / "X days ago".
 *
 * Why no fractional values: an agent reading the brief doesn't care
 * whether it was 3.7 hours or 4 hours ago — the rounded label is
 * sufficient signal. Avoids the I18n + locale-formatting tax that
 * comes with libraries like `date-fns/formatDistance`.
 */
function formatAge(ageMs: number): string {
  if (ageMs < 0) {
    // Clock skew or fixture-injected future time; treat as "just now".
    return "just now";
  }
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * Scrapers write the tool field with their own canonical slug
 * (e.g. `claude-code`), but the policy / sync layers identify tools
 * by their policy slug (`claude`). The brief generator compares
 * `currentTool === session.tool` to skip same-tool sessions, which
 * means the two slug spaces have to be normalized at the adapter
 * boundary.
 *
 * Only `claude-code` differs from its policy slug today; the other
 * six (cursor, codex, copilot, copilot-cli, gemini, opencode) are
 * identical in both layers. Add new entries here when the scraper
 * slug for a new tool diverges from its policy slug.
 */
const SCRAPER_TO_POLICY_SLUG: Record<string, string> = {
  "claude-code": "claude",
};

function normalizeToolSlug(scraperSlug: string): string {
  return SCRAPER_TO_POLICY_SLUG[scraperSlug] ?? scraperSlug;
}

/**
 * Adapter: turn a `SessionSummary` (the runtime's session-listing
 * type) into a `HandoffSession` (this module's input shape).
 *
 * Falls back to `started_at` if `last_activity_at` is missing — a
 * session-source older than the SessionSummary extension would only
 * provide `started_at`, and a stale-but-correct timestamp is better
 * than skipping the brief entirely.
 *
 * Normalizes scraper-style tool slugs (`claude-code`) to policy
 * slugs (`claude`) so the brief generator's currentTool comparison
 * works correctly across the slug-space boundary.
 */
export function sessionSummaryToHandoff(summary: {
  session_ref: string;
  tool: string;
  started_at: string;
  last_activity_at?: string;
  summary?: string;
  message_count?: number;
}): HandoffSession {
  return {
    tool: normalizeToolSlug(summary.tool),
    sessionRef: summary.session_ref,
    lastActivityAt: summary.last_activity_at ?? summary.started_at,
    ...(summary.summary !== undefined ? { summary: summary.summary } : {}),
    ...(summary.message_count !== undefined
      ? { messageCount: summary.message_count }
      : {}),
  };
}

/**
 * Map internal tool slugs to display names. Slugs are kebab-case for
 * stability; display names match the tool's own brand-cased name.
 */
function formatToolName(tool: string): string {
  // Includes both policy slug (`claude`) and scraper slug
  // (`claude-code`) for Claude Code so the formatter is robust
  // whether the caller normalized upstream or not. Other tools
  // share the same slug across both spaces.
  const map: Record<string, string> = {
    claude: "Claude Code",
    "claude-code": "Claude Code",
    cursor: "Cursor",
    copilot: "Copilot (VS Code)",
    "copilot-cli": "Copilot CLI",
    codex: "Codex CLI",
    gemini: "Gemini CLI",
    opencode: "opencode",
  };
  return map[tool] ?? tool;
}
