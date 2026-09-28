/**
 * Is there paper where the tracked quad is? — the evidence behind "sheet found".
 *
 * The corner model is confident about anything with a page's outline: on an
 * empty desk it "finds" the laptop, the closed notebook and the place mat at
 * a score of 1.0, and a viewfinder that says *sheet found* over them is a
 * viewfinder that lies. The model's score cannot tell them apart; the pixels
 * inside and around the quad can, cheaply, on the ~640 px frame the loop has
 * already sampled:
 *
 *  1. **Edges** — along each side, the surface just inside differs from the
 *     surface just outside, consistently in one direction. A quad drawn across
 *     a textured desk has no side like that; a page has three or four (a
 *     thumb, a glare or the frame's edge can take one).
 *  2. **A paper surface with print on it** — inside the quad, most samples sit
 *     on a smooth background (the stock, whatever its colour: white, kraft,
 *     navy card), and a minority deviate from it *in one direction* (ink:
 *     darker on light stock, lighter on dark stock), spread over the page
 *     rather than in one spot. A laptop lid or a notebook cover is all
 *     background; a woven mat or a keyboard is all texture, in both
 *     directions; a logo is ink in one place.
 *
 * The same numbers also vet a **classical** quad before it may be shown
 * ({@link classicalQuadSane}): that detector's confident failures are the
 * desk, the frame's own edge, a text block inside the page and slivers.
 *
 * Pure (an RGBA buffer and pixel corners in, numbers out), so the worker and
 * the main-thread lane compute the same thing; tested in
 * `paper-evidence.test.ts`. Thresholds are named, and were set on the bench's
 * scenes and sessions (`scripts/bench/README.md`, "Paper evidence").
 */

import type { CornerPoints, Point } from "scanic";

/** What the evidence found, for the decision and for the bench's probe. */
export interface PaperEvidence {
  /** The quad shows paper: {@link paperLike} over the numbers below. */
  ok: boolean;
  /** Sides whose inside and outside differ consistently. */
  sidesSupported: number;
  /** Sides that could be judged at all (the frame did not cut them off). */
  sidesKnown: number;
  /** Per side (TL→TR, TR→BR, BR→BL, BL→TL): share of profiles that support it, or null. */
  sideSupport: (number | null)[];
  /** Share of the interior on its own smooth background. */
  background: number;
  /** Share of the interior deviating from it in the dominant direction. */
  ink: number;
  /** Share deviating the other way. */
  counterInk: number;
  /** Share of interior blocks holding ink. */
  inkSpread: number;
  /** Share of the ink that is solid area rather than strokes (its four neighbours ink too). */
  solidInk: number;
  /** How much the background itself varies from block to block (0–1 of the range). */
  backgroundSpread: number;
}

/** The rules the numbers are judged by (see {@link judgeEvidence}); defaults in {@link PAPER}. */
export interface EvidenceRules {
  /** A profile steps when inside and outside differ by this much luma (0–255). */
  edgeStep: number;
  /** …and lies within this many px of the side's fitted line. */
  edgeLinePx: number;
  /** A side is supported when this share of its judged profiles step, one way, on one line. */
  sideSupport: number;
  /** Sides needed (fewer when the frame cut some off — never under two). */
  minSides: number;
  /** An interior sample within this of its background is background… */
  backgroundBand: number;
  /** …and one this far from it is ink. */
  inkStep: number;
  /** Share of the interior samples that must be background (the sheet itself). */
  minBackground: number;
  minInk: number;
  /**
   * Faint print: on an interior this clean (background share at least
   * `faintBackground`), ink down to `faintInk` is enough — a sparse page in
   * pale print at a phone's full resolution, where the strokes are a few
   * samples wide.
   */
  faintInk: number;
  faintBackground: number;
  maxInk: number;
  /** Share of the interior's blocks that must hold ink. */
  minInkSpread: number;
  /** The minority direction may be at most this share of the dominant one (plus a floor). */
  maxCounterRatio: number;
  counterFloor: number;
  /** Largest spread of the background between blocks (0–1 of the luma range). */
  maxBackgroundSpread: number;
  /** Largest share of the ink that may be solid area. */
  maxSolidInk: number;
}

