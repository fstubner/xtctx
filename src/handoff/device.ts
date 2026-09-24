import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { cpus, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_EMBEDDING_DTYPE, DEFAULT_EMBEDDING_MODEL } from "./embeddings.js";

/**
 * Which ONNX execution provider the local model runs on.
 *
 * `cpu` is what the product used until this existed — passing no `device` at
 * all measured identical to `cpu` on all three operating systems, so the GPU
 * was not merely underused, it was unused.
 */
export type EmbeddingDevice = "cpu" | "dml" | "webgpu";

/**
 * Candidates worth trying here, cheapest signal first.
 *
 * Platform-filtered because asking for a device the runtime does not build is
 * an immediate throw rather than a measurement: `dml` answers `Unsupported
 * device: "dml". Should be one of: coreml, webgpu, cpu` on macOS and
 * `cuda, webgpu, cpu` on Linux.
 *
 * On Windows, `dml` failing is ALSO the adapter check. `onnxruntime-node`
 * ships `DirectML.dll` in the package this project already installs, and on a
 * machine with no real display adapter it refuses with `Specified display
 * adapter handle is invalid` rather than quietly falling back — measured on a
 * GitHub windows-latest runner against this maintainer's desktop, where it was
 * the fastest device of the three. That matters because Windows is the one
 * platform where WebGPU does NOT refuse: see `calibrate` below.
 */
export function deviceCandidates(platform = process.platform): EmbeddingDevice[] {
  if (platform === "win32") return ["cpu", "dml", "webgpu"];
  return ["cpu", "webgpu"];
}

export interface DeviceVerdict {
  device: EmbeddingDevice;
  /** Every candidate that ran, so a surprising verdict can be argued with. */
  measured: Array<{ device: EmbeddingDevice; msPerSegment: number | null; error?: string }>;
  fingerprint: string;
  measuredAt: string;
}

/**
 * Identity of the thing that was measured.
 *
 * A verdict is about this machine running this model at this precision, so all
 * three are in the key along with the core count — the CPU arm's speed is what
 * the GPU has to beat, and a 24-core desktop and a 4-core laptop reach
 * different answers from the same hardware.
 */
export function deviceFingerprint(
  model = DEFAULT_EMBEDDING_MODEL,
  dtype = DEFAULT_EMBEDDING_DTYPE,
): string {
  return [process.platform, process.arch, `cores=${cpus().length}`, model, dtype].join("|");
}

function cachePath(home = homedir()): string {
  // User-level, not project-level: the answer is about the hardware, and a
  // second project on the same machine has already paid for it.
  return join(home, ".xtctx", "device.json");
}

/**
 * The cached verdict, or null when there is none for this exact configuration.
 *
 * Never throws. A machine that cannot read its own cache runs on CPU, which is
 * what it did before any of this existed.
 */
