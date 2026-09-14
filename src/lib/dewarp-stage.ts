"use client";

/**
 * The curved geometry, as a **drop-in for the warp**.
 *
 * `lib/dewarp/` is a self-contained engine: it speaks `RgbaImage`, it computes
 * no homography of its own, and every string it returns is a telemetry
 * identifier rather than a sentence. This module is the only place in the app
 * that knows how to feed it — decode the page's canonical, render the small
 * flat baseline the semantic A/B needs, hand both over, and turn the answer
 * back into the one thing `lib/page-processing.ts` understands: a canvas.
 *
 * Four rules it exists to keep:
 *
 *  * **A fallback is an outcome, never an error.** Nothing here throws. When the
 *    engine steps back to the homography — for any of its fifteen reasons, or
 *    because this device could not even produce a baseline — the answer is
 *    `{ canvas: null, reason }` and the caller runs the flat path exactly as it
 *    does for a page that never asked. A dewarp must not cost the page, and must
 *    not spend one of the render ladder's two concessions.
 *  * **One full-resolution copy at a time.** A 12 MP page is ~48 MB per surface
 *    on a phone with ~200 MB to spend. The decode is released the instant its
 *    pixels have been read out, and the read-out is released the instant the
 *    engine has answered — which is why a fallback re-decodes the canonical
 *    (in the caller's own flat path) rather than being handed a canvas kept
 *    warm through a 12-second inference.
 *  * **The baseline is the app's own warp, at 1/8 the size.** The engine
 *    compares its candidate against a flat rendering of the same quad, and that
 *    rendering must come from the implementation that ships — scanic — or the
 *    A/B is measuring two different flatteners. It is rendered small because
 *    `measureSurface` downsamples to 448 px anyway.
 *  * **A device that cannot do this in time stops being asked.** The engine
 *    measures its own gate and refuses to judge it; the judgement is here, and
 *    it latches for the session ({@link dewarpAvailable}) — the same
 *    fail-closed-and-silent shape `lib/flatten.ts` uses for the ML detector.
 */

import {
  htmlSurface,
  releaseSurface,
  scaleSurface,
  surfaceContext,
} from "@/lib/canvas-surface";
// Types only, and deliberately: the engine's own modules are ~25 kB of pure
// maths that a person photographing a page must not download to do it. They
// arrive with the first correction (see `loadEngine`), the same way scanic,
// pdf-lib does. (The path is spelled to its index because the test
// runner's alias hook appends `.ts` to whatever it is given.)
import type {
  AcceptedGeometry,
  DeviceGate,
  DewarpEngineMode,
  DewarpFallbackReason,
  DewarpProgress,
  DewarpQuad,
  RgbaImage,
} from "@/lib/dewarp/index";
// The one *value* the engine's own modules would otherwise be dragged in for:
// `engine-mode.ts` exists precisely so a caller can know which producer it is
// talking about without paying for the maths (its own doc comment).
import { resolveGeometryMode } from "@/lib/dewarp/engine-mode";
// Same reasoning, and the same reason it is not taken from the index: the
// support codes are a lookup table with no dependencies of its own, and a
// person diagnosing a device must not download the maths to read one.
import { dewarpReasonCode } from "@/lib/dewarp/types";
import { warpToCanvas } from "@/lib/flatten";
import { decodeCanonical, releaseCanvas } from "@/lib/image";
import { denormalizeQuad, type NormalizedQuad } from "@/lib/quad";
import type { AssetUrls } from "@/lib/runtime-config";

/**
 * Long edge the canonical is scaled to before the baseline warp.
 *
 * The baseline only has to survive `measureSurface`, which downsamples to
 * 448 px; a page filling this frame warps to roughly that size, and a page
 * sitting small in it warps to less — which is the honest input, because a
 * small quad is exactly the case where the flat rendering has little to show.
 * Warping a 3000 px canvas for a 448 px comparison would cost a second full
 * pass for pixels nobody looks at.
 */
const BASELINE_SOURCE_LONG_EDGE = 896;

/**
 * Why a page that asked for the curved geometry got the flat one.
 *
 * The engine's own vocabulary plus the two failures it cannot see, because they
 * happen before it is called: the canonical would not decode, and scanic could
 * not produce the baseline the A/B is measured against.
 */
export type DewarpStageReason =
  | DewarpFallbackReason
  | "source-unavailable"
  | "baseline-unavailable";

