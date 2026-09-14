"use client";

/**
 * The one place GSAP is configured, and the one place the motion vocabulary is
 * defined. Components never import `gsap` directly — they call these helpers,
 * so the rules below hold everywhere by construction:
 *
 *  - **transform and opacity only.** Never width/height/top/left: this app runs
 *    on cheap Androids and a layout-animating property drops frames on them.
 *    Reordering "moves" cards with GSAP Flip, which is still a transform.
 *  - **0.35–0.6s, `power2.out`.** `back.out(1.4)` is reserved for the moments
 *    where the user is watching an object *arrive*: a new thumb, the finished
 *    document. Never for a turn — an overshoot on a quarter turn reads as the
 *    page bouncing off the mark it was asked to land on (see {@link spinTo}).
 *  - **nothing loops.** Every helper here is a one-shot triggered by an event.
 *    The single exception in the app is the CSS spinner, which only exists
 *    while a request is genuinely open.
 *  - **reduced motion collapses to a fade, or to nothing.** Enforced through
 *    `gsap.matchMedia()` for scoped entrances and `prefersReducedMotion()` for
 *    the imperative one-shots — both read the same media query.
 */

import { gsap } from "gsap";
import { Flip } from "gsap/Flip";
import { ScrollTrigger } from "gsap/ScrollTrigger";

if (typeof window !== "undefined") {
  gsap.registerPlugin(Flip, ScrollTrigger);
}

/** The default curve: decelerating, no overshoot, never bouncy. */
export const EASE = "power2.out";
/** Overshoot, used only for "here it is" moments. */
export const POP_EASE = "back.out(1.4)";

export const DURATION = {
  /** Route entrances and micro-feedback. */
  quick: 0.3,
  /**
   * The quarter turn of "Girar". Short on purpose: the turn is a direct answer
   * to a tap, and the render that bakes it into the page's own pixels is
   * already on its way — a long turn is a long wait in front of it.
   */
  spin: 0.28,
  /** The default for anything the user is watching. */
  base: 0.45,
  /** The celebration beat on the finished-document screen. */
  slow: 0.6,
} as const;

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * How far the page shrinks at the halfway point of a turn. A rectangle's
 * bounding box is widest at 45°, so this is what keeps a quarter turn inside a
 * 320px frame while it is happening.
 */
const SPIN_DIP = 0.8;

/**
 * The elements a turn is currently playing on.
 *
 * Not `gsap.isTweening()`, which was the obvious thing and the wrong one: GSAP
 * only counts a tween as tweening once its ticker has *rendered* it, so for the
 * rest of the tick in which {@link spinTo} created it the answer is `false`.
 * The turn is a direct answer to a tap, so the commit that follows it lands in
 * exactly that window — and every caller that asks "is a turn in flight?"
 * before placing the element got told no, and hard-set the page to the angle
 * the tween was still on its way to. The tween then went back and played its
 * arc from the start: the page snapped a quarter turn, jumped backwards, and
 * turned again. That is the "it bounces and flicks" report.
 *
 * A `WeakSet` rather than a flag on the element: the fact belongs to this
 * module, it must not survive the element, and it must be true from the
 * *instant* the tween is created rather than from its first frame.
 */
const spinning = new WeakSet<Element>();

/** True when the user asked the system to calm animations down. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return true;
  const query: unknown = window.matchMedia;
  if (typeof query !== "function") return false;
  return window.matchMedia(REDUCED_QUERY).matches;
}

export interface MotionApi {
  /** `false` when the user prefers reduced motion — build a fade, or nothing. */
  readonly full: boolean;
  readonly gsap: typeof gsap;
}

/**
 * Runs `build` inside a `gsap.matchMedia()` bound to `scope`, so every tween it
 * creates is reverted when the component unmounts or the media query flips.
 * Returns the cleanup the caller hands back to React.
 */
export function motionScope(
  scope: Element | null,
  build: (api: MotionApi) => void,
): () => void {
  if (scope === null || typeof window === "undefined") return () => {};
  const media = gsap.matchMedia();
  media.add(
    {
      full: "(prefers-reduced-motion: no-preference)",
      reduced: REDUCED_QUERY,
    },
    (context) => {
      const conditions = context.conditions as
        | { full?: boolean; reduced?: boolean }
        | undefined;
      build({ full: conditions?.full === true, gsap });
    },
    scope,
  );
  return () => {
    media.revert();
  };
}

