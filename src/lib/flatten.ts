"use client";

/**
 * The flatten layer: **scanic** (MIT, marquaye) detects the page in the photo
 * and warps it flat, in the browser. It is the *only* detector there is —
 * everything happens on the device, with nothing to fall back to off it.
 * scanic offers two, and the **ML corner model (DocCornerNet) is
 * the primary one**: {@link detectOnCanvasMl}, self-hosted, warmed up the moment
 * the capture screen opens. The classical Canny/contour pipeline
 * ({@link detectOnCanvas}) is the **fallback**: it answers while the model is
 * still downloading, and it is what the session runs on for good if anything
 * about the ML path fails. Which of the two a caller gets is decided in one
 * place ({@link primaryDetector} over this module's latches).
 *
 * This module now deals in **canvases and quads only**. It never encodes
 * a JPEG: a warp is a step inside the page's single render pass
 * (`lib/page-processing.ts`), not an artifact of its own. Detection answers in
 * {@link NormalizedQuad} — fractions of the frame — because the corners are
 * stored on the page and re-applied to a canonical the caller may have decoded
 * at a different moment; pixels are only spoken at scanic's own boundary.
 *
 * Three rules this module never breaks:
 *
 *  1. **Capture never blocks on it.** Detection gets a ~3 s budget and a
 *     dynamic import; a timeout, a failure or a browser that can't run the WASM
 *     all fall back to no quad. That page enters the document un-warped and the
 *     UI nudges the user toward "Ajustar cantos" — the warp rescue. A photo of
 *     the page beats no page.
 *  2. **No interstitial beyond the one the flow already has.** A detected quad
 *     is the corner screen's starting position, never a silent crop.
 *  3. **The canonical survives.** Nothing here mutates the source it is given,
 *     so the corners can be moved again tomorrow against the same pixels.
 */

import type { CornerPoints } from "scanic";
import { loadScanic } from "@/lib/scanic-runtime";
import { decodeCanonical, releaseCanvas } from "@/lib/image";
import {
  beginMlPass,
  coverageFloor,
  disableMl,
  endMlPass,
  isMlBusy,
  isMlDisabled,
  isMlReady,
  markMlReady,
  ML_WEAK_CONFIDENCE,
  primaryDetector,
} from "@/lib/ml-detection";
import { mlDetectorOptions, type AssetUrls } from "@/lib/runtime-config";
import { denormalizeQuad, normalizeQuad, quadCoverage, type NormalizedQuad } from "@/lib/quad";
import { probe, probing, type CaptureDetectProbe, type RefineProbe } from "@/lib/probe";
import { refineOnCanvas } from "@/lib/refine";
import { cornerCheckOf, type CornerCheck } from "@/lib/corner-check";
import { demoteDetectLane, detectLane, detectLaneSettled, laneDetect } from "@/lib/detect-lane";
import type { DetectPlan } from "@/lib/detect-protocol";

export type { CornerPoints };

/** Detection budget. Past this we keep the raw frame and move on. */
const DETECT_BUDGET_MS = 3000;

/** The four handles scanic draws, by the names it gives them. */
export type CornerHandleKey = keyof CornerPoints;

/**
 * Put the app's own language on scanic's four drag handles.
 *
 * `createCornerEditor` hard-codes their accessible names in English ("Top-left
 * corner", …) and offers no option for them: its `labels` option covers the
 * floating toolbar we switch off, nothing else. So a pt-BR flow was handing a
 * screen reader four English strings — the only place in the app that did.
 *
 * Called once, right after the editor is built: scanic creates the four buttons
 * in its constructor, keeps them for the editor's lifetime and only ever moves
 * them, so there is nothing to re-apply. The handles are found by scanic's own
 * `data-corner` attribute rather than by class, which is the part of that DOM
 * its API actually documents; a build that stopped emitting it would leave the
 * labels English rather than break the editor.
 */
export function localizeCornerHandles(
  host: HTMLElement,
  labels: Record<CornerHandleKey, string>,
): void {
  for (const handle of host.querySelectorAll<HTMLElement>("[data-corner]")) {
    const key = handle.dataset.corner;
    if (key !== undefined && key in labels) {
      handle.setAttribute("aria-label", labels[key as CornerHandleKey]);
    }
  }
}