export interface DewarpStageRequest {
  /** The page's one immutable source. */
  canonical: Blob;
  /** The confirmed outline, normalized to the canonical. */
  corners: NormalizedQuad;
  /** Identifies the page's pixels for the engine's render key. */
  sourceId: string;
  /** Monotonic per page — the store's revision. An older one is dropped. */
  generation: number;
  /**
   * Which producer this request is for. Optional and defaulting to
   * {@link resolveGeometryMode} for every caller before the "ab" build — the
   * store now threads its own per-page choice through explicitly, because a
   * global read here cannot tell a uvdoc attempt and a classical attempt for
   * the *same page* apart, and the "ab" build runs both.
   */
  engineMode?: DewarpEngineMode;
  /**
   * Where the dewarp WebAssembly lives on the host's origin.
   *
   * Carried on the request rather than read from a module global: this library
   * has no origin of its own, and the engine is instantiated lazily on the
   * first correction — long after the component that knows the base URL has
   * rendered.
   */
  assets: AssetUrls;
  onPhase?: (progress: DewarpProgress) => void;
  signal?: AbortSignal;
}

/**
 * The accepted map, opaque, good for exactly one more render of this page.
 *
 * Handed back so the render ladder can produce the same pixels a second time
 * without a second inference — see {@link replayDewarpStage}.
 */
export type DewarpReplay = AcceptedGeometry;

export interface DewarpStageResult {
  /** The dewarped page, or null when the caller must run its flat path. */
  canvas: HTMLCanvasElement | null;
  /** Why the flat path is being asked for. Null only when `canvas` is set. */
  reason: DewarpStageReason | null;
  /** The map behind `canvas`, to resample. Null whenever `canvas` is null. */
  replay: DewarpReplay | null;
}

/**
 * Session latch: once this device has proven it cannot do this, it is never
 * asked again.
 *
 * Three things set it, on different standards of proof:
 *
 *  * a browser the engine itself refuses (`unsupported`) — immediately, it is
 *    a fact about the browser;
 *  * **two** runs past the wait budget — never one, because one slow run is
 *    as often a fact about the moment (a backgrounded tab, a thermal
 *    throttle, one enormous page) as about the device, and a single sample
 *    must not convert a normal phone interruption into "this phone can't";
 *  * **two** failures to load the engine chunk — the first is retried, since
 *    a dropped connection deserves a second attempt where a missing deploy
 *    file does not (both strikes land only because {@link loadEngine} clears
 *    its memo on rejection).
 *
 * Silent and fail-closed, the same shape as the ML detector's latch in
 * `lib/flatten.ts`.
 */
let disabledForSession = false;
/** Misses of {@link DEVICE_GATE_BUDGET_MS} this session; two latch. */
let budgetStrikes = 0;
/** Failed engine-chunk loads this session; two latch. */
let engineLoadStrikes = 0;
const STRIKES_TO_LATCH = 2;
/**
 * Which of the three proofs above actually closed the latch, kept so the
 * paused line can name it (`#101`/`#102`) rather than shrug (`#100`).
 *
 * A recording, never an input: nothing reads it to decide anything, and the
 * latch behaves exactly as it did before it existed.
 */
let latchReason: string | null = null;

/**
 * The session latch's own support codes — the `#1xx` family named in
 * `dewarp/types.ts`'s {@link DEWARP_REASON_CODES}, in a table of their own
 * because a latch reason is not a fallback reason: `"unsupported"` is both a
 * per-page render outcome (`#040`) and a proof that closes the latch, and one
 * map cannot answer twice for one key.
 *
 * **Stable identifiers. Never renumber, never reuse** — the same contract the
 * `#0xx` table carries.
 */
const DEWARP_LATCH_CODES: Record<string, string> = {
  budget: "#101",
  "engine-load": "#102",
};

/**
 * Latched for a reason with no number of its own — the browser the engine
 * refuses, and the device that never latched at all but has no `Worker`, which
 * is the other half of {@link dewarpAvailable}.
 */
const DEWARP_LATCH_UNKNOWN_CODE = "#100";

/** The code behind the paused line, for the support suffix and nothing else. */
export function dewarpLatchCode(): string {
  if (latchReason === null) return DEWARP_LATCH_UNKNOWN_CODE;
  return DEWARP_LATCH_CODES[latchReason] ?? DEWARP_LATCH_UNKNOWN_CODE;
}

