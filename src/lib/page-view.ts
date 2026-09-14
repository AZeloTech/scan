/**
 * What the viewer is showing right now: one picture, and the turn it is wearing.
 *
 * The two belong together and the app kept letting them come apart. A turn is
 * instant in CSS while the render that bakes it into the page's own pixels is
 * still working (`lib/rotation.ts`), so for a few hundred milliseconds the
 * angle on screen lives in a transform. When the render lands, the same commit
 * is supposed to move those degrees out of the transform and into the bytes —
 * nothing changes on screen, which is the entire point.
 *
 * It only holds if the new bytes are *on screen* by then. They are not: an
 * `<img>` handed a fresh object URL keeps painting the old bitmap until the new
 * one has decoded, which on a 12 MP phone photo is many frames. Drop the
 * transform in that window and the viewer shows the picture it had before the
 * turn, un-turned — the page visibly snaps back to where it started and then
 * pops upright when the decode finishes. That is the "flick".
 *
 * So the pair advances together or not at all: hold the picture the viewer is
 * already showing, at the angle it is already wearing, until the incoming
 * bitmap can be painted in the same frame its angle changes.
 */

import type { PageRotation } from "@/lib/rotation";

/** A picture and the turn it is wearing — never one without the other. */
export interface PageView {
  /** The object URL the `<img>` is pointing at. `null` before the first one. */
  readonly url: string | null;
  /** The CSS turn that picture still needs, in degrees. */
  readonly rotation: PageRotation;
}

/**
 * How the view changed, which is what tells the viewer whether to animate.
 *
 * - `none` — nothing to do.
 * - `turn` — the user turned the page. The picture is the same one; the
 *   degrees are the stand-in the render has not caught up with yet. **Animate**
 *   this: it is the direct answer to a tap.
 * - `handover` — the render caught up. New bytes, and the degrees that were in
 *   the transform are now in them. Nothing changes on screen, so nothing may
 *   move: **place** this, never tween it. Animating it is a second quarter turn
 *   a few hundred milliseconds after the one the user asked for — backwards.
 */
export type PageViewChange = "none" | "turn" | "handover";

export interface PageViewStep {
  readonly view: PageView;
  readonly change: PageViewChange;
}

/**
 * The next thing to show, given what is shown now and what the store offers.
 *
 * `decoded` is the caller's answer to "can the incoming picture be painted this
 * frame?". Until it is `true` a new picture is simply not taken — the old pair
 * stands, whole and consistent, and the user sees the page they turned holding
 * still rather than flicking back to where it started.
 *
 * A turn on the *same* picture is always taken immediately: those degrees are
 * the CSS stand-in, and making the user wait for a decode to see their own tap
 * answered is the delay the stand-in exists to hide.
 */
export function stepPageView(
  current: PageView,
  incoming: PageView,
  decoded: boolean,
): PageViewStep {
  if (incoming.url === current.url) {
    // The same bytes. Only the stand-in angle can have moved.
    if (incoming.rotation === current.rotation) {
      return { view: current, change: "none" };
    }
    return { view: incoming, change: "turn" };
  }
  // Undecoded is undecoded whether or not there is a picture to hold: with one,
  // taking it would flick; without one, it would paint an empty box the `<img>`
  // cannot fill yet. Either way the pair does not advance.
  if (!decoded) return { view: current, change: "none" };
  return { view: incoming, change: "handover" };
}
