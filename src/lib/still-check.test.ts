import assert from "node:assert/strict";
import test from "node:test";

import type { NormalizedQuad } from "./quad.ts";
import {
  checkStill,
  fitScaleShift,
  mapPreviewQuadToStill,
  STILL_MATCH_RESIDUAL,
  turnPoint,
  type StillMapping,
} from "./still-check.ts";

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

function quad(x0: number, y0: number, x1: number, y1: number): NormalizedQuad {
  return { topLeft: { x: x0, y: y0 }, topRight: { x: x1, y: y0 }, bottomRight: { x: x1, y: y1 }, bottomLeft: { x: x0, y: y1 } };
}

const PREVIEW = { width: 720, height: 1280 };
const PAGE = quad(0.15, 0.2, 0.85, 0.8);

test("same shape, same field of view: the quad carries over unchanged", () => {
  const m = mapPreviewQuadToStill(PAGE, { preview: PREVIEW, still: { width: 2250, height: 4000 } });
  for (const key of ["topLeft", "topRight", "bottomRight", "bottomLeft"] as const) {
    near(m[key].x, PAGE[key].x, 1e-12);
    near(m[key].y, PAGE[key].y, 1e-12);
  }
});

test("a 4:3 photo under a 9:16 preview: same long edge, a wider short edge", () => {
  const m = mapPreviewQuadToStill(PAGE, { preview: PREVIEW, still: { width: 3000, height: 4000 } });
  // y (the long axis) unchanged; x pulled towards the centre by (9/16)/(3/4) = 0.75.
  near(m.topLeft.y, 0.2);
  near(m.bottomRight.y, 0.8);
  near(m.topLeft.x, 0.5 + (0.15 - 0.5) * 0.75);
  near(m.topRight.x, 0.5 + (0.85 - 0.5) * 0.75);
});

test("a stabilised preview: the photo sees 10 % more, the page is smaller in it", () => {
  const m = mapPreviewQuadToStill(PAGE, { preview: PREVIEW, still: { width: 720, height: 1280 }, fovScale: 1.1 });
  near(m.topLeft.x, 0.5 + (0.15 - 0.5) / 1.1);
  near(m.bottomRight.y, 0.5 + (0.8 - 0.5) / 1.1);
  // …and a zoomed photo pipeline (sees less) pushes a wide page off the photo.
  const zoomed = mapPreviewQuadToStill(quad(0.02, 0.1, 0.98, 0.9), { preview: PREVIEW, still: PREVIEW, fovScale: 0.9 });
  assert.ok(zoomed.topLeft.x < 0 && zoomed.topRight.x > 1);
});

test("quarter turns: the picture turns, the corners are re-labelled by position", () => {
  assert.deepEqual(turnPoint({ x: 0.1, y: 0.2 }, 1), { x: 0.8, y: 0.1 });
  assert.deepEqual(turnPoint({ x: 0.1, y: 0.2 }, 2), { x: 0.9, y: 0.8 });
  assert.deepEqual(turnPoint({ x: 0.1, y: 0.2 }, 3), { x: 0.2, y: 0.9 });
  for (const turns of [0, 1, 2, 3] as const) {
    const back = turnPoint(turnPoint({ x: 0.3, y: 0.7 }, turns), ((4 - turns) % 4) as 0 | 1 | 2 | 3);
    near(back.x, 0.3);
    near(back.y, 0.7);
  }
  // A portrait preview whose photo came back landscape, a quarter turn clockwise.
  const mapping: StillMapping = { preview: PREVIEW, still: { width: 1280, height: 720 }, turns: 1 };
  const m = mapPreviewQuadToStill(quad(0.1, 0.2, 0.6, 0.9), mapping);
  // The preview's left edge (x 0.1) is the photo's top edge (y 0.1); its bottom (y 0.9) the photo's left (x 0.1).
  near(m.topLeft.x, 0.1);
  near(m.topLeft.y, 0.1);
  near(m.bottomRight.x, 0.8);
  near(m.bottomRight.y, 0.6);
});

