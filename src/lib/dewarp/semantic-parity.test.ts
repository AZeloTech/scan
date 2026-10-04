/**
 * The A/B has to be fair before it can be right.
 *
 * The caller's flat baseline is a small copy of the canonical, warped once and
 * then downscaled for measurement; every one of those bilinear passes spreads
 * a stroke a little further. A candidate sampled straight from the full-size
 * canonical has none of that blur, so on a geometrically *identical* page its
 * strokes are thinner and the ink clause reads the difference as "the dewarp
 * lost ink". The fix is to put the candidate through the baseline's own chain.
 *
 * This file holds it to that where the answer is known, and against the real
 * flat path wherever it can: the baselines and the shipped flat page below are
 * made by scanic's own `extractDocument` (run on a stand-in canvas that only
 * stores pixels — its warp is plain JavaScript), not by a copy of it. The one
 * thing emulated is the browser's `drawImage` downscale, twice over: a bilinear
 * tap and an area average, the two ends of what a browser may use.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { outputDimsFromQuad, paddedCropBox } from "./crop.ts";
import {
  CLASSICAL_GRID_HEIGHT,
  CLASSICAL_GRID_WIDTH,
  identityGrid,
  type CoarseGrid,
} from "./grid.ts";
import { renderAcceptedGeometry } from "./index.ts";
import {
  copyScale,
  quadOnScaledCopy,
  renderThroughGrid,
  toScaledCopy,
  fitLongEdge,
} from "./sampler.ts";
import {
  SEMANTIC_LONG_EDGE,
  measureSurface,
  renderSemanticCandidate,
} from "./semantic.ts";
import type { CropBox, DewarpPoint, DewarpQuad, RgbaImage } from "./types.ts";

/** `dewarp-stage.ts :: BASELINE_SOURCE_LONG_EDGE`. */
const BASELINE_SOURCE_LONG_EDGE = 896;

/* ── scanic, for real ──────────────────────────────────────────────────── */

type Extract = (
  source: RgbaImage,
  corners: DewarpQuad,
  options: { output: "imagedata" },
) => Promise<{ success: boolean; output: RgbaImage | null; message?: string }>;

let extractDocument: Extract;
const realDocument = (globalThis as { document?: unknown }).document;

/**
 * Just enough of a 2-D canvas for `extractDocument` handed an `ImageData`:
 * it puts the source on a canvas, reads it back, and writes its output with
 * `createImageData`/`putImageData`. Nothing is drawn, so nothing is emulated.
 */
function standInCanvas(): unknown {
  const canvas: { width: number; height: number; getContext?: () => unknown } = {
    width: 0,
    height: 0,
  };
  let held: RgbaImage | null = null;
  const context = {
    canvas,
    createImageData: (width: number, height: number): RgbaImage => ({
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4),
    }),
    putImageData(image: RgbaImage) {
      held = image;
    },
    getImageData: (_x: number, _y: number, width: number, height: number): RgbaImage =>
      held === null
        ? { width, height, data: new Uint8ClampedArray(width * height * 4) }
        : { width: held.width, height: held.height, data: new Uint8ClampedArray(held.data) },
    drawImage() {
      throw new Error("the stand-in canvas cannot draw");
    },
  };
  canvas.getContext = () => context;
  return canvas;
}

before(async () => {
  (globalThis as { document?: unknown }).document = {
    createElement: () => standInCanvas(),
  };
  const scanic = (await import("scanic")) as unknown as { extractDocument: Extract };
  extractDocument = scanic.extractDocument;
});

after(() => {
  (globalThis as { document?: unknown }).document = realDocument;
});

/** `flatten.ts :: warpToCanvas` — scanic's flat page of `quad`, in `source`'s pixels. */
async function scanicFlat(source: RgbaImage, quad: DewarpQuad): Promise<RgbaImage> {
  const result = await extractDocument(source, quad, { output: "imagedata" });
  assert.ok(result.success && result.output !== null, result.message);
  return result.output;
}

/* ── Pages ─────────────────────────────────────────────────────────────── */

function blank(width: number, height: number): RgbaImage {
  const image: RgbaImage = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  for (let index = 3; index < image.data.length; index += 4) image.data[index] = 255;
  return image;
}

