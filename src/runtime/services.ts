import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { SqliteHandoffIndex } from "../handoff/sqlite-index.js";
import type { SessionService } from "../handoff/types.js";
import { createDefaultScrapers } from "../tools/sources.js";

export interface ProjectConfig {
  tools: Record<string, { enabled?: boolean; storePath?: string }>;
  /**
   * Why the config on disk could not be read, when it exists but is broken.
   * Nothing is scanned while this is set: the file is the only place a user
   * says which transcript stores may be read, and guessing at that is not a
   * default worth having.
   */
  error?: string;
}

export interface ProjectServices {
  projectRoot: string;
  xtctxDir: string;
  stateDir: string;
  dbPath: string;
  configPath: string;
  config: ProjectConfig;
  sessions: SessionService;
}

/**
 * Resolve a project root through any symlinks.
 *
 * Every scraper attributes a session by comparing a path another tool
 * recorded — and those tools record `process.cwd()`, which the OS reports
 * canonically. On macOS the temp directory and plenty of ordinary home
 * layouts are symlinks (`/var` -> `/private/var`), so a root given as the
 * symlinked path matches nothing any tool ever wrote, and the project
 * silently scrapes zero sessions. Falls back to the lexical path when the
 * directory does not exist yet.
 */
async function canonicalProjectRoot(projectPath: string): Promise<string> {
  const resolved = resolve(projectPath);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

export interface ProjectServicesOptions {
  /** Diagnostics pass false so inspecting a project does not create one. */
  createIfMissing?: boolean;
  /**
   * Store directories a tool named for itself, keyed by tool id.
   *
   * The hook path supplies Claude Code's, taken from the `transcript_path`
   * every hook receives. Everything else leaves this empty and the scrapers
   * reconstruct their locations as before.
   */
  storeDirs?: Record<string, string | undefined>;
  /**
   * Home directory to judge store-path redirects against. Tests pass one;
   * everything else uses the real environment.
   */
  homeDir?: string;
}

export async function createProjectServices(
  projectPath?: string,
  options: ProjectServicesOptions = {},
): Promise<ProjectServices> {
  const projectRoot = await canonicalProjectRoot(projectPath ?? process.cwd());
  const xtctxDir = join(projectRoot, ".xtctx");
  const stateDir = join(xtctxDir, "state");
  const dbPath = join(stateDir, "xtctx.db");
  const configPath = join(xtctxDir, "config.yaml");
  const config = await loadProjectConfig(configPath);
  const overrides = Object.fromEntries(
    Object.entries(config.tools)
      .filter(([, value]) => value.enabled !== false)
      .map(([tool, value]) => [tool, value.storePath]),
  );
  // A config that cannot be read leaves no scrapers at all. Scanning on
  // defaults would read stores the user may have switched off, and the whole
  // point of the file is that they get to decide.
  const scrapers = config.error
    ? []
    : createDefaultScrapers(
        stateDir,
        overrides,
        projectRoot,
        // Recorded by the session-start hook from the `transcript_path` the
        // host tool passes it. The hook cannot use it itself — it reads the
        // existing index without scraping — so this is where it lands.
        { ...(await readRecordedStoreDirs(stateDir)), ...(options.storeDirs ?? {}) },
      ).filter((scraper) => {
        const toolConfig = config.tools[scraper.tool];
        return toolConfig?.enabled !== false;
      });

  const sessions = new SqliteHandoffIndex(
    dbPath,
    projectRoot,
    scrapers.map((scraper) => ({ tool: scraper.tool, scraper })),
    {
      createIfMissing: options.createIfMissing,
      redirectedTools: redirectedTools(config, options.homeDir),
    },
  );

  return {
    projectRoot,
    xtctxDir,
    stateDir,
    dbPath,
    configPath,
    config,
    sessions,
  };
}

export async function loadProjectConfig(configPath: string): Promise<ProjectConfig> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf-8");
  } catch {
    // Missing config is valid: setup owns writing it, MCP can still run.
    return { tools: {} };
  }

  try {
    const parsed = parseYaml(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const root = parsed as Record<string, unknown>;
      return { tools: normalizeTools(root.tools) };
    }
    return { tools: {}, error: "expected a mapping at the top level" };
  } catch (err) {
    // A config that exists but will not parse is not the same as no config.
    // `enabled: false` is the only control a user has over which transcript
    // stores get read, so reading a stray tab as "no preferences expressed"
    // silently re-enabled a tool they had switched off — and said nothing.
    //
    // Reported rather than thrown: `status` has to keep working, since
    // explaining a broken config is exactly what a diagnostic is for. What
    // does change is that nothing is scanned until it is fixed.
    return { tools: {}, error: err instanceof Error ? err.message : String(err) };
  }
}

function normalizeTools(input: unknown): ProjectConfig["tools"] {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  const tools: ProjectConfig["tools"] = {};
  for (const [tool, rawConfig] of Object.entries(input as Record<string, unknown>)) {
    if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
      continue;
    }

    const value = rawConfig as Record<string, unknown>;
    const config: { enabled?: boolean; storePath?: string } = {};
    if (typeof value.enabled === "boolean") {
      config.enabled = value.enabled;
    }
    if (typeof value.storePath === "string" && value.storePath.trim().length > 0) {
      config.storePath = resolve(value.storePath);
    }
    tools[tool] = config;
  }

  return tools;
}

/**
 * Enabled tools whose transcript store this project's config redirects out of
 * the home directory.
 *
 * `.xtctx/config.yaml` is committable — which tools a project uses belongs in
 * the repo — and it can also set `storePath`, the directory transcripts are
 * read from. That path is resolved with no containment, so a config carried by
 * a cloned repository can point xtctx at another project's store and have
 * those conversations served back as this project's context.
 *
 * Nothing writes `storePath` any more, so one that is present came from the
 * operator or from a clone, and the transcripts that come back look the same
 * either way. Reporting it is the mitigation: the reading still happens, but
 * it stops being silent.
 *
 * Home is the boundary because every tool keeps its store under it by default.
 * A path elsewhere is unusual enough to be worth a line and common enough
 * inside home that warning there would only teach people to ignore it.
 */
function redirectedTools(config: ProjectConfig, homeDir?: string): string[] {
  const home = homeDir ?? process.env.USERPROFILE ?? process.env.HOME ?? "";
  if (!home) {
    return [];
  }

  return Object.entries(config.tools)
    .filter(([, value]) => value.enabled !== false && value.storePath)
    .filter(([, value]) => !isInsideDir(value.storePath as string, home))
    .map(([tool]) => tool)
    .sort();
}

function isInsideDir(candidate: string, root: string): boolean {
  const c = normalizeForCompare(candidate);
  const r = normalizeForCompare(root);
  return c === r || c.startsWith(`${r}/`);
}

function normalizeForCompare(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Store directories the session-start hook recorded, if any.
 *
 * Absent for every project set up without hooks, and for tools that send no
 * payload — in which case the scrapers reconstruct their locations exactly as
 * before. An unreadable or malformed file is treated the same as no file: this
 * is an accuracy improvement, not a dependency.
 */
async function readRecordedStoreDirs(
  stateDir: string,
): Promise<Record<string, string | undefined>> {
  try {
    const raw = await readFile(join(stateDir, "store-dirs.json"), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string" && entry[1].length > 0,
      ),
    );
  } catch {
    return {};
  }
}
