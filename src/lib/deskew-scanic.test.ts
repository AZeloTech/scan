/**
 * A rotated outline that leaves the photo, through the flattener that ships.
 *
 * Paper mode keeps the page at its own scale, so on an outline that sits on
 * the photo's own edges (a gallery import, a full-frame crop) the rotated
 * outline Q′ reaches past the photo. What scanic does there is decided here,
 * not assumed: it clamps each sample to the photo, so the region beyond is the
 * photo's edge row smeared outward — never an error, never transparent. The
 * plan marks that region (`photoInOutput`) and the fill always paints it, so
 * no smear survives into the page the user sees.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import {
  DESKEW_POLICY_VERSION,
  applyHomography,
  curlEvidence,
  deskewQuad,
  fillDeskewWedges,
  flatPageDims,
  homographyFrom,
  type DeskewImage,
  type DeskewPlan,
  type DeskewQuad,
  type SkewEstimate,
} from "./deskew.ts";

type Extract = (
  source: DeskewImage,
  corners: DeskewQuad,
  options: { output: "imagedata" },
) => Promise<{ success: boolean; output: DeskewImage | null; message?: string }>;

let extractDocument: Extract;
const realDocument = (globalThis as { document?: unknown }).document;

/** Just enough of a 2-D canvas for `extractDocument` handed pixels (as in `semantic-parity.test.ts`). */
function standInCanvas(): unknown {
  const canvas: { width: number; height: number; getContext?: () => unknown } = { width: 0, height: 0 };
  let held: DeskewImage | null = null;
  const context = {
    canvas,
    createImageData: (width: number, height: number): DeskewImage => ({
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4),
    }),
    putImageData(image: DeskewImage) {
      held = image;
    },
    getImageData: (_x: number, _y: number, width: number, height: number): DeskewImage =>
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
  (globalThis as { document?: unknown }).document = { createElement: () => standInCanvas() };
  const scanic = (await import("scanic")) as unknown as { extractDocument: Extract };
  extractDocument = scanic.extractDocument;
});

after(() => {
  (globalThis as { document?: unknown }).document = realDocument;
});

/** A photo that is all page: paper, a red edge row along the top, blue along the left. */
function fullFramePhoto(width: number, height: number): DeskewImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const rgb = y === 0 ? [220, 20, 20] : x === 0 ? [20, 20, 220] : [228, 226, 220];
      data.set([...rgb, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

test("scanic clamps a rotated outline that leaves the photo, and the fill paints every pixel beyond it", async () => {
  const width = 300;
  const height = 400;
  const photo = fullFramePhoto(width, height);
  const quad: DeskewQuad = {
    topLeft: { x: 0, y: 0 },
    topRight: { x: width - 1, y: 0 },
    bottomRight: { x: width - 1, y: height - 1 },
    bottomLeft: { x: 0, y: height - 1 },
  };
  // scanic's own size rule: the longer of each pair of opposite sides.
  const dims = flatPageDims(quad);
  for (const deg of [5, -9]) {
    const geometry = deskewQuad({
      quad,
      outputWidth: dims.width,
      outputHeight: dims.height,
      canonicalWidth: width,
      canonicalHeight: height,
      deg,
      mode: "paper",
    });
    assert.equal(geometry.scale, 1, "paper mode never zooms");
    assert.ok(geometry.photoInOutput !== null, "Q′ leaves the photo, and the plan says so");
    const result = await extractDocument(photo, geometry.quad, { output: "imagedata" });
    assert.ok(result.success && result.output !== null, result.message);
    const out = result.output;
    assert.equal(out.width, dims.width);
    assert.equal(out.height, dims.height);
    // Beyond the photo, scanic repeats the photo's edge: the output's top-left
    // corner is the photo's (red or blue) edge row smeared, not black, not empty.
    const corner = [out.data[0], out.data[1], out.data[2], out.data[3]];
    assert.equal(corner[3], 255, "opaque");
    assert.ok(corner[0] > 200 || corner[2] > 200, `the edge row, clamped: ${corner}`);

    const plan: DeskewPlan = {
      policyVersion: DESKEW_POLICY_VERSION,
      deg,
      quad: geometry.quad,
      scale: 1,
      mode: "paper",
      pageInOutput: geometry.pageInOutput,
      cornerColors: [
        [228, 226, 220],
        [228, 226, 220],
        [228, 226, 220],
        [228, 226, 220],
      ],
      // Even with every wedge kept, what lies beyond the photo is painted.
      paint: [false, false, false, false],
      bleedFraction: 0.004,
      photoInOutput: geometry.photoInOutput,
      curl: curlEvidence({ deg, halves: [deg, deg] } as SkewEstimate, null),
    };
    const page = { width: out.width, height: out.height, data: new Uint8ClampedArray(out.data) };
    assert.ok(fillDeskewWedges(page, plan) > 0);
    // No smeared edge-row colour anywhere outside the photo.
    const w = out.width;
    const h = out.height;
    const toCanonical = homographyFrom(
      [
        { x: 0, y: 0 },
        { x: w - 1, y: 0 },
        { x: w - 1, y: h - 1 },
        { x: 0, y: h - 1 },
      ],
      [geometry.quad.topLeft, geometry.quad.topRight, geometry.quad.bottomRight, geometry.quad.bottomLeft],
    );
    let beyond = 0;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const p = applyHomography(toCanonical, { x, y });
        if (p.x > -2 && p.y > -2 && p.x < width + 1 && p.y < height + 1) continue;
        beyond += 1;
        const o = (y * w + x) * 4;
        const [r, g, b] = [page.data[o], page.data[o + 1], page.data[o + 2]];
        assert.ok(Math.abs(r - g) < 30 && Math.abs(b - g) < 30, `${deg}°: smear left at ${x},${y}: ${r},${g},${b}`);
      }
    }
    assert.ok(beyond > 100, `${deg}°: ${beyond} px beyond the photo checked`);
  }
});
