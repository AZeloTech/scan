/**
 * Where the photo's picture sits against the viewfinder's — measured from
 * the pictures themselves, not from the page (Phase 5a, review fix).
 *
 * `lib/still-check.ts` compares the page the viewfinder vouched for with the
 * page detected on the photo. That comparison can only ever be as good as
 * the photo's detection: when it finds nothing (the camera hunting focus at
 * the shutter) there is nothing to compare, and when it locks onto the wrong
 * contour — an inner printed border on a form, which a photo that sees LESS
 * than the viewfinder can make look exactly like the viewfinder's page — a
 * cut sheet fits perfectly. What the page check cannot establish is the one
 * thing that matters: does the photo still contain everything the
 * viewfinder showed?
 *
 * This answers that directly. A small grey thumbnail of the preview, drawn
 * at the tap, is registered against a thumbnail of the photo: the field of
 * view and the shift that best take one onto the other (normalised
 * cross-correlation over the scene, a coarse search then a fine one). The
 * camera model is `mapPreviewQuadToStill`'s — one optical centre, long edges
 * spanning the same angle — so the answer plugs straight into it. A photo
 * that sees less (a zoomed pipeline), one that sees more (a stabilised
 * preview), one taken a hand's drift later: all measured, whatever the page
 * detector made of the photo.
 *
 * Pure apart from {@link lumaThumb}, which draws a source into a thumbnail
 * (the only DOM here). No pixels leave the function that reads them.
 */

/** A grey thumbnail: luma in 0–1, row-major, and the size of what it was drawn from. */
export interface LumaThumb {
  width: number;
  height: number;
  data: Float32Array;
  /** The source's own size in pixels (its shape; the thumbnail's is rounded). */
  sourceWidth: number;
  sourceHeight: number;
}

/**
 * The best registration of the preview on the photo, in the terms of
 * `mapPreviewQuadToStill`: a preview point `q` lands on the photo at
 * `0.5 + (q − 0.5)·k / fovScale + shift` (per axis, `k` the shape factor).
 */
export interface StillRegistration {
  /** The photo's field of view over the preview's (above 1: it sees more). */
  fovScale: number;
  /** Where the preview's centre landed, as a share of the photo's width/height. */
  shiftX: number;
  shiftY: number;
  /** Normalised cross-correlation at the best fit, −1…1. */
  score: number;
  /** The share of the preview's thumbnail that landed on the photo at the best fit. */
  overlap: number;
}

/** Thumbnail long edge for the fine search. */
export const REGISTER_LONG_EDGE = 96;
/** Thumbnail long edge for the coarse search (a box-reduction of the fine one). */
const COARSE_LONG_EDGE = 32;
/** The fields of view searched: from a photo that sees 0.6× the preview to one that sees 1.5×. */
const FOV_RANGE: readonly [number, number] = [0.6, 1.5];
/** Coarse field-of-view step (ratio). */
const FOV_STEP = 1.03;
/** How far the photo may have drifted, as a share of each axis. */
const MAX_SHIFT = 0.12;
/** The least share of the preview that must land on the photo for a fit to count. */
const MIN_OVERLAP = 0.5;
/** Half a thumbnail pixel past the outermost sample centres still reads the edge pixel. */
const EDGE_SLACK = 0.5;
/** Luma variance below which a thumbnail holds no structure to register (a blank wall). */
const MIN_VARIANCE = 1e-4;

/** How the preview's shape and the photo's turn into per-axis factors (`mapPreviewQuadToStill`, no turn). */
function shapeFactors(preview: LumaThumb, still: LumaThumb): { kx: number; ky: number } {
  const pl = Math.max(preview.sourceWidth, preview.sourceHeight);
  const sl = Math.max(still.sourceWidth, still.sourceHeight);
  return {
    kx: ((preview.sourceWidth / pl) * sl) / still.sourceWidth,
    ky: ((preview.sourceHeight / pl) * sl) / still.sourceHeight,
  };
}

