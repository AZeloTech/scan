"use client";

/**
 * The still-photo path: asking the camera for a *photo* instead of scraping a
 * preview frame.
 *
 * A viewfinder frame is what the compositor happened to be showing — preview
 * resolution, preview exposure, preview noise reduction. `ImageCapture.takePhoto()`
 * goes to the still pipeline the camera app itself uses, which on most Android
 * phones means a sharper, better-exposed, higher-resolution image of the same
 * page. That is worth having, and it is worth having *optionally*: the API is
 * Chromium-only, drivers reject it, and some phones take seconds to answer. So
 * every path here converges on the same fallback answer — no bitmap and a
 * named {@link StillFallbackReason}, meaning "use the preview frame, at the
 * stream's native size" — and the reason is reported, never swallowed.
 *
 * The photo is asked for at the camera's **largest** size
 * ({@link pickPhotoSize}) and matched to the viewfinder by a crop
 * ({@link stillCropFor}), never by asking the driver for a smaller one.
 *
 * Three rules hold this together:
 *
 *  1. **A budget, never a wait.** The attempt is raced against
 *     {@link STILL_CAPTURE_BUDGET_MS}; a slow driver costs a moment, never a
 *     stuck shutter. The *driver call* is not cancellable, though — losing the
 *     race abandons the answer, not the work — so the attempt stays counted as
 *     in flight until it genuinely settles, and a shutter that arrives while
 *     one is still alive goes straight to the preview frame rather than asking
 *     a busy camera for a second full-resolution photo.
 *  2. **Two strikes per session.** A camera that failed twice will keep
 *     failing, and paying the budget on every page for it is worse than never
 *     having tried ({@link STILL_FAILURE_LIMIT}). A photo that arrives and then
 *     cannot be turned into a capture canvas is a failure like any other
 *     ({@link noteStillFailure}) — it cost the budget *and* a decode.
 *  3. **The photo is not the preview — but the corners may still cross.** A
 *     still may arrive at a different resolution, aspect ratio or field of view
 *     than the frame the user was watching, so its own detection is what
 *     decides the page's corners whenever it lands. When it misses — and on a
 *     phone hunting focus at the shutter moment it misses often — the corners
 *     the user was actually looking at are better than none, so they may travel
 *     as a *fallback*, gated on two things this module answers: the geometry
 *     still matches ({@link quadTransfers}) and they are inside the capture
 *     grace window ({@link liveQuadSurvives}). The confirm-corners screen is
 *     what protects the crop either way.
 *
 * The decision-making — which size to ask for, whether to attempt at all,
 * whether buffered corners may still travel — is pure and unit-tested; only the
 * thin shell around `ImageCapture` touches the DOM.
 */

import { probe, probing } from "@/lib/probe";

/**
 * How long the shutter may spend hoping for a still.
 *
 * The capture already shows its flash and haptic the instant the user taps, so
 * this window is spent under feedback rather than under a frozen screen. ~1.5 s
 * is long enough for a phone whose still pipeline has to spin up (measured
 * takePhoto latencies on mid-range Android sit in the 200–900 ms band) and
 * short enough that a driver which is never going to answer is written off
 * before the user starts tapping again.
 */
export const STILL_CAPTURE_BUDGET_MS = 1500;

/** Failed stills tolerated per session before the path is abandoned. */
export const STILL_FAILURE_LIMIT = 2;

/**
 * How long corners measured on the preview may still travel with a capture.
 *
 * The window has to cover what actually happens between the corners being
 * accepted and the page existing: a detection flicker just before the tap, plus
 * the full {@link STILL_CAPTURE_BUDGET_MS} the still attempt is allowed to burn
 * after it. Anything tighter than that sum spends its whole allowance inside the
 * shutter and throws away the quad the user was looking at when they tapped —
 * which is the failure this window exists to prevent. It is not a claim that
 * 2.5 s of hand movement is harmless: it is a claim that corners this recent are
 * a better opening offer than none, and the mandatory confirm-corners screen is
 * where a drifted crop gets fixed.
 */
export const CAPTURE_GRACE_MS = 2500;

