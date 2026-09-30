/**
 * Text deskew for Endireitar — the tilt of the print, fixed before (and
 * mostly instead of) the curved-page engine.
 *
 * The capture homography flattens the *sheet*: it maps the confirmed outline
 * Q onto a rectangle. When the print sits skewed on that sheet — a photocopy
 * fed crooked, a label stuck on at an angle, an outline the user confirmed a
 * few degrees off — the flat page is square but its text lines are not, and
 * the dewarp engine (pinned to Q) can only express that rotation as a
 * boundary offset its own guards refuse.
 *
 * So the tap on Endireitar runs this first, on the small flat page B₀ of Q
 * the stage already renders for the engine's A/B:
 *
 * ```
 * B₀ ─ estimate θ ─ rotation R(θ) about the page centre, its own transform
 *    ─ render B′ (the page of Q composed with R: one resample of the photo)
 *    ─ paint the uncovered corner wedges in the paper colour next to them
 *    ─ JUDGE B′ against B₀ — the rotation must leave the print more level,
 *      no less straight, and inside the frame — or drop the rotation
 *    ─ curl evidence on B′? then (and only then) the engine runs — on Q, with
 *      its own A/B against B₀, exactly as before this step existed; the
 *      rotation is what the page gets when the engine declines
 * ```
 *
 * Why the engine runs on Q and not on the rotated outline: measured on the
 * straighten bench, the engine on Q′ lost three curled pages it fixes on Q
 * (a Q′ past the photo reads as blank border; a level page pinned to Q′
 * pushed print into the border) and fixed two it declines on Q — one more
 * harm and one fewer complete fix overall. The classical engine models text
 * lines, so on the pages it accepts it levels a few degrees of tilt itself.
 *
 * **Q stays the document's outline.** The rotation is a separate record
 * ({@link DeskewPlan}: θ, the wedge policy, what it was judged on) that is
 * composed with Q at render time. Composing is exact: a homography is fixed
 * by four point pairs, so warping the outline Q′ = H_Q(R(rect)) onto the
 * output rectangle *is* "homography, then rotate about the centre", in a
 * single resample — flat path and curved path alike. Nothing downstream
 * replaces Q with Q′; a corner edit throws the rotation away and asks again.
 *
 * The estimator is deliberately conservative — it *abstains* unless the page
 * is plainly text in lines, all at one angle:
 *
 *  1. ink mask on a ≤{@link DESKEW_LONG_EDGE} px copy (local-contrast ink;
 *     large dark regions — the table showing in a loose outline — excluded);
 *  2. 8-connected components; glyph/word-sized ones kept, graphics dropped;
 *  3. coarse angle vote: projection energy of the component *centroids* over
 *     ±{@link COARSE_RANGE_DEG}° — and the same vote a quarter turn away, so a
 *     page lying on its side is refused rather than rotated a few degrees;
 *  4. refine: projection energy of the glyph *pixels* over ±1° of the vote;
 *  5. the two ink halves estimated on their own — a curl tilts them apart;
 *  6. glyphs the winning angle leaves off every line, voted on their own — a
 *     level heading over a skewed body is refused, not rotated;
 *  7. long rules (a form's lines) voted on their own — rules that disagree
 *     with the text win, and the page is refused;
 *  8. act only when 0.3° ≤ |θ| ≤ 15°, the vote is sharp and backed by lines.
 *
 * Pure: plain arrays in and out, no DOM, no engine. The app glue
 * (`dewarp-stage.ts`) and the bench (`scripts/bench/straighten`) call the
 * same {@link planStraighten}; the one import is the engine's own text
 * measurement, so the judge measures straightness the way the A/B does.
 */

import { measureSurface, type StraightnessStats } from "./dewarp/semantic.ts";

// The engine's own rule for putting canonical positions onto the scaled copy
// the small pages are warped from — re-exported so a caller that has only this
// module (the engine chunk failed to load, the latch is closed) still renders
// B₀ and B′ exactly as the stage does.
export { copyScale, quadOnScaledCopy } from "./dewarp/sampler.ts";

/* ── Types (structural) ────────────────────────────────────────────────── */

export interface DeskewImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

export interface DeskewPoint {
  x: number;
  y: number;
}

/** Same corner names and order as `NormalizedQuad` / `DewarpQuad`. */
export interface DeskewQuad {
  topLeft: DeskewPoint;
  topRight: DeskewPoint;
  bottomRight: DeskewPoint;
  bottomLeft: DeskewPoint;
}

/* ── Policy constants ──────────────────────────────────────────────────── */

/** See `deskew-policy.ts`: cached answers are keyed on it. */
export { DESKEW_POLICY_VERSION } from "./deskew-policy.ts";
import { DESKEW_POLICY_VERSION } from "./deskew-policy.ts";

/** How the uncovered corners are handled. */
export type DeskewWedgeMode = "paper" | "crop";
/**
 * `"paper"` (approved): the page keeps its own scale and the wedges are
 * painted. `"crop"` zooms to the inscribed rectangle — it cut print at the
 * frame edge on 53 bench pages, so it stays a comparison switch only.
 */
export const DESKEW_WEDGE_MODE: DeskewWedgeMode = "paper";

/** Below this the rotation is not worth a resample, nor visible. */
export const DESKEW_MIN_DEG = 0.3;
/** Above this it is not print skew any more — a wrong outline, or a photo. */
export const DESKEW_MAX_DEG = 15;
/**
 * The estimator's own tolerance at the upper bound, so a page printed at
 * exactly 15° and measured at 15.04° is not refused on rounding.
 */
const MAX_DEG_TOLERANCE = 0.25;

/** Long edge the estimate runs at. */
export const DESKEW_LONG_EDGE = 700;
/** Coarse vote range (a little past the act range, so a 15° peak is interior). */
export const COARSE_RANGE_DEG = 17;
const COARSE_STEP_DEG = 0.25;
/** Refine window and step around the coarse vote. */
export const REFINE_RANGE_DEG = 1;
export const REFINE_STEP_DEG = 0.05;

/** Glyph-sized components needed before the page counts as text at all. */
export const MIN_COMPONENTS = 40;
/** Separate text lines needed at the voted angle. */
export const MIN_LINES = 4;
/** Coarse vote energy at the peak over its median across angles. */
export const MIN_PEAK_RATIO = 1.6;
/** Share of the ink in non-glyph components above which the page is a graphic. */
export const MAX_GRAPHIC_INK_SHARE = 0.55;
/** A rival coarse peak this far away and this strong makes the page ambiguous. */
const RIVAL_MIN_SEPARATION_DEG = 2;
const RIVAL_MAX_RATIO = 0.92;
/** The refine must land within this of the vote, or the two disagree. */
const MAX_REFINE_DISAGREEMENT_DEG = 0.6;
/** Search window and step for each half-page estimate, around the whole-page one. */
const HALF_RANGE_DEG = 3;
const HALF_STEP_DEG = 0.1;
/** Glyph pixels each half needs for its estimate to count. */
const HALF_MIN_PIXELS = 200;
/**
 * Left and right halves of skewed print agree; a bowed page's disagree by
 * about four sagittas over the width. Past this spread the page is curved,
 * and a rotation is not its fix.
 */
export const MAX_HALF_SPREAD_DEG = 3;
/** …and the whole-page answer must sit near the halves' mean. */
export const MAX_HALF_MIDPOINT_OFFSET_DEG = 0.75;

/**
 * Mixed orientation: glyphs off every line at the winning angle, voted on
 * their own. They are a separate block of print (a level heading over a
 * skewed body, a stamp) when there are enough of them, they line up at an
 * angle this far from the page's, and their lines are real lines.
 */
const MIXED_MIN_ORPHANS = 20;
const MIXED_MIN_ORPHAN_SHARE = 0.05;
export const MIXED_MIN_SEPARATION_DEG = 1.5;
/** Σn²/Σn of the orphans' own vote: the mean size of the line an orphan sits on. */
const MIXED_MIN_LINE_SIZE = 8;

/** Rules (a form's lines) that disagree with the text by more than this win. */
export const RULES_MAX_DISAGREEMENT_DEG = 0.6;
/** A rule is a run of ink at least this long (fraction of the page width). */
const RULES_MIN_RUN_FRACTION = 0.15;
/** A rules vote this sharp (peak energy over its energy ±2° away) is a real set of rules. */
const RULES_MIN_SHARPNESS = 3;

export type DeskewReason =
  | "act"
  | "too-small"
  | "sparse"
  | "graphic"
  | "sideways"
  | "few-lines"
  | "low-confidence"
  | "ambiguous"
  | "disagreement"
  | "negligible"
  | "curved"
  | "mixed"
  | "rules-disagree"
  | "out-of-range";

export interface SkewEstimate {
  /** Degrees, + = text lines descend to the right (y down). NaN when unknown. */
  deg: number;
  /** Whether a deskew should be applied. */
  act: boolean;
  reason: DeskewReason;
  /** Coarse vote peak energy / median energy over all angles. */
  peakRatio: number;
  /** Distinct text lines at the voted angle. */
  lineCount: number;
  /** Glyph-sized components found. */
  components: number;
  /** The coarse vote's own answer, before the refine. */
  coarseDeg: number;
  /** Share of the ink in components too big to be glyphs (rules and grids excepted). */
  graphicInkShare: number;
  /** Left-ink-half and right-ink-half estimates, when the refine ran. */
  halves?: [number, number];
  /** The orphans' own angle, when enough of them lined up (see "mixed"). */
  orphanDeg?: number;
  /** The rules' own angle, when the page has rules (see "rules-disagree"). */
  rulesDeg?: number;
}

/* ── Small image helpers ───────────────────────────────────────────────── */

interface Gray {
  width: number;
  height: number;
  data: Float32Array;
}

const lumOf = (data: Uint8ClampedArray, offset: number): number =>
  data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114;

/** Box-filtered downscale to a long edge, straight to luminance (0–255). */
function grayAt(image: DeskewImage, longEdge: number): Gray {
  const scale = Math.min(1, longEdge / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const data = new Float32Array(width * height);
  const sx = image.width / width;
  const sy = image.height / height;
  const src = image.data;
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.min(image.height, Math.floor((y + 1) * sy)));
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.min(image.width, Math.floor((x + 1) * sx)));
      let sum = 0;
      for (let yy = y0; yy < y1; yy += 1) {
        let offset = (yy * image.width + x0) * 4;
        for (let xx = x0; xx < x1; xx += 1) {
          sum += lumOf(src, offset);
          offset += 4;
        }
      }
      data[y * width + x] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
  return { width, height, data };
}