/**
 * What happened, in the vocabulary of the thing that happened — not the
 * sentence the user was shown.
 *
 * The latch above is deliberately silent to the person holding the phone, and
 * that silence used to reach the person *diagnosing* the phone too: "a
 * correção não deu conta neste aparelho" is the same line whether the engine
 * chunk 404ed, the wasm refused to instantiate, or the device simply took
 * fourteen seconds twice. These entries are the difference: a bounded, in-memory
 * ring that dies with the mounted flow. Nothing is written to storage and
 * nothing is sent anywhere — the `?debug=1` log that used to export them is not
 * part of this library.
 */
export type DewarpDiagnosticEvent =
  | "attempt"
  | "corrected"
  | "fallback"
  | "budget-strike"
  | "engine-load-failed"
  | "replay-failed"
  | "latched";

export interface DewarpDiagnosticEntry {
  /** ISO 8601, local device clock. */
  ts: string;
  /** The page's `sourceId` — absent for anything not tied to one page. */
  pageId?: string;
  engineMode: DewarpEngineMode;
  event: DewarpDiagnosticEvent;
  /** The engine's own identifier, never a sentence. */
  reason?: string;
  /** A real exception's `name: message`, where one was caught. */
  message?: string;
  stack?: string;
  durationMs?: number;
  extra?: Record<string, string | number | boolean>;
}

/**
 * Enough to hold a field-testing session's worth of attempts without the
 * buffer itself becoming a memory question on a phone with ~200 MB to spend.
 */
const DIAGNOSTIC_CAPACITY = 50;

let diagnostics: DewarpDiagnosticEntry[] = [];

/**
 * The support code in front of a recorded reason, so the report and the line
 * the user screenshotted say the same number.
 *
 * Which table answers is decided by the *event*, not by the string: a latch and
 * a render both know a reason called `"unsupported"`, and they are not the same
 * fact about the device.
 */
function codedReason(event: DewarpDiagnosticEvent, reason: string): string {
  const code =
    event === "latched" || event === "budget-strike"
      ? (DEWARP_LATCH_CODES[reason] ?? DEWARP_LATCH_UNKNOWN_CODE)
      : dewarpReasonCode(reason);
  return `${code} ${reason}`;
}

function note(entry: Omit<DewarpDiagnosticEntry, "ts">): void {
  diagnostics.push({
    ts: new Date().toISOString(),
    ...entry,
    ...(entry.reason === undefined
      ? {}
      : { reason: codedReason(entry.event, entry.reason) }),
  });
  if (diagnostics.length > DIAGNOSTIC_CAPACITY) {
    diagnostics = diagnostics.slice(-DIAGNOSTIC_CAPACITY);
  }
}

/**
 * The thrown value, as far as it can be trusted.
 *
 * `catch` binds `unknown` and browsers do throw non-`Error`s (a rejected
 * `import()` on some engines, an aborted fetch on others), so the narrowing is
 * the point: a stack is only reported when there genuinely is one.
 */
function errorFields(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: `${error.name}: ${error.message}`,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    };
  }
  return { message: String(error) };
}

/** The session latch, recorded on the transition only. Never a second latch. */
function latchSession(
  engineMode: DewarpEngineMode,
  reason: string,
  pageId: string,
): void {
  if (!disabledForSession) {
    note({ pageId, engineMode, event: "latched", reason });
    // The transition only, for the same reason the entry is written only here:
    // the first proof is the one that closed it.
    latchReason = reason;
  }
  disabledForSession = true;
}

/** Oldest first. Read only by the debug sheet; recording is unconditional. */
export function dewarpDiagnostics(): readonly DewarpDiagnosticEntry[] {
  return diagnostics;
}

export interface DewarpLatchState {
  disabledForSession: boolean;
  budgetStrikes: number;
  engineLoadStrikes: number;
  strikesToLatch: number;
}

/** The counters behind {@link dewarpAvailable}, for the diagnostic report. */
export function dewarpLatchState(): DewarpLatchState {
  return {
    disabledForSession,
    budgetStrikes,
    engineLoadStrikes,
    strikesToLatch: STRIKES_TO_LATCH,
  };
}

