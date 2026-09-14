import assert from "node:assert/strict";
import test from "node:test";

import { binarize, deepenInk, normalizeIllumination } from "./enhance.ts";
import { applyFinish } from "./render-pixels.ts";
import type { SurfaceFactory } from "./canvas-surface.ts";

/**
 * The ink curve, and the one place a finish is chosen.
 *
 * Neither needs a browser: `enhance.ts` is written against {@link CanvasSurface}
 * and reaches the pixels through `getImageData`/`putImageData`, so a plain
 * object with those two methods over a `Uint8ClampedArray` is a faithful stand-in
 * — the arithmetic under test is the whole of what runs on the phone.
 *
 * What is being protected here is a deliberate product ruling: `clarear`
 * now deepens the ink, and `preto e branco` must NOT, because Otsu's split is
 * computed from the histogram it is handed and darkening the ink first moves it.
 */

interface FakeSurface {
  width: number;
  height: number;
  /** The buffer the pass mutates in place — read it back after the call. */
  pixels: Uint8ClampedArray;
  getContext: () => unknown;
}

function surfaceOf(
  width: number,
  height: number,
  pixels: Uint8ClampedArray,
): FakeSurface {
  const image = { data: pixels, width, height, colorSpace: "srgb" } as unknown as ImageData;
  return {
    width,
    height,
    pixels,
    getContext: () => ({
      getImageData: () => image,
      putImageData: () => {},
      drawImage: () => {},
      setTransform: () => {},
    }),
  };
}

/** Cast at the seam, once, so the tests themselves stay free of `as`. */
function asCanvas(surface: FakeSurface): HTMLCanvasElement {
  return surface as unknown as HTMLCanvasElement;
}

/** An RGBA buffer from a list of RGB triples. */
function rgba(triples: readonly (readonly [number, number, number])[]): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(triples.length * 4);
  triples.forEach(([r, g, b], index) => {
    pixels[index * 4] = r;
    pixels[index * 4 + 1] = g;
    pixels[index * 4 + 2] = b;
    pixels[index * 4 + 3] = 255;
  });
  return pixels;
}

function pixelAt(pixels: Uint8ClampedArray, index: number): [number, number, number] {
  return [pixels[index * 4], pixels[index * 4 + 1], pixels[index * 4 + 2]];
}

/** Every grey 0–255, one pixel each, as a 16×16 sheet. */
function greyRamp(): Uint8ClampedArray {
  return rgba(Array.from({ length: 256 }, (_, level) => [level, level, level] as const));
}

// ── deepenInk, on its own ────────────────────────────────────────────────────

test("nothing at or above the paper anchor is touched", () => {
  const pixels = greyRamp();
  deepenInk(asCanvas(surfaceOf(16, 16, pixels)));

  for (let level = 215; level <= 255; level += 1) {
    assert.deepEqual(
      pixelAt(pixels, level),
      [level, level, level],
      `grey ${level} sits on the paper side of the anchor and must not move`,
    );
  }
});

test("everything below the anchor is darkened, and never lightened", () => {
  const pixels = greyRamp();
  deepenInk(asCanvas(surfaceOf(16, 16, pixels)));

  for (let level = 0; level < 215; level += 1) {
    const [red] = pixelAt(pixels, level);
    assert.ok(
      red <= level,
      `grey ${level} came back as ${red}: this pass may only ever darken`,
    );
  }
  // Something actually happened — a no-op would satisfy the clamp above.
  assert.ok(pixelAt(pixels, 100)[0] < 90, "mid ink should be visibly deepened");
});

test("darker in, darker out: the curve is monotonic", () => {
  const pixels = greyRamp();
  deepenInk(asCanvas(surfaceOf(16, 16, pixels)));

  for (let level = 1; level < 256; level += 1) {
    const previous = pixelAt(pixels, level - 1)[0];
    const current = pixelAt(pixels, level)[0];
    assert.ok(
      current >= previous,
      `grey ${level} (→${current}) must not come back darker than ${level - 1} (→${previous})`,
    );
  }
});

test("colour survives: one ratio on all three channels, so a blue pen stays blue", () => {
  const before: readonly [number, number, number] = [40, 60, 200];
  const pixels = rgba([before]);
  deepenInk(asCanvas(surfaceOf(1, 1, pixels)));
  const after = pixelAt(pixels, 0);

  // The same scale on each channel, within the byte rounding.
  const ratios = after.map((channel, index) => channel / before[index]);
  assert.ok(ratios[0] < 1, "the pixel is well below the anchor and must darken");
  for (const ratio of ratios) {
    assert.ok(
      Math.abs(ratio - ratios[2]) < 0.02,
      `channel ratios drifted (${ratios.join(", ")}) — that is a hue shift`,
    );
  }
  // Hue, stated the way a reader would see it: blue still dominates by the same
  // margin it did before.
  assert.ok(Math.abs(after[2] / after[0] - before[2] / before[0]) < 0.2);
});

