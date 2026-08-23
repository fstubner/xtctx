import { describe, expect, it } from "vitest";
import { tomlHasComments } from "@xtctx/config/mcp-config";

/**
 * Whether a TOML config carries comments decides whether setup may rewrite it,
 * so both answers are destructive when wrong: a false negative deletes the
 * user's comments, a false positive refuses to wire up a tool and tells them
 * to remove comments that are not there.
 *
 * The first version reset string state at every newline, so line two of a
 * `"""` block was scanned as if it were outside a string — and it got both
 * directions wrong.
 */
describe("tomlHasComments", () => {
  const cases: Array<[string, string, boolean]> = [
    ["a whole-line comment", "# note\nmodel = \"x\"\n", true],
    ["a trailing comment", "model = \"x\" # note\n", true],
    ["nothing at all", "model = \"x\"\n", false],
    ["a hash inside a basic string", "tag = \"release#1\"\n", false],
    ["a hash inside a literal string", "path = 'C:\\a#b'\n", false],
    ["a hash inside an escaped quote", 's = "he said \\"hi#\\""\n', false],
    ["a hash in a quoted key", '"a#b" = 1\n', false],
    ["a comment after a multi-line basic string", 'a = """\ntext\n""" # real\n', true],
    ["a hash inside a multi-line basic string", 'a = """\nhas # here\n"""\n', false],
    ["a hash inside a multi-line literal string", "a = '''\nhas # here\n'''\n", false],
    ["a comment after a multi-line literal string", "a = '''\ntext\n''' # real\n", true],
    ["a comment before a multi-line string", '# lead\na = """\ntext\n"""\n', true],
    ["an unterminated basic string, then a hash", 'a = "oops\n# note\n', true],
  ];

  for (const [label, toml, expected] of cases) {
    it(`${expected ? "finds" : "ignores"} ${label}`, () => {
      expect(tomlHasComments(toml)).toBe(expected);
    });
  }
});
