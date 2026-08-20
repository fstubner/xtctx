/**
 * Capture a structural fingerprint of the transcript formats on this machine.
 *
 * The drift canary answers "does the scraper still work?" but costs an API
 * call per tool. This answers the cheaper question underneath it — "has the
 * on-disk shape changed?" — using stores the tools already wrote while you
 * worked. No API, no network, no credentials.
 *
 * What it records is deliberately narrow: record types, field names, and the
 * *type* of each field. Never values. A transcript's content is exactly the
 * thing that must not end up in a committed fixture, and shape is the only
 * part drift detection needs.
 *
 *   npm run capture:formats           print the fingerprint and diff vs committed
 *   npm run capture:formats -- --write update tests/drift/fingerprints/
 *
 * Exit codes: 0 = matches committed (or written), 10 = shape changed,
 * 1 = the capture itself failed.
 */
import { readdir, readFile, mkdir, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXIT_CHANGED = 10;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, "tests", "drift", "fingerprints");
const write = process.argv.includes("--write");

/**
 * Sample caps: a fingerprint needs breadth of shape, not volume.
 *
 * Files are sampled newest-first and the union of their shapes is recorded.
 * Both parts matter. Newest-first because the current format is the one drift
 * detection cares about; a union over a wide sample because otherwise the
 * fingerprint changes with whichever files happened to be picked, and a
 * fingerprint that churns on an unchanged store is another alarm nobody reads.
 */
const MAX_FILES = 30;
const MAX_RECORDS_PER_FILE = 400;

// Resolve store locations through the product's own helpers rather than
// repeating them here. A second copy of path logic is how the demo ended up
// building a store the scraper refused to read, and how opencode's real
// database stayed invisible on this machine.
let storePaths;
try {
  storePaths = await import("../dist/src/tools/sources.js");
} catch {
  console.error(
    "dist is missing — run `npm run build` first.\n" +
      "This script deliberately reuses the product's own store-path resolution\n" +
      "instead of duplicating it, so it needs the built output.",
  );
  process.exit(1);
}

/** Type name of a value — the only thing recorded about it. */
function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    const inner = [...new Set(value.slice(0, 20).map(typeOf))].sort();
    return inner.length === 0 ? "array<empty>" : `array<${inner.join("|")}>`;
  }
  return typeof value;
}

const UUID_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPAQUE_KEY = /^[0-9a-f]{16,}$/i;
const SCHEMA_KEY = /^[A-Za-z0-9_$.:@-]{1,64}$/;

/**
 * A field name is safe to record; a map key is not.
 *
 * Some of these objects are dictionaries keyed by data rather than by schema —
 * cursor stores per-file state under the file's URI, so a naive walk wrote
 * absolute paths from unrelated private projects straight into a committed
 * fingerprint. Anything that does not look like an identifier, plus ids that
 * do, collapse to `*`: the shape underneath is still recorded, the key is not.
 */
function schemaKey(key) {
  if (!SCHEMA_KEY.test(key)) return "*";
  if (UUID_KEY.test(key) || OPAQUE_KEY.test(key)) return "*";
  return key;
}

/** Flatten an object into "path: type" entries, one level of arrays. */
function shapeOf(value, prefix = "", out = new Set(), depth = 0) {
  if (depth > 4 || value === null || typeof value !== "object" || Array.isArray(value)) {
    if (prefix) out.add(`${prefix}: ${typeOf(value)}`);
    return out;
  }
  for (const [rawKey, inner] of Object.entries(value)) {
    const key = schemaKey(rawKey);
    const path = prefix ? `${prefix}.${key}` : key;
    if (inner !== null && typeof inner === "object" && !Array.isArray(inner)) {
      shapeOf(inner, path, out, depth + 1);
    } else {
      out.add(`${path}: ${typeOf(inner)}`);
    }
  }
  return out;
}

async function* walk(dir, depth = 0, maxDepth = 6) {
  if (depth > maxDepth) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full, depth + 1, maxDepth);
    else yield full;
  }
}

/** Newest-first, deterministic for a given store. */
async function newestFiles(root, matcher, limit, maxDepth = 6) {
  const candidates = [];
  for await (const file of walk(root, 0, maxDepth)) {
    if (!matcher(file)) continue;
    let mtime = 0;
    try {
      mtime = (await stat(file)).mtimeMs;
    } catch {
      continue;
    }
    candidates.push({ file, mtime });
  }
  candidates.sort((a, b) => b.mtime - a.mtime || a.file.localeCompare(b.file));
  return candidates.slice(0, limit).map((entry) => entry.file);
}

async function jsonlFingerprint(root, matcher) {
  if (!existsSync(root)) return null;
  const byType = new Map();
  let files = 0;
  let records = 0;

  for (const file of await newestFiles(root, matcher, MAX_FILES)) {
    files += 1;
    let text;
    try {
      text = await readFile(file, "utf-8");
    } catch {
      continue;
    }
    let seen = 0;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim() || seen >= MAX_RECORDS_PER_FILE) continue;
      seen += 1;
      records += 1;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const kind = typeof record?.type === "string" ? record.type : "(no type field)";
      const existing = byType.get(kind) ?? new Set();
      for (const entry of shapeOf(record)) existing.add(entry);
      byType.set(kind, existing);
    }
  }

  if (files === 0) return null;
  return {
    kind: "jsonl",
    filesSampled: files,
    recordsSampled: records,
    recordTypes: Object.fromEntries(
      [...byType.entries()].sort().map(([type, fields]) => [type, [...fields].sort()]),
    ),
  };
}

