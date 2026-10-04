/**
 * The straighten suite's estimators, run on a finished page — the flat page
 * of the confirmed outline, or the page the user would see. Pure: pixels in,
 * numbers out; no engine, no ground truth. They are checked against scenes
 * whose truth is known in `straighten-measure.test.mjs`.
 *
 *  - `inkMask`: local-contrast ink on paper; dark background (table, wedges)
 *    and its neighbourhood are never ink.
 *  - `estimateTilt`: projection-profile sharpness over angles (coarse → fine),
 *    sub-pixel splatted bins; +deg = lines descend to the right.
 *  - `estimateCurvature`: text-line bow. Strip-wise vertical profiles in the
 *    de-tilted frame are cross-correlated between adjacent strips per band,
 *    the shifts chained into a baseline offset d(x) and a quadratic fitted:
 *    the |x²| coefficient (centre-vs-ends sagitta) over the page height.
 *  - `clippingCheck`: did the finished page lose print the flat page had —
 *    absolute ink, ink in each border band and the ink's bounding box, all
 *    against the ORIGINAL flat page.
 *  - `textureBlocks` / `paintCheck`: regions painted in (flat, texture-less
 *    fill where the photo had paper grain) and the seams where a fill's
 *    colour steps against the paper next to it.
 *
 * A NaN is an honest "could not measure" and the scoring treats it as
 * unverified — never as a pass.
 */

import { areaDownscale } from "./imaging.mjs";

export const MEASURE_LONG_EDGE = 1000;

/** Width of the border bands `clippingCheck` reads, as a fraction of the page's side. */
export const BORDER_BAND = 0.04;

function boxMean(g, w, h, r) {
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += g[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const s = I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0];
      out[y * w + x] = s / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

export function inkMask(img, inset = 0.015) {
  const im = areaDownscale(img, MEASURE_LONG_EDGE);
  const w = im.width, h = im.height;
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = 0.299 * im.data[i * 4] + 0.587 * im.data[i * 4 + 1] + 0.114 * im.data[i * 4 + 2];
  const L = Math.max(w, h);
  const local = boxMean(g, w, h, Math.round(L / 40));
  const wide = boxMean(g, w, h, Math.round(L / 12));
  // paper level: a high percentile of the whole page, so "mostly paper" is relative
  const sorted = Float32Array.from(g).sort();
  const paper = sorted[Math.floor(0.9 * sorted.length)];
  // large dark regions (table / background wedges), dilated: never ink.
  const dark = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) dark[i] = g[i] < 0.5 * paper ? 1 : 0;
  const rr = Math.max(2, Math.round(L / 60));
  const darkDensity = boxMean(dark, w, h, rr);
  const core = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) core[i] = darkDensity[i] > 0.6 ? 1 : 0;
  const nearCore = boxMean(core, w, h, rr);
  let pageArea = 0;
  for (let i = 0; i < w * h; i++) if (nearCore[i] === 0) pageArea++;
  const bw = Math.max(1, Math.round(0.02 * w)), bh = Math.max(1, Math.round(0.02 * h));
  let bandN = 0, bandDark = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x >= bw && x < w - bw && y >= bh && y < h - bh) continue;
    bandN++; if (dark[y * w + x]) bandDark++;
  }
  const mask = new Uint8Array(w * h);
  const ix = Math.round(inset * w), iy = Math.round(inset * h);
  const sw = Math.max(1, Math.round(BORDER_BAND * w)), sh = Math.max(1, Math.round(BORDER_BAND * h));
  const bandInk = [0, 0, 0, 0]; // top, right, bottom, left
  let count = 0, bx0 = w, by0 = h, bx1 = -1, by1 = -1;
  for (let y = iy; y < h - iy; y++) for (let x = ix; x < w - ix; x++) {
    const i = y * w + x;
    if (g[i] < 0.72 * local[i] && wide[i] > 0.62 * paper && local[i] > 0.5 * paper && nearCore[i] === 0) {
      mask[i] = 1; count++;
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
      if (y < sh) bandInk[0]++;
      if (x >= w - sw) bandInk[1]++;
      if (y >= h - sh) bandInk[2]++;
      if (x < sw) bandInk[3]++;
    }
  }
  const band = [bandInk[0] / (w * sh), bandInk[1] / (sw * h), bandInk[2] / (w * sh), bandInk[3] / (sw * h)];
  return {
    w, h, mask, count,
    bbox: count ? [bx0 / w, by0 / h, (bx1 + 1) / w, (by1 + 1) / h] : [0, 0, 0, 0],
    borderDarkFrac: bandDark / bandN, pageArea, band,
  };
}