test("the scale-and-shift fit recovers a field of view and a drift", () => {
  const aspect = 1280 / 720;
  const seen = mapPreviewQuadToStill(PAGE, { preview: PREVIEW, still: PREVIEW, fovScale: 1.15 });
  const fit = fitScaleShift(PAGE, seen, aspect);
  near(fit.scale, 1 / 1.15, 1e-9);
  near(fit.shiftX, 0, 1e-9);
  near(fit.residual, 0, 1e-9);
  const drifted = quad(0.18, 0.22, 0.88, 0.82);
  const shifted = fitScaleShift(PAGE, drifted, aspect);
  near(shifted.scale, 1, 1e-9);
  near(shifted.shiftX, 0.03, 1e-9);
  near(shifted.shiftY, 0.02, 1e-9);
  near(shifted.residual, 0, 1e-9);
  // Another shape altogether (a landscape card where a portrait page was) does not fit.
  const other = fitScaleShift(PAGE, quad(0.1, 0.4, 0.9, 0.6), aspect);
  assert.ok(other.residual > STILL_MATCH_RESIDUAL);
});

test("checkStill: whole and in place → no flag", () => {
  const mapping = { preview: PREVIEW, still: { width: 2250, height: 4000 } };
  const detected = quad(0.152, 0.198, 0.849, 0.801);
  const r = checkStill({ live: PAGE, corners: detected, cornersFromPhoto: true, mapping });
  assert.equal(r.attention, null);
  assert.ok(r.fit !== null && r.fit.residual < 0.01);
  // Through a stabilised preview: the photo's page is smaller, still no flag.
  const eis = checkStill({ live: PAGE, corners: mapPreviewQuadToStill(PAGE, { ...mapping, fovScale: 1.12 }), cornersFromPhoto: true, mapping });
  assert.equal(eis.attention, null);
});

test("checkStill: a corner on the photo's edge, no page, another page → flagged", () => {
  const mapping = { preview: PREVIEW, still: PREVIEW };
  const cut = quad(0, 0.2, 0.85, 0.8);
  assert.equal(checkStill({ live: PAGE, corners: cut, cornersFromPhoto: true, mapping }).attention, "corner-outside");
  assert.equal(checkStill({ live: PAGE, corners: null, cornersFromPhoto: false, mapping }).attention, "no-page");
  const elsewhere = quad(0.5, 0.05, 0.95, 0.4);
  assert.equal(checkStill({ live: PAGE, corners: elsewhere, cornersFromPhoto: true, mapping }).attention, "moved");
  // Slid a quarter of the frame sideways: same shape, but not where the viewfinder had it.
  const slid = quad(0.4, 0.2, 0.99, 0.8);
  assert.equal(checkStill({ live: quad(0.15, 0.2, 0.74, 0.8), corners: slid, cornersFromPhoto: true, mapping }).attention, "moved");
  // Corners carried over from the viewfinder (the photo's own detect found nothing):
  // nothing to compare with, but the mapped page must still fit the photo.
  assert.equal(checkStill({ live: PAGE, corners: PAGE, cornersFromPhoto: false, mapping }).attention, null);
  const zoomed = { preview: PREVIEW, still: PREVIEW, fovScale: 0.8 };
  const wide = quad(0.05, 0.1, 0.95, 0.9);
  assert.equal(checkStill({ live: wide, corners: quad(0.1, 0.1, 0.9, 0.9), cornersFromPhoto: false, mapping: zoomed }).attention, "corner-outside");
  // A manual capture with no live quad: only the photo's own corners are judged.
  assert.equal(checkStill({ live: null, corners: PAGE, cornersFromPhoto: true, mapping }).attention, null);
});

test("checkStill: a photo that sees less than the preview — the page's own detect shrinks onto what is left, the fit still says cut", () => {
  const mapping = { preview: PREVIEW, still: PREVIEW };
  const live = quad(0.08, 0.2, 0.92, 0.8);
  // Seen 20 % narrower, the page would run from −0.05 to 1.05 across: the
  // detect on the photo clamps to what is left, a hair inside the edge.
  const seen = mapPreviewQuadToStill(live, { ...mapping, fovScale: 0.8 });
  assert.ok(seen.topLeft.x < 0);
  const clipped = quad(0.006, seen.topLeft.y, 0.994, seen.bottomRight.y);
  const r = checkStill({ live, corners: clipped, cornersFromPhoto: true, mapping });
  assert.equal(r.attention, "corner-outside");
  // The same page through a photo that sees 10 % MORE: whole, no flag.
  const wider = mapPreviewQuadToStill(live, { ...mapping, fovScale: 1.1 });
  assert.equal(checkStill({ live, corners: wider, cornersFromPhoto: true, mapping }).attention, null);
});
