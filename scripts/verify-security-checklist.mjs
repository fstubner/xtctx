import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const checklistPath = resolve(process.cwd(), "docs", "security", "owasp-asvs-lite.md");
const requiredHeadings = [
  "## Authentication",
  "## Access Control",
  "## Input and Output Handling",
  "## API and Web Security",
  "## Logging and Monitoring",
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

console.log(`Security checklist present and complete: ${checklistPath}`);
