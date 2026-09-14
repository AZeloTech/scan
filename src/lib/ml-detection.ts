/**
 * The ML corner detector's policy: when it runs, what it costs, and whose
 * answer wins while the two detectors are handing over to each other.
 *
 * **DocCornerNet is the primary detector.** It is not an escalation and
 * it is not woken by trouble: entering the capture screen starts the ~3.4 MB of
 * model + WASM downloading (from the host's own `assetBaseUrl`, never a CDN),
 * and from the moment that runtime is warm every regular pass of the live loop
 * is an ML pass. scanic's classical Canny/contour detector is what keeps the
 * viewfinder alive in the meantime — and what takes back over, for the rest of
 * the session, if anything about the ML path fails. This module owns both the
 * decisions around that handover and the **fail-closed latch** itself.
 *
 * The arbitration half is pure and DOM-free — time is a parameter, never
 * `performance.now()` read from inside — so the handover can be tested at the
 * seam (`ml-detection.test.ts`) instead of by holding a phone over a desk. The
 * runtime half below it (the latch and {@link warmUpMl}) is the exception: it
 * touches scanic, and it exists because nothing else in scanic can answer the
 * one question that matters — whether ML works on this device and this deploy.
 *
 * The ML pass's own numbers live here rather than with the live loop's other
 * throttle constants because they are facts about *this detector* — a 640 px
 * DocCornerNet inference is a different workload from a contour trace, and the
 * loop measures and backs off against whichever one it is currently running.
 */

import type { DetectionSource } from "@/lib/flatten";
import { loadScanic } from "@/lib/scanic-runtime";
import { mlDetectorOptions, type AssetUrls } from "@/lib/runtime-config";

/**
 * The ML pass's base interval: ~1.4 passes a second.
 *
 * Slower than the classical loop's ~8/s on purpose. An inference is worth more
 * per pass than a contour trace, and the phones this product targets are the
 * ones a 60 ms pass every 125 ms would cook.
 */
export const ML_CADENCE_MS = 700;

/** Rolling average above this: the loop halves the ML pass rate. */
export const ML_SLOW_PASS_MS = 350;

/**
 * Rolling average above this and this device cannot run the model live.
 *
 * Unlike the classical detector's equivalent, this does not switch live
 * detection off: it latches ML off for the session and the classical loop takes
 * over — the same fallback every other ML failure lands in.
 */
export const ML_HOPELESS_PASS_MS = 900;

/**
 * How long a normal ML pass may take before its answer is thrown away.
 *
 * The corners describe the frame the pass started on, so a very late answer is a
 * description of a moment that has gone. Generous rather than tight, because the
 * devices this feature exists for are the slow ones.
 */
export const ML_CALL_BUDGET_MS = 2500;

/**
 * The one-time budget for the warm-up pass, which also pays for the ~3.4 MB
 * download and the WASM compile.
 *
 * It is long because the download must be allowed to finish — scanic memoises
 * the session, so every pass after it is a normal pass. The caller runs the
 * warm-up **detached** from the detection chain and keeps its cost out of the
 * adaptive-throttle average: a slow *network* is not a slow *device*, and
 * letting it into that average would write off a perfectly capable phone. A
 * warm-up slower than {@link ML_CALL_BUDGET_MS} is treated as pure warm-up and
 * its corners are discarded ({@link isMlResultFresh}).
 */
export const ML_WARM_UP_BUDGET_MS = 30000;

/**
 * What counts as a detection nobody should have to trust.
 *
 * Deliberately the same number as the ML detector's own `minScore`
 * (`lib/flatten.ts`), so a successful ML detection is never weak by
 * construction. On the classical fallback's side it is a geometry heuristic
 * rather than a probability: scanic returns candidates that failed its own
 * geometry gate with their score scaled down — those land around ≤0.33 — so 0.5
 * sits clear of the band that means "not really a page". `null` — scanic
 * declining to score — counts as weak: an unknown is not a reassurance.
 */
export const ML_WEAK_CONFIDENCE = 0.5;

/**
 * The confidence at which the model's quad outranks the area heuristic.
 *
 * A real sigmoid — P(document present) — not the classical pipeline's geometry
 * score, which is why only `"ml"` detections may claim it. On the field stills
 * that motivated this (S25 Ultra) the model sat at ≥0.999 while its
 * correct quad covered 0.30–0.33 of the frame.
 */
export const ML_TRUSTED_CONFIDENCE = 0.9;

/**
 * The floor a trusted ML quad still has to clear.
 *
 * Not zero: a quad this small is a receipt across the room, and warping to it
 * would print a stamp-sized page. 0.1 keeps the "page is small because the
 * still's field of view is wide" regime while still rejecting specks.
 */
export const ML_TRUSTED_MIN_COVERAGE = 0.1;