/**
 * The shipped rules, set on the bench (`scripts/bench/README.md`, "Paper
 * evidence"): over the model's own quads on 186 synthetic pages (F1–F7), 55
 * page-less F6 scenes it answered on, and 94 real stills and clip frames
 * (numbers only), they keep 98.9 % of the synthetic pages and 94.7 % of the
 * real ones and pass 4 of the 55 laptops, keyboards, notebooks and place
 * mats. The faint-print allowance is what takes the real share from 91.5 %
 * (86 of 94, one place mat fewer) and a sparse, pale real page held on
 * camera from 69 % of its readings to 95 %. The background floor is 0.68, not
 * 0.65: a black keyboard on a wooden desk reads 0.66–0.68 (its keycaps are
 * the "sheet", the gaps and legends the "ink"), a page 0.8 and up; over the
 * model's passes in 10-seed session runs that cut the empty-desk readings
 * passing as paper from 35 of 676 to 12, and not one of the 7896 readings of
 * the hold sessions nor any synthetic or real page. The low edge step is deliberate: a white page on a white table
 * differs from it by 3–8 luma levels, and what makes that an edge is that it
 * is the same step, in the same place, all along the side.
 */
export const PAPER: EvidenceRules = {
  edgeStep: 3,
  edgeLinePx: 2.5,
  sideSupport: 0.55,
  minSides: 3,
  backgroundBand: 12,
  inkStep: 22,
  minBackground: 0.68,
  minInk: 0.025,
  faintInk: 0.012,
  faintBackground: 0.92,
  maxInk: 0.45,
  minInkSpread: 0.15,
  maxCounterRatio: 0.45,
  counterFloor: 0.01,
  maxBackgroundSpread: 0.35,
  maxSolidInk: 0.35,
};

/** The step's boxes, and how far from the side it is looked for — shares of the frame's short side. */
const EDGE_DEPTH = 0.01;
const EDGE_REACH = 0.025;
/** Profiles per side, and the share of the side they span. */
const PROFILES = 20;
const PROFILE_SPAN = [0.12, 0.88] as const;
/** A side needs this many judged profiles to be judged at all. */
const MIN_JUDGED = 6;

/** The interior grid: about one sample per 3 px, within these bounds per axis. */
const GRID_MIN = 20;
const GRID_MAX = 64;
/** Interior samples stay this far (as a share of the quad) from its edges. */
const INSET = 0.07;
/** Background blocks per axis. */
const BLOCKS = 6;

function luma(data: Uint8ClampedArray, width: number, height: number, x: number, y: number): number | null {
  if (!(x >= 0 && y >= 0 && x <= width - 1 && y <= height - 1)) return null;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const at = (px: number, py: number): number => {
    const i = (py * width + px) * 4;
    return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  };
  const top = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
  const bottom = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
  return top * (1 - fy) + bottom * fy;
}

function corners(quad: CornerPoints): Point[] {
  return [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];
}

/** A point of the quad at (u, v) in [0, 1]², bilinearly between its corners. */
function inside(c: Point[], u: number, v: number): Point {
  const top = { x: c[0].x + (c[1].x - c[0].x) * u, y: c[0].y + (c[1].y - c[0].y) * u };
  const bottom = { x: c[3].x + (c[2].x - c[3].x) * u, y: c[3].y + (c[2].y - c[3].y) * u };
  return { x: top.x + (bottom.x - top.x) * v, y: top.y + (bottom.y - top.y) * v };
}

