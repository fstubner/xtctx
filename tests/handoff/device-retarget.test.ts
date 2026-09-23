/**
 * The model loads on the device calibration chose, even when something asks
 * for the model before calibration finishes.
 *
 * The first version of same-session calibration retargeted the provider only
 * if nothing had started loading yet. The MCP server's own warm scan always
 * started loading first — every scan ends by calling `warm()` — so the
 * retarget was refused on every run, the verdict applied only to the next
 * session, and the comments and README said otherwise. The unit test for it
 * called the provider in isolation and never exercised that ordering.
 *
 * These tests put the load FIRST, which is the order that actually happens.
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

describe("deferring the model load until the device is known", () => {
  it("loads on the calibrated device even when the load was requested first", async () => {
    const { factory, devices } = recordingPipeline();
    const provider = new TransformersEmbeddingProvider(undefined, undefined, undefined, factory);

    let resolveDevice: (device: string) => void = () => {};
    provider.deferDeviceUntil(new Promise((resolve) => (resolveDevice = resolve)));

    // The warm scan asks for the model before calibration is done.
    const embedding = provider.embed("some text");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(devices).toEqual([]);

    resolveDevice("dml");
    await embedding;

    expect(devices).toEqual(["dml"]);
    expect(provider.device).toBe("dml");
  });

  it("keeps the configured device when calibration fails", async () => {
    // A failed measurement is not a reason to stop using the device that has
    // always worked.
    const { factory, devices } = recordingPipeline();
    const provider = new TransformersEmbeddingProvider(undefined, undefined, "cpu", factory);

    provider.deferDeviceUntil(Promise.reject(new Error("could not measure")));
    await provider.embed("some text");

    expect(devices).toEqual(["cpu"]);
  });

  it("keeps the configured device when calibration yields nothing", async () => {
    const { factory, devices } = recordingPipeline();
    const provider = new TransformersEmbeddingProvider(undefined, undefined, undefined, factory);

    provider.deferDeviceUntil(Promise.resolve(undefined));
    await provider.embed("some text");

    expect(devices).toEqual([undefined]);
  });

  it("loads once, however many callers were waiting", async () => {
    const { factory, devices } = recordingPipeline();
    const provider = new TransformersEmbeddingProvider(undefined, undefined, undefined, factory);
    provider.deferDeviceUntil(Promise.resolve("webgpu"));

    await Promise.all([provider.embed("a"), provider.embed("b"), provider.embedBatch(["c", "d"])]);

    expect(devices).toEqual(["webgpu"]);
  });
});