/** Mean over a (2r+1)² box, clamped at the borders, via an integral image. */
function boxMean(values: Float32Array, width: number, height: number, radius: number): Float32Array {
  const stride = width + 1;
  const integral = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let row = 0;
    for (let x = 0; x < width; x += 1) {
      row += values[y * width + x];
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + row;
    }
  }
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height, y + radius + 1);
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width, x + radius + 1);
      const sum =
        integral[y1 * stride + x1] -
        integral[y0 * stride + x1] -
        integral[y1 * stride + x0] +
        integral[y0 * stride + x0];
      out[y * width + x] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

function quantileOf(values: Float32Array, q: number): number {
  const bins = new Uint32Array(256);
  for (let i = 0; i < values.length; i += 1) {
    bins[Math.max(0, Math.min(255, Math.round(values[i])))] += 1;
  }
  const target = values.length * q;
  let seen = 0;
  for (let bin = 0; bin < 256; bin += 1) {
    seen += bins[bin];
    if (seen >= target) return bin;
  }
  return 255;
}

function medianOf(values: ArrayLike<number>): number {
  if (values.length === 0) return 0;
  const sorted = Array.from(values).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/* ── Ink and components ───────────────────────────────────────────────── */

interface InkMap {
  width: number;
  height: number;
  mask: Uint8Array;
}

/**
 * Local-contrast ink on paper. Large dark regions (a table wedge in a loose
 * outline, a photo) are excluded with a margin, and so is a thin frame inset,
 * so the page's own edge never reads as a line of text.
 */
function inkMap(gray: Gray): InkMap {
  const { width, height, data } = gray;
  const long = Math.max(width, height);
  const paper = quantileOf(data, 0.9);
  const local = boxMean(data, width, height, Math.max(2, Math.round(long / 40)));
  const dark = new Float32Array(width * height);
  for (let i = 0; i < dark.length; i += 1) dark[i] = data[i] < 0.5 * paper ? 1 : 0;
  const reach = Math.max(2, Math.round(long / 60));
  const density = boxMean(dark, width, height, reach);
  const core = new Float32Array(width * height);
  for (let i = 0; i < core.length; i += 1) core[i] = density[i] > 0.6 ? 1 : 0;
  const nearCore = boxMean(core, width, height, reach);
  const mask = new Uint8Array(width * height);
  const insetX = Math.max(1, Math.round(0.015 * width));
  const insetY = Math.max(1, Math.round(0.015 * height));
  for (let y = insetY; y < height - insetY; y += 1) {
    for (let x = insetX; x < width - insetX; x += 1) {
      const i = y * width + x;
      if (data[i] < 0.8 * local[i] && local[i] > 0.45 * paper && nearCore[i] === 0) {
        mask[i] = 1;
      }
    }
  }
  return { width, height, mask };
}

interface Blob {
  cx: number;
  cy: number;
  width: number;
  height: number;
  /** Indices of its pixels in the ink map. */
  pixels: Int32Array;
}

function labelBlobs(ink: InkMap): Blob[] {
  const { width, height, mask } = ink;
  const seen = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  const blobs: Blob[] = [];
  for (let seed = 0; seed < mask.length; seed += 1) {
    if (mask[seed] === 0 || seen[seed] === 1) continue;
    let top = 0;
    stack[top++] = seed;
    seen[seed] = 1;
    const pixels: number[] = [];
    let sx = 0;
    let sy = 0;
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;
    while (top > 0) {
      const index = stack[--top];
      pixels.push(index);
      const y = (index / width) | 0;
      const x = index - y * width;
      sx += x;
      sy += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const n = ny * width + nx;
          if (mask[n] === 0 || seen[n] === 1) continue;
          seen[n] = 1;
          stack[top++] = n;
        }
      }
    }
    blobs.push({
      cx: sx / pixels.length,
      cy: sy / pixels.length,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
      pixels: Int32Array.from(pixels),
    });
  }
  return blobs;
}

/** Glyphs, graphics and rules of one small page — what every vote reads. */
interface Glyphs {
  width: number;
  height: number;
  glyphs: Blob[];
  /** Long thin non-glyph components: rules, a table's grid. */
  rules: Blob[];
  graphicInkShare: number;
  plausible: number;
}

function glyphsOf(image: DeskewImage): Glyphs {
  const gray = grayAt(image, DESKEW_LONG_EDGE);
  const blobs = labelBlobs(inkMap(gray));
  const { width, height } = gray;
  const long = Math.max(width, height);
  // The typical glyph size is taken from the components that could plausibly
  // be letters before the outliers are cut.
  const plausible = blobs.filter((b) => b.pixels.length >= 3 && b.height <= 0.08 * height);
  const typical = Math.max(2, medianOf(plausible.map((b) => Math.min(b.height, b.width))));
  let inkTotal = 0;
  let inkGraphic = 0;
  const glyphs: Blob[] = [];
  const rules: Blob[] = [];
  for (const b of blobs) {
    inkTotal += b.pixels.length;
    const glyphLike =
      b.pixels.length >= 3 &&
      b.height <= 4 * typical + 0.3 * b.width &&
      b.height <= 0.3 * height &&
      b.width <= 0.6 * width;
    if (glyphLike) {
      glyphs.push(b);
      continue;
    }
    const span = Math.max(b.width, b.height);
    const lineArt =
      span >= 0.25 * long &&
      (b.pixels.length <= 0.25 * b.width * b.height || b.pixels.length <= 3 * typical * span);
    // Rules and a table's grid are line art, not a picture: a ruled form is
    // still a page of text.
    if (lineArt) rules.push(b);
    else inkGraphic += b.pixels.length;
  }
  return {
    width,
    height,
    glyphs,
    rules,
    graphicInkShare: inkTotal === 0 ? 1 : inkGraphic / inkTotal,
    plausible: plausible.length,
  };
}

/* ── Projection energies ──────────────────────────────────────────────── */

/**
 * Σ bin² of the points projected onto the normal of direction `deg`,
 * linearly splatted into bins of `binSize`. Coordinates are centred.
 */
function projectionEnergy(
  xs: Float64Array,
  ys: Float64Array,
  deg: number,
  binSize: number,
  span: number,
  bins: Float64Array,
): number {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  bins.fill(0);
  const offset = span / binSize + 1;
  for (let i = 0; i < xs.length; i += 1) {
    // Distance along the normal of a line whose direction is (cos t, sin t).
    const r = (ys[i] * c - xs[i] * s) / binSize + offset;
    const b = Math.floor(r);
    const f = r - b;
    if (b >= 0 && b + 1 < bins.length) {
      bins[b] += 1 - f;
      bins[b + 1] += f;
    }
  }
  let energy = 0;
  for (let i = 0; i < bins.length; i += 1) energy += bins[i] * bins[i];
  return energy;
}

/**
 * Where a sampled peak is centred, in fractional sample indices.
 *
 * The projection energy of level text has a *plateau* a few tenths of a
 * degree wide (below that the tilt moves no pixel across a bin), so the
 * arg-max of the samples is noise. The flanks are not: the midpoint between
 * the two crossings of 80–95 % of the peak, averaged over those levels, is
 * the peak's centre. A three-point parabola is the fallback when the peak is
 * too narrow or too close to the window's edge for the flanks to be read.
 */
function peakCentre(values: number[]): number {
  let top = 0;
  for (let i = 1; i < values.length; i += 1) if (values[i] > values[top]) top = i;
  const peak = values[top];
  const mids: number[] = [];
  for (const level of [0.8, 0.85, 0.9, 0.95]) {
    const cut = level * peak;
    let left = NaN;
    for (let i = top; i > 0; i -= 1) {
      if (values[i - 1] < cut) {
        left = i - 1 + (cut - values[i - 1]) / (values[i] - values[i - 1]);
        break;
      }
    }
    let right = NaN;
    for (let i = top; i < values.length - 1; i += 1) {
      if (values[i + 1] < cut) {
        right = i + (values[i] - cut) / (values[i] - values[i + 1]);
        break;
      }
    }
    if (Number.isFinite(left) && Number.isFinite(right)) mids.push((left + right) / 2);
  }
  if (mids.length > 0) return mids.reduce((a, b) => a + b, 0) / mids.length;
  if (top > 0 && top < values.length - 1) {
    const den = values[top - 1] - 2 * values[top] + values[top + 1];
    if (den < 0) return top + (0.5 * (values[top - 1] - values[top + 1])) / den;
  }
  return top;
}

/** Light smoothing, so a line split across two bins is one peak. */
function smoothBins(bins: Float64Array): Float64Array {
  const smooth = new Float64Array(bins.length);
  for (let i = 0; i < bins.length; i += 1) {
    smooth[i] = 0.25 * (bins[i - 1] ?? 0) + 0.5 * bins[i] + 0.25 * (bins[i + 1] ?? 0);
  }
  return smooth;
}

/** Separated peaks of a smoothed histogram — one per text line. */
function linePeaks(smooth: Float64Array, minSeparation: number, minMass: number): number[] {
  let max = 0;
  for (const v of smooth) if (v > max) max = v;
  const floor = Math.max(minMass, 0.15 * max);
  const peaks: number[] = [];
  let lastPeak = -Infinity;
  for (let i = 1; i < smooth.length - 1; i += 1) {
    const v = smooth[i];
    if (v < floor || v < smooth[i - 1] || v < smooth[i + 1]) continue;
    if (i - lastPeak < minSeparation) continue;
    peaks.push(i);
    lastPeak = i;
  }
  return peaks;
}

/** A coarse vote over ±{@link COARSE_RANGE_DEG}° about `centre`. */
interface Vote {
  angles: number[];
  energies: number[];
  best: number;
  deg: number;
  peakRatio: number;
}

function coarseVote(
  xs: Float64Array,
  ys: Float64Array,
  centre: number,
  binSize: number,
  span: number,
  bins: Float64Array,
): Vote {
  const angles: number[] = [];
  const energies: number[] = [];
  for (let a = -COARSE_RANGE_DEG; a <= COARSE_RANGE_DEG + 1e-9; a += COARSE_STEP_DEG) {
    angles.push(centre + a);
    energies.push(projectionEnergy(xs, ys, centre + a, binSize, span, bins));
  }
  let best = 0;
  for (let i = 1; i < energies.length; i += 1) if (energies[i] > energies[best]) best = i;
  return {
    angles,
    energies,
    best,
    deg: angles[best],
    peakRatio: energies[best] / Math.max(1e-9, medianOf(energies)),
  };
}

/** Refined peak of `xs, ys` (1 px bins) within ±range of `around`. */
function refineAround(
  xs: Float64Array,
  ys: Float64Array,
  around: number,
  range: number,
  step: number,
  span: number,
  bins: Float64Array,
): number {
  const steps = Math.round(range / step);
  const values: number[] = [];
  for (let i = -steps; i <= steps; i += 1) {
    values.push(projectionEnergy(xs, ys, around + i * step, 1, span, bins));
  }
  return around + (peakCentre(values) - steps) * step;
}