function median(values: ArrayLike<number>): number {
  if (values.length === 0) return 0;
  const sorted = Array.from(values).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** One profile across a side: where along it (0–1), the strongest step (inside − outside), and its offset (px, outward +). */
export interface EdgeProfile {
  t: number;
  step: number;
  at: number;
}

/** What {@link measureEvidence} read, before any threshold: the numbers {@link judgeEvidence} judges. */
export interface EvidenceSamples {
  /** Per side (TL→TR, TR→BR, BR→BL, BL→TL): its profiles, or null when the frame cut it off. */
  sides: (EdgeProfile[] | null)[];
  /** Per side, its length (px). */
  sideLengths: number[];
  /**
   * Every interior sample's luma minus its background, row by row over a
   * `cols`×`rows` grid (`NaN` where the sample fell off the frame).
   */
  residuals: Float32Array;
  cols: number;
  rows: number;
  /** The block (0 … blocks − 1) each residual lies in. */
  blockOf: Uint8Array;
  blocks: number;
  /** The background of each block (its median luma). */
  blockMedians: number[];
}

/**
 * Per side, per profile (a short line across the side): the strongest step
 * between a box of samples inside and one outside, anywhere within
 * {@link EDGE_REACH} of the side — the tracked quad is the model's, a few
 * pixels off the paper's edge as a rule. Profiles off the frame are not read.
 */
function measureSides(data: Uint8ClampedArray, width: number, height: number, c: Point[]): { sides: (EdgeProfile[] | null)[]; lengths: number[] } {
  const cx = (c[0].x + c[1].x + c[2].x + c[3].x) / 4;
  const cy = (c[0].y + c[1].y + c[2].y + c[3].y) / 4;
  const short = Math.min(width, height);
  const depth = Math.max(2, Math.round(EDGE_DEPTH * short));
  const reach = Math.max(2, Math.round(EDGE_REACH * short));
  const span = reach + depth;
  const line = new Float64Array(2 * span + 1);
  const sides: (EdgeProfile[] | null)[] = [];
  const lengths: number[] = [];
  for (let side = 0; side < 4; side += 1) {
    const a = c[side];
    const b = c[(side + 1) % 4];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    lengths.push(length);
    if (length < 4) {
      sides.push(null);
      continue;
    }
    let nx = -(b.y - a.y) / length;
    let ny = (b.x - a.x) / length;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    // Outward: away from the quad's centre.
    if ((mx - cx) * nx + (my - cy) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    const profiles: EdgeProfile[] = [];
    for (let k = 0; k < PROFILES; k += 1) {
      const t = PROFILE_SPAN[0] + ((PROFILE_SPAN[1] - PROFILE_SPAN[0]) * k) / (PROFILES - 1);
      const px = a.x + (b.x - a.x) * t;
      const py = a.y + (b.y - a.y) * t;
      // line[j] is the luma at offset (j - span) px along the outward normal.
      let inFrame = true;
      for (let j = 0; j <= 2 * span; j += 1) {
        const value = luma(data, width, height, px + nx * (j - span), py + ny * (j - span));
        if (value === null) {
          inFrame = false;
          break;
        }
        line[j] = value;
      }
      if (!inFrame) continue;
      let best = 0;
      let bestAt = 0;
      for (let centre = depth; centre <= 2 * span - depth; centre += 1) {
        let insideSum = 0;
        let outsideSum = 0;
        for (let d = 1; d <= depth; d += 1) {
          insideSum += line[centre - d];
          outsideSum += line[centre + d - 1];
        }
        const step = (insideSum - outsideSum) / depth;
        if (Math.abs(step) > Math.abs(best)) {
          best = step;
          bestAt = centre - span;
        }
      }
      profiles.push({ t, step: best, at: bestAt });
    }
    sides.push(profiles.length < MIN_JUDGED ? null : profiles);
  }
  return { sides, lengths };
}

/**
 * The interior: a grid of luma samples, a smooth background from block
 * medians (so a lighting gradient or a shadow across the page is background,
 * not ink), and each sample's residual from it.
 */
function measureInterior(data: Uint8ClampedArray, width: number, height: number, c: Point[]) {
  const across = (Math.hypot(c[1].x - c[0].x, c[1].y - c[0].y) + Math.hypot(c[2].x - c[3].x, c[2].y - c[3].y)) / 2;
  const down = (Math.hypot(c[3].x - c[0].x, c[3].y - c[0].y) + Math.hypot(c[2].x - c[1].x, c[2].y - c[1].y)) / 2;
  const cols = Math.max(GRID_MIN, Math.min(GRID_MAX, Math.round(across / 3)));
  const rows = Math.max(GRID_MIN, Math.min(GRID_MAX, Math.round(down / 3)));
  const grid = new Float32Array(cols * rows).fill(Number.NaN);
  for (let j = 0; j < rows; j += 1) {
    const v = INSET + ((1 - 2 * INSET) * (j + 0.5)) / rows;
    for (let i = 0; i < cols; i += 1) {
      const u = INSET + ((1 - 2 * INSET) * (i + 0.5)) / cols;
      const p = inside(c, u, v);
      const y = luma(data, width, height, p.x, p.y);
      if (y !== null) grid[j * cols + i] = y;
    }
  }
  const blocks = new Float32Array(BLOCKS * BLOCKS).fill(Number.NaN);
  for (let bj = 0; bj < BLOCKS; bj += 1) {
    for (let bi = 0; bi < BLOCKS; bi += 1) {
      const values: number[] = [];
      for (let j = Math.floor((bj * rows) / BLOCKS); j < Math.floor(((bj + 1) * rows) / BLOCKS); j += 1) {
        for (let i = Math.floor((bi * cols) / BLOCKS); i < Math.floor(((bi + 1) * cols) / BLOCKS); i += 1) {
          const y = grid[j * cols + i];
          if (!Number.isNaN(y)) values.push(y);
        }
      }
      if (values.length > 0) blocks[bj * BLOCKS + bi] = median(values);
    }
  }
  const known = Array.from(blocks).filter((b) => !Number.isNaN(b));
  const fallback = median(known);
  for (let b = 0; b < blocks.length; b += 1) if (Number.isNaN(blocks[b])) blocks[b] = fallback;
  const background = (i: number, j: number): number => {
    const fx = Math.max(0, Math.min(BLOCKS - 1, ((i + 0.5) / cols) * BLOCKS - 0.5));
    const fy = Math.max(0, Math.min(BLOCKS - 1, ((j + 0.5) / rows) * BLOCKS - 0.5));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(BLOCKS - 1, x0 + 1);
    const y1 = Math.min(BLOCKS - 1, y0 + 1);
    const ax = fx - x0;
    const ay = fy - y0;
    const top = blocks[y0 * BLOCKS + x0] * (1 - ax) + blocks[y0 * BLOCKS + x1] * ax;
    const bottom = blocks[y1 * BLOCKS + x0] * (1 - ax) + blocks[y1 * BLOCKS + x1] * ax;
    return top * (1 - ay) + bottom * ay;
  };
  const residuals = new Float32Array(cols * rows);
  const blockOf = new Uint8Array(cols * rows);
  let inFrame = 0;
  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < cols; i += 1) {
      const at = j * cols + i;
      const y = grid[at];
      residuals[at] = Number.isNaN(y) ? Number.NaN : y - background(i, j);
      if (!Number.isNaN(y)) inFrame += 1;
      blockOf[at] = Math.min(BLOCKS - 1, Math.floor((j * BLOCKS) / rows)) * BLOCKS + Math.min(BLOCKS - 1, Math.floor((i * BLOCKS) / cols));
    }
  }
  return { residuals, cols, rows, inFrame, blockOf, blockMedians: known };
}

