/**
 * The two gates a curved geometry has to pass before it may touch pixels.
 *
 * A dewarp that goes wrong does not look like an error. It looks like a page:
 * slightly folded, subtly sheared, a line of text pulled into a curve that was
 * never there. There is no exception to catch, so the engine catches it with
 * arithmetic instead — twice.
 *
 * **Before** inference, {@link evaluateEligibility} asks whether the confirmed
 * quad is even the kind of shape UVDoc was trained on. This is the cheap gate:
 * it costs microseconds and saves a 12-second inference on a page that could
 * never have produced a trustworthy map.
 *
 * **After** inference, {@link evaluateComposedMap} interrogates the composed
 * map itself — not the model's raw output, because a plausible-looking grid
 * over a badly-chosen crop still composes to nonsense. Every check is a
 * rejection, never a repair: clamping an out-of-bounds coordinate would turn a
 * broken map into a smeared page, which is exactly the failure the user cannot
 * see and cannot report.
 *
 * The map is sampled on the coarse lattice *and* on every cell centre, and its
 * deformation is measured per cell, from the cell's own closed form, at all
 * four corners and the centre. Nodes alone would miss a fold that lives inside
 * a cell; a difference taken *across* a cell border would miss one that lives
 * at a node, because the derivative there is genuinely two-valued and averaging
 * the two sides hides exactly the sign change being looked for.
 */

import {
  cropDiagonal,
  cropIdentityPoint,
  quadDiagonal,
} from "./crop.ts";
import { cellJacobian, composeInto, type CoarseGrid } from "./grid.ts";
import type { CropBox, DewarpPoint, DewarpQuad } from "./types.ts";
import { QUAD_CORNERS } from "./types.ts";

/* ── Pre-inference: is this quad worth a model run? ─────────────────────── */

/**
 * Quad area over bounding-box area.
 *
 * A rectangle seen straight on is 1.0; a strongly perspective-skewed page is
 * still ~0.7. Below 0.55 the "page" is a sliver or a wedge — either a bad
 * detection or a photograph so oblique that the crop is mostly table, and the
 * model has never seen either.
 */
export const MIN_QUAD_FILL = 0.55;

/**
 * Internal angles, in degrees.
 *
 * A page corner is 90° plus perspective. [25°,155°] is generous — it still
 * admits a hard three-quarter view — while excluding the degenerate shapes
 * (a near-collinear triple) where the output-size rule stops describing a
 * page at all.
 */
export const MIN_INTERNAL_ANGLE_DEG = 25;
export const MAX_INTERNAL_ANGLE_DEG = 155;

/**
 * Longer over shorter, for each pair of opposite edges.
 *
 * Perspective shortens the far edge; 2.5:1 is past anything a document photo
 * produces and into "these four corners are not a quadrilateral of one page".
 */
export const MAX_OPPOSITE_EDGE_RATIO = 2.5;

/**
 * Resolution floor for the crop, in canonical pixels.
 *
 * A native-resolution pipeline has no fixed network input to avoid upsampling
 * into — its own S0 stage upscales internally, capped at 3×, same as the
 * Python reference — but a crop this tiny still makes text-line/CC detection
 * meaningless. 96px pre-upscale keeps the internal 3× cap at ≥288px on the
 * short side, comfortably above what `textline.rs`'s CC filters need.
 */
export const CLASSICAL_MIN_CROP_SIDE_PX = 96;

export type EligibilityFailure =
  | "quad-fill"
  | "quad-angle"
  | "quad-edge-ratio"
  | "crop-resolution";

export interface EligibilityStats {
  fill: number;
  minAngleDeg: number;
  maxAngleDeg: number;
  maxOppositeEdgeRatio: number;
  minCropSide: number;
}

export interface EligibilityResult {
  eligible: boolean;
  failure?: EligibilityFailure;
  stats: EligibilityStats;
}

function corners(quad: DewarpQuad): DewarpPoint[] {
  return QUAD_CORNERS.map((key) => quad[key]);
}

function shoelaceArea(points: DewarpPoint[]): number {
  let doubled = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    doubled += a.x * b.y - b.x * a.y;
  }
  return Math.abs(doubled) / 2;
}

