/**
 * The A/B check: does the dewarped page actually read better than the flat one?
 *
 * The guards in `guards.ts` can only prove that a map is *geometrically*
 * sane — finite, unfolded, not wandering off the page. They cannot tell a
 * correct dewarp from a confident wrong one, because both produce a perfectly
 * well-behaved map. Only the pixels can, and only by comparison: the same page,
 * flattened both ways, at a size small enough (~448 px long edge) that the
 * whole comparison costs less than the inference that preceded it.
 *
 * Two independent questions are asked of each rendering.
 *
 * **Did the page survive?** A wrong map does not lose a page gracefully; it
 * pushes content off the edge and pads with margin, or clamps at the border and
 * repeats the last strip. Both show up as an occupancy delta against the
 * homography rendering of the same quad.
 *
 * **Did the text get straighter?** That is the entire promise of the feature,
 * so it is measured directly: threshold, connected components, group into
 * baselines, fit a quadratic, read off the sagitta. A dewarp that leaves the
 * lines exactly as bent as the homography did has bought nothing and is not
 * worth the risk of being subtly wrong.
 *
 * Everything here is pure and works on plain arrays, so the verdict logic can
 * be tested without ever rendering anything.
 */

import { downscale } from "./sampler.ts";
import type { RgbaImage } from "./types.ts";

/**
 * Long edge of the comparison rendering.
 *
 * Big enough that a 10 pt line of text is still several pixels tall (so
 * components survive thresholding), small enough that the whole A/B pass —
 * two renders, two component labellings — is a fraction of one inference.
 */
export const SEMANTIC_LONG_EDGE = 448;

/** Luminance in 0–1, Rec. 601 — the same weights the enhancement pass assumes. */
export interface GrayImage {
  width: number;
  height: number;
  data: Float32Array;
}

export function toGray(image: RgbaImage): GrayImage {
  const data = new Float32Array(image.width * image.height);
  const source = image.data;
  for (let index = 0; index < data.length; index += 1) {
    const offset = index * 4;
    data[index] =
      (source[offset] * 0.299 +
        source[offset + 1] * 0.587 +
        source[offset + 2] * 0.114) /
      255;
  }
  return { width: image.width, height: image.height, data };
}

/* ── Occupancy ─────────────────────────────────────────────────────────── */

/** Border strip thickness, as a fraction of the shorter side. */
export const BORDER_BAND_FRACTION = 0.06;

/** How close to the page's own background a pixel must be to count as blank. */
export const BLANK_TOLERANCE = 0.06;

/** Rows/columns inward that are checked for being a copy of the outermost one. */
export const BORDER_REPEAT_DEPTH = 4;

/** Mean absolute luminance difference below which two strips are "the same". */
export const BORDER_REPEAT_TOLERANCE = 0.02;

/**
 * A strip has to have something on it before repeating it means anything.
 *
 * Every page has blank margins, and a blank row is trivially identical to the
 * next blank row — without this floor the repeat score would fire on healthy
 * scans. The failure it is actually looking for is a strip *with content*
 * smeared inward, which is what edge-clamped sampling produces.
 */
export const BORDER_CONTENT_STDEV = 0.02;

/** Ink is this far below the page background — deliberately gentle. */
export const INK_MARGIN = 0.18;

export interface OccupancyStats {
  /** Share of the whole image that is ink. Content pushed off the page lowers it. */
  inkFraction: number;
  /** Share of the border strips that is indistinguishable from background. */
  blankBorderFraction: number;
  /** 0–1: how many strips inward are a copy of the outermost one (edge smear). */
  borderRepeatScore: number;
}

function backgroundLevel(gray: GrayImage): number {
  // The 90th percentile rather than the max: a specular highlight is not the
  // page. Histogram over 256 bins — sorting 200k floats to read one quantile
  // is the kind of cost that turns a "cheap" check into the expensive one.
  const bins = new Uint32Array(256);
  for (let index = 0; index < gray.data.length; index += 1) {
    const bin = Math.max(0, Math.min(255, Math.round(gray.data[index] * 255)));
    bins[bin] += 1;
  }
  const target = gray.data.length * 0.9;
  let seen = 0;
  for (let bin = 0; bin < bins.length; bin += 1) {
    seen += bins[bin];
    if (seen >= target) return bin / 255;
  }
  return 1;
}

