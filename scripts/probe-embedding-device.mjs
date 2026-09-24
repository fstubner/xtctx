#!/usr/bin/env node
/**
 * Which ONNX execution providers can this machine actually embed on, and do
 * they agree with the CPU?
 *
 * `docs/embedding-performance.md` measured DirectML at ~6x the CPU path with
 * numerically identical vectors, and stopped there: DirectML is Windows-only,
 * WebGPU is the portable candidate, and WebGPU had only ever been run on one
 * machine. Implementing device selection on a sample of one is how a fallback
 * path ships broken — it works for whoever wrote it and silently throws, or
 * silently returns different vectors, everywhere else.
 *
 * This script is the evidence. It is deliberately not a test: it downloads a
 * model, takes tens of seconds, and its output is a report to read rather than
 * an assertion to pass. `.github/workflows/embedding-device-probe.yml` runs it
 * on ubuntu, windows and macos runners so the report covers three operating
 * systems and three GPU situations instead of this one desk.
 *
 * Two things are being asked, and only the first is about speed:
 *
 *   1. Does the device initialise and embed at all?
 *   2. Are its vectors the same as the CPU's?
 *
 * (2) is the one that decides whether a fallback can be silent. Identical
 * vectors mean a machine that falls back to CPU is running the same index as
 * a machine that does not, and no re-embed or threshold re-sweep is implied.
 * Vectors that drift mean device choice is part of vector identity, the way
 * dtype would have to be, and that is a much larger change.
 *
 * Each device runs in its OWN PROCESS. Two providers in one process fail
 * intermittently with `bad allocation`; the parent below spawns itself per
 * device for that reason, not for isolation of timings.
 *
 * Usage:
 *   node scripts/probe-embedding-device.mjs            # all devices, report
 *   node scripts/probe-embedding-device.mjs --json     # machine-readable only
 *   node scripts/probe-embedding-device.mjs --json-also # report, then JSON
 *   node scripts/probe-embedding-device.mjs --device=webgpu --child  # one
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Candidates, in the order a fallback chain would try them.
 *
 * `auto` is what @huggingface/transformers picks when `device` is not passed —
 * which is what xtctx did before calibration existed, so it is the baseline any
 * change is measured against, not a fourth option.
 */
const DEVICES = ["cpu", "dml", "webgpu", "auto"];

// Kept in step with DEFAULT_EMBEDDING_MODEL in src/handoff/embeddings.ts by
// hand: this runs without a build, so it cannot import the TypeScript. It was
// still measuring MiniLM for two days after the default moved to bge-small.
const MODEL = "Xenova/bge-small-en-v1.5";
const DTYPE = "fp32";
/**
 * Enough segments for a timing to mean something, few enough that a CI runner
 * with no GPU finishes the CPU arm in a couple of minutes.
 */
const SEGMENT_COUNT = 48;
const SEGMENT_CHARS = 1000;

/**
 * Deterministic filler at the length real segments have.
 *
 * Not real transcript text — that is private, and this is not measuring
 * retrieval quality. It IS measuring per-segment cost, where length is the
 * term that matters: an earlier round of this work benchmarked strings like
 * `warm query number 5`, concluded a heavier model was affordable, and shipped
 * a change that had to be reverted the next day. A segment is ~1024
 * characters, the model's full sequence window, and that is what this feeds it.
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
      // xorshift: reproducible across platforms and Node versions, unlike
      // anything seeded from Math.random or from the clock.
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

async function runOneDevice(device, vectorPath) {
  const segments = buildSegments();
  const transformers = await import("@huggingface/transformers");

  const options = { dtype: DTYPE };
  // `auto` means "pass nothing", which is today's behaviour.
  if (device !== "auto") {
    options.device = device;
  }

  const loadStart = performance.now();
  const extractor = await transformers.pipeline("feature-extraction", MODEL, options);
  const loadMs = performance.now() - loadStart;

  // One untimed batch first: the first call carries graph compilation and
  // buffer allocation, which is a one-off cost and not what per-segment
  // throughput means.
  await extractor(segments.slice(0, 4), { pooling: "mean", normalize: true });

  const cpuBefore = process.cpuUsage();
  const embedStart = performance.now();
  const output = await extractor(segments, { pooling: "mean", normalize: true });
  const embedMs = performance.now() - embedStart;
  const cpuAfter = process.cpuUsage(cpuBefore);

  const flat = Float32Array.from(output.data);
  const dimensions = flat.length / segments.length;
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(`unexpected output shape: ${flat.length} for ${segments.length} segments`);
  }
  if (vectorPath) {
    writeFileSync(vectorPath, Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength));
  }

  const cpuMs = (cpuAfter.user + cpuAfter.system) / 1000;
  return {
    device,
    ok: true,
    loadMs: Math.round(loadMs),
    msPerSegment: Number((embedMs / segments.length).toFixed(1)),
    coresUsed: Number((cpuMs / embedMs).toFixed(1)),
    dimensions,
    segments: segments.length,
  };
}

/**
 * Worst and mean cosine between two runs' vectors for the same segments.
 *
 * Both sides are already L2-normalized by the pipeline, so a dot product is
 * the cosine. Worst pair is the number that matters — a mean of 1.000000 with
 * one pair at 0.97 is still a vector space that moved.
 */
