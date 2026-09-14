/**
 * Everything specific to the classical (Rust/WASM) engine that the uvdoc path
 * has no equivalent of: what crosses the TS→wasm boundary as input, and the
 * confidence layer that comes back as output. Every number in this file is
 * transcribed from the classical engine's own tuning — none of it is
 * re-derived here.
 *
 * Kept out of `sampler.ts`/`guards.ts`/`index.ts` on purpose: those files are
 * shared by both engines and a reader of them should not have to hold the
 * classical engine's status-JSON shape or its own resample rule in their head
 * to follow the uvdoc path. This module is the one place that knowledge lives.
 */

import { fitLongEdge } from "./sampler.ts";
import type { CropBox, DewarpFallbackReason, DewarpPoint, DewarpQuad, RgbaImage } from "./types.ts";
import type { RgbaCropBuffer } from "./worker-protocol.ts";

/**
 * The ceiling on what the TS side ever hands the wasm module, on the crop's
 * long edge. Matches `proc_max_side` at the `"default"`
 * preset exactly — handing over more would only be wasted transfer and wasm
 * memory, since the Rust pipeline's own internal resize would immediately
 * downsample it right back to this same number.
 */
export const WASM_INPUT_MAX_SIDE = 1600;

/**
 * `opts_json`: the `default` preset with `use_line_term=true` — turning the
 * LSD line term on lifted field acceptance 5/8 → 7/8 through the unchanged
 * guard layer, so the full Kil 2017 mode is the classical default. The reserved
 * fields stay `null` so `QualityOptions`'s full shape has a home in the ABI
 * without a second design pass. Not a product knob today — there is no UI
 * surface that would ever pass anything else.
 */
const CLASSICAL_OPTS_BASE = {
  preset: "default",
  use_line_term: true,
  f_exif_px: null,
  max_nfev: null,
  n_outlier_iter: null,
} as const;

/**
 * Quad-aligned export framing: confirmed-quad corners, normalized `[0,1]`
 * over the **same crop rectangle**
 * {@link cropToClassicalInput} extracted from — not the wasm module's own
 * (possibly area-average-downsampled) input buffer. Normalizing against the
 * crop's own width/height rather than the buffer's is what makes the ≤1600px
 * ceiling a no-op for this value (the same argument that makes the ABI's
 * `[-1,1]` grid convention resolution-independent applies identically
 * here: a uniform scale composed with a translation preserves a
 * `[0,1]` fraction of the same physical rectangle regardless of how many
 * pixels represent it).
 */
export interface NormalizedQuad {
  topLeft: [number, number];
  topRight: [number, number];
  bottomRight: [number, number];
  bottomLeft: [number, number];
}

/**
 * `(point - crop.origin) / (crop.span - 1)`, `align_corners` style — the
 * exact inverse of `crop.ts::cropIdentityPoint`, and the same convention
 * `composeInto` already assumes for every crop-relative fraction in this
 * engine. A corner landing exactly at `0` or `1` is expected, not an error:
 * `paddedCropBox` floors/ceils outward and then clamps to the canonical
 * image, so a quad corner near the frame edge routinely ends up flush
 * against the crop's own boundary.
 */
export function normalizeQuadToCrop(quad: DewarpQuad, crop: CropBox): NormalizedQuad {
  const spanX = Math.max(1, crop.width - 1);
  const spanY = Math.max(1, crop.height - 1);
  const at = (point: DewarpPoint): [number, number] => [
    (point.x - crop.left) / spanX,
    (point.y - crop.top) / spanY,
  ];
  return {
    topLeft: at(quad.topLeft),
    topRight: at(quad.topRight),
    bottomRight: at(quad.bottomRight),
    bottomLeft: at(quad.bottomLeft),
  };
}

/**
 * `opts_json`, optionally carrying the optional `quad` field
 * (`[[x,y],[x,y],[x,y],[x,y]]`, clockwise from the top-left, matching
 * {@link NormalizedQuad}'s own field order and `wasm.rs::parse_quad`'s
 * expected shape exactly). `quad` omitted reproduces the quad-less JSON
 * byte-for-byte ({@link CLASSICAL_OPTS_JSON}) — "no quad ⇒ current framing"
 * is a property of the wire format itself, not just the Rust side's parse.
 */
export function classicalOptsJson(quad?: NormalizedQuad): string {
  if (quad === undefined) return CLASSICAL_OPTS_JSON;
  return JSON.stringify({
    ...CLASSICAL_OPTS_BASE,
    quad: [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft],
  });
}