function meanRowDifference(
  gray: GrayImage,
  rowA: number,
  rowB: number,
): number {
  let total = 0;
  const offsetA = rowA * gray.width;
  const offsetB = rowB * gray.width;
  for (let column = 0; column < gray.width; column += 1) {
    total += Math.abs(gray.data[offsetA + column] - gray.data[offsetB + column]);
  }
  return total / Math.max(1, gray.width);
}

function meanColumnDifference(
  gray: GrayImage,
  columnA: number,
  columnB: number,
): number {
  let total = 0;
  for (let row = 0; row < gray.height; row += 1) {
    total += Math.abs(
      gray.data[row * gray.width + columnA] - gray.data[row * gray.width + columnB],
    );
  }
  return total / Math.max(1, gray.height);
}

function stripDeviation(values: number[]): number {
  const mean = values.reduce((total, value) => total + value, 0) / Math.max(1, values.length);
  const variance =
    values.reduce((total, value) => total + (value - mean) * (value - mean), 0) /
    Math.max(1, values.length);
  return Math.sqrt(variance);
}

function rowValues(gray: GrayImage, row: number): number[] {
  const values: number[] = [];
  for (let column = 0; column < gray.width; column += 1) {
    values.push(gray.data[row * gray.width + column]);
  }
  return values;
}

function columnValues(gray: GrayImage, column: number): number[] {
  const values: number[] = [];
  for (let row = 0; row < gray.height; row += 1) {
    values.push(gray.data[row * gray.width + column]);
  }
  return values;
}

/**
 * Repeat score for one side: how many of the first {@link BORDER_REPEAT_DEPTH}
 * strips inward are copies of the outermost strip.
 *
 * Edge clamping is the signature this looks for — the sampler asked for a row
 * outside the source and got the last one, over and over. A featureless
 * outermost strip scores zero: a blank margin repeating itself is a page, not
 * a smear.
 */
function sideRepeat(outermost: number[], differences: number[]): number {
  if (stripDeviation(outermost) < BORDER_CONTENT_STDEV) return 0;
  let same = 0;
  for (const difference of differences) {
    if (difference > BORDER_REPEAT_TOLERANCE) break;
    same += 1;
  }
  return same / Math.max(1, differences.length);
}

export function occupancyStats(gray: GrayImage): OccupancyStats {
  const background = backgroundLevel(gray);
  const inkLevel = background - INK_MARGIN;

  let ink = 0;
  for (let index = 0; index < gray.data.length; index += 1) {
    if (gray.data[index] < inkLevel) ink += 1;
  }

  const band = Math.max(
    1,
    Math.round(BORDER_BAND_FRACTION * Math.min(gray.width, gray.height)),
  );
  let blank = 0;
  let bandPixels = 0;
  const inBand = (row: number, column: number): boolean =>
    row < band ||
    row >= gray.height - band ||
    column < band ||
    column >= gray.width - band;
  for (let row = 0; row < gray.height; row += 1) {
    for (let column = 0; column < gray.width; column += 1) {
      if (!inBand(row, column)) continue;
      bandPixels += 1;
      if (Math.abs(gray.data[row * gray.width + column] - background) <= BLANK_TOLERANCE) {
        blank += 1;
      }
    }
  }

  const depth = Math.min(
    BORDER_REPEAT_DEPTH,
    Math.max(0, Math.min(gray.height, gray.width) - 1),
  );
  const sides: number[] = [];
  if (depth > 0) {
    const top: number[] = [];
    const bottom: number[] = [];
    const left: number[] = [];
    const right: number[] = [];
    for (let step = 1; step <= depth; step += 1) {
      top.push(meanRowDifference(gray, 0, step));
      bottom.push(meanRowDifference(gray, gray.height - 1, gray.height - 1 - step));
      left.push(meanColumnDifference(gray, 0, step));
      right.push(meanColumnDifference(gray, gray.width - 1, gray.width - 1 - step));
    }
    sides.push(
      sideRepeat(rowValues(gray, 0), top),
      sideRepeat(rowValues(gray, gray.height - 1), bottom),
      sideRepeat(columnValues(gray, 0), left),
      sideRepeat(columnValues(gray, gray.width - 1), right),
    );
  }

  return {
    inkFraction: ink / Math.max(1, gray.data.length),
    blankBorderFraction: blank / Math.max(1, bandPixels),
    borderRepeatScore: sides.length === 0 ? 0 : Math.max(...sides),
  };
}