/**
 * How much of the frame a detection must cover before anyone believes it —
 * conditioned on who is claiming it, and how confidently.
 *
 * The caller supplies the unconditioned floor (`MIN_QUAD_AREA_FRACTION` in
 * `lib/flatten.ts` — deliberately not imported here, that would be a cycle).
 * That floor was built for the **classical** pipeline's failure mode: a text
 * block or a stain returned as a confident contour. The ML model does not fail
 * that way — when it is sure, its quad is the page — but the page can honestly
 * be small in frame: the still pipeline's field of view is wider than the
 * preview the user composed against. So a trusted ML detection is
 * measured against {@link ML_TRUSTED_MIN_COVERAGE} instead, and everything
 * else — classical always, ML below {@link ML_TRUSTED_CONFIDENCE}, ML with no
 * score at all — keeps the caller's floor. A gated-out detection stays gated:
 * it must never fall through to the other detector, whose confident answer in
 * exactly this regime is the desk, not the page.
 */
export function coverageFloor(
  source: DetectionSource,
  confidence: number | null,
  unconditionedFloor: number,
): number {
  return source === "ml" && confidence !== null && confidence >= ML_TRUSTED_CONFIDENCE
    ? ML_TRUSTED_MIN_COVERAGE
    : unconditionedFloor;
}

/** What the caller knows about the ML runtime, from `lib/flatten.ts`. */
export interface MlAvailability {
  /** The runtime has loaded and answered at least once this session. */
  ready: boolean;
  /** It failed, and is latched off for the rest of the session. */
  disabled: boolean;
}

/**
 * Which detector the next regular pass belongs to.
 *
 * ML the moment it can answer, classical before that and after any failure.
 * There is never a frame on which both run: the fallback exists so the
 * viewfinder is not dead during the download, not to give a second opinion.
 */
export function primaryDetector({ ready, disabled }: MlAvailability): DetectionSource {
  return ready && !disabled ? "ml" : "classical";
}

/**
 * Whether the session still owes the eager warm-up pass.
 *
 * Once, per page-session, as early as there is a frame to run it on — the point
 * of warming up eagerly is that the download starts before anything has gone
 * wrong, not
 * after. A warm-up that has failed has latched `disabled` instead, and a
 * warm-up still in flight has already set `started`.
 */
export function shouldWarmUpMl(
  { ready, disabled }: MlAvailability,
  started: boolean,
): boolean {
  return !started && !ready && !disabled;
}

/** A detection, dated by the frame it describes rather than by its answer. */
export interface DetectionCandidate {
  source: DetectionSource;
  /** scanic's score, `null` when it declined to give one. */
  confidence: number | null;
  /** When the frame this describes was sampled — never when it was answered. */
  capturedAt: number;
}

function isWeak(candidate: DetectionCandidate): boolean {
  return (
    candidate.confidence === null || candidate.confidence < ML_WEAK_CONFIDENCE
  );
}

/**
 * Whether a detection may replace the one being tracked.
 *
 * Two detectors reach the overlay over one frame stream, at wildly different
 * speeds, whenever the session is handing over: classical while the model
 * downloads and the detached warm-up pass answering into it, or the model still
 * finishing a pass when a failure has just handed the loop back to classical. In
 * those windows "newest answer wins" would let a slow pass describing an old
 * frame overwrite a fresh one, and a capture would warp with corners from a
 * moment that has gone. Three rules, in order:
 *
 *  * **Same detector: strictly in frame order.** A pass that describes an older
 *    frame than the one already tracked has nothing to add.
 *  * **The model may take over a quad the classical detector doubts**, even a
 *    newer one — the model is the better detector and that doubt is what the
 *    handover is for — but never a confident classical quad describing a newer
 *    frame.
 *  * **A weak classical candidate may not displace a fresh ML quad**, for
 *    `mlAuthorityMs`: the table edges and text blocks the fallback keeps
 *    offering are exactly what the model was brought in to beat. A *confident*
 *    classical quad still wins, which is what makes the fail-closed fallback
 *    usable the instant it takes over. The caller passes its own ML staleness
 *    horizon, so the authority ends when the quad it protects would be retired
 *    anyway.
 */
export function supersedesDetection(
  next: DetectionCandidate,
  tracked: DetectionCandidate | null,
  now: number,
  mlAuthorityMs: number,
): boolean {
  if (tracked === null) return true;
  if (next.source === tracked.source) return next.capturedAt > tracked.capturedAt;
  if (next.source === "ml") {
    return isWeak(tracked) || next.capturedAt > tracked.capturedAt;
  }
  if (next.capturedAt <= tracked.capturedAt) return false;
  return !(isWeak(next) && now - tracked.capturedAt < mlAuthorityMs);
}

/**
 * A pass that took longer than a normal budget describes a frame that has gone.
 * Its only remaining value is that the assets are now warm.
 */
export function isMlResultFresh(startedAt: number, now: number): boolean {
  return now - startedAt < ML_CALL_BUDGET_MS;
}


