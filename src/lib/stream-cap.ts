"use client";

/**
 * The live preview's resolution cap — a cheaper viewfinder, never a cheaper page.
 *
 * The camera is opened at 4K (3840×2160) so that a page made of the preview
 * frame is made of every pixel the phone can stream. The live loop does not
 * need them: it samples a few hundred pixels a side, and every 4K frame costs
 * the decoder, the compositor and each sample's downscale. So on Android
 * Chrome the stream may be lowered to {@link STREAM_CAP_LONG_EDGE} — but
 * **only while the page is known to come from the still pipeline**, i.e. while
 * `ImageCapture.takePhoto()` is proven on this device
 * (`stillPipelineWorking`, `lib/still-capture.ts`): a still this session
 * became a page, and none has failed since.
 *
 * Proven, not merely present: the first page of a session is always taken on
 * the native stream, so a phone whose `takePhoto` turns out to be broken never
 * had its fallback frame lowered in the first place. Never on iOS/iPadOS
 * (there is no `ImageCapture`; the preview frame IS the page), never where
 * `ImageCapture` is missing, and never once a still has failed.
 *
 * And when a still fails on a capped stream anyway, the fallback is not the
 * capped frame: the capture restores the native stream and takes the frame
 * at full size ({@link STREAM_RESTORE_BUDGET_MS}). Only if the camera will not
 * come back up in time is the capped frame used — and then the page is
 * flagged (`low-resolution`) and the reason reported, never handed over
 * silently. Restoring was chosen over flag-only because it keeps the
 * guarantee the rest of this change makes — the page is the camera's full
 * resolution — at the cost of up to a second more on a capture that is
 * already the rare, failed one.
 *
 * Decisions are pure and unit-tested; only `applyConstraints` touches the device.
 *
 * **Off ({@link STREAM_CAP_ENABLED}).** The owner's field run on a Galaxy S25
 * Ultra (2026-10-02) showed the capped mode is not a smaller copy of the
 * native one: the 1080×1920 stream sees a field of view ~1.26× tighter (the
 * still registered against it at `fovScale` 1.256 and 1.275, against 1.006 on
 * the native stream), so the page the person framed is ~20 % smaller in the
 * photo than on screen — the very pixels "Aproxime" asks for — and from the
 * cap on the live loop found no page at all for the rest of the session,
 * while the photo's own detection found it every time. The live loop itself
 * handles a stream that changes size and field of view
 * (`npm run bench:quality -- --case cap-fov`, which forces the cap on), so
 * what failed is the device's capped mode, which the library cannot see
 * into. Until a capped stream is proven to keep the native field of view and
 * the detection on a device, the stream stays native: the decision answers
 * `disabled` on every device, and the restore path below never has anything
 * to restore.
 */

/**
 * Whether the cap may be applied at all. Off: see the module comment. The
 * decision, the restore and their telemetry stay, so turning it back on is
 * this constant (and the field proof that should come with it).
 */
export const STREAM_CAP_ENABLED = false;

/** Bench builds only: `globalThis.__scanBenchStreamCap = true` turns the cap on to prove the live loop survives it. */
interface StreamCapBench {
  __SCAN_PROBE_BUILD__?: boolean;
  __scanBenchStreamCap?: boolean;
}

/** {@link STREAM_CAP_ENABLED}, or — in the bench's build only — the bench asking for the cap. */
export function streamCapEnabled(): boolean {
  BENCH_PROBE: if ((globalThis as StreamCapBench).__SCAN_PROBE_BUILD__ === true) {
    if ((globalThis as StreamCapBench).__scanBenchStreamCap === true) return true;
  }
  return STREAM_CAP_ENABLED;
}

/** Long edge of the capped preview stream. */
export const STREAM_CAP_LONG_EDGE = 1920;

/** The stream the camera is opened at (landscape terms, as the constraints speak). */
export const NATIVE_STREAM = { width: 3840, height: 2160 } as const;

