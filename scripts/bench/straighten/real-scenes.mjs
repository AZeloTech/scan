/**
 * The straighten suite's REAL scenes — local only. Pixels never leave this
 * machine: stills are read from `SCAN_REAL_MEDIA`, and anything drawn from
 * them goes to the real run's directory in the cache (`paths.mjs`).
 *
 * Source: every still in `SCAN_REAL_MEDIA` with a hand label (a page, not
 * "no document"), decoded upright (@napi-rs/canvas applies the EXIF
 * orientation, as the labelling page's browser does) and scaled like
 * `src/lib/image.ts` :: `decodeCanonical` (long edge ≤ 3000).
 *
 * Three ways to put a synthetic θ into a real photo:
 *  - `interior` — the user's case. Capture already straightened the outline
 *    (the quad is right) but the PRINT is skewed on the paper: only the page
 *    interior is rotated by θ about the page centre, in the page's own
 *    (homography) frame; the sheet's edge band stays put, and uncovered paper
 *    is filled with the local paper colour.
 *  - `rot-quad` — the whole photo rotated θ about the page centre, the quad
 *    rotated with it: an in-frame rotation the homography already undoes
 *    (nothing to do beyond the base photo).
 *  - `rot-origquad` — the whole photo rotated, the ORIGINAL quad kept: the
 *    outline no longer matches the sheet, so the content is tilted by θ
 *    relative to it and wedges of table enter it.
 * Plus `base`: the still itself, θ = 0.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { ROOT } from "../paths.mjs";
import { applyH, homography, mapQuad, newImage, outputDims, quadFromList, quadList, sampleBilinear } from "./imaging.mjs";

export const REAL_TILTS = { full: [1, 2, 4, 6, 8], quick: [2, 6] };
export const REAL_VARIANTS = ["interior", "rot-quad", "rot-origquad"];

/** lib/image.ts :: MAX_LONG_EDGE */
const MAX_LONG_EDGE = 3000;

/**
 * The real scenes of a profile over the labelled stills (`{ id, corners }`,
 * `id` the still's path inside `SCAN_REAL_MEDIA`): per still, its base and
 * each variant at each tilt — 16 a still in `full`, 7 in `quick`.
 */
export function realMatrix(stills, profile) {
  const tilts = REAL_TILTS[profile];
  if (tilts === undefined) throw new Error(`unknown straighten profile "${profile}" (full or quick)`);
  const out = [];
  for (const still of stills) {
    const name = path.basename(still.id).replace(/\.[^.]+$/, "");
    out.push({ id: `real/${name}/base/t0`, still: still.id, corners: still.corners, variant: "base", tiltDeg: 0 });
    for (const variant of REAL_VARIANTS) {
      for (const t of tilts) out.push({ id: `real/${name}/${variant}/t${t}`, still: still.id, corners: still.corners, variant, tiltDeg: t });
    }
  }
  return out;
}

/** @napi-rs/canvas, which this checkout has through pdfjs-dist; the real suite's only decoder. */
function canvasLib() {
  try {
    return createRequire(path.join(ROOT, "package.json"))("@napi-rs/canvas");
  } catch (error) {
    throw new Error(`the straighten-real suite decodes stills with @napi-rs/canvas (via pdfjs-dist), which did not load: ${error?.message ?? error}`);
  }
}

const decoded = new Map();

export async function decodeUpright(file) {
  const hit = decoded.get(file);
  if (hit) return hit;
  const { loadImage, createCanvas } = canvasLib();
  const im = await loadImage(readFileSync(file));
  const s = Math.min(1, MAX_LONG_EDGE / Math.max(im.width, im.height));
  const w = Math.round(im.width * s), h = Math.round(im.height * s);
  const cv = createCanvas(w, h);
  const ctx = cv.getContext("2d");
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  ctx.drawImage(im, 0, 0, w, h);
  const id = ctx.getImageData(0, 0, w, h);
  const img = { width: w, height: h, data: new Uint8ClampedArray(id.data) };
  decoded.set(file, img);
  return img;
}

function centroid(q) {
  const p = quadList(q);
  return { x: p.reduce((a, b) => a + b.x, 0) / 4, y: p.reduce((a, b) => a + b.y, 0) / 4 };
}

const rot = (p, c, deg) => {
  const t = (deg * Math.PI) / 180, cs = Math.cos(t), sn = Math.sin(t), dx = p.x - c.x, dy = p.y - c.y;
  return { x: c.x + dx * cs - dy * sn, y: c.y + dx * sn + dy * cs };
};