/**
 * Whether the correction is still worth offering on this device.
 *
 * Read at render time by the control as well as by the pipeline, so a device
 * that misses the budget once stops advertising the feature immediately.
 *
 * The `Worker` probe is a deliberate under-approximation, not a second copy of
 * the engine's capability rule: the engine re-checks WebAssembly and `fetch`
 * itself and answers `unsupported`, and it is the authority. All this has to do
 * is avoid loading 25 kB of maths — and showing a switch we would have to
 * apologise for — on a browser that plainly cannot run any of it.
 */
export function dewarpAvailable(): boolean {
  return !disabledForSession && typeof Worker === "function";
}

/**
 * The wait policy, applied.
 *
 * Stated as a pure predicate taking its own budget because it is the one
 * product judgement in this file: the engine reports what it measured
 * (download, session creation, first inference, wall time) and refuses to grade
 * it, and the grade is "would a person still be waiting for this?".
 */
export function withinDeviceBudget(gate: DeviceGate, budgetMs: number): boolean {
  return gate.totalMs <= budgetMs;
}

type DewarpEngineModule = typeof import("@/lib/dewarp/index");

let enginePromise: Promise<DewarpEngineModule> | null = null;

/**
 * The engine's maths, fetched once, on the first correction of the session.
 *
 * A rejection clears the memo: a memoized failure would turn one dropped
 * connection into a permanent one, with every later attempt "failing" without
 * a single packet leaving the phone.
 */
function loadEngine(): Promise<DewarpEngineModule> {
  if (enginePromise === null) {
    const attempt = import("@/lib/dewarp/index");
    attempt.catch(() => {
      if (enginePromise === attempt) enginePromise = null;
    });
    enginePromise = attempt;
  }
  return enginePromise;
}

/**
 * The flat rendering of the same quad, small — the engine's A/B baseline.
 *
 * Null when scanic could not extract at all, which is also how the caller's own
 * warp would end: the page is about to go in flat either way, and there is
 * nothing for the curved geometry to be compared against.
 */
async function homographyBaseline(
  source: HTMLCanvasElement,
  corners: NormalizedQuad,
  assets: AssetUrls,
): Promise<RgbaImage | null> {
  const small = scaleSurface(source, BASELINE_SOURCE_LONG_EDGE, htmlSurface);
  let flat: HTMLCanvasElement | null = null;
  try {
    flat = await warpToCanvas(small, corners, assets);
    if (flat === null) return null;
    const context = surfaceContext(flat, { willReadFrequently: true });
    if (context === null) return null;
    return context.getImageData(0, 0, flat.width, flat.height);
  } catch {
    return null;
  } finally {
    // `scaleSurface` hands the source straight back when it already fits.
    if (small !== source) releaseSurface(small);
    releaseCanvas(flat);
  }
}

/** The engine's answer, back on a canvas the render tail can take. */
function toCanvas(image: RgbaImage): HTMLCanvasElement {
  const canvas = htmlSurface(image.width, image.height);
  const context = surfaceContext(canvas);
  if (context === null) throw new Error("no 2-D context for the dewarped page");
  const pixels = image.data;
  const buffer = pixels.buffer;
  // Wrapping rather than copying, so the handoff never holds a third copy of
  // the page. `ImageData` will only take a view over a plain `ArrayBuffer`;
  // the engine allocates one, and the narrowing is what proves it rather than
  // assuming it (a `SharedArrayBuffer` would have to be copied).
  const view =
    buffer instanceof ArrayBuffer
      ? new Uint8ClampedArray(buffer, pixels.byteOffset, pixels.byteLength)
      : Uint8ClampedArray.from(pixels);
  context.putImageData(new ImageData(view, image.width, image.height), 0, 0);
  return canvas;
}

/**
 * The same page again, from the map the engine already accepted.
 *
 * The one thing the render ladder is allowed to do twice. It costs a decode and
 * a resample — no worker, no model, no guards, no wait — and it exists so that
 * a retry which was only ever meant to cost the *enhancement* cannot also cost
 * the page its curvature. Null on failure, exactly like {@link runDewarpStage}.
 */
