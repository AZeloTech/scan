"use client";

/**
 * Quad geometry, in ONE coordinate system.
 *
 * The live detector works on a ~640 px sample, the overlay is painted over a
 * CSS box that `object-cover` has cropped, and the warp happens on a ≤3000 px
 * capture. Three different pixel grids for the same four corners — so nothing
 * outside this module ever carries corners in pixels for longer than one call:
 * everything in between speaks {@link NormalizedQuad}, fractions of the frame.
 *
 * The one axis-scaling subtlety: fractions are anisotropic (0.01 of the width
 * is not 0.01 of the height on a 16:9 frame), so every *distance* here is
 * expressed in **frame-width units** — y multiplied by the aspect (h/w) — and
 * compared against the frame diagonal in the same units.
 */

import type { CornerPoints, Point } from "scanic";

export const CORNER_KEYS = [
  "topLeft",
  "topRight",
  "bottomRight",
  "bottomLeft",
] as const;

export type CornerKey = (typeof CORNER_KEYS)[number];

/** The four corners as fractions of the frame: 0–1 on each axis. */
export interface NormalizedQuad {
  topLeft: Point;
  topRight: Point;
  bottomRight: Point;
  bottomLeft: Point;
}

/**
 * The whole frame, as a quad: no crop, no perspective correction.
 *
 * For the photo that arrives already cropped — a gallery pick, usually — where
 * hunting for four corners inside a picture whose corners ARE the page's is
 * work the user should not have to do. The render still runs its normal pass
 * over it; the map it applies is simply the identity one.
 *
 * A real quad rather than `null`, and the difference matters: `null` means "we
 * found no outline", which the page reports as `bordas não encontradas` and
 * asks the user to fix. This is the user's own answer, so the page says nothing.
 *
 * Clockwise from the top-left in the same **y-down** fractions everything else
 * here speaks — `y: 1` is the bottom edge of the image, not the top of a maths
 * plane. Reading it the other way silently flips the page.
 */
export const FULL_FRAME_QUAD: NormalizedQuad = {
  topLeft: { x: 0, y: 0 },
  topRight: { x: 1, y: 0 },
  bottomRight: { x: 1, y: 1 },
  bottomLeft: { x: 0, y: 1 },
};

/** Clockwise from the top-left — the winding both scanic and the SVG expect. */
export function cornerList(quad: NormalizedQuad | CornerPoints): Point[] {
  return CORNER_KEYS.map((key) => quad[key]);
}

function shoelaceArea(points: Point[]): number {
  let doubled = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    doubled += a.x * b.y - b.x * a.y;
  }
  return Math.abs(doubled) / 2;
}

/** Share of the frame a pixel-space quad covers (0–1). */
export function quadCoverage(
  corners: CornerPoints,
  width: number,
  height: number,
): number {
  const frame = width * height;
  return frame > 0 ? shoelaceArea(cornerList(corners)) / frame : 0;
}

/** The same share for a normalized quad — the frame's own area is exactly 1. */
export function normalizedCoverage(quad: NormalizedQuad): number {
  return shoelaceArea(cornerList(quad));
}

export function normalizeQuad(
  corners: CornerPoints,
  width: number,
  height: number,
): NormalizedQuad | null {
  if (width <= 0 || height <= 0) return null;
  return {
    topLeft: { x: corners.topLeft.x / width, y: corners.topLeft.y / height },
    topRight: { x: corners.topRight.x / width, y: corners.topRight.y / height },
    bottomRight: {
      x: corners.bottomRight.x / width,
      y: corners.bottomRight.y / height,
    },
    bottomLeft: {
      x: corners.bottomLeft.x / width,
      y: corners.bottomLeft.y / height,
    },
  };
}

/** Back to pixels — for scanic's `extractDocument`, at whatever size we hold. */
export function denormalizeQuad(
  quad: NormalizedQuad,
  width: number,
  height: number,
): CornerPoints {
  return {
    topLeft: { x: quad.topLeft.x * width, y: quad.topLeft.y * height },
    topRight: { x: quad.topRight.x * width, y: quad.topRight.y * height },
    bottomRight: {
      x: quad.bottomRight.x * width,
      y: quad.bottomRight.y * height,
    },
    bottomLeft: { x: quad.bottomLeft.x * width, y: quad.bottomLeft.y * height },
  };
}

function lerpPoint(from: Point, to: Point, amount: number): Point {
  return {
    x: from.x + (to.x - from.x) * amount,
    y: from.y + (to.y - from.y) * amount,
  };
}

/** Eases the drawn quad toward the latest detection, corner by corner. */
export function lerpQuad(
  from: NormalizedQuad,
  to: NormalizedQuad,
  amount: number,
): NormalizedQuad {
  return {
    topLeft: lerpPoint(from.topLeft, to.topLeft, amount),
    topRight: lerpPoint(from.topRight, to.topRight, amount),
    bottomRight: lerpPoint(from.bottomRight, to.bottomRight, amount),
    bottomLeft: lerpPoint(from.bottomLeft, to.bottomLeft, amount),
  };
}

/**
 * Adjacent-frame averaging for the live detector.
 *
 * Scanic detects each frame independently. On a stationary page it can switch
 * between two equally plausible edge pixels (or two near-tied contours), and
 * sending each answer straight to the animation makes the outline chase that
 * high-frequency noise. Averaging the newest detection with the previous RAW
 * detection is a two-sample low-pass filter: an A/B/A/B edge toggle resolves
 * to the same midpoint instead of becoming visible motion.
 *
 * The filter deliberately stops smoothing when detections are 500 ms apart.
 * At that cadence the half-frame lag would be more distracting than the
 * occasional jump, while healthy 8/4 fps loops add only 62.5–125 ms of lag.
 */