function withBudget<T>(work: Promise<T>, budgetMs: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = window.setTimeout(() => resolve(null), budgetMs);
    work
      .then((value) => {
        window.clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        window.clearTimeout(timer);
        resolve(null);
      });
  });
}

function asCanvas(output: unknown): HTMLCanvasElement | null {
  return typeof HTMLCanvasElement !== "undefined" &&
    output instanceof HTMLCanvasElement
    ? output
    : null;
}

/**
 * A quad covering too little of the frame is almost never the page — it is a
 * text block or a stain that detection latched onto (the classic failure on a
 * borderless, page-fills-the-frame shot). Below this fraction we discard the
 * detection and keep the raw frame — the warp rescue then offers the corner
 * editor, which is the only thing left that can do better.
 *
 * The live viewfinder reuses it as the gate for what it will draw brackets
 * around, and for what a capture is allowed to carry corners from.
 *
 * This is the **unconditioned** floor: it is what the classical
 * pipeline is always measured against, while a high-confidence ML detection is
 * held to the lower trusted floor instead (`coverageFloor`,
 * `lib/ml-detection.ts`) — the model being sure and the page being small is a
 * wide-FOV still, not a stain.
 */
export const MIN_QUAD_AREA_FRACTION = 0.35;

/**
 * A detection and how much scanic believed in it.
 *
 * The confidence is carried rather than dropped because the live loop's
 * arbitration reads it: which of two detectors answering over one frame stream
 * gets the overlay turns on whether the classical fallback believed its own quad
 * (`supersedesDetection`, `lib/ml-detection.ts`). With the model primary it is a
 * real sigmoid — P(document present) — on every detection the loop tracks; the
 * geometry heuristic that {@link detectOnCanvas} returns is now the exception,
 * seen only while the model is warming up or after it has been latched off.
 * `null` is scanic saying it has no score — treated as unknown, never as zero.
 * Nothing on the capture path reads it: a photo the user asked for is taken at
 * any confidence.
 */
export interface QuadDetection {
  /** Fractions of the frame — the coordinate system everything else speaks. */
  corners: NormalizedQuad;
  confidence: number | null;
  /** Which detector answered — carried for the debug panel's capture row. */
  source: DetectionSource;
  /**
   * The model answered "no page" and these are the classical detector's
   * corners ({@link CAPTURE_CLASSICAL_FALL_THROUGH}) — for the bench's
   * comparison of the two capture policies.
   */
  fellThrough?: boolean;
  /**
   * What the refinement said about the corners (`lib/corner-check.ts`):
   * each seen, inferred or unknown, and whether another sheet overlaps the
   * page. Absent when the answer was not refined.
   */
  check?: CornerCheck;
}

/**
 * Which detector produced a frame detection.
 *
 * `"ml"` is DocCornerNet, the primary detector: every regular pass once the
 * runtime is warm. `"classical"` is scanic's Canny/contour pipeline, the
 * fallback that carries the warm-up seconds and every session the model failed
 * in. The two never run on the same frame; the tag exists because their answers
 * still meet during a handover, and the loop's arbitration is written in terms
 * of it (`lib/ml-detection.ts`).
 */
export type DetectionSource = "classical" | "ml";

/** The same answer at scanic's own boundary: pixels, in the sampled frame. */
export interface FrameDetection {
  corners: CornerPoints;
  confidence: number | null;
  source: DetectionSource;
}

/**
 * The capture path's policy when the model is ready and **answers that there
 * is no page**: ask the classical detector anyway (`true`, the fall-through)
 * or take no corners (`false`: the confirm screen opens on the whole frame
 * and the user places them).
 *
 * Either way the classical detector still answers when the model *cannot* —
 * not ready yet, latched off, out of time, or (main-thread lane) held by a
 * live pass — because then it is the only detector there is. Decided on the
 * bench's sessions and scenes (`scripts/bench/README.md`, "Capture: the
 * classical fall-through"): the fall-through's rescues outnumber its
 * miscrops.
 */
