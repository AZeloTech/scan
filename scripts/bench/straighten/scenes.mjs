/**
 * The straighten suite's synthetic scenes: deterministic, ground truth known.
 *
 * A scene is a *photo* (the canonical) plus the *confirmed quad*, built from
 * a physically motivated chain so the truth is exact:
 *
 *   text layout (text frame)
 *     --rotate θ about the page centre-->  paper (print skewed on the sheet)
 *     --cylinder curl z(X), pinhole camera-->  flat photo coordinates
 *     --rotate φ about the page centre, placed on a table-->  canonical
 *
 * Conventions (y down): +θ / +φ are clockwise on screen, i.e. a text line
 * with +θ descends to the right. The tilt estimator (`measure.mjs`) uses the
 * same sign, and `straighten-measure.test.mjs` checks it.
 *
 * Pure: no I/O, no engine. The same spec always renders the same pixels.
 */

import { cropImage, hashString, mapQuad, mulberry32, newImage, quadFromList } from "./imaging.mjs";

/** Peak paper lift as a fraction of camera distance. Edge bow ≈ (H/2)·z/D. */
export const CURL_Z_OVER_D = { none: 0, small: 0.02, medium: 0.05, large: 0.09 };
export const LAYOUTS = ["paragraphs", "block", "form", "twocol"];
export const QUAD_MODES = ["correct", "fullframe", "jitter"];

export const PAGE_W = 900;
export const PAGE_H = 1273;
const PAPER = 240;
const INK = 30;
const TABLE = 70;

/**
 * Photo realism: `noise` adds sensor noise and uneven light; `blurSigma` is
 * the camera's PSF (px, gaussian) — without it strokes are perfectly hard and
 * any point-sampled render aliases them more than a real photo would. A run
 * records both (`config.scene`), and runs with different values never compare.
 */
export const SCENE_OPTIONS = Object.freeze({ noise: true, blurSigma: 0.8 });

function gaussianBlur(img, sigma) {
  if (!(sigma > 0)) return img;
  const r = Math.ceil(3 * sigma), k = [];
  let sum = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(v); sum += v; }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const { width: W, height: H } = img;
  const tmp = new Float32Array(W * H), src = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) src[i] = img.data[i * 4];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = 0; for (let i = -r; i <= r; i++) v += k[i + r] * src[y * W + Math.min(W - 1, Math.max(0, x + i))];
    tmp[y * W + x] = v;
  }
  const out = newImage(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = 0; for (let i = -r; i <= r; i++) v += k[i + r] * tmp[Math.min(H - 1, Math.max(0, y + i)) * W + x];
    const o = (y * W + x) * 4; out.data[o] = out.data[o + 1] = out.data[o + 2] = v + 0.5; out.data[o + 3] = 255;
  }
  return out;
}

/* ── Layouts: binary ink bitmaps in the text frame ─────────────────── */

function glyph(bm, W, H, x, y0, gw, asc, desc) {
  for (let dy = -asc; dy < 13 + desc; dy++) for (let dx = 0; dx < gw; dx++) {
    if (dx > 1 && dx < gw - 2 && dy > 2 && dy < 10) continue; // hollow body, like a letter's counter
    const px = Math.round(x + dx), py = Math.round(y0 + dy);
    if (px >= 0 && py >= 0 && px < W && py < H) bm[py * W + px] = 1;
  }
}

/** Words of hollow glyphs from x0 to lineEnd on one baseline row. */
function textRun(bm, W, H, x0, lineEnd, y0, rnd, maxWords = Infinity) {
  let x = x0, words = 0;
  while (x < lineEnd && words < maxWords) {
    const wl = 2 + Math.floor(rnd() * 7);
    for (let g = 0; g < wl && x < lineEnd; g++) {
      const gw = 7 + Math.floor(rnd() * 4);
      glyph(bm, W, H, x, y0, gw, rnd() < 0.3 ? 6 : 0, rnd() < 0.15 ? 5 : 0);
      x += gw + 4;
    }
    x += 14; words++;
  }
  return x;
}

