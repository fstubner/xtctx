#!/usr/bin/env node
/**
 * drift-canary.mjs — runs a real AI CLI tool against a scripted prompt, lets it
 * write its actual on-disk storage, then runs xtctx's scraper against that
 * storage and asserts the scraper still returns usable output.
 *
 * This is the only test that catches *upstream* drift: when Claude Code,
 * Codex CLI, or Gemini CLI changes its storage format, synthetic fixtures stay
 * "correct" but this canary will fail.
 *
 * Usage:
 *   node scripts/drift-canary.mjs --tool <claude-code|codex|gemini>
 *   node scripts/drift-canary.mjs --help
 *
 * Env:
 *   ANTHROPIC_API_KEY   required for --tool claude-code
 *   OPENAI_API_KEY      required for --tool codex
 *   GEMINI_API_KEY      required for --tool gemini
 *
 * Exits 0 on success with a one-line summary; exits 1 on any failure with
 * details written to stderr.
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// -----------------------------------------------------------------------------
// CLI argument parsing
// -----------------------------------------------------------------------------

const HELP_TEXT = `drift-canary — verify xtctx scrapers against real AI CLI tools

Usage:
  node scripts/drift-canary.mjs --tool <name> [--keep-temp]
  node scripts/drift-canary.mjs --help

Tools:
  claude-code   Anthropic Claude Code CLI   (needs ANTHROPIC_API_KEY)
  codex         OpenAI Codex CLI            (needs OPENAI_API_KEY)
  gemini        Google Gemini CLI           (needs GEMINI_API_KEY)

Options:
  --tool <name>     Which tool to exercise. Required.
  --keep-temp       Do not delete the sandboxed HOME on exit (for debugging).
  --timeout-ms <n>  Override the per-tool invocation timeout (default 120000).
  --help            Show this text.

Exit codes:
  0  scraper produced at least one user chunk and one assistant chunk.
  1  anything else — missing credentials, tool not installed, tool crashed,
     scraper produced empty / malformed output, etc.
`;

function parseArgs(argv) {
  const args = { tool: null, keepTemp: false, timeoutMs: 120_000, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--tool") args.tool = argv[++i];
    else if (a === "--keep-temp") args.keepTemp = true;
    else if (a === "--timeout-ms") args.timeoutMs = Number(argv[++i]);
    else {
      console.error(`drift-canary: unknown argument: ${a}`);
      console.error("use --help for usage");
      process.exit(2);
    }
  }
  return args;
}

// -----------------------------------------------------------------------------
// Shared helpers
// -----------------------------------------------------------------------------

const PROMPT = "What is 17 * 23? Explain your reasoning in one sentence.";

/**
 * Spawn a child process, capture stdout+stderr, reject on non-zero exit or
 * timeout. Inherits env + a supplemental env overlay.
 */
export function runCommand(cmd, args, { env = {}, timeoutMs = 120_000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...env },
      cwd,
      shell: process.platform === "win32",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timeout after ${timeoutMs}ms running ${cmd} ${args.join(" ")}`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const err = new Error(
          `${cmd} ${args.join(" ")} exited ${code}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
        );
        err.stdout = stdout;
        err.stderr = stderr;
        err.code = code;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function probeCommand(cmd) {
  try {
    await runCommand(cmd, ["--version"], { timeoutMs: 15_000 });
    return true;
  } catch {
    // Some CLIs don't support --version; try --help as a fallback.
    try {
      await runCommand(cmd, ["--help"], { timeoutMs: 15_000 });
      return true;
    } catch {
      return false;
    }
  }
}

function pathExists(p) {
  return stat(p).then(
    () => true,
    () => false,
  );
}

// -----------------------------------------------------------------------------
// Tool invocations
//
// Each strategy is async ({sandboxHome, prompt, timeoutMs}) => { sessionPath,
// invocationMs }. It:
//   (a) probes whether the tool is installed, throwing a clear error if not,
//   (b) invokes the tool with the scripted prompt against sandboxHome,
//   (c) returns where the tool wrote its on-disk session for this run.
// -----------------------------------------------------------------------------