// ── entrances ────────────────────────────────────────────────────────────────

export interface RiseOptions {
  /** Travel distance in px. Collapsed to 0 under reduced motion. */
  y?: number;
  stagger?: number;
  duration?: number;
  delay?: number;
}

/**
 * The house entrance: content rises a few px while fading in. Under reduced
 * motion it is a plain opacity fade with no travel — the same information
 * arrives, just without the movement.
 */
export function rise(
  api: MotionApi,
  targets: gsap.TweenTarget,
  options: RiseOptions = {},
): void {
  const {
    y = 14,
    stagger = 0,
    duration = DURATION.quick,
    delay = 0,
  } = options;
  api.gsap.from(targets, {
    opacity: 0,
    y: api.full ? y : 0,
    duration: api.full ? duration : DURATION.quick,
    delay,
    stagger: api.full ? stagger : 0,
    ease: EASE,
    clearProps: "opacity,transform",
  });
}

// ── one-shot feedback ────────────────────────────────────────────────────────

/** A new page landing in the thumbnail rail. */
export function popIn(element: Element | null): void {
  if (element === null) return;
  if (prefersReducedMotion()) {
    gsap.from(element, { opacity: 0, duration: DURATION.quick, ease: EASE });
    return;
  }
  gsap.from(element, {
    opacity: 0,
    scale: 0.6,
    y: 12,
    duration: DURATION.base,
    ease: POP_EASE,
    transformOrigin: "center bottom",
    clearProps: "transform",
  });
}

/** The verdict chip changing under a thumb: the new state pops, the old goes. */
export function swapIn(element: Element | null): void {
  if (element === null) return;
  if (prefersReducedMotion()) {
    gsap.from(element, { opacity: 0, duration: 0.2, ease: EASE });
    return;
  }
  gsap.from(element, {
    opacity: 0,
    scale: 0.5,
    duration: DURATION.quick,
    ease: POP_EASE,
    transformOrigin: "center center",
    clearProps: "transform",
  });
}

/**
 * "Girar": the page turns a quarter of the way round and stops on the mark.
 *
 * **One tween, no overshoot.** This used to end on `back.out(1.4)`, and a
 * quarter turn that swings past 90° and comes back reads as the page bouncing —
 * field testing reported exactly that. An overshoot is right for something
 * *arriving* (a thumb, the finished document); a turn has a destination the
 * user chose, and settling past it and correcting looks like a mistake being
 * fixed. It accelerates into the turn and decelerates out of it, and that is
 * all.
 *
 * `degrees` is **cumulative**, never the 0–270 model value: tweening 270 → 0
 * would unwind three quarters anticlockwise, and the button says clockwise.
 * `scale` is the fit compensation, tweened alongside so the page never leaves
 * its frame mid-turn.
 *
 * The dip at the halfway point is not only decoration. A rectangle's bounding
 * box peaks at 45°, part-way between two fits that both hold, so on a narrow
 * phone the page would clip against the frame in the middle of a turn that
 * starts and ends legal. Shrinking through the middle and coming back out
 * fixes that, and reads as the page making room for itself.
 *
 * Under reduced motion it snaps, with no tween and no dip at all.
 */
export function spinTo(
  element: Element | null,
  degrees: number,
  scale: number,
): void {
  if (element === null) return;
  if (prefersReducedMotion()) {
    setSpin(element, degrees, scale);
    return;
  }
  const fromDegrees = Number(gsap.getProperty(element, "rotation"));
  const fromScale = Number(gsap.getProperty(element, "scaleX"));
  const settled = Math.min(fromScale > 0 ? fromScale : scale, scale);
  // Claimed here and not on the tween's first frame — see `spinning`.
  spinning.add(element);
  const release = (): void => {
    spinning.delete(element);
  };
  gsap.to(element, {
    onComplete: release,
    onInterrupt: release,
    keyframes: [
      {
        rotation: (fromDegrees + degrees) / 2,
        scale: settled * SPIN_DIP,
        duration: DURATION.spin / 2,
        ease: "power2.in",
      },
      {
        rotation: degrees,
        scale,
        duration: DURATION.spin / 2,
        ease: EASE,
      },
    ],
    transformOrigin: "center center",
  });
}