function fill(image: RgbaImage, x: number, y: number, w: number, h: number, level: number): void {
  for (let row = Math.max(0, y); row < Math.min(image.height, y + h); row += 1) {
    for (let column = Math.max(0, x); column < Math.min(image.width, x + w); column += 1) {
      const offset = (row * image.width + column) * 4;
      image.data[offset] = level;
      image.data[offset + 1] = level;
      image.data[offset + 2] = level;
    }
  }
}

/**
 * A phone photo of a printed page, reduced to what the ink clause sees: a dark
 * table, a light sheet on it, and lines of thin-stroked glyphs — outlines a few
 * pixels wide, which is what body text is at 12 MP and what resampling
 * thickens. Drawn at 2400 px wide and scaled with `width`.
 */
function photographedPage(width: number, height: number): RgbaImage {
  const k = width / 2400;
  const at = (value: number) => Math.round(value * k);
  const stroke = Math.max(2, at(3));
  const image = blank(width, height);
  fill(image, 0, 0, width, height, 70);
  fill(image, at(240), at(200), at(1940), at(2800), 238);
  for (let lineY = 420; lineY < 2800; lineY += 72) {
    for (let x = 420; x < 1980; x += 38) {
      // A hollow glyph, plus a crossbar on every other one.
      fill(image, at(x), at(lineY), at(26), stroke, 30);
      fill(image, at(x), at(lineY + 33), at(26), stroke, 30);
      fill(image, at(x), at(lineY), stroke, at(36), 30);
      fill(image, at(x + 23), at(lineY), stroke, at(36), 30);
      if (((x / 38) | 0) % 2 === 0) fill(image, at(x), at(lineY + 16), at(26), stroke, 30);
    }
  }
  return image;
}

/* ── The browser's downscale, both ends of it ──────────────────────────── */

function bilinear(image: RgbaImage, x: number, y: number, out: Float64Array): void {
  const maxX = image.width - 1;
  const maxY = image.height - 1;
  const sx = Math.min(maxX, Math.max(0, x));
  const sy = Math.min(maxY, Math.max(0, y));
  const x0 = Math.floor(sx);
  const y0 = Math.floor(sy);
  const x1 = Math.min(maxX, x0 + 1);
  const y1 = Math.min(maxY, y0 + 1);
  const fx = sx - x0;
  const fy = sy - y0;
  for (let channel = 0; channel < 3; channel += 1) {
    const value = (px: number, py: number) => image.data[(py * image.width + px) * 4 + channel];
    out[channel] =
      value(x0, y0) * (1 - fx) * (1 - fy) +
      value(x1, y0) * fx * (1 - fy) +
      value(x0, y1) * (1 - fx) * fy +
      value(x1, y1) * fx * fy;
  }
}

/** `canvas-surface.ts :: scaleSurface`'s size: each axis rounded on its own. */
function copySize(image: RgbaImage, longEdge: number): { width: number; height: number } {
  const scale = Math.min(1, longEdge / Math.max(image.width, image.height));
  return {
    width: Math.max(1, Math.round(image.width * scale)),
    height: Math.max(1, Math.round(image.height * scale)),
  };
}

type Downscale = (image: RgbaImage, width: number, height: number) => RgbaImage;

/** `drawImage` at the default smoothing: one bilinear tap per pixel centre. */
const bilinearTap: Downscale = (image, width, height) => {
  const out = blank(width, height);
  const rgb = new Float64Array(3);
  const sx = image.width / width;
  const sy = image.height / height;
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      bilinear(image, (column + 0.5) * sx - 0.5, (row + 0.5) * sy - 0.5, rgb);
      const offset = (row * width + column) * 4;
      out.data[offset] = rgb[0];
      out.data[offset + 1] = rgb[1];
      out.data[offset + 2] = rgb[2];
    }
  }
  return out;
};

