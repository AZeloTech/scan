/**
 * Where the engine looks, how big the answer is, and what identifies it.
 *
 * Three pure decisions live here because they have to be made *once* and then
 * agreed on by everything downstream: the guards measure displacement against
 * this crop, the sampler walks this output size, and the cache is keyed by
 * this string. Recomputing any of them a second time is how the composed map
 * and the pixels it produced silently stop describing the same page.
 */

import type { DewarpEngineMode } from "./engine-mode.ts";
import type { CropBox, DewarpPoint, DewarpQuad } from "./types.ts";
import { QUAD_CORNERS } from "./types.ts";

/**
 * How much room the engine gets around the confirmed page, per side.
 *
 * The crop must not cut the page's own edge off — but every pixel of context
 * is also a pixel of resolution not spent on the page.
 *
 * The field-corpus finding behind it: on a 6 % pad, the
 * renderer's quad-aligned export window is ceiling-limited by the crop's own
 * extent on 2 of 7 single-page field captures (`20260816_145002`,
 * `20260816_145825` — the certified window and the crop-bounds-only extent
 * were bit-for-bit identical, i.e. the crop, not the window-fitting
 * algorithm, was the binding constraint) — both then miss
 * `evaluateComposedMap`'s `boundary` guard (`MAX_BOUNDARY_OFFSET_FRACTION =
 * 0.05`) by 1.9–2.6 points.
 *
 * Empirical basis (`scripts/verify-classical-engine.mjs` re-run against the
 * 8-capture field corpus, 2026-08-18): swept `{0.08, 0.10, 0.12}`. **0.08** is the smallest
 * of the three that flips both `145002` and `145825` to ACCEPTED without
 * regressing the 3 captures already accepted at 6 % (`144930`, `145103`,
 * `150015`) and while `150037` (the booklet spread) keeps falling back, as
 * required. 0.10 and 0.12 both *regress* `144930` to FALLBACK (`out-of-
 * bounds` — a wider pad shrinks that capture's own detected-content fraction
 * of the crop past what its degenerate 2-line solve can frame safely) — so
 * this is not "wider is safer within the swept range," it is specifically
 * 0.08 that threads both needles on this corpus. Not swept below 0.08; not
 * claimed optimal past it.
 *
 * Deliberately a fixed pad: an adaptive expansion (retry wider when the map
 * runs into the crop border) would make the outcome depend on how many
 * inferences we could afford, and the point is one inference with a verdict.
 */
export const CLASSICAL_CROP_PAD = 0.08;

/** Bumped whenever the padding rule changes — part of the render key. */
export const CROP_PAD_VERSION = "pad-v1";

/**
 * The one place the pad is decided, so a refactor that inlines it inlines this
 * function rather than a bare literal. `geometry.test.ts` pins it directly.
 *
 * Takes the mode it applies to even though there is only one engine left: the
 * render key is mode-keyed and the call sites already carry the value, so
 * threading it keeps the pad and the key provably about the same producer.
 */
export function cropPadForMode(_mode: DewarpEngineMode): number {
  return CLASSICAL_CROP_PAD;
}

function corners(quad: DewarpQuad): DewarpPoint[] {
  return QUAD_CORNERS.map((key) => quad[key]);
}

