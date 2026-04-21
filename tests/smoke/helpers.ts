/**
 * Helpers for the cross-tool-pickup smoke tests.
 *
 * Every helper in here is designed to exercise the *real* xtctx pipeline:
 *  - CLI commands are executed via `node dist/src/cli/index.js`
 *  - MCP queries go through a live `xtctx serve --mcp-only` stdio subprocess
 *    speaking JSON-RPC 2.0 (no in-process handler imports)
 *  - Scraper fixtures are written in each scraper's *native* storage format
 *    (real SQLite DBs, real JSONL event streams, real JSON session files).
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// `better-sqlite3` is already a project dep.
// eslint-disable-next-line @typescript-eslint/no-var-requires
type BetterSqlite3 = typeof import("better-sqlite3");
const Database: BetterSqlite3 = require("better-sqlite3");

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const REPO_ROOT = resolve(__dirname, "..", "..");
export const CLI_ENTRY = join(REPO_ROOT, "dist", "src", "cli", "index.js");

// ---------------------------------------------------------------------------
// CLI subprocess helpers
// ---------------------------------------------------------------------------

export interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the built xtctx CLI with the given args.
 * Captures stdout+stderr and returns once the process exits.
 */
export async function spawnCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<SpawnResult> {
  const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
    env,
    cwd: opts.cwd ?? REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const timeout = opts.timeoutMs ?? 120_000;
  const killer = setTimeout(() => {
    child.kill("SIGKILL");
  }, timeout).unref();

  const code = await new Promise<number | null>((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("exit", (exitCode) => resolvePromise(exitCode));
  });
  clearTimeout(killer);

  return { code, stdout, stderr };
}

// ---------------------------------------------------------------------------
// JSON-RPC helpers for talking to xtctx serve --mcp-only
// ---------------------------------------------------------------------------

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Spawn `xtctx serve --mcp-only`, perform the MCP handshake, call one tool,
 * then gracefully terminate the child. Returns the parsed tool-call result.
 *
 * Communication is framed as newline-delimited JSON-RPC 2.0 over stdio,
 * which is what `StdioServerTransport` in @modelcontextprotocol/sdk expects.
 */
export async function mcpCall(
  projectDir: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Promise<{ content: Array<{ type: string; text: string }>; structuredContent?: unknown; isError?: boolean }> {
  const child = spawn(
    process.execPath,
    [CLI_ENTRY, "serve", "--mcp-only", "--project", projectDir],
    {
      env,
      cwd: REPO_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  // Buffer stderr for debugging on failure.
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const pending = new Map<number, (resp: JsonRpcResponse) => void>();
  let lineBuffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    lineBuffer += chunk;
    let nl: number;
    while ((nl = lineBuffer.indexOf("\n")) >= 0) {
      const line = lineBuffer.slice(0, nl).trim();
      lineBuffer = lineBuffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        if (typeof msg.id === "number" && pending.has(msg.id)) {
          const resolver = pending.get(msg.id);
          pending.delete(msg.id);
          resolver?.(msg);
        }
      } catch {
        // Not JSON — ignore (the MCP stdio transport should never emit these,
        // but extra console.log from the child would trip us up otherwise).
      }
    }
  });

  const send = (msg: Record<string, unknown>): void => {
    child.stdin.write(JSON.stringify(msg) + "\n");
  };

  const rpc = async (
    id: number,
    method: string,
    params: Record<string, unknown>,
  ): Promise<JsonRpcResponse> => {
    return new Promise<JsonRpcResponse>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectPromise(
          new Error(
            `MCP RPC '${method}' (id=${id}) timed out after 60s.\nServer stderr:\n${stderr}`,
          ),
        );
      }, 60_000);
      pending.set(id, (resp) => {
        clearTimeout(timer);
        resolvePromise(resp);
      });
      send({ jsonrpc: "2.0", id, method, params });
    });
  };

  try {
    // 1. initialize
    const initResp = await rpc(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "xtctx-smoke", version: "0.0.0" },
    });
    if (initResp.error) {
      throw new Error(`initialize failed: ${initResp.error.message}`);
    }

    // 2. initialized notification (no response expected)
    send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

    // 3. tools/call
    const callResp = await rpc(2, "tools/call", {
      name: toolName,
      arguments: toolArgs,
    });
    if (callResp.error) {
      throw new Error(`tools/call '${toolName}' failed: ${callResp.error.message}`);
    }

    return callResp.result as {
      content: Array<{ type: string; text: string }>;
      structuredContent?: unknown;
      isError?: boolean;
    };
  } finally {
    await terminate(child);
  }
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  try {
    child.stdin?.end();
  } catch {
    // ignore
  }
  const settled = new Promise<void>((resolvePromise) => {
    child.once("exit", () => resolvePromise());
  });
  // Give the child 1s to exit cleanly before forcing it.
  const forceKill = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }, 1000).unref();
  await settled;
  clearTimeout(forceKill);
}