async function sqliteFingerprint(dbPath, jsonColumns = []) {
  if (!existsSync(dbPath)) return null;
  let Database;
  try {
    Database = (await import("better-sqlite3")).default;
  } catch {
    return null;
  }

  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }

  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")
      .all()
      .map((row) => row.name);

    const schema = {};
    for (const table of tables) {
      schema[table] = db
        .prepare(`PRAGMA table_info("${table}")`)
        .all()
        .map((col) => `${col.name}: ${col.type || "any"}`)
        .sort();
    }

    // Shapes inside JSON-bearing columns, since that is where these tools
    // actually keep the conversation structure.
    const embedded = {};
    for (const { table, column } of jsonColumns) {
      if (!tables.includes(table)) continue;
      const fields = new Set();
      let rows = [];
      try {
        rows = db.prepare(`SELECT "${column}" AS v FROM "${table}" LIMIT 50`).all();
      } catch {
        continue;
      }
      for (const row of rows) {
        const raw = typeof row.v === "string" ? row.v : row.v?.toString?.("utf-8");
        if (!raw) continue;
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          continue;
        }
        const sample = Array.isArray(parsed) ? parsed[0] : parsed;
        for (const entry of shapeOf(sample)) fields.add(entry);
      }
      if (fields.size > 0) embedded[`${table}.${column}`] = [...fields].sort();
    }

    return { kind: "sqlite", tables: schema, embeddedJson: embedded };
  } finally {
    db.close();
  }
}

/**
 * Cursor and VS Code Copilot keep conversation state in key/value SQLite
 * tables, so the interesting shape is inside JSON *values* selected by key
 * rather than in columns. Keys carry ids (`bubbleId:<composer>:<bubble>`),
 * so they are grouped by prefix and the ids themselves are never recorded.
 */
async function keyValueFingerprint(dbPath, table, keyColumn, valueColumn, prefixes) {
  if (!existsSync(dbPath)) return null;
  let Database;
  try {
    Database = (await import("better-sqlite3")).default;
  } catch {
    return null;
  }

  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }

  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => row.name);
    if (!tables.includes(table)) return null;

    const byPrefix = {};
    for (const prefix of prefixes) {
      const fields = new Set();
      let rows = [];
      try {
        rows = db
          .prepare(`SELECT "${valueColumn}" AS v FROM "${table}" WHERE "${keyColumn}" LIKE ? LIMIT 25`)
          .all(`${prefix}%`);
      } catch {
        continue;
      }
      for (const row of rows) {
        const raw = typeof row.v === "string" ? row.v : row.v?.toString?.("utf-8");
        if (!raw) continue;
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          continue;
        }
        const sample = Array.isArray(parsed) ? parsed[0] : parsed;
        for (const entry of shapeOf(sample)) fields.add(entry);
      }
      if (fields.size > 0) byPrefix[prefix] = [...fields].sort();
    }

    return Object.keys(byPrefix).length > 0
      ? { kind: "sqlite-kv", table, keysByPrefix: byPrefix }
      : null;
  } finally {
    db.close();
  }
}

/** Merge several fingerprints into one record, dropping the empty ones. */
function combine(parts) {
  const present = Object.entries(parts).filter(([, value]) => value !== null);
  return present.length > 0 ? Object.fromEntries(present) : null;
}

async function cursorFingerprint() {
  const workspaceRoot = storePaths.defaultCursorStorePath();
  if (!existsSync(workspaceRoot)) return null;

  // Message bodies live in globalStorage, a sibling of workspaceStorage.
  const globalDb = join(dirname(workspaceRoot), "globalStorage", "state.vscdb");

  let workspace = null;
  for await (const file of walk(workspaceRoot, 0)) {
    if (!file.endsWith("state.vscdb")) continue;
    workspace = await keyValueFingerprint(file, "ItemTable", "key", "value", [
      "composer.composerData",
    ]);
    if (workspace) break;
  }

  return combine({
    workspaceStorage: workspace,
    globalStorage: await keyValueFingerprint(globalDb, "cursorDiskKV", "key", "value", [
      "composerData:",
      "bubbleId:",
    ]),
  });
}

/**
 * Antigravity is the odd one out: its conversations are protobuf read through
 * a localhost runtime API rather than parsed off disk, so there is no on-disk
 * record shape to fingerprint for them. What the scraper does depend on
 * statically is the directory layout it detects on, and the `<artifact>.
 * metadata.json` sidecar convention under `brain/` — so that is what is
 * recorded.
 *
 * Artifact file names are chosen by the model and describe the user's work, so
 * only their extensions are kept.
 */
