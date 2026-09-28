import assert from "node:assert/strict";
import test from "node:test";

import { OneEuroFilter, QuadOneEuro, OVERLAY_ONE_EURO } from "./one-euro.ts";
import type { NormalizedQuad } from "./quad.ts";

const quad = (dx = 0, dy = 0): NormalizedQuad => ({
  topLeft: { x: 0.2 + dx, y: 0.2 + dy },
  topRight: { x: 0.8 + dx, y: 0.2 + dy },
  bottomRight: { x: 0.8 + dx, y: 0.8 + dy },
  bottomLeft: { x: 0.2 + dx, y: 0.8 + dy },
});

test("the first sample passes through; the same moment twice changes nothing", () => {
  const filter = new OneEuroFilter(OVERLAY_ONE_EURO);
  assert.equal(filter.filter(0.5, 1000), 0.5);
  assert.equal(filter.filter(0.9, 1000), 0.5);
  assert.equal(filter.filter(0.9, 900), 0.5);
});

test("a still signal's noise is calmed", () => {
  const filter = new OneEuroFilter(OVERLAY_ONE_EURO);
  let raw = 0;
  let filtered = 0;
  let previousRaw = 0.5;
  let previousOut = 0.5;
  filter.filter(0.5, 0);
  for (let k = 1; k <= 200; k += 1) {
    const x = 0.5 + (k % 2 === 0 ? 0.002 : -0.002);
    const out = filter.filter(x, k * 125);
    raw += Math.abs(x - previousRaw);
    filtered += Math.abs(out - previousOut);
    previousRaw = x;
    previousOut = out;
  }
  assert.ok(filtered < raw * 0.6, `filtered motion ${filtered} vs raw ${raw}`);
});

test("a moving signal is followed closely: the cutoff rises with speed", () => {
  const slow = new OneEuroFilter({ ...OVERLAY_ONE_EURO, beta: 0 });
  const adaptive = new OneEuroFilter(OVERLAY_ONE_EURO);
  let lagSlow = 0;
  let lagAdaptive = 0;
  for (let k = 0; k <= 40; k += 1) {
    // 0.1 frame widths per second, sampled every 125 ms.
    const x = 0.1 * (k * 0.125);
    lagSlow = x - slow.filter(x, k * 125);
    lagAdaptive = x - adaptive.filter(x, k * 125);
  }
  assert.ok(lagAdaptive < lagSlow, `adaptive lag ${lagAdaptive} vs fixed ${lagSlow}`);
  assert.ok(adaptive.speed() > 0.05);
});

test("a quad is filtered per corner, isotropically, and a reset starts over", () => {
  const filter = new QuadOneEuro(OVERLAY_ONE_EURO, 16 / 9);
  const first = filter.update(quad(), 0, 16 / 9);
  assert.deepEqual(first, quad());
  const moved = filter.update(quad(0.01, 0.01), 125, 16 / 9);
  assert.ok(moved.topLeft.x > 0.2 && moved.topLeft.x < 0.21);
  assert.ok(moved.topLeft.y > 0.2 && moved.topLeft.y < 0.21);
  filter.reset();
  assert.deepEqual(filter.update(quad(0.1, 0), 250, 16 / 9), quad(0.1, 0));
  // A new aspect (the frame changed shape) is a new geometry: no smoothing across it.
  filter.update(quad(0.1, 0), 375, 16 / 9);
  assert.deepEqual(filter.update(quad(0.2, 0), 500, 4 / 3), quad(0.2, 0));
});