/** A thumbnail box-reduced by an integer factor (the coarse level). */
export function reduceThumb(thumb: LumaThumb, factor: number): LumaThumb {
  const width = Math.max(1, Math.floor(thumb.width / factor));
  const height = Math.max(1, Math.floor(thumb.height / factor));
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let dy = 0; dy < factor; dy += 1) {
        const row = (y * factor + dy) * thumb.width;
        for (let dx = 0; dx < factor; dx += 1) sum += thumb.data[row + x * factor + dx];
      }
      data[y * width + x] = sum / (factor * factor);
    }
  }
  return { width, height, data, sourceWidth: thumb.sourceWidth, sourceHeight: thumb.sourceHeight };
}

function variance(thumb: LumaThumb): number {
  let s = 0;
  let ss = 0;
  for (const v of thumb.data) {
    s += v;
    ss += v * v;
  }
  const n = thumb.data.length;
  return n === 0 ? 0 : ss / n - (s / n) ** 2;
}

/** The correlation of the preview laid onto the photo at one field of view and shift. */
export function scoreAt(
  preview: LumaThumb,
  still: LumaThumb,
  fovScale: number,
  shiftX: number,
  shiftY: number,
): { score: number; overlap: number } {
  const { kx, ky } = shapeFactors(preview, still);
  const ax = kx / fovScale;
  const ay = ky / fovScale;
  const sw = still.width;
  const sh = still.height;
  const sd = still.data;
  let n = 0;
  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  for (let j = 0; j < preview.height; j += 1) {
    const uy = 0.5 + ((j + 0.5) / preview.height - 0.5) * ay + shiftY;
    const fy = Math.min(sh - 1, Math.max(0, uy * sh - 0.5));
    if (uy * sh - 0.5 < -EDGE_SLACK || uy * sh - 0.5 > sh - 1 + EDGE_SLACK) continue;
    const y0 = Math.floor(fy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const wy = fy - y0;
    for (let i = 0; i < preview.width; i += 1) {
      const ux = 0.5 + ((i + 0.5) / preview.width - 0.5) * ax + shiftX;
      const fx = Math.min(sw - 1, Math.max(0, ux * sw - 0.5));
      if (ux * sw - 0.5 < -EDGE_SLACK || ux * sw - 0.5 > sw - 1 + EDGE_SLACK) continue;
      const x0 = Math.floor(fx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const wx = fx - x0;
      const top = sd[y0 * sw + x0] * (1 - wx) + sd[y0 * sw + x1] * wx;
      const bottom = sd[y1 * sw + x0] * (1 - wx) + sd[y1 * sw + x1] * wx;
      const b = top * (1 - wy) + bottom * wy;
      const a = preview.data[j * preview.width + i];
      n += 1;
      sa += a;
      sb += b;
      saa += a * a;
      sbb += b * b;
      sab += a * b;
    }
  }
  const overlap = n / (preview.width * preview.height);
  if (n < 16) return { score: -1, overlap };
  const va = saa - (sa * sa) / n;
  const vb = sbb - (sb * sb) / n;
  if (va <= MIN_VARIANCE * n || vb <= MIN_VARIANCE * n) return { score: -1, overlap };
  return { score: (sab - (sa * sb) / n) / Math.sqrt(va * vb), overlap };
}

/**
 * The field of view and shift that best lay the preview onto the photo —
 * `null` when either picture holds no structure to register (a blank
 * scene), so nothing can be said. Coarse over the whole range at a
 * {@link COARSE_LONG_EDGE}-pixel level, then fine around the three best.
 */
export function registerStill(preview: LumaThumb, still: LumaThumb): StillRegistration | null {
  if (variance(preview) < MIN_VARIANCE || variance(still) < MIN_VARIANCE) return null;
  const pf = Math.max(1, Math.round(Math.max(preview.width, preview.height) / COARSE_LONG_EDGE));
  const sf = Math.max(1, Math.round(Math.max(still.width, still.height) / COARSE_LONG_EDGE));
  const pc = reduceThumb(preview, pf);
  const sc = reduceThumb(still, sf);
  type Candidate = StillRegistration;
  const coarse: Candidate[] = [];
  const stepX = 1 / sc.width;
  const stepY = 1 / sc.height;
  const nx = Math.ceil(MAX_SHIFT / stepX);
  const ny = Math.ceil(MAX_SHIFT / stepY);
  for (let fov = FOV_RANGE[0]; fov <= FOV_RANGE[1] * 1.0001; fov *= FOV_STEP) {
    for (let iy = -ny; iy <= ny; iy += 1) {
      for (let ix = -nx; ix <= nx; ix += 1) {
        const r = scoreAt(pc, sc, fov, ix * stepX, iy * stepY);
        if (r.overlap < MIN_OVERLAP) continue;
        coarse.push({ fovScale: fov, shiftX: ix * stepX, shiftY: iy * stepY, score: r.score, overlap: r.overlap });
      }
    }
  }
  if (coarse.length === 0) return null;
  coarse.sort((a, b) => b.score - a.score);
  // Seeds for the fine search: the best, and the best two that are not its neighbours.
  const seeds: Candidate[] = [];
  for (const c of coarse) {
    if (seeds.length >= 3) break;
    const near = seeds.some(
      (s) => Math.abs(Math.log(s.fovScale / c.fovScale)) < 2.5 * Math.log(FOV_STEP) && Math.abs(s.shiftX - c.shiftX) <= 2 * stepX && Math.abs(s.shiftY - c.shiftY) <= 2 * stepY,
    );
    if (!near) seeds.push(c);
  }
  let best: Candidate | null = null;
  const fineX = 1 / still.width;
  const fineY = 1 / still.height;
  const reachX = Math.ceil(stepX / fineX);
  const reachY = Math.ceil(stepY / fineY);
  for (const seed of seeds) {
    for (let k = -2; k <= 2; k += 1) {
      const fov = seed.fovScale * Math.pow(FOV_STEP, k / 2);
      for (let iy = -reachY; iy <= reachY; iy += 1) {
        for (let ix = -reachX; ix <= reachX; ix += 1) {
          const shiftX = seed.shiftX + ix * fineX;
          const shiftY = seed.shiftY + iy * fineY;
          const r = scoreAt(preview, still, fov, shiftX, shiftY);
          if (r.overlap < MIN_OVERLAP) continue;
          if (best === null || r.score > best.score) best = { fovScale: fov, shiftX, shiftY, score: r.score, overlap: r.overlap };
        }
      }
    }
  }
  return best;
}

/**
 * Draw `source` (a video, a canvas) into a grey thumbnail whose long edge is
 * `longEdge`, reducing in steps of at most 4× with high-quality smoothing so
 * a 12-megapixel photo does not alias into noise on the way down. `null`
 * when there is nothing to draw or no 2D context.
 */
export function lumaThumb(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  longEdge = REGISTER_LONG_EDGE,
): LumaThumb | null {
  if (!(sourceWidth > 0 && sourceHeight > 0) || typeof document === "undefined") return null;
  const long = Math.max(sourceWidth, sourceHeight);
  const target = { width: Math.max(1, Math.round((sourceWidth / long) * longEdge)), height: Math.max(1, Math.round((sourceHeight / long) * longEdge)) };
  let current: CanvasImageSource = source;
  let cw = sourceWidth;
  let ch = sourceHeight;
  const scratch: HTMLCanvasElement[] = [];
  try {
    for (;;) {
      const ratio = Math.max(cw / target.width, ch / target.height);
      const step = ratio > 4 ? 4 : ratio;
      const w = ratio > 4 ? Math.max(target.width, Math.round(cw / step)) : target.width;
      const h = ratio > 4 ? Math.max(target.height, Math.round(ch / step)) : target.height;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      scratch.push(canvas);
      const context = canvas.getContext("2d", { willReadFrequently: w === target.width });
      if (context === null) return null;
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(current, 0, 0, w, h);
      current = canvas;
      cw = w;
      ch = h;
      if (w === target.width && h === target.height) {
        const rgba = context.getImageData(0, 0, w, h).data;
        const data = new Float32Array(w * h);
        for (let p = 0, q = 0; p < data.length; p += 1, q += 4) {
          data[p] = (0.299 * rgba[q] + 0.587 * rgba[q + 1] + 0.114 * rgba[q + 2]) / 255;
        }
        return { width: w, height: h, data, sourceWidth, sourceHeight };
      }
    }
  } catch {
    return null;
  } finally {
    for (const canvas of scratch) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}
