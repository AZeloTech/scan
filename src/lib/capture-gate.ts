"use client";

/**
 * On-device capture gate — "will this photo OCR?", answered without OCR.
 *
 * Measured 2026-08-13 over 144 samples (8 lab-report pages × an 18-step
 * degradation ladder: blur, JPEG, downscale, darkness, glare, combinations),
 * labelled by what a text-recognition engine actually recovered from each one.
 * The corpus itself is not distributed with this library; what it produced —
 * the calibration and the reasoning below — is. Three results drove this file:
 *
 *  1. **Only blur and resolution break OCR.** Mean value recall by degradation:
 *     very dark 0.916, big glare 0.904, JPEG q20 0.931 — all ≈ pristine (0.936).
 *     Versus blur σ2.5 → 0.336, 35 % scale → 0.214, 25 % scale → 0.000.
 *     Recognition normalises exposure and shrugs off compression; it cannot
 *     invent strokes that blur erased or pixels that downscaling removed.
 *  2. **Variance-of-Laplacian is the WRONG metric — it is scale-dependent.**
 *     A downscaled, unreadable capture scored `lap_var` 1502–2694 at 5–6 px text
 *     (recall 0.01–0.30); a very dark, perfectly readable one scored 71–121 at
 *     16–19 px text (recall 0.89–0.98). Twenty times *higher* on the useless
 *     photo. AUC for `lap_var` was only 0.685.
 *  3. **Sharpness × text height is what works.** The two failure modes are
 *     independent — sharp-but-tiny fails, large-but-blurry fails — so the
 *     product of a scale-free focus measure and a focus-free size measure beats
 *     every single feature: **AUC 0.895**.
 *
 * Re-derived against this file's own arithmetic the product scores **AUC
 * 0.899**, and the shipped floors give 77 true-pass / 22 false-pass /
 * **0 false-retake** / 45 true-retake — it never rejected a capture that would
 * have read fine, while stopping ~67 % of the ones that were going to fail.
 *
 * ⚠️ **Those numbers come from SYNTHETIC degradations of 4 documents.** The
 * method and the feature ranking should hold; the constants must be re-derived
 * on real phone captures. Nothing here blocks anything — a failed reading is an
 * *offer* to retake, never a refusal — but a wrong floor still nags a user who
 * did nothing wrong.
 *
 * There is no recalibration corpus inside this library and there cannot be
 * one: nothing is logged, nothing is stored and nothing leaves the device.
 * A host that wants to re-derive the floors builds its own corpus from the
 * `quality` events it receives on `onEvent`, which carry a verdict and a page
 * number and nothing else.
 */

import { decodeToCanvas } from "@/lib/image";

/** Long edge the measurement runs at. Big enough to resolve text lines, small
 *  enough to stay ~10 ms; every constant below is calibrated at this size. */
export const GATE_SAMPLE_LONG_EDGE = 1000;

/**
 * Floors, derived against THIS file's exact arithmetic (3-tap binomial blur,
 * unnormalised Sobel, 1000 px long edge) — not against the prototype's numpy /
 * PIL equivalents, which produce a different sharpness scale. Re-derived by
 * `gate_recalibrate.py` over the same 144 labelled samples.
 *
 * This is the zero-false-retake operating point: on the bench set it passed all
 * 77 captures that OCR'd (FN = 0) while stopping 45 of the 67 that were doomed
 * (67 %), at the cost of 22 uploads that would have failed anyway.
 */
export const SCORE_FLOOR = 1.64;

/** Sharpness below this reads as camera shake / out of focus, at any size. */
export const SHARPNESS_FLOOR = 0.1068;

/** Text-line height (in native capture pixels) OCR needs to resolve glyphs. */
export const TEXT_HEIGHT_FLOOR = 7;

/** Projection-profile sanity clamp. Outside this the measurement degenerated —
 *  on one bench variant the whole frame read as a single ink run (532 px). */
const TEXT_HEIGHT_PLAUSIBLE = { min: 3, max: 80 } as const;

/**
 * Why a capture is weak. `unknown` means the measurement itself degenerated and
 * the caller must NOT treat it as a failure — absence of a reading is not
 * evidence of a bad photo.
 */
export type GateReason = "ok" | "blurry" | "too_small" | "unknown";

export interface GateReading {
  /** Scale-free focus measure, 0…1. Higher is sharper. */
  sharpness: number;
  /** Estimated text-line height in NATIVE capture pixels. */
  textHeightPx: number;
  /** `sharpness × textHeightPx` — the decision statistic (AUC 0.895). */
  score: number;
  /** Whether the capture clears the floors. */
  pass: boolean;
  reason: GateReason;
}