function inkPoints(m, maxPts = 160_000) {
  const stride = Math.max(1, Math.ceil(m.count / maxPts));
  const pts = [];
  let k = 0;
  const cx = m.w / 2, cy = m.h / 2;
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
    if (!m.mask[y * m.w + x]) continue;
    if (k++ % stride) continue;
    pts.push(x - cx, y - cy);
  }
  return Float64Array.from(pts);
}

function profileScore(pts, deg, span) {
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  const off = span, bins = new Float64Array(2 * span + 2);
  for (let i = 0; i < pts.length; i += 2) {
    const r = pts[i + 1] * c - pts[i] * s + off;
    const b = Math.floor(r), f = r - b;
    if (b >= 0 && b + 1 < bins.length) { bins[b] += 1 - f; bins[b + 1] += f; }
  }
  let v = 0; for (let i = 0; i < bins.length; i++) v += bins[i] * bins[i];
  return v;
}

export function estimateTilt(m, range = 20) {
  const pts = inkPoints(m);
  const n = pts.length / 2;
  if (n < 200) return { deg: NaN, confidence: 0, n };
  const span = Math.ceil(Math.hypot(m.w, m.h) / 2) + 2;
  let best = -1, bestA = 0; const scores = [];
  for (let a = -range; a <= range + 1e-9; a += 0.25) {
    const v = profileScore(pts, a, span); scores.push(v);
    if (v > best) { best = v; bestA = a; }
  }
  let fineBest = best, fineA = bestA;
  for (let a = bestA - 0.3; a <= bestA + 0.3 + 1e-9; a += 0.02) {
    const v = profileScore(pts, a, span);
    if (v > fineBest) { fineBest = v; fineA = a; }
  }
  scores.sort((x, y) => x - y);
  return { deg: Math.round(fineA * 100) / 100, confidence: fineBest / scores[Math.floor(scores.length / 2)], n };
}

export function estimateCurvature(m, tiltDeg, K = 40, B = 6, S = 9) {
  const t = ((Number.isFinite(tiltDeg) ? tiltDeg : 0) * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  // rotated coordinates of each ink pixel
  const xs = [], ys = [];
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) if (m.mask[y * m.w + x]) {
    xs.push(x * c + y * s); ys.push(y * c - x * s);
  }
  if (xs.length < 500) return { bowFrac: NaN, bowFracMax: NaN, bands: 0 };
  const q = (arr, p) => { const a = [...arr].sort((u, v) => u - v); return a[Math.floor(p * (a.length - 1))]; };
  const x0 = q(xs, 0.01), x1 = q(xs, 0.99), y0 = q(ys, 0.01), y1 = q(ys, 0.99);
  const Hn = Math.ceil(y1 - y0) + 2 * S + 4;
  const prof = Array.from({ length: K }, () => new Float64Array(Hn));
  const stripOf = (x) => Math.min(K - 1, Math.max(0, Math.floor(((x - x0) / (x1 - x0)) * K)));
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] < x0 || xs[i] > x1) continue;
    const r = ys[i] - y0 + S + 2, b = Math.floor(r), f = r - b;
    if (b < 0 || b + 1 >= Hn) continue;
    const p = prof[stripOf(xs[i])]; p[b] += 1 - f; p[b + 1] += f;
  }
  // light smoothing
  for (const p of prof) { const cp = Float64Array.from(p); for (let i = 1; i < Hn - 1; i++) p[i] = 0.25 * cp[i - 1] + 0.5 * cp[i] + 0.25 * cp[i + 1]; }
  const bandH = (Hn - 2 * S - 4) / B;
  const bows = [];
  for (let band = 0; band < B; band++) {
    const lo = Math.floor(S + 2 + band * bandH), hi = Math.floor(S + 2 + (band + 1) * bandH);
    const mass = prof.map((p) => { let v = 0; for (let i = lo; i < hi; i++) v += p[i]; return v; });
    const valid = mass.map((v) => v >= 25);
    let prev = -1, cum = 0; const tx = [], dy = [], wt = [];
    for (let k = 0; k < K; k++) {
      if (!valid[k]) continue;
      if (prev >= 0 && k - prev <= 3) {
        // shift d maximizing Σ p_prev(y) p_k(y + d)
        const a = prof[prev], b = prof[k];
        let bestD = 0, bestV = -Infinity; const vals = [];
        for (let d = -S; d <= S; d++) {
          let v = 0; for (let y = lo; y < hi; y++) v += a[y] * b[y + d];
          vals.push(v); if (v > bestV) { bestV = v; bestD = d; }
        }
        let sub = 0; const iB = bestD + S;
        if (iB > 0 && iB < vals.length - 1) { const den = vals[iB - 1] - 2 * vals[iB] + vals[iB + 1]; if (den < 0) sub = 0.5 * (vals[iB - 1] - vals[iB + 1]) / den; }
        cum += bestD + sub;
      } else if (prev >= 0) {
        // gap too wide to chain safely: start a new segment (offset unknown) — drop band
        tx.length = 0; dy.length = 0; wt.length = 0; cum = 0;
      }
      tx.push(((k + 0.5) / K) * 2 - 1); dy.push(cum); wt.push(Math.sqrt(mass[k]));
      prev = k;
    }
    if (tx.length < 8 || tx[tx.length - 1] - tx[0] < 1.0) continue;
    // weighted LSQ: d = A t² + Bt + C
    const S_ = new Float64Array(9), r = new Float64Array(3);
    for (let i = 0; i < tx.length; i++) {
      const v = [tx[i] * tx[i], tx[i], 1];
      for (let a = 0; a < 3; a++) { r[a] += wt[i] * v[a] * dy[i]; for (let b = 0; b < 3; b++) S_[a * 3 + b] += wt[i] * v[a] * v[b]; }
    }
    const A = solve3(S_, r);
    if (A && Number.isFinite(A[0])) bows.push(Math.abs(A[0]) / m.h);
  }
  if (!bows.length) return { bowFrac: NaN, bowFracMax: NaN, bands: 0 };
  return { bowFrac: bows.reduce((a, b) => a + b, 0) / bows.length, bowFracMax: Math.max(...bows), bands: bows.length };
}