/**
 * Put the element where it now belongs, cancelling any turn still playing.
 *
 * The counterpart to {@link spinTo}, for the moment the render pipeline catches
 * up: the turn the user watched moves out of the CSS transform and into the
 * page's own pixels, in the same commit that swaps the picture. Nothing changes
 * on screen, so nothing may animate — tweening that hand-over is a second
 * quarter turn, a few hundred milliseconds after the one the user asked for.
 *
 * A turn still in flight is killed rather than allowed to finish: its remaining
 * degrees would be added to pixels that already carry them, so the page would
 * over-rotate for the rest of the tween and then snap back.
 */
export function settleSpin(
  element: Element | null,
  degrees: number,
  scale: number,
): void {
  if (element === null) return;
  gsap.killTweensOf(element);
  spinning.delete(element);
  setSpin(element, degrees, scale);
}

/**
 * True while a turn is still playing. The resize path must not place the
 * element while {@link spinTo} owns it, or a re-measure lands a hard jump in
 * the middle of the animation it was meant to keep honest.
 *
 * True from the instant the turn is created, not from its first rendered frame
 * — the difference is the whole bug this guard exists to prevent (see
 * `spinning`). The commit that follows a tap is *inside* that gap.
 */
export function isSpinning(element: Element | null): boolean {
  if (element === null) return false;
  return spinning.has(element);
}

/** The same placement with no animation: first paint, and frame resizes. */
export function setSpin(
  element: Element | null,
  degrees: number,
  scale: number,
): void {
  if (element === null) return;
  gsap.set(element, {
    rotation: degrees,
    scale,
    transformOrigin: "center center",
  });
}

/**
 * A field that just filled itself from a suggestion chip. One soft squeeze, so
 * the tap lands somewhere visible instead of only in the text.
 */
export function pulse(element: Element | null): void {
  if (element === null || prefersReducedMotion()) return;
  gsap.fromTo(
    element,
    { scale: 0.97 },
    {
      scale: 1,
      duration: DURATION.quick,
      ease: POP_EASE,
      transformOrigin: "center center",
      clearProps: "transform",
    },
  );
}

/** Shutter feedback — a quick squeeze, in step with the vibration. */
export function shutterPulse(element: Element | null): void {
  if (element === null || prefersReducedMotion()) return;
  gsap.fromTo(
    element,
    { scale: 0.9 },
    { scale: 1, duration: DURATION.quick, ease: POP_EASE },
  );
}

/** The capture flash. Opacity only, and skipped entirely under reduced motion. */
export function flash(element: Element | null): void {
  if (element === null || prefersReducedMotion()) return;
  gsap.fromTo(
    element,
    { opacity: 0.75 },
    { opacity: 0, duration: DURATION.base, ease: EASE },
  );
}

/**
 * Moves a progress bar between polls. The bar is a full-width element scaled on
 * X, so this is a transform — never an animated `width`.
 */
export function progressTo(element: Element | null, fraction: number): void {
  if (element === null) return;
  const clamped = Math.min(1, Math.max(0.04, fraction));
  gsap.to(element, {
    scaleX: clamped,
    duration: prefersReducedMotion() ? 0 : DURATION.slow,
    ease: EASE,
    transformOrigin: "left center",
  });
}

/**
 * The finished-document celebration: it drops in and settles at its
 * resting tilt, then the headline and the buttons come up under it. One
 * timeline, two beats, no confetti — the audience is here to get a job done and
 * the reward is seeing the thing they made.
 *
 * Elements opt in with `data-celebrate` (the document) and `data-enter`
 * (everything after it). Returns the cleanup for React.
 */
export function celebrate(scope: Element | null): () => void {
  if (scope === null || typeof window === "undefined") return () => {};
  const reduced = prefersReducedMotion();
  const context = gsap.context(() => {
    const timeline = gsap.timeline();
    timeline.from("[data-celebrate]", {
      opacity: 0,
      y: reduced ? 0 : -24,
      rotation: reduced ? 0 : -6,
      duration: reduced ? DURATION.quick : DURATION.slow,
      ease: reduced ? EASE : POP_EASE,
    });
    timeline.from(
      "[data-enter]",
      {
        opacity: 0,
        y: reduced ? 0 : 14,
        duration: DURATION.quick,
        stagger: reduced ? 0 : 0.06,
        ease: EASE,
        clearProps: "opacity,transform",
      },
      reduced ? 0 : "-=0.25",
    );
  }, scope);
  return () => {
    context.revert();
  };
}