function compareVectors(pathA, pathB, dimensions) {
  const a = new Float32Array(toArrayBuffer(readFileSync(pathA)));
  const b = new Float32Array(toArrayBuffer(readFileSync(pathB)));
  if (a.length !== b.length) {
    return { comparable: false, reason: `dimension mismatch: ${a.length} vs ${b.length}` };
  }

  let total = 0;
  let worst = 1;
  const count = a.length / dimensions;
  for (let index = 0; index < count; index += 1) {
    let dot = 0;
    for (let d = 0; d < dimensions; d += 1) {
      dot += a[index * dimensions + d] * b[index * dimensions + d];
    }
    total += dot;
    worst = Math.min(worst, dot);
  }
  return {
    comparable: true,
    meanCosine: Number((total / count).toFixed(6)),
    worstCosine: Number(worst.toFixed(6)),
  };
}

function toArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

async function child(device) {
  const vectorPath = process.env.XTCTX_PROBE_VECTORS ?? "";
  try {
    const result = await runOneDevice(device, vectorPath);
    process.stdout.write(`\n__PROBE__${JSON.stringify(result)}\n`);
  } catch (error) {
    // A device that cannot initialise is a RESULT, not a crash — "webgpu is
    // unavailable on this runner" is exactly what the probe exists to learn.
    process.stdout.write(
      `\n__PROBE__${JSON.stringify({
        device,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
  }
}

async function parent(asJson) {
  const workDir = mkdtempSync(join(tmpdir(), "xtctx-probe-"));
  const results = [];
  try {
    for (const device of DEVICES) {
      const vectorPath = join(workDir, `${device}.f32`);
      const run = spawnSync(
        process.execPath,
        [process.argv[1], `--device=${device}`, "--child"],
        {
          encoding: "utf-8",
          env: { ...process.env, XTCTX_PROBE_VECTORS: vectorPath },
          // The model download is minutes on a cold CI cache.
          timeout: 15 * 60 * 1000,
          maxBuffer: 64 * 1024 * 1024,
        },
      );
      const marker = `${run.stdout ?? ""}\n${run.stderr ?? ""}`.match(/__PROBE__(.*)/);
      if (!marker) {
        results.push({
          device,
          ok: false,
          error: `child produced no result (status ${run.status}): ${(run.stderr ?? "").trim().slice(-400)}`,
        });
        continue;
      }
      const result = JSON.parse(marker[1]);
      if (result.ok) {
        result.vectorPath = vectorPath;
      }
      results.push(result);
    }

    const cpu = results.find((result) => result.device === "cpu" && result.ok);
    for (const result of results) {
      if (!result.ok || !cpu || result.device === "cpu") continue;
      result.vsCpu = compareVectors(cpu.vectorPath, result.vectorPath, cpu.dimensions);
    }

    for (const result of results) delete result.vectorPath;
    report(results, asJson);
    return results;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function report(results, asJson) {
  const json = () =>
    process.stdout.write(
      `${JSON.stringify({ platform: process.platform, arch: process.arch, results }, null, 2)}\n`,
    );
  if (asJson === "only") {
    json();
    return;
  }

  const cpu = results.find((result) => result.device === "cpu" && result.ok);
  process.stdout.write(`\nEmbedding device probe — ${process.platform}/${process.arch}, node ${process.version}\n`);
  process.stdout.write(`model ${MODEL} ${DTYPE}, ${SEGMENT_COUNT} segments of ${SEGMENT_CHARS} chars\n\n`);
  process.stdout.write("device   status       ms/segment  vs cpu  cores  load ms\n");
  for (const result of results) {
    if (!result.ok) {
      process.stdout.write(`${result.device.padEnd(8)} unavailable  ${result.error.slice(0, 60)}\n`);
      continue;
    }
    const speedup = cpu ? `${(cpu.msPerSegment / result.msPerSegment).toFixed(1)}x` : "—";
    const agreement = result.vsCpu
      ? result.vsCpu.comparable
        ? `worst cosine ${result.vsCpu.worstCosine}`
        : result.vsCpu.reason
      : "baseline";
    process.stdout.write(
      `${result.device.padEnd(8)} ok           ${String(result.msPerSegment).padEnd(11)} ${speedup.padEnd(7)} ${String(result.coresUsed).padEnd(6)} ${result.loadMs}\n`,
    );
    process.stdout.write(`${" ".repeat(9)}${agreement}\n`);
  }
  process.stdout.write("\n");
  if (asJson === "also") json();
}

const isChild = process.argv.includes("--child");
const deviceArg = process.argv.find((argument) => argument.startsWith("--device="));

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (isChild) {
    await child(deviceArg ? deviceArg.slice("--device=".length) : "auto");
  } else {
    await parent(
      process.argv.includes("--json") ? "only" : process.argv.includes("--json-also") ? "also" : "",
    );
  }
}

export { DEVICES, buildSegments, compareVectors, runOneDevice };
