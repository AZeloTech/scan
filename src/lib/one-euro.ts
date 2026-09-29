/**
 * The live overlay's display filter: a One-Euro filter per corner coordinate.
 *
 * The detector answers several times a second and each answer is a little off
 * in its own direction — a corner that should sit still swims by a pixel or
 * two, and a hand that trembles moves the page by several. A fixed low-pass
 * trades one against the other: heavy enough to calm a still page, it lags a
 * moving one; light enough to follow the hand, it shows every flicker. The
 * One-Euro filter (Casiez, Roussel & Vogel, CHI 2012) adapts its cutoff to the
 * signal's own speed — `cutoff = minCutoff + beta·|velocity|` — so a still
 * corner is smoothed hard and a moving one is followed closely.
 *
 * **It shapes what is drawn, never what is measured.** Acceptance,
 * arbitration, the capture buffer and the probe all read the raw, timestamped
 * detections; only the overlay's target goes through here. Time is the
 * *frame's* time (when the frame the detection describes was sampled), in
 * milliseconds, so a detection that arrived late is filtered at the moment it
 * describes.
 *
 * Pure and DOM-free: tested in `one-euro.test.ts`.
 */

import { CORNER_KEYS, type NormalizedQuad } from "@/lib/quad";

export interface OneEuroParams {
  /** Hz: the cutoff of a still signal — lower is calmer and laggier. */
  minCutoff: number;
  /** How fast the cutoff rises with speed, per (frame-width unit per second). */
  beta: number;
  /** Hz: the cutoff of the speed estimate itself. */
  derivativeCutoff: number;
}

/**
 * Chosen on the bench's sessions (approach, tremor, page swap, wider still;
 * the recorded detections replayed through a grid of settings): with the
 * refined live quad at the worker lane's ~8 passes a second, every setting
 * kept the overlay on the page within a point of drawing each answer as it
 * came, and this one — calm when still, quick the moment the page moves —
 * cut the drawn corners' frame-to-frame motion by about 8 %. See
 * `scripts/bench/README.md`, "The live loop".
 */
export const OVERLAY_ONE_EURO: OneEuroParams = {
  minCutoff: 1,
  beta: 64,
  derivativeCutoff: 5,
};

function alpha(cutoffHz: number, dtSeconds: number): number {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtSeconds);
}

/** One scalar channel. */
export class OneEuroFilter {
  private readonly params: OneEuroParams;
  private value: number | null = null;
  private derivative = 0;
  private at = 0;

  constructor(params: OneEuroParams) {
    this.params = params;
  }

  /** The filtered value of `x`, observed at `atMs`. A sample at or before the last one is taken as-is. */
  filter(x: number, atMs: number): number {
    if (this.value === null) {
      this.value = x;
      this.derivative = 0;
      this.at = atMs;
      return x;
    }
    const dt = (atMs - this.at) / 1000;
    if (!(dt > 0)) {
      // Same moment (or an older one): nothing to integrate over. Keep the
      // estimate; a frame cannot be described twice.
      return this.value;
    }
    const rawDerivative = (x - this.value) / dt;
    this.derivative += alpha(this.params.derivativeCutoff, dt) * (rawDerivative - this.derivative);
    const cutoff = this.params.minCutoff + this.params.beta * Math.abs(this.derivative);
    this.value += alpha(cutoff, dt) * (x - this.value);
    this.at = atMs;
    return this.value;
  }

  /** The estimated speed, units per second. */
  speed(): number {
    return this.derivative;
  }

  reset(): void {
    this.value = null;
    this.derivative = 0;
    this.at = 0;
  }
}

/**
 * Four corners, eight channels. Distances are made isotropic by measuring y in
 * frame-width units (`aspect` = height / width), so a corner moving up the
 * frame is judged by the same speed as one moving across it.
 */
export class QuadOneEuro {
  private readonly channels: OneEuroFilter[];
  private aspect: number;
  private primed = false;

  constructor(params: OneEuroParams = OVERLAY_ONE_EURO, aspect = 1) {
    this.aspect = aspect;
    this.channels = Array.from({ length: 8 }, () => new OneEuroFilter(params));
  }

  /** The filtered quad for a raw detection of the frame sampled at `atMs`. */
  update(quad: NormalizedQuad, atMs: number, aspect: number = this.aspect): NormalizedQuad {
    if (this.primed && Math.abs(aspect - this.aspect) > 1e-6) this.reset();
    this.aspect = aspect;
    this.primed = true;
    const out = {} as NormalizedQuad;
    CORNER_KEYS.forEach((key, index) => {
      const x = this.channels[index * 2].filter(quad[key].x, atMs);
      const y = this.channels[index * 2 + 1].filter(quad[key].y * aspect, atMs) / aspect;
      out[key] = { x, y };
    });
    return out;
  }

  /** Forget the history: the next detection is taken as it is. */
  reset(): void {
    for (const channel of this.channels) channel.reset();
    this.primed = false;
  }
}