/** The fixed, quad-less `opts_json` — kept as a plain export for callers
 * (tests, the verify harness) that have no crop/quad in hand. */
export const CLASSICAL_OPTS_JSON = JSON.stringify(CLASSICAL_OPTS_BASE);

/** `dewarp_status_json`'s shape, verbatim. */
export interface ClassicalStatus {
  converged: boolean;
  kept_text_lines: number;
  total_text_lines: number;
  kept_segments: number;
  total_candidates: number;
  uses_confidence_filter: boolean;
  bound_saturation: {
    a: [boolean, boolean, boolean, boolean];
    rvec: [boolean, boolean, boolean];
    log_f: boolean;
  };
  output_aspect: number;
  input_aspect: number;
  boundary_used: boolean;
  residual_text_straightness_p90: number;
  residual_boundary_mean_px: number | null;
  /** The window fix — boy-scouted onto this
   * interface alongside `quad_corner_residual` below; both were already on
   * the wire (`pipeline.rs::DewarpStatus::to_json`) but missing here. */
  window_clip: { left: number; right: number; top: number; bottom: number; area_frac: number };
  window_clips_text: boolean;
  /** Quad-aligned export framing: the Rust side's own prediction of
   * `evaluateComposedMap`'s `boundary` corner metric for the grid this
   * status accompanies — `null` when no quad was honored. */
  quad_corner_residual: number | null;
  elapsed_ms: number;
}

/**
 * Parse `dewarp_status_json`'s output. `null` on anything malformed — not a
 * throw, because a status the TS side cannot read is not a reason to treat
 * the *page* as broken; the pixel-level guards and the semantic A/B are the
 * real safety net regardless of whether this cheaper, earlier signal parses.
 */
export function parseClassicalStatus(json: string): ClassicalStatus | null {
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value !== "object" || value === null) return null;
    return value as ClassicalStatus;
  } catch {
    return null;
  }
}

/** `output_aspect / input_aspect` outside this band is a framing red flag. */
const MIN_ASPECT_RATIO = 0.4;
const MAX_ASPECT_RATIO = 2.5;

/**
 * The four status-based fallback reasons, checked in the order they are
 * listed below. `null` when none trip — the run proceeds to the
 * pixel-level guards exactly as it would have without this layer.
 *
 * These are a *pre*-guard rung: cheap struct reads, before a single Jacobian
 * probe runs. They do not replace `evaluateComposedMap` — a classical engine
 * that reports `converged: true` over a folding grid is still caught by
 * `guard-jacobian` exactly as uvdoc would be.
 */
export function classicalFallbackReason(
  status: ClassicalStatus,
): DewarpFallbackReason | null {
  if (!status.converged) return "classical-non-convergent";
  if (status.kept_text_lines < 2) return "classical-insufficient-features";
  const { a, rvec } = status.bound_saturation;
  if (a.every((saturated) => saturated) && rvec.some((saturated) => saturated)) {
    return "classical-degenerate-bounds";
  }
  const aspectRatio =
    status.input_aspect === 0
      ? Number.POSITIVE_INFINITY
      : status.output_aspect / status.input_aspect;
  if (
    !Number.isFinite(aspectRatio) ||
    aspectRatio < MIN_ASPECT_RATIO ||
    aspectRatio > MAX_ASPECT_RATIO
  ) {
    return "classical-aspect-outlier";
  }
  return null;
}

/**
 * A true area-average (`INTER_AREA`-equivalent) downscale — every output
 * pixel is the weighted average of the source rectangle it covers, partial
 * source pixels included at their overlap fraction.
 *
 * This step **must not** be a naive single-tap bilinear pass: above
 * `WASM_INPUT_MAX_SIDE`, this TS-side resize
 * is the *only* resample a large capture's stage-0 resolution reduction ever
 * gets (the Rust pipeline's own `S0` becomes a no-op once the buffer already
 * fits under `proc_max_side`), so it silently substitutes for the Rust
 * pipeline's own carefully-ported `INTER_AREA` stage rather than composing
 * with it. A naive
 * bilinear tap here would alias exactly the fine text-stroke detail the
 * classical pipeline's line-detection stage depends on.
 *
 * Separable (horizontal pass, then vertical), alpha ignored on the way in and
 * forced to 255 on the way out — RGB is all the wasm side reads.
 */