export const CAPTURE_CLASSICAL_FALL_THROUGH = true;

/** How long a capture waits for a lane still being decided before running on this thread. */
const LANE_WAIT_MS = 250;

/** A one-shot detect's answer, and how it came to be — for the probe and the capture policy. */
interface HeldDetection {
  detection: FrameDetection | null;
  lane: "worker" | "main";
  /** The model answered nothing and the classical detector was asked. */
  fellThrough: boolean;
  /** Why the model was not asked (`busy`: a live pass held it — a downgrade). */
  mlSkipped: "busy" | "not-ready" | "disabled" | null;
  /** Worker lane: time spent queued behind a live pass already running. */
  queueMs: number | null;
}

/**
 * One detect with whichever detector this session is currently on — the model
 * when it is warm, the classical pipeline otherwise — on whichever lane the
 * session runs detection on.
 *
 * ML-first means ML-*first*: a model that cannot answer — not ready, latched
 * off mid-call, out of time, held by an earlier pass — is followed by a
 * classical pass rather than by a shrug. A model that *did* answer "no page"
 * is followed by one only under {@link CAPTURE_CLASSICAL_FALL_THROUGH}.
 */
async function detectFrame(
  source: HTMLCanvasElement,
  budgetMs: number,
  urls: AssetUrls,
): Promise<HeldDetection> {
  // A lane still being decided is usually decided in milliseconds; running
  // the model here meanwhile would warm a second ONNX session beside the
  // worker's. But a worker script still on its way (or one that will never
  // say hello) can take seconds, and a capture's budget must not start after
  // them: past a short wait the capture runs here, with the model only if it
  // is already proven on this thread — otherwise the classical detector.
  await Promise.race([
    detectLaneSettled(),
    new Promise<void>((resolve) => window.setTimeout(resolve, LANE_WAIT_MS)),
  ]);
  const mlPrimary = primaryDetector({ ready: isMlReady(), disabled: isMlDisabled() }) === "ml";
  if (detectLane() === "worker") {
    const held = await detectFrameInWorker(source, budgetMs, mlPrimary);
    // A worker that died during the job handed the session to this thread.
    if (held !== null) return held;
  }
  let mlSkipped: HeldDetection["mlSkipped"] = mlPrimary ? null : isMlDisabled() ? "disabled" : "not-ready";
  if (mlPrimary) {
    if (isMlBusy()) mlSkipped = "busy";
    const pass = await mlPass(source, budgetMs, urls);
    if (pass.detection !== null) {
      return { detection: pass.detection, lane: "main", fellThrough: false, mlSkipped: null, queueMs: null };
    }
    if (pass.outcome === "none" && !CAPTURE_CLASSICAL_FALL_THROUGH) {
      return { detection: null, lane: "main", fellThrough: false, mlSkipped: null, queueMs: null };
    }
  }
  return {
    detection: await detectOnCanvas(source, budgetMs, urls),
    lane: "main",
    fellThrough: mlPrimary && mlSkipped === null,
    mlSkipped,
    queueMs: null,
  };
}

/**
 * The same detect in the worker: the frame goes over as an `ImageBitmap`
 * (Chromium defers the pixel copy to the worker), jumps the live queue, and
 * the worker runs the plan — model, then classical when the policy or the
 * model's absence says so. `null` when the worker was lost, so the caller can
 * run it here instead.
 */
