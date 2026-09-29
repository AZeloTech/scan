import { CORNER_KEYS, type NormalizedQuad } from "@/lib/quad";

/**
 * The photo is checked before it is offered (Phase 5a, revision R2).
 *
 * The live loop judges the page on the PREVIEW; the page is made from the
 * STILL — a different pipeline (`ImageCapture.takePhoto`), often at another
 * shape (a 4:3 sensor photo under a 16:9 preview), another field of view
 * (a preview cropped by stabilisation, a photo that is not), sometimes turned
 * a quarter, and taken a few hundred milliseconds after the decision. A page
 * that was fully framed in the viewfinder can therefore come back cut in the
 * photo, and an automatic capture must never be accepted silently when it
 * does: the confirm screen still opens (the owner's rule: every capture is
 * confirmed), flagged with a short reason.
 *
 * Here: the maths that maps a preview quad onto the still
 * ({@link mapPreviewQuadToStill}), the fit that measures how the still's own
 * detection sits against that mapping ({@link fitScaleShift}), and the
 * verdict ({@link checkStill}). Pure — tested without a camera.
 */

type Point = { x: number; y: number };

/** Quarter turns clockwise that take the preview's picture to the still's. */
export type QuarterTurns = 0 | 1 | 2 | 3;

export interface StillMapping {
  /** Preview and still size, in pixels. */
  preview: { width: number; height: number };
  still: { width: number; height: number };
  /** The still is the preview's picture turned this many quarters clockwise (default 0). */
  turns?: QuarterTurns;
  /**
   * The still's field of view over the preview's, along the long edge
   * (default 1): above 1 the photo sees more than the preview (a preview
   * cropped by stabilisation), below 1 less (a zoomed photo pipeline).
   */
  fovScale?: number;
}

/** Why a photo is flagged on the confirm screen. */
export type StillAttention = "no-page" | "corner-outside" | "moved";

/**
 * Turn a point of a `w`×`h` picture a quarter turn clockwise `turns` times,
 * in fractions: answers the point in the turned picture's fractions.
 */
export function turnPoint(p: Point, turns: QuarterTurns): Point {
  switch (turns) {
    case 1:
      return { x: 1 - p.y, y: p.x };
    case 2:
      return { x: 1 - p.x, y: 1 - p.y };
    case 3:
      return { x: p.y, y: 1 - p.x };
    default:
      return { x: p.x, y: p.y };
  }
}

/**
 * A preview quad (fractions of the preview frame) in fractions of the still.
 *
 * The camera model every phone pipeline shares: one lens, one optical centre,
 * both pictures centred on it. After turning the preview's picture to the
 * still's orientation, a point is expressed as an angle-like offset from the
 * centre in units of the frame's LONG edge — a 16:9 preview is a crop of the
 * 4:3 sensor's short edge, so the long edges span the same angle — and put
 * back into the still's fractions, `fovScale` times wider.
 *
 * The corner order follows the picture: after a turn the preview's top-left
 * corner is no longer the still's, so the quad is re-labelled by position
 * (top-left = smallest x + y, and so on round).
 */
export function mapPreviewQuadToStill(quad: NormalizedQuad, mapping: StillMapping): NormalizedQuad {
  const turns = mapping.turns ?? 0;
  const fov = mapping.fovScale ?? 1;
  const turned = turns % 2 === 1;
  const pw = turned ? mapping.preview.height : mapping.preview.width;
  const ph = turned ? mapping.preview.width : mapping.preview.height;
  const pl = Math.max(pw, ph);
  const sw = mapping.still.width;
  const sh = mapping.still.height;
  const sl = Math.max(sw, sh);
  const map = (p: Point): Point => {
    const q = turnPoint(p, turns);
    // Offsets from the centre in long-edge units, the same angle on both.
    const ax = ((q.x - 0.5) * pw) / pl;
    const ay = ((q.y - 0.5) * ph) / pl;
    return { x: 0.5 + (ax * sl) / sw / fov, y: 0.5 + (ay * sl) / sh / fov };
  };
  const points = CORNER_KEYS.map((key) => map(quad[key]));
  return relabel(points);
}

/** Four points as a quad, labelled by where they sit (top-left, top-right, …). */
function relabel(points: Point[]): NormalizedQuad {
  const byPos = (score: (p: Point) => number) => points.reduce((best, p) => (score(p) < score(best) ? p : best));
  return {
    topLeft: byPos((p) => p.x + p.y),
    topRight: byPos((p) => -p.x + p.y),
    bottomRight: byPos((p) => -p.x - p.y),
    bottomLeft: byPos((p) => p.x - p.y),
  };
}

/**
 * The scale about the centre and the shift that best take `from` onto `to`
 * (least squares over the four corners, in frame fractions): `to ≈ 0.5 +
 * scale · (from − 0.5) + shift`. `residual` is the RMS corner distance left
 * after that fit, as a share of the frame's diagonal (`aspect` = height over
 * width) — near zero when `to` is `from` seen through a different field of
 * view, large when the photo holds another page or the page moved within it.
 */
