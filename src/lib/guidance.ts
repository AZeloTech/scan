/**
 * What the viewfinder tells the person holding the phone, and when it says the
 * page is ready: one hint at a time, a ready cue on the corner brackets, and
 * — when they switched it on — a capture that takes itself.
 *
 * The phones' own document scanners do the same three things: a short hint
 * ("move closer", "hold still", "too dark"), a clear *ready* state, and an
 * automatic capture after about a second of stable hold, with the shutter
 * still under the thumb. This is that, driven by what the live loop already
 * knows (`hooks/useLiveDetect.ts`): whether a sheet is found and where, how
 * much it moved lately, how sharp and how bright the frame is, how much of the
 * page is washed out by a reflection, and how long it has been looking.
 *
 * **One hint, in priority order** ({@link rawHint}):
 *
 *  1. no page found — "Procurando documento" (after
 *     {@link SEARCHING_AFTER_MS}: the usual lock comes first), and after
 *     {@link NOT_FOUND_AFTER_MS} "Não achei a folha — toque para capturar"
 *     (the photo can still be taken; the confirm screen takes the corners);
 *     a frame too dark to see into says "Pouca luz" instead, because that is
 *     the reason and the torch is the remedy — unless a page is suspected
 *     cut off or far away, when framing it comes first, as below;
 *  2. a corner at or past the edge of what the viewfinder shows —
 *     "Afaste um pouco";
 *  3. the page not filling the viewfinder — "Aproxime" ("Aproxime mais um
 *     pouco" when it already nearly does: {@link FILL_NEAR});
 *  4. too dark — "Pouca luz" (with the torch offered where the camera has one);
 *  5. a reflection washing out part of the page — "Reflexo — incline o
 *     celular";
 *  6. a found sheet that keeps moving, or a blurred frame — "Segure firme"
 *     (not the moment "Aproxime" or "Afaste um pouco" is answered: the page
 *     moves because the person is moving it as asked);
 *  7. nothing: the page is ready.
 *
 * Each condition has an entry and an exit threshold (hysteresis), and the
 * hint on screen changes only when another one has been the answer for
 * {@link HINT_APPEAR_MS} and the one showing has been up for
 * {@link HINT_MIN_SHOW_MS} ({@link HintDebounce}): a hint never flickers.
 *
 * **Ready** ({@link ReadyCue}): a found sheet, no hint owed, a sharp frame
 * and a still page — still over the last {@link STILL_WINDOW_MS}, and not
 * drifting over the whole time since (on at least
 * {@link READY_MIN_READINGS} readings: a slow phone waits for them) — for
 * {@link READY_AFTER_MS}. Those are the *strict* conditions, and what
 * auto-capture counts from: its countdown stops the moment one fails. The cue
 * on the brackets is steadier: once on, it stays through a failure shorter
 * than {@link READY_EXIT_MS} and goes at once only when the page is lost or
 * another hint is owed — a cue that blinks, and buzzes each time it comes
 * back ({@link ReadyTick}: one tick per page), says nothing. It comes on
 * only once the hint slot is empty (the live loop's rule), so the slot and
 * the brackets never disagree.
 *
 * **Auto-capture** ({@link AutoCapture}), opt-in: once the strict conditions
 * have held {@link AUTO_FIRE_MS} — and a detection pass on a frame sampled
 * after that has found the page where it was — it fires, once per
 * page. After a fire it waits for the page to change (a sheet somewhere
 * else, no sheet for a second, or the scene changed) or for two seconds and
 * the phone moving, all counted from when the viewfinder came back from the
 * confirm screen, before it may fire again. It goes through the same capture
 * as a tap — capture priority, refinement, the confirm screen — and never
 * replaces the shutter.
 *
 * Pure: no DOM, no clock of its own (every call is given `now`); tested in
 * `guidance.test.ts`. Thresholds were set on the bench's guidance sessions
 * (`scripts/bench/README.md`, "Guidance").
 */

import { CORNER_KEYS, type NormalizedQuad } from "@/lib/quad";

export type HintKey = "searching" | "not-found" | "move-back" | "move-closer" | "low-light" | "glare" | "hold-still";

/**
 * No sheet for this long since the loop started (or one was last seen)
 * before "searching" is said at all: the usual first lock comes sooner, and a
 * hint flashed up on every page would then have to stay its second.
 */
export const SEARCHING_AFTER_MS = 700;