test("full white and full black are fixed points", () => {
  const pixels = rgba([
    [255, 255, 255],
    [0, 0, 0],
  ]);
  deepenInk(asCanvas(surfaceOf(2, 1, pixels)));

  assert.deepEqual(pixelAt(pixels, 0), [255, 255, 255]);
  assert.deepEqual(pixelAt(pixels, 1), [0, 0, 0]);
});

test("a surface with no pixels is handed straight back", () => {
  const empty = surfaceOf(0, 0, new Uint8ClampedArray(0));
  assert.equal(deepenInk(asCanvas(empty)), asCanvas(empty));
});

// ── the wiring: which finish runs which pass ─────────────────────────────────

/**
 * A page the illumination pass leaves alone, so the finish comparisons below
 * isolate the ink curve.
 *
 * `normalizeIllumination` estimates the light field from a thumbnail drawn by
 * the surface factory; with a flat field the per-pixel gain collapses to the
 * paper lift, and with 95 % of the sheet already at `PAPER_WHITE` (245) that
 * lift is exactly 1. The remaining 5 % is the ink.
 */
const INK: readonly [number, number, number] = [100, 100, 100];
const PAPER: readonly [number, number, number] = [245, 245, 245];

function testPage(): Uint8ClampedArray {
  return rgba(Array.from({ length: 100 }, (_, index) => (index < 10 ? INK : PAPER)));
}

/** Every surface this hands out is a flat mid-grey — the flat light field. */
const flatField: SurfaceFactory<HTMLCanvasElement> = (width, height) => {
  const count = Math.max(1, Math.round(width)) * Math.max(1, Math.round(height));
  return asCanvas(
    surfaceOf(
      Math.max(1, Math.round(width)),
      Math.max(1, Math.round(height)),
      rgba(Array.from({ length: count }, () => [128, 128, 128] as const)),
    ),
  );
};

test("the flat-field page really is an illumination no-op", () => {
  const pixels = testPage();
  normalizeIllumination(asCanvas(surfaceOf(10, 10, pixels)), flatField);
  assert.deepEqual(pixelAt(pixels, 0), [100, 100, 100]);
  assert.deepEqual(pixelAt(pixels, 99), [245, 245, 245]);
});

test('the "clean" finish is normalize → deepenInk', () => {
  const shipped = testPage();
  applyFinish(asCanvas(surfaceOf(10, 10, shipped)), "clean", flatField);

  const expected = testPage();
  deepenInk(normalizeIllumination(asCanvas(surfaceOf(10, 10, expected)), flatField));

  assert.deepEqual([...shipped], [...expected]);
  // And it is not the old `clarear`: the ink moved.
  const withoutInk = testPage();
  normalizeIllumination(asCanvas(surfaceOf(10, 10, withoutInk)), flatField);
  assert.notDeepEqual([...shipped], [...withoutInk]);
  assert.ok(pixelAt(shipped, 0)[0] < pixelAt(withoutInk, 0)[0]);
  // The paper the illumination pass just lifted is left where it was put.
  assert.deepEqual(pixelAt(shipped, 99), [245, 245, 245]);
});

test('the "bw" finish is normalize → binarize, with no ink curve in between', () => {
  const shipped = testPage();
  applyFinish(asCanvas(surfaceOf(10, 10, shipped)), "bw", flatField);

  const expected = testPage();
  binarize(normalizeIllumination(asCanvas(surfaceOf(10, 10, expected)), flatField));
  assert.deepEqual([...shipped], [...expected]);

  // The proof that it matters: deepening first moves Otsu's split, and the same
  // photograph comes out cut somewhere else.
  const deepened = testPage();
  binarize(
    deepenInk(normalizeIllumination(asCanvas(surfaceOf(10, 10, deepened)), flatField)),
  );
  assert.notDeepEqual([...shipped], [...deepened]);
});

test('the "original" finish touches nothing at all', () => {
  const pixels = testPage();
  const surface = surfaceOf(10, 10, pixels);
  assert.equal(applyFinish(asCanvas(surface), "original", flatField), asCanvas(surface));
  assert.deepEqual([...pixels], [...testPage()]);
});