/**
 * Grayscale luma from RGBA, Rec.601 — the same weights `hints.ts` uses so the
 * live hint and the shutter gate cannot disagree about what "bright" means.
 */
function toGrayscale(data: Uint8ClampedArray, pixels: number): Float32Array {
  const gray = new Float32Array(pixels);
  for (let index = 0; index < pixels; index += 1) {
    const offset = index * 4;
    gray[index] =
      0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2];
  }
  return gray;
}

/**
 * Mean Sobel gradient magnitude. Deliberately the *mean* and not the variance:
 * the ratio of two means is scale-free, which is the whole fix for finding (2).
 */
function meanGradient(gray: Float32Array, width: number, height: number): number {
  if (width < 3 || height < 3) return 0;
  let sum = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const gx =
        -gray[i - width - 1] + gray[i - width + 1] -
        2 * gray[i - 1] + 2 * gray[i + 1] -
        gray[i + width - 1] + gray[i + width + 1];
      const gy =
        -gray[i - width - 1] - 2 * gray[i - width] - gray[i - width + 1] +
        gray[i + width - 1] + 2 * gray[i + width] + gray[i + width + 1];
      sum += Math.hypot(gx, gy);
      count += 1;
    }
  }
  return count === 0 ? 0 : sum / count;
}

/** Separable 3-tap binomial blur (≈ Gaussian σ1), run in place-ish. */
function blur3(gray: Float32Array, width: number, height: number): Float32Array {
  const tmp = new Float32Array(gray.length);
  const out = new Float32Array(gray.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const left = x > 0 ? gray[i - 1] : gray[i];
      const right = x < width - 1 ? gray[i + 1] : gray[i];
      tmp[i] = 0.25 * left + 0.5 * gray[i] + 0.25 * right;
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const up = y > 0 ? tmp[i - width] : tmp[i];
      const down = y < height - 1 ? tmp[i + width] : tmp[i];
      out[i] = 0.25 * up + 0.5 * tmp[i] + 0.25 * down;
    }
  }
  return out;
}

/**
 * Blur/re-blur sharpness (Crete et al.): a sharp image loses a lot of gradient
 * energy when blurred again; an already-smeared one barely changes. Because it
 * is a RATIO of two gradient means it is independent of image size and of how
 * much detail the page happens to carry — precisely where variance-of-Laplacian
 * failed on the bench.
 */
export function sharpnessOf(
  gray: Float32Array,
  width: number,
  height: number,
): number {
  const sharp = meanGradient(gray, width, height);
  if (sharp <= 1e-6) return 0;
  const soft = meanGradient(blur3(gray, width, height), width, height);
  return Math.max(0, Math.min(1, 1 - soft / sharp));
}

/** Otsu threshold over a 256-bin luma histogram. */
function otsuThreshold(gray: Float32Array): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i += 1) {
    hist[Math.max(0, Math.min(255, Math.round(gray[i])))] += 1;
  }
  let total = 0;
  let sumAll = 0;
  for (let t = 0; t < 256; t += 1) {
    total += hist[t];
    sumAll += t * hist[t];
  }
  let weightBack = 0;
  let sumBack = 0;
  let best = 0;
  let bestVariance = -1;
  for (let t = 0; t < 256; t += 1) {
    weightBack += hist[t];
    if (weightBack === 0) continue;
    const weightFore = total - weightBack;
    if (weightFore === 0) break;
    sumBack += t * hist[t];
    const meanBack = sumBack / weightBack;
    const meanFore = (sumAll - sumBack) / weightFore;
    const variance = weightBack * weightFore * (meanBack - meanFore) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      best = t;
    }
  }
  return best;
}

/**
 * Text-line height from a horizontal projection profile: binarize, count the
 * dark fraction of every pixel row, and read off the runs of "ink rows". Each
 * run is one line of text; the median run length is the line height.
 *
 * Returns 0 when the profile degenerates (no runs, or a single run swallowing
 * the frame) — the caller maps that to `unknown`, never to "bad photo".
 */
