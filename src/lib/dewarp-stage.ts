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
 *    `measureSurface` downsamples to 448 px anyway — and the small copy it is
 *    warped from is handed over as well, so the candidate goes through the
 *    same resampling rather than looking sharper than any flat page can.
 *  * **A device that cannot do this in time stops being asked.** The engine
 *    measures its own gate and refuses to judge it; the judgement is here, and
 *    it latches for the session ({@link dewarpAvailable}) — the same
 *    fail-closed-and-silent shape `lib/flatten.ts` uses for the ML detector.
 *  * **The print's tilt comes first, and usually alone.** Before the engine,
 *    the text deskew (`lib/deskew.ts`) measures the print on the small flat
 *    page and — when a rotation levels it and its judge agrees against that
 *    same flat page — the rotation is composed with the confirmed outline on
 *    the flat path. The engine is asked only when the level page still shows
 *    a curl (and on the confirmed outline, as always: see `deskew.ts` for
 *    why); the rotation is the page's answer whenever the engine declines.
 *    The deskew's time counts in the same device budget as the engine's.
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
import type { DeskewPlan } from "@/lib/deskew";
import { decodeCanonical, releaseCanvas } from "@/lib/image";
import { denormalizeQuad, normalizeQuad, type NormalizedQuad } from "@/lib/quad";
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
  | "baseline-unavailable"
  /**
   * Not a failure: the deskew levelled the print and the level page showed no
   * curl, so the engine was not asked. The page is the deskewed flat page.
   */
  | "curl-absent";

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
  /** Run the text deskew before the engine. Default on: the tap asks for it. */
  deskew?: boolean;
  /**
   * The deskew already planned for exactly these pixels and this outline (the
   * store's cache): used as is, never re-estimated. Null: planned, and no
   * rotation. Absent: plan it here.
   */
  knownDeskew?: AppliedDeskew | null;
}

/**
 * A text rotation the step decided on for one page and one outline.
 *
 * Its own transform, not a new outline: the page's corners stay what the user
 * confirmed, and `corners` is only the render-time composition of those
 * corners with the rotation (normalized to the canonical, for scanic) — valid
 * for exactly the corners and pixels it was planned on.
 */
export interface AppliedDeskew {
  plan: DeskewPlan;
  /** The confirmed outline composed with the rotation, normalized to the canonical. */
  corners: NormalizedQuad;
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
  /**
   * The deskew's answer for the flat path: the rotation the page gets when
   * `canvas` is null (an engine surface never carries one). Null: planned, no
   * rotation. Absent: the run stopped before it could plan (the caller plans
   * on its own, see {@link planDeskewStage}).
   */
  deskew?: AppliedDeskew | null;
  /**
   * The deskew planned no rotation because the print was already level, and
   * the level page showed no curl either — measured on this run's own B₀, so
   * absent whenever the deskew came from `knownDeskew`. The engine still
   * runs; this only lets the page view say "already level and flat" rather
   * than guess at why the engine declined.
   */
  alreadyStraight?: true;
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
 * The small copy of the canonical every A/B baseline is warped from, and its
 * pixels.
 *
 * The copy goes to the engine too, so its candidate is sampled from the very
 * pixels the baseline's warp saw (whatever filter this browser's `drawImage`
 * used) at the very size it produced: a page that is geometrically the same
 * must measure the same, and a candidate sampled once from the full canonical
 * is sharper than any flat rendering — thinner strokes that read as lost ink.
 * The deskew renders its rotated page from the same copy, so the two small
 * pages it compares differ by the rotation alone. `pixels` is `"canonical"`
 * when the canonical already fit (it *is* the copy), and null when the copy
 * could not be read back: the A/B then falls back to sampling the canonical,
 * which costs fairness, not the attempt.
 */
interface SmallCopy {
  canvas: HTMLCanvasElement;
  pixels: RgbaImage | "canonical" | null;
}

function smallCopyOf(source: HTMLCanvasElement): SmallCopy {
  const canvas = scaleSurface(source, BASELINE_SOURCE_LONG_EDGE, htmlSurface);
  if (canvas === source) return { canvas, pixels: "canonical" };
  let pixels: RgbaImage | null = null;
  try {
    pixels =
      surfaceContext(canvas, { willReadFrequently: true })?.getImageData(
        0,
        0,
        canvas.width,
        canvas.height,
      ) ?? null;
  } catch {
    pixels = null;
  }
  return { canvas, pixels };
}

