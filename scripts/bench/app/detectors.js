/**
 * The detector variants the bench compares, each calling the library's own
 * source exactly the way the product does.
 *
 * Nothing here re-implements a detector or restates its options: the calls go
 * through `src/lib/flatten.ts`, so `mlDetectorOptions()`, the coverage floor
 * and the ML-first/classical-fallback chain are the shipping ones, and a change
 * to any of them changes the bench's numbers the same day.
 *
 *  - `ml` — one live-loop ML pass: the frame downscaled to the loop's 640 px
 *    sample, `detectOnCanvasMl`, then the loop's conditioned coverage floor.
 *  - `classical` — one live-loop classical pass: same sample, `detectOnCanvas`
 *    (which carries the 0.35 `minDocumentCoverageRatio`), same floor.
 *  - `production` — the capture path as it was before refinement:
 *    `detectInCanvas(…, { refine: false })` on the full frame (ML first when
 *    the runtime is warm, its trusted floor, the classical fallback).
 *  - `refined` — the capture path as the product runs it now: the same call
 *    with its edge refinement (`src/lib/refine.ts`) on.
 *  - `ml+refine` — the live-loop ML pass, its quad then refined on the full
 *    frame exactly as a capture refines a carried live quad.
 *
 * The refinement's own report (probe `refine` event: ms, per-side verdicts)
 * travels in the row as `refine`.
 */

import { assetUrls } from "../../../src/lib/runtime-config.ts";
import {
  detectInCanvas,
  detectOnCanvas,
  detectOnCanvasMl,
  isMlDetectionDisabled,
  isMlDetectionReady,
  MIN_QUAD_AREA_FRACTION,
  refineCorners,
  warmUpMl,
} from "../../../src/lib/flatten.ts";
import { coverageFloor, ML_CALL_BUDGET_MS } from "../../../src/lib/ml-detection.ts";
import { cornerList, normalizedCoverage, normalizeQuad } from "../../../src/lib/quad.ts";

/**
 * `SAMPLE_LONG_EDGE` and the classical pass budget are module-private in
 * `hooks/useLiveDetect.ts`; mirrored here, and named after what they mirror.
 */
export const SAMPLE_LONG_EDGE = 640;
const CLASSICAL_PASS_BUDGET_MS = 2000;

let urls = null;

/** Point the library at the served assets and warm the ML runtime once. */
export async function initDetectors(assetBase) {
  urls = assetUrls(assetBase);
  const warmStarted = performance.now();
  const mlReady = await warmUpMl(urls);
  return { mlReady, mlWarmUpMs: performance.now() - warmStarted, assets: urls.base };
}

