import assert from "node:assert/strict";
import test from "node:test";

import { DEVICE_GATE_BUDGET_MS } from "./dewarp/index.ts";
import type { DeviceGate } from "./dewarp/types.ts";
import {
  DESKEW_POLICY_VERSION,
  curlEvidence,
  deskewQuad,
  fillDeskewWedges,
  type DeskewImage,
  type DeskewPlan,
  type SkewEstimate,
} from "./deskew.ts";
import { dewarpAvailable, paintDeskewWedges, withinDeviceBudget } from "./dewarp-stage.ts";

/**
 * The two decisions in the stage that are not about pixels: how long a person
 * may be left waiting, and whether to offer the control at all. Both are pure,
 * and both are the sort of rule that quietly inverts in a refactor.
 */

function gate(totalMs: number): DeviceGate {
  // The three components are what the engine measured; only the wall time is
  // the product's business, and the fixture says so by varying just that.
  return { downloadMs: 8_000, initMs: 900, firstInferenceMs: 1_400, totalMs };
}

test("the wait budget is the 12 seconds the product promised", () => {
  assert.equal(DEVICE_GATE_BUDGET_MS, 12_000);
});

test("a device is kept only while it answers inside the budget", () => {
  assert.equal(withinDeviceBudget(gate(4_300), DEVICE_GATE_BUDGET_MS), true);
  // The boundary belongs to the device: 12 s exactly is a wait that was
  // promised, not one that was broken.
  assert.equal(withinDeviceBudget(gate(12_000), DEVICE_GATE_BUDGET_MS), true);
  assert.equal(withinDeviceBudget(gate(12_001), DEVICE_GATE_BUDGET_MS), false);
  assert.equal(withinDeviceBudget(gate(41_000), DEVICE_GATE_BUDGET_MS), false);
});

test("a runtime with no Worker is never offered the correction", () => {
  // Node is that runtime, which is the whole point: the control must not be
  // shown anywhere the engine cannot run, and the probe answers before a
  // single byte of the engine is fetched.
  assert.equal(typeof Worker, "undefined");
  assert.equal(dewarpAvailable(), false);
});

/* ── The deskew's wedge painter on a canvas ─────────────────────────────── */

/** A canvas as `paintDeskewWedges` uses one: a 2-D context that reads and writes pixel boxes. */
function standInCanvas(image: DeskewImage): { canvas: HTMLCanvasElement; readArea: () => number } {
  let read = 0;
  const context = {
    getImageData(x: number, y: number, w: number, h: number) {
      read += w * h;
      const data = new Uint8ClampedArray(w * h * 4);
      for (let row = 0; row < h; row += 1) {
        const from = ((y + row) * image.width + x) * 4;
        data.set(image.data.subarray(from, from + w * 4), row * w * 4);
      }
      return { width: w, height: h, data };
    },
    putImageData(patch: DeskewImage, x: number, y: number) {
      for (let row = 0; row < patch.height; row += 1) {
        image.data.set(
          patch.data.subarray(row * patch.width * 4, (row + 1) * patch.width * 4),
          ((y + row) * image.width + x) * 4,
        );
      }
    },
  };
  const canvas = { width: image.width, height: image.height, getContext: () => context };
  return { canvas: canvas as unknown as HTMLCanvasElement, readArea: () => read };
}

function wedgedPage(width: number, height: number, deg: number): { image: DeskewImage; plan: DeskewPlan } {
  const geometry = deskewQuad({
    quad: { topLeft: { x: 40, y: 30 }, topRight: { x: 40 + width - 1, y: 30 }, bottomRight: { x: 40 + width - 1, y: 30 + height - 1 }, bottomLeft: { x: 40, y: 30 + height - 1 } },
    outputWidth: width,
    outputHeight: height,
    canonicalWidth: width + 80,
    canonicalHeight: height + 60,
    deg,
  });
  const plan: DeskewPlan = {
    policyVersion: DESKEW_POLICY_VERSION,
    deg,
    quad: geometry.quad,
    scale: geometry.scale,
    mode: "paper",
    pageInOutput: geometry.pageInOutput,
    cornerColors: [
      [230, 230, 230],
      [230, 230, 230],
      [230, 230, 230],
      [230, 230, 230],
    ],
    paint: [true, true, false, true],
    bleedFraction: 0.004,
    photoInOutput: geometry.photoInOutput,
    curl: curlEvidence({ deg, halves: [deg, deg] } as SkewEstimate, null),
  };
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // Shaded paper with lines of print, and table where the wedges are.
      const v = 235 - 30 * (x / width) - (y % 23 < 4 && x > 40 && x < width - 40 ? 150 : 0);
      data.set([v, v - 4, v - 12, 255], (y * width + x) * 4);
    }
  }
  return { image: { width, height, data }, plan };
}

test("the canvas painter gives the very pixels of the pure fill, reading back only the wedge boxes", async () => {
  for (const deg of [4, -7.5]) {
    const { image, plan } = wedgedPage(420, 560, deg);
    const expected = { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
    const painted = fillDeskewWedges(expected, plan);
    assert.ok(painted > 0, `${deg}°`);
    const { canvas, readArea } = standInCanvas(image);
    await paintDeskewWedges(canvas, plan);
    assert.deepEqual(image.data, expected.data, `${deg}°: canvas and pure fill agree pixel for pixel`);
    assert.ok(readArea() < 0.5 * image.width * image.height, `${deg}°: read back ${readArea()} px, not the page`);
  }
});

test("a crop-mode plan paints nothing on the canvas", async () => {
  const { image, plan } = wedgedPage(200, 260, 5);
  const before = new Uint8ClampedArray(image.data);
  const { canvas } = standInCanvas(image);
  await paintDeskewWedges(canvas, { ...plan, mode: "crop" });
  assert.deepEqual(image.data, before);
});