/* ── The estimator ────────────────────────────────────────────────────── */

function abstain(reason: DeskewReason, partial: Partial<SkewEstimate> = {}): SkewEstimate {
  return {
    deg: NaN,
    act: false,
    reason,
    peakRatio: 0,
    lineCount: 0,
    components: 0,
    coarseDeg: NaN,
    graphicInkShare: 0,
    ...partial,
  };
}

/** The estimate, and the glyph-pixel sample it was made from (for the judge). */
interface DetailedEstimate {
  estimate: SkewEstimate;
  /** Glyph pixels, centred on the small page, in its pixels. */
  sample: { xs: Float64Array; ys: Float64Array; width: number; height: number } | null;
}

function pixelSample(g: Glyphs, blobs: Blob[], limit: number): { xs: Float64Array; ys: Float64Array } {
  const cx = (g.width - 1) / 2;
  const cy = (g.height - 1) / 2;
  let total = 0;
  for (const b of blobs) total += b.pixels.length;
  const stride = Math.max(1, Math.ceil(total / limit));
  const px: number[] = [];
  const py: number[] = [];
  let k = 0;
  for (const b of blobs) {
    for (let j = 0; j < b.pixels.length; j += 1) {
      if (k++ % stride !== 0) continue;
      const index = b.pixels[j];
      const y = (index / g.width) | 0;
      px.push(index - y * g.width - cx);
      py.push(y - cy);
    }
  }
  return { xs: Float64Array.from(px), ys: Float64Array.from(py) };
}

/**
 * Orphans: glyphs the page's own lines at `deg` leave out, voted on their
 * own. Answers their angle and how much of a text block they are, or null
 * when there are too few of them to be one.
 */
function orphanVote(
  gx: Float64Array,
  gy: Float64Array,
  deg: number,
  bin: number,
  span: number,
  bins: Float64Array,
): { deg: number; peakRatio: number; lineSize: number; lines: number; count: number } | null {
  projectionEnergy(gx, gy, deg, bin, span, bins);
  const smooth = smoothBins(bins);
  const peaks = linePeaks(smooth, 3, 3);
  if (peaks.length === 0) return null;
  const cut = 0.25 * medianOf(peaks.map((p) => smooth[p]));
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const offset = span / bin + 1;
  const ox: number[] = [];
  const oy: number[] = [];
  for (let i = 0; i < gx.length; i += 1) {
    const r = (gy[i] * c - gx[i] * s) / bin + offset;
    const b = Math.floor(r);
    const here = Math.max(smooth[b] ?? 0, smooth[b + 1] ?? 0);
    if (here < cut) {
      ox.push(gx[i]);
      oy.push(gy[i]);
    }
  }
  const count = ox.length;
  if (count < Math.max(MIXED_MIN_ORPHANS, MIXED_MIN_ORPHAN_SHARE * gx.length)) return null;
  const xs = Float64Array.from(ox);
  const ys = Float64Array.from(oy);
  const vote = coarseVote(xs, ys, 0, bin, span, bins);
  projectionEnergy(xs, ys, vote.deg, bin, span, bins);
  const lines = linePeaks(smoothBins(bins), 3, 3).length;
  return {
    deg: vote.deg,
    peakRatio: vote.peakRatio,
    lineSize: vote.energies[vote.best] / count,
    lines,
    count,
  };
}

/**
 * The pixels of a component that lie on a long, nearly horizontal run — the
 * rule itself, without the glyphs of handwriting that cross it and merge
 * with it. A run may step one row per column (up to 45°), so a tilted rule
 * keeps its length; a word's letters, even merged, never reach `length`.
 */
function longRunPixels(b: Blob, width: number, length: number): number[] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let j = 0; j < b.pixels.length; j += 1) {
    const y = (b.pixels[j] / width) | 0;
    const x = b.pixels[j] - y * width;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  if (bw < length) return [];
  const mask = new Uint8Array(bw * bh);
  for (let j = 0; j < b.pixels.length; j += 1) {
    const y = (b.pixels[j] / width) | 0;
    const x = b.pixels[j] - y * width;
    mask[(y - minY) * bw + (x - minX)] = 1;
  }
  // Longest run reaching each pixel from the left, and leaving it to the right.
  const left = new Uint16Array(bw * bh);
  const right = new Uint16Array(bw * bh);
  const best = (runs: Uint16Array, x: number, y: number): number => {
    let m = 0;
    for (let dy = -1; dy <= 1; dy += 1) {
      const yy = y + dy;
      if (yy >= 0 && yy < bh) m = Math.max(m, runs[yy * bw + x]);
    }
    return m;
  };
  for (let x = 0; x < bw; x += 1) {
    for (let y = 0; y < bh; y += 1) {
      if (mask[y * bw + x] === 1) left[y * bw + x] = 1 + (x > 0 ? best(left, x - 1, y) : 0);
    }
  }
  for (let x = bw - 1; x >= 0; x -= 1) {
    for (let y = 0; y < bh; y += 1) {
      if (mask[y * bw + x] === 1) right[y * bw + x] = 1 + (x < bw - 1 ? best(right, x + 1, y) : 0);
    }
  }
  const out: number[] = [];
  for (let y = 0; y < bh; y += 1) {
    for (let x = 0; x < bw; x += 1) {
      const i = y * bw + x;
      if (mask[i] === 1 && left[i] + right[i] - 1 >= length) out.push((y + minY) * width + x + minX);
    }
  }
  return out;
}

/** The rules' own angle, or NaN when the page has no clear rules. */
function rulesAngle(g: Glyphs, span: number): number {
  if (g.rules.length === 0) return NaN;
  const length = Math.max(12, Math.round(RULES_MIN_RUN_FRACTION * g.width));
  const runs: Blob[] = [];
  let pixels = 0;
  for (const b of g.rules) {
    const on = longRunPixels(b, g.width, length);
    if (on.length === 0) continue;
    pixels += on.length;
    runs.push({ ...b, pixels: Int32Array.from(on) });
  }
  if (pixels < 0.3 * g.width) return NaN;
  const { xs, ys } = pixelSample(g, runs, 30_000);
  const bins = new Float64Array(Math.ceil(2 * span) + 4);
  const vote = coarseVote(xs, ys, 0, 1, span, bins);
  // Sharpness, not height over the median: a ruled page's rules are dense
  // enough to lift the median itself. Straight rules lose most of their
  // energy two degrees off; a heap of line art does not.
  const off =
    0.5 *
    (projectionEnergy(xs, ys, vote.deg - 2, 1, span, bins) + projectionEnergy(xs, ys, vote.deg + 2, 1, span, bins));
  if (vote.energies[vote.best] < RULES_MIN_SHARPNESS * off) return NaN;
  return refineAround(xs, ys, vote.deg, 0.5, REFINE_STEP_DEG, span, bins);
}

function estimateDetailed(image: DeskewImage): DetailedEstimate {
  const none = (estimate: SkewEstimate): DetailedEstimate => ({ estimate, sample: null });
  if (Math.min(image.width, image.height) < 64) return none(abstain("too-small"));
  const g = glyphsOf(image);
  const { width, height, glyphs, graphicInkShare } = g;
  if (g.plausible < MIN_COMPONENTS || glyphs.length < MIN_COMPONENTS) {
    return none(abstain("sparse", { components: Math.min(g.plausible, glyphs.length), graphicInkShare }));
  }
  if (graphicInkShare > MAX_GRAPHIC_INK_SHARE) {
    return none(abstain("graphic", { components: glyphs.length, graphicInkShare }));
  }

  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const span = Math.hypot(width, height) / 2 + 2;

  // Coarse: centroid projection energy over angles.
  const n = glyphs.length;
  const gx = new Float64Array(n);
  const gy = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    gx[i] = glyphs[i].cx - cx;
    gy[i] = glyphs[i].cy - cy;
  }
  // Fixed bins, not glyph-relative: a rotated word's own box says nothing
  // about the line height it sits on.
  const coarseBin = Math.max(1, Math.max(width, height) / 350);
  const coarseBins = new Float64Array(Math.ceil((2 * span) / coarseBin) + 4);
  const vote = coarseVote(gx, gy, 0, coarseBin, span, coarseBins);
  const { energies, angles, best } = vote;
  const coarseDeg = vote.deg;
  const peakRatio = vote.peakRatio;
  // A page lying on its side: its lines run a quarter turn away, and a few
  // degrees of "tilt" found near 0° would be noise between columns.
  const sideways = coarseVote(gx, gy, 90, coarseBin, span, coarseBins);
  // A rival: the strongest local maximum well away from the peak.
  let rival = 0;
  for (let i = 1; i < energies.length - 1; i += 1) {
    if (Math.abs(angles[i] - coarseDeg) < RIVAL_MIN_SEPARATION_DEG) continue;
    if (energies[i] >= energies[i - 1] && energies[i] >= energies[i + 1]) {
      rival = Math.max(rival, energies[i]);
    }
  }
  projectionEnergy(gx, gy, coarseDeg, coarseBin, span, coarseBins);
  const lineCount = linePeaks(smoothBins(coarseBins), 3, 3).length;

  const partial = { peakRatio, lineCount, components: n, coarseDeg, graphicInkShare };
  // Sharper, not merely stronger: a form's columns line glyphs up vertically
  // too, and on a dense table their raw energy can edge past the rows'; a
  // page on its side has no rows to speak of at all.
  if (sideways.peakRatio > peakRatio) return none(abstain("sideways", partial));
  if (lineCount < MIN_LINES) return none(abstain("few-lines", partial));
  if (peakRatio < MIN_PEAK_RATIO) return none(abstain("low-confidence", partial));
  if (rival > RIVAL_MAX_RATIO * energies[best]) return none(abstain("ambiguous", partial));

  // Refine: glyph pixels, 1 px bins, ±1° in 0.05° steps.
  const { xs: fx, ys: fy } = pixelSample(g, glyphs, 120_000);
  const fineBins = new Float64Array(Math.ceil(2 * span) + 4);
  const deg = refineAround(fx, fy, coarseDeg, REFINE_RANGE_DEG, REFINE_STEP_DEG, span, fineBins);
  const sample = { xs: fx, ys: fy, width, height };

  // The two halves of the *ink*, each on its own — split at the ink's own
  // median, not the page's centre, so a single column off to one side still
  // has two halves to compare. Skewed print tilts both the same way; a bowed
  // page (curl) tilts them apart, and there a single rotation is not the fix.
  const sortedX = Float64Array.from(fx).sort();
  const splitX = sortedX[sortedX.length >> 1] ?? 0;
  const halves: [number, number] = [NaN, NaN];
  for (const side of [0, 1] as const) {
    const hx: number[] = [];
    const hy: number[] = [];
    for (let i = 0; i < fx.length; i += 1) {
      if ((fx[i] < splitX) === (side === 0)) {
        hx.push(fx[i]);
        hy.push(fy[i]);
      }
    }
    if (hx.length < HALF_MIN_PIXELS) continue;
    halves[side] = refineAround(
      Float64Array.from(hx),
      Float64Array.from(hy),
      deg,
      HALF_RANGE_DEG,
      HALF_STEP_DEG,
      span,
      fineBins,
    );
  }
  const result = { ...partial, deg, halves };
  const detailed = (estimate: SkewEstimate): DetailedEstimate => ({ estimate, sample });
  if (Math.abs(deg - coarseDeg) > MAX_REFINE_DISAGREEMENT_DEG) {
    return detailed({ ...abstain("disagreement", result), deg });
  }
  // A half that could not be measured is not evidence of a flat page: the
  // curvature veto fails closed.
  const spread = Math.abs(halves[0] - halves[1]);
  const midpoint = (halves[0] + halves[1]) / 2;
  if (
    !Number.isFinite(spread) ||
    spread > MAX_HALF_SPREAD_DEG ||
    Math.abs(midpoint - deg) > MAX_HALF_MIDPOINT_OFFSET_DEG
  ) {
    return detailed({ ...abstain("curved", result), deg });
  }
  const magnitude = Math.abs(deg);
  if (magnitude > DESKEW_MAX_DEG + MAX_DEG_TOLERANCE) {
    return detailed({ ...abstain("out-of-range", result), deg });
  }
  if (magnitude < DESKEW_MIN_DEG) return detailed({ ...abstain("negligible", result), deg });

  // A second block of print at its own angle (a level heading over a skewed
  // body): rotating the page would level one and tilt the other.
  const orphans = orphanVote(gx, gy, coarseDeg, coarseBin, span, coarseBins);
  if (
    orphans !== null &&
    Math.abs(orphans.deg - deg) >= MIXED_MIN_SEPARATION_DEG &&
    orphans.peakRatio >= MIN_PEAK_RATIO &&
    orphans.lineSize >= MIXED_MIN_LINE_SIZE &&
    orphans.lines >= 2
  ) {
    return detailed({ ...abstain("mixed", result), deg, orphanDeg: orphans.deg });
  }
  // A form's rules are the page's own horizontal. Handwriting sloping across
  // level rules is not a skewed page.
  const rulesDeg = rulesAngle(g, span);
  if (Number.isFinite(rulesDeg) && Math.abs(rulesDeg - deg) > RULES_MAX_DISAGREEMENT_DEG) {
    return detailed({ ...abstain("rules-disagree", result), deg, rulesDeg });
  }
  return detailed({
    ...result,
    ...(Number.isFinite(rulesDeg) ? { rulesDeg } : {}),
    act: true,
    reason: "act",
  });
}