const DETECTION_SMOOTHING_MAX_GAP_MS = 500;

export class QuadDetectionSmoother {
  private previous: NormalizedQuad | null = null;
  private previousAt = Number.NEGATIVE_INFINITY;

  update(next: NormalizedQuad, now: number): NormalizedQuad {
    const elapsed = now - this.previousAt;
    const previous = this.previous;
    const canSmooth =
      previous !== null &&
      Number.isFinite(elapsed) &&
      elapsed > 0 &&
      elapsed < DETECTION_SMOOTHING_MAX_GAP_MS;
    const result = canSmooth
      ? lerpQuad(
          previous,
          next,
          Math.max(
            0.5,
            Math.min(1, elapsed / DETECTION_SMOOTHING_MAX_GAP_MS),
          ),
        )
      : next;
    this.previous = next;
    this.previousAt = now;
    return result;
  }

  reset(): void {
    this.previous = null;
    this.previousAt = Number.NEGATIVE_INFINITY;
  }
}

/** Frame diagonal in frame-width units, for an `aspect` of height/width. */
export function frameDiagonal(aspect: number): number {
  return Math.hypot(1, aspect);
}

/** Largest single-corner displacement between two quads, in frame-width units. */
export function maxCornerShift(
  a: NormalizedQuad,
  b: NormalizedQuad,
  aspect: number,
): number {
  let largest = 0;
  for (const key of CORNER_KEYS) {
    const shift = Math.hypot(a[key].x - b[key].x, (a[key].y - b[key].y) * aspect);
    if (shift > largest) largest = shift;
  }
  return largest;
}

/** `points` for an SVG polygon drawn inside a `0 0 1 1` viewBox. */
export function quadPoints(quad: NormalizedQuad): string {
  return cornerList(quad)
    .map((point) => `${point.x.toFixed(5)},${point.y.toFixed(5)}`)
    .join(" ");
}

/** Below this a segment is a dot, not a mark: skip it rather than draw it. */
const MIN_BRACKET_LENGTH = 1e-4;

/**
 * The ceiling on one bracket, in the units the overlay is actually drawn in.
 *
 * The overlay's `0 0 1 1` viewBox is stretched onto the rendered frame box with
 * `preserveAspectRatio: none`, so one viewBox unit is `width` px across and
 * `height` px down: a cap expressed in viewBox units is a different number of
 * pixels on each axis, and on a 16:9 frame a horizontal mark comes out nearly
 * twice the length of a vertical one. The cap therefore travels with the box it
 * is measured against and is converted per segment, along that segment's own
 * direction.
 *
 * `width === height` means "no stretch": the cap is then read in viewBox units,
 * which is what a caller that has not measured the frame yet wants.
 */
export interface BracketCap {
  /** Longest a drawn segment may be, in the box's own units (px). */
  length: number;
  /** The rendered box one viewBox unit maps onto. */
  width: number;
  height: number;
}

/**
 * The four corner brackets of the live overlay, as one SVG `d` for the same
 * `0 0 1 1` viewBox {@link quadPoints} writes into.
 *
 * Each corner gets two segments that start ON the corner and run along its two
 * real edges, so the brackets lean with the page instead of staying square to
 * the screen — the thing a static bracket cannot do and the reason they replace
 * the filled polygon.
 *
 * A segment is `fraction` of its own edge, capped at {@link BracketCap}:
 * proportional so a small quad gets small marks, capped so a page filling the
 * frame does not get brackets long enough to read as a whole outline.
 * `fraction` is clamped to half an edge — past that the two brackets of one
 * edge would meet and the "corner" reading would be gone.
 */
export function cornerBracketPath(
  quad: NormalizedQuad,
  fraction: number,
  cap: BracketCap,
): string {
  const corners = cornerList(quad);
  const share = Math.max(0, Math.min(0.5, fraction));
  const capLength = Math.max(0, cap.length);
  const segments: string[] = [];
  for (let index = 0; index < corners.length; index += 1) {
    const corner = corners[index];
    const neighbours = [
      corners[(index + corners.length - 1) % corners.length],
      corners[(index + 1) % corners.length],
    ];
    for (const neighbour of neighbours) {
      const dx = neighbour.x - corner.x;
      const dy = neighbour.y - corner.y;
      const edge = Math.hypot(dx, dy);
      if (edge === 0) continue;
      // Drawn units per viewBox unit *along this segment* — the conversion the
      // anisotropic stretch makes direction-dependent.
      const drawnPerUnit = Math.hypot(
        (dx / edge) * cap.width,
        (dy / edge) * cap.height,
      );
      const capNorm = drawnPerUnit > 0 ? capLength / drawnPerUnit : 0;
      const reach = Math.min(edge * share, capNorm);
      if (reach < MIN_BRACKET_LENGTH) continue;
      const step = reach / edge;
      segments.push(
        `M${corner.x.toFixed(5)},${corner.y.toFixed(5)}` +
          `L${(corner.x + dx * step).toFixed(5)},${(corner.y + dy * step).toFixed(5)}`,
      );
    }
  }
  return segments.join(" ");
}