function hline(bm, W, H, x0, x1, y, t = 2) {
  for (let yy = Math.round(y); yy < Math.round(y) + t; yy++) for (let x = Math.round(x0); x <= Math.round(x1); x++)
    if (x >= 0 && yy >= 0 && x < W && yy < H) bm[yy * W + x] = 1;
}
function vline(bm, W, H, x, y0, y1, t = 2) {
  for (let y = Math.round(y0); y <= Math.round(y1); y++) for (let xx = Math.round(x); xx < Math.round(x) + t; xx++)
    if (xx >= 0 && y >= 0 && xx < W && y < H) bm[y * W + xx] = 1;
}

/** Paragraphs of hollow glyphs; `gaps` drops a line now and then, like paragraph breaks. */
function paragraphs(W, H, rnd, gaps) {
  const bm = new Uint8Array(W * H);
  const L = 0.1 * W, R = 0.9 * W, pitch = 30;
  for (let y0 = 0.08 * H; y0 < 0.92 * H - 20; y0 += pitch) {
    if (gaps && rnd() < 0.08) continue;
    const lineEnd = rnd() < 0.2 ? L + (R - L) * (0.3 + 0.5 * rnd()) : R;
    textRun(bm, W, H, L, lineEnd, y0, rnd);
  }
  return bm;
}

function twoColumns(W, H, rnd) {
  const bm = new Uint8Array(W * H);
  const pitch = 28;
  textRun(bm, W, H, 0.1 * W, 0.7 * W, 0.07 * H, rnd); // heading
  for (const [L, R] of [[0.08 * W, 0.47 * W], [0.53 * W, 0.92 * W]]) {
    for (let y0 = 0.12 * H; y0 < 0.92 * H - 20; y0 += pitch) {
      if (rnd() < 0.07) continue;
      const lineEnd = rnd() < 0.15 ? L + (R - L) * (0.3 + 0.5 * rnd()) : R;
      textRun(bm, W, H, L, lineEnd, y0, rnd);
    }
  }
  return bm;
}

/** Sparse form: labelled fields over rules, a ruled table, a signature line. */
function form(W, H, rnd) {
  const bm = new Uint8Array(W * H);
  textRun(bm, W, H, 0.1 * W, 0.6 * W, 0.07 * H, rnd); // title
  let y = 0.14 * H;
  for (let i = 0; i < 7; i++) {
    const end = textRun(bm, W, H, 0.1 * W, 0.34 * W, y, rnd, 1 + Math.floor(rnd() * 2));
    hline(bm, W, H, Math.max(end, 0.36 * W), 0.9 * W, y + 15);
    if (rnd() < 0.5) textRun(bm, W, H, 0.4 * W, 0.4 * W + 80 + rnd() * 200, y, rnd); // filled-in value
    y += 58;
  }
  // table
  const top = y + 20, rows = 7, rowH = 44, cols = [0.1, 0.34, 0.56, 0.74, 0.9].map((f) => f * W);
  for (let r = 0; r <= rows; r++) hline(bm, W, H, cols[0], cols[cols.length - 1], top + r * rowH);
  for (const c of cols) vline(bm, W, H, c, top, top + rows * rowH);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols.length - 1; c++) {
    if (r > 0 && rnd() < 0.3) continue;
    textRun(bm, W, H, cols[c] + 10, cols[c + 1] - 12, top + r * rowH + 15, rnd, 1);
  }
  y = top + rows * rowH + 50;
  for (let i = 0; i < 3 && y < 0.88 * H; i++, y += 30) textRun(bm, W, H, 0.1 * W, 0.9 * W, y, rnd);
  hline(bm, W, H, 0.55 * W, 0.88 * W, 0.9 * H);
  textRun(bm, W, H, 0.6 * W, 0.8 * W, 0.9 * H + 10, rnd, 1);
  return bm;
}

export function layoutBitmap(layout, W, H, seed) {
  const rnd = mulberry32(seed);
  switch (layout) {
    case "paragraphs": return paragraphs(W, H, rnd, true);
    case "block": return paragraphs(W, H, rnd, false);
    case "twocol": return twoColumns(W, H, rnd);
    case "form": return form(W, H, rnd);
  }
}

/* ── Paper: the sheet with its (possibly skewed) print ───────────────── */

function bilinearMask(bm, W, H, x, y) {
  if (x < 0 || y < 0 || x > W - 1 || y > H - 1) return 0;
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  return bm[y0 * W + x0] * (1 - fx) * (1 - fy) + bm[y0 * W + x1] * fx * (1 - fy) + bm[y1 * W + x0] * (1 - fx) * fy + bm[y1 * W + x1] * fx * fy;
}