function solve3(M, r) {
  const m = [[M[0], M[1], M[2], r[0]], [M[3], M[4], M[5], r[1]], [M[6], M[7], M[8], r[2]]];
  for (let c = 0; c < 3; c++) {
    let p = c; for (let i = c + 1; i < 3; i++) if (Math.abs(m[i][c]) > Math.abs(m[p][c])) p = i;
    [m[c], m[p]] = [m[p], m[c]];
    if (Math.abs(m[c][c]) < 1e-12) return null;
    for (let i = 0; i < 3; i++) if (i !== c) { const f = m[i][c] / m[c][c]; for (let k = c; k < 4; k++) m[i][k] -= f * m[c][k]; }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

/**
 * What the suite records about one page. `ink` is the ink pixel count at the
 * measuring scale and `inkAbs` that count over the whole page area (so a page
 * whose visible sheet grew or shrank does not move it); `band` is the ink
 * density of the top, right, bottom and left border bands.
 */
export function measurePage(img) {
  const m = inkMask(img);
  const t = estimateTilt(m);
  const cv = estimateCurvature(m, t.deg);
  const r4 = (v) => Math.round(v * 1e4) / 1e4;
  return {
    tiltDeg: t.deg, tiltConfidence: Math.round(t.confidence * 100) / 100,
    bowFrac: cv.bowFrac, bowFracMax: cv.bowFracMax, curvBands: cv.bands,
    ink: m.count, inkFrac: m.count / Math.max(1, m.pageArea), inkAbs: m.count / (m.w * m.h),
    band: m.band.map(r4), bbox: m.bbox, borderDarkFrac: Math.round(m.borderDarkFrac * 1000) / 1000,
  };
}

/** Clipping thresholds: below this share of the flat page's ink, print was lost. */
export const CLIP = {
  /** Absolute ink of the finished page over the flat page's. */
  inkRatio: 0.92,
  /** Ink running into a border the flat page's print kept clear of, with this much ink lost. */
  pushedInkRatio: 0.985,
  /** A bbox side this close to the edge touches it (the mask's own inset is 0.015). */
  edge: 0.02,
  /** Band ink up by this much (density) on the side that newly touches. */
  bandRise: 0.004,
  /** Ink lost with the bbox shrinking alike (ink per bbox area at least this share of the flat page's): scaled, not cut. */
  shrunkInkPerBox: 0.97,
  /** …and the box's width and height ratios within this of each other. */
  shrunkAspectSlack: 0.03,
  /** Fewer ink pixels than this on the flat page: too little print to judge. */
  minInk: 1500,
};

const SIDES = ["top", "right", "bottom", "left"];

/**
 * Did the finished page lose print the ORIGINAL flat page had? Answers
 * `{ clipped, inkRatio, why? }`, or `{ clipped: null, why }` when the flat
 * page has too little print to judge (unverified, never a pass).
 *
 * Absolute ink, not density over the visible sheet: a kept wedge of table
 * shrinks the sheet and hid lost print, a sheet that grew diluted it into a
 * false loss. A side is "pushed" when the finished page's print now touches
 * a border the flat page's print kept clear of and its band holds more ink.
 * Print that lost ink but shrank with its bounding box alike on both axes,
 * touching no new edge, was scaled down rather than cut (`shrunk`, not
 * clipped).
 */
export function clippingCheck(flat, out) {
  if (!(flat.ink >= CLIP.minInk)) return { clipped: null, inkRatio: NaN, why: `flat page has ${flat.ink} ink px (< ${CLIP.minInk})` };
  const inkRatio = out.inkAbs / Math.max(1e-9, flat.inkAbs);
  const touches = (b) => [b[1] < CLIP.edge, b[2] > 1 - CLIP.edge, b[3] > 1 - CLIP.edge, b[0] < CLIP.edge];
  const tf = touches(flat.bbox), to = touches(out.bbox);
  if (inkRatio < CLIP.inkRatio) {
    // Print that shrank with its bounding box, alike on both axes and clear
    // of every edge, was scaled down, not cut: a geometric correction cannot
    // drop lines from the middle of a page without cutting through one at an
    // edge, and a cut shortens one side of the box, not both alike.
    const wRatio = (out.bbox[2] - out.bbox[0]) / Math.max(1e-9, flat.bbox[2] - flat.bbox[0]);
    const hRatio = (out.bbox[3] - out.bbox[1]) / Math.max(1e-9, flat.bbox[3] - flat.bbox[1]);
    const perBox = inkRatio / Math.max(1e-9, wRatio * hRatio);
    const uniform = Math.abs(wRatio - hRatio) <= CLIP.shrunkAspectSlack;
    if (uniform && perBox >= CLIP.shrunkInkPerBox && !to.some((t, i) => t && !tf[i])) {
      return { clipped: false, inkRatio, shrunk: true, why: `print shrank to ${(inkRatio * 100).toFixed(0)}% of the flat page's ink with its bounding box (scaled, not cut)` };
    }
    return { clipped: true, inkRatio, why: `ink ${(inkRatio * 100).toFixed(0)}% of flat` };
  }
  const flatBand = flat.band ?? [0, 0, 0, 0], outBand = out.band ?? [0, 0, 0, 0];
  const pushed = SIDES.filter((_, i) => to[i] && !tf[i] && outBand[i] > flatBand[i] + CLIP.bandRise);
  if (pushed.length > 0 && inkRatio < CLIP.pushedInkRatio) {
    return { clipped: true, inkRatio, why: `ink pushed into the ${pushed.join(" + ")} border (${(inkRatio * 100).toFixed(1)}% of flat)` };
  }
  return { clipped: false, inkRatio };
}

/* ── Painted regions and seams ───────────────────────────────────────── */

/** Painted-fill detection thresholds (full-resolution luminance). */
export const PAINT = {
  /** Blocks per long edge. */
  blocksPerEdge: 96,
  /** A block whose grain is under this share of the flat page's paper grain is painted. */
  roughRatio: 0.35,
  /** Flat-page paper grain under this: no texture to tell fill from paper — unmeasured. */
  minPaperRough: 0.35,
  /** Paper-coloured: block mean at least this share of the paper level (dark background is not fill). */
  paperMean: 0.6,
  /** A painted block's mean this far (grey levels) from paper within two blocks is on a seam. */
  seamDelta: 6,
  /** This many seam blocks make a visible seam. */
  seamMinBlocks: 3,
  /** A page with more than this share of painted blocks (over the flat page's) counts as painted. */
  paintedMinFrac: 0.002,
};

/**
 * Per-block mean luminance and grain (mean absolute second difference, both
 * axes — blind to smooth gradients, alive to sensor noise and print) at full
 * resolution; the paper level (90th percentile of block means) and the paper
 * grain (median grain of paper-coloured blocks).
 */
export function textureBlocks(img) {
  const { width: W, height: H, data } = img;
  const B = Math.max(6, Math.round(Math.max(W, H) / PAINT.blocksPerEdge));
  const bw = Math.floor(W / B), bh = Math.floor(H / B);
  const mean = new Float32Array(bw * bh), rough = new Float32Array(bw * bh);
  const lum = (x, y) => { const i = (y * W + x) * 4; return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; };
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    let sum = 0, n = 0, r = 0, rn = 0;
    const x0 = bx * B, y0 = by * B;
    for (let y = y0; y < y0 + B; y++) for (let x = x0; x < x0 + B; x++) {
      const v = lum(x, y);
      sum += v; n++;
      if (x > 0 && x < W - 1) { r += Math.abs(lum(x - 1, y) - 2 * v + lum(x + 1, y)); rn++; }
      if (y > 0 && y < H - 1) { r += Math.abs(lum(x, y - 1) - 2 * v + lum(x, y + 1)); rn++; }
    }
    mean[by * bw + bx] = sum / n;
    rough[by * bw + bx] = rn ? r / rn : 0;
  }
  const sortedMeans = Float32Array.from(mean).sort();
  const paperLevel = sortedMeans[Math.floor(0.9 * (sortedMeans.length - 1))];
  const paperRoughs = [];
  for (let i = 0; i < mean.length; i++) if (mean[i] >= 0.9 * paperLevel) paperRoughs.push(rough[i]);
  paperRoughs.sort((a, b) => a - b);
  const paperRough = paperRoughs.length ? paperRoughs[Math.floor(paperRoughs.length / 2)] : NaN;
  return { bw, bh, block: B, mean, rough, paperLevel, paperRough };
}

function paintedBlocks(t, ref) {
  const out = new Uint8Array(t.mean.length);
  let n = 0;
  for (let i = 0; i < out.length; i++) {
    if (t.mean[i] >= PAINT.paperMean * ref.paperLevel && t.rough[i] < PAINT.roughRatio * ref.paperRough) { out[i] = 1; n++; }
  }
  return { out, n };
}

/**
 * Painted blocks on a seam: a painted block against the paper-coloured blocks
 * within two blocks of it — the ring right at a fill's edge mixes fill and
 * paper (and the step itself reads as grain), so the paper is looked for
 * just beyond it. Answers `{ blocks, worst }` (the largest step, grey levels).
 */
function seamsOf(tex, painted, ref) {
  const { bw, bh, mean, rough } = tex;
  const paperLike = (i) => !painted[i] && mean[i] >= 0.9 * ref.paperLevel && rough[i] < 3 * ref.paperRough;
  let blocks = 0, worst = 0;
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const i = y * bw + x;
    if (!painted[i]) continue;
    let step = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx, ny = y + dy;
      if ((dx === 0 && dy === 0) || nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
      const j = ny * bw + nx;
      if (paperLike(j)) step = Math.max(step, Math.abs(mean[i] - mean[j]));
    }
    if (step > worst) worst = step;
    if (step > PAINT.seamDelta) blocks++;
  }
  return { blocks, worst };
}

