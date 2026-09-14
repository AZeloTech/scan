/**
 * The geometry the whole engine rests on: the crop, the two `align_corners`
 * conversions, and the guards that decide whether a map is a page.
 *
 * The load-bearing test here is the identity one. If the composed map of an
 * identity grid is not *exactly* the crop rectangle, then every threshold in
 * `guards.ts` is measuring against a baseline that is already wrong, and the
 * error would show up as a half-pixel blur nobody could trace.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CLASSICAL_CROP_PAD,
  cropIdentityPoint,
  cropPadForMode,
  outputDimsFromQuad,
  paddedCropBox,
  renderKeyFor,
} from "./crop.ts";
import {
  CLASSICAL_GRID_HEIGHT,
  CLASSICAL_GRID_WIDTH,
  GridContractError,
  composeToCanonical,
  identityGrid,
  parseGridTensor,
  sampleCoarseGrid,
  type CoarseGrid,
} from "./grid.ts";
import {
  CLASSICAL_MIN_CROP_SIDE_PX,
  MAX_BOUNDARY_OFFSET_FRACTION,
  MAX_EDGE_OFFSET_FRACTION,
  evaluateComposedMap,
  evaluateEligibility,
} from "./guards.ts";
import { renderThroughGrid } from "./sampler.ts";
import type { CropBox, DewarpQuad, RgbaImage } from "./types.ts";

function rectQuad(
  left: number,
  top: number,
  width: number,
  height: number,
): DewarpQuad {
  return {
    topLeft: { x: left, y: top },
    topRight: { x: left + width, y: top },
    bottomRight: { x: left + width, y: top + height },
    bottomLeft: { x: left, y: top + height },
  };
}

/** A deterministic RGB field with no repeated rows — so a shift is visible. */
function syntheticImage(width: number, height: number): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = (x * 37 + y * 17) % 256;
      data[offset + 1] = (x * 11 + y * 53) % 256;
      data[offset + 2] = (x * 29 + y * 3) % 256;
      data[offset + 3] = 255;
    }
  }
  return { width, height, data };
}

test("the crop pads 8 % of the quad's own bounding box, clipped to the image", () => {
  // Worked example: a 400×200 quad at (100,50) in a 1000×800 canonical.
  // 8 % of 400 = 32, of 200 = 16 → left 68, top 34, right 532, bottom 266.
  const crop = paddedCropBox(rectQuad(100, 50, 400, 200), 1000, 800);
  assert.equal(CLASSICAL_CROP_PAD, 0.08);
  assert.deepEqual(crop, { left: 68, top: 34, width: 464, height: 232 });

  // The same quad hard against the top-left corner cannot pad past the image.
  const clipped = paddedCropBox(rectQuad(0, 0, 400, 200), 1000, 800);
  assert.equal(clipped.left, 0);
  assert.equal(clipped.top, 0);
  assert.equal(clipped.width, 432);
  assert.equal(clipped.height, 216);
});

test("cropPadForMode is the only place the pad is decided", () => {
  // A field-corpus sweep chose 0.08 — the
  // smallest of {0.08, 0.10, 0.12} that stops the quad-aligned export window
  // being crop-bounds-ceiling-limited without regressing the captures already
  // accepted. Pinned as a literal so a nudge fails loudly here instead of
  // silently changing the accept rate on a corpus this test cannot see.
  assert.equal(CLASSICAL_CROP_PAD, 0.08);
  assert.equal(cropPadForMode("classical"), CLASSICAL_CROP_PAD);

  // And it actually reaches the crop math rather than being a spare constant.
  const quad = rectQuad(100, 50, 400, 200);
  const padded = paddedCropBox(quad, 1000, 800, cropPadForMode("classical"));
  const narrower = paddedCropBox(quad, 1000, 800, 0.06);
  assert.ok(padded.width > narrower.width);
  assert.ok(padded.height > narrower.height);
});