/** The live loop's sample: the whole frame, drawn down to 640 px on its long edge. */
function liveSample(frame) {
  const scale = Math.min(1, SAMPLE_LONG_EDGE / Math.max(frame.width, frame.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(frame.width * scale));
  canvas.height = Math.max(1, Math.round(frame.height * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(frame, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** A library quad → `[[x, y] × 4]`, TL, TR, BR, BL as the detector named them. */
function toPoints(quad) {
  return quad === null ? null : cornerList(quad).map((p) => [p.x, p.y]);
}

/** One live-loop pass, gated exactly as `accept()` gates it (floor only; no tracking). */
async function livePass(frame, detect) {
  const sample = liveSample(frame);
  const started = performance.now();
  const detection = await detect(sample);
  const ms = performance.now() - started;
  const quad = detection === null ? null : normalizeQuad(detection.corners, sample.width, sample.height);
  const floor =
    detection === null ? null : coverageFloor(detection.source, detection.confidence, MIN_QUAD_AREA_FRACTION);
  const coverage = quad === null ? null : normalizedCoverage(quad);
  return {
    source: detection?.source ?? null,
    ok: quad !== null,
    accepted: quad !== null && coverage >= floor,
    quad: toPoints(quad),
    confidence: detection?.confidence ?? null,
    coverage,
    floor,
    ms,
    input: { width: sample.width, height: sample.height },
  };
}

/** The refinement's probe event, as a row carries it. */
function refineRow(event) {
  return event === null
    ? null
    : {
        from: event.from,
        mode: event.mode,
        changed: event.changed,
        reason: event.reason,
        ms: event.ms,
        input: toPoints(event.input),
        sides: event.sides,
      };
}

/** Run `work` with a probe listener that keeps the last event of each type. */
async function listening(work) {
  const seen = {};
  const previous = globalThis.__SCAN_PROBE__;
  globalThis.__SCAN_PROBE__ = (event) => {
    seen[event.type] = event;
    if (typeof previous === "function") previous(event);
  };
  try {
    return { result: await work(), seen };
  } finally {
    globalThis.__SCAN_PROBE__ = previous;
  }
}

/** The capture path, with its pre-floor answer read off the probe (`src/lib/probe.ts`). */
async function capturePass(frame, refine) {
  const started = performance.now();
  const { result: detection, seen } = await listening(() => detectInCanvas(frame, urls, { refine }));
  const ms = performance.now() - started;
  const raw = seen["capture-detect"] ?? null;
  return {
    refine: refineRow(seen.refine ?? null),
    source: raw?.source ?? detection?.source ?? null,
    ok: raw?.quad != null,
    accepted: detection !== null,
    quad: toPoints(detection?.corners ?? raw?.quad ?? null),
    confidence: raw?.confidence ?? detection?.confidence ?? null,
    coverage: raw?.coverage ?? null,
    floor: raw?.floor ?? null,
    ms,
    input: { width: frame.width, height: frame.height },
  };
}

export const VARIANTS = {
  ml: {
    describe: "live-loop ML pass on the 640 px sample, conditioned coverage floor",
    run: (frame) => livePass(frame, (sample) => detectOnCanvasMl(sample, ML_CALL_BUDGET_MS, urls)),
  },
  classical: {
    describe: "live-loop classical pass on the 640 px sample, 0.35 coverage floor",
    run: (frame) => livePass(frame, (sample) => detectOnCanvas(sample, CLASSICAL_PASS_BUDGET_MS, urls)),
  },
  production: {
    describe: "capture path before refinement: detectInCanvas on the full frame (ML first, floor, classical fallback)",
    run: (frame) => capturePass(frame, false),
  },
  refined: {
    describe: "capture path as shipped: production + edge refinement on the full frame (src/lib/refine.ts)",
    run: (frame) => capturePass(frame, true),
  },
  "ml+refine": {
    describe: "live-loop ML pass, its accepted quad refined on the full frame as a carried live quad is",
    run: async (frame) => {
      const pass = await livePass(frame, (sample) => detectOnCanvasMl(sample, ML_CALL_BUDGET_MS, urls));
      if (!pass.accepted) return { ...pass, refine: null };
      const quad = {
        topLeft: { x: pass.quad[0][0], y: pass.quad[0][1] },
        topRight: { x: pass.quad[1][0], y: pass.quad[1][1] },
        bottomRight: { x: pass.quad[2][0], y: pass.quad[2][1] },
        bottomLeft: { x: pass.quad[3][0], y: pass.quad[3][1] },
      };
      const { result: refined, seen } = await listening(async () => refineCorners(frame, quad, pass.source, "live"));
      const refine = refineRow(seen.refine ?? null);
      return { ...pass, quad: toPoints(refined), ms: pass.ms + (refine?.ms ?? 0), refine };
    },
  },
};

/** Run one variant; the ML latches are reported so a silent fallback cannot hide in a row. */
export async function detect(variant, frame) {
  const entry = VARIANTS[variant];
  if (entry === undefined) {
    throw new Error(`unknown variant "${variant}" (known: ${Object.keys(VARIANTS).join(", ")})`);
  }
  const result = await entry.run(frame);
  return { variant, ...result, mlReady: isMlDetectionReady(), mlDisabled: isMlDetectionDisabled() };
}
