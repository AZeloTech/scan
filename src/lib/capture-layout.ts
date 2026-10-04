/**
 * The capture screen's layouts (`captureLayout` on `<ScanFlow>`), as the
 * decisions they make — kept out of the components so the rules can be tested
 * without a DOM.
 *
 * Every layout is the SAME capture stage — the camera, the live detection, the
 * guidance, the ready cue on the corner brackets, the torch and auto-capture —
 * under different chrome. Nothing here changes what a tap captures, and the
 * shutter is live in every state of every layout.
 *
 *  - `rail`      — THE DEFAULT. Full-bleed, a MANUAL · AUTOMÁTICO mode rail
 *                  over the shutter, "Já tenho a foto" under it.
 *  - `standard`  — the screen that shipped before `rail`: header, viewfinder
 *                  card, thumbnail rail, control row. (`default` is its old,
 *                  deprecated name.)
 *  - `classic`   — experimental: full-bleed camera, a translucent bottom bar.
 *  - `filmstrip` — experimental: the camera on top, the pages as a strip under it.
 *  - `onehand`   — experimental: no bars; every control in reach of a right thumb.
 *  - `collapse`  — experimental: `classic` while searching; the chrome folds
 *                  into one capsule while the ready cue is on.
 */

export type CaptureLayout =
  | "rail"
  | "standard"
  | "classic"
  | "filmstrip"
  | "onehand"
  | "collapse";

export const CAPTURE_LAYOUTS: readonly CaptureLayout[] = [
  "rail",
  "standard",
  "classic",
  "filmstrip",
  "onehand",
  "collapse",
];

/** What a host gets when it names no layout, or one this version does not know. */
export const DEFAULT_CAPTURE_LAYOUT: CaptureLayout = "rail";

/** Old names still accepted, and what they mean now. */
const DEPRECATED_LAYOUT_NAMES: Readonly<Record<string, CaptureLayout>> = {
  // The shipped screen was called "default" while `rail` was experimental;
  // it is not the default any more, so the name would now lie.
  default: "standard",
};

/**
 * A host value, read defensively: a plain-JS host can pass anything, and a
 * typo must land on the default screen rather than on a blank one. A
 * deprecated name maps to the layout it names.
 */
export function resolveCaptureLayout(value: unknown): CaptureLayout {
  if (typeof value !== "string") return DEFAULT_CAPTURE_LAYOUT;
  if ((CAPTURE_LAYOUTS as readonly string[]).includes(value)) return value as CaptureLayout;
  return Object.prototype.hasOwnProperty.call(DEPRECATED_LAYOUT_NAMES, value)
    ? DEPRECATED_LAYOUT_NAMES[value]!
    : DEFAULT_CAPTURE_LAYOUT;
}

/**
 * The layout a `<ScanFlow>` shows, from its two props: `captureLayout` wins;
 * `experimentalCaptureLayout` (its deprecated old name) is read only when
 * `captureLayout` is absent.
 */
export function pickCaptureLayout(captureLayout: unknown, experimentalCaptureLayout: unknown): CaptureLayout {
  return resolveCaptureLayout(captureLayout ?? experimentalCaptureLayout);
}

/** The layouts whose design shows the auto-capture toggle unless the host hides it. */
const LAYOUTS_WITH_AUTO_TOGGLE: ReadonlySet<CaptureLayout> = new Set(["rail", "onehand", "collapse"]);

/**
 * Whether the auto-capture toggle is offered, from the layout and the host's
 * `experimentalAutoCapture` (`undefined` when the host left it out).
 *
 *  - `false` hides the toggle on every layout — the host's escape hatch.
 *  - Omitted, a layout drawn around the toggle shows it (`rail`, the default,
 *    and `onehand`, `collapse`); `standard` keeps its old rule and does not.
 *  - `true` shows it on `standard` too.
 *  - `classic` and `filmstrip` have no place for it and never show it.
 *
 * Offered is never on: every new flow starts with auto-capture off, in every
 * layout, and the choice is never stored.
 */
export function autoCaptureOffered(layout: CaptureLayout, hostFlag: boolean | undefined): boolean {
  if (hostFlag === false) return false;
  if (layout === "standard") return hostFlag === true;
  return LAYOUTS_WITH_AUTO_TOGGLE.has(layout);
}

export interface CollapseInputs {
  /** The viewfinder is live and taking pages (not starting, fallback or at capacity). */
  live: boolean;
  /** The ready cue: a found sheet, framed, sharp and still. */
  ready: boolean;
  /** A capture is in flight. */
  busy: boolean;
  /** Something the person must read is on screen (a failed capture). */
  notice: boolean;
}

/**
 * Whether the `collapse` layout folds its chrome away.
 *
 * Only while the ready cue is on, over a live viewfinder, with nothing to read
 * and no capture in flight: the fold says "this is the moment", and a capture
 * in flight or an error on screen is not that moment. The ready cue carries
 * its own hysteresis (`ReadyCue` in `lib/guidance.ts`), so this adds none —
 * a second debounce would only make the fold lag the brackets it mirrors.
 */
export function chromeCollapsed({ live, ready, busy, notice }: CollapseInputs): boolean {
  return live && ready && !busy && !notice;
}

/**
 * Where `onehand` shows its hint: attached above the page's top-left corner
 * while a page is tracked, and as a pill at the top when there is none to
 * attach to (searching, not found, no live detection on this device).
 */
export function hintPlacement(hasQuad: boolean): "anchor" | "top" {
  return hasQuad ? "anchor" : "top";
}

export interface FilmstripState {
  /** The dashed slot's number — the page the shutter takes next — or null at the cap. */
  nextSlot: number | null;
  /** How many pages, of how many allowed. */
  count: number;
  max: number;
}

/** The filmstrip's tail: the dashed slot for the next page, and the count. */
export function filmstripState(pageCount: number, maxPages: number): FilmstripState {
  const count = Math.max(0, Math.floor(pageCount));
  const max = Math.max(1, Math.floor(maxPages));
  return { nextSlot: count < max ? count + 1 : null, count, max };
}

/**
 * The countdown ring's dash offset for a progress in 0..1 (null: not
 * running), on a circle of the given circumference: full offset is an empty
 * ring, zero a closed one.
 */
export function ringOffset(progress: number | null, circumference: number): number {
  if (progress === null || !Number.isFinite(progress) || progress <= 0) return circumference;
  return circumference * (1 - Math.min(1, progress));
}
