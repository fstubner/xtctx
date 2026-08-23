/**
 * Types for the fingerprint comparison helpers.
 *
 * The implementation is plain Node ESM — it runs from `npm run capture:formats`
 * without a build step — but its tests are TypeScript, and they were importing
 * it behind a `@ts-expect-error` that suppressed nothing useful. Declaring the
 * surface means the tests check these signatures rather than working blind.
 */

/** A parsed fingerprint: nested objects, arrays of "name: type" entries. */
export type Fingerprint = Record<string, unknown>;

export function withoutVolumeCounters(value: unknown): unknown;

export function serializeFingerprint(fingerprint: unknown): string;

export function normalizeForCompare(text: string): string;

export function fingerprintsDiffer(previousText: string, nextText: string): boolean;

export function isTransientSidecar(name: string): boolean;

export function normalizeFieldEntries(entries: string[]): string[];

// Returns the merged structure. Typed loosely on purpose: this walks arbitrary
// JSON whose shape differs per tool, and pinning it would mean describing every
// fingerprint variant in a file that exists to serve one script.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mergeFingerprints(previous: unknown, next: unknown): any;
