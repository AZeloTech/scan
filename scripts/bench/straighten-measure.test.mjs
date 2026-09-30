/**
 * The straighten suite's estimators recover known truth, and the repaired
 * checks — clipping against the original flat page, painted fill and seams —
 * say what they claim, both ways. Engine-free.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newImage, outputDims, warpQuad } from "./straighten/imaging.mjs";
import { clippingCheck, measurePage, paintCheck, textureBlocks } from "./straighten/measure.mjs";
import { buildScene, sceneProfile } from "./straighten/scenes.mjs";

const spec = (id) => {
  const found = sceneProfile("full").find((s) => s.id === id);
  assert.ok(found, id);
  return found;
};

const flatOf = (scene) => {
  const d = outputDims(scene.quad);
  return warpQuad(scene.canonical, scene.quad, d.width, d.height);
};

/** A copy of `img` with `paint(x, y) → grey | null` applied. */
function painted(img, paint) {
  const out = { width: img.width, height: img.height, data: Uint8ClampedArray.from(img.data) };
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const v = paint(x, y);
    if (v === null) continue;
    const o = (y * img.width + x) * 4;
    out.data[o] = out.data[o + 1] = out.data[o + 2] = v;
  }
  return out;
}

test("tilt: the estimator recovers the print's tilt, sign and size, on every layout", () => {
  for (const layout of ["paragraphs", "block", "form", "twocol"]) {
    for (const t of [-4, 0, 1, 6]) {
      const sc = buildScene({ ...spec(`tilt/${layout}/correct/t0/p0/none`), id: `probe/${layout}/${t}`, tiltDeg: t });
      const m = measurePage(sc.paper);
      assert.ok(Math.abs(m.tiltDeg - t) <= 0.15, `${layout} ${t}°: measured ${m.tiltDeg}°`);
    }
  }
});

test("bow: the curvature estimator grows with the curl", () => {
  const bows = ["small", "medium", "large"].map((curl) => measurePage(flatOf(buildScene(spec(`curl/paragraphs/correct/t0/p0/${curl}`)))).bowFrac);
  const none = measurePage(flatOf(buildScene(spec("tilt/paragraphs/correct/t0/p0/none")))).bowFrac;
  const all = [none, ...bows];
  for (let i = 1; i < all.length; i++) assert.ok(all[i] > all[i - 1], `bows ${all.join(", ")}`);
});

test("clipping: a page that lost a band of print is clipped; the same page is not", () => {
  const flatImg = flatOf(buildScene(spec("tilt/paragraphs/correct/t0/p0/none")));
  const flat = measurePage(flatImg);
  assert.deepEqual({ ...clippingCheck(flat, flat), inkRatio: 1 }, { clipped: false, inkRatio: 1 });
  // The bottom 30 % whited out: a quarter of the lines gone.
  const cut = measurePage(painted(flatImg, (x, y) => (y > 0.7 * flatImg.height ? 240 : null)));
  const c = clippingCheck(flat, cut);
  assert.equal(c.clipped, true, JSON.stringify(c));
});

test("clipping: a kept wedge of table does not hide lost print (absolute ink, not density)", () => {
  const flatImg = flatOf(buildScene(spec("tilt/paragraphs/correct/t0/p0/none")));
  const flat = measurePage(flatImg);
  const w = flatImg.width;
  // The right 15 % of the page replaced by dark table: print there is lost,
  // but the visible sheet shrank with it, so ink density over the sheet —
  // the old check, clipped below 93 % — does not drop at all.
  const wedged = measurePage(painted(flatImg, (x) => (x > 0.85 * w ? 70 : null)));
  assert.ok(wedged.inkFrac / flat.inkFrac > 0.93, `density ${wedged.inkFrac} vs ${flat.inkFrac}`);
  assert.equal(clippingCheck(flat, wedged).clipped, true);
});

test("clipping: print pushed into a border the flat page kept clear of is clipped", () => {
  const flatImg = flatOf(buildScene(spec("tilt/block/correct/t0/p0/none")));
  const flat = measurePage(flatImg);
  // Shift the page up by 9 % — the top lines run off, the rest crowds the top edge.
  const dy = Math.round(0.09 * flatImg.height);
  const shifted = newImage(flatImg.width, flatImg.height);
  shifted.data.fill(240);
  shifted.data.set(flatImg.data.subarray(dy * flatImg.width * 4));
  for (let i = 3; i < shifted.data.length; i += 4) shifted.data[i] = 255;
  const c = clippingCheck(flat, measurePage(shifted));
  assert.equal(c.clipped, true, JSON.stringify(c));
});

test("clipping: a page with too little print is unmeasured, never a pass", () => {
  const blank = newImage(600, 800);
  blank.data.fill(240);
  const m = measurePage(blank);
  const c = clippingCheck(m, m);
  assert.equal(c.clipped, null);
  assert.ok(c.why);
});

test("paint: flat fill where the photo had grain is found, and a fill that steps against the paper is a seam", () => {
  const flatImg = flatOf(buildScene(spec("tilt/paragraphs/correct/t0/p0/none")));
  const flatTex = textureBlocks(flatImg);
  assert.ok(flatTex.paperRough >= 0.35, `paper grain ${flatTex.paperRough}`);
  const same = paintCheck(flatTex, textureBlocks(flatImg));
  assert.equal(same.paintedFrac, 0);
  assert.equal(same.seam, false);
  // A corner triangle filled with the paper's own level: painted, no seam.
  const level = Math.round(flatTex.paperLevel);
  const corner = (x, y) => (x + y < 0.12 * (flatImg.width + flatImg.height) ? level : null);
  const matched = paintCheck(flatTex, textureBlocks(painted(flatImg, corner)));
  assert.ok(matched.paintedFrac > 0.01, JSON.stringify(matched));
  assert.equal(matched.seam, false, JSON.stringify(matched));
  // The same triangle 25 grey levels darker than the paper: a visible seam.
  const darker = paintCheck(flatTex, textureBlocks(painted(flatImg, (x, y) => (corner(x, y) === null ? null : level - 25))));
  assert.equal(darker.seam, true, JSON.stringify(darker));
});

test("paint: a flat page with no grain to compare against is unmeasured", () => {
  const clean = newImage(400, 500);
  clean.data.fill(240);
  const tex = textureBlocks(clean);
  assert.equal(paintCheck(tex, tex).paintedFrac, null);
});