/** The capped stream, in the same terms. */
export const CAPPED_STREAM = { width: 1920, height: 1080 } as const;

/**
 * How long a failed still may wait for the native stream to come back before
 * the capped frame is used (flagged). A camera reconfigure on Android takes a
 * few hundred milliseconds; this is spent under the shutter's feedback.
 */
export const STREAM_RESTORE_BUDGET_MS = 2000;

/** Why the stream is, or is not, capped. */
export type StreamCapReason =
  /** The cap is switched off for every device ({@link STREAM_CAP_ENABLED}). */
  | "disabled"
  /** Capped: a still became a page and none has failed since. */
  | "still-proven"
  /** Not Android Chrome (iOS WebKit, desktop, Firefox): the preview frame may be the page. */
  | "not-android"
  /** No `ImageCapture`: the preview frame is the page. */
  | "no-image-capture"
  /** No still has become a page yet this session. */
  | "still-unproven"
  /** A still failed: the preview frame may be the next page. */
  | "still-failed"
  /** The stream is already at or under the cap. */
  | "stream-small"
  /** The camera refused the constraints. */
  | "constraints-failed";

export interface StreamCapInputs {
  /** {@link streamCapEnabled}: the cap may be applied at all. */
  enabled: boolean;
  /** Android (Chrome's `ImageCapture` is where the still pipeline lives). */
  android: boolean;
  /** `ImageCapture` exists. */
  imageCapture: boolean;
  /** `stillPipelineWorking()`: the last still became a page and the session has not given up. */
  stillWorking: boolean;
  /** Whether any still has been attempted and failed since the last success. */
  stillFailed: boolean;
  /** The live stream's long edge right now (0 when unknown). */
  streamLongEdge: number;
  /** Whether the stream is capped right now. */
  capped: boolean;
}

/**
 * Should the live stream be capped? `cap: true` only on Android Chrome with a
 * proven still pipeline and a stream larger than the cap (or already capped).
 */
export function streamCapDecision(inputs: StreamCapInputs): { cap: boolean; reason: StreamCapReason } {
  if (!inputs.enabled) return { cap: false, reason: "disabled" };
  if (!inputs.android) return { cap: false, reason: "not-android" };
  if (!inputs.imageCapture) return { cap: false, reason: "no-image-capture" };
  if (!inputs.stillWorking) return { cap: false, reason: inputs.stillFailed ? "still-failed" : "still-unproven" };
  if (!inputs.capped && inputs.streamLongEdge > 0 && inputs.streamLongEdge <= STREAM_CAP_LONG_EDGE) {
    return { cap: false, reason: "stream-small" };
  }
  return { cap: true, reason: "still-proven" };
}

/** Whether this browser is Android (Chrome is the one with `ImageCapture` there). */
export function isAndroid(): boolean {
  return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent ?? "");
}

/** Whether `ImageCapture` exists here. */
export function hasImageCapture(): boolean {
  return typeof ImageCapture === "function";
}

/** Ask the track for `size` (ideal, so a camera without that exact mode picks its nearest). */
export async function applyStreamSize(
  track: MediaStreamTrack,
  size: { width: number; height: number },
): Promise<boolean> {
  try {
    await track.applyConstraints({ width: { ideal: size.width }, height: { ideal: size.height } });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve once the `<video>` shows a frame whose long edge is more than the
 * cap (the native stream is back), or `false` after `budgetMs`.
 */
export function waitForNativeFrame(video: HTMLVideoElement, budgetMs: number): Promise<boolean> {
  const big = () => Math.max(video.videoWidth, video.videoHeight) > STREAM_CAP_LONG_EDGE;
  if (big()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      window.clearInterval(poll);
      video.removeEventListener("resize", check);
      resolve(ok);
    };
    const check = () => {
      if (big()) finish(true);
    };
    const timer = window.setTimeout(() => finish(big()), budgetMs);
    const poll = window.setInterval(check, 50);
    video.addEventListener("resize", check);
  });
}