/**
 * The skew of the print on a flat page.
 *
 * `image` is the homography output (any size; it is reduced to
 * {@link DESKEW_LONG_EDGE}). Never throws; an abstention says why.
 */
export function estimateSkew(image: DeskewImage): SkewEstimate {
  return estimateDetailed(image).estimate;
}

/**
 * The lean left on a page that should now be level: the estimator's own
 * vote and refine, without its abstentions. NaN when the page has too little
 * print to say.
 */
export function residualLean(image: DeskewImage): number {
  if (Math.min(image.width, image.height) < 64) return NaN;
  const g = glyphsOf(image);
  if (g.glyphs.length < MIN_COMPONENTS) return NaN;
  const cx = (g.width - 1) / 2;
  const cy = (g.height - 1) / 2;
  const span = Math.hypot(g.width, g.height) / 2 + 2;
  const gx = Float64Array.from(g.glyphs, (b) => b.cx - cx);
  const gy = Float64Array.from(g.glyphs, (b) => b.cy - cy);
  const coarseBin = Math.max(1, Math.max(g.width, g.height) / 350);
  const vote = coarseVote(gx, gy, 0, coarseBin, span, new Float64Array(Math.ceil((2 * span) / coarseBin) + 4));
  const { xs, ys } = pixelSample(g, g.glyphs, 60_000);
  return refineAround(xs, ys, vote.deg, REFINE_RANGE_DEG, REFINE_STEP_DEG, span, new Float64Array(Math.ceil(2 * span) + 4));
}

/* ── Geometry: the rotation, composed with the outline ────────────────── */

type H3 = Float64Array;

function solve8(a: number[][], b: number[]): number[] {
  const n = 8;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c += 1) {
    let p = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    const pivot = m[c][c];
    if (Math.abs(pivot) < 1e-12) throw new Error("degenerate quad");
    for (let r = 0; r < n; r += 1) {
      if (r === c) continue;
      const f = m[r][c] / pivot;
      if (f === 0) continue;
      for (let k = c; k <= n; k += 1) m[r][k] -= f * m[c][k];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}

/** Homography taking `src[i]` to `dst[i]` (four pairs). */
export function homographyFrom(src: DeskewPoint[], dst: DeskewPoint[]): H3 {
  const a: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  return Float64Array.from([...solve8(a, b), 1]);
}

export function applyHomography(h: H3, p: DeskewPoint): DeskewPoint {
  const w = h[6] * p.x + h[7] * p.y + h[8];
  return { x: (h[0] * p.x + h[1] * p.y + h[2]) / w, y: (h[3] * p.x + h[4] * p.y + h[5]) / w };
}

const CORNERS = ["topLeft", "topRight", "bottomRight", "bottomLeft"] as const;

function quadPoints(quad: DeskewQuad): DeskewPoint[] {
  return CORNERS.map((key) => quad[key]);
}

function toQuad(points: DeskewPoint[]): DeskewQuad {
  return { topLeft: points[0], topRight: points[1], bottomRight: points[2], bottomLeft: points[3] };
}

/**
 * Largest scale of a W×H rectangle, rotated by `deg` about its centre, that
 * still fits inside the unrotated one — the crop-to-inscribed factor.
 */
export function inscribedScale(width: number, height: number, deg: number): number {
  const t = (Math.abs(deg) * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return Math.min(width / (width * c + height * s), height / (width * s + height * c));
}

/**
 * The outline Q′ that renders "the page of Q, rotated by `deg` about its
 * centre" in one warp, and where the original page and the photo land in
 * that output (fractions 0–1, clockwise from the top-left).
 *
 * `quad` is the confirmed outline in canonical pixels; `outputWidth/Height`
 * the flat page's dimensions (scanic's rectangle: the quad maps onto
 * (0,0)…(w−1,h−1)). In `"paper"` mode the page keeps its own scale, even where
 * Q′ reaches past the photo (an outline on the photo's own edges, a gallery
 * import): scanic clamps there — the photo's edge row smeared outward — and
 * {@link DeskewPlan.photoInOutput} marks it so the fill always paints it.
 */
export function deskewQuad(input: {
  quad: DeskewQuad;
  outputWidth: number;
  outputHeight: number;
  canonicalWidth: number;
  canonicalHeight: number;
  deg: number;
  mode?: DeskewWedgeMode;
}): {
  quad: DeskewQuad;
  scale: number;
  pageInOutput: DeskewPoint[];
  photoInOutput: DeskewPoint[] | null;
} {
  const { outputWidth: w, outputHeight: h, deg } = input;
  const mode = input.mode ?? DESKEW_WEDGE_MODE;
  const rect: DeskewPoint[] = [
    { x: 0, y: 0 },
    { x: w - 1, y: 0 },
    { x: w - 1, y: h - 1 },
    { x: 0, y: h - 1 },
  ];
  const toCanonical = homographyFrom(rect, quadPoints(input.quad));
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  // Output point p samples flat point c + scale·R(θ)(p − c): a line of
  // direction (cos θ, sin θ) in the flat page comes out horizontal.
  const scale = mode === "crop" ? inscribedScale(w, h, deg) : 1;
  const points = rect.map((p) => {
    const dx = (p.x - cx) * scale;
    const dy = (p.y - cy) * scale;
    return applyHomography(toCanonical, { x: cx + c * dx - s * dy, y: cy + s * dx + c * dy });
  });
  const inside = points.every(
    (p) =>
      p.x >= -0.5 && p.y >= -0.5 && p.x <= input.canonicalWidth - 0.5 && p.y <= input.canonicalHeight - 0.5,
  );
  let photoInOutput: DeskewPoint[] | null = null;
  if (!inside) {
    const toOutput = homographyFrom(points, rect);
    const mapped = [
      { x: 0, y: 0 },
      { x: input.canonicalWidth - 1, y: 0 },
      { x: input.canonicalWidth - 1, y: input.canonicalHeight - 1 },
      { x: 0, y: input.canonicalHeight - 1 },
    ].map((p) => {
      const o = applyHomography(toOutput, p);
      return { x: o.x / Math.max(1, w - 1), y: o.y / Math.max(1, h - 1) };
    });
    photoInOutput = mapped.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)) ? mapped : null;
  }
  // The original page rectangle, seen from the output: p = c + R(−θ)(f − c)/scale.
  const pageInOutput = rect.map((f) => {
    const dx = f.x - cx;
    const dy = f.y - cy;
    const ox = cx + (c * dx + s * dy) / scale;
    const oy = cy + (-s * dx + c * dy) / scale;
    return { x: ox / Math.max(1, w - 1), y: oy / Math.max(1, h - 1) };
  });
  return { quad: toQuad(points), scale, pageInOutput, photoInOutput };
}

/**
 * The flat page's size for an outline — scanic's and the engine's rule (the
 * longer of each opposite pair of sides), restated so the step can run
 * without loading either.
 */
export function flatPageDims(quad: DeskewQuad): { width: number; height: number } {
  const d = (a: DeskewPoint, b: DeskewPoint): number => Math.hypot(a.x - b.x, a.y - b.y);
  return {
    width: Math.max(1, Math.round(Math.max(d(quad.bottomRight, quad.bottomLeft), d(quad.topRight, quad.topLeft)))),
    height: Math.max(1, Math.round(Math.max(d(quad.topRight, quad.bottomRight), d(quad.topLeft, quad.bottomLeft)))),
  };
}

/* ── The plan ─────────────────────────────────────────────────────────── */

/**
 * Whether the page, once level, still shows a curl the engine should be
 * asked about. The engine costs seconds and its guards were never meant for
 * a flat page, so a rotation that leaves straight lines is the whole answer.
 */
