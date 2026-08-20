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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXIT_CHANGED = 10;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, "tests", "drift", "fingerprints");
const write = process.argv.includes("--write");

/** Sample caps: a fingerprint needs breadth of shape, not volume. */
const MAX_FILES = 8;
const MAX_RECORDS_PER_FILE = 400;

const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");

/** Type name of a value — the only thing recorded about it. */
function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    const inner = [...new Set(value.slice(0, 20).map(typeOf))].sort();
    return inner.length === 0 ? "array<empty>" : `array<${inner.join("|")}>`;
  }
  return typeof value;
}

/** Flatten an object into "path: type" entries, one level of arrays. */
function shapeOf(value, prefix = "", out = new Set(), depth = 0) {
  if (depth > 4 || value === null || typeof value !== "object" || Array.isArray(value)) {
    if (prefix) out.add(`${prefix}: ${typeOf(value)}`);
    return out;
  }
  for (const [key, inner] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (inner !== null && typeof inner === "object" && !Array.isArray(inner)) {
      shapeOf(inner, path, out, depth + 1);
    } else {
      out.add(`${path}: ${typeOf(inner)}`);
    }
  }
  return out;
}

async function* walk(dir, depth = 0) {
  if (depth > 6) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full, depth + 1);
    else yield full;
  }
}

async function jsonlFingerprint(root, matcher) {
  if (!existsSync(root)) return null;
  const byType = new Map();
  let files = 0;
  let records = 0;

  for await (const file of walk(root)) {
    if (!matcher(file)) continue;
    if (files >= MAX_FILES) break;
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

const TOOLS = {
  "claude-code": () =>
    jsonlFingerprint(join(home, ".claude", "projects"), (f) => f.endsWith(".jsonl")),
  codex: () => jsonlFingerprint(join(home, ".codex", "sessions"), (f) => f.endsWith(".jsonl")),
  "copilot-cli": () =>
    jsonlFingerprint(join(home, ".copilot", "session-state"), (f) => f.endsWith("events.jsonl")),
  opencode: () =>
    sqliteFingerprint(join(appData, "opencode", "opencode.db"), [
      { table: "message", column: "data" },
      { table: "part", column: "data" },
    ]),
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

await stat(outDir);
process.exit(changed > 0 && !write ? EXIT_CHANGED : 0);