/**
 * What the pixels in and around `quad` (pixels of a `width`×`height` RGBA
 * frame) say, before any threshold — or null when the quad is degenerate or
 * none of its interior is in the frame.
 */
export function measureEvidence(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  quad: CornerPoints,
): EvidenceSamples | null {
  if (width <= 0 || height <= 0 || data.length < width * height * 4) return null;
  const c = corners(quad);
  if (c.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
  const { sides, lengths } = measureSides(data, width, height, c);
  const { inFrame, ...texture } = measureInterior(data, width, height, c);
  if (inFrame === 0) return null;
  return { sides, sideLengths: lengths, ...texture, blocks: BLOCKS * BLOCKS };
}

/**
 * How many of the steps lie on one straight line across the profiles (offset
 * against position along the side, a Theil–Sen fit), within `tolerance` px.
 */
function onOneLine(points: EdgeProfile[], sideLength: number, tolerance: number): number {
  if (points.length < 2) return points.length;
  const slopes: number[] = [];
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const dt = (points[j].t - points[i].t) * sideLength;
      if (Math.abs(dt) > 1e-6) slopes.push((points[j].at - points[i].at) / dt);
    }
  }
  const slope = median(slopes);
  const intercept = median(points.map((p) => p.at - slope * p.t * sideLength));
  return points.filter((p) => Math.abs(p.at - (intercept + slope * p.t * sideLength)) <= tolerance).length;
}

