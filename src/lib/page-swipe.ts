/**
 * The page editor's swipe, as arithmetic (`components/PagePreview.tsx`).
 *
 * One pointer on the page means one of three things — a swipe to the
 * neighbouring page, the compare hold, or a tap that opens the page whole —
 * and which one is decided by what the finger does first. The component owns
 * the timers and the pointer capture; the decisions live here, where they can
 * be tested without a DOM.
 */

/** Movement (px, either axis) before a press stops being a tap or a hold. */
export const SWIPE_SLOP = 10;

/** A press held this long without moving is the compare hold. */
export const HOLD_MS = 220;

/**
 * The strip along each side of the screen (px) where a touch belongs to the
 * platform's edge-swipe back gesture (iOS Safari, Android gesture navigation)
 * rather than to the page.
 */
export const EDGE_ZONE_PX = 16;

/** Whether a touch at `x` starts inside the edge-swipe zone of a `viewportWidth` screen. */
export function inEdgeZone(x: number, viewportWidth: number): boolean {
  return x < EDGE_ZONE_PX || x > viewportWidth - EDGE_ZONE_PX;
}

/** How far past a closed end the page still follows the finger: a third, so it gives, then stops. */
export const EDGE_RESISTANCE = 0.3;

/**
 * What a press that has moved `dx`, `dy` has become.
 *
 * `pending` while it is still inside the slop (it may yet be a tap or a hold);
 * past it, a mostly-sideways move on a document with somewhere to go is a
 * swipe, and anything else is `other` — a vertical drag the stage ignores, so a
 * stray scroll never turns the page.
 */
export function pressIntent(
  dx: number,
  dy: number,
  swipeable: boolean,
): "pending" | "swipe" | "other" {
  if (Math.abs(dx) < SWIPE_SLOP && Math.abs(dy) < SWIPE_SLOP) return "pending";
  return swipeable && Math.abs(dx) > Math.abs(dy) ? "swipe" : "other";
}

/**
 * Where the page sits while it is being dragged: under the finger, except
 * towards an end with no page behind it, where it resists.
 */
export function dragOffset(dx: number, canPrev: boolean, canNext: boolean): number {
  const blocked = (dx > 0 && !canPrev) || (dx < 0 && !canNext);
  return blocked ? dx * EDGE_RESISTANCE : dx;
}

/**
 * Where a released swipe goes: `1` to the next page, `-1` to the previous one,
 * `null` to snap back.
 *
 * Far enough is 22 % of the stage (capped at 80 px, so a tablet-wide stage
 * does not ask for a long drag), or a flick — faster than 0.5 px/ms over at
 * least 30 px. A swipe towards an end with no page there always snaps back,
 * however far it went, and so does a cancelled pointer.
 */
export function swipeStep({
  dx,
  ms,
  width,
  canPrev,
  canNext,
  cancelled = false,
}: {
  dx: number;
  ms: number;
  width: number;
  canPrev: boolean;
  canNext: boolean;
  cancelled?: boolean;
}): -1 | 1 | null {
  if (cancelled || dx === 0) return null;
  const distance = Math.abs(dx);
  const speed = distance / Math.max(1, ms);
  const far = distance > Math.min(80, width * 0.22) || (speed > 0.5 && distance > 30);
  if (!far) return null;
  const step: -1 | 1 = dx < 0 ? 1 : -1;
  return (step === 1 ? canNext : canPrev) ? step : null;
}
