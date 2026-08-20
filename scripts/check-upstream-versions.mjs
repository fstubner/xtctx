/**
 * Free drift signal: watch upstream releases instead of invoking the tools.
 *
 * The drift canary proves whether a scraper still works, but it costs an API
 * call per tool per run. Transcript formats do not change nightly — they
 * change when a tool ships a release. So this checks npm for new versions of
 * the tools whose on-disk formats xtctx reads, and reports which ones moved
 * past the version recorded in .github/upstream-versions.json.
 *
 * It proves nothing about whether anything broke. It tells you when it is
 * worth looking, which is the part that was missing for free.
 *
 *   node scripts/check-upstream-versions.mjs            human-readable report
 *   node scripts/check-upstream-versions.mjs --json     machine-readable
 *
 * Exit codes: 0 = everything current, 10 = at least one tool moved,
 * 1 = the check itself failed (network, bad registry response).
 */
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXIT_OUTDATED = 10;
const REGISTRY = "https://registry.npmjs.org";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(repoRoot, ".github", "upstream-versions.json");
const asJson = process.argv.includes("--json");

async function latestVersion(pkg) {
  // No custom accept header: the abbreviated-metadata type is only valid on
  // the packument, and the registry answers /latest with 406 for it.
  const response = await fetch(`${REGISTRY}/${encodeURIComponent(pkg).replace("%40", "@")}/latest`);
  if (!response.ok) {
    throw new Error(`${pkg}: registry returned ${response.status}`);
  }
  const body = await response.json();
  if (typeof body.version !== "string") {
    throw new Error(`${pkg}: registry response had no version`);
  }
  return body.version;
}

let manifest;
try {
  manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
} catch (err) {
  console.error(`could not read ${manifestPath}: ${err.message}`);
  process.exit(1);
}

const tracked = Object.entries(manifest.packages ?? {});
if (tracked.length === 0) {
  console.error("no packages tracked in .github/upstream-versions.json");
  process.exit(1);
}

const results = [];
for (const [pkg, known] of tracked) {
  try {
    const latest = await latestVersion(pkg);
    results.push({ package: pkg, known, latest, moved: latest !== known });
  } catch (err) {
    console.error(`ERROR ${pkg}: ${err.message}`);
    process.exit(1);
  }
}

const moved = results.filter((r) => r.moved);

if (asJson) {
  process.stdout.write(JSON.stringify({ moved: moved.length > 0, results }, null, 2) + "\n");
} else {
  for (const r of results) {
    process.stdout.write(
      r.moved
        ? `MOVED    ${r.package}: ${r.known} -> ${r.latest}\n`
        : `current  ${r.package}: ${r.known}\n`,
    );
  }
  if (moved.length > 0) {
    process.stdout.write(
      `\n${moved.length} tool(s) released since the recorded versions.\n` +
        `Check formats with: npm run capture:formats\n` +
        `Then record the new versions in .github/upstream-versions.json.\n`,
    );
  }
}

process.exit(moved.length > 0 ? EXIT_OUTDATED : 0);
