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
 * every path here converges on the same fallback answer — `null`, meaning "use
 * the preview frame, exactly as before".
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
 * The largest photo this camera supports that still fits the page grid —
 * and, when the caller says what shape the preview is, that still fits the
 * **preview's field of view**.
 *
 * Asking for the sensor's full 12 MP would hand a cheap phone a 4000×3000 JPEG
 * to decode and then immediately throw three quarters of away — the canonical
 * is capped at `MAX_LONG_EDGE` regardless. So the request is scaled down to the
 * target long edge when the sensor exceeds it, and left at the maximum when it
 * does not.
 *
 * `previewAspect` is the shape of the stream the user composed against.
 * A 4:3 still against a 16:9 preview is a *wider* photo than the one
 * the user framed: the page they filled the viewfinder with arrives small and
 * off in a scene they never saw, which is what broke both the corner transfer
 * and the coverage gate in the field. When the aspect is given, the sensor's
 * maximum is first cropped to that shape — orientation-agnostically, since the
 * driver speaks sensor orientation and the preview may be portrait — and the
 * scaling runs on the cropped rectangle. When it is not given, the behaviour
 * is exactly what it always was.
 *
 * Returns `null` when the capabilities say nothing usable; the caller then
 * takes the photo without settings, which is a photo all the same. The answer
 * is a *request*: drivers are free to return something else, which is exactly
 * why geometry measured before the photo may only be reused after it once
 * {@link quadTransfers} has checked the shape that came back — and why the
 * capture path discards a still whose shape does not match the preview at all.
 */
export function pickPhotoSize(
  width: PhotoSizeRange | null,
  height: PhotoSizeRange | null,
  longEdgeTarget: number,
  previewAspect: number | null = null,
): PhotoSizeChoice | null {
  if (width === null || height === null) return null;
  if (!Number.isFinite(longEdgeTarget) || longEdgeTarget <= 0) return null;
  let maxWidth = width.max;
  let maxHeight = height.max;
  if (
    previewAspect !== null &&
    Number.isFinite(previewAspect) &&
    previewAspect > 0 &&
    maxWidth > 0 &&
    maxHeight > 0
  ) {
    // Long-over-short, so a portrait preview asks for the same crop as its
    // landscape twin — the sensor's axes, not the screen's, decide which
    // dimension carries the long edge.
    const ratio = Math.max(previewAspect, 1 / previewAspect);
    const long = Math.max(maxWidth, maxHeight);
    const short = Math.min(maxWidth, maxHeight);
    let cropLong = long;
    let cropShort = long / ratio;
    if (cropShort > short) {
      cropShort = short;
      cropLong = short * ratio;
    }
    if (maxWidth >= maxHeight) {
      maxWidth = cropLong;
      maxHeight = cropShort;
    } else {
      maxWidth = cropShort;
      maxHeight = cropLong;
    }
  }
  const maxLongEdge = Math.max(maxWidth, maxHeight);
  if (maxLongEdge <= 0) return null;
  const scale = maxLongEdge <= longEdgeTarget ? 1 : longEdgeTarget / maxLongEdge;
  const imageWidth = snapDown(Math.round(maxWidth * scale), width);
  const imageHeight = snapDown(Math.round(maxHeight * scale), height);
  if (imageWidth <= 0 || imageHeight <= 0) return null;
  return { imageWidth, imageHeight };
}

export interface StillPhotoOptions {
  /** The long edge the canonical will be capped to anyway. */
  longEdgeTarget: number;
  /**
   * The preview stream's `videoWidth / videoHeight` — the shape the user is
   * composing against. Passed down to {@link pickPhotoSize} so the still is
   * *requested* at the preview's field of view rather than the sensor's.
   */
  previewAspect?: number | null;
  budgetMs?: number;
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
}

/** Test/dev hook: forget this session's failures. */
export function resetStillCapturePolicy(): void {
  failures = 0;
  underlyingFlight = null;
}

/** How many stills have failed this session — for the debug panel and tests. */
export function stillCaptureFailures(): number {
  return failures;
}

