/**
 * Rendering transcript text into somewhere an agent or a terminal will read it.
 *
 * Everything xtctx reads is written by another tool, so its content is not
 * ours to trust — and it lands in two places that treat structure as meaning:
 * a host agent's boot context, where a newline can forge a heading, and a
 * console, where an escape sequence can clear the screen or fake output.
 *
 * This lived as two copies, in `cli/hook.ts` and `mcp/tools/sessions.ts`. They
 * had not drifted, but the bugs around them had the shape that duplication
 * produces: `git_branch`, `git_commit` and `session_ref` each reached a context
 * window unscrubbed while the field beside them was scrubbed correctly, because
 * the rule lived somewhere other than the place you had to remember it. One
 * definition is one place to find it.
 */

/**
 * Collapse untrusted text to a single safe line.
 *
 * Content that cannot start a line cannot forge the headings and fences a
 * reading agent treats as structure, which is what makes collapsing — rather
 * than escaping — the right move for text rendered inline.
 *
 * `\s` does not match ESC or BEL, so collapsing whitespace alone left terminal
 * escape sequences intact on their way to a console. Control characters are
 * replaced rather than stripped, so text either side of one cannot be joined
 * into a word nobody wrote.
 */
export function inlineSafe(value: string): string {
  return replaceControlCharacters(value).replace(/\s+/g, " ").trim();
}

/**
 * Replace control characters with spaces, leaving tab, newline and carriage
 * return for the whitespace collapse to handle.
 * @internal Exported for tests only.
 */
export function replaceControlCharacters(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    const isFormatting = code === 0x09 || code === 0x0a || code === 0x0d;
    out += (code < 0x20 && !isFormatting) || code === 0x7f ? " " : ch;
  }
  return out;
}