async function detectFrameInWorker(
  source: HTMLCanvasElement,
  budgetMs: number,
  mlPrimary: boolean,
): Promise<HeldDetection | null> {
  const plan: DetectPlan = !mlPrimary ? "classical" : CAPTURE_CLASSICAL_FALL_THROUGH ? "ml-then-classical" : "ml";
  let frame: ImageBitmap;
  try {
    frame = await createImageBitmap(source);
  } catch {
    return null;
  }
  const reply = await laneDetect(
    {
      frame,
      width: source.width,
      height: source.height,
      plan,
      priority: "capture",
      capturedAt: performance.now(),
      epoch: 0,
      luma: false,
      refineMs: 0,
      evidence: false,
      held: null,
      hint: false,
    },
    budgetMs,
  );
  if (reply.type === "miss") return detectLane() === "worker" ? emptyHeld("worker", mlPrimary) : null;
  // The model failed in the worker: the session moves to this thread, which
  // warms its own (the classical answer the worker gave instead still stands).
  if (reply.mlFailed) demoteDetectLane("worker-ml-failed");
  const detection =
    reply.success && reply.corners !== null && reply.detector !== null
      ? { corners: reply.corners, confidence: reply.confidence, source: reply.detector }
      : null;
  return {
    detection,
    lane: "worker",
    fellThrough: reply.fellThrough,
    mlSkipped: mlPrimary ? null : isMlDisabled() ? "disabled" : "not-ready",
    queueMs: reply.queueMs,
  };
}

function emptyHeld(lane: "worker" | "main", mlPrimary: boolean): HeldDetection {
  return {
    detection: null,
    lane,
    fellThrough: false,
    mlSkipped: mlPrimary ? null : isMlDisabled() ? "disabled" : "not-ready",
    queueMs: null,
  };
}

/**
 * Detect the page in a frame the caller already holds. Never rejects: no quad
 * is a normal answer and the warp rescue is the contract.
 *
 * The answer is **refined** onto the paper's edge ({@link refineCorners})
 * unless `refine: false` — which only the bench asks for, to measure the
 * detector on its own.
 */
export async function detectInCanvas(
  source: HTMLCanvasElement,
  urls: AssetUrls,
  { refine = true }: { refine?: boolean } = {},
): Promise<QuadDetection | null> {
  return detectHeld(source, urls, "frame", refine);
}

/**
 * Where the corners handed to {@link refineCorners} came from — the capture's
 * own detect, the live loop's quad (on the preview frame, or carried to the
 * still), or a fresh detect on a stored canonical.
 */
export type RefineFrom = RefineProbe["from"];

/**
 * Move a quad that is about to seed a confirm screen onto the paper's edge,
 * on the image it is normalized to (`lib/refine.ts`). The detectors answer
 * slightly inside the page as a rule, and on a low-contrast table the model can
 * pull a corner onto the text block; the refinement measures the edge itself.
 *
 * Runs **after** every gate — the coverage floor judged the detector's own
 * answer — and never decides whether there are corners, only where. A quad
 * from the classical detector (or of unknown origin) is only ever snapped
 * locally: its confident failure is the desk, and a wide search from there
 * would only make the desk look more like a page. Refinement that fails,
 * doubts or runs out of time answers the corners it was given.
 */
export function refineCorners(
  frame: HTMLCanvasElement,
  quad: NormalizedQuad,
  detector: DetectionSource | null,
  from: RefineFrom,
): NormalizedQuad {
  return refineCornersChecked(frame, quad, detector, from).quad;
}

/**
 * {@link refineCorners}, with what the refinement says about the corners
 * (`lib/corner-check.ts`): the capture's word on them, which the confirm
 * screen marks and the diagnostics carry. The full-resolution still is
 * authoritative — whatever the live loop said about the same corners.
 */
export function refineCornersChecked(
  frame: HTMLCanvasElement,
  quad: NormalizedQuad,
  detector: DetectionSource | null,
  from: RefineFrom,
): { quad: NormalizedQuad; check: CornerCheck } {
  const mode = detector === "ml" ? "full" : "local";
  const result = refineOnCanvas(frame, quad, { mode });
  if (probing()) {
    probe({
      type: "refine",
      t: performance.now(),
      from,
      detector,
      mode,
      input: quad,
      output: result.quad,
      changed: result.changed,
      reason: result.reason,
      sides: result.sides,
      corners: result.corners,
      occlusion: result.occlusion,
      ms: result.ms,
      width: frame.width,
      height: frame.height,
    });
  }
  return { quad: result.quad, check: cornerCheckOf(result) };
}

/**
 * {@link detectInCanvas}, told what it is looking at — only so the bench's
 * probe can tell a capture's detect from a confirm screen's.
 */