export function textLineHeight(
  gray: Float32Array,
  width: number,
  height: number,
): number {
  const threshold = otsuThreshold(gray);
  const inkPerRow = new Float32Array(height);
  let inkTotal = 0;
  for (let y = 0; y < height; y += 1) {
    let dark = 0;
    for (let x = 0; x < width; x += 1) {
      if (gray[y * width + x] < threshold) dark += 1;
    }
    inkPerRow[y] = dark / width;
    inkTotal += inkPerRow[y];
  }
  const meanInk = inkTotal / Math.max(1, height);
  const rowFloor = Math.max(0.01, meanInk * 0.5);

  const runs: number[] = [];
  let current = 0;
  for (let y = 0; y < height; y += 1) {
    if (inkPerRow[y] > rowFloor) current += 1;
    else if (current > 0) {
      runs.push(current);
      current = 0;
    }
  }
  if (current > 0) runs.push(current);
  if (runs.length === 0) return 0;
  runs.sort((a, b) => a - b);
  return runs[Math.floor(runs.length / 2)];
}

/**
 * Assess an already-sampled frame.
 *
 * `nativeLongEdge` is the long edge of the ORIGINAL capture, so the text height
 * measured on the sample can be scaled back to the pixels OCR will actually
 * see. Pass the sample's own long edge when the frame was not downscaled.
 *
 * **This never throws and never returns a hard failure it is unsure about.**
 * A degenerate measurement yields `reason: "unknown"` with `pass: true`, so the
 * gate can only ever fail a capture it positively measured as weak — matching
 * the scanner's standing "false-ok beats false-warn" posture.
 */
export function assessFrame(image: ImageData, nativeLongEdge: number): GateReading {
  const { width, height } = image;
  const pixels = width * height;
  if (pixels === 0) {
    return { sharpness: 0, textHeightPx: 0, score: 0, pass: true, reason: "unknown" };
  }
  const gray = toGrayscale(image.data, pixels);
  const sharpness = sharpnessOf(gray, width, height);

  const sampleLongEdge = Math.max(width, height);
  const scaleBack = Math.max(1, nativeLongEdge / Math.max(1, sampleLongEdge));
  const sampleLineHeight = textLineHeight(gray, width, height);
  const textHeightPx = sampleLineHeight * scaleBack;

  const plausible =
    sampleLineHeight > 0 &&
    textHeightPx >= TEXT_HEIGHT_PLAUSIBLE.min &&
    textHeightPx <= TEXT_HEIGHT_PLAUSIBLE.max * scaleBack;
  if (!plausible) {
    // Could not read the page's line structure — say so rather than guess.
    return {
      sharpness,
      textHeightPx: 0,
      score: 0,
      pass: true,
      reason: "unknown",
    };
  }

  const score = sharpness * textHeightPx;
  if (sharpness < SHARPNESS_FLOOR) {
    return { sharpness, textHeightPx, score, pass: false, reason: "blurry" };
  }
  if (textHeightPx < TEXT_HEIGHT_FLOOR) {
    return { sharpness, textHeightPx, score, pass: false, reason: "too_small" };
  }
  if (score < SCORE_FLOOR) {
    // Below the floor but neither axis is individually damning: attribute the
    // shortfall to whichever axis is further from comfortable.
    const reason: GateReason =
      sharpness / SHARPNESS_FLOOR < textHeightPx / TEXT_HEIGHT_FLOOR
        ? "blurry"
        : "too_small";
    return { sharpness, textHeightPx, score, pass: false, reason };
  }
  return { sharpness, textHeightPx, score, pass: true, reason: "ok" };
}

/**
 * Draw `source` into `canvas` at the gate's sample size and assess it.
 * Returns `null` when a 2-D context is unavailable — again, never a failure.
 */
/**
 * Assess an encoded image (gallery pick, or the un-warped frame behind a
 * corner adjustment) by decoding it first.
 *
 * Every upload path is measured, not just the shutter: an unmeasured upload
 * silently becomes `ok`, which is the one way a genuinely bad page can reach
 * the user with no warning at all.
 *
 * Never throws — a decode failure is `null`, i.e. "not measured".
 */
export async function assessBlob(blob: Blob): Promise<GateReading | null> {
  try {
    const canvas = await decodeToCanvas(blob);
    const scratch = document.createElement("canvas");
    return assessSource(canvas, canvas.width, canvas.height, scratch);
  } catch {
    return null;
  }
}

export function assessSource(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  canvas: HTMLCanvasElement,
): GateReading | null {
  if (sourceWidth === 0 || sourceHeight === 0) return null;
  const longEdge = Math.max(sourceWidth, sourceHeight);
  const scale = Math.min(1, GATE_SAMPLE_LONG_EDGE / longEdge);
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) return null;
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  return assessFrame(image, longEdge);
}
