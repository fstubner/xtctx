/**
 * Comparison rules for committed format fingerprints.
 *
 * Extracted from the capture script so they can be tested directly. Both rules
 * exist because the naive comparison — serialize, compare the strings — fired
 * on things that are not format changes, and an alarm that fires on an
 * unchanged store is one nobody reads.
 */

/**
 * Volume counters record how much was sampled, not what shape was found. They
 * move whenever the user has done more work, so leaving them inside the
 * compared payload guarantees a permanent diff. They are still reported to the
 * console; they are just not part of what "changed" means.
 */
const VOLUME_COUNTERS = new Set(["filesSampled", "recordsSampled"]);

export function withoutVolumeCounters(value) {
  if (Array.isArray(value)) {
    return value.map(withoutVolumeCounters);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !VOLUME_COUNTERS.has(key))
      .map(([key, inner]) => [key, withoutVolumeCounters(inner)]),
  );
}

/**
 * Serialize for comparison and for writing.
 *
 * Always LF. `core.autocrlf` is on by default on Windows, so a committed
 * fingerprint can come back off a checkout with CRLF while the script writes
 * LF — which made every line differ and reported a changed format forever on a
 * store that had not moved. A .gitattributes rule pins the committed form; this
 * makes the comparison itself immune either way.
 */
export function serializeFingerprint(fingerprint) {
  return JSON.stringify(withoutVolumeCounters(fingerprint), null, 2) + "\n";
}

export function normalizeForCompare(text) {
  return text.replace(/\r\n/g, "\n");
}

/** True when two serialized fingerprints describe a different shape. */
export function fingerprintsDiffer(previousText, nextText) {
  return normalizeForCompare(previousText) !== normalizeForCompare(nextText);
}