// ── overlays ─────────────────────────────────────────────────────────────────

/** Full-screen preview arriving: backdrop fades, the page scales up to meet you. */
export function overlayIn(backdrop: Element | null, panel: Element | null): void {
  if (backdrop !== null) {
    gsap.fromTo(
      backdrop,
      { opacity: 0 },
      { opacity: 1, duration: DURATION.quick, ease: EASE },
    );
  }
  if (panel === null) return;
  if (prefersReducedMotion()) {
    gsap.fromTo(
      panel,
      { opacity: 0 },
      { opacity: 1, duration: DURATION.quick, ease: EASE },
    );
    return;
  }
  gsap.fromTo(
    panel,
    { opacity: 0, scale: 0.85 },
    { opacity: 1, scale: 1, duration: DURATION.base, ease: EASE },
  );
}

/**
 * A bottom sheet arriving: the backdrop fades and the panel rises off the
 * bottom edge.
 *
 * Deliberately not {@link overlayIn}: that one scales a page up towards the
 * reader, which is right for a picture and wrong for a panel whose whole
 * affordance is "I came from the bottom of the screen, and that is where I go
 * back to". Under `prefers-reduced-motion` both are a plain fade.
 */
export function sheetIn(backdrop: Element | null, panel: Element | null): void {
  if (backdrop !== null) {
    gsap.fromTo(
      backdrop,
      { opacity: 0 },
      { opacity: 1, duration: DURATION.quick, ease: EASE },
    );
  }
  if (panel === null) return;
  if (prefersReducedMotion()) {
    gsap.fromTo(
      panel,
      { opacity: 0 },
      { opacity: 1, duration: DURATION.quick, ease: EASE },
    );
    return;
  }
  gsap.fromTo(
    panel,
    { yPercent: 100 },
    { yPercent: 0, duration: DURATION.base, ease: EASE },
  );
}

/**
 * The reverse, played to completion before the caller unmounts the overlay.
 * Resolves even when there is nothing to animate, so the close path can always
 * `await` it without special cases.
 */
export function overlayOut(
  backdrop: Element | null,
  panel: Element | null,
): Promise<void> {
  if (backdrop === null && panel === null) return Promise.resolve();
  const duration = prefersReducedMotion() ? 0.001 : DURATION.quick;
  return new Promise((resolve) => {
    const timeline = gsap.timeline({ onComplete: () => resolve() });
    if (panel !== null) {
      timeline.to(
        panel,
        {
          opacity: 0,
          scale: prefersReducedMotion() ? 1 : 0.9,
          duration,
          ease: EASE,
        },
        0,
      );
    }
    if (backdrop !== null) {
      timeline.to(backdrop, { opacity: 0, duration, ease: EASE }, 0);
    }
  });
}

/** A card leaving the review list before the layout closes the gap. */
export function collapseOut(element: Element | null): Promise<void> {
  if (element === null) return Promise.resolve();
  const duration = prefersReducedMotion() ? 0.001 : DURATION.quick;
  return new Promise((resolve) => {
    gsap.to(element, {
      opacity: 0,
      scale: prefersReducedMotion() ? 1 : 0.92,
      duration,
      ease: EASE,
      transformOrigin: "center center",
      onComplete: () => resolve(),
    });
  });
}

// ── Flip (reordering) ────────────────────────────────────────────────────────

/**
 * Snapshot the review list before React re-renders it in a new order; the
 * matching {@link playFlip} makes both affected cards glide to their new slots
 * instead of teleporting.
 */
export function captureFlip(targets: gsap.DOMTarget): Flip.FlipState | null {
  if (typeof window === "undefined") return null;
  return Flip.getState(targets);
}

export function playFlip(state: Flip.FlipState | null): void {
  if (state === null) return;
  if (prefersReducedMotion()) {
    Flip.from(state, { duration: 0 });
    return;
  }
  Flip.from(state, {
    duration: DURATION.base,
    ease: EASE,
    absolute: true,
    nested: true,
  });
}