export interface CurlEvidence {
  evidence: boolean;
  /** |left − right| ink-half angle, degrees. */
  spread: number;
  /** |mean of the halves − whole-page angle|, degrees. */
  midOffset: number;
  /** Median line bow of the level page (the engine's own measure, fraction of height). */
  bow: number;
  /** Lines that bow was measured on. */
  bowLines: number;
  why: string[];
}

/**
 * The halves' mean off the whole page by more than this: curled (degrees).
 * Their spread alone is not evidence: a form's blocks split its halves by up
 * to a degree with no curl at all (bench: 0.4–1.0° on uncurled forms), while
 * the offset stays under 0.19° there.
 */
export const CURL_HALF_OFFSET_DEG = 0.25;
/**
 * Median bow of the level page past which it is curled (fraction of its
 * height). On the straighten bench the level pages of uncurled print measure
 * at most 0.00125 and the gentlest curl acted on 0.00156.
 */
export const CURL_BOW_FRACTION = 0.0015;
/** Lines needed before that bow counts. */
const CURL_BOW_MIN_LINES = 3;

export function curlEvidence(estimate: SkewEstimate, levelled: StraightnessStats | null): CurlEvidence {
  const halves = estimate.halves ?? [NaN, NaN];
  const spread = Math.abs(halves[0] - halves[1]);
  const midOffset = Math.abs((halves[0] + halves[1]) / 2 - estimate.deg);
  const bow = levelled?.medianCurvature ?? NaN;
  const bowLines = levelled?.lineCount ?? 0;
  const why: string[] = [];
  if (!Number.isFinite(spread)) why.push("halves-unmeasured");
  else if (midOffset > CURL_HALF_OFFSET_DEG) why.push("halves-offset");
  if (bowLines >= CURL_BOW_MIN_LINES && bow > CURL_BOW_FRACTION) why.push("bow");
  return { evidence: why.length > 0, spread, midOffset, bow, bowLines, why };
}

export interface DeskewPlan {
  /** {@link DESKEW_POLICY_VERSION} the plan was made under. */
  policyVersion: string;
  /** The rotation applied, in degrees (same sign as {@link SkewEstimate.deg}). */
  deg: number;
  /**
   * The outline that renders Q composed with the rotation, canonical pixels —
   * derived from the confirmed outline it was planned for, never stored in
   * its place.
   */
  quad: DeskewQuad;
  /** Rectangle scale actually used: 1 for full paper-fill, <1 when cropped. */
  scale: number;
  mode: DeskewWedgeMode;
  /**
   * The original flat page's rectangle as seen in the deskewed output, in
   * fractions of the output (0–1): everything outside it is a wedge.
   */
  pageInOutput: DeskewPoint[];
  /** Paper colour near each output corner (TL, TR, BR, BL): the fill's last resort. */
  cornerColors: [number, number, number][];
  /**
   * Which wedges are painted, by the page edge they lie beyond (top, right,
   * bottom, left — `pageInOutput`'s edges in order). Each wedge is the one
   * triangle between the frame and one edge of the rotated page, whichever
   * output quadrants it spans, so a wedge is painted or kept whole. It is
   * painted only when it holds *new* background — the outline matched the
   * sheet along that edge, so what rotated in is the table. When the page
   * itself continues into it (an outline inside the sheet), or the frame
   * already showed the table along that edge (a loose outline), the real
   * pixels stay.
   */
  paint: [boolean, boolean, boolean, boolean];
  /** Fill bleed as a fraction of the output's long edge ({@link DESKEW_FILL_BLEED_FRACTION}). */
  bleedFraction: number;
  /**
   * The photo's own frame as seen in the output (fractions), when Q′ reaches
   * past it: everything outside has no pixels and is always painted. Null
   * when Q′ lies inside the photo.
   */
  photoInOutput: DeskewPoint[] | null;
  /** Whether the engine should still be asked about a curl, and why. */
  curl: CurlEvidence;
}

/**
 * How far inside the original page edge the fill reaches, as a fraction of
 * the output's long edge — enough to cover the few pixels of table or shadow
 * a confirmed outline usually leaves along the sheet edge, which would
 * otherwise come out as a thin *tilted* line; far less than any print margin.
 */
export const DESKEW_FILL_BLEED_FRACTION = 0.004;

/* ── Paper colour and wedge fill ──────────────────────────────────────── */

/**
 * Paper colour near each corner of the flat page (TL, TR, BR, BL): the
 * bright, non-ink pixels of a patch just inside it. A patch that is mostly
 * not paper (a table corner in a loose outline) takes the page-wide colour.
 * Only the fill's fallback now — the fill reads the paper beside each wedge.
 */
export function paperCornerColors(image: DeskewImage): [number, number, number][] {
  const { width, height, data } = image;
  const step = Math.max(1, Math.floor(Math.max(width, height) / 400));
  const all: number[] = [];
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) all.push(lumOf(data, (y * width + x) * 4));
  }
  all.sort((a, b) => a - b);
  const paperLum = all[Math.floor(0.9 * (all.length - 1))] ?? 255;
  const meanOf = (x0: number, y0: number, x1: number, y1: number): [number, number, number] | null => {
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    let total = 0;
    for (let y = Math.max(0, y0); y < Math.min(height, y1); y += step) {
      for (let x = Math.max(0, x0); x < Math.min(width, x1); x += step) {
        const i = (y * width + x) * 4;
        total += 1;
        if (lumOf(data, i) < 0.85 * paperLum) continue;
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        n += 1;
      }
    }
    return n < Math.max(4, 0.3 * total) ? null : [r / n, g / n, b / n];
  };
  const whole = meanOf(0, 0, width, height) ?? [paperLum, paperLum, paperLum];
  const pw = Math.max(4, Math.round(0.1 * width));
  const ph = Math.max(4, Math.round(0.1 * height));
  const ix = Math.round(0.02 * width);
  const iy = Math.round(0.02 * height);
  const patches: [number, number][] = [
    [ix, iy],
    [width - ix - pw, iy],
    [width - ix - pw, height - iy - ph],
    [ix, height - iy - ph],
  ];
  return patches.map(([x, y]) => meanOf(x, y, x + pw, y + ph) ?? whole);
}

/** Whether (x, y) lies inside the convex polygon (either winding). */
function insidePolygon(poly: DeskewPoint[], x: number, y: number): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (cross === 0) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/**
 * Which edge of the convex polygon `poly` the point (x, y) lies beyond (the
 * one it is furthest beyond, near a corner), or −1 inside.
 */
export function outsideEdge(poly: DeskewPoint[], x: number, y: number): number {
  const mx = poly.reduce((a, p) => a + p.x, 0) / poly.length;
  const my = poly.reduce((a, p) => a + p.y, 0) / poly.length;
  let best = -1;
  let furthest = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const inward = ex * (my - a.y) - ey * (mx - a.x);
    const here = ex * (y - a.y) - ey * (x - a.x);
    if (inward === 0 || Math.sign(here) === Math.sign(inward) || here === 0) continue;
    const beyond = Math.abs(here) / (Math.hypot(ex, ey) || 1);
    if (beyond > furthest) {
      furthest = beyond;
      best = i;
    }
  }
  return best;
}

/** Move each vertex toward the centroid by (ex, ey) — a small inward bleed. */
export function shrinkPolygon(poly: DeskewPoint[], ex: number, ey: number): DeskewPoint[] {
  const mx = poly.reduce((a, p) => a + p.x, 0) / poly.length;
  const my = poly.reduce((a, p) => a + p.y, 0) / poly.length;
  return poly.map((p) => ({
    x: p.x + Math.sign(mx - p.x) * ex,
    y: p.y + Math.sign(my - p.y) * ey,
  }));
}

/** The wedges of a plan on a W×H output, in that output's pixels. */
interface WedgeLayout {
  width: number;
  height: number;
  /** The original page, pulled in by the bleed: outside it (in a painted quadrant) is fill. */
  page: DeskewPoint[];
  /** The photo, pulled in by one pixel (the clamped edge row): outside it is always fill. */
  photo: DeskewPoint[] | null;
  paint: [boolean, boolean, boolean, boolean];
  /** Along each edge of `page`: inward unit normal. */
  normals: DeskewPoint[];
  /**
   * `page` pulled in by the seam band's depth: where the deeper band may
   * read, so near a corner it never reads the other edge's rim.
   */
  inner: DeskewPoint[];
}

