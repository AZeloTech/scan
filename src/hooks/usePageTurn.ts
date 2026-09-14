"use client";

import * as React from "react";
import { isSpinning, setSpin, settleSpin, spinTo } from "@/lib/motion";
import { turnDegrees, type PageRotation } from "@/lib/rotation";

/**
 * "Girar", on whatever element is carrying the page.
 *
 * One implementation for both surfaces, which is the point. The phone's page
 * editor and the desktop viewer show the same page from the same store and owe
 * the user the same motion, but each had grown its own: the phone tweened the
 * turn with GSAP and placed the hand-over, while the desktop put a blanket
 * `transition-transform` on the `<img>` and animated *both*. So on a desktop
 * the render catching up played as a second quarter turn, backwards, a few
 * hundred milliseconds after the one the user asked for — the
 * "bounces" it was reported as. A rule that lives in one place cannot be kept on
 * one screen and not the other.
 *
 * The two things this owes the caller, and the reason it is a hook rather than
 * two `useEffect`s copied about:
 *
 *  - **a turn is animated** — it is the direct answer to a tap, and the render
 *    that bakes it into the page's own pixels is still on its way.
 *  - **a hand-over is placed** — nothing changes on screen when the degrees
 *    move out of the transform and into the bytes, so nothing may move.
 *
 * The element must be the one that carries the transform, and nothing else may
 * write to that transform — no `style={{ transform }}`, no `transition-*`
 * class. GSAP owns it.
 */
export interface PageTurnOptions {
  /** The element carrying the turn. GSAP owns its transform. */
  readonly element: React.MutableRefObject<Element | null>;
  /** The CSS turn the picture still needs — `PageView.rotation`. */
  readonly rotation: PageRotation;
  /** `PageView.handover`: bumped by the commit where the render caught up. */
  readonly handover: number;
  /** The fit compensation as state — a commit late, and only for placing. */
  readonly scale: number;
  /** The fit compensation measured now — what the animating paths must use. */
  readonly scaleFor: (rotation: PageRotation) => number;
  /** False while there is no picture to turn. */
  readonly ready: boolean;
  /** A change here is a different page, not a turn of this one. */
  readonly pageId: string;
}

export function usePageTurn({
  element: elementRef,
  rotation,
  handover,
  scale,
  scaleFor,
  ready,
  pageId,
}: PageTurnOptions): void {
  /**
   * Degrees actually on the element, counted up rather than wrapped: tweening
   * the model value 270 → 0 would unwind three quarters the wrong way, and the
   * control that triggered it promised otherwise.
   */
  const spin = React.useRef<{
    degrees: number;
    applied: PageRotation;
    handover: number;
  }>({ degrees: rotation, applied: rotation, handover });

  // Read through refs rather than through the effect's dependency list: the
  // reset below has to see the angles of the page it is arriving on, and a
  // `rotation` dependency would also fire it on every *turn* — which would tell
  // the spin effect the turn had already been applied and place the page
  // instead of animating it.
  const rotationRef = React.useRef(rotation);
  rotationRef.current = rotation;
  const handoverRef = React.useRef(handover);
  handoverRef.current = handover;

  // Declared BEFORE the spin effect so it lands first in the same commit: a new
  // page is a new picture, and animating it from the angle the previous one was
  // leaving would spin a page nobody turned. It is reset to the incoming page's
  // OWN angle, not to zero — starting at zero makes every already-turned page
  // spin into place on arrival, on mount and on every move of the pager.
  React.useEffect(() => {
    spin.current = {
      degrees: rotationRef.current,
      applied: rotationRef.current,
      handover: handoverRef.current,
    };
  }, [pageId]);

  React.useEffect(() => {
    const element = elementRef.current;
    if (element === null || !ready) return;
    if (handover !== spin.current.handover) {
      // The render caught up. The turn the user watched is in the new bytes
      // now, and `rotation` is the difference that is left over — usually none.
      // Place it: animating the hand-over turns the page a second quarter, half
      // a second after the tap, and then unwinds it. Any turn still playing is
      // cancelled by `settleSpin` rather than allowed to finish, because its
      // remaining degrees would be added to pixels that already carry them.
      spin.current = { degrees: rotation, applied: rotation, handover };
      settleSpin(element, rotation, scaleFor(rotation));
      return;
    }
    if (spin.current.applied === rotation) {
      // First paint, and any re-measure of the frame: place, never animate —
      // and never while a turn is mid-flight, which already ends where it must.
      if (!isSpinning(element)) setSpin(element, spin.current.degrees, scale);
      return;
    }
    spin.current = {
      degrees: turnDegrees(spin.current.degrees, spin.current.applied, rotation),
      applied: rotation,
      handover,
    };
    // Measured here rather than read from `scale`: that state still describes
    // the angle we are leaving, and tweening to it lands the page at the wrong
    // size — visibly overflowing its frame at rest on a narrow phone.
    spinTo(element, spin.current.degrees, scaleFor(rotation));
  }, [elementRef, handover, ready, rotation, scale, scaleFor]);
}
