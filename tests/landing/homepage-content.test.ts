/**
 * The claims on the page visitors actually see.
 *
 * This used to read `v9.astro`, which is a design draft carrying
 * `noindex,nofollow`. The real homepage is `index.astro` — Nav, Hero,
 * Workflow, Surfaces, Install, Faq, Footer, all fed from `data/site.ts` — and
 * nothing pinned it, so the product claims and the punctuation rules were
 * enforced only on a page nobody is sent to. Retargeting immediately found two
 * em dashes in live hero and install copy that the draft-only check had never
 * looked at.
 *
 * Source text, not rendered output, and the limit of that is worth stating: a
 * claim wrapped in `{false && (…)}` would still satisfy every assertion below.
 * Rendering means an astro build, which costs more in the unit suite than it
 * buys here — `npm run landing:build` already runs in `verify:release` and in
 * CI, so a page that cannot build is caught there.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const LANDING = join(process.cwd(), "landing", "src");

/** Every source file that composes the homepage, concatenated. */
async function homepageSources(): Promise<string> {
  const files = [
    join(LANDING, "pages", "index.astro"),
    join(LANDING, "data", "site.ts"),
    ...["Nav", "Hero", "Workflow", "Surfaces", "Install", "Faq", "Footer", "IdeMock", "TerminalMock"].map(
      (name) => join(LANDING, "components", `${name}.astro`),
    ),
  ];
  const parts = await Promise.all(files.map((file) => readFile(file, "utf-8")));
  return parts.join("\n");
}

describe("the homepage visitors are sent to", () => {
  it("names the five MCP tools the product actually exposes", async () => {
    const page = await homepageSources();

    for (const tool of [
      "xtctx_recent_sessions",
      "xtctx_session_detail",
      "xtctx_search_sessions",
      "xtctx_continuity_status",
      "xtctx_handoff_manifest",
    ]) {
      expect(page, `homepage should name ${tool}`).toContain(tool);
    }
  });

  it("gives the install command the README gives", async () => {
    const page = await homepageSources();

    expect(page).toContain("npx -y xtctx setup");
  });

  it("still says the thing that makes the product what it is", async () => {
    const page = await homepageSources();

    // PRODUCT.md's first constraint. Deliberately not a ban on the words
    // "daemon" or "dashboard": the page uses them to say it has neither, and a
    // substring check flagged that correct copy as a false promise. Asserting
    // the commitment is present is the check that survives rewording of the
    // sentence around it.
    expect(page.toLowerCase()).toContain("local-only");
  });

  it("does not promise retrieval without setup", async () => {
    const page = await homepageSources();

    // The page's central pitch was false. It said "Install the plugin and
    // retrieval works, with no project setup required", with a proof chip
    // reading "No project setup required" and an FAQ answering "No" to
    // whether setup is needed per project — while `server.ts` points every
    // tool at `notConfigured()` in a project with no `.xtctx/config.yaml`,
    // and README.md's own table says "Retrieval in an unconfigured project:
    // no (offers setup)". The same wrong belief was in the published plugin's
    // skill text.
    const lowered = page.toLowerCase();
    expect(lowered).not.toContain("no project setup required");
    expect(lowered).not.toContain("with no setup at all");
    expect(lowered).not.toContain("retrieval works straight away");
  });

  it("keeps em and en dashes out of the copy", async () => {
    const page = await homepageSources();

    expect(page).not.toContain("—");
    expect(page).not.toContain("–");
  });
});