function wedgeLayout(plan: DeskewPlan, width: number, height: number): WedgeLayout {
  const sx = Math.max(1, width - 1);
  const sy = Math.max(1, height - 1);
  const bleedPx = Math.max(1, plan.bleedFraction * Math.max(width, height));
  const px = (poly: DeskewPoint[]): DeskewPoint[] => poly.map((p) => ({ x: p.x * sx, y: p.y * sy }));
  const page = shrinkPolygon(px(plan.pageInOutput), bleedPx, bleedPx);
  const photo = plan.photoInOutput === null ? null : shrinkPolygon(px(plan.photoInOutput), 1, 1);
  const mx = page.reduce((a, p) => a + p.x, 0) / 4;
  const my = page.reduce((a, p) => a + p.y, 0) / 4;
  const normals = page.map((a, i) => {
    const b = page[(i + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    let nx = -(b.y - a.y) / len;
    let ny = (b.x - a.x) / len;
    if (nx * (mx - a.x) + ny * (my - a.y) < 0) {
      nx = -nx;
      ny = -ny;
    }
    return { x: nx, y: ny };
  });
  const band = Math.max(4, FILL_BAND_FRACTION * Math.max(width, height));
  return { width, height, page, photo, paint: plan.paint, normals, inner: shrinkPolygon(page, band, band) };
}

function paintsAt(layout: WedgeLayout, x: number, y: number): boolean {
  if (layout.photo !== null && !insidePolygon(layout.photo, x, y)) return true;
  const edge = outsideEdge(layout.page, x, y);
  return edge >= 0 && layout.paint[edge];
}

export interface PixelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Part of a W×H output: its pixels, and where it sits. */
export interface PixelWindow {
  x: number;
  y: number;
  image: DeskewImage;
}

/**
 * The paper beside each wedge: colour profiles along each edge of the page,
 * read from two bands inside it — one right at the seam, one a little
 * further in. A wedge pixel takes the colour of the paper at the nearest
 * point of the page edge: the seam band's right at the seam, so nothing steps
 * there (real sheets shade and brighten toward their edges), turning into
 * the deeper band's over {@link FILL_BLEND_FRACTION} of the long edge, so a
 * rim of light or shadow — or the blurred sheet edge in a loose outline — is
 * not carried across the whole wedge. Tint and shading along the edge carry
 * on either way, instead of meeting one flat colour for the whole corner.
 */
export interface WedgeFill {
  /** Per page edge: K colours (RGB, K×3) at t = (k+½)/K along it, from the seam band; empty when unread. */
  near: Float32Array[];
  /** The same, from the deeper band; empty when unread (the near one is used alone). */
  deep: Float32Array[];
  /** When an edge has no paper to read: the page's own. */
  fallback: [number, number, number];
}

/**
 * Depth of the seam band the paper is read from, beyond the bleed (fraction
 * of the long edge): close to the seam, because real sheets shade toward
 * their edge.
 */
const FILL_BAND_FRACTION = 0.006;
/** The deeper band: from this far inside the seam (fraction of the long edge)… */
const FILL_DEEP_FROM_FRACTION = 0.015;
/** …to this far. */
const FILL_DEEP_TO_FRACTION = 0.03;
/** Distance from the seam over which the fill turns from the seam band's colour to the deeper band's. */
const FILL_BLEND_FRACTION = 0.015;
/** Profile smoothing along each edge (fraction of the long edge, full width). */
const FILL_SMOOTH_FRACTION = 0.03;
/**
 * How far along the edge the paper level of a position is judged from
 * (fraction of the long edge, each way): about one line of print, so a line
 * meeting the edge has paper beside it — and short enough that shading along
 * the edge is not mistaken for print.
 */
const FILL_PAPER_REACH_FRACTION = 0.012;
/**
 * The same for the deeper band, which print reaches far more often (a level
 * line runs along a tilted edge's band for a long stretch); shading there is
 * gentler than at the seam, so it can afford the longer look.
 */
const FILL_DEEP_REACH_FRACTION = 0.05;
/** A position this many grey levels under the paper around it is print, not paper. */
const FILL_PRINT_STEP = 10;
/** A position under this share of the sheet's paper level is not paper (table in a loose outline). */
const FILL_MIN_PAPER_SHARE = 0.6;

type Band = "near" | "deep";

interface SamplePlan {
  /** Depths sampled per position, px inside the seam. */
  depths: number[];
  /** Positions along the edge. */
  k: number;
}

function samplePlanFor(layout: WedgeLayout, edge: number, band: Band): SamplePlan {
  const long = Math.max(layout.width, layout.height);
  const a = layout.page[edge];
  const b = layout.page[(edge + 1) % 4];
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const step = Math.max(2, long / 256);
  const k = Math.max(2, Math.ceil(len / step));
  const from = band === "near" ? 1 : Math.max(2, Math.round(FILL_DEEP_FROM_FRACTION * long));
  const to =
    band === "near"
      ? Math.max(4, Math.round(FILL_BAND_FRACTION * long))
      : Math.max(from + 3, Math.round(FILL_DEEP_TO_FRACTION * long));
  const count = Math.min(10, to - from + 1);
  const depths: number[] = [];
  for (let j = 0; j < count; j += 1) depths.push(from + (j * (to - from)) / Math.max(1, count - 1));
  return { depths, k };
}

/** Every pixel the profiles of `edge` read, as integer output coordinates. */
function samplePoints(
  layout: WedgeLayout,
  edge: number,
  visit: (band: Band, k: number, x: number, y: number) => void,
): void {
  const a = layout.page[edge];
  const b = layout.page[(edge + 1) % 4];
  const n = layout.normals[edge];
  for (const band of ["near", "deep"] as const) {
    const { depths, k } = samplePlanFor(layout, edge, band);
    for (let i = 0; i < k; i += 1) {
      const t = (i + 0.5) / k;
      const ex = a.x + t * (b.x - a.x);
      const ey = a.y + t * (b.y - a.y);
      for (const d of depths) {
        const x = Math.round(ex + n.x * d);
        const y = Math.round(ey + n.y * d);
        if (x < 0 || y < 0 || x >= layout.width || y >= layout.height) continue;
        if (layout.photo !== null && !insidePolygon(layout.photo, x, y)) continue;
        if (!insidePolygon(band === "near" ? layout.page : layout.inner, x, y)) continue;
        visit(band, i, x, y);
      }
    }
  }
}

/** Positions along an edge whose samples share one read-back box. */
const SAMPLE_BOX_POSITIONS = 12;

/**
 * The boxes holding every pixel the fill's profiles read: short runs of
 * positions along each edge, so a tilted edge's band is read as a staircase
 * of thin boxes rather than one box as large as the page.
 */
export function wedgeSampleBoxes(plan: DeskewPlan, width: number, height: number): (PixelBox | null)[] {
  const layout = wedgeLayout(plan, width, height);
  const boxes = new Map<string, [number, number, number, number]>();
  for (let edge = 0; edge < 4; edge += 1) {
    samplePoints(layout, edge, (band, k, x, y) => {
      const key = `${edge}/${band}/${Math.floor(k / SAMPLE_BOX_POSITIONS)}`;
      const box = boxes.get(key);
      if (box === undefined) boxes.set(key, [x, y, x, y]);
      else {
        if (x < box[0]) box[0] = x;
        if (y < box[1]) box[1] = y;
        if (x > box[2]) box[2] = x;
        if (y > box[3]) box[3] = y;
      }
    });
  }
  return [...boxes.values()].map(([x0, y0, x1, y1]) => ({ x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }));
}

function pixelIn(windows: PixelWindow[], x: number, y: number): { data: Uint8ClampedArray; offset: number } | null {
  for (const w of windows) {
    const lx = x - w.x;
    const ly = y - w.y;
    if (lx >= 0 && ly >= 0 && lx < w.image.width && ly < w.image.height) {
      return { data: w.image.data, offset: (ly * w.image.width + lx) * 4 };
    }
  }
  return null;
}

/**
 * A running quantile of `values` over ±radius positions (NaN where no valid
 * one is in reach). Paper is the bright mode of a band: print crossing the
 * edge only ever darkens a position, so an upper quantile over a stretch of
 * the edge is the paper there — and shading, which changes slowly along the
 * edge, survives it.
 */
function runningQuantile(values: Float32Array, valid: Uint8Array, radius: number, q: number): Float32Array {
  const out = new Float32Array(values.length);
  const window: number[] = [];
  for (let i = 0; i < values.length; i += 1) {
    window.length = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(values.length - 1, i + radius); j += 1) {
      if (valid[j] === 1) window.push(values[j]);
    }
    if (window.length === 0) {
      out[i] = NaN;
      continue;
    }
    window.sort((a, b) => a - b);
    out[i] = window[Math.min(window.length - 1, Math.floor(q * window.length))];
  }
  return out;
}

/** One band's profile along one edge, from its samples (lum, r, g, b per sample, per position). */
function profileOf(
  samples: number[][],
  minSamples: number,
  sheetLevel: number,
  long: number,
  reachFraction: number,
): Float32Array {
  const k = samples.length;
  // Per position: the middle half of the band by brightness — unbiased by
  // grain, and blind to a speck of print; a position that is mostly print
  // reads dark and is dropped below.
  const raw = [new Float32Array(k), new Float32Array(k), new Float32Array(k)];
  const lum = new Float32Array(k);
  const valid = new Uint8Array(k);
  for (let i = 0; i < k; i += 1) {
    const s = samples[i];
    const n = s.length / 4;
    if (n < minSamples) continue;
    const order = Array.from({ length: n }, (_, j) => j).sort((p, q) => s[q * 4] - s[p * 4]);
    const keep = order.slice(Math.floor(n / 4), Math.max(Math.floor(n / 4) + 1, Math.ceil((3 * n) / 4)));
    for (let c = 0; c < 3; c += 1) {
      raw[c][i] = keep.reduce((acc, j) => acc + s[j * 4 + 1 + c], 0) / keep.length;
    }
    lum[i] = 0.299 * raw[0][i] + 0.587 * raw[1][i] + 0.114 * raw[2][i];
    valid[i] = 1;
  }
  // Lines of print meeting the edge darken whole positions, one after the
  // other: over a stretch of the edge the paper is the upper quantile.
  // Positions far below it are print — or table, inside a loose outline —
  // and are dropped before the colours are read.
  const step = Math.max(2, long / 256);
  const reach = Math.max(3, Math.round((reachFraction * long) / step));
  const paperLum = runningQuantile(lum, valid, reach, 0.75);
  for (let i = 0; i < k; i += 1) {
    if (valid[i] === 1 && (lum[i] < paperLum[i] - FILL_PRINT_STEP || lum[i] < FILL_MIN_PAPER_SHARE * sheetLevel)) {
      valid[i] = 0;
    }
  }
  if (!valid.some((v) => v === 1)) return new Float32Array(0);
  // A box average keeps the profile smooth; gaps take the nearest measured value.
  const smoothRadius = Math.max(1, Math.round((FILL_SMOOTH_FRACTION * long) / step / 2));
  const out = new Float32Array(k * 3);
  for (let c = 0; c < 3; c += 1) {
    const med = runningQuantile(raw[c], valid, 3, 0.5);
    for (let i = 0; i < k; i += 1) {
      if (Number.isFinite(med[i])) continue;
      let near = NaN;
      for (let d = 1; d < k && !Number.isFinite(near); d += 1) {
        if (Number.isFinite(med[i - d])) near = med[i - d];
        else if (Number.isFinite(med[i + d])) near = med[i + d];
      }
      med[i] = near;
    }
    for (let i = 0; i < k; i += 1) {
      let sum = 0;
      let n = 0;
      for (let j = Math.max(0, i - smoothRadius); j <= Math.min(k - 1, i + smoothRadius); j += 1) {
        sum += med[j];
        n += 1;
      }
      out[i * 3 + c] = sum / n;
    }
  }
  return out;
}

/**
 * Read the paper beside each wedge, from `windows` of the output (the whole
 * image, or the boxes {@link wedgeSampleBoxes} named). Call it before any
 * pixel is painted.
 */
export function wedgeFillFrom(windows: PixelWindow[], plan: DeskewPlan, width: number, height: number): WedgeFill {
  const layout = wedgeLayout(plan, width, height);
  const long = Math.max(width, height);
  // Every band's samples first: their bright end is the sheet's paper level,
  // against which a stretch of table inside a loose outline is told apart.
  const read: Record<Band, number[][][]> = { near: [], deep: [] };
  const everything: number[] = [];
  for (let edge = 0; edge < 4; edge += 1) {
    for (const band of ["near", "deep"] as const) {
      read[band].push(Array.from({ length: samplePlanFor(layout, edge, band).k }, () => []));
    }
    samplePoints(layout, edge, (band, i, x, y) => {
      const px = pixelIn(windows, x, y);
      if (px === null) return;
      const l = lumOf(px.data, px.offset);
      everything.push(l);
      read[band][edge][i].push(l, px.data[px.offset], px.data[px.offset + 1], px.data[px.offset + 2]);
    });
  }
  everything.sort((a, b) => a - b);
  const sheetLevel = everything.length === 0 ? 255 : everything[Math.floor(0.9 * (everything.length - 1))];
  const near: Float32Array[] = [];
  const deep: Float32Array[] = [];
  let fr = 0;
  let fg = 0;
  let fb = 0;
  let fn = 0;
  for (let edge = 0; edge < 4; edge += 1) {
    const nearMin = Math.min(3, samplePlanFor(layout, edge, "near").depths.length);
    const deepMin = Math.min(3, samplePlanFor(layout, edge, "deep").depths.length);
    const n = profileOf(read.near[edge], nearMin, sheetLevel, long, FILL_PAPER_REACH_FRACTION);
    near.push(n);
    deep.push(profileOf(read.deep[edge], deepMin, sheetLevel, long, FILL_DEEP_REACH_FRACTION));
    for (let i = 0; i < n.length; i += 3) {
      fr += n[i];
      fg += n[i + 1];
      fb += n[i + 2];
      fn += 1;
    }
  }
  let fallback: [number, number, number];
  if (fn > 0) fallback = [fr / fn, fg / fn, fb / fn];
  else {
    const cc = plan.cornerColors;
    fallback = [0, 1, 2].map((c) => (cc[0][c] + cc[1][c] + cc[2][c] + cc[3][c]) / 4) as [number, number, number];
  }
  return { near, deep, fallback };
}

function profileAt(profile: Float32Array, t: number, c: number): number {
  const k = profile.length / 3;
  const f = Math.max(0, Math.min(k - 1, t * k - 0.5));
  const i0 = Math.floor(f);
  const i1 = Math.min(k - 1, i0 + 1);
  const w = f - i0;
  return profile[i0 * 3 + c] * (1 - w) + profile[i1 * 3 + c] * w;
}

/** The fill colour at output pixel (x, y): the paper at the nearest point of the page edge. */
function fillColorAt(layout: WedgeLayout, fill: WedgeFill, x: number, y: number, out: number[]): void {
  let best = Infinity;
  let bestEdge = -1;
  let bestT = 0;
  for (let edge = 0; edge < 4; edge += 1) {
    if (fill.near[edge].length === 0) continue;
    const a = layout.page[edge];
    const b = layout.page[(edge + 1) % 4];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2));
    const d = Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
    if (d < best) {
      best = d;
      bestEdge = edge;
      bestT = t;
    }
  }
  if (bestEdge < 0) {
    out[0] = fill.fallback[0];
    out[1] = fill.fallback[1];
    out[2] = fill.fallback[2];
    return;
  }
  const near = fill.near[bestEdge];
  const deep = fill.deep[bestEdge];
  // Smoothstep from the seam band's colour to the deeper band's.
  const span = Math.max(1, FILL_BLEND_FRACTION * Math.max(layout.width, layout.height));
  const u = Math.min(1, best / span);
  const w = deep.length === 0 ? 0 : u * u * (3 - 2 * u);
  for (let c = 0; c < 3; c += 1) {
    const a = profileAt(near, bestT, c);
    out[c] = w === 0 ? a : a * (1 - w) + profileAt(deep, bestT, c) * w;
  }
}