/* ── Text-line straightness ────────────────────────────────────────────── */

/** Threshold at `mean − k·stdev`: gentle, so faint print still labels. */
export const INK_THRESHOLD_K = 0.6;

/** Below this a component is speckle, not a glyph. */
export const MIN_COMPONENT_PIXELS = 4;

/** Above this a component is a photo or a stain, not a glyph. */
export const MAX_COMPONENT_HEIGHT_FRACTION = 0.08;
export const MAX_COMPONENT_WIDTH_FRACTION = 0.25;

/** A baseline needs this many glyphs before its curvature means anything. */
export const MIN_COMPONENTS_PER_LINE = 6;

/** …spanning at least this much of the width, or the fit is extrapolation. */
export const MIN_LINE_SPAN_FRACTION = 0.35;

/** Share of the worst-fitting glyphs dropped before the second fit. */
export const FIT_TRIM_FRACTION = 0.2;

interface Component {
  centroidX: number;
  centroidY: number;
  height: number;
}

export interface StraightnessStats {
  /** Baselines that qualified for a fit. Zero means "no opinion". */
  lineCount: number;
  /**
   * Median sagitta over those baselines, as a fraction of image height:
   * how far the fitted curve bows away from its own chord.
   */
  medianCurvature: number;
}

function labelComponents(gray: GrayImage): Component[] {
  let total = 0;
  for (let index = 0; index < gray.data.length; index += 1) total += gray.data[index];
  const mean = total / Math.max(1, gray.data.length);
  let variance = 0;
  for (let index = 0; index < gray.data.length; index += 1) {
    const delta = gray.data[index] - mean;
    variance += delta * delta;
  }
  const stdev = Math.sqrt(variance / Math.max(1, gray.data.length));
  const threshold = mean - INK_THRESHOLD_K * stdev;

  const visited = new Uint8Array(gray.data.length);
  const stack: number[] = [];
  const components: Component[] = [];
  const maxHeight = MAX_COMPONENT_HEIGHT_FRACTION * gray.height;
  const maxWidth = MAX_COMPONENT_WIDTH_FRACTION * gray.width;

  for (let seed = 0; seed < gray.data.length; seed += 1) {
    if (visited[seed] === 1 || gray.data[seed] >= threshold) continue;
    stack.length = 0;
    stack.push(seed);
    visited[seed] = 1;
    let count = 0;
    let sumX = 0;
    let sumY = 0;
    let minX = gray.width;
    let maxX = 0;
    let minY = gray.height;
    let maxY = 0;
    while (stack.length > 0) {
      const index = stack.pop() as number;
      const row = (index / gray.width) | 0;
      const column = index - row * gray.width;
      count += 1;
      sumX += column;
      sumY += row;
      if (column < minX) minX = column;
      if (column > maxX) maxX = column;
      if (row < minY) minY = row;
      if (row > maxY) maxY = row;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = row + dy;
        if (ny < 0 || ny >= gray.height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = column + dx;
          if (nx < 0 || nx >= gray.width) continue;
          const neighbour = ny * gray.width + nx;
          if (visited[neighbour] === 1 || gray.data[neighbour] >= threshold) continue;
          visited[neighbour] = 1;
          stack.push(neighbour);
        }
      }
    }
    const height = maxY - minY + 1;
    const width = maxX - minX + 1;
    if (count < MIN_COMPONENT_PIXELS) continue;
    if (height > maxHeight || width > maxWidth) continue;
    components.push({
      centroidX: sumX / count,
      centroidY: sumY / count,
      height,
    });
  }
  return components;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Group glyph centroids into baselines by their vertical gaps.
 *
 * Deliberately simple: sort by y and cut wherever the gap exceeds 60 % of the
 * typical glyph height. It relies on lines staying separable in y, which holds
 * for the deformations the guards let through and fails for a page bent far
 * enough that one line's descenders reach the next line's x-height — and a
 * page like that is one the displacement guard has already rejected.
 */
function groupBaselines(components: Component[]): Component[][] {
  if (components.length === 0) return [];
  const typical = Math.max(1, median(components.map((item) => item.height)));
  const sorted = [...components].sort((a, b) => a.centroidY - b.centroidY);
  const groups: Component[][] = [];
  let current: Component[] = [sorted[0]];
  for (let index = 1; index < sorted.length; index += 1) {
    const gap = sorted[index].centroidY - sorted[index - 1].centroidY;
    if (gap > typical * 0.6) {
      groups.push(current);
      current = [];
    }
    current.push(sorted[index]);
  }
  groups.push(current);
  return groups;
}

