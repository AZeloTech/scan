/**
 * The diagnostics event stream (`onDiagnostics` on `<ScanFlow>`, experimental):
 * the envelope, the copy and the rate limit every event goes through.
 *
 * The library only ever *calls* the host's function. Nothing here sends,
 * stores or buffers anything; there is no URL, no timer and no queue. When
 * the host passes no callback there is no sink at all (`null`), and every
 * call site is written `sink?.emit(...)` or behind `sink !== null`, so an
 * absent callback costs a null check and builds no event.
 *
 * What may travel is fixed by the type (`ScanDiagnosticsPayload` in
 * `types.ts`) and enforced again here, at run time, by {@link cleanValue}:
 * finite numbers (rounded), booleans, null, short strings the library itself
 * made (enums and the HUD's reason line), and plain objects of those. An
 * array, a typed array, a Blob, an ImageBitmap, a canvas — anything that is
 * not a plain object — is dropped, so no pixel can ride along by accident.
 */

import type { ScanDiagnosticsEvent, ScanDiagnosticsPayload } from "@/types";

export const DIAGNOSTICS_VERSION = 1 as const;

/** Pass samples are at most this often (two a second). */
export const PASS_SAMPLE_MS = 500;

/**
 * A sample a little early for its slot still counts for that slot: a sampler
 * on a {@link PASS_SAMPLE_MS} timer lands a millisecond either side of it.
 * The slots themselves stay {@link PASS_SAMPLE_MS} apart on average.
 */
export const PASS_JITTER_MS = 50;

/** Longest string an event may carry — a reason line, never a sentence. */
export const MAX_STRING = 96;

export interface DiagnosticsSink {
  /** Stamp, copy and hand one event to the host. A throwing host is ignored. */
  emit(payload: ScanDiagnosticsPayload): void;
  /**
   * Whether a pass sample may go now: true at most once per
   * {@link PASS_SAMPLE_MS}. Asked before the sample is built.
   */
  passDue(): boolean;
}

/**
 * A copy of `value` with only what an event may carry: finite numbers
 * (rounded to 3 decimals), booleans, null, strings cut to {@link MAX_STRING},
 * and plain objects of those. Anything else becomes `null` (at the top) or is
 * left out (inside an object).
 */
export function cleanValue(value: unknown): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "number":
      return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
    case "boolean":
      return value;
    case "string":
      return value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value;
    case "object": {
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return null;
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        const cleaned = cleanValue(inner);
        if (cleaned !== null || inner === null) out[key] = cleaned;
      }
      return out;
    }
    default:
      return null;
  }
}

/** The sink for a host's `onDiagnostics`, or null when it passed none — then nothing is ever built for it. */
export function diagnosticsSinkFor(
  callback: ((event: ScanDiagnosticsEvent) => void) | undefined,
  clock?: () => number,
): DiagnosticsSink | null {
  return callback === undefined ? null : createDiagnosticsSink(callback, clock);
}

export function createDiagnosticsSink(
  deliver: (event: ScanDiagnosticsEvent) => void,
  clock: () => number = () => performance.now(),
): DiagnosticsSink {
  const origin = clock();
  let seq = 0;
  /** When the next pass sample may go (a budget, so a sampler timer's jitter does not halve the rate). */
  let nextPass = Number.NEGATIVE_INFINITY;
  return {
    emit(payload) {
      const body = cleanValue(payload) as ScanDiagnosticsPayload;
      const event = { v: DIAGNOSTICS_VERSION, seq, t: Math.round(clock() - origin), ...body } as ScanDiagnosticsEvent;
      seq += 1;
      try {
        deliver(event);
      } catch {
        // An instrument must never be able to break the thing it measures.
      }
    },
    passDue() {
      const now = clock();
      if (now < nextPass - PASS_JITTER_MS) return false;
      nextPass = Math.max(nextPass + PASS_SAMPLE_MS, now + PASS_SAMPLE_MS - PASS_JITTER_MS);
      return true;
    },
  };
}

/** A quad's corners, as fractions of the frame. */
interface QuadLike {
  topLeft: { x: number; y: number };
  topRight: { x: number; y: number };
  bottomRight: { x: number; y: number };
  bottomLeft: { x: number; y: number };
}

/**
 * The largest distance any corner moved between two quads (fractions of a
 * `width` × `height` frame), as a percentage of that frame's diagonal.
 */
export function maxCornerMovePct(from: QuadLike, to: QuadLike, width: number, height: number): number {
  const diagonal = Math.hypot(width, height);
  if (!(diagonal > 0)) return 0;
  let largest = 0;
  for (const key of ["topLeft", "topRight", "bottomRight", "bottomLeft"] as const) {
    const moved = Math.hypot((to[key].x - from[key].x) * width, (to[key].y - from[key].y) * height);
    if (moved > largest) largest = moved;
  }
  return (largest / diagonal) * 100;
}
