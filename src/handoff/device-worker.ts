/**
 * Time one embedding device, in a process of its own, and print the result.
 *
 * Spawned by `calibrateEmbeddingDevice`. It is a separate process because two
 * providers in one process fail intermittently with `bad allocation`, and a
 * device that cannot initialise has to be a measurement rather than a crash in
 * the caller.
 *
 * Spawned by path, so it has to exist wherever it is spawned from: `tsc`
 * emits it to `dist/src/handoff/device-worker.js` for the published package,
 * and `workerArgv` in device.ts spawns the `.ts` through tsx when running from
 * source. A plain `.js` file here would be simpler to spawn and would never
 * reach `dist` at all, because the build is `tsc` over the `src` tree and
 * copies nothing.
 */
import { parseArgs } from "node:util";
import { DEFAULT_EMBEDDING_DTYPE, DEFAULT_EMBEDDING_MODEL } from "./embeddings.js";
import { calibrationSegments } from "./device.js";

const { values } = parseArgs({
  options: {
    device: { type: "string", default: "cpu" },
    segments: { type: "string", default: "16" },
  },
  strict: false,
});

const device = values.device;
const segmentCount = Math.max(1, Number.parseInt(String(values.segments), 10) || 16);

try {
  const segments = calibrationSegments(segmentCount);
  const transformers = (await import("@huggingface/transformers")) as unknown as {
    pipeline: (
      task: "feature-extraction",
      model: string,
      options: Record<string, unknown>,
    ) => Promise<
      (
        input: string[],
        options: { pooling: "mean"; normalize: boolean },
      ) => Promise<{ data: ArrayLike<number> }>
    >;
  };
  const options: Record<string, unknown> = { dtype: DEFAULT_EMBEDDING_DTYPE, device };
  const extractor = await transformers.pipeline(
    "feature-extraction",
    DEFAULT_EMBEDDING_MODEL,
    options,
  );

  // One untimed batch first. The first call carries graph compilation and
  // buffer allocation, a one-off cost that is not what per-segment throughput
  // means — and it is much larger on the GPU paths, so including it would
  // bias the comparison toward the CPU.
  await extractor(segments.slice(0, 2), { pooling: "mean", normalize: true });

  const startedAt = performance.now();
  await extractor(segments, { pooling: "mean", normalize: true });
  const elapsed = performance.now() - startedAt;

  process.stdout.write(
    `\n__XTCTX_DEVICE__${JSON.stringify({
      device,
      msPerSegment: Number((elapsed / segments.length).toFixed(1)),
    })}\n`,
  );
} catch (error) {
  // A device that cannot initialise is the answer, not a failure: "webgpu is
  // unavailable here" is exactly what the caller needs in order to rule it out.
  process.stdout.write(
    `\n__XTCTX_DEVICE__${JSON.stringify({
      device,
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
}