/** A prefiltered `drawImage` (mipmaps, "high" quality): each copy pixel's exact area. */
const areaAverage: Downscale = (image, width, height) => {
  const out = blank(width, height);
  const sx = image.width / width;
  const sy = image.height / height;
  for (let row = 0; row < height; row += 1) {
    const y0 = row * sy;
    const y1 = (row + 1) * sy;
    for (let column = 0; column < width; column += 1) {
      const x0 = column * sx;
      const x1 = (column + 1) * sx;
      const sum = [0, 0, 0];
      let weight = 0;
      for (let py = Math.floor(y0); py < Math.ceil(y1); py += 1) {
        const wy = Math.min(y1, py + 1) - Math.max(y0, py);
        for (let px = Math.floor(x0); px < Math.ceil(x1); px += 1) {
          const w = wy * (Math.min(x1, px + 1) - Math.max(x0, px));
          const offset = (py * image.width + px) * 4;
          sum[0] += image.data[offset] * w;
          sum[1] += image.data[offset + 1] * w;
          sum[2] += image.data[offset + 2] * w;
          weight += w;
        }
      }
      const offset = (row * width + column) * 4;
      out.data[offset] = sum[0] / weight;
      out.data[offset + 1] = sum[1] / weight;
      out.data[offset + 2] = sum[2] / weight;
    }
  }
  return out;
};

/* ── Geometry ──────────────────────────────────────────────────────────── */

/** The unit square onto a quad, projectively (Heckbert's closed form). */
function unitSquareToQuad(quad: DewarpQuad): (u: number, v: number) => DewarpPoint {
  const [p0, p1, p2, p3] = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const dy3 = p0.y - p1.y + p2.y - p3.y;
  const denominator = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / denominator;
  const h = (dx1 * dy3 - dx3 * dy1) / denominator;
  const a = p1.x - p0.x + g * p1.x;
  const b = p3.x - p0.x + h * p3.x;
  const d = p1.y - p0.y + g * p1.y;
  const e = p3.y - p0.y + h * p3.y;
  return (u, v) => {
    const w = g * u + h * v + 1;
    return { x: (a * u + b * v + p0.x) / w, y: (d * u + e * v + p0.y) / w };
  };
}

/**
 * The grid of a page with zero displacement: every node exactly where the
 * page's own homography puts it, in the padded crop's `align_corners` frame.
 */
function homographyGrid(
  quad: DewarpQuad,
  canonical: RgbaImage,
): { grid: CoarseGrid; crop: CropBox } {
  const crop = paddedCropBox(quad, canonical.width, canonical.height);
  const map = unitSquareToQuad(quad);
  const width = CLASSICAL_GRID_WIDTH;
  const height = CLASSICAL_GRID_HEIGHT;
  const x = new Float32Array(width * height);
  const y = new Float32Array(width * height);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const point = map(column / (width - 1), row / (height - 1));
      x[row * width + column] = ((point.x - crop.left) / (crop.width - 1)) * 2 - 1;
      y[row * width + column] = ((point.y - crop.top) / (crop.height - 1)) * 2 - 1;
    }
  }
  return { grid: { width, height, x, y }, crop };
}

/** A rotated rectangle: its homography is affine, so a coarse grid carries it exactly. */
function rotatedRectangle(
  cx: number,
  cy: number,
  width: number,
  height: number,
  degrees: number,
): DewarpQuad {
  const angle = (degrees * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const at = (dx: number, dy: number): DewarpPoint => ({
    x: cx + dx * cos - dy * sin,
    y: cy + dx * sin + dy * cos,
  });
  return {
    topLeft: at(-width / 2, -height / 2),
    topRight: at(width / 2, -height / 2),
    bottomRight: at(width / 2, height / 2),
    bottomLeft: at(-width / 2, height / 2),
  };
}

/** A photographed page in perspective — the grid is then an approximation. */
const PERSPECTIVE: DewarpQuad = {
  topLeft: { x: 260, y: 220 },
  topRight: { x: 2150, y: 300 },
  bottomRight: { x: 2090, y: 2980 },
  bottomLeft: { x: 320, y: 2900 },
};

function scaledQuad(quad: DewarpQuad, k: number): DewarpQuad {
  const at = (point: DewarpPoint): DewarpPoint => ({ x: point.x * k, y: point.y * k });
  return {
    topLeft: at(quad.topLeft),
    topRight: at(quad.topRight),
    bottomRight: at(quad.bottomRight),
    bottomLeft: at(quad.bottomLeft),
  };
}

/** Per-channel absolute differences of two same-sized images. */
function difference(a: RgbaImage, b: RgbaImage): { max: number; mean: number; off: number } {
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  let max = 0;
  let sum = 0;
  let off = 0;
  let count = 0;
  for (let index = 0; index < a.data.length; index += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      const delta = Math.abs(a.data[index + channel] - b.data[index + channel]);
      if (delta > max) max = delta;
      if (delta > 1) off += 1;
      sum += delta;
      count += 1;
    }
  }
  return { max, mean: sum / count, off: off / count };
}

