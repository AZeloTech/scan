"use client";

/**
 * The live loop's motion probe — the cheap answer to "did the scene change,
 * or did detection just miss?"
 *
 * The overlay holds a tracked quad through detection dropouts (the stale
 * horizon in `hooks/useLiveDetect.ts`), because on a stationary page a missed
 * pass is noise and retiring the brackets makes them flash. But the same hold
 * is wrong the moment the user swings the phone away: the brackets float over
 * a scene the quad was never measured on, and the capture buffer underneath
 * them (`takeQuadForCapture`) would hand those corners to a photo. This module
 * is how the loop tells the two apart: a dropped detection on a **still**
 * frame keeps the hold; a dropped detection on a **moved** frame ends it.
 *
 * The probe is deliberately crude — a {@link MOTION_PROBE_SIZE}² grayscale
 * thumbnail of the detection sample, compared to the previous pass's by mean
 * absolute difference. It runs once per detection pass (~700 ms apart), not
 * per animation frame, so its cost is one 24×24 draw and 576 subtractions.
 * It is not a tracker and never moves the quad; it only ever *ends* a hold.
 *
 * {@link MOTION_DROP_THRESHOLD} is calibrated from handheld field footage
 * (S25 Ultra, handheld, 700 ms probe spacing): deliberate repositioning
 * scored 0.10–0.22, ordinary hand tremor while aiming 0.03–0.09, a steady
 * hold ≤ 0.03. The threshold sits at the bottom of the repositioning band —
 * tremor must never break the hold, because tremor is exactly when the hold
 * earns its keep. Auto-exposure swings also raise the score; a scene whose
 * exposure is swinging is one the quad should not be trusted on either, so
 * that failure mode is welcome, not fought.
 */

/** Probe thumbnail edge, in pixels. 576 samples is plenty for "did it move". */
export const MOTION_PROBE_SIZE = 24;

/** Mean absolute luma difference (0–1) at which a held quad is dropped. */
export const MOTION_DROP_THRESHOLD = 0.1;

/**
 * Mean absolute difference between two probes, normalized to 0–1.
 *
 * `null` when there is nothing to compare against — no previous probe, or a
 * probe of a different length (a rotated camera resizes the sample; the first
 * probe after that describes a different geometry, not motion).
 */
export function frameMotionScore(
  previous: Uint8ClampedArray | null,
  next: Uint8ClampedArray,
): number | null {
  if (previous === null || previous.length !== next.length) return null;
  if (next.length === 0) return null;
  let sum = 0;
  for (let index = 0; index < next.length; index += 1) {
    sum += Math.abs(next[index] - previous[index]);
  }
  return sum / next.length / 255;
}

/**
 * Whether a missed detection on this frame should end the hold.
 *
 * An unknown score keeps the hold: "I could not measure motion" is the state
 * every loop starts in, and dropping on it would retire the quad on exactly
 * the pass after a camera rotation — a moment the page usually did not move.
 */
export function motionBreaksHold(score: number | null): boolean {
  return score !== null && score >= MOTION_DROP_THRESHOLD;
}

/**
 * Draws `source` into a {@link MOTION_PROBE_SIZE}² scratch canvas and returns
 * its luma plane. The scratch canvas is caller-owned and reused across passes;
 * `null` when the platform refuses a context — the loop then simply never
 * drops on motion, which is the behaviour from before this probe existed.
 */
export function probeLuma(
  source: HTMLCanvasElement,
  scratch: HTMLCanvasElement,
): Uint8ClampedArray | null {
  if (source.width === 0 || source.height === 0) return null;
  if (scratch.width !== MOTION_PROBE_SIZE) scratch.width = MOTION_PROBE_SIZE;
  if (scratch.height !== MOTION_PROBE_SIZE) scratch.height = MOTION_PROBE_SIZE;
  const context = scratch.getContext("2d", { willReadFrequently: true });
  if (context === null) return null;
  context.drawImage(source, 0, 0, MOTION_PROBE_SIZE, MOTION_PROBE_SIZE);
  let rgba: Uint8ClampedArray;
  try {
    rgba = context.getImageData(0, 0, MOTION_PROBE_SIZE, MOTION_PROBE_SIZE).data;
  } catch {
    return null;
  }
  const luma = new Uint8ClampedArray(MOTION_PROBE_SIZE * MOTION_PROBE_SIZE);
  for (let index = 0; index < luma.length; index += 1) {
    const at = index * 4;
    // Rec. 601 luma — the probe compares scenes, so perceptual weights beat a
    // plain channel average on colored desks and papers alike.
    luma[index] =
      0.299 * rgba[at] + 0.587 * rgba[at + 1] + 0.114 * rgba[at + 2];
  }
  return luma;
}
