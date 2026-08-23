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

/**
 * Files SQLite writes beside a database while it is open.
 *
 * Whether these exist depends on whether the tool happened to be running when
 * the fingerprint was captured, not on its format. Recording them reports a
 * changed format for having Antigravity open — and accepting that with
 * `--write` inverts the alarm, so it then reports a change for having it
 * closed. Neither reading is about a format.
 */
export function isTransientSidecar(name) {
  return /\.[A-Za-z0-9]+-(wal|shm|journal)$/.test(name);
}

/**
 * Sorted field entries with empty-array noise removed.
 *
 * `[]` says nothing about what a field holds, so a field recorded as
 * `array<string>` gains a second `array<empty>` entry the first time the tool
 * happens to write an empty one — a property of the data that day, not of the
 * format. That fired the alarm for `toolUseResult.matches` because a search
 * found nothing. Where a path has a typed array, the empty variant is dropped;
 * where empty is all that was ever seen, it stays, because that is all we know.
 */
export function normalizeFieldEntries(entries) {
  const typed = new Set(
    entries
      .filter((entry) => /: array<(?!empty>)[^>]*>$/.test(entry))
      .map((entry) => entry.slice(0, entry.lastIndexOf(": "))),
  );

  return [...new Set(entries)]
    .filter((entry) => {
      if (!entry.endsWith(": array<empty>")) {
        return true;
      }
      return !typed.has(entry.slice(0, entry.lastIndexOf(": ")));
    })
    .sort();
}

/**
 * What is known about a format, accumulated rather than replaced.
 *
 * A capture samples the newest N files, so the window moves as the tool is
 * used: a record type last written a month ago drops out, and the fingerprint
 * reports it as a change for having sampled different files. Merging keeps
 * everything ever recorded, so the alarm only ever fires on something new —
 * which is the question it exists to answer.
 *
 * The cost is that a field genuinely removed upstream is not detected. That
 * was never reliable here anyway: with a moving sample, "gone" and "not
 * sampled this time" are the same observation.
 */
export function mergeFingerprints(previous, next) {
  if (Array.isArray(previous) && Array.isArray(next)) {
    return normalizeFieldEntries([...previous, ...next]);
  }
  if (!isPlainObject(previous) || !isPlainObject(next)) {
    // Scalars and shape changes take the newer value.
    return next;
  }

  const merged = { ...previous };
  for (const [key, value] of Object.entries(next)) {
    merged[key] = key in previous ? mergeFingerprints(previous[key], value) : value;
  }
  return merged;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** True when two serialized fingerprints describe a different shape. */
export function fingerprintsDiffer(previousText, nextText) {
  return normalizeForCompare(previousText) !== normalizeForCompare(nextText);
}