/**
 * The numbers, and the verdict, under `rules`.
 *
 * A side is supported when most of its judged profiles step by
 * `edgeStep` or more **in one direction** (paper lighter than the desk all
 * along it, or darker all along it) **on one straight line** — a paper's edge
 * is straight, the strongest steps of a textured desk are anywhere. Inside,
 * ink is what deviates from the background by `inkStep` in the dominant
 * direction.
 */
export function judgeEvidence(samples: EvidenceSamples, rules: EvidenceRules = PAPER): PaperEvidence {
  const sideSupport = samples.sides.map((profiles, side) => {
    if (profiles === null) return null;
    const up = profiles.filter((p) => p.step >= rules.edgeStep);
    const down = profiles.filter((p) => p.step <= -rules.edgeStep);
    const majority = up.length >= down.length ? up : down;
    return onOneLine(majority, samples.sideLengths[side], rules.edgeLinePx) / profiles.length;
  });
  const judged = sideSupport.filter((s): s is number => s !== null);
  const { residuals, cols, rows } = samples;
  let count = 0;
  let onBackground = 0;
  let dark = 0;
  let light = 0;
  const darkBlocks = new Uint16Array(samples.blocks);
  const lightBlocks = new Uint16Array(samples.blocks);
  for (let k = 0; k < residuals.length; k += 1) {
    const r = residuals[k];
    if (Number.isNaN(r)) continue;
    count += 1;
    if (Math.abs(r) <= rules.backgroundBand) onBackground += 1;
    if (r <= -rules.inkStep) {
      dark += 1;
      darkBlocks[samples.blockOf[k]] += 1;
    } else if (r >= rules.inkStep) {
      light += 1;
      lightBlocks[samples.blockOf[k]] += 1;
    }
  }
  const darkInk = dark >= light;
  const inkBlocks = darkInk ? darkBlocks : lightBlocks;
  // Print is strokes — thin, broken, mostly paper around them; a keyboard's
  // keys, a laptop's well, a notebook's cover are solid areas. The share of
  // ink samples whose four neighbours are all ink too.
  const isInk = (r: number): boolean => (darkInk ? r <= -rules.inkStep : r >= rules.inkStep);
  let inkSamples = 0;
  let solid = 0;
  for (let j = 1; j < rows - 1; j += 1) {
    for (let i = 1; i < cols - 1; i += 1) {
      const at = j * cols + i;
      if (!isInk(residuals[at])) continue;
      inkSamples += 1;
      if (isInk(residuals[at - 1]) && isInk(residuals[at + 1]) && isInk(residuals[at - cols]) && isInk(residuals[at + cols])) solid += 1;
    }
  }
  const perBlock = count / samples.blocks;
  const spread = Array.from(inkBlocks).filter((n) => n >= Math.max(2, perBlock * 0.01)).length / samples.blocks;
  const sortedBlocks = [...samples.blockMedians].sort((a, b) => a - b);
  const blockRange =
    sortedBlocks.length > 1
      ? (sortedBlocks[Math.floor(sortedBlocks.length * 0.9)] - sortedBlocks[Math.floor(sortedBlocks.length * 0.1)]) / 255
      : 0;
  const numbers = {
    sidesSupported: judged.filter((s) => s >= rules.sideSupport).length,
    sidesKnown: judged.length,
    sideSupport,
    background: onBackground / count,
    ink: Math.max(dark, light) / count,
    counterInk: Math.min(dark, light) / count,
    inkSpread: spread,
    solidInk: inkSamples > 0 ? solid / inkSamples : 0,
    backgroundSpread: blockRange,
  };
  return { ok: paperLike(numbers, rules), ...numbers };
}

