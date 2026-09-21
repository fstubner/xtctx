/**
 * Describing a transcript record by its shape, never its content.
 *
 * Extracted from the capture script so the fixture-fidelity test can describe a
 * seeded record the same way the committed fingerprint describes a real one.
 * Two implementations of this would make that comparison meaningless: the test
 * would be checking that two different descriptions of the same record agree,
 * which they would not.
 */

/** Type name of a value — the only thing recorded about it. */
export function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    const inner = [...new Set(value.slice(0, 20).map(typeOf))].sort();
    return inner.length === 0 ? "array<empty>" : `array<${inner.join("|")}>`;
  }
  return typeof value;
}

const UUID_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPAQUE_KEY = /^[0-9a-f]{16,}$/i;
const SCHEMA_KEY = /^[A-Za-z0-9_$.:@-]{1,64}$/;

/**
 * A field name is safe to record; a map key is not.
 *
 * Some of these objects are dictionaries keyed by data rather than by schema —
 * cursor stores per-file state under the file's URI, so a naive walk wrote
 * absolute paths from unrelated private projects straight into a committed
 * fingerprint. Anything that does not look like an identifier, plus ids that
 * do, collapse to `*`: the shape underneath is still recorded, the key is not.
 */
export function schemaKey(key) {
  if (!SCHEMA_KEY.test(key)) return "*";
  if (UUID_KEY.test(key) || OPAQUE_KEY.test(key)) return "*";
  return key;
}

/** How many elements of an array are shaped. Matches `typeOf`'s own sample. */
const ARRAY_SAMPLE = 20;

/**
 * Flatten an object into "path: type" entries, descending into arrays.
 *
 * Arrays used to stop at `path: array<object>` — the docstring claimed "one
 * level of arrays" and the code did none. That made the whole drift mechanism
 * blind to any change inside an array, and Claude Code's entire assistant
 * payload is one: `message.content[]`. Measured before the fix,
 * `{content:[{type,text}]}` and `{content:[{kind,body}]}` produced byte-
 * identical shape sets, so a wholesale upstream rename inside that array was
 * indistinguishable from no change at all.
 *
 * That matters more than an ordinary gap because it is load-bearing twice:
 * `capture:formats` reports drift from it, and `tests/drift/fixture-fidelity`
 * asserts through it in `verify:release` and in CI. Both reported agreement
 * they had not established.
 *
 * Elements are shaped under a `path[]` prefix, sampled like `typeOf` samples,
 * and the union across elements is kept — a heterogeneous array records every
 * variant it holds rather than only the first.
 */
export function shapeOf(value, prefix = "", out = new Set(), depth = 0) {
  if (depth > 4 || value === null || typeof value !== "object") {
    if (prefix) out.add(`${prefix}: ${typeOf(value)}`);
    return out;
  }

  if (Array.isArray(value)) {
    // The array's own type is still recorded, so an array becoming a scalar is
    // still visible even when the elements shape to nothing.
    if (prefix) out.add(`${prefix}: ${typeOf(value)}`);
    for (const element of value.slice(0, ARRAY_SAMPLE)) {
      shapeOf(element, `${prefix}[]`, out, depth + 1);
    }
    return out;
  }

  for (const [rawKey, inner] of Object.entries(value)) {
    const key = schemaKey(rawKey);
    const path = prefix ? `${prefix}.${key}` : key;
    if (inner !== null && typeof inner === "object") {
      shapeOf(inner, path, out, depth + 1);
    } else {
      out.add(`${path}: ${typeOf(inner)}`);
    }
  }
  return out;
}