async function detectHeld(
  source: HTMLCanvasElement,
  urls: AssetUrls,
  on: CaptureDetectProbe["on"],
  refine = true,
): Promise<QuadDetection | null> {
  const started = performance.now();
  const held = await detectFrame(source, DETECT_BUDGET_MS, urls);
  const detection = held.detection;
  if (detection === null) {
    reportCaptureDetect(on, source, started, null, null, false, held);
    return null;
  }
  const { corners, confidence } = detection;
  // The floor is conditioned on who answered: a high-confidence ML quad
  // is measured against the trusted floor, because a page honestly small in a
  // wide-FOV still is not the failure MIN_QUAD_AREA_FRACTION was built for.
  // A detection that fails its floor is null, never a retry with the other
  // detector — in the small-page regime the classical pipeline's confident
  // answer is the desk, and no corners beats wrong corners.
  const floor = coverageFloor(
    detection.source,
    confidence,
    MIN_QUAD_AREA_FRACTION,
  );
  if (quadCoverage(corners, source.width, source.height) < floor) {
    reportCaptureDetect(on, source, started, detection, floor, false, held);
    return null;
  }
  const quad = normalizeQuad(corners, source.width, source.height);
  reportCaptureDetect(on, source, started, detection, floor, quad !== null, held);
  if (quad === null) return null;
  const refined = refine ? refineCornersChecked(source, quad, detection.source, on === "frame" ? "detected" : "canonical") : null;
  return {
    corners: refined?.quad ?? quad,
    confidence,
    source: detection.source,
    fellThrough: held.fellThrough,
    ...(refined === null ? {} : { check: refined.check }),
  };
}

/** A one-shot detect's answer as the bench's probe sees it (`lib/probe.ts`). */
function reportCaptureDetect(
  on: CaptureDetectProbe["on"],
  frame: HTMLCanvasElement,
  started: number,
  detection: FrameDetection | null,
  floor: number | null,
  accepted: boolean,
  held: HeldDetection,
): void {
  if (!probing()) return;
  const quad =
    detection === null
      ? null
      : normalizeQuad(detection.corners, frame.width, frame.height);
  probe({
    type: "capture-detect",
    on,
    t: started,
    ms: performance.now() - started,
    source: detection?.source ?? null,
    quad,
    confidence: detection?.confidence ?? null,
    coverage:
      detection === null
        ? null
        : quadCoverage(detection.corners, frame.width, frame.height),
    floor,
    accepted,
    width: frame.width,
    height: frame.height,
    lane: held.lane,
    queueMs: held.queueMs,
    fellThrough: held.fellThrough,
    mlSkipped: held.mlSkipped,
  });
}

/**
 * The detection scanic would pick for a page's canonical — the editor's start.
 *
 * The full {@link QuadDetection}, not just the corners: the editors only read
 * `.corners` (the user is looking at four movable handles, so how sure the
 * detector was changes nothing there), but the gallery intake hands the whole
 * detection up, because which detector answered at what confidence is exactly
 * what the coverage floor downstream conditions itself on.
 */
export async function detectInBlob(
  canonical: Blob,
  urls: AssetUrls,
): Promise<QuadDetection | null> {
  let source: HTMLCanvasElement;
  try {
    source = await decodeCanonical(canonical);
  } catch {
    return null;
  }
  try {
    return await detectHeld(source, urls, "canonical");
  } finally {
    releaseCanvas(source);
  }
}

/**
 * Warp a frame the caller already holds, with corners it already knows.
 *
 * `corners` are normalized, so the same stored quad warps the canonical at
 * whatever size this decode produced. Returns null when scanic could not
 * extract — the caller then keeps the un-warped geometry rather than losing the
 * page.
 */
export async function warpToCanvas(
  source: HTMLCanvasElement,
  corners: NormalizedQuad,
  urls: AssetUrls,
): Promise<HTMLCanvasElement | null> {
  try {
    const { extractDocument } = await loadScanic(urls);
    const result = await extractDocument(
      source,
      denormalizeQuad(corners, source.width, source.height),
      { output: "canvas" },
    );
    return result.success ? asCanvas(result.output) : null;
  } catch {
    return null;
  }
}