/** Rows per paint box: a wedge is a thin triangle, read back as a staircase of short boxes. */
const PAINT_BOX_ROWS_FRACTION = 1 / 64;

/**
 * The boxes (disjoint: within one output quadrant and one short run of rows)
 * holding every pixel the fill paints. Found row by row; a box may hold
 * pixels that are not painted — the painter decides each pixel on its own, so
 * painting box by box is the same as painting the whole page.
 */
export function wedgePaintBoxes(plan: DeskewPlan, width: number, height: number): PixelBox[] {
  const layout = wedgeLayout(plan, width, height);
  const midX = 0.5 * (width - 1);
  const midY = 0.5 * (height - 1);
  const boxes: PixelBox[] = [];
  const quadrants: [number, number, number, number][] = [
    [0, Math.floor(midX), 0, Math.floor(midY)],
    [Math.floor(midX) + 1, width - 1, 0, Math.floor(midY)],
    [Math.floor(midX) + 1, width - 1, Math.floor(midY) + 1, height - 1],
    [0, Math.floor(midX), Math.floor(midY) + 1, height - 1],
  ];
  // A convex polygon's inside is one interval per row; outside it, at most two.
  const interval = (poly: DeskewPoint[], y: number): [number, number] => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < poly.length; i += 1) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      if ((a.y - y) * (b.y - y) > 0 || a.y === b.y) {
        if (a.y === y) {
          lo = Math.min(lo, a.x);
          hi = Math.max(hi, a.x);
        }
        continue;
      }
      const x = a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x);
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
    }
    return [lo, hi];
  };
  const strip = Math.max(8, Math.round(PAINT_BOX_ROWS_FRACTION * Math.max(width, height)));
  const anyWedge = layout.paint.some(Boolean);
  quadrants.forEach(([qx0, qx1, qy0, qy1]) => {
    if (qx1 < qx0 || qy1 < qy0) return;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const flush = (): void => {
      if (x1 >= x0 && y1 >= y0) {
        const bx0 = Math.max(qx0, x0 - 1);
        const bx1 = Math.min(qx1, x1 + 1);
        boxes.push({ x: bx0, y: y0, width: bx1 - bx0 + 1, height: y1 - y0 + 1 });
      }
      x0 = Infinity;
      y0 = Infinity;
      x1 = -Infinity;
      y1 = -Infinity;
    };
    for (let y = qy0; y <= qy1; y += 1) {
      if ((y - qy0) % strip === 0) flush();
      let [lo, hi] = [-Infinity, Infinity];
      if (anyWedge) [lo, hi] = interval(layout.page, y);
      if (layout.photo !== null) {
        const [plo, phi] = interval(layout.photo, y);
        lo = Math.max(lo, plo);
        hi = Math.min(hi, phi);
      }
      if (!anyWedge && layout.photo === null) continue;
      // Painted in this row: x < lo or x > hi (±2 px for the polygon test's own edges).
      const left = Math.ceil(lo) + 1;
      const right = Math.floor(hi) - 1;
      const segments: [number, number][] = [];
      if (!(lo <= hi)) segments.push([qx0, qx1]);
      else {
        if (left > qx0) segments.push([qx0, Math.min(qx1, left)]);
        if (right < qx1) segments.push([Math.max(qx0, right), qx1]);
      }
      for (const [s0, s1] of segments) {
        if (s1 < s0) continue;
        x0 = Math.min(x0, s0);
        x1 = Math.max(x1, s1);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    }
    flush();
  });
  return boxes;
}

/** Paint the wedge pixels of one window of the output, in place. Answers how many. */
export function paintWedgeWindow(
  window: PixelWindow,
  plan: DeskewPlan,
  fill: WedgeFill,
  width: number,
  height: number,
): number {
  if (plan.mode !== "paper") return 0;
  const layout = wedgeLayout(plan, width, height);
  const { image } = window;
  const data = image.data;
  const rgb = [0, 0, 0];
  let painted = 0;
  for (let ly = 0; ly < image.height; ly += 1) {
    const y = window.y + ly;
    for (let lx = 0; lx < image.width; lx += 1) {
      const x = window.x + lx;
      if (!paintsAt(layout, x, y)) continue;
      fillColorAt(layout, fill, x, y, rgb);
      const o = (ly * image.width + lx) * 4;
      data[o] = rgb[0];
      data[o + 1] = rgb[1];
      data[o + 2] = rgb[2];
      data[o + 3] = 255;
      painted += 1;
    }
  }
  return painted;
}

/** Whether a plan paints anything at all. */
export function paintsAnything(plan: DeskewPlan): boolean {
  return plan.mode === "paper" && (plan.paint.some(Boolean) || plan.photoInOutput !== null);
}

/**
 * Paint the wedges of a deskewed page, in place — the whole-image form. The
 * canvas painter in `dewarp-stage.ts` reads and writes only the boxes
 * ({@link wedgeSampleBoxes}, {@link wedgePaintBoxes}) and calls the same
 * functions, so the two give the same pixels.
 */
export function fillDeskewWedges(image: DeskewImage, plan: DeskewPlan): number {
  if (!paintsAnything(plan)) return 0;
  const whole: PixelWindow = { x: 0, y: 0, image };
  const fill = wedgeFillFrom([whole], plan, image.width, image.height);
  let painted = 0;
  for (const box of wedgePaintBoxes(plan, image.width, image.height)) {
    const sub = { width: box.width, height: box.height, data: new Uint8ClampedArray(box.width * box.height * 4) };
    for (let y = 0; y < box.height; y += 1) {
      const from = ((box.y + y) * image.width + box.x) * 4;
      sub.data.set(image.data.subarray(from, from + box.width * 4), y * box.width * 4);
    }
    painted += paintWedgeWindow({ x: box.x, y: box.y, image: sub }, plan, fill, image.width, image.height);
    for (let y = 0; y < box.height; y += 1) {
      image.data.set(sub.data.subarray(y * box.width * 4, (y + 1) * box.width * 4), ((box.y + y) * image.width + box.x) * 4);
    }
  }
  return painted;
}

/** Share of paper-like pixels in a wedge above which the page continues into it. */
const WEDGE_PAGE_CONTINUES = 0.6;
/**
 * A wedge whose median is at least this share of the page border's own is the
 * page continuing (shaded paper, print on paper), however little of it passes
 * as bright paper.
 */
const WEDGE_LOOKS_LIKE_PAGE = 0.85;
/** Share of paper-like pixels in the confirmed page's border that says the outline was the sheet. */
const BORDER_WAS_PAPER = 0.7;

/**
 * Decide, per corner, whether the wedge is painted (see
 * {@link DeskewPlan.paint}), from two small renderings the step already has:
 * `flat`, the page of the confirmed outline, and `deskewed`, the page of Q′.
 *
 * Per wedge — the triangle beyond one edge of the rotated page:
 *
 *  * wedge pixels mostly paper, or as bright as the page's own border along
 *    that edge → the page continues → keep them;
 *  * wedge background, and the confirmed page's own border along that edge
 *    was paper → the outline was the sheet, this background is new → paint;
 *  * wedge background, and the confirmed page's border there was already
 *    background → a loose outline; the table simply continues → keep.
 */