export function fitScaleShift(
  from: NormalizedQuad,
  to: NormalizedQuad,
  aspect: number,
): { scale: number; shiftX: number; shiftY: number; residual: number } {
  const a = CORNER_KEYS.map((k) => ({ x: from[k].x - 0.5, y: (from[k].y - 0.5) * aspect }));
  const b = CORNER_KEYS.map((k) => ({ x: to[k].x - 0.5, y: (to[k].y - 0.5) * aspect }));
  const n = a.length;
  const mean = (ps: Point[]) => ({ x: ps.reduce((s, p) => s + p.x, 0) / n, y: ps.reduce((s, p) => s + p.y, 0) / n });
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (a[i].x - ma.x) * (b[i].x - mb.x) + (a[i].y - ma.y) * (b[i].y - mb.y);
    den += (a[i].x - ma.x) ** 2 + (a[i].y - ma.y) ** 2;
  }
  const scale = den > 0 ? num / den : 1;
  const tx = mb.x - scale * ma.x;
  const ty = mb.y - scale * ma.y;
  let sq = 0;
  for (let i = 0; i < n; i += 1) {
    sq += (scale * a[i].x + tx - b[i].x) ** 2 + (scale * a[i].y + ty - b[i].y) ** 2;
  }
  const diagonal = Math.hypot(1, aspect);
  return { scale, shiftX: tx, shiftY: ty / aspect, residual: Math.sqrt(sq / n) / diagonal };
}

/** How far in from the photo's edge every corner must be (fraction of each axis). */
export const STILL_EDGE_MARGIN = 0.004;
/**
 * The largest disagreement between the page the viewfinder showed (mapped
 * onto the photo) and the page found on the photo that still counts as the
 * same page, after the best scale-and-shift between them — as a share of
 * the photo's diagonal. A stabilised preview seen against its photo, a hand
 * that drifted a little during the shutter, and the detector's own few-pixel
 * noise stay well under it; another page, or one that slid half out, does not.
 */
export const STILL_MATCH_RESIDUAL = 0.03;
/** The scale between the two that can still be one field of view against another (EIS, a zoomed pipeline). */
export const STILL_SCALE_RANGE: readonly [number, number] = [0.6, 1.25];
/** How far the page may have shifted in the photo, as a share of each axis, before it is not where the viewfinder had it. */
export const STILL_MAX_SHIFT = 0.12;

export interface StillCheckInput {
  /** The quad the viewfinder vouched for, in preview fractions — null when none travelled. */
  live: NormalizedQuad | null;
  /** The corners the confirm screen will open with, in the photo's fractions — null when none. */
  corners: NormalizedQuad | null;
  /** Whether `corners` were found on the photo itself (else they are the live quad carried over). */
  cornersFromPhoto: boolean;
  mapping: StillMapping;
}

export interface StillCheck {
  attention: StillAttention | null;
  /** The live quad on the photo, when one travelled. */
  mapped: NormalizedQuad | null;
  /** How the photo's own page sits against the mapped one (both present and found on the photo). */
  fit: ReturnType<typeof fitScaleShift> | null;
}

/**
 * The photo's verdict before the confirm screen: `null` attention when it
 * holds the page whole, where the viewfinder had it — else the first reason
 * it does not:
 *
 *  - `no-page`        — no corners at all (the confirm screen will guess);
 *  - `corner-outside` — a corner on or past the photo's edge (the corners
 *                       are clamped to the image, so a cut page sits on the
 *                       border), or the viewfinder's page, mapped onto the
 *                       photo, running off it;
 *  - `moved`          — the page found on the photo is not the viewfinder's
 *                       page seen through the photo's field of view (the
 *                       residual, scale or shift of the best fit is out of
 *                       bounds): another sheet, or the phone moved.
 */
export function checkStill({ live, corners, cornersFromPhoto, mapping }: StillCheckInput): StillCheck {
  const mapped = live === null ? null : mapPreviewQuadToStill(live, mapping);
  const aspect = mapping.still.height / mapping.still.width;
  const inside = (quad: NormalizedQuad) =>
    CORNER_KEYS.every((key) => {
      const p = quad[key];
      return p.x >= STILL_EDGE_MARGIN && p.x <= 1 - STILL_EDGE_MARGIN && p.y >= STILL_EDGE_MARGIN && p.y <= 1 - STILL_EDGE_MARGIN;
    });
  if (corners === null) return { attention: "no-page", mapped, fit: null };
  if (!inside(corners)) return { attention: "corner-outside", mapped, fit: null };
  if (mapped === null || !cornersFromPhoto) {
    // Nothing independent to compare with: the mapped quad (when it is what
    // travelled) still has to fit the photo.
    return { attention: mapped !== null && !inside(mapped) ? "corner-outside" : null, mapped, fit: null };
  }
  const fit = fitScaleShift(mapped, corners, aspect);
  const [lo, hi] = STILL_SCALE_RANGE;
  const moved =
    fit.residual > STILL_MATCH_RESIDUAL ||
    fit.scale < lo ||
    fit.scale > hi ||
    Math.abs(fit.shiftX) > STILL_MAX_SHIFT ||
    Math.abs(fit.shiftY) > STILL_MAX_SHIFT;
  return { attention: moved ? "moved" : null, mapped, fit };
}