function distance(a: DewarpPoint, b: DewarpPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * The padded axis-aligned crop the engine sees, clipped to the canonical image.
 *
 * The pad is a fraction of the quad's *own* bounding box rather than of the
 * frame, so a page photographed from far away is not handed a crop that is
 * mostly table.
 */
export function paddedCropBox(
  quad: DewarpQuad,
  canonicalWidth: number,
  canonicalHeight: number,
  pad: number = CLASSICAL_CROP_PAD,
): CropBox {
  const points = corners(quad);
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const padX = (maxX - minX) * pad;
  const padY = (maxY - minY) * pad;

  const left = Math.max(0, Math.floor(minX - padX));
  const top = Math.max(0, Math.floor(minY - padY));
  const right = Math.min(canonicalWidth, Math.ceil(maxX + padX));
  const bottom = Math.min(canonicalHeight, Math.ceil(maxY + padY));

  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

/**
 * The output size, by the same rule scanic's own `extractDocument` uses.
 *
 * Derived rather than imported: scanic computes it inside the function that
 * also warps, so there is nothing to call. The rule (read off `scanic.js`,
 * v1.6.0) is *max of each opposite pair*, rounded —
 *
 *   width  = round(max(|BR−BL|, |TR−TL|))
 *   height = round(max(|TR−BR|, |TL−BL|))
 *
 * Matching it exactly is what lets a dewarped page and a homography-flattened
 * page of the same quad be swapped for one another without the layout, the
 * thumbnail or the PDF page box changing size.
 */
export function outputDimsFromQuad(quad: DewarpQuad): {
  width: number;
  height: number;
} {
  const width = Math.round(
    Math.max(
      distance(quad.bottomRight, quad.bottomLeft),
      distance(quad.topRight, quad.topLeft),
    ),
  );
  const height = Math.round(
    Math.max(
      distance(quad.topRight, quad.bottomRight),
      distance(quad.topLeft, quad.bottomLeft),
    ),
  );
  return { width: Math.max(1, width), height: Math.max(1, height) };
}

/**
 * The map a *perfectly flat* crop would produce: output (u,v) straight onto
 * the crop's own rectangle, `align_corners` style.
 *
 * This is the zero against which the displacement guard measures. It is not
 * the homography — it is "the model predicted nothing" — which is exactly the
 * baseline that makes "how far did this map move pixels" a statement about the
 * model rather than about the page's perspective.
 */
export function cropIdentityPoint(
  crop: CropBox,
  u: number,
  v: number,
): DewarpPoint {
  return {
    x: crop.left + u * (crop.width - 1),
    y: crop.top + v * (crop.height - 1),
  };
}

/** The crop's diagonal — the unit every displacement threshold is stated in. */
export function cropDiagonal(crop: CropBox): number {
  return Math.hypot(crop.width - 1, crop.height - 1);
}

/** The quad's diagonal — the unit the boundary-agreement threshold uses. */
export function quadDiagonal(quad: DewarpQuad): number {
  return Math.max(
    distance(quad.topLeft, quad.bottomRight),
    distance(quad.topRight, quad.bottomLeft),
  );
}

/** Everything that changes the pixels, and nothing that does not. */
export interface RenderKeyInput {
  /** Identifies the canonical image — a page id, a content hash, anything stable. */
  sourceId: string;
  quad: DewarpQuad;
  padVersion: string;
  modelVersion: string;
}

/**
 * FNV-1a, twice, over the same string with different offsets.
 *
 * A 64-bit-shaped key from two 32-bit lanes: enough to make an accidental
 * collision between two quads of the same page a non-event, and small enough
 * to compute synchronously without pulling in SubtleCrypto (which is async and
 * unavailable on insecure origins, neither of which a cache key should care
 * about).
 */
function fnv1a(text: string, offset: number): number {
  let hash = offset >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function hex8(value: number): string {
  return value.toString(16).padStart(8, "0");
}

/**
 * The identity of the pixels a job would produce.
 *
 * Corners are quantised to 1/100 px before hashing: the corner editor emits
 * float coordinates that jitter in the last bits without describing a
 * different page, and a key that changes on those bits would re-run a 12 s
 * inference for a page nobody moved.
 */
export function renderKeyFor(input: RenderKeyInput): string {
  const quadText = QUAD_CORNERS.map((key) => {
    const point = input.quad[key];
    return `${point.x.toFixed(2)},${point.y.toFixed(2)}`;
  }).join(";");
  const material = [
    input.sourceId,
    quadText,
    input.padVersion,
    input.modelVersion,
  ].join("|");
  return `${hex8(fnv1a(material, 0x811c9dc5))}${hex8(fnv1a(material, 0x7fffffff))}`;
}