/* ── Where the copy's pixels are ───────────────────────────────────────── */

/**
 * A ramp in each axis — R is the column, G the row — scaled by two different
 * factors. Any centre-aligned filter reproduces a linear ramp exactly at the
 * pixel centres it samples, so the copy holds, at each of its pixels, the
 * canonical position `drawImage` put there — and a mapping either reads that
 * position back or it does not.
 */
function rampCanonical(): RgbaImage {
  const image = blank(250, 200);
  for (let row = 0; row < image.height; row += 1) {
    for (let column = 0; column < image.width; column += 1) {
      const offset = (row * image.width + column) * 4;
      image.data[offset] = column;
      image.data[offset + 1] = row;
    }
  }
  return image;
}

/** Render the canonical's interior 1:1 from the copy, and how far R/G land from truth. */
function readBack(
  copy: RgbaImage,
  scale: { x: number; y: number },
): { maxX: number; maxY: number } {
  const crop: CropBox = { left: 20, top: 20, width: 210, height: 160 };
  const image = renderThroughGrid({
    source: copy,
    grid: identityGrid(),
    crop,
    width: crop.width,
    height: crop.height,
    sourceScale: scale,
  });
  assert.ok(image !== null);
  let maxX = 0;
  let maxY = 0;
  for (let row = 0; row < image.height; row += 1) {
    for (let column = 0; column < image.width; column += 1) {
      const offset = (row * image.width + column) * 4;
      maxX = Math.max(maxX, Math.abs(image.data[offset] - (crop.left + column)));
      maxY = Math.max(maxY, Math.abs(image.data[offset + 1] - (crop.top + row)));
    }
  }
  return { maxX, maxY };
}

for (const [name, downscale] of [
  ["bilinear tap", bilinearTap],
  ["area average", areaAverage],
] as const) {
  test(`the candidate reads the copy where drawImage put each pixel (${name}, per axis)`, () => {
    const canonical = rampCanonical();
    // Deliberately unequal: 250→37 is ×0.148, 200→22 is ×0.11.
    const copy = downscale(canonical, 37, 22);
    const scale = copyScale(canonical, copy);
    assert.deepEqual(scale, { x: 37 / 250, y: 22 / 200 });

    const found = readBack(copy, scale);
    // Two roundings to 8 bits (the copy, the render) and nothing else.
    assert.ok(found.maxX <= 1, `x read back ${found.maxX} levels off`);
    assert.ok(found.maxY <= 1, `y read back ${found.maxY} levels off`);

    // What the other rules would have read. Not contracts — the record of why
    // the rule is this one: `p·s` is off by ½(1/s − 1) canonical pixels (2.9
    // columns, 4 rows here), and one shared factor misreads the other axis.
    const rgb = new Float64Array(3);
    bilinear(copy, 100 * scale.x, 100 * scale.y, rgb);
    assert.ok(Math.abs(rgb[0] - 100) > 2.5, `p·s reads column ${rgb[0].toFixed(2)} for 100`);
    assert.ok(Math.abs(rgb[1] - 100) > 2.5, `p·s reads row ${rgb[1].toFixed(2)} for 100`);
    const shared = readBack(copy, { x: scale.x, y: scale.x });
    assert.ok(shared.maxY > 20, `one shared factor misreads y by ${shared.maxY}`);
  });
}

test("the baseline's quad goes onto the copy by the same rule, corner by corner", () => {
  const quad = rotatedRectangle(600, 800, 900, 1300, 3);
  const scale = { x: 0.37, y: 0.41 };
  const onCopy = quadOnScaledCopy(quad, scale);
  for (const key of ["topLeft", "topRight", "bottomRight", "bottomLeft"] as const) {
    assert.equal(onCopy[key].x, toScaledCopy(quad[key].x, scale.x));
    assert.equal(onCopy[key].y, toScaledCopy(quad[key].y, scale.y));
  }
  // Scale 1 is the identity on pixel indices.
  assert.equal(toScaledCopy(417, 1), 417);
});

/* ── Zero displacement is the flat page ────────────────────────────────── */

