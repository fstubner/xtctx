/**
 * Seeders that write each tool's *native* on-disk format.
 *
 * The point of these is that they are not shortcuts: real SQLite databases
 * with the real table shapes, real JSONL event streams, real artifact
 * directories, written to the exact paths the product computes for the host
 * platform. Unit tests hand a scraper a path it was told to read; this makes
 * the product find the data on its own, which is where the platform-shaped
 * bugs live.
 *
 * Adapted from the (unmerged) phase-3 smoke branch, rebuilt for the current
 * seven-tool lineup and the SQLite handoff index.
 */

import Database from "better-sqlite3";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  defaultAntigravityStorePath,
  defaultClaudeProjectsDir,
  defaultCodexSessionsPath,
  defaultCopilotCliSessionPath,
  defaultCopilotHistoryPath,
  defaultCursorStorePath,
  defaultOpenCodeStorePath,
} from "../../src/tools/sources.js";
import { encodePathForToolDirectory } from "../../src/utils/project-scope.js";

/** Environment that redirects every default store path into a sandbox. */
export function sandboxEnv(homeDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    APPDATA: join(homeDir, "AppData", "Roaming"),
    LOCALAPPDATA: join(homeDir, "AppData", "Local"),
    XDG_DATA_HOME: join(homeDir, ".local", "share"),
    XDG_CONFIG_HOME: join(homeDir, ".config"),
    // Keep the CLI from auto-starting an MCP server on a piped stdio pair.
    XTCTX_NO_AUTO_MCP: "1",
  };
}

/**
 * Resolve a tool's default store path *as the product would* under a sandbox
 * home. The default resolvers read process.env directly, so they are called
 * with the sandbox values swapped in and then restored.
 */
export function storePathUnderSandbox(
  tool: string,
  homeDir: string,
): string {
  const env = sandboxEnv(homeDir);
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    switch (tool) {
      case "claude-code":
        return defaultClaudeProjectsDir();
      case "codex":
        return defaultCodexSessionsPath();
      case "cursor":
        return defaultCursorStorePath();
      case "copilot":
        return defaultCopilotHistoryPath();
      case "antigravity":
        return defaultAntigravityStorePath();
      case "opencode":
        return defaultOpenCodeStorePath();
      case "copilot-cli":
        return defaultCopilotCliSessionPath();
      default:
        throw new Error(`unknown tool ${tool}`);
    }
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

const STAMP = "2026-05-01T10:00:00.000Z";

export async function seedClaudeCode(home: string, projectRoot: string, marker: string) {
  const dir = join(storePathUnderSandbox("claude-code", home), encodePathForToolDirectory(projectRoot));
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "claude-session.jsonl"),
    [
      JSON.stringify({
        type: "user",
        timestamp: STAMP,
        cwd: projectRoot,
        message: { role: "user", content: marker },
      }),
    ].join("\n") + "\n",
    "utf-8",
  );
}

export async function seedCodex(home: string, projectRoot: string, marker: string) {
  const dir = join(storePathUnderSandbox("codex", home), "2026", "05", "01");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "rollout-codex-session.jsonl"),
    [
      JSON.stringify({
        timestamp: STAMP,
        type: "session_meta",
        payload: { id: "codex-session", cwd: projectRoot, originator: "codex_cli_rs" },
      }),
      JSON.stringify({
        timestamp: STAMP,
        type: "event_msg",
        payload: { type: "user_message", message: marker },
      }),
    ].join("\n") + "\n",
    "utf-8",
  );
}

export async function seedCopilotCli(home: string, projectRoot: string, marker: string) {
  const dir = join(storePathUnderSandbox("copilot-cli", home), "copilot-cli-session");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "events.jsonl"),
    [
      JSON.stringify({
        type: "session.start",
        timestamp: STAMP,
        data: { context: { cwd: projectRoot, gitRoot: projectRoot } },
      }),
      JSON.stringify({ type: "user.message", timestamp: STAMP, data: { content: marker } }),
    ].join("\n") + "\n",
    "utf-8",
  );
}