// ── scroll-driven reveals ────────────────────────────────────────────────
//
// The one place in this library where motion is triggered by *scrolling*
// rather than by something the user did. It is meant for a long, static page
// a host builds around the scanner: inside the scan flow itself, motion always
// answers an action.
//
// GSAP + ScrollTrigger come from the copy already in the bundle, never from a
// CDN — the whole claim of this library is that nothing loads off-origin.

/**
 * Reveal each `[data-fade]` element, and stagger the children of each
 * `[data-anim-group]`, as they come into view.
 *
 * Returns a disposer. Under reduced motion it does nothing at all and the page
 * is simply already visible — which is why the markup carries no starting
 * opacity of its own: a JS failure must never leave the page blank.
 */
export function revealOnScroll(scope: Element | null): () => void {
  if (scope === null || prefersReducedMotion()) return () => undefined;

  /**
   * Anything already on screen when the page loads is left alone.
   *
   * A scroll-triggered reveal can only be honest about content the user has
   * not reached yet. Applied to an element that is *already visible*, it hides
   * something the visitor is looking at and waits for a scroll that may never
   * come — which on a desktop hero, where the next section starts just below
   * the trigger threshold, showed up as a blank band under the fold. So the
   * rule is: below the fold animates, in the fold simply is.
   */
  const belowFold = (element: Element): boolean =>
    element.getBoundingClientRect().top >= window.innerHeight * 0.85;

  const context = gsap.context(() => {
    gsap.utils
      .toArray<Element>("[data-fade]")
      .filter(belowFold)
      .forEach((element) => {
        gsap.from(element, {
          opacity: 0,
          y: 32,
          duration: 0.8,
          ease: "power3.out",
          scrollTrigger: { trigger: element, start: "top 85%" },
        });
      });
    gsap.utils
      .toArray<Element>("[data-anim-group]")
      .filter(belowFold)
      .forEach((group) => {
        gsap.from(Array.from(group.children), {
          opacity: 0,
          y: 36,
          scale: 0.94,
          duration: 0.65,
          ease: "power3.out",
          stagger: 0.12,
          scrollTrigger: { trigger: group, start: "top 85%" },
        });
      });
  }, scope);

  /**
   * Re-measure once the web fonts have swapped in.
   *
   * ScrollTrigger measures on creation, before Baloo 2 and Plus Jakarta have
   * replaced the fallback faces — and those have very different metrics, so
   * every trigger below the fold ends up positioned against a layout that no
   * longer exists.
   */
  const fonts: FontFaceSet | undefined = document.fonts;
  if (fonts !== undefined) {
    void fonts.ready.then(() => ScrollTrigger.refresh());
  }

  return () => context.revert();
}

/**
 * The floating "digitalizar" button, which exists only once the hero's own CTA
 * has scrolled away — so the page always has exactly one obvious next action,
 * never two competing ones.
 */
export function toggleFab(element: Element | null, show: boolean): void {
  if (element === null) return;
  gsap.killTweensOf(element);
  if (prefersReducedMotion()) {
    gsap.set(element, { opacity: show ? 1 : 0, scale: 1, y: 0 });
    return;
  }
  if (show) {
    gsap.to(element, {
      opacity: 1,
      scale: 1,
      y: 0,
      duration: 0.5,
      ease: "back.out(1.7)",
    });
  } else {
    gsap.to(element, { opacity: 0, scale: 0.4, y: 16, duration: 0.3, ease: "power2.in" });
  }
}


/**
 * The step-1 welcome, choreographed — the `conta até três` variation (canvas
 * `Scan Step 1 Variations`, 2d).
 *
 * The order is the argument the screen is making, and it is the reason this is
 * a timeline rather than a stagger: the trail draws itself, the card greets,
 * the three instructions arrive from the left, and each numeral *pops in after
 * its own line* — so the count reads as counting rather than as three rows
 * appearing. The CTA lands last, once there is something to say yes to.
 *
 * Selection is by `data-s1` rather than a scoped ref because the pieces are
 * split across two components: the trail belongs to `AppFrame`'s header and
 * the CTA to its footer, neither of which is inside the screen's own subtree.
 *
 * Returns a disposer. Under reduced motion it does nothing at all and every
 * element is simply already in place — nothing here may leave content hidden.
 */