/* ── The ML runtime: one latch, one probe ──────────────────────────────── */

/**
 * Session latch: once the ML runtime has failed, it is never tried again.
 *
 * Fail closed and silent. Every reason ML can fail — the assets missing from
 * the host's public directory, a 404 on the model, a CSP that forbids
 * `wasm-unsafe-eval`, a browser that cannot compile the WASM — is a property of
 * this device and this deploy, not of this frame, so retrying costs battery and
 * a repeated multi-megabyte fetch for an answer that will not change. The
 * classical detector and manual capture are untouched by it, and **the person
 * using the scanner is told nothing**: there is nothing they could do, and
 * scanic's classical detector — whose WASM is base64-inlined inside scanic
 * itself and therefore can never 404 — carries the session from here.
 */
let disabled = false;

/**
 * The runtime has loaded, compiled and answered at least once this session.
 *
 * The handover signal: until it flips, the classical detector is carrying the
 * viewfinder; after it, the model is the regular pass. It is set on a pass
 * *settling*, not on a successful detection — an inference that honestly found
 * no page is proof the runtime works.
 */
let ready = false;

/**
 * The single-flight latch, held until the underlying work truly settles.
 *
 * A caller's budget only bounds the *wait*: losing that race abandons the
 * answer, not the work, and the work is still holding a frame plus an ORT
 * session. A second pass started on top of it would put two inferences on a
 * phone already struggling with one.
 */
let inFlight = false;

/** Whether the ML detector is still worth calling. */
export function isMlDisabled(): boolean {
  return disabled;
}

/** Whether the model can answer now, or the fallback is still carrying it. */
export function isMlReady(): boolean {
  return ready;
}

/** True while an earlier ML pass is still running, budget or no budget. */
export function isMlBusy(): boolean {
  return inFlight;
}

/**
 * Latch ML off for the session.
 *
 * Called from here on any runtime failure, and from the live loop's side for
 * its own half of the pass — a device the model is measurably too slow on
 * ({@link ML_HOPELESS_PASS_MS}) is the same kind of fact as a runtime that will
 * not load, and lands in the same place.
 */
export function disableMl(): void {
  disabled = true;
}

/** A pass settled, whatever it found: the runtime is proven. */
export function markMlReady(): void {
  ready = true;
}

/**
 * Claim the single-flight latch for one pass. `false` means "not now" — ML is
 * latched off, or an earlier pass is still airborne — and the caller falls
 * through to the classical detector rather than waiting.
 */
export function beginMlPass(): boolean {
  if (disabled || inFlight) return false;
  inFlight = true;
  return true;
}

/** Release the latch. Always paired with a `true` from {@link beginMlPass}. */
export function endMlPass(): void {
  inFlight = false;
}

/**
 * The probe frame: the smallest thing that still makes scanic build a real ORT
 * session and run a real inference. Blank white, 64×64 — the model resizes to
 * its own input either way, and what is being asked is "does this runtime work
 * here", never "is there a page in this".
 */
const PROBE_SIDE = 64;

function probeFrame(): ImageData {
  const data = new Uint8ClampedArray(PROBE_SIDE * PROBE_SIDE * 4).fill(255);
  return new ImageData(data, PROBE_SIDE, PROBE_SIDE);
}

/**
 * Warm the ML runtime up, and find out whether it works at all.
 *
 * Both jobs, because scanic gives no way to do either separately. There is no
 * detector to inject: the only ML control surface is the `ml` option on a
 * `scanDocument` call, and `Scanner.initialize()` swallows its own errors, so
 * it cannot report whether ML is usable. `scanDocument` on the ML branch does
 * not swallow — so one tiny inference is simultaneously the download, the WASM
 * compile, the session creation scanic memoises, and the availability signal.
 *
 * The memoisation is keyed on `modelUrl|wasmPaths|numThreads`, which is why
 * every call in this library goes through {@link mlDetectorOptions} with the
 * same {@link AssetUrls}: a second distinct triple is a second 3.4 MB session.
 *
 * **Never rejects.** Resolves `true` when the runtime answered and `false` when
 * it did not — in which case ML is latched off for the session and everything
 * falls back to scanic's classical detector. Safe to call repeatedly: a warm
 * session answers immediately, a failed one answers `false` without touching
 * the network.
 */
export async function warmUpMl(urls: AssetUrls): Promise<boolean> {
  if (disabled) return false;
  if (ready) return true;
  if (!beginMlPass()) return false;
  try {
    const { scanDocument } = await loadScanic(urls);
    await scanDocument(probeFrame(), {
      mode: "detect",
      detector: "ml",
      ml: mlDetectorOptions(urls, ML_WEAK_CONFIDENCE),
    });
    markMlReady();
    return true;
  } catch {
    disableMl();
    return false;
  } finally {
    endMlPass();
  }
}