/**
 * One detect-only **classical** pass over a frame the caller already sampled —
 * the fallback detector, and the live viewfinder's own loop while the model
 * downloads.
 *
 * Its confidence is a geometry heuristic, not a probability: scanic scales a
 * candidate that failed its own geometry gate down to ≈0.33 and scores the rest
 * on shape. That is the one place in the app where a confidence does not mean
 * P(document) — the primary detector's does (see {@link detectOnCanvasMl}) — and
 * it is why the weakness bar is a *threshold on two scales* rather than one
 * quantity (`ML_WEAK_CONFIDENCE`, `lib/ml-detection.ts`).
 *
 * `budgetMs` only bounds the *wait*: a detection that blows through it is
 * abandoned by the caller (so the loop never stacks up) while the underlying
 * work finishes on its own. The loop's rolling average sees the real cost and
 * throttles — or gives up on this device — accordingly.
 */
export async function detectOnCanvas(
  source: HTMLCanvasElement,
  budgetMs: number,
  urls: AssetUrls,
): Promise<FrameDetection | null> {
  const result = await withBudget(
    (async () => {
      const { scanDocument } = await loadScanic(urls);
      return scanDocument(source, {
        mode: "detect",
        minDocumentCoverageRatio: MIN_QUAD_AREA_FRACTION,
      });
    })(),
    budgetMs,
  );
  if (result?.success !== true || result.corners === null) return null;
  return {
    corners: result.corners,
    confidence: result.confidence ?? null,
    source: "classical",
  };
}

/**
 * The confidence the model has to reach before it reports a document at all.
 *
 * Deliberately `ML_WEAK_CONFIDENCE` itself (`lib/ml-detection.ts`), the bar the
 * arbitration uses for "unconvincing": a successful ML detection is therefore,
 * by construction, never a weak one. It is a real sigmoid — P(document
 * present) — which is what makes it the number the primary detector is allowed
 * to be silent under.
 */
const ML_MIN_SCORE = ML_WEAK_CONFIDENCE;

/**
 * The ML runtime's latches live in `lib/ml-detection.ts`, next to the warm-up
 * probe that sets them — this module keeps the names the rest of the app calls
 * them by, so which file owns the state is not everyone else's problem.
 *
 * `isMlDetectionDisabled` is the fail-closed one: once the runtime has failed,
 * it is never tried again this session and scanic's classical detector (whose
 * WASM is inlined inside scanic and so can never 404) carries the rest of it.
 */
export {
  disableMl as disableMlDetection,
  isMlBusy as isMlDetectionBusy,
  isMlDisabled as isMlDetectionDisabled,
  isMlReady as isMlDetectionReady,
  warmUpMl,
} from "@/lib/ml-detection";

/**
 * How long a capture will wait for the live loop's in-flight ML pass to settle.
 *
 * Landing well inside the capture path's own 3 s detect budget: worst case is
 * this wait plus one fresh pass, which phones at the slow end of the measured
 * 350–900 ms band still fit.
 */
export const ML_FLIGHT_WAIT_MS = 1200;

/**
 * Waits (bounded) until no ML pass is in flight — the capture path's antidote
 * to being silently downgraded to the classical detector.
 *
 * {@link detectOnCanvasMl} is single-flight and answers null when busy, which
 * is right for the viewfinder loop (skip a frame, another arrives in 125 ms)
 * and wrong for a capture: there is exactly one frame, and losing the ML pass
 * on it hands the page to the classical pipeline, whose confident failure mode
 * is the desk. The live loop is already paused by the time a capture
 * detects — only the pass that was airborne at the tap can still hold the
 * latch, so this resolves quickly in practice and the deadline is a backstop,
 * never the expected path.
 */
