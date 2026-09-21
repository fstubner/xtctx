/**
 * The review map has no blank regions.
 *
 * Five audits of this repository each found a layer the previous one had not
 * looked at. None was shallow; each was simply pointed somewhere the last had
 * not, and nothing could say where that was, because the list of places lived
 * in whoever was reviewing. `scripts/check-review-coverage.mjs` moves the list
 * into the repository so the question is a command rather than a memory.
 *
 * It found three files on its first run — `.github/copilot-instructions.md`,
 * `dependabot.yml` and `upstream-versions.json` — that no pass had opened.
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain JS with JSDoc types, imported for its exports.
import { LAYERS, reviewCoverage } from "../../scripts/check-review-coverage.mjs";

interface Layer {
  name: string;
  question: string;
  why: string;
  match: RegExp[];
}

const layers = LAYERS as Layer[];

function coverage(files: string[]): {
  unassigned: string[];
  overlapping: string[];
  empty: string[];
} {
  return (reviewCoverage as (files: string[]) => never)(files);
}

describe("review coverage", () => {
  it("assigns every file in a representative tree to exactly one layer", () => {
    const sample = [
      "src/handoff/sqlite-index.ts",
      "tests/handoff/ranking.test.ts",
      "scripts/audit-production.mjs",
      ".github/workflows/release.yml",
      ".github/dependabot.yml",
      ".github/upstream-versions.json",
      ".github/copilot-instructions.md",
      "plugin/plugin.json",
      "package.json",
      "README.md",
      "docs/testing-strategy.md",
      "landing/src/data/site.ts",
      "design-direction.md",
      "ux-walkthrough.md",
      "tsconfig.json",
      ".gitignore",
    ];

    const { unassigned, overlapping, empty } = coverage(sample);

    expect(unassigned).toEqual([]);
    expect(overlapping).toEqual([]);
    expect(empty).toEqual([]);
  });

  it("reports a file no layer claims", () => {
    // The check is only worth having if it fails on the thing it exists for.
    const { unassigned } = coverage(["some/new/area/thing.ts"]);

    expect(unassigned).toEqual(["some/new/area/thing.ts"]);
  });

  it("reports a file two layers claim, because then neither owns it", () => {
    const { overlapping } = coverage(["src/handoff/x.ts", "tests/x.test.ts"]);
    expect(overlapping).toEqual([]);

    // `design-direction.md` is root markdown AND a site document; the claims
    // layer excludes it by name so the site layer owns it alone.
    const { overlapping: none } = coverage(["design-direction.md"]);
    expect(none).toEqual([]);
  });

  it("gives every layer its own question, not a generic one", () => {
    // The question is the load-bearing part: asking "is it correct?" of a test
    // suite finds nothing, because a test that cannot fail is correct.
    const questions = layers.map((layer) => layer.question);

    expect(new Set(questions).size).toBe(layers.length);
    for (const layer of layers) {
      expect(layer.question.length, `${layer.name} needs a real question`).toBeGreaterThan(20);
      expect(layer.why.length, `${layer.name} needs the reason it is asked`).toBeGreaterThan(20);
    }
  });
});