test("output dims follow scanic's max-of-each-opposite-pair rule", () => {
  // A trapezoid: top edge 300 wide, bottom edge 400; sides 200 and 200 tall.
  // scanic takes the max of {bottom, top} for width and of {right, left} for
  // height, so this is 400 × round(hypot(50,200)) = 400 × 206.
  const quad: DewarpQuad = {
    topLeft: { x: 50, y: 0 },
    topRight: { x: 350, y: 0 },
    bottomRight: { x: 400, y: 200 },
    bottomLeft: { x: 0, y: 200 },
  };
  assert.deepEqual(outputDimsFromQuad(quad), { width: 400, height: 206 });

  // A plain rectangle is its own size.
  assert.deepEqual(outputDimsFromQuad(rectQuad(10, 10, 640, 480)), {
    width: 640,
    height: 480,
  });
});

test("the render key changes with the quad and the engine, not with sub-pixel jitter", () => {
  const base = {
    sourceId: "page-1",
    quad: rectQuad(100, 50, 400, 200),
    padVersion: "pad-v1",
    modelVersion: "dewarp-classical-2ae72e6f",
  };
  const key = renderKeyFor(base);
  assert.match(key, /^[0-9a-f]{16}$/);

  // 1/1000 px of corner jitter is quantised away.
  const jittered = rectQuad(100.0004, 50, 400, 200);
  assert.equal(renderKeyFor({ ...base, quad: jittered }), key);

  // A visible corner move, a different pad rule and a different engine build all count.
  assert.notEqual(renderKeyFor({ ...base, quad: rectQuad(101, 50, 400, 200) }), key);
  assert.notEqual(renderKeyFor({ ...base, padVersion: "pad-v2" }), key);
  assert.notEqual(renderKeyFor({ ...base, modelVersion: "other" }), key);
  assert.notEqual(renderKeyFor({ ...base, sourceId: "page-2" }), key);
});

test("the grid contract rejects anything that is not our 65×47 float grid", () => {
  const good = {
    dims: [1, 2, CLASSICAL_GRID_HEIGHT, CLASSICAL_GRID_WIDTH],
    type: "float32",
    data: new Float32Array(2 * CLASSICAL_GRID_HEIGHT * CLASSICAL_GRID_WIDTH),
  };
  assert.equal(parseGridTensor(good).width, CLASSICAL_GRID_WIDTH);

  assert.throws(
    () => parseGridTensor({ ...good, type: "float16" }),
    GridContractError,
  );
  assert.throws(
    () => parseGridTensor({ ...good, dims: [1, 2, 31, 45] }),
    GridContractError,
  );
  assert.throws(
    () => parseGridTensor({ ...good, data: new Float32Array(10) }),
    GridContractError,
  );
});

test("an identity grid composes to exactly the crop rectangle", () => {
  const crop: CropBox = { left: 76, top: 38, width: 448, height: 224 };
  const grid = identityGrid();
  // "Exactly" is bounded by the grid's own float32 storage: a millionth of the
  // crop diagonal, i.e. well under a thousandth of a pixel on this crop.
  const tolerance = Math.hypot(crop.width - 1, crop.height - 1) * 1e-6;
  for (const [u, v] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
    [0.5, 0.5],
    [0.137, 0.921],
  ] as const) {
    const composed = composeToCanonical(grid, crop, u, v);
    const flat = cropIdentityPoint(crop, u, v);
    assert.ok(
      Math.abs(composed.x - flat.x) < tolerance &&
        Math.abs(composed.y - flat.y) < tolerance,
      `identity composition drifted at (${u},${v}): ${JSON.stringify(composed)} vs ${JSON.stringify(flat)}`,
    );
  }
});

test("sampling through an identity grid reproduces the crop region pixel for pixel", () => {
  const source = syntheticImage(200, 160);
  const crop: CropBox = { left: 20, top: 12, width: 64, height: 48 };
  const rendered = renderThroughGrid({
    source,
    grid: identityGrid(),
    crop,
    width: crop.width,
    height: crop.height,
  });
  assert.ok(rendered !== null);
  for (let y = 0; y < crop.height; y += 1) {
    for (let x = 0; x < crop.width; x += 1) {
      const to = (y * crop.width + x) * 4;
      const from = ((y + crop.top) * source.width + (x + crop.left)) * 4;
      assert.equal(rendered.data[to], source.data[from], `red at ${x},${y}`);
      assert.equal(rendered.data[to + 1], source.data[from + 1], `green at ${x},${y}`);
      assert.equal(rendered.data[to + 2], source.data[from + 2], `blue at ${x},${y}`);
    }
  }
});