/**
 * `lib.dom` declares `ImageCapture` unconditionally; Firefox and Safari do not
 * ship it. The `typeof` check is the only thing standing between the two.
 */
function imageCaptureConstructor(): typeof ImageCapture | null {
  return typeof ImageCapture === "function" ? ImageCapture : null;
}

/**
 * One attempt, end to end, resolving `null` for every kind of "no photo".
 * Never rejects: a rejection here would reach the shutter as an error the user
 * has no use for, when the preview frame is sitting right there.
 */
async function decodeStill(
  capture: ImageCapture,
  longEdgeTarget: number,
  previewAspect: number | null,
): Promise<ImageBitmap | null> {
  try {
    let settings: PhotoSizeChoice | undefined;
    try {
      // Typed as `PhotoCapabilities`, narrowed as `unknown`: every field of it
      // is optional in the spec and drivers answer with less than that.
      const capabilities: unknown = await capture.getPhotoCapabilities();
      settings =
        pickPhotoSize(
          readPhotoSizeRange(capabilities, "imageWidth"),
          readPhotoSizeRange(capabilities, "imageHeight"),
          longEdgeTarget,
          previewAspect,
        ) ?? undefined;
    } catch {
      // Capabilities are a nicety; the default photo size is still a photo.
      settings = undefined;
    }
    const photo: unknown =
      settings === undefined
        ? await capture.takePhoto()
        : await capture.takePhoto(settings);
    if (!(photo instanceof Blob) || photo.size === 0) return null;
    // EXIF is baked in here, once, so the rest of the app can take the pixels
    // as they are — the same contract `prepareCapture` holds for picked files.
    const bitmap = await createImageBitmap(photo, {
      imageOrientation: "from-image",
    });
    if (bitmap.width === 0 || bitmap.height === 0) {
      bitmap.close();
      return null;
    }
    return bitmap;
  } catch {
    return null;
  }
}

/** The budget race. A photo that arrives after the bell is closed, not kept. */
async function withBudget(
  work: Promise<ImageBitmap | null>,
  budgetMs: number,
): Promise<ImageBitmap | null> {
  let timer = 0;
  const expiry = new Promise<null>((resolve) => {
    timer = window.setTimeout(() => resolve(null), budgetMs);
  });
  const winner = await Promise.race([work, expiry]);
  window.clearTimeout(timer);
  if (winner === null) {
    void work.then((late) => late?.close()).catch(() => undefined);
  }
  return winner;
}

/**
 * A still photo of what the camera is pointing at, or `null` to use the frame.
 *
 * The returned bitmap belongs to the caller, who must `close()` it as soon as
 * it has been drawn — a full-resolution photo is tens of megabytes and this
 * runs on phones that have a few hundred.
 */
export async function takeStillPhoto(
  track: MediaStreamTrack | null,
  {
    longEdgeTarget,
    previewAspect = null,
    budgetMs = STILL_CAPTURE_BUDGET_MS,
  }: StillPhotoOptions,
): Promise<ImageBitmap | null> {
  if (!stillAttemptsAllowed(failures, underlyingFlight !== null)) return null;
  if (track === null || track.readyState !== "live") return null;
  if (typeof createImageBitmap !== "function") return null;
  const constructor = imageCaptureConstructor();
  if (constructor === null) return null;

  let capture: ImageCapture;
  try {
    capture = new constructor(track);
  } catch {
    // Some drivers throw at construction for a track they cannot photograph.
    failures = nextFailureCount(failures);
    return null;
  }

  // `decodeStill` never rejects, so settlement is the only thing that clears
  // the latch — and it is cleared by identity, so a stale attempt cannot free a
  // slot a newer one is holding.
  const work = decodeStill(capture, longEdgeTarget, previewAspect);
  underlyingFlight = work;
  void work.then(() => {
    if (underlyingFlight === work) underlyingFlight = null;
  });

  const bitmap = await withBudget(work, budgetMs);
  if (bitmap === null) failures = nextFailureCount(failures);
  return bitmap;
}