test("a zero-displacement grid renders the shipped flat page (scanic's own)", async () => {
  const canonical = photographedPage(1200, 1600);
  const quad = rotatedRectangle(600, 810, 960, 1390, 4);
  const shipped = await scanicFlat(canonical, quad);
  const output = outputDimsFromQuad(quad);
  assert.deepEqual({ width: shipped.width, height: shipped.height }, output);

  const { grid, crop } = homographyGrid(quad, canonical);
  const rendered = renderAcceptedGeometry(canonical, {
    grid,
    crop,
    width: output.width,
    height: output.height,
  });
  assert.ok(rendered !== null);
  const delta = difference(rendered, shipped);
  // The same bilinear sample at the same place, rounded two ways (scanic adds
  // ½ and truncates; the render's clamped array rounds half to even) plus a
  // float32 grid: a level at most, and on almost no pixel even that.
  assert.ok(delta.max <= 1, `max |Δ| ${delta.max}`);
  assert.ok(delta.mean < 0.05, `mean |Δ| ${delta.mean.toFixed(4)}`);
});

test("in perspective the coarse grid is the flat page to within a trace", async () => {
  const canonical = photographedPage(1200, 1600);
  const quad = scaledQuad(PERSPECTIVE, 0.5);
  const shipped = await scanicFlat(canonical, quad);
  const { grid, crop } = homographyGrid(quad, canonical);
  const rendered = renderAcceptedGeometry(canonical, {
    grid,
    crop,
    width: shipped.width,
    height: shipped.height,
  });
  assert.ok(rendered !== null);
  const delta = difference(rendered, shipped);
  // Between nodes the grid is bilinear and the homography is not; the stroke
  // edges move by a fraction of a pixel, nothing more.
  assert.ok(delta.mean < 1, `mean |Δ| ${delta.mean.toFixed(4)}`);
  const ink = (image: RgbaImage) => measureSurface(image).occupancy.inkFraction;
  assert.ok(Math.abs(ink(rendered) - ink(shipped)) < 0.002);
});

for (const [name, downscale] of [
  ["bilinear tap", bilinearTap],
  ["area average", areaAverage],
] as const) {
  test(`a zero-displacement candidate is the production baseline (${name})`, async () => {
    const canonical = photographedPage(1200, 1600);
    const quad = rotatedRectangle(600, 810, 960, 1390, 4);
    const size = copySize(canonical, BASELINE_SOURCE_LONG_EDGE);
    const copy = downscale(canonical, size.width, size.height);
    // `dewarp-stage.ts :: homographyBaseline`, scanic included.
    const baseline = await scanicFlat(copy, quadOnScaledCopy(quad, copyScale(canonical, copy)));

    const { grid, crop } = homographyGrid(quad, canonical);
    const output = outputDimsFromQuad(quad);
    const candidate = renderSemanticCandidate({
      canonical,
      baseline,
      baselineSource: copy,
      grid,
      crop,
      outputWidth: output.width,
      outputHeight: output.height,
    });
    assert.ok(candidate !== null);
    const delta = difference(candidate, baseline);
    assert.ok(delta.max <= 1, `max |Δ| ${delta.max}`);
    assert.ok(delta.off === 0);
  });
}

/* ── Ink ───────────────────────────────────────────────────────────────── */

test("a dewarp that is exactly the homography measures the same ink as the baseline", async () => {
  const canonical = photographedPage(2400, 3200);
  const size = copySize(canonical, BASELINE_SOURCE_LONG_EDGE);
  const copy = bilinearTap(canonical, size.width, size.height);
  const baseline = await scanicFlat(copy, quadOnScaledCopy(PERSPECTIVE, copyScale(canonical, copy)));
  const { grid, crop } = homographyGrid(PERSPECTIVE, canonical);
  const output = outputDimsFromQuad(PERSPECTIVE);

  const candidate = renderSemanticCandidate({
    canonical,
    baseline,
    baselineSource: copy,
    grid,
    crop,
    outputWidth: output.width,
    outputHeight: output.height,
  });
  assert.ok(candidate !== null);
  assert.equal(candidate.width, baseline.width);
  assert.equal(candidate.height, baseline.height);

  const base = measureSurface(baseline).occupancy.inkFraction;
  const found = measureSurface(candidate).occupancy.inkFraction;
  assert.ok(base > 0.02, `the page must have ink to lose (baseline ink ${base})`);
  assert.ok(
    Math.abs(base - found) < 0.005,
    `same geometry, same chain: ink ${base.toFixed(4)} vs ${found.toFixed(4)}`,
  );
});

