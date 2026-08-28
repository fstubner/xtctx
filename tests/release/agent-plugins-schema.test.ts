import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `plugin/plugin.json` is the manifest Cursor and VS Code read, and it names
 * the Agent Plugins 1.0 schema in its own `$schema` field. That schema sets
 * `additionalProperties: false`, so one field the spec does not define makes
 * the manifest invalid — and the symptom is a client quietly not recognising
 * the plugin, which looks exactly like a plugin that installs fine everywhere
 * it was tested. A `displayName` was already in there when this was written.
 *
 * The schema is vendored rather than fetched: a network call would make CI
 * fail on HuggingFace-style rate limits and outages, and pinning 1.0.0 is
 * correct anyway, since the manifest declares that exact version. Refresh the
 * fixture from the `$id` URL when moving to a later spec version.
 *
 * This checks the parts of the schema that carry its meaning — required
 * fields, the closed property set, and the declared types — rather than
 * running a full JSON Schema engine, which would be a dependency for a
 * ten-property flat object.
 */
const SCHEMA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "agent-plugins-1.0.0.schema.json",
);

interface JsonSchema {
  $id?: string;
  required: string[];
  additionalProperties: boolean;
  properties: Record<string, { type: string }>;
}

describe("agent plugins manifest", () => {
  it("satisfies the Agent Plugins 1.0 schema it declares", async () => {
    const schema = JSON.parse(await readFile(SCHEMA_PATH, "utf-8")) as JsonSchema;
    const manifest = JSON.parse(
      await readFile(join(process.cwd(), "plugin", "plugin.json"), "utf-8"),
    ) as Record<string, unknown>;

    // The manifest must point at the schema it is being checked against,
    // otherwise this test silently grades it against the wrong spec.
    expect(manifest.$schema).toBe(schema.$id);

    const missing = schema.required.filter((field) => !(field in manifest));
    expect(missing, "required fields").toEqual([]);

    // The closed property set is the whole point: unknown fields are errors,
    // not extras that clients ignore.
    expect(schema.additionalProperties).toBe(false);
    const unknown = Object.keys(manifest).filter((field) => !(field in schema.properties));
    expect(unknown, "fields the spec does not define").toEqual([]);

    const wrongType = Object.entries(manifest)
      .filter(([field]) => field !== "$schema")
      .filter(([field, value]) => {
        const expected = schema.properties[field]?.type;
        const actual = Array.isArray(value) ? "array" : typeof value;
        return expected !== undefined && expected !== actual;
      })
      .map(([field]) => field);
    expect(wrongType, "fields whose type differs from the spec").toEqual([]);
  });
});