export async function replayDewarpStage(
  canonical: Blob,
  replay: DewarpReplay,
): Promise<HTMLCanvasElement | null> {
  let engine: DewarpEngineModule;
  try {
    engine = await loadEngine();
  } catch (error) {
    // The build's default mode, not the replayed one: the accepted map carries
    // no producer, and a replay never strikes the latch either way.
    note({
      engineMode: resolveGeometryMode(),
      event: "replay-failed",
      reason: "model-unavailable",
      ...errorFields(error),
    });
    return null;
  }
  let source: HTMLCanvasElement | null = null;
  let pixels: RgbaImage | null = null;
  try {
    source = await decodeCanonical(canonical);
    const context = surfaceContext(source, { willReadFrequently: true });
    if (context === null) return null;
    pixels = context.getImageData(0, 0, source.width, source.height);
    releaseCanvas(source);
    const surface = engine.renderAcceptedGeometry(pixels, replay);
    pixels = null;
    return surface === null ? null : toCanvas(surface);
  } catch (error) {
    note({
      engineMode: resolveGeometryMode(),
      event: "replay-failed",
      reason: "render-failed",
      ...errorFields(error),
    });
    return null;
  } finally {
    releaseCanvas(source);
  }
}

/**
 * One page through the curved geometry.
 *
 * Owns everything it allocates and never throws: a `null` canvas is a complete,
 * documented answer that the caller turns into the flat page.
 */