// ---------------------------------------------------------------------------
// Sandbox environment
// ---------------------------------------------------------------------------

/**
 * Build a child-process env that points every HOME-ish variable at `fakeHome`
 * so scrapers discover test fixtures, not real user data.
 */
export function sandboxEnv(fakeHome: string): NodeJS.ProcessEnv {
  // Clone the current env so PATH, SystemRoot, etc. are preserved.
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.HOME = fakeHome;
  env.USERPROFILE = fakeHome;
  env.APPDATA = join(fakeHome, "AppData", "Roaming");
  env.LOCALAPPDATA = join(fakeHome, "AppData", "Local");
  env.XDG_CONFIG_HOME = join(fakeHome, ".config");
  env.XDG_DATA_HOME = join(fakeHome, ".local", "share");
  // Force the transformers cache to live under the repo node_modules so it's
  // shared across test runs and not re-downloaded per test. (This path is the
  // library default — we just make it explicit so sandboxed HOME doesn't
  // accidentally break it.)
  env.TRANSFORMERS_CACHE = join(
    REPO_ROOT,
    "node_modules",
    "@xenova",
    "transformers",
    ".cache",
  );
  return env;
}

// ---------------------------------------------------------------------------
// Per-tool storage writers (real, native formats — no shortcuts)
// ---------------------------------------------------------------------------

export interface SeedMessage {
  role: "user" | "assistant";
  content: string;
  /** ISO string; if omitted, auto-generated with monotonic offsets. */
  timestamp?: string;
}

/**
 * Claude Code stores JSONL session files at:
 *   ~/.claude/projects/<project-hash>/<sessionId>.jsonl
 * Each line is a JSON object with `type` ∈ {human, assistant, ...},
 * `content`, and `timestamp`. See src/scrapers/claude-code.ts.
 */