/**
 * Least-squares `y = a·t² + b·t + c` over `t ∈ [-1,1]`, solved by Cramer.
 *
 * Returns null on a singular system (every glyph at the same x).
 */
function fitQuadratic(
  points: Array<{ t: number; y: number }>,
): [number, number, number] | null {
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  let s4 = 0;
  let ty0 = 0;
  let ty1 = 0;
  let ty2 = 0;
  for (const point of points) {
    const t = point.t;
    const t2 = t * t;
    s0 += 1;
    s1 += t;
    s2 += t2;
    s3 += t2 * t;
    s4 += t2 * t2;
    ty0 += point.y;
    ty1 += t * point.y;
    ty2 += t2 * point.y;
  }
  const m = [
    [s4, s3, s2],
    [s3, s2, s1],
    [s2, s1, s0],
  ];
  const rhs = [ty2, ty1, ty0];
  const determinant =
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  if (Math.abs(determinant) < 1e-9) return null;
  const solve = (column: number): number => {
    const c = m.map((row, index) => {
      const copy = [...row];
      copy[column] = rhs[index];
      return copy;
    });
    const value =
      c[0][0] * (c[1][1] * c[2][2] - c[1][2] * c[2][1]) -
      c[0][1] * (c[1][0] * c[2][2] - c[1][2] * c[2][0]) +
      c[0][2] * (c[1][0] * c[2][1] - c[1][1] * c[2][0]);
    return value / determinant;
  };
  return [solve(0), solve(1), solve(2)];
}

/**
 * The sagitta of one baseline, as a fraction of image height.
 *
 * On `t ∈ [-1,1]` the quadratic's deviation from the chord through its own
 * endpoints is exactly `|a|` — so the coefficient *is* the bow, in pixels, and
 * dividing by the image height makes it comparable across renderings.
 */
function baselineCurvature(line: Component[], gray: GrayImage): number | null {
  const xs = line.map((item) => item.centroidX);
  const spanLow = Math.min(...xs);
  const spanHigh = Math.max(...xs);
  const span = spanHigh - spanLow;
  if (line.length < MIN_COMPONENTS_PER_LINE) return null;
  if (span < MIN_LINE_SPAN_FRACTION * gray.width) return null;

  const half = span / 2;
  const middle = (spanLow + spanHigh) / 2;
  const points = line.map((item) => ({
    t: (item.centroidX - middle) / half,
    y: item.centroidY,
  }));

  const first = fitQuadratic(points);
  if (first === null) return null;
  const residuals = points.map((point) => {
    const predicted = first[0] * point.t * point.t + first[1] * point.t + first[2];
    return { point, error: Math.abs(point.y - predicted) };
  });
  residuals.sort((a, b) => a.error - b.error);
  const keep = Math.max(
    MIN_COMPONENTS_PER_LINE,
    Math.round(residuals.length * (1 - FIT_TRIM_FRACTION)),
  );
  const trimmed = residuals.slice(0, Math.min(residuals.length, keep)).map((item) => item.point);
  const second = fitQuadratic(trimmed) ?? first;
  return Math.abs(second[0]) / Math.max(1, gray.height);
}

export function lineStraightness(gray: GrayImage): StraightnessStats {
  const lines = groupBaselines(labelComponents(gray));
  const curvatures: number[] = [];
  for (const line of lines) {
    const curvature = baselineCurvature(line, gray);
    if (curvature !== null && Number.isFinite(curvature)) curvatures.push(curvature);
  }
  return { lineCount: curvatures.length, medianCurvature: median(curvatures) };
}

/* ── Verdict ───────────────────────────────────────────────────────────── */

export interface SemanticMeasurement {
  occupancy: OccupancyStats;
  straightness: StraightnessStats;
}

/** Downscale to the comparison size, then measure. */
export function measureSurface(image: RgbaImage): SemanticMeasurement {
  const gray = toGray(downscale(image, SEMANTIC_LONG_EDGE));
  return { occupancy: occupancyStats(gray), straightness: lineStraightness(gray) };
}

/** Extra blank border the dewarp may introduce before it counts as lost page. */
export const OCCUPANCY_BLANK_REGRESSION_DELTA = 0.08;

