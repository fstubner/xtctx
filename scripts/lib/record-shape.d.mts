/** Types for the record-shape helpers. See record-shape.mjs. */

export function typeOf(value: unknown): string;

export function schemaKey(key: string): string;

export function shapeOf(
  value: unknown,
  prefix?: string,
  out?: Set<string>,
  depth?: number,
): Set<string>;
