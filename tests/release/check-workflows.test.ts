/**
 * The workflow files have to be ones GitHub will actually run.
 *
 * A comment inside `release.yml`'s `run:` block contained an empty Actions
 * expression. Actions evaluates expressions in `run:` strings, comments
 * included, so the file became invalid; CI never looks at release.yml, so
 * everything stayed green and merging would have left releases impossible to
 * dispatch. See scripts/check-workflows.mjs.
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain JS with JSDoc types, imported for its exports.
import { checkWorkflowDir, checkWorkflowText } from "../../scripts/check-workflows.mjs";

const check = checkWorkflowText as (text: string, name?: string) => string[];

describe("workflow checks", () => {
  it("passes every workflow in this repository", () => {
    expect((checkWorkflowDir as () => string[])()).toEqual([]);
  });

  it("rejects an empty expression inside a run block's shell comment", () => {
    // The exact shape that broke release.yml.
    const text = [
      "on: workflow_dispatch",
      "jobs:",
      "  cut:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: |",
      "          # through the environment rather than `${{ }}`",
      "          echo hi",
      "",
    ].join("\n");

    expect(check(text, "release.yml").join("\n")).toMatch(/empty expression/);
  });

  it("ignores a YAML comment, which Actions never evaluates", () => {
    const text = ["# `${{ }}` in a real YAML comment is fine", "on: push", "jobs: {}", ""].join("\n");

    expect(check(text)).toEqual([]);
  });

  it("rejects an expression that is never closed", () => {
    const text = ["on: push", "jobs:", "  a:", "    runs-on: ${{ matrix.os", ""].join("\n");

    expect(check(text).join("\n")).toMatch(/unclosed expression/);
  });

  it("rejects a file that does not parse", () => {
    expect(check("on: [push\n").join("\n")).toMatch(/does not parse/);
  });
});
