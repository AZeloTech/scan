/**
 * The part of the camera frame the person can actually SEE — the one source
 * of truth the live loop judges a page against (Phase 5a).
 *
 * A viewfinder never shows the whole frame the camera delivers. The video is
 * scaled to the stage under a fit policy (`cover` crops what overflows,
 * `contain` letterboxes), the stage is clipped by the viewport, and a
 * full-bleed layout draws its chrome — the notch, the mode rail and the
 * shutter row over a dark fade — on top of the picture. A corner the frame
 * holds but the screen crops away, or hides under a ≥ 50 %-opaque band, is
 * cut off to the person holding the phone, and "Página enquadrada", the ready
 * cue and auto-capture must all say so.
 *
 * Everything here is plain geometry on rectangles in CSS pixels, stage
 * coordinates (0,0 = the stage's top-left), so it is tested without a DOM:
 *
 *  1. the **clear area** — the stage ∩ the viewport, minus the opaque bands a
 *     layout declares on its edges ({@link clearArea});
 *  2. the **frame box** — where the whole frame renders, from the fit policy
 *     ({@link frameBoxFor}): `cover` fills the stage as the layouts always
 *     have; `contain` and `maxcrop` are placed in the clear area, so the chrome
 *     sits over dark ground instead of over the page;
 *  3. the **visible region** — the frame box ∩ the clear area, as fractions
 *     of the frame ({@link visibleRegionOf}): what the hints, the ready cue and
 *     auto-capture judge.
 *
 * Detection itself still runs on the whole frame: more context is fine.
 */

