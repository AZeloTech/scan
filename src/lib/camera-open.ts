/**
 * Opening the camera: a short ladder of requests, each with a deadline.
 *
 * One `getUserMedia` call asking for a 4K back camera is the right first ask
 * — the live loop and the still pipeline both want every pixel the sensor
 * offers — but it is not a safe *only* ask. Older Android phones hang on it:
 * the promise neither resolves nor rejects for many seconds, then rejects with
 * `NotReadableError` or `AbortError` ("Timeout starting video source"). With
 * no deadline the screen sat on «Abrindo a câmera…» for that whole time, and
 * the rejection was then reported as a refusal the person never made.
 *
 * So each step races a deadline, and a step that times out or fails for a
 * reason that is about the *request* (an unreadable source, an abort, an
 * over-constrained ask, a malformed one) falls through to a plainer ask. Only
 * two outcomes stop the ladder early: a refusal (`NotAllowedError`,
 * `SecurityError`) — asking again would only ask the person again — and no
 * device at all (`NotFoundError`), which a plainer ask cannot conjure.
 *
 * The deadline is armed only once the browser says the permission is
 * granted: a person reading the system prompt is not a hung camera. Where the
 * browser cannot say (no `permissions.query` for cameras), a longer deadline
 * stands in for it.
 *
 * DOM-free apart from the types, so it runs under `node --test` with a fake
 * `getUserMedia` and fake timers.
 */

/** One rung: what to ask for, and how long the ask may take once granted. */
export interface CameraRequest {
  readonly constraints: MediaStreamConstraints;
  readonly timeoutMs: number;
}

/** The deadline for one rung, once the permission is known granted. */
export const CAMERA_ATTEMPT_TIMEOUT_MS = 8_000;
/** The deadline when the browser cannot say whether the prompt was answered. */
export const CAMERA_UNKNOWN_PERMISSION_TIMEOUT_MS = 30_000;
/** How long `video.play()` may take before the stream is judged on its frame. */
export const VIDEO_PLAY_TIMEOUT_MS = 5_000;

/**
 * The ladder: the full ask, the back camera at whatever size it gives, and
 * any camera at all.
 */
export const CAMERA_LADDER: readonly CameraRequest[] = [
  {
    constraints: {
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 3840 },
        height: { ideal: 2160 },
      },
      audio: false,
    },
    timeoutMs: CAMERA_ATTEMPT_TIMEOUT_MS,
  },
  {
    constraints: { video: { facingMode: { ideal: "environment" } }, audio: false },
    timeoutMs: CAMERA_ATTEMPT_TIMEOUT_MS,
  },
  { constraints: { video: true, audio: false }, timeoutMs: CAMERA_ATTEMPT_TIMEOUT_MS },
];

/** Why the camera did not open, in the public error vocabulary. */
export type CameraOpenFailure = "camera_denied" | "no_camera" | "camera_unavailable";

export type CameraOpenResult =
  | { readonly kind: "live"; readonly stream: MediaStream; readonly attempt: number }
  | { readonly kind: "failed"; readonly code: CameraOpenFailure; readonly attempt: number }
  /** The caller gave up (unmounted) while a request was in flight. */
  | { readonly kind: "cancelled" };

/**
 * What the permission is known to be, for arming the deadline:
 *
 *  * `granted` — arm it now;
 *  * `unknown` — the browser cannot say; arm the longer one now.
 *
 * A pending prompt is a promise that has not settled yet: it settles with
 * `granted` when the person allows, and never on a refusal (the request then
 * rejects on its own and the ladder stops).
 */
export type PermissionReading = "granted" | "unknown";

export interface CameraOpenOptions {
  readonly getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  /** Settles when the deadline may be armed. Default: arm at once, as `granted`. */
  readonly whenGranted?: () => Promise<PermissionReading>;
  readonly ladder?: readonly CameraRequest[];
  /** Called before each rung, with its index (0 is the first ask). */
  readonly onAttempt?: (attempt: number) => void;
  /** True once the caller no longer wants a stream. Checked between rungs. */
  readonly isCancelled?: () => boolean;
}

/** Stop every track of a stream nobody is going to use. */
export function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

/** The rejection's `name`, from a `DOMException` or anything shaped like one. */
function errorName(error: unknown): string {
  if (typeof error === "object" && error !== null && "name" in error) {
    const name = (error as { name: unknown }).name;
    return typeof name === "string" ? name : "";
  }
  return "";
}

/**
 * What a rejection means for the ladder: stop with a code, or try the next
 * rung. Everything not named here is about the request (or unknown) and
 * gets the plainer ask.
 */
export function classifyCameraError(error: unknown): "camera_denied" | "no_camera" | "retry" {
  const name = errorName(error);
  // `PermissionDeniedError` is the pre-standard Chromium name for the same fact.
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
    return "camera_denied";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") return "no_camera";
  return "retry";
}

