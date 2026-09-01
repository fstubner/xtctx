/**
 * Copy `package.json`'s version into every other file that carries it.
 *
 * Seven files declare this package's version: `package.json` and its lockfile,
 * three plugin manifests (one per client family), the marketplace entry Claude
 * Code's `plugin tag` refuses to cut a release against when it disagrees, and
 * the landing site's footer and JSON-LD `softwareVersion`.
 *
 * `npm version` writes two of them. Release Please used to write the rest, and
 * when it was removed nothing took the job over — so a bump left five files
 * behind, and the commit the release workflow then tagged failed its own test
 * suite (`tests/release/plugin-package.test.ts`,
 * `tests/landing/version-sync.test.ts`). The release could not have completed.
 *
 * Wired as the npm `version` lifecycle script, so it runs inside `npm version`
 * rather than being a step someone has to remember. `--check` verifies without
 * writing, which is what CI asserts.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const check = process.argv.includes("--check");
const root = process.cwd();

const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf-8"));
const version = pkg.version;
if (typeof version !== "string" || version.length === 0) {
  throw new Error("package.json has no version to sync from.");
}

/** JSON files whose top-level `version` tracks the package. */
const JSON_TARGETS = [
  "plugin/plugin.json",
  "plugin/.claude-plugin/plugin.json",
  "plugin/.codex-plugin/plugin.json",
];

const stale = [];

for (const relative of JSON_TARGETS) {
  const path = resolve(root, relative);
  const raw = await readFile(path, "utf-8");
  const parsed = JSON.parse(raw);
  if (parsed.version === version) continue;

  stale.push(`${relative}: ${parsed.version} -> ${version}`);
  if (check) continue;

  // Rewritten by string substitution rather than re-serialised, so key order,
  // indentation and the trailing newline survive untouched. These are files
  // other tools read; a reformat is a diff nobody asked for.
  await writeFile(
    path,
    raw.replace(/("version"\s*:\s*)"[^"]*"/, `$1${JSON.stringify(version)}`),
    "utf-8",
  );
}

// The marketplace entry sits inside a `plugins` array, so it is addressed by
// the surrounding `"name": "xtctx"` rather than by being the only version key.
{
  const path = resolve(root, ".claude-plugin/marketplace.json");
  const raw = await readFile(path, "utf-8");
  const parsed = JSON.parse(raw);
  const entry = parsed.plugins?.find((plugin) => plugin.name === "xtctx");
  if (!entry) {
    throw new Error(`No xtctx plugin entry in ${path}.`);
  }
  if (entry.version !== version) {
    stale.push(`.claude-plugin/marketplace.json: ${entry.version} -> ${version}`);
    if (!check) {
      // Scanned forward from the entry's name rather than matched as one
      // pattern: `version` is not adjacent to `name` in this file, and an
      // anchored regex silently matched nothing — which reads exactly like
      // "already in sync".
      const nameAt = raw.indexOf('"name": "xtctx"');
      const versionAt = nameAt === -1 ? -1 : raw.indexOf('"version"', nameAt);
      if (versionAt === -1) {
        throw new Error(`Could not locate the xtctx version field in ${path}.`);
      }
      const head = raw.slice(0, versionAt);
      const tail = raw
        .slice(versionAt)
        .replace(/^("version"\s*:\s*)"[^"]*"/, `$1${JSON.stringify(version)}`);
      if (head + tail === raw) {
        throw new Error(`Failed to rewrite the version field in ${path}.`);
      }
      await writeFile(path, head + tail, "utf-8");
    }
  }
}

// The landing site keeps it in a TypeScript literal, tagged with the marker
// Release Please used so the line stays findable.
{
  const path = resolve(root, "landing/src/data/site.ts");
  const raw = await readFile(path, "utf-8");
  const current = /version:\s*'([^']+)'/.exec(raw);
  if (!current) {
    throw new Error(`No version literal in ${path}.`);
  }
  if (current[1] !== version) {
    stale.push(`landing/src/data/site.ts: ${current[1]} -> ${version}`);
    if (!check) {
      await writeFile(path, raw.replace(/(version:\s*)'[^']+'/, `$1'${version}'`), "utf-8");
    }
  }
}

if (check) {
  if (stale.length > 0) {
    console.error(
      `Version files disagree with package.json (${version}):\n` +
        stale.map((line) => `  ${line}`).join("\n") +
        "\nRun: npm run sync:version",
    );
    process.exit(1);
  }
  console.log(`All version files agree with package.json (${version}).`);
} else {
  console.log(
    stale.length > 0
      ? `Synced to ${version}:\n${stale.map((line) => `  ${line}`).join("\n")}`
      : `Already in sync at ${version}.`,
  );
}