export async function seedAntigravity(home: string, projectRoot: string, marker: string) {
  const dir = join(storePathUnderSandbox("antigravity", home), "brain", "antigravity-session");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "task.md"), `${marker}\n\nWorking in ${projectRoot}\n`, "utf-8");
  await writeFile(
    join(dir, "task.md.metadata.json"),
    JSON.stringify({ artifactType: "ARTIFACT_TYPE_TASK", updatedAt: STAMP }),
    "utf-8",
  );
}

export async function seedOpencode(home: string, projectRoot: string, marker: string) {
  const dbPath = storePathUnderSandbox("opencode", home);
  await mkdir(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT, parent_id TEXT,
      slug TEXT NOT NULL, directory TEXT NOT NULL, path TEXT, title TEXT NOT NULL,
      version TEXT NOT NULL, share_url TEXT, time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL, time_compacting INTEGER, time_archived INTEGER);
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, data TEXT NOT NULL);
  `);
  const created = Date.parse(STAMP);
  db.prepare(
    `INSERT INTO session (id, project_id, workspace_id, parent_id, slug, directory, path, title,
      version, share_url, time_created, time_updated, time_compacting, time_archived)
     VALUES ('opencode-session','p1',NULL,NULL,'s',?,NULL,'smoke','0.1',NULL,?,?,NULL,NULL)`,
  ).run(projectRoot, created, created);
  db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)`)
    .run("m1", "opencode-session", created, created, JSON.stringify({
      id: "m1", sessionID: "opencode-session", role: "user", time: { created },
    }));
  db.prepare(`INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?,?,?,?,?)`)
    .run("p1", "m1", "opencode-session", created, JSON.stringify({ type: "text", text: marker }));
  db.close();
}

/** Cursor and VS Code Copilot share the workspaceStorage layout. */
async function seedWorkspaceStorage(
  storeRoot: string,
  projectRoot: string,
  seed: (db: Database.Database) => void,
): Promise<string> {
  const workspaceDir = join(storeRoot, "workspace-1");
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(
    join(workspaceDir, "workspace.json"),
    JSON.stringify({ folder: `file:///${projectRoot.replace(/\\/g, "/")}` }),
    "utf-8",
  );
  const db = new Database(join(workspaceDir, "state.vscdb"));
  db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
  seed(db);
  db.close();
  return workspaceDir;
}

export async function seedCopilot(home: string, projectRoot: string, marker: string) {
  await seedWorkspaceStorage(storePathUnderSandbox("copilot", home), projectRoot, (db) => {
    // The value is an object keyed by numeric index, and each request's
    // message carries `parts`, not a bare `text` field.
    db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
      "interactive.sessions",
      JSON.stringify({
        "0": {
          sessionId: "copilot-session",
          creationDate: Date.parse(STAMP),
          requests: [
            {
              message: { parts: [{ text: marker }] },
              response: [{ value: "acknowledged" }],
            },
          ],
        },
      }),
    );
  });
}

export async function seedCursor(home: string, projectRoot: string, marker: string) {
  const storeRoot = storePathUnderSandbox("cursor", home);
  await seedWorkspaceStorage(storeRoot, projectRoot, (db) => {
    db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
      "composer.composerData",
      JSON.stringify({ allComposers: [{ composerId: "cursor-session" }] }),
    );
  });

  // Cursor keeps message bodies in globalStorage, a sibling of workspaceStorage.
  const globalDir = join(dirname(storeRoot), "globalStorage");
  await mkdir(globalDir, { recursive: true });
  const db = new Database(join(globalDir, "state.vscdb"));
  db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)");
  const insert = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
  insert.run(
    "composerData:cursor-session",
    JSON.stringify({
      composerId: "cursor-session",
      createdAt: Date.parse(STAMP),
      fullConversationHeadersOnly: [{ bubbleId: "b1", type: 1 }],
    }),
  );
  insert.run(
    "bubbleId:cursor-session:b1",
    JSON.stringify({ type: 1, text: marker, createdAt: Date.parse(STAMP) }),
  );
  db.close();
}

export const SEEDERS: Record<string, (home: string, projectRoot: string, marker: string) => Promise<void>> = {
  "claude-code": seedClaudeCode,
  codex: seedCodex,
  "copilot-cli": seedCopilotCli,
  antigravity: seedAntigravity,
  opencode: seedOpencode,
  copilot: seedCopilot,
  cursor: seedCursor,
};
