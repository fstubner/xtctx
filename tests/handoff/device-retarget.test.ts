/**
 * The model loads on the device calibration chose — unless someone is
 * waiting for a vector, in which case it loads now on the device it has.
 *
 * The first version of same-session calibration retargeted the provider only
 * if nothing had started loading yet. The MCP server's own warm scan always
 * started loading first — every scan ends by calling `warm()` — so the
 * retarget was refused on every run, and the verdict applied only to the next
 * session while the comments and README said otherwise. The test for it called
 * the provider in isolation and never exercised that ordering.
 *
 * The fix that followed, deferring every load to calibration, overcorrected:
 * an explicit `vector` search then waited for a measurement it did not need,
 * and on a fresh GitHub ubuntu runner it "did not answer within 60s". So the
 * background warm-up waits and a caller holding a tool call open does not.
 */
import { describe, expect, it } from "vitest";
import {
  TransformersEmbeddingProvider,
  type PipelineFactory,
} from "@xtctx/handoff/embeddings";

/** A pipeline that records the device it was loaded with and returns vectors. */
function recordingPipeline(): { factory: PipelineFactory; devices: Array<string | undefined> } {
  const devices: Array<string | undefined> = [];
  const factory: PipelineFactory = async (_task, _model, options) => {
    devices.push((options as { device?: string } | undefined)?.device);
    return async (input) => {
      const count = Array.isArray(input) ? input.length : 1;
      return { data: new Float32Array(count * 2).fill(0.5) };
    };
  };
  return { factory, devices };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("deferring the model load until the device is known", () => {
  it("makes the background warm-up wait, then load on the calibrated device", async () => {
    // The order that actually happens: the warm scan asks for the model while
    // calibration is still running.
    const { factory, devices } = recordingPipeline();
    const provider = new TransformersEmbeddingProvider(undefined, undefined, undefined, factory);

    let resolveDevice: (device: string) => void = () => {};
    provider.deferDeviceUntil(new Promise((resolve) => (resolveDevice = resolve)));

    provider.warm();
    await tick();
    expect(devices).toEqual([]);

    resolveDevice("dml");
    await tick();

    expect(devices).toEqual(["dml"]);
    expect(provider.device).toBe("dml");
  });

  it("does not make a caller that needs a vector now wait for calibration", async () => {
    // A calibration that never finishes, standing in for one that takes a
    // minute on a fresh machine behind a 60-second tool-call limit.
    const { factory, devices } = recordingPipeline();
    const provider = new TransformersEmbeddingProvider(undefined, undefined, "cpu", factory);
    provider.deferDeviceUntil(new Promise<string>(() => {}));

    await provider.embed("an explicit vector search");

    expect(devices).toEqual(["cpu"]);
  });

  it("keeps the configured device when calibration fails", async () => {
    // A failed measurement is not a reason to stop using the device that has
    // always worked.
    const { factory, devices } = recordingPipeline();
    const provider = new TransformersEmbeddingProvider(undefined, undefined, "cpu", factory);

    provider.deferDeviceUntil(Promise.reject(new Error("could not measure")));
    provider.warm();
    await tick();

    expect(devices).toEqual(["cpu"]);
  });

  it("loads once, however many callers there are", async () => {
    const { factory, devices } = recordingPipeline();
    const provider = new TransformersEmbeddingProvider(undefined, undefined, undefined, factory);
    let resolveDevice: (device: string) => void = () => {};
    provider.deferDeviceUntil(new Promise((resolve) => (resolveDevice = resolve)));

    provider.warm();
    provider.warm();
    resolveDevice("webgpu");
    await tick();
    await Promise.all([provider.embed("a"), provider.embed("b"), provider.embedBatch(["c", "d"])]);

    expect(devices).toEqual(["webgpu"]);
  });
});