export function areaAverageDownsample(
  image: RgbaImage,
  dstWidth: number,
  dstHeight: number,
): RgbaImage {
  const { width: srcWidth, height: srcHeight, data: src } = image;
  if (dstWidth === srcWidth && dstHeight === srcHeight) return image;

  const scaleX = srcWidth / dstWidth;
  const scaleY = srcHeight / dstHeight;

  // Horizontal pass: srcWidth×srcHeight RGBA8 → dstWidth×srcHeight RGB, f64.
  const horizontal = new Float64Array(dstWidth * srcHeight * 3);
  for (let y = 0; y < srcHeight; y += 1) {
    const rowIn = y * srcWidth * 4;
    const rowOut = y * dstWidth * 3;
    for (let dx = 0; dx < dstWidth; dx += 1) {
      const x0 = dx * scaleX;
      const x1 = Math.min(srcWidth, (dx + 1) * scaleX);
      let r = 0;
      let g = 0;
      let b = 0;
      let weight = 0;
      let x = x0;
      while (x < x1) {
        const xi = Math.min(srcWidth - 1, Math.floor(x));
        const next = Math.min(x1, xi + 1);
        const w = next - x;
        const index = rowIn + xi * 4;
        r += src[index] * w;
        g += src[index + 1] * w;
        b += src[index + 2] * w;
        weight += w;
        x = next;
      }
      const out = rowOut + dx * 3;
      const safeWeight = weight > 0 ? weight : 1;
      horizontal[out] = r / safeWeight;
      horizontal[out + 1] = g / safeWeight;
      horizontal[out + 2] = b / safeWeight;
    }
  }

  // Vertical pass: dstWidth×srcHeight → dstWidth×dstHeight RGBA8.
  const data = new Uint8ClampedArray(dstWidth * dstHeight * 4);
  for (let x = 0; x < dstWidth; x += 1) {
    for (let dy = 0; dy < dstHeight; dy += 1) {
      const y0 = dy * scaleY;
      const y1 = Math.min(srcHeight, (dy + 1) * scaleY);
      let r = 0;
      let g = 0;
      let b = 0;
      let weight = 0;
      let y = y0;
      while (y < y1) {
        const yi = Math.min(srcHeight - 1, Math.floor(y));
        const next = Math.min(y1, yi + 1);
        const w = next - y;
        const index = (yi * dstWidth + x) * 3;
        r += horizontal[index] * w;
        g += horizontal[index + 1] * w;
        b += horizontal[index + 2] * w;
        weight += w;
        y = next;
      }
      const safeWeight = weight > 0 ? weight : 1;
      const out = (dy * dstWidth + x) * 4;
      data[out] = r / safeWeight;
      data[out + 1] = g / safeWeight;
      data[out + 2] = b / safeWeight;
      data[out + 3] = 255;
    }
  }
  return { width: dstWidth, height: dstHeight, data };
}

/** A plain sub-copy of the crop rectangle — the crop is already integer-
 * aligned (`paddedCropBox` floors/ceils outward), so this is an exact
 * pixel-for-pixel extraction, never a resample. */
function extractCrop(source: RgbaImage, crop: CropBox): RgbaImage {
  const data = new Uint8ClampedArray(crop.width * crop.height * 4);
  const src = source.data;
  for (let row = 0; row < crop.height; row += 1) {
    const srcOffset = ((crop.top + row) * source.width + crop.left) * 4;
    const dstOffset = row * crop.width * 4;
    data.set(src.subarray(srcOffset, srcOffset + crop.width * 4), dstOffset);
  }
  return { width: crop.width, height: crop.height, data };
}

/**
 * The classical engine's input, materialized: the padded
 * crop, at native resolution unless that exceeds {@link WASM_INPUT_MAX_SIDE}
 * on its long edge, in which case it is area-averaged down to it. Never
 * upscaled here — a crop under the ceiling is handed over as-is; the Rust
 * pipeline's own `S0` stage does any upscaling it needs, internally, capped
 * at 3×, exactly matching the Python reference.
 */
export function cropToClassicalInput(
  source: RgbaImage,
  crop: CropBox,
  maxLongSide: number = WASM_INPUT_MAX_SIDE,
): RgbaCropBuffer {
  const extracted = extractCrop(source, crop);
  const target = fitLongEdge(extracted.width, extracted.height, maxLongSide);
  const resized =
    target.width === extracted.width && target.height === extracted.height
      ? extracted
      : areaAverageDownsample(extracted, target.width, target.height);
  return {
    data: new Uint8Array(resized.data.buffer, resized.data.byteOffset, resized.data.byteLength),
    width: resized.width,
    height: resized.height,
  };
}