/**
 * Claude Code — `@anthropic-ai/claude-code`
 *
 * Install (Ubuntu):
 *   npm i -g @anthropic-ai/claude-code
 *
 * Headless invocation uses `--print` (or `-p`) to run a single prompt and
 * exit, streaming the response to stdout. Session files land in
 * `$HOME/.claude/projects/<project-hash>/<session-id>.jsonl`.
 *
 * If the `--print` flag no longer exists in a future release, we fail loudly
 * rather than papering over drift — this canary's whole point is to notice.
 */
export async function invokeClaudeCode({ sandboxHome, prompt, timeoutMs }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set — export it to run the claude-code canary.",
    );
  }
  if (!(await probeCommand("claude"))) {
    throw new Error(
      "claude CLI not found on PATH. Install with: npm i -g @anthropic-ai/claude-code",
    );
  }

  // Read --help at runtime and assert --print still exists. If it doesn't,
  // the tool has drifted and the canary's assumed invocation is wrong — that
  // is exactly the signal we want.
  const { stdout: help } = await runCommand("claude", ["--help"], { timeoutMs: 15_000 });
  if (!/--print\b|-p\b/.test(help)) {
    throw new Error(
      "claude CLI --help no longer advertises --print/-p; invocation flag has drifted. " +
        "Check recent claude-code releases and update scripts/drift-canary.mjs.",
    );
  }

  const start = Date.now();
  await runCommand("claude", ["--print", prompt], {
    env: { HOME: sandboxHome, USERPROFILE: sandboxHome },
    timeoutMs,
    cwd: sandboxHome,
  });
  const invocationMs = Date.now() - start;

  const projectsDir = join(sandboxHome, ".claude", "projects");
  if (!(await pathExists(projectsDir))) {
    throw new Error(
      `claude ran but did not create ${projectsDir} — session-storage layout may have drifted.`,
    );
  }
  return { sessionPath: projectsDir, invocationMs };
}

/**
 * Codex CLI — `@openai/codex`
 *
 * Install (Ubuntu):
 *   npm i -g @openai/codex
 *   # or via cargo: cargo install codex-cli
 *
 * Non-interactive invocation uses `codex exec "<prompt>"` which runs a single
 * turn headless. Sessions land in `$HOME/.codex/sessions/YYYY/MM/DD/*.jsonl`.
 */
export async function invokeCodex({ sandboxHome, prompt, timeoutMs }) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY is not set — export it to run the codex canary.",
    );
  }
  if (!(await probeCommand("codex"))) {
    throw new Error(
      "codex CLI not found on PATH. Install with: npm i -g @openai/codex",
    );
  }

  const { stdout: help } = await runCommand("codex", ["--help"], { timeoutMs: 15_000 });
  if (!/\bexec\b/.test(help)) {
    throw new Error(
      "codex CLI --help no longer advertises an `exec` subcommand; invocation has drifted. " +
        "Check recent @openai/codex releases and update scripts/drift-canary.mjs.",
    );
  }

  const start = Date.now();
  await runCommand("codex", ["exec", prompt], {
    env: { HOME: sandboxHome, USERPROFILE: sandboxHome },
    timeoutMs,
    cwd: sandboxHome,
  });
  const invocationMs = Date.now() - start;

  const sessionsDir = join(sandboxHome, ".codex", "sessions");
  if (!(await pathExists(sessionsDir))) {
    throw new Error(
      `codex ran but did not create ${sessionsDir} — session-storage layout may have drifted.`,
    );
  }
  return { sessionPath: sessionsDir, invocationMs };
}

/**
 * Gemini CLI — `@google/gemini-cli`
 *
 * Install (Ubuntu):
 *   npm i -g @google/gemini-cli
 *
 * Non-interactive invocation uses `gemini -p "<prompt>"` which prints the
 * response and exits. Chat sessions are persisted under
 * `$HOME/.gemini/tmp/<project-hash>/chats/session-*.json`.
 */