/**
 * How old the buffer may already be **at the tap** and still travel.
 *
 * {@link CAPTURE_GRACE_MS} bounds the whole journey — buffer age plus
 * everything the shutter spends — and exists so the still budget alone cannot
 * disqualify the corners. This bound is the other half: a quad the
 * detector last confirmed 2 s before the tap describes where the page *was*,
 * and on a handheld phone that is centimeters of drift. Fresh at the tap plus
 * a slow shutter is rescuable; stale at the tap is not.
 */
export const LIVE_BUFFER_MAX_AGE_AT_TAP_MS = 800;

/** Whether the buffer was fresh enough at the moment the user tapped. */
export function liveQuadFreshAtTap(bufferAgeMs: number): boolean {
  return bufferAgeMs >= 0 && bufferAgeMs <= LIVE_BUFFER_MAX_AGE_AT_TAP_MS;
}

/** How far two aspect ratios may differ and still describe the same geometry. */
const ASPECT_TOLERANCE = 0.02;

/** A photo dimension the driver will accept. `step` 0 means "continuous". */
export interface PhotoSizeRange {
  min: number;
  max: number;
  step: number;
}

/** What we ask `takePhoto` for — the field names are the spec's. */
export interface PhotoSizeChoice {
  imageWidth: number;
  imageHeight: number;
}

/** Failures so far in this browsing session. Memory only, like everything here. */
let failures = 0;

/**
 * How the most recent still attempt ended: `true` it became a photo the page
 * could use, `false` it failed in any way, `null` none yet this page load.
 */
let lastStillOk: boolean | null = null;

/**
 * Whether the still pipeline is *proven* on this device right now: the last
 * attempt produced a usable photo and the session has not given up on it.
 *
 * What the live stream's cap (`lib/stream-cap.ts`) is conditioned on: the
 * preview may only be made cheaper while the photo — not the preview — is
 * what becomes the page.
 */
export function stillPipelineWorking(): boolean {
  return lastStillOk === true && failures < STILL_FAILURE_LIMIT;
}

/** Whether the most recent still failed, or the session gave up on stills. */
export function stillPipelineFailed(): boolean {
  return lastStillOk === false || failures >= STILL_FAILURE_LIMIT;
}

/** The caller turned the photo into the page's canvas: the pipeline is proven. */
export function noteStillSuccess(): void {
  lastStillOk = true;
}

/**
 * The driver call of an earlier attempt, alive until it actually answers.
 *
 * Not the same thing as "a shutter is busy": the budget race can be lost while
 * `takePhoto()` is still working, and the camera is still holding whatever it
 * allocated for it.
 */
let underlyingFlight: Promise<ImageBitmap | null> | null = null;

/**
 * Whether another still is worth the budget it may cost.
 *
 * `occupied` is the earlier attempt the driver has not answered yet: a second
 * full-resolution photo on top of it is two still pipelines and two decodes at
 * once on the phones least able to afford either, and the preview frame that
 * falls back is a complete capture.
 */
export function stillAttemptsAllowed(
  failureCount: number,
  occupied: boolean,
): boolean {
  return !occupied && failureCount < STILL_FAILURE_LIMIT;
}

/**
 * The count after a failed attempt. Failures accumulate for the whole session
 * and are never forgiven by a later success: the cost of being wrong is a
 * repeated {@link STILL_CAPTURE_BUDGET_MS} stall on the shutter, and a camera
 * that fails intermittently pays it as often as one that fails always.
 */
export function nextFailureCount(failureCount: number): number {
  return failureCount + 1;
}

/**
 * Whether corners measured `totalAgeMs` ago may still travel with a capture.
 *
 * `totalAgeMs` is the whole age, not one leg of it: how long the corners had
 * already been buffered when the shutter fired, plus everything the shutter
 * itself then spent. A clock that ran backwards is not evidence of freshness.
 */
export function liveQuadSurvives(totalAgeMs: number): boolean {
  return totalAgeMs >= 0 && totalAgeMs <= CAPTURE_GRACE_MS;
}