/** Gray paper image (Float32, 0..255) with the text frame rotated by θ. */
export function renderPaper(layout, tiltDeg, seed, W = PAGE_W, H = PAGE_H) {
  const bm = layoutBitmap(layout, W, H, seed);
  const t = (tiltDeg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  const cx = W / 2, cy = H / 2;
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    // paper p = centre + R(θ)(q - centre)=> q = centre + R(-θ)(p - centre)
    const dx = x - cx, dy = y - cy;
    const qx = cx + dx * c + dy * s, qy = cy - dx * s + dy * c;
    const ink = bilinearMask(bm, W, H, qx, qy);
    out[y * W + x] = PAPER - (PAPER - INK) * ink;
  }
  return out;
}

function grayToRgba(g, W, H) {
  const img = newImage(W, H);
  for (let i = 0; i < W * H; i++) { img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = g[i]; img.data[i * 4 + 3] = 255; }
  return img;
}

/* ── Curl + camera ───────────────────────────────────────────────────── */

/**
 * Cylinder curl about a vertical axis: lift z(X) = A·g(X/L), g(t)=6.75·t(1-t)²
 * (0 at both edges, peak at t=1/3 — a page rising off the spine), paper keeps
 * its arc length (so it foreshortens), seen by a pinhole camera at distance D
 * over the page centre: flat photo point = c + (P - c)·D/(D - z).
 * Every photo column is one paper column, so the inverse is a 1-D table.
 */

function makeCurl(zOverD, W, H) {
  const D = 1.6 * H, A = zOverD * D, cx = W / 2, cy = H / 2;
  if (A === 0) {
    return {
      paperX: (xf) => (xf < 0 || xf > W ? NaN : xf), scaleAt: () => 1,
      forward: (x, y) => ({ x, y }), edgeBowFrac: 0,
    };
  }
  const N = 4096;
  const g = (t) => 6.75 * t * (1 - t) * (1 - t);
  let L = W;
  let Xs = new Float64Array(N + 1), arc = new Float64Array(N + 1);
  for (let it = 0; it < 8; it++) {
    arc[0] = 0;
    for (let i = 1; i <= N; i++) {
      const X0 = ((i - 1) / N) * L, X1 = (i / N) * L;
      const dz = A * (g(X1 / L) - g(X0 / L));
      arc[i] = arc[i - 1] + Math.hypot(X1 - X0, dz);
      Xs[i] = X1;
    }
    L *= W / arc[N];
  }
  // table over paper x: X(xp), s(xp), xf(xp)
  const M = 4096, sTab = new Float64Array(M + 1), xfTab = new Float64Array(M + 1);
  let j = 0;
  for (let k = 0; k <= M; k++) {
    const xp = (k / M) * W;
    while (j < N && arc[j + 1] < xp) j++;
    const f = arc[j + 1] > arc[j] ? (xp - arc[j]) / (arc[j + 1] - arc[j]) : 0;
    const X = Xs[j] + f * (Xs[Math.min(N, j + 1)] - Xs[j]);
    const z = A * g(Math.min(1, Math.max(0, X / L)));
    const s = D / (D - z);
    sTab[k] = s; xfTab[k] = cx + (X - cx) * s;
  }
  const lerpTab = (tab, xp) => {
    const u = Math.min(M, Math.max(0, (xp / W) * M)), k = Math.min(M - 1, Math.floor(u)), f = u - k;
    return tab[k] + f * (tab[k + 1] - tab[k]);
  };
  const paperX = (xf) => {
    if (xf < xfTab[0] || xf > xfTab[M]) return NaN;
    let lo = 0, hi = M;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xfTab[mid] <= xf) lo = mid; else hi = mid; }
    const f = (xf - xfTab[lo]) / (xfTab[hi] - xfTab[lo] || 1);
    return ((lo + f) / M) * W;
  };
  let sMax = 1; for (const s of sTab) sMax = Math.max(sMax, s);
  return {
    paperX,
    scaleAt: (xp) => lerpTab(sTab, xp),
    forward: (xp, yp) => { const s = lerpTab(sTab, xp); return { x: lerpTab(xfTab, xp), y: cy + (yp - cy) * s }; },
    edgeBowFrac: ((H / 2) * (sMax - 1)) / H,
  };
}

/* ── Scene assembly ──────────────────────────────────────────────────── */