export async function seedClaudeCode(
  fakeHome: string,
  projectHash: string,
  sessionId: string,
  messages: SeedMessage[],
  startMs = Date.now() - 60_000,
): Promise<void> {
  const dir = join(fakeHome, ".claude", "projects", projectHash);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${sessionId}.jsonl`);
  const lines = messages.map((m, i) => {
    const ts = m.timestamp ?? new Date(startMs + i * 1000).toISOString();
    return JSON.stringify({
      type: m.role === "user" ? "human" : "assistant",
      content: m.content,
      timestamp: ts,
    });
  });
  await writeFile(file, lines.join("\n") + "\n", "utf-8");
}

/** Append extra messages to an existing Claude Code session (for incremental test). */
export async function appendClaudeCode(
  fakeHome: string,
  projectHash: string,
  sessionId: string,
  messages: SeedMessage[],
  startMs: number,
): Promise<void> {
  const { appendFile } = await import("node:fs/promises");
  const file = join(fakeHome, ".claude", "projects", projectHash, `${sessionId}.jsonl`);
  const lines = messages.map((m, i) => {
    const ts = m.timestamp ?? new Date(startMs + i * 1000).toISOString();
    return JSON.stringify({
      type: m.role === "user" ? "human" : "assistant",
      content: m.content,
      timestamp: ts,
    });
  });
  await appendFile(file, lines.join("\n") + "\n", "utf-8");
}

/**
 * Cursor stores two SQLite DBs:
 *  - Workspace:  <storePath>/<hash>/state.vscdb
 *    ItemTable(key='composer.composerData', value=JSON { allComposers: [...] })
 *  - Global:     <storePath>/../globalStorage/state.vscdb
 *    cursorDiskKV(key, value) where key is
 *      `composerData:<composerId>` (JSON with fullConversationHeadersOnly)
 *      `bubbleId:<composerId>:<bubbleId>` (JSON with type/text/createdAt)
 *
 * Scraper source: src/scrapers/cursor.ts.
 * The scraper derives the global DB path from the workspace DB path by
 * replacing `/workspaceStorage/<hash>/` with `/globalStorage/`.
 */
export async function seedCursor(
  fakeHome: string,
  composerId: string,
  messages: SeedMessage[],
  startMs = Date.now() - 60_000,
): Promise<void> {
  // Emulate the Windows-style path the default resolver produces.
  const appData = join(fakeHome, "AppData", "Roaming");
  const userDir = join(appData, "Cursor", "User");
  const workspaceDir = join(userDir, "workspaceStorage", "testws");
  const globalDir = join(userDir, "globalStorage");
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(globalDir, { recursive: true });

  const workspaceDbPath = join(workspaceDir, "state.vscdb");
  const globalDbPath = join(globalDir, "state.vscdb");

  // Workspace DB: ItemTable with composer.composerData
  const wsDb = new Database(workspaceDbPath);
  wsDb.exec(`CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value TEXT);`);
  const composerData = {
    allComposers: [
      { composerId, unifiedMode: "agent" },
    ],
  };
  wsDb.prepare("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)").run(
    "composer.composerData",
    JSON.stringify(composerData),
  );
  wsDb.close();

  // Global DB: cursorDiskKV with composerData + bubbles.
  const globalDb = new Database(globalDbPath);
  globalDb.exec(`CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);`);
  const insert = globalDb.prepare(
    "INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)",
  );

  const headers = messages.map((_m, i) => ({
    bubbleId: `bubble-${composerId}-${i}`,
    type: 1,
  }));
  insert.run(
    `composerData:${composerId}`,
    JSON.stringify({
      composerId,
      fullConversationHeadersOnly: headers,
      unifiedMode: "agent",
      modelConfig: { modelName: "claude-3.5-sonnet" },
    }),
  );

  for (const [i, m] of messages.entries()) {
    const createdAt = m.timestamp
      ? Date.parse(m.timestamp)
      : startMs + i * 1000;
    insert.run(
      `bubbleId:${composerId}:bubble-${composerId}-${i}`,
      JSON.stringify({
        type: m.role === "user" ? 1 : 2,
        text: m.content,
        createdAt,
      }),
    );
  }
  globalDb.close();
}

/**
 * Copilot (VS Code chat) stores a single SQLite DB. VS Code uses
 * platform-specific workspaceStorage roots, and the scraper resolves them
 * with `process.platform` (win32 → APPDATA, linux → ~/.config, else →
 * ~/Library/Application Support). Seed at the correct root for this host so
 * the scraper actually finds the fixture on both Windows devs and Linux CI.
 *
 * Scraper source: src/scrapers/copilot.ts; default-path logic in
 * src/runtime/ingestion.ts::defaultCopilotHistoryPath.
 */
function copilotWorkspaceRoot(fakeHome: string): string {
  if (process.platform === "win32") {
    return join(fakeHome, "AppData", "Roaming", "Code", "User", "workspaceStorage");
  }
  if (process.platform === "linux") {
    return join(fakeHome, ".config", "Code", "User", "workspaceStorage");
  }
  return join(fakeHome, "Library", "Application Support", "Code", "User", "workspaceStorage");
}

export async function seedCopilot(
  fakeHome: string,
  sessionId: string,
  turns: Array<{ user: string; assistant: string }>,
  creationDate = Date.now() - 60_000,
): Promise<void> {
  const dbDir = join(copilotWorkspaceRoot(fakeHome), "copilotws");
  await mkdir(dbDir, { recursive: true });
  const dbPath = join(dbDir, "state.vscdb");

  const db = new Database(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value TEXT);`);
  const sessions = {
    [sessionId]: {
      sessionId,
      creationDate,
      requests: turns.map((t) => ({
        message: { parts: [{ text: t.user }] },
        response: [{ value: t.assistant }],
        model: "gpt-4.1",
        agentId: "copilot",
      })),
    },
  };
  db.prepare("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)").run(
    "interactive.sessions",
    JSON.stringify(sessions),
  );
  db.close();
}

