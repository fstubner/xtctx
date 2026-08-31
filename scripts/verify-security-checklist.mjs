import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const checklistPath = resolve(process.cwd(), "docs", "security", "owasp-asvs-lite.md");
const requiredHeadings = [
  "## Local-Only Execution",
  "## Input and Output Handling",
  "## File Safety",
  "## Supply Chain and Release Security",
];

const content = await readFile(checklistPath, "utf-8");
for (const heading of requiredHeadings) {
  if (!content.includes(heading)) {
    throw new Error(
      `Missing required security checklist section '${heading}' in ${checklistPath}`,
    );
  }
}

const unchecked = [...content.matchAll(/^- \[ \] (.+)$/gm)].map((match) => match[1]);
if (unchecked.length > 0) {
  const summary = unchecked.map((item) => `- ${item}`).join("\n");
  throw new Error(
    `Security checklist has incomplete controls in ${checklistPath}:\n${summary}`,
  );
}

const checked = [...content.matchAll(/^- \[[xX]\] (.+)$/gm)];
if (checked.length === 0) {
  throw new Error(`No completed checklist controls found in ${checklistPath}.`);
}

// Every control here is self-attested prose: this script cannot verify any of
// them, and pretending otherwise is what made a gate named "security" mean
// nothing. What it *can* check is whether anyone has re-read them lately — an
// attestation is a claim about a moment, and this one sat 113 days stale
// across the releases that added the global-config write paths.
//
// Warn, then fail. A warning surfaces the drift without blocking work on the
// day it crosses the line; the hard bound is there so "warned about for
// months" cannot become the resting state.
const REVIEW_WARN_DAYS = 90;
const REVIEW_FAIL_DAYS = 180;

const reviewed = /^Last reviewed:\s*(\d{4}-\d{2}-\d{2})\s*$/m.exec(content);
if (!reviewed) {
  throw new Error(
    `No 'Last reviewed: YYYY-MM-DD' line in ${checklistPath}. ` +
      "An attestation with no date is not one.",
  );
}

const reviewedAt = Date.parse(`${reviewed[1]}T00:00:00Z`);
if (Number.isNaN(reviewedAt)) {
  throw new Error(`Unparseable review date '${reviewed[1]}' in ${checklistPath}.`);
}

const ageDays = Math.floor((Date.now() - reviewedAt) / 86_400_000);
if (ageDays > REVIEW_FAIL_DAYS) {
  throw new Error(
    `Security checklist was last reviewed ${ageDays} days ago (${reviewed[1]}), ` +
      `over the ${REVIEW_FAIL_DAYS}-day limit. Re-read the controls in ${checklistPath} ` +
      "and update the date, or the attestation is fiction.",
  );
}
if (ageDays > REVIEW_WARN_DAYS) {
  console.warn(
    `WARNING: security checklist last reviewed ${ageDays} days ago (${reviewed[1]}). ` +
      `These ${checked.length} controls are self-attested prose that nothing verifies; ` +
      `re-read them and update the date. Fails at ${REVIEW_FAIL_DAYS} days.`,
  );
}

console.log(
  `Security checklist present and complete: ${checklistPath} ` +
    `(${checked.length} controls, reviewed ${ageDays} days ago)`,
);
