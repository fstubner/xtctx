import { createProjectServices } from "../runtime/services.js";
import type { SessionSummary } from "../handoff/types.js";
import { dirname, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

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
    const payload = await readHookPayload();
    services = await createProjectServices(options.projectPath ?? payload.cwd);

    // Record it rather than only using it here. This hook deliberately does a
    // no-scan read of the existing index — scraping happens later, in the MCP
    // server, a different process that never receives a hook payload. Writing
    // it down is what carries the tool's own answer across that gap.
    await rememberStoreDirs(services.projectRoot, payload.storeDirs);
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
    `- Session: \`${inlineSafe(session.session_ref)}\` (${inlineSafe(session.tool)}${branch})`,
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
    `Call \`xtctx_session_detail session_ref="${inlineSafe(session.session_ref)}"\` for the full turn history.`,
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

/** What a host tool tells its hook about the session it is starting. */
interface HookPayload {
  cwd?: string;
  storeDirs: Record<string, string | undefined>;
}

/**
 * Read the JSON a host tool writes to the hook's stdin.
 *
 * Claude Code passes documented fields including `transcript_path` and `cwd`.
 * `transcript_path` resolves to `<store>/<project>/<session-id>.jsonl`, so its
 * directory is the project's store directory as stated by the tool — which is
 * strictly better than reconstructing it, because the reconstruction
 * re-implements a lossy path encoding (`:`, `\` and `/` all become `-`) and is
 * defeated entirely by `CLAUDE_CONFIG_DIR` moving the tree.
 *
 * Everything here is best-effort. The hook is also run by hand, by tools that
 * send nothing, and by tools that send a different shape; none of those may
 * turn into a startup error, so an absent or unparseable payload simply means
 * the scrapers reconstruct as they always did.
 */
async function readHookPayload(): Promise<HookPayload> {
  const empty: HookPayload = { storeDirs: {} };

  // A TTY means no piped payload and reading would block on the user.
  if (process.stdin.isTTY) {
    return empty;
  }

  try {
    const raw = await readStdinWithin(HOOK_STDIN_TIMEOUT_MS);
    if (!raw.trim()) {
      return empty;
    }

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const transcriptPath =
      typeof parsed.transcript_path === "string" && parsed.transcript_path.length > 0
        ? parsed.transcript_path
        : null;

    return {
      cwd: typeof parsed.cwd === "string" && parsed.cwd.length > 0 ? parsed.cwd : undefined,
      // Only Claude Code documents this field; a tool that sends something
      // else shaped like it would be attributing its own store, which is the
      // same claim and equally trustworthy.
      storeDirs: transcriptPath ? { "claude-code": dirname(transcriptPath) } : {},
    };
  } catch {
    return empty;
  }
}

/**
 * Bounded because the hook blocks the host's startup. A tool that opens stdin
 * without writing would otherwise hang the session it is announcing.
 */
const HOOK_STDIN_TIMEOUT_MS = 250;

function readStdinWithin(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    const done = (): void => {
      clearTimeout(timer);
      process.stdin.removeAllListeners("data");
      process.stdin.removeAllListeners("end");
      resolve(data);
    };
    const timer = setTimeout(done, timeoutMs);
    timer.unref?.();
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

/**
 * Where a tool said its transcripts live, remembered between processes.
 *
 * Merged rather than replaced: each hook invocation speaks for one tool, and
 * overwriting would drop what the others told us. Best-effort throughout —
 * this is an optimisation over reconstructing the path, so failing to record
 * it costs accuracy in edge cases, never the session that is starting.
 */
export const STORE_DIRS_FILE = "store-dirs.json";

async function rememberStoreDirs(
  projectRoot: string,
  storeDirs: Record<string, string | undefined>,
): Promise<void> {
  const entries = Object.entries(storeDirs).filter(([, dir]) => Boolean(dir));
  if (entries.length === 0) {
    return;
  }

  const path = join(projectRoot, ".xtctx", "state", STORE_DIRS_FILE);
  try {
    const existing = await readFile(path, "utf-8")
      .then((raw) => JSON.parse(raw) as Record<string, string>)
      .catch(() => ({}) as Record<string, string>);

    const merged = { ...existing, ...Object.fromEntries(entries) };
    if (JSON.stringify(merged) === JSON.stringify(existing)) {
      return;
    }

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
  } catch {
    // See the docstring: never fail the session over a cache write.
  }
}
