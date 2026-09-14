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
 * One pass with whichever detector this session is currently on — the model
 * when it is warm, the classical pipeline otherwise.
 *
 * ML-first means ML-*first*, not ML-only: a pass that answers nothing — no page
 * in the frame, an earlier pass still in flight, a runtime that latched off
 * mid-call — is followed by a classical pass rather than by a shrug. On the
 * capture path that second pass costs milliseconds and is the difference
 * between a page that arrives warped and one the user has to fix by hand.
 */
async function detectFrame(
  source: HTMLCanvasElement,
  budgetMs: number,
  urls: AssetUrls,
): Promise<FrameDetection | null> {
  if (primaryDetector({ ready: isMlReady(), disabled: isMlDisabled() }) === "ml") {
    const detection = await detectOnCanvasMl(source, budgetMs, urls);
    if (detection !== null) return detection;
  }
  return detectOnCanvas(source, budgetMs, urls);
}

/**
 * Detect the page in a frame the caller already holds. Never rejects: no quad
 * is a normal answer and the warp rescue is the contract.
 */
export async function detectInCanvas(
  source: HTMLCanvasElement,
  urls: AssetUrls,
): Promise<QuadDetection | null> {
  const detection = await detectFrame(source, DETECT_BUDGET_MS, urls);
  if (detection === null) return null;
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
    return null;
  }
  const quad = normalizeQuad(corners, source.width, source.height);
  return quad === null
    ? null
    : { corners: quad, confidence, source: detection.source };
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
    return await detectInCanvas(source, urls);
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
  if (!beginMlPass()) return null;
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
  work.then(markMlReady, disableMl).finally(endMlPass);
  const result = await withBudget(work, budgetMs);
  if (result?.success !== true || result.corners === null) return null;
  return {
    corners: result.corners,
    confidence: result.confidence ?? null,
    source: "ml",
  };
}