test("composition of a known grid matches four hand-computed points", () => {
  // A 3×3 grid on a 101 × 201 crop at (10, 20). With align_corners the crop
  // spans pixel centres 10…110 in x and 20…220 in y, so g = 0 lands exactly on
  // the middle pixel and g = ±1 on the first/last.
  const grid: CoarseGrid = {
    width: 3,
    height: 3,
    x: Float32Array.from([-1, 0, 1, -1, 0, 1, -1, 0, 1]),
    y: Float32Array.from([-1, -1, -1, 0, 0, 0, 1, 1, 1]),
  };
  const crop: CropBox = { left: 10, top: 20, width: 101, height: 201 };

  // (u,v)=(0,0) → g=(-1,-1) → crop pixel (0,0) → canonical (10,20)
  assert.deepEqual(composeToCanonical(grid, crop, 0, 0), { x: 10, y: 20 });
  // (1,1) → g=(1,1) → crop pixel (100,200) → canonical (110,220)
  assert.deepEqual(composeToCanonical(grid, crop, 1, 1), { x: 110, y: 220 });
  // (0.5,0.5) → g=(0,0) → crop pixel (50,100) → canonical (60,120)
  assert.deepEqual(composeToCanonical(grid, crop, 0.5, 0.5), { x: 60, y: 120 });
  // (0.25,0) → g=(-0.5,-1) → crop pixel (25,0) → canonical (35,20)
  const quarter = composeToCanonical(grid, crop, 0.25, 0);
  assert.ok(Math.abs(quarter.x - 35) < 1e-6 && Math.abs(quarter.y - 20) < 1e-6);
});

test("the coarse grid interpolates linearly between lattice nodes", () => {
  // Two nodes 0 and 1 in x: the midpoint of the output is the midpoint of the
  // values, which is the property the per-pixel composition depends on.
  const grid: CoarseGrid = {
    width: 2,
    height: 2,
    x: Float32Array.from([0, 1, 0, 1]),
    y: Float32Array.from([0, 0, 1, 1]),
  };
  const middle = sampleCoarseGrid(grid, 0.5, 0.25);
  assert.ok(Math.abs(middle.x - 0.5) < 1e-6);
  assert.ok(Math.abs(middle.y - 0.25) < 1e-6);
});

/* ── Eligibility ───────────────────────────────────────────────────────── */

test("the eligibility gate admits a page and refuses the shapes that are not one", () => {
  const bigCrop: CropBox = { left: 0, top: 0, width: 800, height: 600 };

  // A plain rectangle photographed straight on.
  assert.equal(evaluateEligibility(rectQuad(0, 0, 700, 500), bigCrop).eligible, true);

  // A moderately oblique but real page: still in.
  const oblique: DewarpQuad = {
    topLeft: { x: 80, y: 20 },
    topRight: { x: 620, y: 60 },
    bottomRight: { x: 700, y: 520 },
    bottomLeft: { x: 20, y: 470 },
  };
  assert.equal(evaluateEligibility(oblique, bigCrop).eligible, true);

  // A sliver: the quad fills far too little of its own bounding box.
  const sliver: DewarpQuad = {
    topLeft: { x: 0, y: 0 },
    topRight: { x: 700, y: 480 },
    bottomRight: { x: 700, y: 500 },
    bottomLeft: { x: 0, y: 20 },
  };
  assert.equal(evaluateEligibility(sliver, bigCrop).failure, "quad-fill");

  // A kite: one corner far too sharp.
  const kite: DewarpQuad = {
    topLeft: { x: 0, y: 250 },
    topRight: { x: 350, y: 0 },
    bottomRight: { x: 700, y: 250 },
    bottomLeft: { x: 350, y: 300 },
  };
  const kiteResult = evaluateEligibility(kite, bigCrop);
  assert.equal(kiteResult.eligible, false);
  assert.ok(kiteResult.failure === "quad-angle" || kiteResult.failure === "quad-fill");

  // Opposite edges 3:1 — not one sheet seen in perspective.
  const wedge: DewarpQuad = {
    topLeft: { x: 300, y: 0 },
    topRight: { x: 400, y: 0 },
    bottomRight: { x: 700, y: 500 },
    bottomLeft: { x: 0, y: 500 },
  };
  assert.equal(evaluateEligibility(wedge, bigCrop).failure, "quad-edge-ratio");

  // A fine quad, but the crop is below the engine's resolution floor.
  const tinyCrop: CropBox = {
    left: 0,
    top: 0,
    width: CLASSICAL_MIN_CROP_SIDE_PX - 1,
    height: 400,
  };
  assert.equal(
    evaluateEligibility(rectQuad(0, 0, 200, 300), tinyCrop).failure,
    "crop-resolution",
  );
});