async function antigravityFingerprint() {
  const root = storePaths.defaultAntigravityStorePath();
  if (!existsSync(root)) return null;

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const layout = entries
    .map((entry) => `${schemaKey(entry.name)}${entry.isDirectory() ? "/" : ""}`)
    .sort();

  // Depth matters: `brain/` is not only artifacts, it also holds a large
  // dependency tree, and walking it whole is both slow and picks up files the
  // scraper never looks at. The scraper reads `brain/<session>/<artifact>` and
  // `conversations/<file>`, so the fingerprint stops there too.
  const extensionsIn = async (dir, maxDepth) => {
    const found = new Set();
    // Censused over the whole directory rather than the newest sample: a
    // format migration shows up as an old extension sitting alongside a new
    // one, and a newest-first window is exactly what would hide it.
    for (const file of await newestFiles(join(root, dir), () => true, 5000, maxDepth)) {
      // Compound suffixes matter here (`.md.metadata.json` is the convention
      // the scraper keys on), so take everything from the first dot.
      const name = basename(file);
      const dot = name.indexOf(".");
      found.add(dot === -1 ? "(none)" : name.slice(dot));
    }
    return [...found].sort();
  };

  const sidecar = new Set();
  let files = 0;
  for (const file of await newestFiles(
    join(root, "brain"),
    (f) => f.endsWith(".metadata.json"),
    MAX_FILES,
    1,
  )) {
    files += 1;
    try {
      for (const entry of shapeOf(JSON.parse(await readFile(file, "utf-8")))) sidecar.add(entry);
    } catch {
      continue;
    }
  }

  return {
    kind: "directory",
    layout,
    brainArtifactExtensions: await extensionsIn("brain", 1),
    conversationExtensions: await extensionsIn("conversations", 0),
    artifactMetadata: { filesSampled: files, fields: [...sidecar].sort() },
  };
}

const TOOLS = {
  "claude-code": () =>
    jsonlFingerprint(storePaths.defaultClaudeProjectsDir(), (f) => f.endsWith(".jsonl")),
  codex: () => jsonlFingerprint(storePaths.defaultCodexSessionsPath(), (f) => f.endsWith(".jsonl")),
  "copilot-cli": () =>
    jsonlFingerprint(storePaths.defaultCopilotCliSessionPath(), (f) => f.endsWith("events.jsonl")),
  opencode: () =>
    sqliteFingerprint(storePaths.defaultOpenCodeStorePath(), [
      { table: "message", column: "data" },
      { table: "part", column: "data" },
    ]),
  cursor: cursorFingerprint,
  antigravity: antigravityFingerprint,
  copilot: async () => {
    const root = storePaths.defaultCopilotHistoryPath();
    if (!existsSync(root)) return null;
    for await (const file of walk(root, 0)) {
      if (!file.endsWith("state.vscdb")) continue;
      const found = await keyValueFingerprint(file, "ItemTable", "key", "value", [
        "interactive.sessions",
      ]);
      if (found) return found;
    }
    return null;
  },
};

const captured = {};
const skipped = [];
for (const [tool, capture] of Object.entries(TOOLS)) {
  let fingerprint = null;
  try {
    fingerprint = await capture();
  } catch (err) {
    console.error(`ERROR ${tool}: ${err.message}`);
    process.exit(1);
  }
  if (fingerprint) captured[tool] = fingerprint;
  else skipped.push(tool);
}

if (Object.keys(captured).length === 0) {
  console.error("no transcript stores found on this machine — nothing to fingerprint");
  process.exit(1);
}

await mkdir(outDir, { recursive: true });
let changed = 0;

for (const [tool, fingerprint] of Object.entries(captured)) {
  const path = join(outDir, `${tool}.json`);
  const next = JSON.stringify(fingerprint, null, 2) + "\n";
  const previous = existsSync(path) ? await readFile(path, "utf-8") : null;

  if (previous === null) {
    if (write) {
      await writeFile(path, next, "utf-8");
      console.log(`NEW      ${tool} (${fingerprint.filesSampled ?? "-"} files) -> written`);
    } else {
      console.log(`NEW      ${tool} — no committed fingerprint yet (run with --write)`);
      changed += 1;
    }
    continue;
  }

  if (previous === next) {
    console.log(`same     ${tool}`);
    continue;
  }

  changed += 1;
  console.log(`CHANGED  ${tool}`);
  const before = new Set(previous.split("\n"));
  const after = next.split("\n");
  const added = after.filter((line) => line.trim() && !before.has(line)).slice(0, 12);
  for (const line of added) console.log(`           + ${line.trim()}`);
  if (write) {
    await writeFile(path, next, "utf-8");
    console.log(`           -> updated`);
  }
}

for (const tool of skipped) console.log(`skipped  ${tool} — no store on this machine`);

if (changed > 0 && !write) {
  console.log(
    "\nShape changed since the committed fingerprint. Check the scraper for that tool,\n" +
      "then re-run with --write to record the new shape.",
  );
}

process.exit(changed > 0 && !write ? EXIT_CHANGED : 0);