const TIMED_OUT: unique symbol = Symbol("timed-out");

/**
 * One rung: the request raced against its deadline, armed once permission
 * allows. A stream that arrives after the deadline is stopped — nobody holds
 * it, and a camera left open keeps the light on and the device busy for the
 * next rung.
 */
async function attempt(
  options: CameraOpenOptions,
  request: CameraRequest,
): Promise<MediaStream | typeof TIMED_OUT> {
  let settled = false;
  const pending = options.getUserMedia(request.constraints).then<MediaStream, typeof TIMED_OUT>(
    (stream) => {
      if (settled) stopStream(stream);
      return stream;
    },
    (error: unknown) => {
      if (settled) return TIMED_OUT; // a late refusal of a request we gave up on
      throw error;
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    const arm = (reading: PermissionReading): void => {
      if (settled) return;
      const ms = reading === "granted" ? request.timeoutMs : Math.max(request.timeoutMs, CAMERA_UNKNOWN_PERMISSION_TIMEOUT_MS);
      timer = setTimeout(() => resolve(TIMED_OUT), ms);
    };
    const reading = options.whenGranted?.() ?? Promise.resolve<PermissionReading>("granted");
    reading.then(arm, () => arm("unknown"));
  });
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Walk the ladder until a rung yields a stream or a rejection that ends it.
 * Never throws.
 */
export async function openCamera(options: CameraOpenOptions): Promise<CameraOpenResult> {
  const ladder = options.ladder ?? CAMERA_LADDER;
  for (let index = 0; index < ladder.length; index += 1) {
    if (options.isCancelled?.()) return { kind: "cancelled" };
    options.onAttempt?.(index);
    let outcome: MediaStream | typeof TIMED_OUT;
    try {
      outcome = await attempt(options, ladder[index]!);
    } catch (error) {
      const verdict = classifyCameraError(error);
      if (verdict !== "retry") return { kind: "failed", code: verdict, attempt: index };
      continue;
    }
    if (outcome === TIMED_OUT) continue;
    if (options.isCancelled?.()) {
      stopStream(outcome);
      return { kind: "cancelled" };
    }
    return { kind: "live", stream: outcome, attempt: index };
  }
  return { kind: "failed", code: "camera_unavailable", attempt: ladder.length - 1 };
}

/** The slice of a `<video>` that starting playback needs. */
export interface PlayableVideo {
  play(): Promise<void>;
  readonly videoWidth: number;
}

/**
 * Start playback, with a deadline. `true` when the stream can be shown:
 * playback started, playback was refused (autoplay — a frame still arrives
 * after a gesture), or playback hung but a frame is already there. `false`
 * only when it hung with no frame at all — a stream that delivers nothing.
 */
export async function startPlayback(video: PlayableVideo, timeoutMs = VIDEO_PLAY_TIMEOUT_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  let played: Promise<"played" | "refused">;
  try {
    played = video.play().then(
      () => "played" as const,
      () => "refused" as const,
    );
  } catch {
    played = Promise.resolve("refused" as const);
  }
  try {
    const outcome = await Promise.race([played, deadline]);
    if (outcome !== TIMED_OUT) return true;
    return video.videoWidth > 0;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The slice of `navigator` the permission reading needs. */
export interface PermissionsHost {
  readonly permissions?: {
    query(descriptor: { name: PermissionName }): Promise<{
      readonly state: PermissionState;
      addEventListener?(type: "change", listener: () => void): void;
      removeEventListener?(type: "change", listener: () => void): void;
    }>;
  };
}

/**
 * The browser's {@link CameraOpenOptions.whenGranted}: `granted` at once when
 * the camera is already allowed, `granted` later when a pending prompt is
 * answered yes, `unknown` when the browser cannot say (or says denied). A
 * prompt answered no never settles it — the request rejects with
 * `NotAllowedError` instead.
 */
export function cameraPermissionWatcher(host: PermissionsHost): () => Promise<PermissionReading> {
  return async () => {
    const permissions = host.permissions;
    if (permissions === undefined || typeof permissions.query !== "function") return "unknown";
    let status: Awaited<ReturnType<NonNullable<PermissionsHost["permissions"]>["query"]>>;
    try {
      // `camera` is not in TypeScript's `PermissionName` union; Chromium implements it.
      status = await permissions.query({ name: "camera" as PermissionName });
    } catch {
      return "unknown";
    }
    if (status.state === "granted") return "granted";
    // A stored refusal normally makes the request reject at once; if it does
    // not (the setting changed under us), the longer deadline still ends it.
    if (status.state === "denied") return "unknown";
    if (typeof status.addEventListener !== "function") return "unknown";
    return new Promise<PermissionReading>((resolve) => {
      const onChange = (): void => {
        if (status.state !== "granted") return;
        status.removeEventListener?.("change", onChange);
        resolve("granted");
      };
      status.addEventListener!("change", onChange);
    });
  };
}
