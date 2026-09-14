"use client";

/**
 * Live capture hints — deliberately cheap, deliberately advisory.
 *
 * No OpenCV in the browser: a small grayscale sample a few times per second.
 * These numbers only drive an encouraging chip; the post-shutter capture gate
 * (`lib/capture-gate.ts`) owns the real verdict, so a wrong hint costs nothing
 * and never blocks the shutter.
 *
 * **What changed and why (bench 2026-08-13, 144 samples over 8 lab-report pages).**
 * The previous version gated on variance-of-Laplacian and mean luma. Both were
 * measured against what a text-recognition engine actually recovers, and both
 * were wrong:
 *
 *  - Variance-of-Laplacian is **scale-dependent**, so it inverts on the case
 *    that matters. A downscaled, unreadable frame scored 1502–2694 (value
 *    recall 0.01–0.30) while a very dark but perfectly readable one scored
 *    71–121 (recall 0.89–0.98). It nagged about the good photo and waved the
 *    useless one through. AUC 0.685.
 *  - **Darkness barely affects OCR at all**: mean recall 0.879 (dark) and 0.916
 *    (very dark) against 0.936 pristine. "Pouca luz" was a false alarm on
 *    captures that read fine, so it is downgraded to a nudge that fires only
 *    when the frame is dark enough to risk the *user* mis-framing.
 *
 * The replacement is the same scale-free sharpness the shutter gate uses
 * (`lib/capture-gate.ts`), which keeps the live chip and the post-shutter
 * assessment from ever contradicting each other.
 *
 * **Framing vs focus.** The sample is 320 px wide — far too coarse to resolve
 * text-line structure, so the live path deliberately does NOT try to judge text
 * size. That question is answered once, at full resolution, after the shutter.
 * Here we only answer "is the camera steady and is there light to frame by".
 */

import { sharpnessOf, SHARPNESS_FLOOR } from "@/lib/capture-gate";

export type FrameHint = "good" | "hold_still" | "low_light";

/** Sample width used for the heuristics — small on purpose. */
export const HINT_SAMPLE_WIDTH = 320;

/**
 * Live sharpness floor. Slightly below the shutter gate's own floor: the
 * viewfinder is a lower-resolution, motion-blurred view of the same scene, and
 * nagging a user whose capture would actually pass is the expensive error.
 */
const LIVE_SHARPNESS_FLOOR = SHARPNESS_FLOOR * 0.85;

/**
 * Mean luma (0–255) below which we mention the light. Lowered from 72: the
 * bench showed OCR surviving far darker frames than the old floor assumed, so
 * this now fires only for "you cannot see what you are framing" darkness.
 */
const LUMA_FLOOR = 45;

export interface FrameReading {
  hint: FrameHint;
  /** Scale-free blur/re-blur sharpness, 0…1. Higher is sharper. */
  sharpness: number;
  meanLuma: number;
}

function toGrayscale(data: Uint8ClampedArray, pixels: number): Float32Array {
  const gray = new Float32Array(pixels);
  for (let index = 0; index < pixels; index += 1) {
    const offset = index * 4;
    gray[index] =
      0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2];
  }
  return gray;
}

export function readFrame(image: ImageData): FrameReading {
  const { width, height } = image;
  const pixels = width * height;
  if (pixels === 0) {
    return { hint: "good", sharpness: 1, meanLuma: 255 };
  }
  const gray = toGrayscale(image.data, pixels);

  let lumaSum = 0;
  for (let index = 0; index < pixels; index += 1) lumaSum += gray[index];
  const meanLuma = lumaSum / pixels;

  const sharpness = sharpnessOf(gray, width, height);

  // Focus first: it is the failure mode that actually destroys OCR. Light is a
  // distant second and only worth mentioning when it is genuinely too dark.
  let hint: FrameHint = "good";
  if (sharpness < LIVE_SHARPNESS_FLOOR) hint = "hold_still";
  else if (meanLuma < LUMA_FLOOR) hint = "low_light";

  return { hint, sharpness, meanLuma };
}


