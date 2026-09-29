import assert from "node:assert/strict";
import test from "node:test";

import { registerStill, reduceThumb, scoreAt, type LumaThumb } from "./still-register.ts";
import { mapPreviewQuadToStill } from "./still-check.ts";

/**
 * A synthetic scene in "angle" coordinates (long-edge units from the optical
 * centre): a desk texture, a page with printed lines and an inner border.
 */
function scene(ax: number, ay: number): number {
  const desk = 0.35 + 0.08 * Math.sin(ax * 23 + 1) * Math.cos(ay * 17) + 0.05 * Math.sin((ax + ay) * 41);
  const onPage = Math.abs(ax) < 0.28 && Math.abs(ay) < 0.4;
  if (!onPage) return desk;
  const border = Math.abs(Math.abs(ax) - 0.25) < 0.006 || Math.abs(Math.abs(ay) - 0.37) < 0.006;
  const line = Math.abs(ay) < 0.33 && Math.abs(ax) < 0.2 && Math.sin(ay * 90) > 0.6;
  return border || line ? 0.15 : 0.92;
}

/** Render a picture of `scene` at a field of view (1 = the preview's) and a drift, `w`×`h` thumbnail of a `sw`×`sh` source. */
function render(w: number, h: number, sw: number, sh: number, fov = 1, driftX = 0, driftY = 0): LumaThumb {
  const data = new Float32Array(w * h);
  const long = Math.max(sw, sh);
  // Supersample 3×3 so the thumbnail is area-averaged, as a real reduction is.
  for (let j = 0; j < h; j += 1) {
    for (let i = 0; i < w; i += 1) {
      let sum = 0;
      for (let v = 0; v < 3; v += 1) {
        for (let u = 0; u < 3; u += 1) {
          const fx = (i + (u + 0.5) / 3) / w;
          const fy = (j + (v + 0.5) / 3) / h;
          const ax = ((fx - 0.5 - driftX) * sw) / long * fov;
          const ay = ((fy - 0.5 - driftY) * sh) / long * fov;
          sum += scene(ax, ay);
        }
      }
      data[j * w + i] = sum / 9;
    }
  }
  return { width: w, height: h, data, sourceWidth: sw, sourceHeight: sh };
}

test("registration recovers a photo that sees less, the same, and more than the preview", () => {
  const preview = render(54, 96, 720, 1280);
  for (const fov of [0.8, 1, 1.15]) {
    const still = render(54, 96, 2250, 4000, fov);
    const r = registerStill(preview, still);
    assert.ok(r !== null);
    assert.ok(Math.abs(r.fovScale - fov) / fov < 0.03, `fov ${fov}: got ${r.fovScale}`);
    assert.ok(r.score > 0.9, `fov ${fov}: score ${r.score}`);
  }
});

test("registration recovers a hand's drift and a 4:3 photo under a 9:16 preview", () => {
  const preview = render(54, 96, 720, 1280);
  const still = render(72, 96, 3000, 4000, 0.9, 0.04, -0.03);
  const r = registerStill(preview, still);
  assert.ok(r !== null);
  assert.ok(Math.abs(r.fovScale - 0.9) < 0.03, `fov ${r.fovScale}`);
  assert.ok(Math.abs(r.shiftX - 0.04) < 0.015 && Math.abs(r.shiftY + 0.03) < 0.015, `shift ${r.shiftX}, ${r.shiftY}`);
  // Laid through the registration, the preview's page corner lands where the still has it.
  const page = { topLeft: { x: 0.2, y: 0.2 }, topRight: { x: 0.8, y: 0.2 }, bottomRight: { x: 0.8, y: 0.8 }, bottomLeft: { x: 0.2, y: 0.8 } };
  const truth = mapPreviewQuadToStill(page, { preview: { width: 720, height: 1280 }, still: { width: 3000, height: 4000 }, fovScale: 0.9 });
  const got = mapPreviewQuadToStill(page, { preview: { width: 720, height: 1280 }, still: { width: 3000, height: 4000 }, fovScale: r.fovScale });
  assert.ok(Math.abs(got.topLeft.x + r.shiftX - (truth.topLeft.x + 0.04)) < 0.02);
});

test("a blank picture registers nothing; another scene registers badly", () => {
  const preview = render(54, 96, 720, 1280);
  const blank: LumaThumb = { width: 54, height: 96, data: new Float32Array(54 * 96).fill(0.5), sourceWidth: 720, sourceHeight: 1280 };
  assert.equal(registerStill(preview, blank), null);
  const other: LumaThumb = { ...preview, data: preview.data.map((_, k) => 0.5 + 0.4 * Math.sin(k * 0.37) * Math.cos(k * 0.011)) };
  const r = registerStill(preview, other);
  assert.ok(r === null || r.score < 0.8, `score ${r?.score}`);
});

test("scoreAt: the identity scores 1; the reduction keeps the source's shape", () => {
  const preview = render(54, 96, 720, 1280);
  const s = scoreAt(preview, preview, 1, 0, 0);
  assert.ok(s.score > 0.999 && s.overlap === 1);
  const small = reduceThumb(preview, 3);
  assert.equal(small.width, 18);
  assert.equal(small.height, 32);
  assert.equal(small.sourceWidth, 720);
});

test("a square photo that came back turned a quarter does not register as the viewfinder's picture", () => {
  // Review finding 6. A turned photo of any non-square preview is discarded
  // before it is checked (`quadTransfers`, still-capture.test.ts); a square
  // one is the shape that could slip through, and it registers badly — so an
  // automatic capture with it is flagged "unverified", never accepted.
  const preview = render(96, 96, 1080, 1080);
  const upright = render(96, 96, 1080, 1080);
  const turned: LumaThumb = { ...upright, data: new Float32Array(96 * 96) };
  for (let y = 0; y < 96; y += 1) for (let x = 0; x < 96; x += 1) turned.data[y * 96 + x] = upright.data[(95 - x) * 96 + y];
  const straight = registerStill(preview, upright);
  assert.ok(straight !== null && straight.score > 0.95);
  const r = registerStill(preview, turned);
  assert.ok(r === null || r.score < 0.8, `score ${r?.score}`);
});