export function buildScene(spec, sceneOptions = SCENE_OPTIONS) {
  const seedBase = hashString(spec.layout); // same text for a layout across the matrix
  const W = PAGE_W, H = PAGE_H;
  const paperGray = renderPaper(spec.layout, spec.tiltDeg, seedBase);
  const curl = makeCurl(CURL_Z_OVER_D[spec.curl], W, H);
  const rnd = mulberry32(hashString(spec.id));

  // canonical frame: the analysis harness's 1200x1600 with the page at (150,150)
  // when upright; 1500x1800 with the page centred when rotated in frame.
  const rotated = spec.phiDeg !== 0;
  const CW = rotated ? 1500 : 1200, CH = rotated ? 1800 : 1600;
  const pc = rotated ? { x: CW / 2, y: CH / 2 } : { x: 150 + W / 2, y: 150 + H / 2 };
  const f = (spec.phiDeg * Math.PI) / 180, cf = Math.cos(f), sf = Math.sin(f);
  const toCanon = (p)=> {
    const dx = p.x - W / 2, dy = p.y - H / 2;
    return { x: pc.x + dx * cf - dy * sf, y: pc.y + dx * sf + dy * cf };
  };

  const img = newImage(CW, CH);
  // low-frequency illumination: a gentle diagonal gradient + vignette
  const nz = sceneOptions.noise ? 1 : 0;
  const gx = (rnd() - 0.5) * 0.06 * nz, gy = (rnd() - 0.5) * 0.06 * nz;
  let noiseState = hashString(spec.id + "#noise");
  const noise = () => { // cheap LCG gaussian-ish (sum of 3 uniforms)
    noiseState = (Math.imul(noiseState, 1664525) + 1013904223) >>> 0; const a = noiseState / 4294967296;
    noiseState = (Math.imul(noiseState, 1664525) + 1013904223) >>> 0; const b = noiseState / 4294967296;
    noiseState = (Math.imul(noiseState, 1664525) + 1013904223) >>> 0; const c = noiseState / 4294967296;
    return (a + b + c - 1.5) * 2; // sd ≈ 1
  };
  for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
    const dx = x - pc.x, dy = y - pc.y;
    const xf = W / 2 + dx * cf + dy * sf, yf = H / 2 - dx * sf + dy * cf; // inverse φ
    const xp = curl.paperX(xf);
    let v;
    if (Number.isNaN(xp)) v = TABLE + 4 * nz * noise();
    else {
      const yp = H / 2 + (yf - H / 2) / curl.scaleAt(xp);
      if (yp < 0 || yp > H - 1) v = TABLE + 4 * nz * noise();
      else {
        const x0 = Math.min(W - 2, Math.floor(xp)), y0 = Math.min(H - 2, Math.floor(yp)), fx = xp - x0, fy = yp - y0;
        const p = paperGray[y0 * W + x0] * (1 - fx) * (1 - fy) + paperGray[y0 * W + x0 + 1] * fx * (1 - fy)
          + paperGray[(y0 + 1) * W + x0] * (1 - fx) * fy + paperGray[(y0 + 1) * W + x0 + 1] * fx * fy;
        const light = 1 + gx * (xp / W - 0.5) + gy * (yp / H - 0.5);
        v = p * light + 2 * nz * noise();
      }
    }
    const o = (y * CW + x) * 4;
    img.data[o] = img.data[o + 1] = img.data[o + 2] = v; img.data[o + 3] = 255;
  }

  let quad = quadFromList([
    curl.forward(0, 0), curl.forward(W - 1, 0), curl.forward(W - 1, H - 1), curl.forward(0, H - 1),
  ].map(toCanon));
  let canonical = gaussianBlur(img, sceneOptions.blurSigma);
  if (spec.quadMode === "jitter") {
    const j = mulberry32(hashString(spec.id + "#jitter"));
    quad = mapQuad(quad, (p) => ({ x: p.x + (j() * 2 - 1) * 0.01 * W, y: p.y + (j() * 2 - 1) * 0.01 * H }));
  } else if (spec.quadMode === "fullframe") {
    // "usar a foto inteira" / a gallery image of the page: the frame IS the
    // page's bounding box and the quad is FULL_FRAME_QUAD denormalized.
    const xs = [quad.topLeft.x, quad.topRight.x, quad.bottomRight.x, quad.bottomLeft.x];
    const ys = [quad.topLeft.y, quad.topRight.y, quad.bottomRight.y, quad.bottomLeft.y];
    const x0 = Math.round(Math.min(...xs)), y0 = Math.round(Math.min(...ys));
    const x1 = Math.round(Math.max(...xs)) + 1, y1 = Math.round(Math.max(...ys)) + 1;
    canonical = cropImage(canonical, x0, y0, x1 - x0, y1 - y0);
    quad = quadFromList([{ x: 0, y: 0 }, { x: canonical.width, y: 0 }, { x: canonical.width, y: canonical.height }, { x: 0, y: canonical.height }]);
  }

  const shouldAct = Math.abs(spec.tiltDeg) >= 0.5 || spec.curl !== "none";
  return {
    spec,
    canonical,
    quad,
    paper: grayToRgba(paperGray, W, H),
    truth: {
      shouldAct,
      tiltDeg: spec.tiltDeg,
      curl: spec.curl,
      edgeBowFrac: curl.edgeBowFrac,
      flatAndStraight: spec.tiltDeg === 0 && spec.curl === "none" && spec.phiDeg === 0,
    },
  };
}

