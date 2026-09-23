#!/usr/bin/env node
/**
 * Fail if a GitHub Actions workflow file would be rejected by GitHub itself.
 *
 * Nothing in this repository checked the workflow files, and the gap was not
 * theoretical. A comment inside `release.yml`'s `run:` block mentioned the
 * expression syntax as an empty `${{ }}` pair. Actions evaluates expressions
 * inside `run:` strings — shell comments included — so the empty one made the
 * whole file invalid ("An expression was expected"). CI stayed green, because
 * CI never looks at release.yml; the only symptom was a zero-job failed run on
 * every push, which read as noise. Merged, it would have left the one workflow
 * that cuts releases impossible to dispatch.
 *
 * This checks the two things that failure needed, not a full Actions schema:
 * every workflow parses as YAML, and every expression opened in any string
 * value is closed and non-empty. YAML comments are not checked, because they
 * are not strings and Actions never sees them — only text inside a value is
 * evaluated, which is exactly the distinction that was missed.
 *
 *   node scripts/check-workflows.mjs
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";

const WORKFLOW_DIR = ".github/workflows";

/** Problems in one workflow's text, as human-readable strings. */
export function checkWorkflowText(text, name = "workflow") {
  let document;
  try {
    document = parse(text);
  } catch (error) {
    return [`${name}: does not parse as YAML: ${error instanceof Error ? error.message : String(error)}`];
  }

  const problems = [];
  const visit = (value, path) => {
    if (typeof value === "string") {
      for (const problem of expressionProblems(value)) {
        problems.push(`${name}: ${path}: ${problem}`);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        visit(item, path ? `${path}.${key}` : key);
      }
    }
  };
  visit(document, "");
  return problems;
}

function expressionProblems(value) {
  const problems = [];
  let from = 0;
  for (;;) {
    const open = value.indexOf("${{", from);
    if (open === -1) break;
    const close = value.indexOf("}}", open + 3);
    if (close === -1) {
      problems.push(`unclosed expression starting ${JSON.stringify(value.slice(open, open + 30))}`);
      break;
    }
    if (value.slice(open + 3, close).trim().length === 0) {
      problems.push("empty expression — Actions evaluates this even inside a shell comment");
    }
    from = close + 2;
  }
  return problems;
}

export function checkWorkflowDir(dir = WORKFLOW_DIR) {
  const problems = [];
  for (const file of readdirSync(dir).filter((entry) => /\.ya?ml$/.test(entry))) {
    problems.push(...checkWorkflowText(readFileSync(join(dir, file), "utf-8"), file));
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = checkWorkflowDir();
  if (problems.length > 0) {
    process.stderr.write(`${problems.join("\n")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("Every workflow parses and every expression is closed and non-empty.\n");
  }
}
