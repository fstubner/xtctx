import { parse as parseToml, stringify as stringifyToml } from "@iarna/toml";

/**
 * Reading and writing the two wire formats tool configs come in.
 *
 * Kept apart from the MCP merge logic because the hard part here is not MCP at
 * all: it is that both formats can carry comments xtctx must not destroy, and
 * the rules for detecting them are format-specific and fiddly enough to be
 * worth reading on their own.
 */
export type ConfigFormat = "json" | "toml";

export function parseConfig(raw: string, format: ConfigFormat): Record<string, unknown> {
  if (format === "toml") {
    return parseToml(raw) as Record<string, unknown>;
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

export function serializeConfig(
  value: Record<string, unknown>,
  format: ConfigFormat,
): string {
  if (format === "toml") {
    // @iarna/toml emits a final newline already; normalise to single trailing.
    return stringifyToml(value as Parameters<typeof stringifyToml>[0]).replace(/\n*$/, "\n");
  }
  return JSON.stringify(value, null, 2) + "\n";
}

/**
 * Does this TOML carry comments we would destroy by rewriting it?
 *
 * `@iarna/toml` parses comments and drops them, so a config that parses
 * cleanly still loses every `#` line when re-serialised. That silently deleted
 * four hand-written comments from a codex config, reported as a successful
 * update. The JSONC path had a guard for exactly this; TOML never reached it
 * because it never failed to parse.
 *
 * A `#` inside a string is data, not a comment, so string state is tracked —
 * otherwise `tag = "release#1"` would make the file permanently unwritable.
 */
export function tomlHasComments(raw: string): boolean {
  // Multi-line strings are the reason this cannot be done line by line. An
  // earlier version reset string state at every newline, so line two of a
  // `"""` block was scanned as if it were outside a string — which both missed
  // a real comment after the block (setup then deleted it) and saw a comment
  // inside one (setup then refused to write a file that had none).
  let multiline: '"""' | "'''" | null = null;
  let inBasic = false;
  let inLiteral = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    if (multiline) {
      // Only the closing delimiter matters; `#` inside is content. Escapes
      // still apply in the basic form, so `\"""` does not close it.
      if (multiline === '"""' && !escaped && raw[index] === "\\") {
        escaped = true;
        continue;
      }
      if (!escaped && raw.startsWith(multiline, index)) {
        index += 2;
        multiline = null;
      }
      escaped = false;
      continue;
    }

    const char = raw[index];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (inBasic && char === "\\") {
      escaped = true;
      continue;
    }
    if (!inBasic && !inLiteral && (raw.startsWith('"""', index) || raw.startsWith("'''", index))) {
      multiline = raw.startsWith('"""', index) ? '"""' : "'''";
      index += 2;
      continue;
    }
    if (char === "\n") {
      // A single-line string cannot span lines, so an unterminated one ends
      // here rather than swallowing the rest of the file.
      inBasic = false;
      inLiteral = false;
      continue;
    }
    if (!inLiteral && char === '"') {
      inBasic = !inBasic;
      continue;
    }
    if (!inBasic && char === "'") {
      inLiteral = !inLiteral;
      continue;
    }
    if (!inBasic && !inLiteral && char === "#") {
      return true;
    }
  }

  return false;
}

/** Remove // and /* *\/ comments outside strings (JSONC tolerance). */
export function stripJsonComments(raw: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      out += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && raw[index + 1] === "/") {
      while (index < raw.length && raw[index] !== "\n") index += 1;
      out += "\n";
      continue;
    }
    if (char === "/" && raw[index + 1] === "*") {
      index += 2;
      while (index < raw.length && !(raw[index] === "*" && raw[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }
    out += char;
  }
  return out;
}