export function decideWedgePaint(plan: DeskewPlan, flat: DeskewImage, deskewed: DeskewImage): DeskewPlan {
  if (plan.mode !== "paper") return { ...plan, paint: [false, false, false, false] };
  const lumAt = (img: DeskewImage, x: number, y: number): number => lumOf(img.data, (y * img.width + x) * 4);
  const sample: number[] = [];
  const step = Math.max(1, Math.floor(Math.max(flat.width, flat.height) / 300));
  for (let y = 0; y < flat.height; y += step) for (let x = 0; x < flat.width; x += step) sample.push(lumAt(flat, x, y));
  sample.sort((a, b) => a - b);
  const paperLum = sample[Math.floor(0.9 * (sample.length - 1))] ?? 255;
  const isPaper = (l: number): boolean => l >= 0.8 * paperLum;

  const wedge: number[][] = [[], [], [], []];
  const wedgePaper = [0, 0, 0, 0];
  const du = 1 / Math.max(1, deskewed.width - 1);
  const dv = 1 / Math.max(1, deskewed.height - 1);
  for (let y = 0; y < deskewed.height; y += 1) {
    for (let x = 0; x < deskewed.width; x += 1) {
      const u = x * du;
      const v = y * dv;
      if (insidePolygon(plan.pageInOutput, u, v)) continue;
      // Beyond the photo there is nothing to judge — only clamped edge pixels.
      if (plan.photoInOutput !== null && !insidePolygon(plan.photoInOutput, u, v)) continue;
      const k = outsideEdge(plan.pageInOutput, u, v);
      if (k < 0) continue;
      const l = lumAt(deskewed, x, y);
      wedge[k].push(l);
      if (isPaper(l)) wedgePaper[k] += 1;
    }
  }
  // The confirmed page's own border band (2 %) along each edge: top, right,
  // bottom, left — the edges of `pageInOutput`, in order.
  const bandX = Math.max(1, Math.round(0.02 * flat.width));
  const bandY = Math.max(1, Math.round(0.02 * flat.height));
  const border: number[][] = [[], [], [], []];
  const borderPaper = [0, 0, 0, 0];
  for (let y = 0; y < flat.height; y += 1) {
    for (let x = 0; x < flat.width; x += 1) {
      const bands = [y < bandY, x >= flat.width - bandX, y >= flat.height - bandY, x < bandX];
      if (!bands.some(Boolean)) continue;
      const l = lumAt(flat, x, y);
      bands.forEach((inBand, k) => {
        if (!inBand) return;
        border[k].push(l);
        if (isPaper(l)) borderPaper[k] += 1;
      });
    }
  }
  const paint = [0, 1, 2, 3].map((k) => {
    const total = wedge[k].length;
    if (total < 10) return true;
    if (wedgePaper[k] / total >= WEDGE_PAGE_CONTINUES) return false;
    const borderMedian = medianOf(border[k]);
    if (border[k].length > 0 && medianOf(wedge[k]) >= WEDGE_LOOKS_LIKE_PAGE * borderMedian) return false;
    return border[k].length > 0 && borderPaper[k] / border[k].length >= BORDER_WAS_PAPER;
  }) as [boolean, boolean, boolean, boolean];
  return { ...plan, paint };
}

/* ── The judge: the rotated page against the original flat page ───────── */

/** Print pushed out of the frame by the rotation, as a share of the glyph ink, above which it is refused. */
export const JUDGE_MAX_CLIPPED_SHARE = 0.002;
/** The rotated page's own lean may be at most this share of the rotation… */
const JUDGE_RESIDUAL_SHARE = 0.5;
/** …or this many degrees, whichever is larger. */
const JUDGE_RESIDUAL_FLOOR_DEG = 0.35;
/** Bow may not grow past this ratio of the flat page's (the engine's own regression ratio)… */
const JUDGE_BOW_RATIO = 1.6;
/** …over this floor (the engine's curvature noise floor). */
const JUDGE_BOW_FLOOR = 0.002;
/** Lines the level page must keep, as a share of the flat page's. */
const JUDGE_MIN_LINE_SHARE = 0.6;
const JUDGE_MIN_LINES = 3;

export type DeskewRejection = "clips" | "not-level" | "bow-worse" | "lines-lost";

export interface DeskewJudgement {
  ok: boolean;
  rejection: DeskewRejection | null;
  /** Glyph ink the rotation pushes out of the frame, as a share of all of it. */
  clippedShare: number;
  /** The lean left on the rotated page, degrees (NaN: not measurable). */
  residualDeg: number;
  /** The engine's straightness measure on the original flat page and on the rotated one. */
  flat: StraightnessStats;
  rotated: StraightnessStats;
}

/**
 * Whether the rotation earned its place — judged against the ORIGINAL flat
 * page B₀ of the confirmed outline, not only against itself: the finished
 * (rotated, painted) page must be more level than B₀ was, its lines no less
 * straight and no fewer by the engine's own measure, and no print may leave
 * the frame.
 */
export function judgeDeskew(input: {
  flat: DeskewImage;
  rotated: DeskewImage;
  deg: number;
  scale?: number;
  sample: { xs: Float64Array; ys: Float64Array; width: number; height: number } | null;
}): DeskewJudgement {
  const { deg } = input;
  const scale = input.scale ?? 1;
  let clippedShare = 0;
  if (input.sample !== null) {
    const { xs, ys, width, height } = input.sample;
    const t = (deg * Math.PI) / 180;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const hx = (width - 1) / 2;
    const hy = (height - 1) / 2;
    let out = 0;
    for (let i = 0; i < xs.length; i += 1) {
      // Where this flat-page pixel lands in the rotated output: R(−θ)(f − c)/scale.
      const ox = (c * xs[i] + s * ys[i]) / scale;
      const oy = (-s * xs[i] + c * ys[i]) / scale;
      if (ox < -hx || ox > hx || oy < -hy || oy > hy) out += 1;
    }
    clippedShare = xs.length === 0 ? 0 : out / xs.length;
  }
  const residualDeg = residualLean(input.rotated);
  const flat = measureSurface(input.flat).straightness;
  const rotated = measureSurface(input.rotated).straightness;
  let rejection: DeskewRejection | null = null;
  if (clippedShare > JUDGE_MAX_CLIPPED_SHARE) rejection = "clips";
  else if (
    Number.isFinite(residualDeg) &&
    Math.abs(residualDeg) > Math.max(JUDGE_RESIDUAL_FLOOR_DEG, JUDGE_RESIDUAL_SHARE * Math.abs(deg))
  ) {
    rejection = "not-level";
  } else if (
    flat.lineCount >= JUDGE_MIN_LINES &&
    rotated.lineCount >= JUDGE_MIN_LINES &&
    rotated.medianCurvature > Math.max(flat.medianCurvature * JUDGE_BOW_RATIO, JUDGE_BOW_FLOOR)
  ) {
    rejection = "bow-worse";
  } else if (
    flat.lineCount >= JUDGE_MIN_LINES &&
    rotated.lineCount < Math.max(JUDGE_MIN_LINES, JUDGE_MIN_LINE_SHARE * flat.lineCount)
  ) {
    rejection = "lines-lost";
  }
  return { ok: rejection === null, rejection, clippedShare, residualDeg, flat, rotated };
}

/* ── The step, end to end ─────────────────────────────────────────────── */

export interface StraightenInput {
  /** B₀: the small flat page of `quad`, as the stage renders the engine's A/B baseline. */
  flat: DeskewImage;
  /** The confirmed outline Q, canonical pixels. */
  quad: DeskewQuad;
  canonicalWidth: number;
  canonicalHeight: number;
  mode?: DeskewWedgeMode;
  /**
   * The small flat page of another outline, rendered exactly the way `flat`
   * was (same scaled copy, same warp) — so B′ and B₀ differ by the rotation
   * alone.
   */
  renderSmall: (quad: DeskewQuad) => Promise<DeskewImage | null>;
  now?: () => number;
}

export interface StraightenResult {
  estimate: SkewEstimate;
  /** The rotation to compose with Q — null when the estimate abstained or the judge refused it. */
  plan: DeskewPlan | null;
  /** The judge's verdict, when the estimate acted and B′ could be rendered. */
  judgement: DeskewJudgement | null;
  /**
   * Whether the curved-page engine should run (on Q, as always): whenever
   * there is no rotation, and on a rotated page only when the level page
   * still shows a curl — the rotation then stands only if the engine declines.
   */
  runEngine: boolean;
  /** Wall time of the whole step, ms. */
  ms: number;
}

function copyImage(image: DeskewImage): DeskewImage {
  return { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
}

/**
 * The deskew, planned and judged, from the small flat page the stage already
 * has. Never throws: every failure is "no rotation", and then the engine
 * runs on Q exactly as it did before this step existed.
 */
export async function planStraighten(input: StraightenInput): Promise<StraightenResult> {
  const now = input.now ?? (() => Date.now());
  const started = now();
  const mode = input.mode ?? DESKEW_WEDGE_MODE;
  const done = (
    estimate: SkewEstimate,
    rest: Partial<Omit<StraightenResult, "estimate" | "ms">> = {},
  ): StraightenResult => ({
    estimate,
    plan: null,
    judgement: null,
    runEngine: true,
    ...rest,
    ms: now() - started,
  });
  let detailed: DetailedEstimate;
  try {
    detailed = estimateDetailed(input.flat);
  } catch {
    return done(abstain("too-small"));
  }
  const { estimate, sample } = detailed;
  if (!estimate.act) return done(estimate);
  try {
    const dims = flatPageDims(input.quad);
    const geometry = deskewQuad({
      quad: input.quad,
      outputWidth: dims.width,
      outputHeight: dims.height,
      canonicalWidth: input.canonicalWidth,
      canonicalHeight: input.canonicalHeight,
      deg: estimate.deg,
      mode,
    });
    const rotated = await input.renderSmall(geometry.quad);
    if (rotated === null) return done(estimate);
    let plan: DeskewPlan = {
      policyVersion: DESKEW_POLICY_VERSION,
      deg: estimate.deg,
      quad: geometry.quad,
      scale: geometry.scale,
      mode,
      pageInOutput: geometry.pageInOutput,
      cornerColors: paperCornerColors(input.flat),
      paint: [true, true, true, true],
      bleedFraction: DESKEW_FILL_BLEED_FRACTION,
      photoInOutput: geometry.photoInOutput,
      curl: curlEvidence(estimate, null),
    };
    plan = decideWedgePaint(plan, input.flat, rotated);
    // The page the user would see (rotated, painted) against the page of the
    // outline they confirmed.
    const finished = copyImage(rotated);
    fillDeskewWedges(finished, plan);
    const judgement = judgeDeskew({ flat: input.flat, rotated: finished, deg: estimate.deg, scale: plan.scale, sample });
    if (!judgement.ok) return done(estimate, { judgement });
    plan = { ...plan, curl: curlEvidence(estimate, judgement.rotated) };
    return done(estimate, { plan, judgement, runEngine: plan.curl.evidence });
  } catch {
    return done(estimate);
  }
}
