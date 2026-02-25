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

console.log(`Security checklist present and valid: ${checklistPath}`);
