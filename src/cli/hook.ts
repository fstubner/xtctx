import { createProjectServices } from "../runtime/services.js";
import type { SessionSummary } from "../handoff/types.js";

export interface HookOptions {
  projectPath?: string;
  tool?: string;
  event?: string;
}

/**
 * How recent a session has to be to count as active context.
 *
 * Priming the agent with what someone was doing an hour ago saves it a
 * round-trip. Priming it with last week's work just puts stale detail at the
 * top of the context window, where it reads as current.
 */
const ACTIVE_FRAME_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Keep the preview to a line: this lands in the agent's boot context. */
const PREVIEW_CHARS = 200;
/**
 * A real branch name is far shorter than this. The cap is here because the
 * value is transcript-supplied rather than read from git, so its length is
 * the attacker's choice, not the repository's.
 */
const BRANCH_CHARS = 120;

export async function runHook(options: HookOptions = {}): Promise<void> {
  if (options.event && options.event !== "session-start") {
    return;
  }

  // Fail open throughout: this runs inside the host agent's session startup,
  // so a broken index or config must never surface as a startup error there.
  let services: Awaited<ReturnType<typeof createProjectServices>> | undefined;
  try {
    services = await createProjectServices(options.projectPath);
    const status = await services.sessions.getStatus();
    const tool = options.tool ?? "unknown";

    // Deliberately the no-scan read. This runs before the user's first turn,
    // and `listRecentSessions` would start a scan of every transcript store on
    // the machine and wait seconds for it — on every agent startup.
    const recent = (await services.sessions.listIndexedSessions?.(1)) ?? [];
    const active = recent.find(isActive);

    const lines = [
      "# xtctx handoff",
      "",
      `Tool: ${tool}`,
      `Project root: ${services.projectRoot}`,
      `Last scan: ${status.last_scan_at ?? "never"}`,
      "",
    ];

    if (active) {
      lines.push(...activeFrame(active));
    }

    lines.push(
      "Recent transcript context is available through MCP.",
      "Call `xtctx_recent_sessions`, then `xtctx_session_detail` for relevant sessions.",
      "",
    );

    process.stdout.write(lines.join("\n"));
  } catch {
    return;
  } finally {
    await services?.sessions.close().catch(() => {});
  }
}

function isActive(session: SessionSummary): boolean {
  const lastActivity = Date.parse(session.last_activity_at);
  return Number.isFinite(lastActivity) && Date.now() - lastActivity <= ACTIVE_FRAME_MAX_AGE_MS;
}

/**
 * A pointer, not a summary. It names the session and where it was, and leaves
 * the content to `xtctx_session_detail` — the raw transcript stays the
 * authority, and nothing here is derived from more than one field.
 */
function activeFrame(session: SessionSummary): string[] {
  // The branch is not read from the local repo — the scrapers lift it out of
  // the transcript (`obj.gitBranch`, `git.branch`, `context.branch`) and the
  // helpers around those reads only type-check the value. So it is untrusted
  // text on exactly the same footing as the preview below, and it lands in
  // the next agent's context window: a newline in it can forge a heading.
  const branch = session.git_branch
    ? ` on ${inlineSafe(session.git_branch).slice(0, BRANCH_CHARS)}${
        session.git_commit ? ` @ ${inlineSafe(session.git_commit).slice(0, 8)}` : ""
      }`
    : "";

  const lines = [
    "## Active context",
    "",
    `- Session: \`${session.session_ref}\` (${session.tool}${branch})`,
    `- Last activity: ${session.last_activity_at}`,
    `- Messages: ${session.message_count}`,
  ];

  if (session.preview) {
    // Single line: this is untrusted transcript text going into a context
    // window, and content that cannot start a line cannot forge structure.
    lines.push(`- Opened with: ${inlineSafe(session.preview).slice(0, PREVIEW_CHARS)}`);
  }

  lines.push(
    "",
    `Call \`xtctx_session_detail session_ref="${session.session_ref}"\` for the full turn history.`,
    "",
  );

  return lines;
}

/**
 * The banner is untrusted transcript text printed straight to the host's
 * console. `\s` does not match ESC or BEL, so collapsing whitespace alone left
 * escape sequences intact — enough for a poisoned transcript to clear the
 * screen or forge output. Control characters become spaces, so text either
 * side of one cannot be joined into a word nobody wrote.
 */
function inlineSafe(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    const isFormatting = code === 0x09 || code === 0x0a || code === 0x0d;
    out += (code < 0x20 && !isFormatting) || code === 0x7f ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim();
}