/** `scaleSurface` hands the source straight back when it already fits. */
function releaseSmallCopy(copy: SmallCopy | null, source: HTMLCanvasElement | null): void {
  if (copy !== null && copy.canvas !== source) releaseSurface(copy.canvas);
}

/** The engine's own pixel-centre rule for the copy (the engine and the deskew module both carry it). */
interface CopyMapper {
  copyScale: DewarpEngineModule["copyScale"];
  quadOnScaledCopy: DewarpEngineModule["quadOnScaledCopy"];
}

/**
 * The flat rendering of `quad`, small — the engine's A/B baseline, and the
 * deskew's B₀ and B′ — warped by scanic (the flattener that ships, or the A/B
 * would be measuring two different flatteners) from the small copy.
 *
 * The quad goes onto the copy by the engine's own pixel-centre rule
 * (`quadOnScaledCopy`), per axis — the rule its candidate samples the copy by,
 * so the two sides of the A/B look at the same place. Null when scanic could
 * not extract at all, which is also how the caller's own warp would end.
 */
async function warpSmall(
  copy: SmallCopy,
  source: HTMLCanvasElement,
  quad: DewarpQuad,
  mapper: CopyMapper,
  assets: AssetUrls,
): Promise<RgbaImage | null> {
  const small = copy.canvas;
  let flat: HTMLCanvasElement | null = null;
  try {
    const onCopy =
      small === source ? quad : mapper.quadOnScaledCopy(quad, mapper.copyScale(source, small));
    const corners = normalizeQuad(onCopy, small.width, small.height);
    if (corners === null) return null;
    flat = await warpToCanvas(small, corners, assets);
    if (flat === null) return null;
    const context = surfaceContext(flat, { willReadFrequently: true });
    if (context === null) return null;
    return context.getImageData(0, 0, flat.width, flat.height);
  } catch {
    return null;
  } finally {
    releaseCanvas(flat);
  }
}

type DeskewModule = typeof import("@/lib/deskew");

let deskewPromise: Promise<DeskewModule> | null = null;

/** The deskew maths, lazily — same reasoning and memo rule as {@link loadEngine}. */
function loadDeskew(): Promise<DeskewModule> {
  if (deskewPromise === null) {
    const attempt = import("@/lib/deskew");
    attempt.catch(() => {
      if (deskewPromise === attempt) deskewPromise = null;
    });
    deskewPromise = attempt;
  }
  return deskewPromise;
}

/**
 * The deskew step on the small flat page B₀ of the confirmed outline: the
 * rotation, judged against B₀ on B′ (the small page of the rotated outline,
 * warped from the same copy). Never throws: any failure is "no rotation",
 * and the engine then runs on the confirmed outline as it always has.
 */
async function planDeskewFor(
  copy: SmallCopy,
  source: HTMLCanvasElement,
  baseline: RgbaImage,
  quad: DewarpQuad,
  assets: AssetUrls,
): Promise<DeskewAnswer> {
  const none: DeskewAnswer = { deskew: null, alreadyStraight: false };
  try {
    const deskew = await loadDeskew();
    const width = source.width;
    const height = source.height;
    const result = await deskew.planStraighten({
      flat: baseline,
      quad,
      canonicalWidth: width,
      canonicalHeight: height,
      renderSmall: (rotated) => warpSmall(copy, source, rotated, deskew, assets),
    });
    if (result.plan === null) {
      // Already level (no rotation needed) and no curl on the level page.
      const alreadyStraight = result.level !== null && !result.level.evidence;
      return { deskew: null, alreadyStraight };
    }
    const corners = normalizeQuad(result.plan.quad, width, height);
    if (corners === null) return none;
    return { deskew: { plan: result.plan, corners }, alreadyStraight: false };
  } catch {
    return none;
  }
}

/** {@link planDeskewFor}'s answer: the rotation, and whether none was needed at all. */
interface DeskewAnswer {
  deskew: AppliedDeskew | null;
  /** See {@link DewarpStageResult.alreadyStraight}. */
  alreadyStraight: boolean;
}

