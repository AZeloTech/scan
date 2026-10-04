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
 *
 * `cleanValue` checks shapes, not meaning: it cannot tell an enum from a
 * short sentence. So every string in an event is one the library chose, and
 * the one event made from an object a host also holds — `flow`, from the
 * ScanEvent `onEvent` receives — is rebuilt from an allowlist by
 * {@link flowDiagnostic} before the host ever sees that object.
 */

import type {
  ScanDiagnosticsEvent,
  ScanDiagnosticsPayload,
  ScanErrorCode,
  ScanEvent,
  ScanQuality,
  ScanStep,
} from "@/types";

export const DIAGNOSTICS_VERSION = 1 as const;

/** Pass samples are at most this often (two a second). */
export const PASS_SAMPLE_MS = 500;

/**
 * A sample a little early for its slot still counts for that slot: a sampler
 * on a {@link PASS_SAMPLE_MS} timer lands a millisecond either side of it.
 * Two samples are never closer than `PASS_SAMPLE_MS - PASS_JITTER_MS`, and
 * no rolling second ever holds more than two ({@link PASS_WINDOW_MS}).
 */
export const PASS_JITTER_MS = 50;

/** The rolling window the pass-sample bound is stated over: at most two samples in any one. */
export const PASS_WINDOW_MS = 1000;

/**
 * How deep an event may nest. The deepest the library builds is a `flow`
 * event's ScanEvent (two levels); anything deeper — a cycle included — is
 * cut off here instead of recursing.
 */
export const MAX_DEPTH = 4;

/** Most keys one object in an event may carry; the widest the library builds (a pass sample) has 20. */
export const MAX_KEYS = 24;

/** Longest string an event may carry — a reason line, never a sentence. */
export const MAX_STRING = 96;

export interface DiagnosticsSink {
  /** Stamp, copy and hand one event to the host. A throwing host is ignored. */
  emit(payload: ScanDiagnosticsPayload): void;
  /**
   * Whether a pass sample may go now: never twice within
   * `PASS_SAMPLE_MS - PASS_JITTER_MS`, never three times within any
   * {@link PASS_WINDOW_MS}. Asked before the sample is built.
   */
  passDue(): boolean;
}

/**
 * A copy of `value` with only what an event may carry: finite numbers
 * (rounded to 3 decimals), booleans, null, strings cut to {@link MAX_STRING},
 * and plain objects of those, at most {@link MAX_DEPTH} deep and
 * {@link MAX_KEYS} wide. Anything else becomes `null` (at the top) or is left
 * out (inside an object). A cyclic object ends at the depth bound, so this
 * always returns.
 */
export function cleanValue(value: unknown, depth = 0): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "number":
      return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
    case "boolean":
      return value;
    case "string":
      return value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value;
    case "object": {
      if (depth >= MAX_DEPTH) return null;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return null;
      const out: Record<string, unknown> = {};
      let keys = 0;
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        if (keys >= MAX_KEYS) break;
        const cleaned = cleanValue(inner, depth + 1);
        if (cleaned !== null || inner === null) {
          out[key] = cleaned;
          keys += 1;
        }
      }
      return out;
    }
    default:
      return null;
  }
}

const STEPS: readonly ScanStep[] = ["capture", "corners", "review", "build"];
const QUALITIES: readonly ScanQuality[] = ["sharp", "blurred", "small_text", "unchecked"];
const ERROR_CODES: readonly ScanErrorCode[] = [
  "camera_denied",
  "no_camera",
  "asset_load",
  "model_init",
  "out_of_memory",
  "build_failed",
  "images_unreadable",
];
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | null =>
  typeof value === "string" && (values as readonly string[]).includes(value) ? (value as T) : null;
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * The `flow` diagnostics event for a {@link ScanEvent}: a fresh object built
 * field by field from an allowlist — each event name's own fields, each an
 * enum member or a finite number — never a copy of the object the host's
 * `onEvent` receives. A host that decorates its event (`event.patient = …`)
 * decorates only its own; an unknown name or an out-of-range value yields
 * `null` and no event. Call it *before* handing the event to the host.
 */
export function flowDiagnostic(event: ScanEvent): ScanEvent | null {
  const e = event as unknown as Record<string, unknown>;
  const n = (key: string) => count(e[key]);
  const all = <T extends ScanEvent>(built: T, ...values: unknown[]): T | null =>
    values.every((value) => value !== null) ? built : null;
  switch (e.name) {
    case "step": {
      const step = oneOf(STEPS, e.step);
      return all({ name: "step", step: step as ScanStep }, step);
    }
    case "capture": {
      const source = oneOf(["camera", "file"] as const, e.source);
      return all({ name: "capture", page: n("page") as number, source: source as "camera" }, n("page"), source);
    }
    case "retake":
    case "remove":
      return all({ name: e.name as "retake" | "remove", page: n("page") as number }, n("page"));
    case "reorder":
      return all({ name: "reorder", from: n("from") as number, to: n("to") as number }, n("from"), n("to"));
    case "dewarp": {
      const outcome = oneOf(["applied", "fallback", "declined"] as const, e.outcome);
      return all({ name: "dewarp", page: n("page") as number, outcome: outcome as "applied" }, n("page"), outcome);
    }
    case "quality": {
      const verdict = oneOf(QUALITIES, e.verdict);
      return all({ name: "quality", page: n("page") as number, verdict: verdict as ScanQuality }, n("page"), verdict);
    }
    case "size_ladder":
      return all({ name: "size_ladder", rung: n("rung") as number, bytes: n("bytes") as number }, n("rung"), n("bytes"));
    case "pdf_built":
      return all(
        { name: "pdf_built", pages: n("pages") as number, bytes: n("bytes") as number, ms: n("ms") as number },
        n("pages"),
        n("bytes"),
        n("ms"),
      );
    case "error": {
      const code = oneOf(ERROR_CODES, e.code);
      const recoverable = typeof e.recoverable === "boolean" ? e.recoverable : null;
      return all({ name: "error", code: code as ScanErrorCode, recoverable: recoverable as boolean }, code, recoverable);
    }
    case "cancel": {
      const reason = oneOf(["user", "error"] as const, e.reason);
      return all({ name: "cancel", reason: reason as "user", pages: n("pages") as number }, reason, n("pages"));
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
  /** The last two pass samples let through, newest first. */
  let last = Number.NEGATIVE_INFINITY;
  let beforeLast = Number.NEGATIVE_INFINITY;
  return {
    emit(payload) {
      // Cleaning is inside the guard too: whatever shape reaches it, the
      // scanner's own call (a capture, a step) never throws from here.
      try {
        const body = cleanValue(payload) as ScanDiagnosticsPayload;
        const event = { v: DIAGNOSTICS_VERSION, seq, t: Math.round(clock() - origin), ...body } as ScanDiagnosticsEvent;
        seq += 1;
        deliver(event);
      } catch {
        // An instrument must never be able to break the thing it measures.
      }
    },
    passDue() {
      const now = clock();
      // A hard bound, not an average: never two samples closer than a slot
      // less its jitter, and never a third inside any rolling second.
      if (now - last < PASS_SAMPLE_MS - PASS_JITTER_MS) return false;
      if (now - beforeLast < PASS_WINDOW_MS) return false;
      beforeLast = last;
      last = now;
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