/** Whether a normalized preview quad is geometrically transferable to this frame. */
export function quadTransfers(
  previewAspect: number,
  frameAspect: number,
): boolean {
  if (!Number.isFinite(previewAspect) || !Number.isFinite(frameAspect)) {
    return false;
  }
  if (previewAspect <= 0 || frameAspect <= 0) return false;
  // Normalized corners are fractions of *their own* frame, so they only mean the
  // same thing on another one when both frames are the same shape. A still that
  // came back 16:9 against a 4:3 preview is a different field of view, and
  // 0–1 corners laid onto it point at the wrong part of the page.
  return (
    Math.abs(previewAspect - frameAspect) / previewAspect <= ASPECT_TOLERANCE
  );
}

/**
 * Which corners the page ships with, in priority order.
 *
 * `live` is a quad already measured on this exact frame; `detected` is what the
 * detector found on the finished capture; `fallback` is the buffered preview
 * quad, admitted only once both of the above have come back empty. Fresh
 * measurement always beats a buffer — the buffer is a rescue, not a shortcut.
 */
export function resolveCaptureCorners<T>(
  live: T | null,
  detected: T | null,
  fallback: T | null,
): T | null {
  return live ?? detected ?? fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Pulls one dimension out of whatever `getPhotoCapabilities()` returned.
 *
 * Every field is optional in practice — Firefox has no `ImageCapture` at all,
 * some Android drivers answer with an empty object — so this narrows from
 * `unknown` and answers `null` for anything it cannot vouch for. `null` is not
 * an error: it means "ask for the driver's own default size".
 */
export function readPhotoSizeRange(
  capabilities: unknown,
  key: "imageWidth" | "imageHeight",
): PhotoSizeRange | null {
  if (!isRecord(capabilities)) return null;
  const range: unknown = capabilities[key];
  if (!isRecord(range)) return null;
  const { min, max, step } = range;
  if (typeof min !== "number" || typeof max !== "number") return null;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (max <= 0 || min < 0 || max < min) return null;
  const usableStep =
    typeof step === "number" && Number.isFinite(step) && step > 0 ? step : 0;
  return { min, max, step: usableStep };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** Down to the driver's grid — never up, so the request stays inside the range. */
function snapDown(value: number, range: PhotoSizeRange): number {
  const clamped = clamp(value, range.min, range.max);
  if (range.step === 0) return Math.round(clamped);
  const steps = Math.floor((clamped - range.min) / range.step);
  return Math.min(range.max, range.min + steps * range.step);
}

/**
 * The largest photo this camera supports — the sensor's own full field of
 * view, at every pixel it has.
 *
 * This used to ask for less: the preview's shape at a 3000 px long edge. On
 * Chrome for Android that request is not a request at all but a *hint* — the
 * driver answers with the supported JPEG size **closest** to it (Chromium's
 * Camera2 picks by summed width/height distance), and on a Galaxy S25 Ultra
 * the closest size to 3000×1688 is 3648×1704, a 2.14:1 photo that matches no
 * preview. The shape check then threw it away and the page was made of the
 * preview frame. Asking for the range maxima hits a size that exists — the
 * largest one, which on a phone is the sensor's native 4:3 — and the field of
 * view is matched to the preview afterwards by a pure crop
 * ({@link stillCropFor}), which costs no resample.
 *
 * Returns `null` when the capabilities say nothing usable; the caller then
 * takes the photo without settings, which is a photo all the same.
 */
export function pickPhotoSize(
  width: PhotoSizeRange | null,
  height: PhotoSizeRange | null,
): PhotoSizeChoice | null {
  if (width === null || height === null) return null;
  const imageWidth = snapDown(width.max, width);
  const imageHeight = snapDown(height.max, height);
  if (imageWidth <= 0 || imageHeight <= 0) return null;
  return { imageWidth, imageHeight };
}

/** A rectangle of the still, in its own (upright) pixels. */
export interface StillCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Why a still did not become the page, and the preview frame did.
 *
 * Every one of these is reported (the `capture` diagnostics event's
 * `stillReason`), because "the page was made of the preview frame" is exactly
 * the silent downgrade this module exists to prevent.
 */
export type StillFallbackReason =
  /** No `ImageCapture` (Safari, Firefox) or no `createImageBitmap`. */
  | "unsupported"
  /** No live video track to photograph. */
  | "no-track"
  /** Two stills already failed this session ({@link STILL_FAILURE_LIMIT}). */
  | "gave-up"
  /** The previous attempt's driver call has not settled yet. */
  | "busy"
  /** `new ImageCapture(track)` threw. */
  | "construct-failed"
  /** No photo within {@link STILL_CAPTURE_BUDGET_MS}. */
  | "timeout"
  /** `takePhoto()` rejected, or answered something that is not a photo. */
  | "take-failed"
  /** The photo would not decode. */
  | "decode-failed"
  /** The photo decoded but its canvas could not be allocated. */
  | "alloc-failed"
  /** The photo cannot be cropped to the preview's field of view. */
  | "aspect-mismatch"
  /** The photo came back turned a quarter against the preview. */
  | "orientation-mismatch";

/** What {@link stillCropFor} decided: the part of the still that is the page's frame, or why none is. */
export type StillFit =
  | { crop: StillCrop; basis: "whole" | "sensor-crop" }
  | { reason: "aspect-mismatch" | "orientation-mismatch" };

function sameSize(a: number, b: number): boolean {
  return a > 0 && b > 0 && Math.abs(a - b) / Math.max(a, b) <= ASPECT_TOLERANCE;
}

/**
 * Which part of a still shows what the viewfinder showed — a pure crop, never
 * a resample.
 *
 * Two cases are provably the preview's field of view:
 *
 *  * **The still already has the preview's shape** — the whole still.
 *  * **The still is the sensor-native size we asked for** ({@link pickPhotoSize})
 *    — the largest photo a camera has spans its whole active array, and a
 *    phone's preview stream is the *centre crop* of that array at the stream's
 *    own aspect (Camera2 crops every output stream that way; a 16:9 preview of
 *    a 4:3 sensor keeps the full long edge and gives up the short one). So the
 *    centre crop of the still at the preview's aspect *is* the preview's field
 *    of view, at the still's resolution.
 *
 * Anything else — a driver that answered some other size of another shape — is
 * a field of view nobody can vouch for (a 2.14:1 photo against a 16:9 preview
 * has *lost* part of the short edge), and the preview frame is used instead.
 * Stabilization can still make the preview a little tighter than the still;
 * the still registration (`lib/still-register.ts`) measures that afterwards
 * and the confirm screen asks for a closer look when it matters.
 *
 * `requested` is in the driver's (sensor) orientation; `still` is upright, so
 * sizes are compared long edge to long edge.
 */
export function stillCropFor(
  still: { width: number; height: number },
  requested: PhotoSizeChoice | null,
  previewAspect: number | null,
): StillFit {
  const { width, height } = still;
  const whole: StillFit = { crop: { x: 0, y: 0, width, height }, basis: "whole" };
  if (previewAspect === null || !Number.isFinite(previewAspect) || previewAspect <= 0) return whole;
  const stillAspect = width / height;
  if (quadTransfers(previewAspect, stillAspect)) return whole;
  // Portrait against landscape (neither square): the EXIF turn was not honoured.
  const squarePreview = sameSize(previewAspect, 1);
  const squareStill = sameSize(stillAspect, 1);
  if (!squarePreview && !squareStill && previewAspect < 1 !== stillAspect < 1) {
    return { reason: "orientation-mismatch" };
  }
  const native =
    requested !== null &&
    sameSize(Math.max(width, height), Math.max(requested.imageWidth, requested.imageHeight)) &&
    sameSize(Math.min(width, height), Math.min(requested.imageWidth, requested.imageHeight));
  if (!native) return { reason: "aspect-mismatch" };
  // The largest rectangle of the preview's shape, centred.
  if (stillAspect > previewAspect) {
    const cropWidth = Math.max(1, Math.round(height * previewAspect));
    return {
      crop: { x: Math.floor((width - cropWidth) / 2), y: 0, width: cropWidth, height },
      basis: "sensor-crop",
    };
  }
  const cropHeight = Math.max(1, Math.round(width / previewAspect));
  return {
    crop: { x: 0, y: Math.floor((height - cropHeight) / 2), width, height: cropHeight },
    basis: "sensor-crop",
  };
}

export interface StillPhotoOptions {
  budgetMs?: number;
}

/** One still attempt, whatever became of it. */
export interface StillOutcome {
  /** The photo, upright; the caller's to `close()`. Null when there is none. */
  bitmap: ImageBitmap | null;
  /** Why there is no photo; null when there is one. */
  reason: StillFallbackReason | null;
  /** What `takePhoto` was asked for (sensor orientation), when it was asked for a size. */
  requested: PhotoSizeChoice | null;
  /** From the call to the answer (or to giving up). */
  ms: number;
}

/**
 * A still that arrived but could not become the page.
 *
 * The bitmap decoded and then the capture canvas would not allocate — the
 * caller's own last step. It cost the full budget plus a full-resolution decode
 * and would cost both again on the next page, so it counts against the two
 * strikes exactly like a driver that never answered.
 */
export function noteStillFailure(): void {
  failures = nextFailureCount(failures);
  lastStillOk = false;
}

/** Test/dev hook: forget this session's failures. */
export function resetStillCapturePolicy(): void {
  failures = 0;
  underlyingFlight = null;
  lastStillOk = null;
}

/** How many stills have failed this session — for the debug panel and tests. */
export function stillCaptureFailures(): number {
  return failures;
}

/**
 * Still attempts that reached the camera this page load, numbered for the
 * bench's probe (`lib/probe.ts`) — counted only while something listens, so a
 * build without the probe never touches it.
 */
let stillCalls = 0;

/** The attempt the latest {@link takeStillPhoto} made, `null` when none reached the camera. */
let lastAttempt: number | null = null;

/**
 * Which still attempt the most recent {@link takeStillPhoto} made — the id its
 * `still-call` probe event carried — for the capture's own probe event.
 * Always `null` when nothing is listening.
 */
export function lastStillAttempt(): number | null {
  return lastAttempt;
}

/**
 * `lib.dom` declares `ImageCapture` unconditionally; Firefox and Safari do not
 * ship it. The `typeof` check is the only thing standing between the two.
 */
function imageCaptureConstructor(): typeof ImageCapture | null {
  return typeof ImageCapture === "function" ? ImageCapture : null;
}

/** What one driver call came to, before the budget race. */
interface StillAnswer {
  bitmap: ImageBitmap | null;
  reason: "take-failed" | "decode-failed" | null;
  requested: PhotoSizeChoice | null;
}

/**
 * One attempt, end to end. Never rejects: a rejection here would reach the
 * shutter as an error the user has no use for, when the preview frame is
 * sitting right there. `onRequest` hears the size asked for the moment it is
 * known, so a timed-out attempt can still report it.
 */
async function decodeStill(
  capture: ImageCapture,
  onRequest: (requested: PhotoSizeChoice | null) => void,
): Promise<StillAnswer> {
  let settings: PhotoSizeChoice | null = null;
  try {
    // Typed as `PhotoCapabilities`, narrowed as `unknown`: every field of it
    // is optional in the spec and drivers answer with less than that.
    const capabilities: unknown = await capture.getPhotoCapabilities();
    settings = pickPhotoSize(
      readPhotoSizeRange(capabilities, "imageWidth"),
      readPhotoSizeRange(capabilities, "imageHeight"),
    );
  } catch {
    // Capabilities are a nicety; the default photo size is still a photo.
    settings = null;
  }
  onRequest(settings);
  let photo: unknown;
  try {
    if (probing()) {
      // Synchronously before the call: whatever answers it (the bench's fake
      // camera) learns which attempt it is answering.
      stillCalls += 1;
      probe({ type: "still-call", t: performance.now(), attempt: stillCalls });
    }
    photo = settings === null ? await capture.takePhoto() : await capture.takePhoto(settings);
  } catch {
    return { bitmap: null, reason: "take-failed", requested: settings };
  }
  if (!(photo instanceof Blob) || photo.size === 0) {
    return { bitmap: null, reason: "take-failed", requested: settings };
  }
  try {
    // EXIF is baked in here, once, so the rest of the app can take the pixels
    // as they are — the same contract `prepareCapture` holds for picked files.
    // No resize: the photo is decoded at every pixel it has.
    const bitmap = await createImageBitmap(photo, { imageOrientation: "from-image" });
    if (bitmap.width === 0 || bitmap.height === 0) {
      bitmap.close();
      return { bitmap: null, reason: "decode-failed", requested: settings };
    }
    return { bitmap, reason: null, requested: settings };
  } catch {
    return { bitmap: null, reason: "decode-failed", requested: settings };
  }
}

/** The budget race. A photo that arrives after the bell is closed, not kept. */
async function withBudget(
  work: Promise<StillAnswer>,
  budgetMs: number,
): Promise<StillAnswer | null> {
  let timer = 0;
  const expiry = new Promise<null>((resolve) => {
    timer = window.setTimeout(() => resolve(null), budgetMs);
  });
  const winner = await Promise.race([work, expiry]);
  window.clearTimeout(timer);
  if (winner === null) {
    void work.then((late) => late.bitmap?.close()).catch(() => undefined);
  }
  return winner;
}

/**
 * A still photo of what the camera is pointing at — at the camera's full
 * photo resolution — or the reason there is none, in which case the caller
 * uses the preview frame at the stream's native size.
 *
 * The returned bitmap belongs to the caller, who must `close()` it as soon as
 * it has been drawn — a full-resolution photo is tens of megabytes and this
 * runs on phones that have a few hundred.
 */
export async function takeStillPhoto(
  track: MediaStreamTrack | null,
  options: StillPhotoOptions = {},
): Promise<StillOutcome> {
  const started = performance.now();
  const callsBefore = stillCalls;
  const answer = await attemptStill(track, options);
  const outcome: StillOutcome = { ...answer, ms: performance.now() - started };
  if (probing()) {
    // Attempts never overlap (the flight latch), so a call counted while this
    // one was awaited is this one's.
    lastAttempt = stillCalls > callsBefore ? stillCalls : null;
    probe({
      type: "still",
      t: started,
      ms: outcome.ms,
      ok: outcome.bitmap !== null,
      width: outcome.bitmap?.width ?? null,
      height: outcome.bitmap?.height ?? null,
      failures,
      attempt: lastAttempt,
    });
  }
  return outcome;
}

async function attemptStill(
  track: MediaStreamTrack | null,
  { budgetMs = STILL_CAPTURE_BUDGET_MS }: StillPhotoOptions,
): Promise<Omit<StillOutcome, "ms">> {
  const none = (reason: StillFallbackReason): Omit<StillOutcome, "ms"> => ({
    bitmap: null,
    reason,
    requested: null,
  });
  if (track === null || track.readyState !== "live") return none("no-track");
  if (typeof createImageBitmap !== "function") return none("unsupported");
  const constructor = imageCaptureConstructor();
  if (constructor === null) return none("unsupported");
  if (underlyingFlight !== null) return none("busy");
  if (!stillAttemptsAllowed(failures, false)) return none("gave-up");

  let capture: ImageCapture;
  try {
    capture = new constructor(track);
  } catch {
    // Some drivers throw at construction for a track they cannot photograph.
    noteStillFailure();
    return none("construct-failed");
  }

  // `decodeStill` never rejects, so settlement is the only thing that clears
  // the latch — and it is cleared by identity, so a stale attempt cannot free a
  // slot a newer one is holding.
  let requested: PhotoSizeChoice | null = null;
  const work = decodeStill(capture, (asked) => {
    requested = asked;
  });
  const flight = work.then((answer) => answer.bitmap);
  underlyingFlight = flight;
  void flight.then(() => {
    if (underlyingFlight === flight) underlyingFlight = null;
  });

  const answer = await withBudget(work, budgetMs);
  if (answer === null) {
    noteStillFailure();
    return { bitmap: null, reason: "timeout", requested };
  }
  if (answer.bitmap === null) noteStillFailure();
  return answer;
}