/** The decision over the numbers. */
export function paperLike(e: Omit<PaperEvidence, "ok">, rules: EvidenceRules = PAPER): boolean {
  const sidesNeeded = Math.min(rules.minSides, Math.max(2, e.sidesKnown - 1));
  return (
    e.sidesKnown >= 2 &&
    e.sidesSupported >= sidesNeeded &&
    e.background >= rules.minBackground &&
    e.ink >= (e.background >= rules.faintBackground ? rules.faintInk : rules.minInk) &&
    e.ink <= rules.maxInk &&
    e.inkSpread >= rules.minInkSpread &&
    e.counterInk <= e.ink * rules.maxCounterRatio + rules.counterFloor &&
    e.backgroundSpread <= rules.maxBackgroundSpread &&
    e.solidInk <= rules.maxSolidInk
  );
}

/**
 * The evidence for `quad` (pixels of a `width`×`height` RGBA frame), or null
 * when the quad is degenerate or entirely off the frame.
 */
export function paperEvidence(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  quad: CornerPoints,
  rules: EvidenceRules = PAPER,
): PaperEvidence | null {
  const samples = measureEvidence(data, width, height, quad);
  return samples === null ? null : judgeEvidence(samples, rules);
}

/* ── the classical detector's quads ─────────────────────────────────────── */

/** A side this close to a frame border (share of the short side) lies on it. */
const BORDER_HUG = 0.02;
/** Interior angles outside this band are not a page seen by a phone. */
const MIN_ANGLE_DEG = 35;
/** Short over long side: under this, a sliver. */
const MIN_SIDE_RATIO = 0.18;

/** How many of the quad's sides lie along a border of the frame. */
export function sidesOnFrameBorder(quad: CornerPoints, width: number, height: number): number {
  const c = corners(quad);
  const tolerance = BORDER_HUG * Math.min(width, height);
  let count = 0;
  for (let side = 0; side < 4; side += 1) {
    const a = c[side];
    const b = c[(side + 1) % 4];
    const onLeft = a.x <= tolerance && b.x <= tolerance;
    const onRight = a.x >= width - 1 - tolerance && b.x >= width - 1 - tolerance;
    const onTop = a.y <= tolerance && b.y <= tolerance;
    const onBottom = a.y >= height - 1 - tolerance && b.y >= height - 1 - tolerance;
    if (onLeft || onRight || onTop || onBottom) count += 1;
  }
  return count;
}

/** The smallest interior angle, degrees. */
export function minInteriorAngle(quad: CornerPoints): number {
  const c = corners(quad);
  let least = 180;
  for (let k = 0; k < 4; k += 1) {
    const p = c[k];
    const a = c[(k + 3) % 4];
    const b = c[(k + 1) % 4];
    const v1x = a.x - p.x;
    const v1y = a.y - p.y;
    const v2x = b.x - p.x;
    const v2y = b.y - p.y;
    const norm = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
    if (norm === 0) return 0;
    const angle = (Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / norm))) * 180) / Math.PI;
    least = Math.min(least, angle);
  }
  return least;
}

/** Mean short side over mean long side (opposite sides averaged). */
export function sideRatio(quad: CornerPoints): number {
  const c = corners(quad);
  const len = (a: Point, b: Point): number => Math.hypot(b.x - a.x, b.y - a.y);
  const across = (len(c[0], c[1]) + len(c[3], c[2])) / 2;
  const down = (len(c[0], c[3]) + len(c[1], c[2])) / 2;
  const long = Math.max(across, down);
  return long > 0 ? Math.min(across, down) / long : 0;
}

/**
 * Whether a classical quad may be shown before the model is ready (or after it
 * failed): not the frame's own border (it touches at most one), a shape a
 * page seen by a phone can have (no angle under {@link MIN_ANGLE_DEG}, no
 * sliver) — and paper in it, when the evidence could be read: a text block
 * inside the page has print right up to its sides and the page's own paper
 * outside them; the desk has no print at all.
 */
export function classicalQuadSane(
  quad: CornerPoints,
  width: number,
  height: number,
  evidence: PaperEvidence | null,
): boolean {
  if (sidesOnFrameBorder(quad, width, height) >= 2) return false;
  if (minInteriorAngle(quad) < MIN_ANGLE_DEG) return false;
  if (sideRatio(quad) < MIN_SIDE_RATIO) return false;
  return evidence === null || evidence.ok;
}