/** A rectangle in CSS pixels. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Part of the frame, as fractions of it (x, y from its top-left). */
export interface FrameRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * How a layout scales the camera frame into its stage.
 *
 *  - `cover`   — fill the stage, cropping what overflows (the layouts' look
 *                until Phase 5a; `standard`'s viewfinder card keeps it).
 *  - `contain` — the whole frame, as large as fits the clear area; dark bands
 *                where it does not reach.
 *  - `maxcrop` — cover the clear area, but never crop more than
 *                {@link MAX_CROP_PER_SIDE} of the frame off any side; past
 *                that, dark bands.
 */
export type FitPolicy = "cover" | "contain" | "maxcrop";

export const FIT_POLICIES: readonly FitPolicy[] = ["cover", "contain", "maxcrop"];

/** `maxcrop`'s ceiling: the share of the frame it may crop off each side. */
export const MAX_CROP_PER_SIDE = 0.12;

/** Which stage edge an opaque band hugs. */
export type OccluderEdge = "top" | "bottom" | "left" | "right";

export interface Occluder {
  edge: OccluderEdge;
  box: Box;
}

/** A host or bench value read defensively: an unknown fit is the layout's own. */
export function resolveFit(value: unknown, fallback: FitPolicy): FitPolicy {
  return typeof value === "string" && (FIT_POLICIES as readonly string[]).includes(value) ? (value as FitPolicy) : fallback;
}

/**
 * The stage's clear area: its box ∩ the viewport (both in stage coordinates),
 * trimmed by each opaque band from the edge it hugs. A band only ever eats
 * into the area from its own side; one with no size is no band.
 */
export function clearArea(stage: { width: number; height: number }, viewport: Box | null, occluders: readonly Occluder[]): Box {
  let l = 0;
  let t = 0;
  let r = stage.width;
  let b = stage.height;
  if (viewport !== null) {
    l = Math.max(l, viewport.left);
    t = Math.max(t, viewport.top);
    r = Math.min(r, viewport.left + viewport.width);
    b = Math.min(b, viewport.top + viewport.height);
  }
  for (const { edge, box } of occluders) {
    if (!(box.width > 0 && box.height > 0)) continue;
    if (edge === "top") t = Math.max(t, box.top + box.height);
    else if (edge === "bottom") b = Math.min(b, box.top);
    else if (edge === "left") l = Math.max(l, box.left + box.width);
    else r = Math.min(r, box.left);
  }
  return { left: l, top: t, width: Math.max(0, r - l), height: Math.max(0, b - t) };
}

/**
 * Where the whole frame (`video`, its pixel size) renders in the stage under
 * `fit`. `cover` covers the whole stage, centred — exactly what CSS
 * `object-fit: cover` on a stage-sized video draws; `contain` and `maxcrop`
 * are sized against the clear area and centred in it.
 */
export function frameBoxFor(
  fit: FitPolicy,
  video: { width: number; height: number },
  stage: { width: number; height: number },
  clear: Box,
): Box {
  const vw = video.width;
  const vh = video.height;
  if (fit === "cover" || clear.width <= 0 || clear.height <= 0) {
    const scale = Math.max(stage.width / vw, stage.height / vh);
    const width = vw * scale;
    const height = vh * scale;
    return { left: (stage.width - width) / 2, top: (stage.height - height) / 2, width, height };
  }
  const containScale = Math.min(clear.width / vw, clear.height / vh);
  let scale = containScale;
  if (fit === "maxcrop") {
    const keep = 1 - 2 * MAX_CROP_PER_SIDE;
    const coverScale = Math.max(clear.width / vw, clear.height / vh);
    scale = Math.max(containScale, Math.min(coverScale, clear.width / (vw * keep), clear.height / (vh * keep)));
  }
  const width = vw * scale;
  const height = vh * scale;
  return {
    left: clear.left + (clear.width - width) / 2,
    top: clear.top + (clear.height - height) / 2,
    width,
    height,
  };
}

/**
 * The part of the frame box inside the clear area, as fractions of the
 * frame — `null` when nothing of the frame is visible (a stage with no size).
 */
export function visibleRegionOf(frame: Box, clear: Box): FrameRegion | null {
  if (!(frame.width > 0 && frame.height > 0)) return null;
  const l = Math.max(frame.left, clear.left);
  const t = Math.max(frame.top, clear.top);
  const r = Math.min(frame.left + frame.width, clear.left + clear.width);
  const b = Math.min(frame.top + frame.height, clear.top + clear.height);
  if (r <= l || b <= t) return null;
  return {
    x: (l - frame.left) / frame.width,
    y: (t - frame.top) / frame.height,
    width: (r - l) / frame.width,
    height: (b - t) / frame.height,
  };
}

/**
 * The video element's own box for a fit other than `cover`: the frame box
 * clipped to the stage, filled with `object-fit: cover` at an
 * `object-position` that puts the frame back where the frame box says. At
 * most one axis is clipped (the frame is sized against the clear area, which
 * the stage holds), so cover draws the frame at exactly the frame box's
 * scale. `null` for `cover`, which the stage-sized element draws on its own.
 */
export function videoBoxFor(
  fit: FitPolicy,
  frame: Box,
  stage: { width: number; height: number },
): { box: Box; position: { x: number; y: number } } | null {
  if (fit === "cover") return null;
  const l = Math.max(0, frame.left);
  const t = Math.max(0, frame.top);
  const r = Math.min(stage.width, frame.left + frame.width);
  const b = Math.min(stage.height, frame.top + frame.height);
  const box = { left: l, top: t, width: Math.max(0, r - l), height: Math.max(0, b - t) };
  // CSS puts the content at box + (box − content) × position.
  const at = (clip: number, overflow: number) => (overflow > 0.5 ? Math.min(1, Math.max(0, clip / overflow)) : 0.5);
  return {
    box,
    position: { x: at(l - frame.left, frame.width - box.width), y: at(t - frame.top, frame.height - box.height) },
  };
}

/** Whether two regions are the same to a tenth of a pixel on a 4000 px frame. */
export function sameRegion(a: FrameRegion | null, b: FrameRegion | null): boolean {
  if (a === null || b === null) return a === b;
  const close = (p: number, q: number) => Math.abs(p - q) < 2.5e-5;
  return close(a.x, b.x) && close(a.y, b.y) && close(a.width, b.width) && close(a.height, b.height);
}

/**
 * A control drawn OVER the picture somewhere other than along an edge — a
 * glass button in the top row, the hint pill, a diagnostics HUD — marked
 * `data-scan-occluder="spot"` by the layout. An edge band cannot stand for
 * it (trimming the clear area to clear a 44 px button would shrink the whole
 * camera); instead each is carried as its own rectangle, in frame fractions
 * ({@link spotsInFrame}), and a page with a corner under one is not "fully
 * visible" ({@link cornerUnderSpot}).
 */
export function spotsInFrame(frame: Box, spots: readonly Box[]): FrameRegion[] {
  if (!(frame.width > 0 && frame.height > 0)) return [];
  const out: FrameRegion[] = [];
  for (const s of spots) {
    if (!(s.width > 0 && s.height > 0)) continue;
    const x = (s.left - frame.left) / frame.width;
    const y = (s.top - frame.top) / frame.height;
    const width = s.width / frame.width;
    const height = s.height / frame.height;
    if (x >= 1 || y >= 1 || x + width <= 0 || y + height <= 0) continue;
    out.push({ x, y, width, height });
  }
  return out;
}

/**
 * Whether any of the four corners (frame fractions) lies under a spot,
 * grown by `pad` (a share of the frame's width and height) — a corner
 * peeking out by a pixel from under a button is not one the person can see.
 */
export function cornerUnderSpot(
  corners: readonly { x: number; y: number }[],
  spots: readonly FrameRegion[],
  pad = 0.01,
): boolean {
  return corners.some((p) =>
    spots.some((s) => p.x >= s.x - pad && p.x <= s.x + s.width + pad && p.y >= s.y - pad && p.y <= s.y + s.height + pad),
  );
}