/**
 * The deskew on its own, for a page whose curved chain never got as far as
 * planning it — a device the latch has closed, an engine chunk that would not
 * load. Decodes the canonical, renders the same small page B₀, plans. The
 * engine is not asked, whatever the curl evidence says: it is not available.
 */
export async function planDeskewStage(
  canonical: Blob,
  corners: NormalizedQuad,
  assets: AssetUrls,
): Promise<AppliedDeskew | null> {
  let source: HTMLCanvasElement | null = null;
  let copy: SmallCopy | null = null;
  try {
    const deskew = await loadDeskew();
    source = await decodeCanonical(canonical);
    copy = smallCopyOf(source);
    const quad = denormalizeQuad(corners, source.width, source.height);
    const baseline = await warpSmall(copy, source, quad, deskew, assets);
    if (baseline === null) return null;
    return (await planDeskewFor(copy, source, baseline, quad, assets)).deskew;
  } catch {
    return null;
  } finally {
    releaseSmallCopy(copy, source);
    releaseCanvas(source);
  }
}

/**
 * Paint a deskewed page's corner wedges, in place, with the paper beside each
 * one (`deskew.ts`'s fill). Only the boxes the fill reads and paints are read
 * back — never the whole full-resolution page a second time — and each pixel
 * is decided on its own, so the result is the pure `fillDeskewWedges` pixel
 * for pixel. `"crop"` plans have no wedges and paint nothing. Never throws: a
 * page that cannot be painted keeps its wedges, which is a cosmetic loss.
 */