export async function runDewarpStage(
  request: DewarpStageRequest,
): Promise<DewarpStageResult> {
  // Resolved once, here — every reader below (the render key, the crop pad,
  // the shared engine's own instance, every diagnostic entry) takes this one
  // value rather than each re-reading the flag, which is what lets a uvdoc
  // request and a classical request for the same page run — and replay —
  // without describing each other's job. Through `engine-mode.ts` rather than
  // the engine's own re-export of it, so a run that never gets past
  // `loadEngine` still knows which producer it was for.
  const mode = request.engineMode ?? resolveGeometryMode();
  const pageId = request.sourceId;
  const startedAt = Date.now();
  note({
    pageId,
    engineMode: mode,
    event: "attempt",
    extra: { generation: request.generation },
  });

  let engine: DewarpEngineModule;
  try {
    engine = await loadEngine();
  } catch (error) {
    // The lazy chunk is not in this deploy, or the network dropped it. The
    // two cases are indistinguishable from here, so the first failure is
    // offered a retry (the load memo was cleared) and only the second — which
    // a missing deploy file always earns and a flaky connection rarely does —
    // stops the offer for the session.
    engineLoadStrikes += 1;
    note({
      pageId,
      engineMode: mode,
      event: "engine-load-failed",
      reason: "model-unavailable",
      durationMs: Date.now() - startedAt,
      extra: { strikes: engineLoadStrikes },
      ...errorFields(error),
    });
    if (engineLoadStrikes >= STRIKES_TO_LATCH) {
      latchSession(mode, "engine-load", pageId);
    }
    return { canvas: null, reason: "model-unavailable", replay: null };
  }

  let source: HTMLCanvasElement;
  try {
    source = await decodeCanonical(request.canonical);
  } catch (error) {
    note({
      pageId,
      engineMode: mode,
      event: "fallback",
      reason: "source-unavailable",
      durationMs: Date.now() - startedAt,
      ...errorFields(error),
    });
    return { canvas: null, reason: "source-unavailable", replay: null };
  }

  let canonical: RgbaImage | null = null;
  try {
    const baseline = await homographyBaseline(source, request.corners, request.assets);
    if (baseline === null) {
      note({
        pageId,
        engineMode: mode,
        event: "fallback",
        reason: "baseline-unavailable",
        durationMs: Date.now() - startedAt,
      });
      return { canvas: null, reason: "baseline-unavailable", replay: null };
    }

    const width = source.width;
    const height = source.height;
    // scanic's corners and the engine's quad are the same four points in the
    // same pixels; the engine declares its own type only so it can be run
    // without the DOM.
    const quad: DewarpQuad = denormalizeQuad(request.corners, width, height);
    const output = engine.outputDimsFromQuad(quad);
    const context = surfaceContext(source, { willReadFrequently: true });
    if (context === null) {
      note({
        pageId,
        engineMode: mode,
        event: "fallback",
        reason: "source-unavailable",
        durationMs: Date.now() - startedAt,
        extra: { stage: "canonical-readout" },
      });
      return { canvas: null, reason: "source-unavailable", replay: null };
    }
    canonical = context.getImageData(0, 0, width, height);
    // The pixels are read out; the decode's own backing store is dead weight
    // for the whole inference if it is kept.
    releaseCanvas(source);

    const run = await engine.sharedEngine({ mode, assets: request.assets }).runDewarp({
      job: {
        generation: request.generation,
        renderKey: engine.renderKeyFor({
          sourceId: request.sourceId,
          quad,
          padVersion: engine.CROP_PAD_VERSION,
          // Mode-keyed: flipping
          // `NEXT_PUBLIC_DEWARP_ENGINE` must invalidate every cached render
          // key by construction, which `engine.MODEL_VERSION` alone — always
          // the uvdoc constant — cannot do once a second producer exists. Per
          // *this request's* mode, not the global default, so a uvdoc render
          // and a classical render of the same page never collide.
          modelVersion: engine.activeModelVersion(mode),
        }),
        quad,
        canonicalWidth: width,
        canonicalHeight: height,
        // Mode-keyed pad: the classical
        // path gets its own, wider crop pad than uvdoc's shared 6 %
        // (`engine.cropPadForMode`, `engine.CLASSICAL_CROP_PAD`'s own doc
        // comment has the empirical basis). This crop is what both
        // `cropToClassicalInput` and `normalizeQuadToCrop` key off of
        // downstream (`index.ts`'s `runDewarp`, both via `job.crop`), so the
        // quad the classical ABI receives is automatically normalized
        // against the same, correctly-padded rectangle — nothing else needs
        // to change in lockstep.
        crop: engine.paddedCropBox(quad, width, height, engine.cropPadForMode(mode)),
        outputWidth: output.width,
        outputHeight: output.height,
      },
      canonical,
      baseline,
      ...(request.onPhase === undefined ? {} : { onPhase: request.onPhase }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    // Dropped before the output surface is turned into a canvas, so the two
    // full-resolution buffers never overlap for longer than the handoff.
    canonical = null;

    if (!withinDeviceBudget(run.deviceGate, engine.DEVICE_GATE_BUDGET_MS)) {
      budgetStrikes += 1;
      note({
        pageId,
        engineMode: mode,
        event: "budget-strike",
        reason: "budget",
        durationMs: run.deviceGate.totalMs,
        extra: {
          strikes: budgetStrikes,
          budgetMs: engine.DEVICE_GATE_BUDGET_MS,
          downloadMs: run.deviceGate.downloadMs,
          initMs: run.deviceGate.initMs,
          firstInferenceMs: run.deviceGate.firstInferenceMs,
        },
      });
      if (budgetStrikes >= STRIKES_TO_LATCH) latchSession(mode, "budget", pageId);
    }

    const surface = run.surface;
    // A browser the engine itself cannot run in is a fact, not a sample —
    // no second opinion needed before the offer is withdrawn.
    if (run.outcome.fallbackReason === "unsupported") {
      latchSession(mode, "unsupported", pageId);
    }
    // "homography" is the one geometry that means a fallback happened —
    // "uvdoc" and "classical" are both a correction that
    // worked, and this check must not care which. Checked against the known
    // *failure* value rather than the known *success* one for exactly that
    // reason: a literal `!== "uvdoc"` here would silently treat every
    // successful classical dewarp as a fallback the instant the flag flips.
    if (run.outcome.geometryMode === "homography" || surface === undefined) {
      const reason = run.outcome.fallbackReason ?? "render-failed";
      note({
        pageId,
        engineMode: mode,
        event: "fallback",
        reason,
        durationMs: Date.now() - startedAt,
        extra: { gateTotalMs: run.deviceGate.totalMs },
      });
      return { canvas: null, reason, replay: null };
    }
    note({
      pageId,
      engineMode: mode,
      event: "corrected",
      durationMs: Date.now() - startedAt,
      extra: { gateTotalMs: run.deviceGate.totalMs },
    });
    return {
      canvas: toCanvas(surface),
      reason: null,
      replay: run.geometry ?? null,
    };
  } catch (error) {
    // A refused allocation on the way in or out. The page is not lost — it is
    // about to be rendered flat, which is what it would have been anyway.
    note({
      pageId,
      engineMode: mode,
      event: "fallback",
      reason: "render-failed",
      durationMs: Date.now() - startedAt,
      ...errorFields(error),
    });
    return { canvas: null, reason: "render-failed", replay: null };
  } finally {
    // Idempotent: zeroing an already-zeroed surface costs nothing.
    releaseCanvas(source);
  }
}
