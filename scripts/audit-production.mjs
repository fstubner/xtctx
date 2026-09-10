#!/usr/bin/env node
/**
 * `npm audit --omit=dev`, with room for advisories that have no fix and no
 * reach into this program.
 *
 * The bare command is all-or-nothing: any advisory against any package in the
 * production tree fails the build, whether or not xtctx ever executes the code
 * it describes. That is the right default and it stays the default here —
 * every advisory fails unless it is listed below with a reason.
 *
 * What this is not: a way to make a warning quiet. An entry states which
 * advisory, why the vulnerable path is unreachable from this program, and what
 * would remove the need for the entry. If that argument cannot be written, the
 * advisory is not eligible and the dependency has to change instead.
 *
 * Stale entries fail too. An allowlisted advisory that no longer appears means
 * the dependency moved on, and the exception has to go with it — otherwise the
 * list silently accumulates permission nobody re-examined.
 */
import { spawnSync } from "node:child_process";

/**
 * @typedef {object} Exception
 * @property {string} advisory   GHSA identifier, as npm reports it.
 * @property {string} package    Package the advisory is filed against.
 * @property {string} why        Why this program cannot reach the vulnerable path.
 * @property {string} removedBy  What would let this entry be deleted.
 */

/** @type {Exception[]} */
const EXCEPTIONS = [
  {
    advisory: "GHSA-vwc7-r8mq-g2x9",
    package: "adm-zip",
    why:
      "adm-zip is used in onnxruntime-node's postinstall script, to unpack the " +
      "ONNX Runtime native build it downloads from Microsoft. The advisory is " +
      "about extraction following symlinks in the archive, which requires the " +
      "archive to be attacker-chosen. xtctx never calls adm-zip, never passes it " +
      "an archive, and does not depend on it directly — the only archive it ever " +
      "sees is the vendor download at install time.",
    removedBy:
      "onnxruntime-node releasing with adm-zip >= a fixed version, or xtctx " +
      "dropping @huggingface/transformers from its default install (see the " +
      "optional-peer plan) so the chain leaves the production tree entirely.",
  },
];

/**
 * npm reports one entry per package along the chain, so a single advisory
 * against a leaf also surfaces against everything that depends on it. Matching
 * on the advisory identifier rather than the package name keeps one exception
 * to one real finding, instead of needing an entry per hop.
 */
function advisoriesInReport(report) {
  const found = new Map();
  for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vulnerability.via ?? []) {
      // A string `via` is a pointer to another package's entry, not an
      // advisory of its own; the object form carries the identifier.
      if (typeof via !== "object" || typeof via.url !== "string") {
        continue;
      }
      const id = via.url.split("/").pop();
      if (!id) {
        continue;
      }
      if (!found.has(id)) {
        found.set(id, { id, title: via.title ?? "", severity: via.severity ?? "unknown", url: via.url });
      }
    }
  }
  return found;
}

function runAudit() {
  // `npm audit` exits non-zero when it finds something, which is the whole
  // point, so the exit code is not an error signal here — an unparseable body
  // is.
  // One command string rather than a name plus an argument array. npm is a
  // shell script on every platform this runs on (`npm.cmd` on Windows), so it
  // cannot be spawned without a shell — but passing an array *through* a shell
  // concatenates rather than escapes, which Node deprecates in DEP0190. Every
  // argument here is a literal in this file, so there is nothing to escape.
  const result = spawnSync("npm audit --omit=dev --json", {
    encoding: "utf-8",
    shell: true,
    maxBuffer: 32 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`could not run npm audit: ${result.error.message}`);
  }

  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `npm audit did not return JSON.\nstdout: ${result.stdout.slice(0, 2000)}\nstderr: ${result.stderr.slice(0, 2000)}`,
    );
  }
}

function main() {
  const report = runAudit();
  const found = advisoriesInReport(report);
  const allowed = new Map(EXCEPTIONS.map((entry) => [entry.advisory, entry]));

  const unexpected = [...found.values()].filter((advisory) => !allowed.has(advisory.id));
  const stale = EXCEPTIONS.filter((entry) => !found.has(entry.advisory));

  for (const entry of EXCEPTIONS) {
    if (found.has(entry.advisory)) {
      const advisory = found.get(entry.advisory);
      process.stdout.write(`allowed: ${entry.advisory} (${entry.package}, ${advisory.severity}) — ${entry.why.split(".")[0]}.\n`);
    }
  }

  if (stale.length > 0) {
    process.stderr.write("\nThese exceptions no longer match any advisory. Delete them:\n");
    for (const entry of stale) {
      process.stderr.write(`  ${entry.advisory} (${entry.package})\n`);
    }
  }

  if (unexpected.length > 0) {
    process.stderr.write("\nProduction dependency advisories with no exception:\n");
    for (const advisory of unexpected) {
      process.stderr.write(`  ${advisory.severity.padEnd(8)} ${advisory.id}  ${advisory.title}\n    ${advisory.url}\n`);
    }
    process.stderr.write(
      "\nFix it, or add an exception to scripts/audit-production.mjs stating why\n" +
        "the vulnerable path is unreachable from xtctx and what would remove the\n" +
        "exception. An advisory nobody can write that argument for is not eligible.\n",
    );
  }

  if (unexpected.length > 0 || stale.length > 0) {
    process.exit(1);
  }

  process.stdout.write(
    `Production dependency audit clean (${found.size} advisory/advisories, all accounted for).\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