/** Ink the dewarp may lose (absolute fraction of the image) before the same. */
export const OCCUPANCY_INK_LOSS_DELTA = 0.02;

/** Extra edge-smear the dewarp may introduce. */
export const BORDER_REPEAT_REGRESSION_DELTA = 0.25;

/** Baselines needed on both renderings before curvature is allowed to decide. */
export const MIN_LINE_EVIDENCE = 3;

/** Curvature this small is measurement noise, not a bow — the comparison floor. */
export const CURVATURE_NOISE_FLOOR = 0.002;

/** Past this multiple of the baseline's bow the dewarp is a strong regression. */
export const CURVATURE_REGRESSION_RATIO = 1.6;

/** With evidence and a small deformation, "not worse" is enough. */
export const CURVATURE_NOT_WORSE_RATIO = 1.15;

/** With a large deformation, the dewarp has to actually pay for itself. */
export const CURVATURE_IMPROVEMENT_RATIO = 0.85;

/** Mean displacement above which "not worse" stops being good enough. */
export const LARGE_DEFORMATION_MEAN_FRACTION = 0.08;

/** Mean displacement below which a dewarp may be accepted with no text evidence. */
export const SMALL_DEFORMATION_MEAN_FRACTION = 0.05;

/** Boundary offset a no-evidence acceptance still has to respect. */
export const NO_EVIDENCE_BOUNDARY_FRACTION = 0.03;

export type SemanticRejection =
  | "structural"
  | "regression"
  | "insufficient-evidence";

export interface SemanticVerdictInput {
  /** The homography rendering of the same quad, measured. */
  baseline: SemanticMeasurement;
  /** The dewarped rendering, measured. */
  candidate: SemanticMeasurement;
  /** Did every geometric guard pass? */
  structuralOk: boolean;
  /** From the map guard — how far this map moves pixels. */
  meanDisplacementFraction: number;
  /** From the map guard — how far its corners sit from the confirmed ones. */
  boundaryOffsetFraction: number;
}

export interface SemanticVerdict {
  accept: boolean;
  rejection?: SemanticRejection;
}

/**
 * The last word on a page.
 *
 * The asymmetry is deliberate and is the whole policy: falling back costs the
 * user a page that is merely as good as today's, while accepting a wrong map
 * costs them a page that is worse than today's and looks deliberate. So every
 * branch that is not clearly better resolves to the homography.
 */
export function semanticVerdict(input: SemanticVerdictInput): SemanticVerdict {
  if (!input.structuralOk) return { accept: false, rejection: "structural" };

  const { baseline, candidate } = input;
  const lostPage =
    candidate.occupancy.blankBorderFraction - baseline.occupancy.blankBorderFraction >
      OCCUPANCY_BLANK_REGRESSION_DELTA ||
    baseline.occupancy.inkFraction - candidate.occupancy.inkFraction >
      OCCUPANCY_INK_LOSS_DELTA ||
    candidate.occupancy.borderRepeatScore - baseline.occupancy.borderRepeatScore >
      BORDER_REPEAT_REGRESSION_DELTA;
  if (lostPage) return { accept: false, rejection: "regression" };

  const evidence = Math.min(
    baseline.straightness.lineCount,
    candidate.straightness.lineCount,
  );
  if (evidence >= MIN_LINE_EVIDENCE) {
    const base = baseline.straightness.medianCurvature;
    const found = candidate.straightness.medianCurvature;
    const strongRegression = Math.max(
      base * CURVATURE_REGRESSION_RATIO,
      CURVATURE_NOISE_FLOOR,
    );
    if (found > strongRegression) return { accept: false, rejection: "regression" };

    const ratio =
      input.meanDisplacementFraction > LARGE_DEFORMATION_MEAN_FRACTION
        ? CURVATURE_IMPROVEMENT_RATIO
        : CURVATURE_NOT_WORSE_RATIO;
    const allowed = Math.max(base * ratio, CURVATURE_NOISE_FLOOR);
    return found <= allowed
      ? { accept: true }
      : { accept: false, rejection: "regression" };
  }

  const timid =
    input.meanDisplacementFraction <= SMALL_DEFORMATION_MEAN_FRACTION &&
    input.boundaryOffsetFraction <= NO_EVIDENCE_BOUNDARY_FRACTION;
  return timid
    ? { accept: true }
    : { accept: false, rejection: "insufficient-evidence" };
}