/**
 * Codex stores JSONL event-stream session files at:
 *   ~/.codex/sessions/YYYY/MM/DD/session-<id>.jsonl
 * See src/scrapers/codex.ts for the event type set.
 *
 * We emit: session_meta, turn_context, then alternating event_msg (user)
 * and response_item (assistant) events.
 */
export async function seedCodex(
  fakeHome: string,
  sessionId: string,
  messages: SeedMessage[],
  startMs = Date.now() - 60_000,
): Promise<void> {
  const now = new Date(startMs);
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const dir = join(fakeHome, ".codex", "sessions", year, month, day);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `session-${sessionId}.jsonl`);

  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      type: "session_meta",
      payload: { id: sessionId },
      timestamp: new Date(startMs).toISOString(),
    }),
  );
  lines.push(
    JSON.stringify({
      type: "turn_context",
      payload: { approval_policy: "suggest", sandbox_policy: { type: "workspace-write" } },
      timestamp: new Date(startMs).toISOString(),
    }),
  );

  for (const [i, m] of messages.entries()) {
    const ts = m.timestamp ?? new Date(startMs + (i + 1) * 1000).toISOString();
    if (m.role === "user") {
      lines.push(
        JSON.stringify({
          type: "event_msg",
          payload: { type: "user_message", message: m.content },
          timestamp: ts,
        }),
      );
    } else {
      lines.push(
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: m.content }],
          },
          timestamp: ts,
        }),
      );
    }
  }

  await writeFile(file, lines.join("\n") + "\n", "utf-8");
}

/**
 * Gemini CLI stores session files at:
 *   ~/.gemini/tmp/<project>/chats/session-<id>.json
 * Shape: { sessionId, messages: [{ type: "user"|"gemini", content: [{text}], timestamp }] }.
 *
 * Scraper source: src/scrapers/gemini.ts.
 */
export async function seedGemini(
  fakeHome: string,
  sessionId: string,
  messages: SeedMessage[],
  startMs = Date.now() - 60_000,
): Promise<void> {
  const dir = join(fakeHome, ".gemini", "tmp", "testproj", "chats");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `session-${sessionId}.json`);

  const payload = {
    sessionId,
    messages: messages.map((m, i) => ({
      type: m.role === "user" ? "user" : "gemini",
      content: [{ text: m.content }],
      timestamp: m.timestamp ?? new Date(startMs + i * 1000).toISOString(),
      model: "gemini-2.0-flash",
    })),
  };
  await writeFile(file, JSON.stringify(payload, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Response extraction utilities
// ---------------------------------------------------------------------------

export interface SearchHitMetadata {
  source_tool?: string;
  source_session?: string;
  role?: string;
  timestamp?: string;
}

export interface SearchHit {
  id: string;
  text: string;
  score: number;
  fusedScore?: number;
  metadata: SearchHitMetadata;
}

/**
 * Extract typed search hits from an `xtctx_search` tool-call response
 * (format: "json"). The MCP server returns the raw handler result as
 * structuredContent and also JSON-stringifies it into content[0].text.
 */
export function parseSearchResponse(
  response: { content: Array<{ type: string; text: string }>; structuredContent?: unknown },
): SearchHit[] {
  const text = response.content[0]?.text ?? "";
  const parsed = JSON.parse(text) as { results: Array<{ id: string; text: string; score: number; fusedScore?: number; metadata: string }> };
  return (parsed.results ?? []).map((r) => ({
    id: r.id,
    text: r.text,
    score: r.score,
    fusedScore: r.fusedScore,
    metadata: safeJson(r.metadata),
  }));
}

function safeJson(raw: string | undefined): SearchHitMetadata {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as SearchHitMetadata;
  } catch {
    return {};
  }
}
