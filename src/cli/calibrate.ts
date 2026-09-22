import { calibrateEmbeddingDevice, deviceCandidates, readDeviceVerdict } from "../handoff/device.js";

interface CalibrateOptions {
  /** Re-measure even when a verdict for this machine is already cached. */
  force?: boolean;
}

/**
 * Time the embedding model on every execution provider this machine offers,
 * and remember the fastest.
 *
 * A command rather than something that happens on its own, because it costs
 * real seconds and loads the model once per device. The MCP server only ever
 * *reads* the verdict; nothing spawns processes behind an agent's tool call.
 *
 * Running it is optional. A machine that never does stays on CPU, which is
 * what every machine did before this existed.
 */
export async function runCalibrate(options: CalibrateOptions = {}): Promise<void> {
  // Asked for directly, so this says why nothing happened rather than
  // silently doing nothing — unlike the automatic path in `scan --embed`.
  if (process.env.XTCTX_DISABLE_EMBEDDINGS === "1") {
    process.stdout.write(
      "XTCTX_DISABLE_EMBEDDINGS=1 is set, so there is no model to time. Unset it and run this again.\n",
    );
    return;
  }

  const existing = await readDeviceVerdict();
  if (existing && !options.force) {
    process.stdout.write(
      `Already calibrated on ${existing.measuredAt}: ${existing.device}\n` +
        `${formatMeasurements(existing.measured)}\n` +
        `Re-run with --force to measure again.\n`,
    );
    return;
  }

  process.stdout.write(
    `Timing the embedding model on: ${deviceCandidates().join(", ")}\n` +
      "Each runs in its own process and loads the model once, so this takes a minute.\n\n",
  );

  const verdict = await calibrateEmbeddingDevice({
    onProgress: (device) => process.stdout.write(`  ${device}...\n`),
  });

  process.stdout.write(`\n${formatMeasurements(verdict.measured)}\n`);
  if (verdict.device === "cpu") {
    // Said plainly, because "no GPU was used" is a result and not a failure —
    // and on a machine with no GPU it is the correct one.
    process.stdout.write("Chose cpu: nothing else was decisively faster here.\n");
    return;
  }
  process.stdout.write(`Chose ${verdict.device}. Indexing will use it from now on.\n`);
}

function formatMeasurements(measured: Awaited<ReturnType<typeof calibrateEmbeddingDevice>>["measured"]): string {
  return measured
    .map((row) =>
      row.msPerSegment === null
        ? `  ${row.device.padEnd(7)} unavailable — ${truncate(row.error ?? "unknown")}`
        : `  ${row.device.padEnd(7)} ${row.msPerSegment} ms/segment`,
    )
    .join("\n");
}

function truncate(message: string): string {
  // Device initialisation failures carry multi-line native stack text.
  const firstLine = message.split("\n")[0].trim();
  return firstLine.length > 100 ? `${firstLine.slice(0, 100)}...` : firstLine;
}