export async function paintDeskewWedges(canvas: HTMLCanvasElement, plan: DeskewPlan): Promise<void> {
  try {
    const deskew = await loadDeskew();
    if (!deskew.paintsAnything(plan)) return;
    const context = surfaceContext(canvas, { willReadFrequently: true });
    if (context === null) return;
    const width = canvas.width;
    const height = canvas.height;
    const windows = deskew
      .wedgeSampleBoxes(plan, width, height)
      .flatMap((box) =>
        box === null
          ? []
          : [{ x: box.x, y: box.y, image: context.getImageData(box.x, box.y, box.width, box.height) }],
      );
    const fill = deskew.wedgeFillFrom(windows, plan, width, height);
    for (const box of deskew.wedgePaintBoxes(plan, width, height)) {
      const image = context.getImageData(box.x, box.y, box.width, box.height);
      deskew.paintWedgeWindow({ x: box.x, y: box.y, image }, plan, fill, width, height);
      context.putImageData(image, box.x, box.y);
    }
  } catch {
    // The rotation stands; only the fill is lost.
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
  let copy: SmallCopy | null = null;
  // Planned once B₀ exists; every answer below carries it, so a decline still
  // hands the flat path the rotation.
  let deskew: AppliedDeskew | null | undefined;
  // Level and flat already, as this run measured it (never for a known deskew).
  let alreadyStraight = false;
  // What the device spent on the deskew: counted in the same wait budget.
  let deskewMs = 0;
  // The deskew's answer, for every return once it may have been planned.
  const planned = (): Pick<DewarpStageResult, "deskew" | "alreadyStraight"> => ({
    ...(deskew === undefined ? {} : { deskew }),
    ...(alreadyStraight ? { alreadyStraight: true as const } : {}),
  });
  try {
    const width = source.width;
    const height = source.height;
    // scanic's corners and the engine's quad are the same four points in the
    // same pixels; the engine declares its own type only so it can be run
    // without the DOM.
    const confirmed: DewarpQuad = denormalizeQuad(request.corners, width, height);
    copy = smallCopyOf(source);
    const flat = await warpSmall(copy, source, confirmed, engine, request.assets);
    if (flat === null) {
      note({
        pageId,
        engineMode: mode,
        event: "fallback",
        reason: "baseline-unavailable",
        durationMs: Date.now() - startedAt,
      });
      return { canvas: null, reason: "baseline-unavailable", replay: null };
    }

    // The text deskew, first: the rotation is judged against B₀ here. The
    // engine, when it runs at all, runs on the confirmed outline against B₀
    // exactly as before; the rotation is the flat path's.
    if (request.deskew !== false) {
      const deskewStarted = Date.now();
      if (request.knownDeskew !== undefined) {
        deskew = request.knownDeskew;
      } else {
        const answer = await planDeskewFor(copy, source, flat, confirmed, request.assets);
        deskew = answer.deskew;
        alreadyStraight = answer.alreadyStraight;
      }
      deskewMs = Date.now() - deskewStarted;
      if (deskew && !deskew.plan.curl.evidence) {
        // Level and straight: the rotation is the whole correction, and the
        // engine is not asked.
        if (deskewMs > engine.DEVICE_GATE_BUDGET_MS) strikeBudget(mode, pageId, deskewMs, engine);
        note({
          pageId,
          engineMode: mode,
          event: "fallback",
          reason: "curl-absent",
          durationMs: Date.now() - startedAt,
          extra: { deskewDeg: deskew.plan.deg, deskewMs },
        });
        return { canvas: null, reason: "curl-absent", replay: null, deskew };
      }
    }

    const quad = confirmed;
    const output = engine.outputDimsFromQuad(quad);
    const baselineSource = copy.pixels;
    releaseSmallCopy(copy, source);
    copy = null;
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
      return { canvas: null, reason: "source-unavailable", replay: null, ...planned() };
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
      baseline: flat,
      // The canonical itself when it already fit the baseline's source size;
      // none when the copy could not be read (the engine's legacy A/B).
      ...(baselineSource === null
        ? {}
        : { baselineSource: baselineSource === "canonical" ? canonical : baselineSource }),
      ...(request.onPhase === undefined ? {} : { onPhase: request.onPhase }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    // Dropped before the output surface is turned into a canvas, so the two
    // full-resolution buffers never overlap for longer than the handoff.
    canonical = null;

    // The person waited for the deskew and the engine together: one budget.
    const gate: DeviceGate = { ...run.deviceGate, totalMs: run.deviceGate.totalMs + deskewMs };
    if (!withinDeviceBudget(gate, engine.DEVICE_GATE_BUDGET_MS)) {
      strikeBudget(mode, pageId, gate.totalMs, engine, run.deviceGate, deskewMs);
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
    const extra = {
      gateTotalMs: gate.totalMs,
      ...(deskew ? { deskewDeg: deskew.plan.deg, deskewMs } : {}),
    };
    if (run.outcome.geometryMode === "homography" || surface === undefined) {
      const reason = run.outcome.fallbackReason ?? "render-failed";
      note({
        pageId,
        engineMode: mode,
        event: "fallback",
        reason,
        durationMs: Date.now() - startedAt,
        extra,
      });
      return { canvas: null, reason, replay: null, ...planned() };
    }
    note({
      pageId,
      engineMode: mode,
      event: "corrected",
      durationMs: Date.now() - startedAt,
      extra,
    });
    return {
      canvas: toCanvas(surface),
      reason: null,
      replay: run.geometry ?? null,
      ...planned(),
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
    return { canvas: null, reason: "render-failed", replay: null, ...planned() };
  } finally {
    // Idempotent: zeroing an already-zeroed surface costs nothing.
    releaseSmallCopy(copy, source);
    releaseCanvas(source);
  }
}

/** One miss of the wait budget (deskew and engine together); two latch. */
function strikeBudget(
  mode: DewarpEngineMode,
  pageId: string,
  totalMs: number,
  engine: DewarpEngineModule,
  engineGate?: DeviceGate,
  deskewMs = 0,
): void {
  budgetStrikes += 1;
  note({
    pageId,
    engineMode: mode,
    event: "budget-strike",
    reason: "budget",
    durationMs: totalMs,
    extra: {
      strikes: budgetStrikes,
      budgetMs: engine.DEVICE_GATE_BUDGET_MS,
      deskewMs,
      ...(engineGate === undefined
        ? {}
        : {
            downloadMs: engineGate.downloadMs,
            initMs: engineGate.initMs,
            firstInferenceMs: engineGate.firstInferenceMs,
          }),
    },
  });
  if (budgetStrikes >= STRIKES_TO_LATCH) latchSession(mode, "budget", pageId);
}
