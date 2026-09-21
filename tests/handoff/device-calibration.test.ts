/**
 * Choosing an embedding device has to fail toward the CPU.
 *
 * The measurement that produced this code, run on three operating systems on
 * 2026-09-21: on a Windows machine with no real GPU, WebGPU does not fail. It
 * finds a software adapter, initialises cleanly, returns numerically correct
 * vectors, and runs at 1784.6ms per segment against the CPU's 35.4 — fifty
 * times slower, with no error anywhere and no symptom except a vector backlog
 * that never drains.
 *
 * So every ambiguous case here resolves to the CPU, and the tests below are
 * mostly about ambiguity rather than about picking a winner.
 */
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chooseDevice,
  deviceCandidates,
  deviceFingerprint,
  readDeviceVerdict,
  workerArgv,
} from "@xtctx/handoff/device";

let home = "";

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "xtctx-device-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function writeVerdict(body: unknown): Promise<void> {
  await mkdir(join(home, ".xtctx"), { recursive: true });
  await writeFile(join(home, ".xtctx", "device.json"), JSON.stringify(body), "utf-8");
}

describe("chooseDevice", () => {
  it("takes a decisive win over the CPU", () => {
    expect(
      chooseDevice([
        { device: "cpu", msPerSegment: 20.1 },
        { device: "dml", msPerSegment: 6 },
        { device: "webgpu", msPerSegment: 10.1 },
      ]),
    ).toBe("dml");
  });

  it("stays on the CPU when the GPU is slower", () => {
    // The windows-latest runner, exactly: WebGPU ran, returned correct
    // vectors, and took fifty times as long.
    expect(
      chooseDevice([
        { device: "cpu", msPerSegment: 35.4 },
        { device: "webgpu", msPerSegment: 1784.6 },
      ]),
    ).toBe("cpu");
  });

  it("stays on the CPU when the win is inside the noise", () => {
    // A 10% gap on one short run on a machine doing other things is not
    // evidence, and switching is permanent.
    expect(
      chooseDevice([
        { device: "cpu", msPerSegment: 20 },
        { device: "webgpu", msPerSegment: 18.5 },
      ]),
    ).toBe("cpu");
  });

  it("stays on the CPU when no GPU could be measured at all", () => {
    expect(
      chooseDevice([
        { device: "cpu", msPerSegment: 32.8 },
        { device: "webgpu", msPerSegment: null, error: "No supported adapters" },
      ]),
    ).toBe("cpu");
  });

  it("stays on the CPU when the CPU baseline itself failed", () => {
    // Nothing to compare against. A GPU that looks fast against no baseline
    // is the same guess this mechanism exists to stop making.
    expect(
      chooseDevice([
        { device: "cpu", msPerSegment: null, error: "out of memory" },
        { device: "dml", msPerSegment: 6 },
      ]),
    ).toBe("cpu");
  });
});

describe("deviceCandidates", () => {
  it("offers DirectML only on Windows", () => {
    // Asking for it elsewhere throws immediately rather than measuring:
    // `Unsupported device: "dml". Should be one of: coreml, webgpu, cpu`.
    expect(deviceCandidates("win32")).toContain("dml");
    expect(deviceCandidates("darwin")).not.toContain("dml");
    expect(deviceCandidates("linux")).not.toContain("dml");
  });

  it("always measures the CPU, because it is what everything is compared to", () => {
    for (const platform of ["win32", "darwin", "linux"]) {
      expect(deviceCandidates(platform)).toContain("cpu");
    }
  });
});

describe("readDeviceVerdict", () => {
  it("returns nothing when this machine has never been calibrated", async () => {
    expect(await readDeviceVerdict({ home })).toBeNull();
  });

  it("ignores a verdict measured for a different configuration", async () => {
    // The fingerprint carries the model and the core count: a verdict is about
    // this machine embedding this model, and the CPU arm is what the GPU had
    // to beat. A 4-core laptop and a 24-core desktop reach different answers
    // from identical hardware.
    await writeVerdict({ device: "dml", measured: [], fingerprint: "someone-else", measuredAt: "" });

    expect(await readDeviceVerdict({ home })).toBeNull();
  });

  it("ignores a device this platform does not offer", async () => {
    await writeVerdict({
      device: "cuda",
      measured: [],
      fingerprint: deviceFingerprint(),
      measuredAt: "",
    });

    expect(await readDeviceVerdict({ home })).toBeNull();
  });

  it("returns the verdict when it matches this configuration", async () => {
    await writeVerdict({
      device: "cpu",
      measured: [],
      fingerprint: deviceFingerprint(),
      measuredAt: "2026-09-21T00:00:00.000Z",
    });

    expect((await readDeviceVerdict({ home }))?.device).toBe("cpu");
  });

  it("falls back to no verdict rather than throwing on an unreadable cache", async () => {
    // A machine that cannot read its own cache embeds on the CPU, which is
    // what it did before any of this existed.
    await mkdir(join(home, ".xtctx"), { recursive: true });
    await writeFile(join(home, ".xtctx", "device.json"), "{not json", "utf-8");

    expect(await readDeviceVerdict({ home })).toBeNull();
  });
});

describe("workerArgv", () => {
  it("resolves to a file that exists", () => {
    // The calibration spawns this by path. `tsc` compiles the `src` tree and
    // copies nothing, so a worker written as plain `.js` would be absent from
    // `dist` and every device would report "no result" for the published
    // package while passing every test here.
    const [entry] = workerArgv();

    expect(existsSync(entry)).toBe(true);
  });
});