export async function invokeGemini({ sandboxHome, prompt, timeoutMs }) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error(
      "GEMINI_API_KEY is not set — export it to run the gemini canary.",
    );
  }
  if (!(await probeCommand("gemini"))) {
    throw new Error(
      "gemini CLI not found on PATH. Install with: npm i -g @google/gemini-cli",
    );
  }

  const { stdout: help } = await runCommand("gemini", ["--help"], { timeoutMs: 15_000 });
  if (!/-p\b|--prompt\b/.test(help)) {
    throw new Error(
      "gemini CLI --help no longer advertises -p/--prompt; invocation flag has drifted. " +
        "Check recent @google/gemini-cli releases and update scripts/drift-canary.mjs.",
    );
  }

  const start = Date.now();
  await runCommand("gemini", ["-p", prompt], {
    env: { HOME: sandboxHome, USERPROFILE: sandboxHome },
    timeoutMs,
    cwd: sandboxHome,
  });
  const invocationMs = Date.now() - start;

  const historyDir = join(sandboxHome, ".gemini", "tmp");
  if (!(await pathExists(historyDir))) {
    throw new Error(
      `gemini ran but did not create ${historyDir} — session-storage layout may have drifted.`,
    );
  }
  return { sessionPath: historyDir, invocationMs };
}

// -----------------------------------------------------------------------------
// Scraper dispatch
// -----------------------------------------------------------------------------

/**
 * Dynamically import the scraper for a given tool. We import from the built
 * dist/ — callers are expected to `npm run build` before running the canary.
 * Falls back to tsx-compiled src imports if dist is absent and tsx is in path.
 */
export async function loadScrapers({ distRoot }) {
  const tryLoad = async (relPath) => {
    const fileUrl = pathToFileURL(join(distRoot, relPath)).href;
    return import(fileUrl);
  };

  const claude = await tryLoad("dist/src/scrapers/claude-code.js");
  const codex = await tryLoad("dist/src/scrapers/codex.js");
  const gemini = await tryLoad("dist/src/scrapers/gemini.js");

  return {
    "claude-code": (sessionPath, stateDir) =>
      new claude.ClaudeCodeScraper(sessionPath, stateDir),
    codex: (sessionPath, stateDir) => new codex.CodexCliScraper(sessionPath, stateDir),
    gemini: (sessionPath, stateDir) => new gemini.GeminiCliScraper(sessionPath, stateDir),
  };
}

// -----------------------------------------------------------------------------
// Core orchestrator — dependency-injected so tests can exercise it without
// hitting real APIs. `deps.invokers` and `deps.scraperFactories` are the two
// seams: the test mocks both, the real CLI wires up runtime values.
// -----------------------------------------------------------------------------

