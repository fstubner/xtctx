#!/usr/bin/env node
/**
 * How many segments should go to the model at once, measured per device.
 *
 * `docs/embedding-performance.md` recorded 16 beating the current 32 by
 * 10–20% and declined to act on it: "the absolute numbers are noisy and the
 * sample is three pairs, so this is a consistent direction rather than a
 * settled figure. Before changing the constant it deserves more repetitions
 * on a quiet machine, including 24."
 *
 * That table is also entirely CPU. `MAX_BATCH_SIZE` now applies on whatever
 * device `xtctx calibrate` picked, and batching economics are not the same on
 * a GPU — the whole reason a GPU helps is that it does wide work in parallel,
 * so the size that wins on eleven CPU cores has no reason to win there.
 *
 * Two lessons from the device probe are built in, because both changed an
 * answer there:
 *
 *   A short warmup measures a device that is still starting up. The first
 *   call carries graph compilation and buffer allocation, which inverted the
 *   dml/webgpu ranking until the warmup became a full pass.
 *
 *   One timed pass is not a measurement. Other load on the machine only ever
 *   makes a pass slower, so the fastest of several is the closest this gets to
 *   the device's real throughput.
 *
 * Unlike the device probe this does NOT need a process per configuration —
 * batch size is a loop parameter over one already-loaded pipeline, and it is
 * two providers in one process that fail with `bad allocation`, not two batch
 * sizes.
 *
 *   node scripts/probe-batch-size.mjs --device=cpu
 *   node scripts/probe-batch-size.mjs --device=dml
 *
 * READ THIS BEFORE BELIEVING ITS OUTPUT. On 2026-09-21 it said DirectML wanted
 * the largest batch available — 4.0ms/segment at 128 against 5.3 at 32,
 * reproducing across runs — and acting on that was a 5x REGRESSION when
 * measured through `xtctx scan --embed` on the real index. The segments here
 * are all exactly the same length; real ones are not, and a batch is padded to
 * its longest member, so uniform inputs hide the dominant cost of the real
 * workload. This script is useful for comparing devices at a FIXED batch size.
 * It is not evidence for choosing one. See `MAX_BATCH_SIZE`.
 */
import { parseArgs } from "node:util";

const MODEL = "Xenova/bge-small-en-v1.5";
const DTYPE = "fp32";
const DEFAULT_BATCH_SIZES = [8, 16, 24, 32, 64];
/** Enough that even the largest batch runs twice, so batching is exercised. */
const SEGMENT_COUNT = 128;
const SEGMENT_CHARS = 1000;
const PASSES = 3;

/**
 * Deterministic text at the length real segments have.
 *
 * Length is the term that matters: an earlier round of this work benchmarked
 * strings like `warm query number 5`, concluded a heavier model was
 * affordable, and shipped a change reverted the next day.
 */
function buildSegments() {
  const words = [
    "session", "transcript", "index", "vector", "window", "segment", "scraper",
    "handoff", "retrieval", "keyword", "semantic", "threshold", "cosine",
    "database", "migration", "config", "project", "message", "timestamp", "tool",
  ];
  const segments = [];
  let seed = 1;
  for (let index = 0; index < SEGMENT_COUNT; index += 1) {
    let text = "";
    while (text.length < SEGMENT_CHARS) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      seed >>>= 0;
      text += `${words[seed % words.length]} `;
    }
    segments.push(text.slice(0, SEGMENT_CHARS));
  }
  return segments;
}

async function embedAll(extractor, segments, batchSize) {
  for (let start = 0; start < segments.length; start += batchSize) {
    await extractor(segments.slice(start, start + batchSize), {
      pooling: "mean",
      normalize: true,
    });
  }
}

const { values } = parseArgs({
  options: {
    device: { type: "string", default: "cpu" },
    /** `--batches=2,4,8` to look closely at one end. */
    batches: { type: "string" },
  },
  strict: false,
});
const device = String(values.device);
const BATCH_SIZES = values.batches
  ? String(values.batches).split(",").map((size) => Number.parseInt(size, 10))
  : DEFAULT_BATCH_SIZES;

const segments = buildSegments();
const transformers = await import("@huggingface/transformers");
const options = { dtype: DTYPE };
if (device !== "auto") {
  options.device = device;
}

const extractor = await transformers.pipeline("feature-extraction", MODEL, options);

// A full untimed pass at the largest batch, so every allocation this run will
// ever need has already happened before anything is timed.
await embedAll(extractor, segments, Math.max(...BATCH_SIZES));

process.stdout.write(
  `\n${MODEL} ${DTYPE} on ${device} — ${SEGMENT_COUNT} segments of ${SEGMENT_CHARS} chars, best of ${PASSES}\n\n`,
);
process.stdout.write("batch  ms/segment  vs 32   cores\n");

const results = [];
for (const batchSize of BATCH_SIZES) {
  let best = Number.POSITIVE_INFINITY;
  let bestCores = 0;
  for (let pass = 0; pass < PASSES; pass += 1) {
    const cpuBefore = process.cpuUsage();
    const startedAt = performance.now();
    await embedAll(extractor, segments, batchSize);
    const elapsed = performance.now() - startedAt;
    const cpuAfter = process.cpuUsage(cpuBefore);
    if (elapsed < best) {
      best = elapsed;
      bestCores = (cpuAfter.user + cpuAfter.system) / 1000 / elapsed;
    }
  }
  results.push({ batchSize, msPerSegment: best / segments.length, cores: bestCores });
}

const baseline = results.find((row) => row.batchSize === 32)?.msPerSegment;
for (const row of results) {
  const ratio = baseline ? `${(baseline / row.msPerSegment).toFixed(2)}x` : "—";
  process.stdout.write(
    `${String(row.batchSize).padEnd(6)} ${row.msPerSegment.toFixed(2).padEnd(11)} ` +
      `${ratio.padEnd(7)} ${row.cores.toFixed(1)}\n`,
  );
}
process.stdout.write("\n");