export async function readDeviceVerdict(options: {
  home?: string;
  fingerprint?: string;
} = {}): Promise<DeviceVerdict | null> {
  const fingerprint = options.fingerprint ?? deviceFingerprint();
  try {
    const raw = await readFile(cachePath(options.home), "utf-8");
    const parsed = JSON.parse(raw) as DeviceVerdict;
    if (parsed.fingerprint !== fingerprint) {
      // Different machine, model or precision — the old answer is about
      // something else, not merely stale.
      return null;
    }
    if (!deviceCandidates().includes(parsed.device)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Written to a temporary file and renamed into place.
 *
 * Several MCP servers start at once on a fresh machine — one per agent — and a
 * plain `writeFile` truncates before it writes, so a server reading the verdict
 * mid-write saw half a file. `readDeviceVerdict` treats that as no verdict,
 * which is safe but means calibrating again for nothing. A rename is atomic on
 * one filesystem, so a reader sees the old file or the new one.
 */
async function writeDeviceVerdict(verdict: DeviceVerdict, home?: string): Promise<void> {
  const path = cachePath(home);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(verdict, null, 2)}\n`, "utf-8");
  await rename(temporary, path);
}

/**
 * How long a calibration lock is honoured before it is treated as abandoned.
 *
 * Longer than any calibration measured (about a minute, three devices, each
 * with a model load), shorter than a user would notice as "it never
 * calibrates". A lock older than this belongs to a process that was killed —
 * the server exits two seconds after its client disconnects, whatever it was
 * doing — and must not block every later attempt.
 */
const LOCK_STALE_MS = 10 * 60 * 1000;

/** Thrown when another process is already calibrating this machine. */
export class CalibrationBusyError extends Error {
  constructor() {
    super("another process is already calibrating this machine");
  }
}

/**
 * Take the machine-wide calibration lock, or throw `CalibrationBusyError`.
 *
 * One per machine, not per project, because the verdict is per machine.
 * Without it, every agent that starts an MCP server on a fresh machine
 * calibrates at once: three servers, each timing up to three devices, all
 * loading the model together — and each one's CPU arm timed while the others
 * compete for the same cores, the measurement contaminated by the act of
 * measuring.
 */
async function acquireCalibrationLock(home?: string): Promise<() => Promise<void>> {
  const path = `${cachePath(home)}.lock`;
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx");
      await handle.writeFile(String(process.pid));
      await handle.close();
      return () => unlink(path).catch(() => {});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const modified = await stat(path).catch(() => null);
      if (modified && Date.now() - modified.mtimeMs < LOCK_STALE_MS) {
        throw new CalibrationBusyError();
      }
      await unlink(path).catch(() => {});
    }
  }
  throw new CalibrationBusyError();
}

/**
 * Calibration workers still running, so they can be killed on exit.
 *
 * The MCP server leaves by `process.exit` two seconds after its client goes.
 * A spawned child is not killed with its parent on Windows, and its timeout
 * timer lived in the parent — so a session that ended mid-calibration left a
 * worker loading and timing a model with nothing to report to.
 */
const liveWorkers = new Set<ChildProcess>();
let exitHookInstalled = false;

function trackWorker(child: ChildProcess): void {
  liveWorkers.add(child);
  child.once("close", () => liveWorkers.delete(child));
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => {
      for (const worker of liveWorkers) worker.kill();
    });
  }
}

/** Text at the length real segments have; see the note in the worker. */
export function calibrationSegments(count: number, chars = 1000): string[] {
  const words = [
    "session", "transcript", "index", "vector", "window", "segment", "scraper",
    "handoff", "retrieval", "keyword", "semantic", "threshold", "cosine",
    "database", "migration", "config", "project", "message", "timestamp", "tool",
  ];
  const segments: string[] = [];
  let seed = 1;
  for (let index = 0; index < count; index += 1) {
    let text = "";
    while (text.length < chars) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      seed >>>= 0;
      text += `${words[seed % words.length]} `;
    }
    segments.push(text.slice(0, chars));
  }
  return segments;
}

/**
 * How much faster than CPU a device has to be before it is worth switching to.
 *
 * The rule is "pick the fastest", and this is how close to 1.0 that rule can
 * honestly get rather than a preference for the CPU.
 *
 * It was 1.3 when each device got one timed pass, which is a measurement that
 * cannot distinguish a 10% device difference from a browser starting up
 * mid-run. The worker now takes the fastest of three passes, and since other
 * load only ever makes a pass slower, the minimum is close to the device's
 * real throughput — so the margin only has to cover what is left.
 *
 * Every gap measured so far is far outside it either way: 3x to 6x for the
 * wins, 0.02x for the one to reject. A margin this small changes the answer
 * only in cases nobody has actually observed.
 */
const MIN_SPEEDUP = 1.1;

/**
 * The fastest device that beats the CPU by more than noise, else the CPU.
 *
 * CPU is the default in every ambiguous case, including the one where the CPU
 * arm itself failed to run: a machine whose baseline could not be measured has
 * no basis for preferring anything to it, and guessing wrong there is the
 * fifty-times-slower outcome this whole mechanism exists to avoid.
 */
export function chooseDevice(measured: DeviceVerdict["measured"]): EmbeddingDevice {
  const cpu = measured.find((row) => row.device === "cpu")?.msPerSegment ?? null;
  if (cpu === null) {
    return "cpu";
  }

  let device: EmbeddingDevice = "cpu";
  let best = cpu / MIN_SPEEDUP;
  for (const row of measured) {
    if (row.device === "cpu" || row.msPerSegment === null) continue;
    if (row.msPerSegment < best) {
      best = row.msPerSegment;
      device = row.device;
    }
  }
  return device;
}

/**
 * Time each candidate device and pick the fastest, then remember the answer.
 *
 * This exists instead of a fallback chain because a fallback chain cannot be
 * written correctly. The obvious shape — try the GPU, fall back to CPU if it
 * throws — was measured on three operating systems on 2026-09-21 and fails on
 * exactly one of them, silently and badly. On a Windows machine with no real
 * GPU, WebGPU does not throw: it finds a software adapter, initialises
 * cleanly, returns numerically correct vectors and runs at 1784.6ms per
 * segment against the CPU's 35.4. Fifty times slower, with no error to fall
 * back from, and the only symptom is a vector backlog that never drains.
 *
 * Identity would not fix it either. `onnxruntime-node` exposes no adapter
 * information — `env.webgpu` carries only `powerPreference`, there is no
 * `navigator.gpu`, and the verbose log names every kernel dispatch but never
 * the device. And even a perfect vendor string answers the wrong question: a
 * laptop iGPU against a 24-core desktop CPU is a real GPU that still loses.
 * The question is "is this faster HERE", so it is measured here.
 *
 * Each candidate runs in its own process. Two providers in one process fail
 * intermittently with `bad allocation`, which is also why this cannot simply
 * be a loop inside the caller.
 */
export async function calibrateEmbeddingDevice(options: {
  home?: string;
  /**
   * Segments to time per device. Sixteen is enough to separate a 3x win from
   * noise and costs about two seconds on the slowest CPU measured.
   */
  segmentCount?: number;
  timeoutMs?: number;
  onProgress?: (device: EmbeddingDevice) => void;
  /**
   * Devices to time; this platform's candidates by default. Tests of the lock
   * pass none: timing real devices spawned ONNX workers through tsx, and on
   * Windows killing tsx orphans its child, which starved a 2-core CI runner
   * until unrelated time-budgeted scans came back empty.
   */
  devices?: EmbeddingDevice[];
} = {}): Promise<DeviceVerdict> {
  const segmentCount = options.segmentCount ?? 16;
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const measured: DeviceVerdict["measured"] = [];

  const release = await acquireCalibrationLock(options.home);
  try {
    for (const device of options.devices ?? deviceCandidates()) {
      options.onProgress?.(device);
      const result = await timeDevice(device, segmentCount, timeoutMs);
      measured.push({ device, ...result });
    }

    const verdict: DeviceVerdict = {
      device: chooseDevice(measured),
      measured,
      fingerprint: deviceFingerprint(),
      measuredAt: new Date().toISOString(),
    };
    // Best-effort: an unwritable home directory means the calibration is paid
    // again next time, not that it fails now.
    await writeDeviceVerdict(verdict, options.home).catch(() => {});
    return verdict;
  } finally {
    await release();
  }
}

/**
 * How to spawn the worker, in both layouts this code runs in.
 *
 * Built, `import.meta.url` is `dist/src/handoff/device.js` and the sibling
 * `device-worker.js` that `tsc` emitted is right there. From source — the test
 * suite, and `npm run dev` — the sibling is `device-worker.ts`, which node
 * cannot execute, so it goes through tsx the same way `drift-log.test.ts`
 * spawns its workers.
 *
 * Returned as argv rather than a path so the caller cannot accidentally spawn
 * a `.ts` file directly, which fails with a syntax error several seconds in
 * and reads exactly like a device that does not work.
 */
export function workerArgv(moduleUrl = import.meta.url): string[] {
  const compiled = fileURLToPath(new URL("./device-worker.js", moduleUrl));
  if (existsSync(compiled)) {
    return [compiled];
  }
  const source = fileURLToPath(new URL("./device-worker.ts", moduleUrl));
  return [fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", moduleUrl)), source];
}

function timeDevice(
  device: EmbeddingDevice,
  segmentCount: number,
  timeoutMs: number,
): Promise<{ msPerSegment: number | null; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [...workerArgv(), `--device=${device}`, `--segments=${segmentCount}`],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    trackWorker(child);

    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ msPerSegment: null, error: `timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    // stderr carries the model-loading notice and ONNX warnings; the result
    // only ever arrives on stdout behind its marker.
    child.stderr.resume();

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ msPerSegment: null, error: error.message });
    });
    child.on("close", () => {
      clearTimeout(timer);
      const marker = out.match(/__XTCTX_DEVICE__(.*)/);
      if (!marker) {
        resolve({ msPerSegment: null, error: "no result from the calibration process" });
        return;
      }
      try {
        const parsed = JSON.parse(marker[1]) as { msPerSegment?: number; error?: string };
        if (typeof parsed.msPerSegment === "number") {
          resolve({ msPerSegment: parsed.msPerSegment });
          return;
        }
        resolve({ msPerSegment: null, error: parsed.error ?? "unknown calibration failure" });
      } catch {
        resolve({ msPerSegment: null, error: "unreadable result from the calibration process" });
      }
    });
  });
}
