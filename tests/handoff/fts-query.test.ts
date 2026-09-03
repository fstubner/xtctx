/**
 * The stoplist decides which words a keyword search is allowed to look for,
 * and it has been wrong in both directions.
 *
 * Too short and a question about sourdough returned five results from a
 * TypeScript corpus, because the query contained "how", "do" and "make". Too
 * long and `make`, `get` and `which` were swallowed — a keyword search for
 * `make` returned nothing at all against 1,475 windows, which is the worse
 * failure, because the vocabulary of the thing being searched is exactly what
 * people search for.
 *
 * Neither direction was covered. A mutation sweep found that adding a word to
 * the list passes the whole unit suite, and removing one is caught only by the
 * ranking eval — a slow quality baseline excluded from `npm test`. So the
 * behaviour that broke twice was defended by nothing a developer runs.
 *
 * These pin the contract rather than the list: developer vocabulary survives,
 * bare filler does not, and a query made only of filler finds nothing instead
 * of everything.
 */
import { describe, expect, it } from "vitest";
import { toFtsQuery } from "@xtctx/handoff/queries";

/** The terms an FTS query actually asks for, unquoted. */
function terms(query: string): string[] {
  const fts = toFtsQuery(query);
  return fts === "" ? [] : fts.split(" OR ").map((term) => term.replace(/^"|"$/g, ""));
}

describe("toFtsQuery", () => {
  it("keeps the words a developer would actually search a transcript for", () => {
    // The regression that returned nothing for `make` against 1,475 windows.
    for (const word of ["make", "get", "which", "test", "index", "build", "run"]) {
      expect(terms(`${word} something`), word).toContain(word);
    }
  });

  it("drops bare filler that matches every corpus", () => {
    // Terms are OR-ed, so one filler word anywhere returns a session.
    const asked = terms("how do I use the thing");
    for (const filler of ["how", "the"]) {
      expect(asked, filler).not.toContain(filler);
    }
  });

  it("asks for nothing when the query is nothing but filler", () => {
    // "No results" is the honest answer; matching on "how" is not.
    expect(toFtsQuery("how do the")).toBe("");
  });

  it("keeps identifier-shaped terms intact", () => {
    expect(terms("src/handoff/ranking.ts")).toContain("src/handoff/ranking.ts");
    expect(terms("session_ref")).toContain("session_ref");
  });

  it("cannot be broken out of by a quote in the query", () => {
    // Terms are wrapped in quotes and interpolated into FTS syntax, so a
    // quote that survived tokenizing would end the phrase early and change
    // what is being asked. Two things stop that and only one is reachable:
    // the term pattern does not admit a quote character at all, so the
    // `""` escaping below it is belt-and-braces that never fires.
    expect(terms('say "hello" world')).toEqual(["say", "hello", "world"]);
    expect(toFtsQuery('say "hello"')).toBe('"say" OR "hello"');
  });
});