export async function runCanary({
  tool,
  invokers,
  scraperFactories,
  prompt = PROMPT,
  timeoutMs = 120_000,
  sandboxHome,
  stateDir,
  now = () => new Date(),
}) {
  const invoker = invokers[tool];
  if (!invoker) {
    throw new Error(`unknown tool: ${tool} (known: ${Object.keys(invokers).join(", ")})`);
  }
  const factory = scraperFactories[tool];
  if (!factory) {
    throw new Error(`no scraper factory registered for tool: ${tool}`);
  }

  const { sessionPath, invocationMs } = await invoker({ sandboxHome, prompt, timeoutMs });

  const scraper = factory(sessionPath, stateDir);
  const chunks = [];
  for await (const chunk of scraper.fullSync()) {
    chunks.push(chunk);
  }

  const users = chunks.filter((c) => c.role === "user" && c.content?.trim().length > 0);
  const assistants = chunks.filter(
    (c) => c.role === "assistant" && c.content?.trim().length > 0,
  );

  const tenMinutesAgo = new Date(now().getTime() - 10 * 60_000);
  const recent = chunks.filter((c) => c.timestamp instanceof Date && c.timestamp >= tenMinutesAgo);

  const failures = [];
  if (users.length < 1) {
    failures.push(
      `expected ≥1 user chunk with non-empty content, got ${users.length} ` +
        `(roles seen: ${chunks.map((c) => c.role).join(",") || "none"})`,
    );
  }
  if (assistants.length < 1) {
    failures.push(
      `expected ≥1 assistant chunk with non-empty content, got ${assistants.length} ` +
        `(roles seen: ${chunks.map((c) => c.role).join(",") || "none"})`,
    );
  }
  if (recent.length < 1 && chunks.length > 0) {
    failures.push(
      `no chunk has a timestamp within the last 10 minutes; newest is ` +
        `${chunks.map((c) => c.timestamp).sort().at(-1)?.toISOString?.() ?? "unknown"}`,
    );
  }

  return {
    ok: failures.length === 0,
    failures,
    chunks,
    counts: { total: chunks.length, user: users.length, assistant: assistants.length },
    invocationMs,
    sessionPath,
  };
}

// -----------------------------------------------------------------------------
// Main — executed when invoked as a script, skipped when imported for tests.
// -----------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  if (!args.tool) {
    console.error("drift-canary: --tool is required. Try --help.");
    return 2;
  }

  const known = ["claude-code", "codex", "gemini"];
  if (!known.includes(args.tool)) {
    console.error(
      `drift-canary: unknown --tool ${args.tool}. Expected one of: ${known.join(", ")}`,
    );
    return 2;
  }

  const sandboxHome = await mkdtemp(join(tmpdir(), `xtctx-canary-${args.tool}-`));
  const stateDir = join(sandboxHome, ".xtctx-state");
  await mkdir(stateDir, { recursive: true });

  // Locate project root (the dir containing package.json) — when installed as
  // a dep you'd use the xtctx/scrapers export, but when running in-repo we
  // load straight out of dist/.
  const distRoot = new URL("..", import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1");
  const scraperFactories = await loadScrapers({ distRoot }).catch((err) => {
    console.error(
      "drift-canary: failed to load xtctx scrapers from dist/. " +
        "Did you run `npm run build` first?\n" +
        err.message,
    );
    process.exit(1);
  });

  const invokers = {
    "claude-code": invokeClaudeCode,
    codex: invokeCodex,
    gemini: invokeGemini,
  };

  try {
    const result = await runCanary({
      tool: args.tool,
      invokers,
      scraperFactories,
      timeoutMs: args.timeoutMs,
      sandboxHome,
      stateDir,
    });

    if (result.ok) {
      const latencySec = (result.invocationMs / 1000).toFixed(1);
      process.stdout.write(
        `[${args.tool}] OK ${result.counts.total} chunks scraped ` +
          `(${result.counts.user} user, ${result.counts.assistant} assistant), ` +
          `latency ${latencySec}s\n`,
      );
      return 0;
    }

    console.error(`[${args.tool}] FAIL`);
    for (const f of result.failures) console.error(`  - ${f}`);
    console.error(
      `session path: ${result.sessionPath}\n` +
        `total chunks: ${result.counts.total}\n` +
        `(set --keep-temp to inspect the sandboxed HOME at ${sandboxHome})`,
    );
    return 1;
  } catch (err) {
    console.error(`[${args.tool}] ERROR: ${err.message}`);
    if (err.stderr) console.error(`stderr:\n${err.stderr}`);
    console.error(
      `(set --keep-temp to inspect the sandboxed HOME at ${sandboxHome})`,
    );
    return 1;
  } finally {
    if (!args.keepTemp) {
      await rm(sandboxHome, { recursive: true, force: true }).catch(() => {});
    }
  }
}

// Only run main() when executed directly, not when imported by tests.
const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  main().then((code) => process.exit(code));
}