/** No sheet for this long since the loop started, or since one was last seen: say so and offer the tap. */
export const NOT_FOUND_AFTER_MS = 3500;

/** A condition has to be the answer this long before its hint appears. */
export const HINT_APPEAR_MS = 300;
/** A hint, once shown, stays at least this long… */
export const HINT_MIN_SHOW_MS = 1000;
/** …and the slot changes at most once in this long, whatever it changes to. */
export const HINT_MIN_GAP_MS = 1500;

/**
 * A corner this close to the viewfinder's edge (share of that axis), or past
 * it, is a page cut off: enter at {@link BORDER_ENTER}, leave only once every
 * corner is {@link BORDER_EXIT} inside.
 */
export const BORDER_ENTER = 0.015;
export const BORDER_EXIT = 0.03;

/**
 * How much of the viewfinder the page fills ({@link fillShare}: its reach
 * along the view's limiting axis) under which it is too far: enter below
 * {@link FILL_ENTER}, leave only at {@link FILL_EXIT} or more.
 *
 * Not an area: the viewfinder on a tall phone is about 0.46 as wide as it is
 * tall and an A4 page 0.71, so a page as big as the screen can show it covers
 * at most ~65 % of it — an area target of 70–80 % could never be met. Reach is
 * what the PDF's resolution follows: on the Galaxy S25 Ultra the visible part
 * of the 4080×3060 still is 2295 px wide, so a page across 54 % of it (the
 * owner's field run, under the old area rule) is ~1240 px — 150 dpi for A4 —
 * and across 85 % of it ~1950 px (235 dpi).
 *
 * The band from {@link FILL_EXIT} to "Afaste um pouco" ({@link BORDER_ENTER}:
 * a corner within 1.5 % of the edge, i.e. a centred page reaching 97 %) is
 * where a held page lives; the gap between enter and exit keeps a page held
 * at the line from toggling the hint (set on the bench's hover and
 * follow-the-hint sessions, `scripts/bench/README.md`).
 */
export const FILL_ENTER = 0.78;
export const FILL_EXIT = 0.83;

/**
 * At or above this fill when it appears, "Aproxime" is said as "Aproxime mais
 * um pouco": the page is found and already nearly big enough — a small move
 * is asked for, not a big one that overshoots into "Afaste um pouco". The
 * wording is chosen when the hint appears and kept while it shows (no text
 * change under the person's eyes).
 */
export const FILL_NEAR = 0.6;

/**
 * A page the model is sure of but could not take as a found sheet is a *far*
 * page (`hooks/useLiveDetect.ts`'s candidate) only while it covers less than
 * this share of the view: under the model's own coverage floor.
 */
export const FAR_CANDIDATE_AREA = 0.17;

/**
 * Too dark to frame by: the frame's brightest twentieth (its 95th luma
 * percentile, `lib/hints.ts`) under {@link BRIGHT_ENTER}, until it is back
 * over {@link BRIGHT_EXIT}. Not the mean: a page in a dim room leaves the
 * mean anywhere from 40 to 60 (a grey table), but nothing in the frame is
 * bright — a white page in ordinary light reaches 200 and up.
 */
export const BRIGHT_ENTER = 100;
export const BRIGHT_EXIT = 120;

/**
 * Share of the page's interior blocks washed white by a reflection (`glare`,
 * `lib/paper-evidence.ts`): enter, leave. On the bench's glare sessions a
 * lamp's hot spot reads 0.11–0.36; no page without one read above 0.
 */
export const GLARE_ENTER = 0.1;
export const GLARE_EXIT = 0.06;

/**
 * How far the found sheet moved over the recent window ({@link motionOf}),
 * as a share of the viewfinder's diagonal. Over {@link SHAKY_ENTER} it is
 * "hold still" (until it is back under {@link SHAKY_EXIT}); at or under
 * {@link STILL_MAX} it is still enough to be ready. On the bench a page held
 * with a light tremor (0.3–0.5 % RMS) moves 0.9–1.2 % (p50) over 600 ms, a
 * trembling hand (1.2 % RMS) 3–3.5 %.
 */
export const SHAKY_ENTER = 3 / 100;
export const SHAKY_EXIT = 2 / 100;
export const STILL_MAX = 1.5 / 100;

