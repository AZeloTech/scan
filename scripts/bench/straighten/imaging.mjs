/**
 * Pure pixel helpers for the straighten suite: the scene generator, the
 * estimators and the engine host share them. No engine imports and no I/O —
 * this module works against any engine root, and without one.
 *
 * @typedef {{ width: number, height: number, data: Uint8ClampedArray }} RgbaImage
 * @typedef {{ x: number, y: number }} Pt
 * @typedef {{ topLeft: Pt, topRight: Pt, bottomRight: Pt, bottomLeft: Pt }} Quad
 */

export const CORNERS = ["topLeft", "topRight", "bottomRight", "bottomLeft"];

export function newImage(width, height) {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function quadFromList(p) {
  return { topLeft: p[0], topRight: p[1], bottomRight: p[2], bottomLeft: p[3] };
}
export function quadList(q) {
  return CORNERS.map((k) => q[k]);
}
export function mapQuad(q, f) {
  return quadFromList(quadList(q).map(f));
}

/** scanic's / crop.ts's output-size rule: max of each opposite pair. */
export function outputDims(q) {
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  return {
    width: Math.max(1, Math.round(Math.max(d(q.bottomRight, q.bottomLeft), d(q.topRight, q.topLeft)))),
    height: Math.max(1, Math.round(Math.max(d(q.topRight, q.bottomRight), d(q.topLeft, q.bottomLeft)))),
  };
}

export function fitLongEdge(w, h, longEdge) {
  const s = Math.min(1, longEdge / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

/** Area-average downscale (what a browser's smoothed drawImage approximates). */
export function areaDownscale(img, longEdge) {
  const size = fitLongEdge(img.width, img.height, longEdge);
  if (size.width === img.width && size.height === img.height) return img;
  const out = newImage(size.width, size.height);
  const sx = img.width / size.width;
  const sy = img.height / size.height;
  const acc = new Float64Array(3);
  for (let oy = 0; oy < size.height; oy++) {
    const y0 = oy * sy, y1 = y0 + sy;
    for (let ox = 0; ox < size.width; ox++) {
      const x0 = ox * sx, x1 = x0 + sx;
      acc[0] = acc[1] = acc[2] = 0;
      let wsum = 0;
      for (let y = Math.floor(y0); y < Math.ceil(y1) && y < img.height; y++) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0);
        if (wy <= 0) continue;
        for (let x = Math.floor(x0); x < Math.ceil(x1) && x < img.width; x++) {
          const wx = Math.min(x + 1, x1) - Math.max(x, x0);
          if (wx <= 0) continue;
          const w = wx * wy, i = (y * img.width + x) * 4;
          acc[0] += img.data[i] * w; acc[1] += img.data[i + 1] * w; acc[2] += img.data[i + 2] * w;
          wsum += w;
        }
      }
      const o = (oy * size.width + ox) * 4;
      out.data[o] = acc[0] / wsum; out.data[o + 1] = acc[1] / wsum; out.data[o + 2] = acc[2] / wsum; out.data[o + 3] = 255;
    }
  }
  return out;
}

/** Bilinear RGB sample with edge clamp; writes into out[0..2]. */
export function sampleBilinear(img, x, y, out) {
  const mx = img.width - 1, my = img.height - 1;
  const cx = x < 0 ? 0 : x > mx ? mx : x;
  const cy = y < 0 ? 0 : y > my ? my : y;
  const x0 = Math.floor(cx), y0 = Math.floor(cy);
  const x1 = x0 < mx ? x0 + 1 : x0, y1 = y0 < my ? y0 + 1 : y0;
  const fx = cx - x0, fy = cy - y0;
  const d = img.data, w = img.width;
  const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4, i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
  const a = (1 - fx) * (1 - fy), b = fx * (1 - fy), c = (1 - fx) * fy, e = fx * fy;
  out[0] = d[i00] * a + d[i10] * b + d[i01] * c + d[i11] * e;
  out[1] = d[i00 + 1] * a + d[i10 + 1] * b + d[i01 + 1] * c + d[i11 + 1] * e;
  out[2] = d[i00 + 2] * a + d[i10 + 2] * b + d[i01 + 2] * c + d[i11 + 2] * e;
}

/* ── Homography (row-major 3×3 Float64Array) ────────────────────────── */

function solve(A, b) {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

/** H with H * src_i ~ dst_i for four correspondences. */
export function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i], { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solve(A, b);
  return Float64Array.from([...h, 1]);
}
export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w };
}

/**
 * The app's flat path, exactly as scanic 1.6's extractDocument does it:
 * homography from the quad onto (0,0),(w-1,0),(w-1,h-1),(0,h-1), inverse-mapped
 * per integer output pixel, clamped bilinear, rounded.
 */
export function warpQuad(src, q, width, height) {
  const H = homography(
    [{ x: 0, y: 0 }, { x: width - 1, y: 0 }, { x: width - 1, y: height - 1 }, { x: 0, y: height - 1 }],
    quadList(q),
  );
  const out = newImage(width, height);
  const rgb = new Float64Array(3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = applyH(H, x, y);
      sampleBilinear(src, p.x, p.y, rgb);
      const o = (y * width + x) * 4;
      out.data[o] = rgb[0] + 0.5; out.data[o + 1] = rgb[1] + 0.5; out.data[o + 2] = rgb[2] + 0.5; out.data[o + 3] = 255;
    }
  }
  return out;
}

/**
 * `drawImage(src, 0, 0, w, h)` at the default imageSmoothingQuality ("low"):
 * one bilinear tap per destination pixel centre, no prefilter — what
 * canvas-surface.ts::scaleSurface gets on Chrome/Safari. (areaDownscale is
 * the prefiltered alternative.)
 */
export function bilinearDownscale(img, longEdge) {
  const size = fitLongEdge(img.width, img.height, longEdge);
  if (size.width === img.width && size.height === img.height) return img;
  const out = newImage(size.width, size.height);
  const sx = img.width / size.width, sy = img.height / size.height;
  const rgb = new Float64Array(3);
  for (let y = 0; y < size.height; y++) for (let x = 0; x < size.width; x++) {
    sampleBilinear(img, (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5, rgb);
    const o = (y * size.width + x) * 4;
    out.data[o] = rgb[0] + 0.5; out.data[o + 1] = rgb[1] + 0.5; out.data[o + 2] = rgb[2] + 0.5; out.data[o + 3] = 255;
  }
  return out;
}

export function cropImage(img, x, y, w, h) {
  const out = newImage(w, h);
  for (let r = 0; r < h; r++) {
    const sy = Math.min(img.height - 1, Math.max(0, y + r));
    for (let c = 0; c < w; c++) {
      const sx = Math.min(img.width - 1, Math.max(0, x + c));
      const i = (sy * img.width + sx) * 4, o = (r * w + c) * 4;
      out.data[o] = img.data[i]; out.data[o + 1] = img.data[i + 1]; out.data[o + 2] = img.data[i + 2]; out.data[o + 3] = 255;
    }
  }
  return out;
}

/* ── Deterministic randomness ────────────────────────────────────────── */

export function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