export async function waitForMlIdle(
  budgetMs: number = ML_FLIGHT_WAIT_MS,
): Promise<void> {
  if (isMlDisabled()) return;
  // On the worker lane the capture's job jumps the worker's queue instead: it
  // waits at most for the one pass already running there, and the model is
  // never skipped for it.
  if (detectLane() === "worker") return;
  const deadline = performance.now() + budgetMs;
  while (isMlBusy() && performance.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
}

/**
 * One detect-only ML pass over a frame the caller already sampled — **the
 * primary detector's pass**.
 *
 * Same shape and same contract as {@link detectOnCanvas}: never rejects, and a
 * blown budget is abandoned by the caller while the work finishes on its own —
 * which matters here because the *first* call also pays for ~3.4 MB of model and
 * runtime, and that download must be allowed to complete in the background so
 * the next call can use the session scanic memoises. That first call is the
 * warm-up the capture screen fires eagerly, with the classical detector holding
 * the viewfinder until it settles.
 *
 * **Single-flight is owned here**, not by the caller: a pass launched while an
 * earlier one is still running answers null immediately, so the frame a pass was
 * handed is safe to reuse for the next one and only one inference is ever alive.
 *
 * Note this path ignores `minDocumentCoverageRatio` — the ML branch of
 * `scanDocument` never looks at it — so the caller still owns the coverage gate.
 */
export async function detectOnCanvasMl(
  source: HTMLCanvasElement,
  budgetMs: number,
  urls: AssetUrls,
): Promise<FrameDetection | null> {
  return (await mlPass(source, budgetMs, urls)).detection;
}

/**
 * {@link detectOnCanvasMl}, saying why it answered nothing: `none` — the
 * model ran and found no page; `busy` — an earlier pass held it; `timeout` —
 * the budget ran out first; `failed` — the runtime threw (and is latched off).
 */
async function mlPass(
  source: HTMLCanvasElement,
  budgetMs: number,
  urls: AssetUrls,
): Promise<{ detection: FrameDetection | null; outcome: "found" | "none" | "busy" | "timeout" | "failed" }> {
  if (detectLane() === "worker") {
    // The model lives in the worker while that lane is on: never a second
    // session here.
    let frame: ImageBitmap;
    try {
      frame = await createImageBitmap(source);
    } catch {
      return { detection: null, outcome: "failed" };
    }
    const reply = await laneDetect(
      { frame, width: source.width, height: source.height, plan: "ml", priority: "capture", capturedAt: performance.now(), epoch: 0, luma: false, refineMs: 0, evidence: false, held: null, hint: false },
      budgetMs,
    );
    if (reply.type === "miss") return { detection: null, outcome: "timeout" };
    if (reply.mlFailed) {
      demoteDetectLane("worker-ml-failed");
      return { detection: null, outcome: "failed" };
    }
    return reply.success && reply.corners !== null
      ? { detection: { corners: reply.corners, confidence: reply.confidence, source: "ml" }, outcome: "found" }
      : { detection: null, outcome: "none" };
  }
  if (!beginMlPass()) return { detection: null, outcome: "busy" };
  let failed = false;
  const work = (async () => {
    const { scanDocument } = await loadScanic(urls);
    return scanDocument(source, {
      mode: "detect",
      detector: "ml",
      // One shape for every ML call in the library: scanic memoises its ORT
      // session on `modelUrl|wasmPaths|numThreads`, so a second distinct triple
      // would be a second 3.4 MB session on a phone that can barely hold one.
      ml: mlDetectorOptions(urls, ML_MIN_SCORE),
    });
  })();
  // Attached to the work itself rather than to the awaited result: a failure
  // that arrives after our budget expired is still a failure of the runtime,
  // and it must latch — just as a *settled* pass is proof the runtime works
  // however late it landed, which is what promotes the model to primary.
  // `withBudget` swallows the rejection separately. The flight latch is
  // released here, on the *work*, for the same reason.
  work
    .then(markMlReady, () => {
      failed = true;
      disableMl();
    })
    .finally(endMlPass);
  let settled = false;
  const result = await withBudget(
    work.then((value) => {
      settled = true;
      return value;
    }),
    budgetMs,
  );
  if (result?.success !== true || result.corners === null || result.corners === undefined) {
    return { detection: null, outcome: failed ? "failed" : settled ? "none" : "timeout" };
  }
  return {
    detection: {
      corners: result.corners,
      confidence: result.confidence ?? null,
      source: "ml",
    },
    outcome: "found",
  };
}