/**
 * The windows {@link motionOf} measures over: the hold-still hint over
 * {@link SHAKE_WINDOW_MS} (a trembling hand swings the page through several
 * per cent in that time), the ready cue over {@link STILL_WINDOW_MS} — the
 * page still for that long is "still for ~400 ms". Each at least 1.2 of the
 * loop's own interval (a slow phone reads less often), and a window has to
 * be covered for at least {@link MOTION_MIN_SPAN_MS} to count.
 */
export const SHAKE_WINDOW_MS = 600;
export const STILL_WINDOW_MS = 300;
export const MOTION_MIN_SPAN_MS = 200;

/** Ready: every condition true for this long (the stillness window already spans its 300 ms). */
export const READY_AFTER_MS = 100;
/**
 * The cue on the brackets, once on, outlasts a failure of the strict
 * conditions this short (a reading that drifted a little, one blurred frame);
 * losing the page or owing another hint drops it at once.
 */
export const READY_EXIT_MS = 300;
/** The ready tick is owed again once the cue has been off this long (or the page lost for {@link REARM_GONE_MS}). */
export const TICK_REARM_MS = 2000;
/**
 * …and still all along: while the conditions hold, the sheet may not drift
 * more than {@link READY_DRIFT_MAX} (share of the diagonal) over the whole
 * time since they started (plus the stillness window). A trembling hand has
 * quiet moments a few hundred milliseconds long; over the ready cue and the
 * auto-capture countdown together it drifts.
 */
export const READY_DRIFT_MAX = 2.4 / 100;
/**
 * …or {@link READY_DRIFT_MAX_SPARSE} when fewer than
 * {@link READY_DENSE_READINGS} readings back it: a slow phone sees the hand
 * two or three times a second, and on so few readings a trembling hand's
 * quiet second looks like a steady one (the bench's `tremor-hold` under
 * `--cpu 4` fired at 2.4 %).
 */
export const READY_DRIFT_MAX_SPARSE = 1.8 / 100;
export const READY_DENSE_READINGS = 6;
/**
 * …seen on at least this many readings: a slow phone reads the page two or
 * three times a second, and a trembling hand can look still between two of
 * them.
 */
export const READY_MIN_READINGS = 5;
/** Auto-capture: the ready cue held for this long. */
export const AUTO_FIRE_MS = 500;
/**
 * After a fire: another page is a sheet at least this far (share of the
 * diagonal) from the one taken — the live loop's own jump threshold — …
 */
export const REARM_JUMP = 0.08;
/** …or no sheet for this long while the viewfinder was live… */
export const REARM_GONE_MS = 1000;
/** …or this long since the fire and the phone moved in between… */
export const REARM_AFTER_MS = 2000;
/**
 * …or the scene itself changed since the fire (a page swapped in at much
 * the same place while the confirm screen was up): the viewfinder's 24×24
 * luma against the one at the fire (`frameMotionScore`, `lib/frame-motion.ts`)
 * at least this far apart — the live loop's own "the scene moved" line.
 */
export const REARM_SCENE_CHANGE = 0.1;

/**
 * The part of the camera frame the viewfinder shows (its object-cover crop),
 * as fractions of the frame. Everything here is judged in it: a corner the
 * frame holds but the screen does not show is cut off to the person looking.
 */
export interface VisibleRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The whole frame, before the viewfinder has been measured. */
export const WHOLE_FRAME: VisibleRect = { x: 0, y: 0, width: 1, height: 1 };

/** A quad in frame fractions, re-expressed in fractions of the visible crop. */
export function toVisible(quad: NormalizedQuad, visible: VisibleRect): NormalizedQuad {
  const map = (p: { x: number; y: number }) => ({ x: (p.x - visible.x) / visible.width, y: (p.y - visible.y) / visible.height });
  return {
    topLeft: map(quad.topLeft),
    topRight: map(quad.topRight),
    bottomRight: map(quad.bottomRight),
    bottomLeft: map(quad.bottomLeft),
  };
}

/** How close the quad's nearest corner is to the view's edge (fractions of each axis; negative = outside). */
export function borderMargin(quad: NormalizedQuad): number {
  let least = Infinity;
  for (const key of CORNER_KEYS) {
    const { x, y } = quad[key];
    least = Math.min(least, x, 1 - x, y, 1 - y);
  }
  return least;
}

