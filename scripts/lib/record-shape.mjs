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

/** Flatten an object into "path: type" entries, one level of arrays. */
export function shapeOf(value, prefix = "", out = new Set(), depth = 0) {
  if (depth > 4 || value === null || typeof value !== "object" || Array.isArray(value)) {
    if (prefix) out.add(`${prefix}: ${typeOf(value)}`);
    return out;
  }
  for (const [rawKey, inner] of Object.entries(value)) {
    const key = schemaKey(rawKey);
    const path = prefix ? `${prefix}.${key}` : key;
    if (inner !== null && typeof inner === "object" && !Array.isArray(inner)) {
      shapeOf(inner, path, out, depth + 1);
    } else {
      out.add(`${path}: ${typeOf(inner)}`);
    }
  }
  return out;
}