/**
 * Painted fill in the finished page that the flat page did not have, and the
 * seams it leaves. Grain is judged against the FLAT page's paper grain, so a
 * photo's own noise sets the bar; both are net of what the flat page itself
 * shows. Answers `{ paintedFrac, seamBlocks, seam, maxSeamDelta }`, or
 * `{ paintedFrac: null, … }` when the flat page's paper has no grain to
 * compare with (a clean render) — unmeasured, not zero.
 */
export function paintCheck(flatTex, outTex) {
  if (!(flatTex.paperRough >= PAINT.minPaperRough)) {
    return { paintedFrac: null, seamBlocks: null, seam: null, maxSeamDelta: null, why: `flat paper grain ${flatTex.paperRough?.toFixed?.(2)} too low` };
  }
  const ref = { paperLevel: flatTex.paperLevel, paperRough: flatTex.paperRough };
  const flatPainted = paintedBlocks(flatTex, ref);
  const outPainted = paintedBlocks(outTex, ref);
  const paintedFrac = Math.max(0, outPainted.n / outPainted.out.length - flatPainted.n / flatPainted.out.length);
  const flatSeams = seamsOf(flatTex, flatPainted.out, ref);
  const outSeams = seamsOf(outTex, outPainted.out, ref);
  // Only what the finished page added: a photo (or a scene) may carry fill of its own.
  const seamBlocks = Math.max(0, outSeams.blocks - flatSeams.blocks);
  return {
    paintedFrac: Math.round(paintedFrac * 1e4) / 1e4,
    seamBlocks,
    seam: seamBlocks >= PAINT.seamMinBlocks,
    maxSeamDelta: Math.round(outSeams.worst * 10) / 10,
  };
}