/** The quad's area as a share of the view (clipped to it). */
export function areaShare(quad: NormalizedQuad): number {
  // Shoelace over the quad clipped to the unit square (Sutherland–Hodgman).
  let poly = CORNER_KEYS.map((key) => [quad[key].x, quad[key].y]);
  const edges: [(p: number[]) => boolean, (a: number[], b: number[]) => number[]][] = [
    [(p) => p[0] >= 0, (a, b) => lerpAt(a, b, (0 - a[0]) / (b[0] - a[0]))],
    [(p) => p[0] <= 1, (a, b) => lerpAt(a, b, (1 - a[0]) / (b[0] - a[0]))],
    [(p) => p[1] >= 0, (a, b) => lerpAt(a, b, (0 - a[1]) / (b[1] - a[1]))],
    [(p) => p[1] <= 1, (a, b) => lerpAt(a, b, (1 - a[1]) / (b[1] - a[1]))],
  ];
  for (const [inside, cut] of edges) {
    const out: number[][] = [];
    for (let i = 0; i < poly.length; i += 1) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      if (inside(a)) {
        out.push(a);
        if (!inside(b)) out.push(cut(a, b));
      } else if (inside(b)) out.push(cut(a, b));
    }
    poly = out;
    if (poly.length < 3) return 0;
  }
  let twice = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    twice += x1 * y2 - x2 * y1;
  }
  return Math.abs(twice) / 2;
}

function lerpAt(a: number[], b: number[], t: number): number[] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/**
 * How much of the view the page fills along its limiting axis: the larger of
 * its extent's share of the view's width and of its height (its bounding box,
 * clipped to the view). An upright A4 page in a tall phone's viewfinder is
 * width-limited, a long receipt height-limited, a page turned sideways
 * width-limited again — each reads how far it is from filling the screen.
 *
 * The bounding box, not the quad's side lengths: a page turned in the view
 * reaches the edges with its corners before its sides are as long as the
 * view, so a side-length target could ask for a size no framing allows ("Aproxime"
 * up to the moment "Afaste um pouco" takes over, and back). A box inside the
 * view is exactly four corners inside it, so 1 is always reachable.
 */
export function fillShare(quad: NormalizedQuad): number {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const key of CORNER_KEYS) {
    const { x, y } = quad[key];
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const clip = (v: number) => Math.min(1, Math.max(0, v));
  return Math.max(clip(maxX) - clip(minX), clip(maxY) - clip(minY));
}

/** Whether the page fills too little of the view ({@link FILL_ENTER} / {@link FILL_EXIT}); `showing` is the hint up already. */
export function tooFar(quad: NormalizedQuad, showing: boolean): boolean {
  return fillShare(quad) < (showing ? FILL_EXIT : FILL_ENTER);
}

/**
 * How much a sheet moved lately: over its recent readings (time, quad in the
 * visible crop), the largest corner move between the newest and any reading
 * within `windowMs` before it, as a share of the view's diagonal (`aspect` =
 * the view's height over its width). `null` when the readings span less than
 * {@link MOTION_MIN_SPAN_MS}: not known yet.
 */
export function motionOf(readings: readonly { at: number; quad: NormalizedQuad }[], aspect: number, windowMs: number = SHAKE_WINDOW_MS): number | null {
  const newest = readings[readings.length - 1];
  if (newest === undefined) return null;
  const diagonal = Math.hypot(1, aspect);
  let largest = 0;
  let span = 0;
  for (let i = readings.length - 2; i >= 0; i -= 1) {
    const reading = readings[i];
    const age = newest.at - reading.at;
    if (age > windowMs) break;
    span = age;
    for (const key of CORNER_KEYS) {
      const move = Math.hypot(newest.quad[key].x - reading.quad[key].x, (newest.quad[key].y - reading.quad[key].y) * aspect);
      largest = Math.max(largest, move);
    }
  }
  return span >= MOTION_MIN_SPAN_MS ? largest / diagonal : null;
}

/**
 * The median spacing (ms) of the newest readings' frame times — how often
 * the loop actually reads the page — or 0 with fewer than three of them.
 */