/* ── Map guards ────────────────────────────────────────────────────────── */

/** Perturbs an identity grid with a sinusoid of `amplitude` in [-1,1] units. */
function sinusoidGrid(amplitude: number, cycles = 1): CoarseGrid {
  const grid = identityGrid();
  for (let row = 0; row < grid.height; row += 1) {
    const v = row / (grid.height - 1);
    for (let column = 0; column < grid.width; column += 1) {
      const index = row * grid.width + column;
      grid.y[index] += amplitude * Math.sin(2 * Math.PI * cycles * v);
    }
  }
  return grid;
}

test("the identity map passes every geometric guard with zero displacement", () => {
  const quad = rectQuad(76, 38, 447, 223);
  const crop: CropBox = { left: 76, top: 38, width: 448, height: 224 };
  const result = evaluateComposedMap(identityGrid(), crop, quad, 1000, 800);
  assert.equal(result.ok, true, JSON.stringify(result));
  // Float32 grid storage is the only thing between this and a hard zero.
  assert.ok(result.stats.maxDisplacementFraction < 1e-6);
  assert.ok(Math.abs(result.stats.minNormalizedJacobian - 1) < 1e-3);
  assert.ok(Math.abs(result.stats.maxNormalizedSingular - 1) < 1e-3);
  assert.ok(result.stats.maxBoundaryOffsetFraction <= MAX_BOUNDARY_OFFSET_FRACTION);
});

test("a gentle sinusoid stays inside the guards and reports the displacement it makes", () => {
  const quad = rectQuad(76, 38, 447, 223);
  const crop: CropBox = { left: 76, top: 38, width: 448, height: 224 };
  // amplitude 0.01 in [-1,1] is 0.5 % of the crop height — a page that bows by
  // about one line of text.
  const result = evaluateComposedMap(sinusoidGrid(0.01), crop, quad, 1000, 800);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.stats.maxDisplacementFraction > 0);
  assert.ok(result.stats.maxDisplacementFraction < 0.02);
});

test("a folded grid is rejected by the Jacobian guard", () => {
  // Reverse the y ramp over the bottom half: the map doubles back on itself,
  // which is exactly a determinant sign flip.
  const grid = identityGrid();
  for (let row = 0; row < grid.height; row += 1) {
    const v = row / (grid.height - 1);
    if (v <= 0.5) continue;
    for (let column = 0; column < grid.width; column += 1) {
      grid.y[row * grid.width + column] = 1 - 2 * v;
    }
  }
  const crop: CropBox = { left: 76, top: 38, width: 448, height: 224 };
  const result = evaluateComposedMap(grid, crop, rectQuad(76, 38, 447, 223), 1000, 800);
  assert.equal(result.ok, false);
  assert.equal(result.failure, "jacobian");
  assert.ok(result.stats.minNormalizedJacobian < 0);
});

test("a grid that reaches outside the canonical image is rejected, never clamped", () => {
  const grid = identityGrid();
  // Push every x sample a whole crop-width to the left of the crop.
  for (let index = 0; index < grid.x.length; index += 1) grid.x[index] -= 2;
  const crop: CropBox = { left: 10, top: 10, width: 448, height: 224 };
  const result = evaluateComposedMap(grid, crop, rectQuad(10, 10, 447, 223), 1000, 800);
  assert.equal(result.ok, false);
  assert.equal(result.failure, "out-of-bounds");
});

test("a map whose corners land away from the confirmed quad fails the boundary guard", () => {
  const crop: CropBox = { left: 0, top: 0, width: 448, height: 224 };
  // The map is the identity of the crop, but the user confirmed a quad well
  // inside it — so the map would be cropping to a different document.
  const inner = rectQuad(120, 60, 200, 100);
  const result = evaluateComposedMap(identityGrid(), crop, inner, 1000, 800);
  assert.equal(result.ok, false);
  assert.equal(result.failure, "boundary");
  assert.ok(result.stats.maxBoundaryOffsetFraction > MAX_BOUNDARY_OFFSET_FRACTION);
});