function internalAngles(points: DewarpPoint[]): number[] {
  return points.map((corner, index) => {
    const before = points[(index + points.length - 1) % points.length];
    const after = points[(index + 1) % points.length];
    const ax = before.x - corner.x;
    const ay = before.y - corner.y;
    const bx = after.x - corner.x;
    const by = after.y - corner.y;
    const norm = Math.max(1e-9, Math.hypot(ax, ay) * Math.hypot(bx, by));
    const cosine = Math.max(-1, Math.min(1, (ax * bx + ay * by) / norm));
    return (Math.acos(cosine) * 180) / Math.PI;
  });
}

function edgeLengths(points: DewarpPoint[]): number[] {
  return points.map((point, index) => {
    const next = points[(index + 1) % points.length];
    return Math.hypot(next.x - point.x, next.y - point.y);
  });
}

function ratio(a: number, b: number): number {
  const low = Math.min(a, b);
  return low <= 1e-9 ? Number.POSITIVE_INFINITY : Math.max(a, b) / low;
}

/**
 * The cheap gate: refuse the engine run rather than spend it on a bad shape.
 *
 * `minCropSidePx` stays a parameter rather than a baked-in constant so the
 * floor can be exercised at both sides of the boundary without a second copy
 * of the gate.
 */
export function evaluateEligibility(
  quad: DewarpQuad,
  crop: CropBox,
  minCropSidePx: number = CLASSICAL_MIN_CROP_SIDE_PX,
): EligibilityResult {
  const points = corners(quad);
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const boxArea =
    (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
  const fill = boxArea <= 1e-9 ? 0 : shoelaceArea(points) / boxArea;

  const angles = internalAngles(points);
  const minAngleDeg = Math.min(...angles);
  const maxAngleDeg = Math.max(...angles);

  // Edges in `QUAD_CORNERS` order: top, right, bottom, left.
  const [top, right, bottom, left] = edgeLengths(points);
  const maxOppositeEdgeRatio = Math.max(ratio(top, bottom), ratio(left, right));

  const minCropSide = Math.min(crop.width, crop.height);

  const stats: EligibilityStats = {
    fill,
    minAngleDeg,
    maxAngleDeg,
    maxOppositeEdgeRatio,
    minCropSide,
  };

  if (fill < MIN_QUAD_FILL) return { eligible: false, failure: "quad-fill", stats };
  if (minAngleDeg < MIN_INTERNAL_ANGLE_DEG || maxAngleDeg > MAX_INTERNAL_ANGLE_DEG) {
    return { eligible: false, failure: "quad-angle", stats };
  }
  if (maxOppositeEdgeRatio > MAX_OPPOSITE_EDGE_RATIO) {
    return { eligible: false, failure: "quad-edge-ratio", stats };
  }
  if (minCropSide < minCropSidePx) {
    return { eligible: false, failure: "crop-resolution", stats };
  }
  return { eligible: true, stats };
}

/* ── Post-inference: is this composed map a page? ───────────────────────── */

/**
 * How far outside the canonical image a sample may land, in pixels.
 *
 * One pixel of slack absorbs the float error of two `align_corners`
 * conversions on a 3000 px image. Anything past it is rejected outright: the
 * alternative, clamping, would replace the page's edge with a stripe of the
 * last row repeated, which reads as a real (and wrong) scan.
 */
export const BOUNDS_EPSILON_PX = 1;

/**
 * Normalised Jacobian determinant floor.
 *
 * The Jacobian is divided by the flat crop's own, so 1.0 is "no deformation".
 * Requiring it to stay positive is the fold test — a fold is the instant the
 * determinant crosses zero — and 1e-3 keeps it clear of the numerically
 * meaningless region just above.
 */
export const MIN_NORMALIZED_JACOBIAN = 1e-3;

/**
 * Normalised singular-value band.
 *
 * The singular values of the normalised Jacobian are the local stretch factors
 * along the map's own axes. A real page curvature moves them a few per cent;
 * [0.5, 2.0] allows a 2× local stretch, which is already more than a sheet of
 * paper can do, and rejects the collapse-to-a-line and blow-up-a-cell failures
 * that a bad grid produces.
 */
export const MIN_NORMALIZED_SINGULAR = 0.5;
export const MAX_NORMALIZED_SINGULAR = 2.0;

/**
 * Displacement against the flat crop, as a fraction of the crop's diagonal.
 *
 * A curved page is a *small* correction: the whole point of the feature is
 * pulling a bent line back onto the straight one, not relocating the page.
 * The three thresholds catch three different failures — a map that drifts
 * everywhere (mean), a map that is fine except for one bad region (p95), and a
 * map with a single wild node (max).
 */
export const MAX_MEAN_DISPLACEMENT_FRACTION = 0.25;
export const MAX_P95_DISPLACEMENT_FRACTION = 0.35;
export const MAX_MAX_DISPLACEMENT_FRACTION = 0.5;

/**
 * How far the map's own corners may sit from the corners the user confirmed,
 * as a fraction of the quad's diagonal.
 *
 * This is the guard that keeps the feature honest about *whose* page it is.
 * The user placed four corners; a map whose output corners land somewhere else
 * has found a different document (a second sheet, a table edge) inside the
 * padded crop, and cropping to it would silently discard what was asked for.
 */
export const MAX_BOUNDARY_OFFSET_FRACTION = 0.05;

/**
 * The same question, asked along the whole edge instead of at its ends.
 *
 * Corners alone are not the boundary: a map can pin all four of them exactly
 * and still pull the middle of each edge inwards — an hourglass — which crops
 * away the margin the user included, and does it in the one place a scan's
 * annotations live. So every output edge is sampled and measured against the
 * quad edge it came from.
 *
 * The threshold is looser than the corner one on purpose, and the asymmetry is
 * the physics: the user's quad joins four corners with *straight* lines, while
 * a genuinely curved page's edge bows away from that chord — which is the very
 * deformation this feature exists to undo. Corners are points the user placed;
 * the edge between them is an approximation they never promised.
 */
export const MAX_EDGE_OFFSET_FRACTION = 0.12;

/** Samples per output edge, ends included — the lattice, plus its midpoints. */
const EDGE_SAMPLES = 65;

export type MapGuardFailure =
  | "nonfinite"
  | "out-of-bounds"
  | "jacobian"
  | "scale"
  | "displacement"
  | "boundary";

export interface MapGuardStats {
  meanDisplacementFraction: number;
  p95DisplacementFraction: number;
  maxDisplacementFraction: number;
  minNormalizedJacobian: number;
  minNormalizedSingular: number;
  maxNormalizedSingular: number;
  maxBoundaryOffsetFraction: number;
  /** The worst deviation of a whole output edge from its quad edge. */
  maxEdgeOffsetFraction: number;
}

export interface MapGuardResult {
  ok: boolean;
  failure?: MapGuardFailure;
  stats: MapGuardStats;
}

const EMPTY_STATS: MapGuardStats = {
  meanDisplacementFraction: Number.POSITIVE_INFINITY,
  p95DisplacementFraction: Number.POSITIVE_INFINITY,
  maxDisplacementFraction: Number.POSITIVE_INFINITY,
  minNormalizedJacobian: Number.NEGATIVE_INFINITY,
  minNormalizedSingular: 0,
  maxNormalizedSingular: Number.POSITIVE_INFINITY,
  maxBoundaryOffsetFraction: Number.POSITIVE_INFINITY,
  maxEdgeOffsetFraction: Number.POSITIVE_INFINITY,
};

/** Distance from a point to a segment — the quad edge is a corridor, not a line. */
function segmentDistance(
  point: DewarpPoint,
  from: DewarpPoint,
  to: DewarpPoint,
): number {
  const ex = to.x - from.x;
  const ey = to.y - from.y;
  const lengthSquared = ex * ex + ey * ey;
  const t =
    lengthSquared <= 1e-12
      ? 0
      : Math.max(
          0,
          Math.min(1, ((point.x - from.x) * ex + (point.y - from.y) * ey) / lengthSquared),
        );
  return Math.hypot(point.x - (from.x + t * ex), point.y - (from.y + t * ey));
}

/** Singular values of a 2×2, closed form — no iteration, no library. */
function singularValues(a: number, b: number, c: number, d: number): [number, number] {
  const e = (a + d) / 2;
  const f = (a - d) / 2;
  const g = (b + c) / 2;
  const h = (b - c) / 2;
  const q = Math.hypot(e, h);
  const r = Math.hypot(f, g);
  return [q + r, Math.abs(q - r)];
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const position = fraction * (sorted.length - 1);
  const low = Math.floor(position);
  const high = Math.min(sorted.length - 1, low + 1);
  const weight = position - low;
  return sorted[low] * (1 - weight) + sorted[high] * weight;
}

/**
 * The expensive gate, over the composed map.
 *
 * Failures are reported in severity order (a map that is not finite is not
 * also "displaced"), so the reason a page fell back is always the *first*
 * thing wrong with it.
 */
export function evaluateComposedMap(
  grid: CoarseGrid,
  crop: CropBox,
  quad: DewarpQuad,
  canonicalWidth: number,
  canonicalHeight: number,
): MapGuardResult {
  const diagonal = cropDiagonal(crop);
  if (!(diagonal > 0)) return { ok: false, failure: "nonfinite", stats: EMPTY_STATS };

  const lastColumn = grid.width - 1;
  const lastRow = grid.height - 1;
  const spanX = crop.width - 1;
  const spanY = crop.height - 1;

  const scratch = { x: 0, y: 0 };

  const displacements: number[] = [];
  let minJacobian = Number.POSITIVE_INFINITY;
  let minSingular = Number.POSITIVE_INFINITY;
  let maxSingular = 0;
  let nonFinite = false;
  let outOfBounds = false;

  const visit = (u: number, v: number): void => {
    composeInto(grid, crop, u, v, scratch);
    if (!Number.isFinite(scratch.x) || !Number.isFinite(scratch.y)) {
      nonFinite = true;
      return;
    }
    if (
      scratch.x < -BOUNDS_EPSILON_PX ||
      scratch.y < -BOUNDS_EPSILON_PX ||
      scratch.x > canonicalWidth - 1 + BOUNDS_EPSILON_PX ||
      scratch.y > canonicalHeight - 1 + BOUNDS_EPSILON_PX
    ) {
      outOfBounds = true;
    }

    const flat = cropIdentityPoint(crop, u, v);
    displacements.push(
      Math.hypot(scratch.x - flat.x, scratch.y - flat.y) / diagonal,
    );
  };

  /**
   * The deformation at one place inside one cell, from the cell's own maths.
   *
   * Every cell is measured at all four of its corners and at its centre. The
   * corners are where it matters: the derivative is two-valued across a cell
   * border, so a cell can fold at the node it shares with three healthy
   * neighbours while any averaged reading of that node stays comfortably
   * positive.
   */
  const deform = (column: number, row: number, a: number, b: number): void => {
    const jacobian = cellJacobian(grid, crop, column, row, a, b);
    // Normalised by the flat crop's own Jacobian, so 1.0 means "unchanged"
    // whatever the page's pixel size.
    const m00 = jacobian.dxdu / Math.max(1e-9, spanX);
    const m01 = jacobian.dxdv / Math.max(1e-9, spanY);
    const m10 = jacobian.dydu / Math.max(1e-9, spanX);
    const m11 = jacobian.dydv / Math.max(1e-9, spanY);
    if (![m00, m01, m10, m11].every(Number.isFinite)) {
      nonFinite = true;
      return;
    }

    const determinant = m00 * m11 - m01 * m10;
    if (determinant < minJacobian) minJacobian = determinant;
    const [high, low] = singularValues(m00, m01, m10, m11);
    if (low < minSingular) minSingular = low;
    if (high > maxSingular) maxSingular = high;
  };

  for (let row = 0; row <= lastRow; row += 1) {
    const v = lastRow === 0 ? 0 : row / lastRow;
    for (let column = 0; column <= lastColumn; column += 1) {
      visit(lastColumn === 0 ? 0 : column / lastColumn, v);
    }
  }
  for (let row = 0; row < lastRow; row += 1) {
    const v = (row + 0.5) / lastRow;
    for (let column = 0; column < lastColumn; column += 1) {
      visit((column + 0.5) / lastColumn, v);
    }
  }
  for (let row = 0; row < Math.max(1, lastRow); row += 1) {
    for (let column = 0; column < Math.max(1, lastColumn); column += 1) {
      deform(column, row, 0, 0);
      deform(column, row, 1, 0);
      deform(column, row, 0, 1);
      deform(column, row, 1, 1);
      deform(column, row, 0.5, 0.5);
    }
  }

  const sorted = [...displacements].sort((a, b) => a - b);
  const mean =
    displacements.reduce((total, value) => total + value, 0) /
    Math.max(1, displacements.length);

  const quadSpan = Math.max(1e-9, quadDiagonal(quad));
  let maxBoundary = 0;
  const boundaryProbes: Array<[number, number, DewarpPoint]> = [
    [0, 0, quad.topLeft],
    [1, 0, quad.topRight],
    [1, 1, quad.bottomRight],
    [0, 1, quad.bottomLeft],
  ];
  for (const [u, v, expected] of boundaryProbes) {
    composeInto(grid, crop, u, v, scratch);
    const offset =
      Math.hypot(scratch.x - expected.x, scratch.y - expected.y) / quadSpan;
    if (!Number.isFinite(offset)) nonFinite = true;
    else if (offset > maxBoundary) maxBoundary = offset;
  }

  // Each output edge against the quad edge it claims to be, end to end.
  let maxEdge = 0;
  const edges: Array<[DewarpPoint, DewarpPoint, (t: number) => [number, number]]> = [
    [quad.topLeft, quad.topRight, (t) => [t, 0]],
    [quad.topRight, quad.bottomRight, (t) => [1, t]],
    [quad.bottomLeft, quad.bottomRight, (t) => [t, 1]],
    [quad.topLeft, quad.bottomLeft, (t) => [0, t]],
  ];
  for (const [from, to, at] of edges) {
    for (let step = 0; step < EDGE_SAMPLES; step += 1) {
      const [u, v] = at(step / (EDGE_SAMPLES - 1));
      composeInto(grid, crop, u, v, scratch);
      const offset = segmentDistance(scratch, from, to) / quadSpan;
      if (!Number.isFinite(offset)) nonFinite = true;
      else if (offset > maxEdge) maxEdge = offset;
    }
  }

  const stats: MapGuardStats = {
    meanDisplacementFraction: mean,
    p95DisplacementFraction: percentile(sorted, 0.95),
    maxDisplacementFraction: sorted.length === 0 ? 0 : sorted[sorted.length - 1],
    minNormalizedJacobian: minJacobian,
    minNormalizedSingular: minSingular,
    maxNormalizedSingular: maxSingular,
    maxBoundaryOffsetFraction: maxBoundary,
    maxEdgeOffsetFraction: maxEdge,
  };

  if (nonFinite) return { ok: false, failure: "nonfinite", stats };
  if (outOfBounds) return { ok: false, failure: "out-of-bounds", stats };
  if (minJacobian <= MIN_NORMALIZED_JACOBIAN) {
    return { ok: false, failure: "jacobian", stats };
  }
  if (
    minSingular < MIN_NORMALIZED_SINGULAR ||
    maxSingular > MAX_NORMALIZED_SINGULAR
  ) {
    return { ok: false, failure: "scale", stats };
  }
  if (
    stats.meanDisplacementFraction > MAX_MEAN_DISPLACEMENT_FRACTION ||
    stats.p95DisplacementFraction > MAX_P95_DISPLACEMENT_FRACTION ||
    stats.maxDisplacementFraction > MAX_MAX_DISPLACEMENT_FRACTION
  ) {
    return { ok: false, failure: "displacement", stats };
  }
  if (
    maxBoundary > MAX_BOUNDARY_OFFSET_FRACTION ||
    maxEdge > MAX_EDGE_OFFSET_FRACTION
  ) {
    return { ok: false, failure: "boundary", stats };
  }
  return { ok: true, stats };
}