export function readingSpacing(readings: readonly { at: number }[]): number {
  const recent = readings.slice(-(READY_MIN_READINGS + 1));
  if (recent.length < 3) return 0;
  const gaps = recent.slice(1).map((r, i) => r.at - recent[i].at).sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

/** What the live loop knows at one moment. */
export interface GuidanceInput {
  now: number;
  /** When the loop (re)started looking. */
  since: number;
  /** A found sheet is drawn. */
  locked: boolean;
  /**
   * Where the page is, in the visible crop: the found sheet, or — not found
   * yet — a convincing candidate the live loop could not take (too small for
   * its floor, or cut off by the frame). `null`: no page seen or suspected.
   */
  sheet: NormalizedQuad | null;
  /** The page is known to run on past the viewfinder's edge though its quad does not reach it (an edgeless side with paper beyond) — suspected or found. */
  cutOff?: boolean;
  /** When a sheet (found or candidate) was last seen; null: not since `since`. */
  sheetSeenAt: number | null;
  /** The view's height over its width (for distances along its diagonal). */
  aspect: number;
  /** {@link motionOf} of the found sheet over {@link SHAKE_WINDOW_MS}; null unknown. */
  motion: number | null;
  /** The frame is sharp enough (the hint reading's focus verdict); null unknown. */
  sharp: boolean | null;
  /** The luma the frame's brightest twentieth reaches (0–255); null unknown. */
  bright: number | null;
  /** Share of the found sheet's interior clipped white; null unknown. */
  glare: number | null;
}

/**
 * The hint the moment calls for, before any debouncing — `current` (the hint
 * showing or pending) sets which side of each hysteresis band applies.
 */
export function rawHint(input: GuidanceInput, current: HintKey | null): HintKey | null {
  const keep = (key: HintKey): boolean => current === key;
  const dark = input.bright !== null && input.bright < (keep("low-light") ? BRIGHT_EXIT : BRIGHT_ENTER);
  const sheet = input.sheet;
  if (sheet === null || !input.locked) {
    // Not found: a page suspected at the edge or far away (framing it comes
    // first, as for a found one), too dark to see into, or nothing at all.
    if (sheet !== null) {
      if (input.cutOff === true || borderMargin(sheet) < (keep("move-back") ? BORDER_EXIT : BORDER_ENTER)) return "move-back";
      if (tooFar(sheet, keep("move-closer"))) return "move-closer";
    }
    if (dark) return "low-light";
    const quiet = input.now - Math.max(input.since, input.sheetSeenAt ?? input.since);
    return quiet >= NOT_FOUND_AFTER_MS ? "not-found" : quiet >= SEARCHING_AFTER_MS ? "searching" : null;
  }
  // A found sheet whose paper runs on past the viewfinder's edge is cut off
  // too, wherever the model drew its corners.
  if (input.cutOff === true || borderMargin(sheet) < (keep("move-back") ? BORDER_EXIT : BORDER_ENTER)) return "move-back";
  if (tooFar(sheet, keep("move-closer"))) return "move-closer";
  if (dark) return "low-light";
  if (input.glare !== null && input.glare >= (keep("glare") ? GLARE_EXIT : GLARE_ENTER)) return "glare";
  const shaky = input.motion !== null && input.motion > (keep("hold-still") ? SHAKY_EXIT : SHAKY_ENTER);
  // The page moving while "Aproxime" / "Afaste um pouco" is up is the person
  // doing as asked, not a shaking hand: the slot clears instead of trading
  // one hint for "Segure firme" (the ready cue waits for stillness all the
  // same). Once it has cleared, a hand still moving gets "Segure firme".
  if (shaky && input.sharp !== false && (current === "move-closer" || current === "move-back")) return null;
  if (shaky || input.sharp === false) return "hold-still";
  return null;
}

/**
 * The hint on screen: another answer must hold {@link HINT_APPEAR_MS} before
 * it replaces the one showing, and a shown hint stays at least
 * {@link HINT_MIN_SHOW_MS} — so a condition that comes and goes on alternate
 * passes never makes the slot flicker.
 */
export class HintDebounce {
  private shown: HintKey | null = null;
  private shownAt = Number.NEGATIVE_INFINITY;
  private changedAt = Number.NEGATIVE_INFINITY;
  private pending: HintKey | null = null;
  private pendingSince = 0;

  /** The hint showing (or pending), for {@link rawHint}'s hysteresis. */
  get current(): HintKey | null {
    return this.pending ?? this.shown;
  }

  get value(): HintKey | null {
    return this.shown;
  }

  update(candidate: HintKey | null, now: number): HintKey | null {
    if (candidate === this.shown) {
      this.pending = null;
      return this.shown;
    }
    if (candidate !== this.pending) {
      this.pending = candidate;
      this.pendingSince = now;
    }
    const heldLongEnough = now - this.pendingSince >= HINT_APPEAR_MS;
    const shownLongEnough = this.shown === null || now - this.shownAt >= HINT_MIN_SHOW_MS;
    if (heldLongEnough && shownLongEnough && now - this.changedAt >= HINT_MIN_GAP_MS) {
      this.shown = candidate;
      this.shownAt = now;
      this.changedAt = now;
      this.pending = null;
    }
    return this.shown;
  }

  reset(): void {
    this.shown = null;
    this.shownAt = Number.NEGATIVE_INFINITY;
    this.changedAt = Number.NEGATIVE_INFINITY;
    this.pending = null;
  }
}

/**
 * Ready: the strict conditions (`strict`) held {@link READY_AFTER_MS} turn
 * it on — {@link onSince}, what auto-capture counts from, is null the moment
 * they fail. The cue on screen (the answer) stays on through a failure
 * shorter than {@link READY_EXIT_MS} while `keep` holds (the page still
 * found, no other hint owed), and goes at once when it does not.
 */
export class ReadyCue {
  /** When the strict conditions last started holding, or null while they do not. */
  since: number | null = null;

  /** When the strict conditions had held {@link READY_AFTER_MS}, or null while they do not. */
  onSince: number | null = null;

  private shown = false;
  private failingSince: number | null = null;

  update(strict: boolean, keep: boolean, now: number): boolean {
    if (strict) {
      this.since ??= now;
      if (now - this.since >= READY_AFTER_MS) this.onSince ??= now;
      if (this.onSince !== null) this.shown = true;
      this.failingSince = null;
      return this.shown;
    }
    this.since = null;
    this.onSince = null;
    if (!keep) {
      this.shown = false;
      this.failingSince = null;
      return false;
    }
    if (this.shown) {
      this.failingSince ??= now;
      if (now - this.failingSince >= READY_EXIT_MS) {
        this.shown = false;
        this.failingSince = null;
      }
    }
    return this.shown;
  }

  reset(): void {
    this.since = null;
    this.onSince = null;
    this.shown = false;
    this.failingSince = null;
  }
}

/**
 * The ready cue's haptic tick (and its spoken "ready"): once per page. Owed
 * again only once the cue has been off {@link TICK_REARM_MS}, or the page
 * lost for {@link REARM_GONE_MS} — never on a cue that comes back after a
 * wobble.
 */
export class ReadyTick {
  private armed = true;
  private offSince: number | null = null;
  private lostSince: number | null = null;

  /** One moment: the cue on screen and a sheet found. Answers true when the tick is due now. */
  update(ready: boolean, found: boolean, now: number): boolean {
    if (ready) {
      this.offSince = null;
      this.lostSince = null;
      if (!this.armed) return false;
      this.armed = false;
      return true;
    }
    this.offSince ??= now;
    this.lostSince = found ? null : (this.lostSince ?? now);
    if (now - this.offSince >= TICK_REARM_MS || (this.lostSince !== null && now - this.lostSince >= REARM_GONE_MS)) this.armed = true;
    return false;
  }

  reset(): void {
    this.armed = true;
    this.offSince = null;
    this.lostSince = null;
  }
}

/** What auto-capture says at one moment. */
export interface AutoCaptureState {
  /** 0–1 of the countdown while it runs; null when it is not counting. */
  countdown: number | null;
  /** Fire now (true once per countdown). */
  fire: boolean;
}

/**
 * Opt-in auto-capture: fires when the ready cue has held {@link AUTO_FIRE_MS},
 * once per page. Its memory of the last fire outlives the viewfinder pausing
 * behind the confirm screen — that pause is exactly when it must not forget
 * which page it just took.
 */
export class AutoCapture {
  private fired: { quad: NormalizedQuad; at: number } | null = null;
  /** When it was last armed: a ready cue older than that counts from here. */
  private armedAt = Number.NEGATIVE_INFINITY;
  private movedSinceFire = false;
  private seenSinceFire = false;
  private goneSince: number | null = null;

  /** Armed: allowed to fire on the next ready page. */
  get armed(): boolean {
    return this.fired === null;
  }

  /**
   * One moment of a live viewfinder. `readyOnSince` is when the strict ready
   * conditions came on (null: off — {@link ReadyCue.onSince}); `sheet` the
   * found sheet in the visible crop (null: none); `moving` the phone moving
   * (the hold-still threshold crossed); `confirmedAt` the time of the frame
   * of the newest detection pass that found the page where it was (null:
   * none) — the countdown completes, but it fires only once a frame sampled
   * after it completed has been confirmed, the moment that pass lands: the
   * brackets alone are no proof the page is still in front of the camera, and
   * a camera whipped off the page between two passes is caught by the next
   * one (or by the watch, `hooks/useLiveDetect.ts`) rather than photographed.
   */
  update(input: {
    now: number;
    readyOnSince: number | null;
    sheet: NormalizedQuad | null;
    moving: boolean;
    aspect: number;
    sceneChange?: number | null;
    confirmedAt?: number | null;
  }): AutoCaptureState {
    const { now, readyOnSince, sheet } = input;
    if (this.fired !== null) {
      this.watchForAnotherPage(input);
      if (this.fired === null) this.armedAt = now;
    }
    if (this.fired !== null || readyOnSince === null || sheet === null) return { countdown: null, fire: false };
    const start = Math.max(readyOnSince, this.armedAt);
    const progress = Math.min(1, (now - start) / AUTO_FIRE_MS);
    if (progress < 1) return { countdown: progress, fire: false };
    const confirmedAt = input.confirmedAt ?? null;
    if (confirmedAt === null || confirmedAt < start + AUTO_FIRE_MS) return { countdown: 1, fire: false };
    this.fired = { quad: sheet, at: now };
    this.movedSinceFire = false;
    this.seenSinceFire = false;
    this.goneSince = null;
    return { countdown: 1, fire: true };
  }

  /**
   * The person took this page themselves (a tap): it counts as taken, and
   * auto-capture waits for another page exactly as after a fire of its own.
   * `sheet` null: no page was framed — nothing to wait for.
   */
  took(now: number, sheet: NormalizedQuad | null): void {
    if (sheet === null) return;
    this.fired = { quad: sheet, at: now };
    this.movedSinceFire = false;
    this.seenSinceFire = false;
    this.goneSince = null;
  }

  /**
   * Switched on at `now`: a ready cue already on counts from now. A page
   * already taken stays taken — switching off and on again is not another
   * page.
   */
  enable(now: number): void {
    this.armedAt = now;
  }

  /** The viewfinder stopped (a capture, a sheet over it): not a moment of "no sheet". */
  pause(): void {
    this.goneSince = null;
  }

  /**
   * The viewfinder is back (the confirm screen closed) at `now`: whatever
   * says "another page" is counted from here — the time behind the confirm
   * screen is not time the page was gone, the phone moving while it was up
   * is not the phone moving over the page, and the page has to be seen again
   * before its absence means anything.
   */
  resume(now: number): void {
    if (this.fired !== null) this.fired = { ...this.fired, at: now };
    this.movedSinceFire = false;
    this.seenSinceFire = false;
    this.goneSince = null;
  }

  /** Forget everything (a new capture screen). */
  reset(): void {
    this.fired = null;
    this.armedAt = Number.NEGATIVE_INFINITY;
    this.goneSince = null;
  }

  private watchForAnotherPage({ now, sheet, moving, aspect, sceneChange }: { now: number; sheet: NormalizedQuad | null; moving: boolean; aspect: number; sceneChange?: number | null }): void {
    const fired = this.fired;
    if (fired === null) return;
    if (sceneChange !== undefined && sceneChange !== null && sceneChange >= REARM_SCENE_CHANGE) {
      this.fired = null;
      return;
    }
    if (moving) this.movedSinceFire = true;
    if (sheet !== null) {
      this.seenSinceFire = true;
      this.goneSince = null;
      const diagonal = Math.hypot(1, aspect);
      let largest = 0;
      for (const key of CORNER_KEYS) {
        largest = Math.max(largest, Math.hypot(sheet[key].x - fired.quad[key].x, (sheet[key].y - fired.quad[key].y) * aspect));
      }
      if (largest / diagonal > REARM_JUMP) this.fired = null;
    } else if (this.seenSinceFire) {
      this.goneSince ??= now;
      if (now - this.goneSince >= REARM_GONE_MS) this.fired = null;
    }
    if (this.fired !== null && this.movedSinceFire && now - fired.at >= REARM_AFTER_MS) this.fired = null;
  }
}
