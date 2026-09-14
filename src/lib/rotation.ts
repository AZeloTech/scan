/**
 * Page rotation: the model, and the geometry that makes it show up on screen.
 *
 * A page photographed sideways is not a broken page — the pixels are fine, the
 * paper was just held the other way. The turn is baked into the
 * page's own render (`lib/page-processing.ts`), as an exact quarter-turn pixel
 * permutation: the review screen and the PDF then show the same upright bytes,
 * OCR reads upright text, and nothing is re-encoded at build time to get there.
 *
 * The geometry below is still needed for the window between the tap and that
 * render landing, where the current picture is turned in CSS so "Girar" feels
 * instant (`scan-store.ts:displayRotation`). It exists because rotating an
 * element by 90° swaps the axes
 * of the box it occupies: a 56×74 thumbnail rotated a quarter turn wants 74×56
 * of space, and without a compensating scale it spills over its neighbours.
 * {@link rotatedFitScale} returns the factor that puts it back inside its
 * frame — one number, applied in the same `transform` as the rotation — and
 * {@link rotatedObjectFit} is why that factor never has to crop.
 */

/** Quarter turns clockwise. Nothing else is representable, by construction. */
export type PageRotation = 0 | 90 | 180 | 270;

/** Width/height of a frame or an image, in CSS pixels. */
export interface RotationBox {
  width: number;
  height: number;
}

/** How the `<img>` fills its frame — the same vocabulary as `object-fit`. */
export type RotationFit = "cover" | "contain";

/** One tap of "Girar": a quarter turn clockwise, wrapping at a full circle. */
export function nextRotation(current: PageRotation): PageRotation {
  switch (current) {
    case 0:
      return 90;
    case 90:
      return 180;
    case 180:
      return 270;
    case 270:
      return 0;
  }
}

/**
 * One tap of "girar ↺": a quarter turn anticlockwise.
 *
 * The finish screen offers both directions because a page held the *other* way
 * is three taps away from upright with a clockwise-only control — and three
 * taps on a 12 MP preview is where a cheap Android starts to feel broken.
 */
export function previousRotation(current: PageRotation): PageRotation {
  switch (current) {
    case 0:
      return 270;
    case 90:
      return 0;
    case 180:
      return 90;
    case 270:
      return 180;
  }
}

function isPositive(box: RotationBox | null): box is RotationBox {
  return box !== null && box.width > 0 && box.height > 0;
}

/**
 * How the image should actually be fitted once the turn is applied.
 *
 * **A quarter turn always becomes `contain`, even in a `cover` frame.** Cover
 * already crops the page to the frame's shape; turning that crop a quarter and
 * then scaling it back up to keep covering crops it a second time, on the other
 * axis, and a portrait page in a portrait tile ends up showing about a third of
 * itself. A turned page is one the user just told us they want to read, so the
 * whole of it is shown, letterboxed against the frame's existing background.
 * Half turns keep the caller's choice: the box is unchanged, so cover still
 * covers exactly as much as it did.
 */
export function rotatedObjectFit(
  rotation: PageRotation,
  fit: RotationFit,
): RotationFit {
  return rotation === 90 || rotation === 270 ? "contain" : fit;
}

/**
 * The scale that keeps a rotated image inside the frame it was laid out in.
 *
 * Half turns need none: the box is unchanged. A quarter turn swaps it, and
 * since the turned image is rendered `contain` (see {@link rotatedObjectFit}),
 * the fit is computed against the *content* box — the image letterboxed inside
 * the frame — rather than the frame itself. A landscape photo turned upright
 * then grows to use the height it just gained instead of staying at the width
 * it no longer needs.
 *
 * `natural` is the image's intrinsic size; pass null before it has loaded and
 * the frame is assumed (correct, merely conservative).
 */
export function rotatedFitScale(
  rotation: PageRotation,
  frame: RotationBox,
  natural: RotationBox | null,
): number {
  if (rotation === 0 || rotation === 180) return 1;
  if (!isPositive(frame)) return 1;
  const { width, height } = frame;

  let contentWidth = width;
  let contentHeight = height;
  if (isPositive(natural)) {
    const containScale = Math.min(width / natural.width, height / natural.height);
    contentWidth = natural.width * containScale;
    contentHeight = natural.height * containScale;
  }
  if (contentWidth <= 0 || contentHeight <= 0) return 1;
  return Math.min(width / contentHeight, height / contentWidth);
}

/**
 * Degrees to tween to, so the picture turns the way the button promised.
 *
 * The model wraps (270 → 0 clockwise, 0 → 270 anticlockwise); the animation
 * must not, or the page unwinds three quarters the wrong way while the control
 * that triggered it said otherwise. Callers keep a cumulative angle and hand it
 * back here on every turn.
 *
 * The direction is **inferred from the shortest arc** rather than passed in,
 * which is exact for the only moves that exist: every control turns the page by
 * exactly one quarter, so the short way round is always the way the user asked
 * for. (A half turn is two taps, and ±180 look identical.)
 */
export function turnDegrees(
  currentDegrees: number,
  applied: PageRotation,
  next: PageRotation,
): number {
  const forward = (next - applied + 360) % 360;
  return currentDegrees + (forward > 180 ? forward - 360 : forward);
}