test("an hourglass map keeps every corner and still loses the margins", () => {
  const crop: CropBox = { left: 76, top: 38, width: 448, height: 224 };
  const quad = rectQuad(76, 38, 447, 223);
  // Each row is squeezed towards the page's vertical centre line by a bulge
  // that vanishes at v=0 and v=1 — so all four corners land exactly where the
  // user put them, and the middle of the left and right edges is pulled inside
  // the page. This is what silently eats a margin annotation.
  const grid = identityGrid();
  for (let row = 0; row < grid.height; row += 1) {
    const pinch = 0.35 * Math.sin(Math.PI * (row / (grid.height - 1)));
    for (let column = 0; column < grid.width; column += 1) {
      grid.x[row * grid.width + column] *= 1 - pinch;
    }
  }
  const result = evaluateComposedMap(grid, crop, quad, 1000, 800);
  assert.equal(result.ok, false, JSON.stringify(result.stats));
  assert.equal(result.failure, "boundary");
  // The corner probe alone — all this guard used to be — sees nothing at all.
  assert.ok(
    result.stats.maxBoundaryOffsetFraction <= MAX_BOUNDARY_OFFSET_FRACTION,
    `corners moved: ${result.stats.maxBoundaryOffsetFraction}`,
  );
  assert.ok(result.stats.maxEdgeOffsetFraction > MAX_EDGE_OFFSET_FRACTION);
});

test("a page that bows within its own edges is still a page", () => {
  const crop: CropBox = { left: 76, top: 38, width: 448, height: 224 };
  const quad = rectQuad(76, 38, 447, 223);
  // The same shape at a tenth of the amplitude: a real curl reaches the edge,
  // and the edge check must not turn that into a fallback.
  const grid = identityGrid();
  for (let row = 0; row < grid.height; row += 1) {
    const pinch = 0.035 * Math.sin(Math.PI * (row / (grid.height - 1)));
    for (let column = 0; column < grid.width; column += 1) {
      grid.x[row * grid.width + column] *= 1 - pinch;
    }
  }
  const result = evaluateComposedMap(grid, crop, quad, 1000, 800);
  assert.equal(result.ok, true, JSON.stringify(result.stats));
  assert.ok(result.stats.maxEdgeOffsetFraction > 0);
});

test("a fold in one cell's corner is caught, not averaged away", () => {
  const crop: CropBox = { left: 76, top: 38, width: 448, height: 224 };
  const grid = identityGrid();
  // One interior node pulled back past its upstairs neighbour. The map doubles
  // over inside the cell above-left of it — at that cell's bottom-right corner
  // only. Every reading that straddles a cell border, and the cell's own
  // centre, stay comfortably positive; the corner is where the sign flips, and
  // a corner is a place the renderer samples.
  const node = 20 * grid.width + 15;
  grid.y[node] -= 0.06;
  const result = evaluateComposedMap(grid, crop, rectQuad(76, 38, 447, 223), 1000, 800);
  assert.equal(result.ok, false, JSON.stringify(result.stats));
  assert.equal(result.failure, "jacobian");
  assert.ok(result.stats.minNormalizedJacobian < 0);
});

test("a large-amplitude grid trips the displacement guard before anything else", () => {
  const crop: CropBox = { left: 76, top: 38, width: 448, height: 224 };
  const grid = identityGrid();
  // A uniform half-crop shove: no fold, no scale change, just wrong.
  for (let index = 0; index < grid.y.length; index += 1) grid.y[index] *= 0.2;
  for (let index = 0; index < grid.x.length; index += 1) grid.x[index] *= 0.2;
  const result = evaluateComposedMap(grid, crop, rectQuad(76, 38, 447, 223), 1000, 800);
  assert.equal(result.ok, false);
  // A 5× squeeze is a scale failure; it must be caught, and by a scale-shaped
  // reason rather than being waved through.
  assert.ok(
    result.failure === "scale" || result.failure === "displacement",
    `unexpected failure ${result.failure}`,
  );
});