/* ── The matrix ──────────────────────────────────────────────────────── */

export const TILTS = [0, 0.5, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 15];
export const NEG_TILTS = [-1, -2, -4, -6, -10];
export const PHIS = [10, 20, 30];
export const CURLS = ["small", "medium", "large"];

function sceneId(s) {
  return `${s.family}/${s.layout}/${s.quadMode}/t${s.tiltDeg}/p${s.phiDeg}/${s.curl}`;
}

/** Every synthetic scene of the full profile (279), in a fixed order. */
export function sceneMatrix() {
  const out = [];
  const add = (s) => out.push({ ...s, id: sceneId(s) });
  // tilt × layout × quad mode (θ=0 rows are the flat & straight controls)
  for (const layout of LAYOUTS) for (const quadMode of QUAD_MODES) for (const t of [...TILTS, ...NEG_TILTS])
    add({ family: "tilt", layout, quadMode, tiltDeg: t, phiDeg: 0, curl: "none" });
  // in-frame page rotation, square text (nothing to do) and with 3° print skew
  for (const layout of LAYOUTS) for (const phi of PHIS) for (const t of [0, 3])
    add({ family: "rotation", layout, quadMode: "correct", tiltDeg: t, phiDeg: phi, curl: "none" });
  // book curl × {0,3}° tilt × correct / full-frame quad
  for (const layout of LAYOUTS) for (const quadMode of ["correct", "fullframe"]) for (const curl of CURLS) for (const t of [0, 3])
    add({ family: "curl", layout, quadMode, tiltDeg: t, phiDeg: 0, curl });
  // rotation × curl: does in-frame rotation (M5/M6) block the feature's real job?
  for (const layout of ["paragraphs"]) for (const phi of PHIS)
    add({ family: "rotation", layout, quadMode: "correct", tiltDeg: 0, phiDeg: phi, curl: "medium" });
  return out;
}

/**
 * The quick profile's picks from the full matrix (83 scenes): every layout at
 * the tilts that separate the engine's failure modes on a correct outline
 * (0, 0.5, 1, 2, 4, 6, 10, 15, −2), a sample of full-frame and jittered
 * outlines, in-frame rotation at 20°, small and large curl on every layout,
 * medium curl on a full-frame outline, and rotation with curl. A screen for a
 * change, not a verdict: the full profile is what a decision rests on.
 */
const QUICK = {
  correct: [0, 0.5, 1, 2, 4, 6, 10, 15, -2],
  fullframe: [0, 2, 5],
  jitter: [0, 3],
};

function inQuick(s) {
  if (s.family === "tilt") return QUICK[s.quadMode].includes(s.tiltDeg);
  if (s.family === "rotation") return s.phiDeg === 20;
  // curl
  if (s.quadMode === "correct") return s.curl === "small" || s.curl === "large";
  return s.layout === "paragraphs" && s.curl === "medium";
}

/** The scenes of a profile: `full` (279) or `quick` (a subset, 83). */
export function sceneProfile(profile) {
  if (profile === "full") return sceneMatrix();
  if (profile === "quick") return sceneMatrix().filter(inQuick);
  throw new Error(`unknown straighten profile "${profile}" (full or quick)`);
}
