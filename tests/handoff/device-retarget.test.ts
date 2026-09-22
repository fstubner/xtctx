/**
 * Calibration has to be able to take effect in the session that ran it.
 *
 * The provider loads its model lazily, so until something embeds, pointing it
 * at a different device costs nothing. That is what makes full automation
 * possible: the server starts, finds a backlog and no verdict, measures the
 * devices in child processes, and points the not-yet-loaded provider at the
 * winner before anything embeds.
 *
 * Without this the verdict only applied to the NEXT session, and the gate that
 * decides whether to drain in the background is computed from the old device's
 * rate — so a large history on a CPU stayed above the budget, never drained,
 * and therefore never benefited from the calibration it had just paid for.
 *
 * The refusal matters as much as the retarget. Once the model is loaded or
 * loading, swapping the device means discarding it and paying the load again,
 * possibly while a tool call is waiting on it, to speed up work already in
 * flight. The caller is told it did not apply rather than left to assume it did.
 */
import { describe, expect, it } from "vitest";
import { TransformersEmbeddingProvider } from "@xtctx/handoff/embeddings";

describe("retargeting an embedding provider", () => {
  it("applies while the model has not been loaded", () => {
    const provider = new TransformersEmbeddingProvider();
    expect(provider.device).toBeUndefined();

    expect(provider.retargetDevice("dml")).toBe(true);
    expect(provider.device).toBe("dml");
  });

  it("replaces a device chosen earlier, so a re-measure wins", () => {
    const provider = new TransformersEmbeddingProvider(undefined, undefined, "cpu");

    expect(provider.retargetDevice("webgpu")).toBe(true);
    expect(provider.device).toBe("webgpu");
  });

  it("refuses once the model is loading, and leaves the device alone", async () => {
    const provider = new TransformersEmbeddingProvider(undefined, undefined, "cpu");
    // `warm()` starts the load without waiting for it, which is exactly the
    // window this guards: a tool call arriving mid-calibration.
    provider.warm();

    expect(provider.retargetDevice("dml")).toBe(false);
    expect(provider.device).toBe("cpu");
  });

  it("reports the device it will actually load on", () => {
    // `xtctx status` reads this off the provider rather than off the
    // calibration cache, so it has to follow a retarget.
    const provider = new TransformersEmbeddingProvider();
    provider.retargetDevice("dml");

    expect(provider.device).toBe("dml");
  });
});