/** Whole photo rotated +θ (clockwise on screen) about c. */
function rotateImage(src, c, deg) {
  const out = newImage(src.width, src.height), rgb = new Float64Array(3);
  const t = (-deg * Math.PI) / 180, cs = Math.cos(t), sn = Math.sin(t);
  for (let y = 0; y < src.height; y++) for (let x = 0; x < src.width; x++) {
    const dx = x - c.x, dy = y - c.y;
    sampleBilinear(src, c.x + dx * cs - dy * sn, c.y + dx * sn + dy * cs, rgb);
    const o = (y * src.width + x) * 4;
    out.data[o] = rgb[0]; out.data[o + 1] = rgb[1]; out.data[o + 2] = rgb[2]; out.data[o + 3] = 255;
  }
  return out;
}

/** Only the page interior's print rotated by θ, in the page's homography frame. */
function rotateInterior(src, q, deg, keepBand = 0.03) {
  const d = outputDims(q), W = d.width, H = d.height;
  const rect = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
  const toPage = homography(quadList(q), rect), toImg = homography(rect, quadList(q));
  const bx = keepBand * W, by = keepBand * H;
  const inner = (u, v) => u >= bx && u <= W - bx && v >= by && v <= H - by;
  // local paper colour: 8x8 cells, the 80th-percentile-luminance pixel of each
  const G = 8, cells = [], rgb = new Float64Array(3);
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
    const samples = [];
    for (let s = 0; s < 400; s++) {
      const a = s % 20, b = Math.floor(s / 20);
      const u = bx + ((i + (a + 0.5) / 20) / G) * (W - 2 * bx), v = by + ((j + (b + 0.5) / 20) / G) * (H - 2 * by);
      const p = applyH(toImg, u, v); sampleBilinear(src, p.x, p.y, rgb); samples.push([rgb[0], rgb[1], rgb[2]]);
    }
    samples.sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]));
    cells.push(samples[Math.floor(0.8 * samples.length)]);
  }
  const paperAt = (u, v, out) => {
    const gx = Math.min(G - 1.001, Math.max(0, ((u - bx) / (W - 2 * bx)) * G - 0.5)), gy = Math.min(G - 1.001, Math.max(0, ((v - by) / (H - 2 * by)) * G - 0.5));
    const i0 = Math.floor(gx), j0 = Math.floor(gy), fx = gx - i0, fy = gy - j0;
    for (let ch = 0; ch < 3; ch++)
      out[ch] = cells[j0 * G + i0][ch] * (1 - fx) * (1 - fy) + cells[j0 * G + i0 + 1][ch] * fx * (1 - fy)
        + cells[(j0 + 1) * G + i0][ch] * (1 - fx) * fy + cells[(j0 + 1) * G + i0 + 1][ch] * fx * fy;
  };
  const out = newImage(src.width, src.height); out.data.set(src.data);
  const xs = quadList(q).map((p) => p.x), ys = quadList(q).map((p) => p.y);
  const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(src.width - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(src.height - 1, Math.ceil(Math.max(...ys)));
  const t = (-deg * Math.PI) / 180, cs = Math.cos(t), sn = Math.sin(t), cu = W / 2, cv = H / 2;
  const pc = [0, 0, 0];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const p = applyH(toPage, x, y);
    if (!inner(p.x, p.y)) continue;
    const du = p.x - cu, dv = p.y - cv;
    const su = cu + du * cs - dv * sn, sv = cv + du * sn + dv * cs;
    const o = (y * src.width + x) * 4;
    if (inner(su, sv)) {
      const s = applyH(toImg, su, sv); sampleBilinear(src, s.x, s.y, rgb);
      out.data[o] = rgb[0]; out.data[o + 1] = rgb[1]; out.data[o + 2] = rgb[2];
    } else {
      paperAt(p.x, p.y, pc);
      out.data[o] = pc[0]; out.data[o + 1] = pc[1]; out.data[o + 2] = pc[2];
    }
  }
  return out;
}

/**
 * One real scene: the still decoded upright, its labelled outline, and the
 * synthetic θ put in as the spec's variant says. `file` is the still's path.
 */
export async function buildRealScene(spec, file) {
  const img = await decodeUpright(file);
  const q0 = quadFromList(spec.corners.map(([x, y]) => ({ x: x * img.width, y: y * img.height })));
  const c = centroid(q0);
  let canonical = img, quad = q0;
  if (spec.tiltDeg !== 0) {
    if (spec.variant === "interior") canonical = rotateInterior(img, q0, spec.tiltDeg);
    else {
      canonical = rotateImage(img, c, spec.tiltDeg);
      if (spec.variant === "rot-quad") quad = mapQuad(q0, (p) => rot(p, c, spec.tiltDeg));
    }
  }
  const tiltRelQuad = spec.variant === "rot-quad" ? 0 : spec.tiltDeg;
  return {
    spec, canonical, quad,
    truth: {
      shouldAct: Math.abs(tiltRelQuad) >= 0.5,
      tiltDeg: tiltRelQuad, addedTiltDeg: spec.tiltDeg, curl: "unknown",
      flatAndStraight: false,
    },
  };
}
