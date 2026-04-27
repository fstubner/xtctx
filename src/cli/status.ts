import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { LanceStore } from "../store/lance.js";
import { createProjectServices, type ProjectServices } from "../runtime/services.js";
import { readXtctxPackage } from "../utils/package-info.js";

export interface StatusOptions {
  projectPath?: string;
}

interface ToolState {
  tool: string;
  enabled: boolean;
  detected: boolean;
  lastTimestamp: Date | null;
}

const KNOWN_TOOLS = ["claude-code", "cursor", "copilot", "codex", "gemini"] as const;

export async function runStatus(options: StatusOptions = {}): Promise<void> {
  const projectRoot = resolve(options.projectPath ?? process.cwd());
  const services = await createProjectServices(projectRoot);
  const block = await renderStatusBlock({ services, port: services.webPort });
  process.stdout.write(block + "\n");
}

/**
 * Render the same one-screen status block used by `xtctx status` and the
 * `xtctx serve` startup banner. Reads from disk only, so it works whether or
 * not a serve process is running.
 */
export async function renderStatusBlock(args: {
  services: ProjectServices;
  port: number;
}): Promise<string> {
  const { services, port } = args;
  const { version } = readXtctxPackage(import.meta.url);

  const counts = await countStoreChunks(join(services.storeDir, "lancedb"));
  const toolStates = await collectToolStates(services);
  const lastIngest = pickLatestIngest(toolStates);

  const lines: string[] = [];
  lines.push(`xtctx ${version} — ready`);
  lines.push("");
  lines.push(`  MCP    stdio`);
  lines.push(`  API    http://127.0.0.1:${port}/api  (5 routers)`);
  lines.push(
    `  Store  ${relativizeForDisplay(services.storeDir, services.projectRoot)}/lancedb/  ` +
      `(${counts.total.toLocaleString()} chunks across ${counts.toolsWithData} tools)`,
  );
  if (lastIngest) {
    lines.push(
      `  Last ingest  ${formatRelative(lastIngest.lastTimestamp!)}  (${lastIngest.tool})`,
    );
  } else {
    lines.push(`  Last ingest  never`);
  }
  lines.push("");
  lines.push("Tools:");
  for (const state of toolStates) {
    lines.push(`  ${formatToolRow(state)}`);
  }

  return lines.join("\n");
}

interface StoreCounts {
  total: number;
  toolsWithData: number;
}

async function countStoreChunks(lanceDbPath: string): Promise<StoreCounts> {
  try {
    const present = await pathExists(lanceDbPath);
    if (!present) {
      return { total: 0, toolsWithData: 0 };
    }
    const store = new LanceStore(lanceDbPath);
    await store.initialize();

    let total = 0;
    const toolsSeen = new Set<string>();
    for (const tableName of ["context", "knowledge"]) {
      if (!(await store.tableExists(tableName))) {
        continue;
      }
      total += await store.countRows(tableName);
      // Sample rows to figure out which tools have data. queryRows returns
      // {id, text, metadata} — metadata holds the source tool for context rows.
      const rows = await store.queryRows(tableName, { limit: 5000 });
      for (const row of rows) {
        const tool = extractTool(row.metadata, tableName);
        if (tool) toolsSeen.add(tool);
      }
    }

    return { total, toolsWithData: toolsSeen.size };
  } catch {
    return { total: 0, toolsWithData: 0 };
  }
}

function extractTool(metadata: string, tableName: string): string | null {
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    const tool =
      (typeof parsed.source_tool === "string" ? parsed.source_tool : null) ??
      (typeof parsed.tool === "string" ? parsed.tool : null);
    if (tool) return tool;
  } catch {
    // ignore
  }
  return tableName === "knowledge" ? "knowledge" : null;
}

async function collectToolStates(services: ProjectServices): Promise<ToolState[]> {
  const configByTool = new Map<string, { enabled: boolean; customStorePath?: string }>();
  for (const config of services.ingestion.scrapers) {
    configByTool.set(config.tool, { enabled: config.enabled, customStorePath: config.customStorePath });
  }

  const detectionPaths = await defaultDetectionPaths();

  const tools = [...new Set([...KNOWN_TOOLS, ...configByTool.keys()])];
  const states: ToolState[] = [];
  for (const tool of tools) {
    const config = configByTool.get(tool);
    const enabled = config ? config.enabled : true;
    const path = config?.customStorePath ?? detectionPaths[tool];
    const detected = enabled && path ? await pathExists(path) : false;
    const lastTimestamp = await readLastTimestamp(services.stateDir, tool);
    states.push({ tool, enabled, detected, lastTimestamp });
  }

  return states;
}

async function readLastTimestamp(stateDir: string, tool: string): Promise<Date | null> {
  const path = join(stateDir, `${tool}-state.json`);
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as { lastTimestamp?: string };
    if (typeof parsed.lastTimestamp === "string") {
      const ts = new Date(parsed.lastTimestamp);
      if (!Number.isNaN(ts.getTime()) && ts.getTime() > 0) {
        return ts;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function pickLatestIngest(states: ToolState[]): ToolState | null {
  let latest: ToolState | null = null;
  for (const state of states) {
    if (!state.lastTimestamp) continue;
    if (!latest || state.lastTimestamp > latest.lastTimestamp!) {
      latest = state;
    }
  }
  return latest;
}

function formatToolRow(state: ToolState): string {
  const name = state.tool.padEnd(13);
  if (!state.enabled) {
    return `${name} —  disabled`;
  }
  if (!state.detected) {
    return `${name} —  not detected`;
  }
  if (!state.lastTimestamp) {
    return `${name} ?  detected, no ingest yet`;
  }
  const age = Date.now() - state.lastTimestamp.getTime();
  const stale = age > 7 * 24 * 60 * 60 * 1000;
  const marker = stale ? "!" : "+";
  const label = stale ? "stale" : "synced";
  return `${name} ${marker}  ${label.padEnd(8)} last ingest: ${formatRelative(state.lastTimestamp)}`;
}

function formatRelative(date: Date): string {
  const ageMs = Date.now() - date.getTime();
  if (ageMs < 0) return "just now";
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function relativizeForDisplay(absolutePath: string, projectRoot: string): string {
  if (absolutePath.startsWith(projectRoot)) {
    const rel = absolutePath.slice(projectRoot.length).replace(/^[/\\]+/, "");
    return rel || ".";
  }
  return absolutePath;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function defaultDetectionPaths(): Promise<Record<string, string>> {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const appData = process.env.APPDATA ?? "";
  return {
    "claude-code": join(home, ".claude", "projects"),
    cursor: appData ? join(appData, "Cursor", "User", "workspaceStorage") : join(home, ".cursor", "workspaceStorage"),
    codex: join(home, ".codex", "sessions"),
    copilot: appData
      ? join(appData, "Code", "User", "workspaceStorage")
      : join(home, "Library", "Application Support", "Code", "User", "workspaceStorage"),
    gemini: join(home, ".gemini", "tmp"),
  };
}
