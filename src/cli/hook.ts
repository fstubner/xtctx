import { createProjectServices } from "../runtime/services.js";
import type { ProjectConfig } from "../runtime/services.js";
import type { SessionSummary } from "../handoff/types.js";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "../utils/atomic-file.js";
import { inlineSafe } from "../utils/untrusted-text.js";
import { pathMatchesProject } from "../utils/project-scope.js";

export interface HookOptions {
  projectPath?: string;
  tool?: string;
  event?: string;
  /**
   * How a background scan is started. Tests pass a recorder; everything else
   * forks the CLI's `scan` command detached, see `launchDetachedScan`.
   */
  launchScan?: (projectRoot: string) => void;
}

/**
 * How recently a scan must have finished for the hook not to start another.
 *
 * The hook reads without scanning, so the index it reads is only as fresh as
 * the last MCP call — and the first session after another tool's work has
 * had none. Measured live: Codex left a decision in its transcript, Claude
 * Code opened next, and the hook printed "Last scan: never" and nothing else.
 * One call later the same hook named the Codex session and the agent read it
 * unprompted. A scan started here, in the background, turns the first case
 * into the second for the session after this one.
 *
 * Not every start, though: a scan walks every transcript store on the machine
 * (about 20s against a 19GB Codex store, measured), and one that finished a
 * minute ago has nothing new to find.
 */
export const HOOK_SCAN_MIN_INTERVAL_MS = 5 * 60 * 1000;

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

    // Where the host actually started us. Claude Code runs hooks with cwd set
    // to the project root, so this is the OS's answer rather than the
    // payload's claim, and it is the only independent witness available here.
    const hostRoot = options.projectPath ?? process.cwd();

    // The payload never chooses the project. It used to, and every version of
    // the guard around that was wrong in a different way: first it compared
    // `payload.cwd` against a root derived from `payload.cwd` (a value
    // compared with itself, which cannot reject), then it accepted any path
    // that *contained* the host's — so naming a parent still relocated the
    // hook, to a home directory or a monorepo root, creating an unrequested
    // index there.
    //
    // The subdirectory case that branch existed for is hypothetical: hosts run
    // the hook with cwd at the project root. So the host's cwd decides, full
    // stop, and the payload is used for one thing only — see below.
    services = await createProjectServices(hostRoot);

    // What the payload is still good for: `transcript_path` is the tool's own
    // answer for where its transcripts live, which beats re-deriving a lossy
    // path encoding. It is trusted only when the payload is describing this
    // project or something inside it.
    //
    // Both sides resolved first. `process.cwd()` is reported canonically by
    // the OS while the payload carries whatever the host wrote, and on macOS a
    // temp or home directory is routinely a symlink (`/var` -> `/private/var`)
    // — so comparing them lexically rejected the legitimate payload this
    // exists to accept. An absent `cwd` fails closed.
    const payloadRoot = payload.cwd === undefined ? undefined : await canonical(payload.cwd);
    const payloadIsForThisProject =
      payloadRoot !== undefined && pathMatchesProject(payloadRoot, await canonical(hostRoot));

    // Record it rather than only using it here. This hook deliberately does a
    // no-scan read of the existing index — scraping happens later, in the MCP
    // server, a different process that never receives a hook payload. Writing
    // it down is what carries the tool's own answer across that gap.
    if (payloadIsForThisProject) {
      await rememberStoreDirs(services.projectRoot, payload.storeDirs);
    }
    const status = await services.sessions.getStatus();
    const tool = options.tool ?? "unknown";

    // Started, not awaited: this must not add the scan to the host's startup.
    // Gated on the project having opted in, exactly as the MCP server gates
    // its own scan — two clients wire xtctx machine-globally, so this hook
    // can run in any directory, and a scan writes an index.
    if (shouldLaunchScan(services.config, status.last_scan_at)) {
      (options.launchScan ?? launchDetachedScan)(services.projectRoot);
    }

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

function shouldLaunchScan(config: ProjectConfig, lastScanAt: string | null): boolean {
  if (!config.present || config.error) {
    return false;
  }
  if (lastScanAt === null) {
    return true;
  }
  const finished = Date.parse(lastScanAt);
  return !Number.isFinite(finished) || Date.now() - finished > HOOK_SCAN_MIN_INTERVAL_MS;
}

/**
 * Fork `xtctx scan --project <root>` and let go of it.
 *
 * Detached with no stdio, so the hook's own exit — which the host is waiting
 * on — does not wait for the scan, and the scan does not die with the hook.
 * The entry point is resolved from this module rather than `process.argv[1]`:
 * the hook is also run in-process, where argv names the test runner.
 *
 * `XTCTX_NO_HOOK_SCAN=1` switches it off. That exists for the smoke tests
 * that run the built hook in a temp directory they then delete — a detached
 * scan still writing there is a flake, not a finding.
 */
function launchDetachedScan(projectRoot: string): void {
  if (process.env.XTCTX_NO_HOOK_SCAN === "1") {
    return;
  }
  const entry = fileURLToPath(new URL("./index.js", import.meta.url));
  const child = spawn(process.execPath, [entry, "scan", "--project", projectRoot], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  // A launch that fails must not fail the hook, and an 'error' with no
  // listener would take the process down.
  child.on("error", () => {});
  child.unref();
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
 * Resolve through symlinks, falling back to the path as given.
 *
 * Comparing a resolved path with an unresolved one is the bug this exists to
 * prevent: it reads as a mismatch between two names for one directory.
 */
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
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

    // Atomic, and contained: this was a plain `writeFile` straight at a
    // predictable path, so a `.xtctx/state` symlinked out of the project — or
    // a file pre-planted at the target — redirected the write. The path is
    // derived from the project root, and a cloned repo chooses what its own
    // directories are, so containment is the check that matters.
    await writeFileAtomic(path, `${JSON.stringify(merged, null, 2)}\n`, {
      containWithin: projectRoot,
    });
  } catch {
    // See the docstring: never fail the session over a cache write.
  }
}