test("without the baseline's source the candidate is sharper — the asymmetry this fixes", async () => {
  const canonical = photographedPage(2400, 3200);
  const size = copySize(canonical, BASELINE_SOURCE_LONG_EDGE);
  const copy = bilinearTap(canonical, size.width, size.height);
  const baseline = await scanicFlat(copy, quadOnScaledCopy(PERSPECTIVE, copyScale(canonical, copy)));
  const { grid, crop } = homographyGrid(PERSPECTIVE, canonical);
  const output = outputDimsFromQuad(PERSPECTIVE);

  const legacy = renderSemanticCandidate({
    canonical,
    baseline,
    grid,
    crop,
    outputWidth: output.width,
    outputHeight: output.height,
  });
  assert.ok(legacy !== null);
  const base = measureSurface(baseline).occupancy.inkFraction;
  const found = measureSurface(legacy).occupancy.inkFraction;
  // Not a contract — a record of why `baselineSource` exists. If this ever
  // stops holding, the single-sample path has become fair on its own.
  assert.ok(
    base - found > 0.005,
    `expected the single-sample candidate to lose ink: ${base.toFixed(4)} vs ${found.toFixed(4)}`,
  );
});

/* ── Without a usable copy ─────────────────────────────────────────────── */

test("with no copy, or one that is not a reduction, the candidate is the old single sample", () => {
  const canonical = photographedPage(600, 800);
  const quad = rotatedRectangle(300, 405, 480, 695, 2);
  const { grid, crop } = homographyGrid(quad, canonical);
  const output = outputDimsFromQuad(quad);
  const preview = fitLongEdge(output.width, output.height, SEMANTIC_LONG_EDGE);
  const legacy = renderThroughGrid({
    source: canonical,
    grid,
    crop,
    width: preview.width,
    height: preview.height,
  });
  assert.ok(legacy !== null);
  const baseline = blank(200, 290);

  const copies: (RgbaImage | undefined)[] = [
    undefined,
    // Larger than the canonical: not the copy anything was warped from.
    blank(canonical.width + 1, canonical.height),
    // Empty, and short of its own pixels.
    { width: 0, height: 0, data: new Uint8ClampedArray(0) },
    { width: 10, height: 10, data: new Uint8ClampedArray(4) },
  ];
  for (const baselineSource of copies) {
    const candidate = renderSemanticCandidate({
      canonical,
      baseline,
      ...(baselineSource === undefined ? {} : { baselineSource }),
      grid,
      crop,
      outputWidth: output.width,
      outputHeight: output.height,
    });
    assert.ok(candidate !== null);
    assert.equal(candidate.width, preview.width);
    assert.equal(candidate.height, preview.height);
    assert.deepEqual(candidate.data, legacy.data);
  }
});

test("a copy that is the canonical itself is sampled as it is", () => {
  const canonical = photographedPage(600, 800);
  const quad = rotatedRectangle(300, 405, 480, 695, 2);
  const { grid, crop } = homographyGrid(quad, canonical);
  const output = outputDimsFromQuad(quad);
  const baseline = blank(240, 347);
  const candidate = renderSemanticCandidate({
    canonical,
    baseline,
    baselineSource: canonical,
    grid,
    crop,
    outputWidth: output.width,
    outputHeight: output.height,
  });
  const direct = renderThroughGrid({
    source: canonical,
    grid,
    crop,
    width: baseline.width,
    height: baseline.height,
  });
  assert.ok(candidate !== null && direct !== null);
  assert.deepEqual(candidate.data, direct.data);
});

test("a cancelled candidate is null on either path", () => {
  const canonical = photographedPage(600, 800);
  const quad = rotatedRectangle(300, 405, 480, 695, 2);
  const { grid, crop } = homographyGrid(quad, canonical);
  const output = outputDimsFromQuad(quad);
  const copy = bilinearTap(canonical, 300, 400);
  for (const baselineSource of [undefined, copy]) {
    const candidate = renderSemanticCandidate({
      canonical,
      baseline: blank(240, 347),
      ...(baselineSource === undefined ? {} : { baselineSource }),
      grid,
      crop,
      outputWidth: output.width,
      outputHeight: output.height,
      shouldCancel: () => true,
    });
    assert.equal(candidate, null);
  }
});