export function countIntro(): () => void {
  if (prefersReducedMotion()) return () => undefined;

  const context = gsap.context(() => {
    const pick = (name: string): Element[] =>
      gsap.utils.toArray<Element>(`[data-s1="${name}"]`);

    gsap
      .timeline()
      .from("[data-trail-fill]", {
        scaleX: 0,
        duration: 0.6,
        ease: "power3.out",
      })
      .from(
        pick("card"),
        {
          opacity: 0,
          y: 18,
          scale: 0.97,
          duration: 0.65,
          ease: "power3.out",
          transformOrigin: "50% 100%",
        },
        "-=.4",
      )
      .from(
        pick("hi"),
        { opacity: 0, y: 10, duration: 0.5, stagger: 0.08, ease: "power2.out" },
        "-=.45",
      )
      .from(
        pick("row"),
        { opacity: 0, x: -12, duration: 0.5, stagger: 0.12, ease: "power2.out" },
        "-=.25",
      )
      .from(
        pick("big"),
        {
          scale: 0.3,
          opacity: 0,
          duration: 0.55,
          stagger: 0.12,
          ease: "back.out(2.6)",
          transformOrigin: "50% 100%",
        },
        "-=.65",
      )
      .from(pick("note"), { opacity: 0, duration: 0.5 }, "-=.2")
      .from(
        pick("cta"),
        { opacity: 0, y: 16, duration: 0.5, ease: "back.out(1.6)" },
        "-=.3",
      )
      // …and then keeps breathing. The one looping animation in the whole
      // product, and it earns the exception: this screen has no other movement
      // and no deadline, so a CTA that is imperceptibly alive is the only thing
      // telling a hesitant user that the app is waiting for *them*. 1.8% is
      // below the threshold where it reads as a pulse rather than as breath.
      .to(pick("cta"), {
        scale: 1.018,
        duration: 1.4,
        ease: "sine.inOut",
        repeat: -1,
        yoyo: true,
        transformOrigin: "50% 50%",
      });
  });

  return () => context.revert();
}


/**
 * Send a page into the gallery slot: the confirmed sheet shrinks, travels, and
 * lands in the tray at the bottom of the screen.
 *
 * This is the one animation in the app that exists purely to answer "where did
 * my page go?". A confirmation that simply swaps back to the viewfinder leaves
 * the user to infer that anything was kept at all; watching the sheet fly into
 * a slot that then fills is the receipt.
 *
 * Geometry is measured, not assumed: the flyer is placed over `from` and tweened
 * by the delta to `to`'s centre, so it works at any screen size and needs no
 * hard-coded offsets. Resolves when the page has landed — and resolves
 * immediately, without moving anything, under reduced motion.
 */
export function flyToSlot(
  flyer: HTMLElement | null,
  from: Element | null,
  to: Element | null,
): Promise<void> {
  if (flyer === null || from === null || to === null) return Promise.resolve();
  if (prefersReducedMotion()) return Promise.resolve();

  const source = from.getBoundingClientRect();
  const target = to.getBoundingClientRect();
  if (source.width === 0 || target.width === 0) return Promise.resolve();

  // Land the sheet inside the slot rather than merely near it: the scale is the
  // ratio the slot actually needs, which is ~0.24 at phone sizes.
  const scale = Math.min(target.width / source.width, target.height / source.height);
  const dx = target.left + target.width / 2 - (source.left + source.width / 2);
  const dy = target.top + target.height / 2 - (source.top + source.height / 2);

  return new Promise((resolve) => {
    gsap.set(flyer, {
      position: "fixed",
      left: source.left,
      top: source.top,
      width: source.width,
      height: source.height,
      margin: 0,
      zIndex: 60,
      opacity: 1,
    });
    gsap.to(flyer, {
      x: dx,
      y: dy,
      scale,
      duration: 0.62,
      // Into the slot and settling, not bouncing back out of it.
      ease: "power3.inOut",
      onComplete: () => resolve(),
    });
  });
}

/** The slot lighting up as the page arrives. */
export function fillSlot(slot: Element | null): void {
  if (slot === null || prefersReducedMotion()) return;
  gsap.fromTo(
    slot,
    { scale: 1 },
    { scale: 1.08, duration: 0.18, ease: "power2.out", yoyo: true, repeat: 1 },
  );
}
