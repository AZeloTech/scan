"use client";

import * as React from "react";
import clsx from "clsx";
import {
  ACCEPT_ATTRIBUTE,
  bitmapToCanvas,
  encodeCanvas,
  frameToCanvas,
  ImagePrepError,
  MAX_LONG_EDGE,
  releaseCanvas,
} from "@/lib/image";
import {
  liveQuadFreshAtTap,
  liveQuadSurvives,
  noteStillFailure,
  quadTransfers,
  resolveCaptureCorners,
  takeStillPhoto,
} from "@/lib/still-capture";
import {
  detectInCanvas,
  isMlDetectionReady,
  waitForMlIdle,
  type QuadDetection,
} from "@/lib/flatten";
import { prefetchDewarpAssets } from "@/lib/dewarp/prefetch";
import { connectionKind, shouldPrefetchHeavyAssets } from "@/lib/network";
import { captureFromFile, type Capture, type CapturePath } from "@/lib/capture-intake";
import { HINT_SAMPLE_WIDTH, readFrame, type FrameHint } from "@/lib/hints";
import { assessSource, type GateReading } from "@/lib/capture-gate";
import { type NormalizedQuad } from "@/lib/quad";
import { flash, shutterPulse } from "@/lib/motion";
import { useLiveDetect } from "@/hooks/useLiveDetect";
import { useAssetUrls, useScanRuntime } from "@/hooks/useScanRuntime";
import { useCopy } from "@/components/I18n";
import { CameraIcon, ImageIcon, SpinnerIcon } from "@/components/icons";
import {
  CameraActionBar,
  CameraPill,
  CameraPillSpacer,
  CameraShutter,
} from "@/components/CameraActionBar";
import { Chip, LiveRegion, Meta, Notice } from "@/components/ui";

export type { Capture } from "@/lib/capture-intake";

/**
 * The capture surface — the product. It always fills whatever height the shell
 * gives it, in two flavours behind one screen:
 *
 *  - **live** (localhost / HTTPS): the camera fills the surface edge to edge,
 *    scanic tracks the page inside it (`useLiveDetect`) and marks the corners
 *    it found — four brackets, and nothing joining them, the way a phone
 *    camera marks a face. Mono chips float over the top, and the shutter sits
 *    in a control row under the frame where a camera app puts it. The photo is
 *    taken by the shutter or by a tap anywhere on the frame, and by nothing
 *    else — see the capture note below.
 *  - **fallback** (a phone hitting the demo over plain HTTP, or a denied
 *    permission): the ENTIRE surface becomes one tappable label wrapping the
 *    hidden `<input capture>`. A dashed mist outline on night, a big camera
 *    glyph, and the page number — it reads as a place to put a photo, which is
 *    exactly what it is. Never a dead dark box with a small button under it.
 *
 * **Capture is manual, always.** The person holding the phone decides when the
 * picture is taken: the shutter and the frame tap are the only two things that
 * fire it, and there is no arming, no countdown and no switch. Detection is
 * what finds the corners the capture travels with and what the chips report —
 * it never *acts*.
 *
 * **The frame never changes size.** Everything transient this screen has to say
 * — the chips, the tap caption, the stuck-detector tip, an error — is drawn
 * *over* the frame, absolutely positioned at its top or foot.
 * Nothing conditional is allowed to live between the frame and the control row,
 * because a box that appears there resizes the viewfinder while the user is
 * aiming through it, and a viewfinder that jumps mid-aim is the app moving the
 * page out from under them. The only thing under the frame is the rail the
 * screen slots in (`children`) and the control row, both of which are there on
 * every render. It is also what keeps the quad honest: `useLiveDetect` measures
 * the stage element, so a stage that cannot resize is an overlay that cannot
 * drift off the page it is drawn around.
 *
 * Live detection is a *bonus layer*: on a device too slow for it the hook
 * switches itself off, the corner brackets come back, and the screen behaves
 * exactly as it did before the feature existed. The still photo
 * (`lib/still-capture.ts`) is the same kind of layer: when the camera can give
 * us a real photo instead of a preview frame we take it, and when it cannot the
 * capture is byte-for-byte the one this screen always made.
 */

const HINT_INTERVAL_MS = 200;

/**
 * How long the detector may search before the screen starts *helping*.
 *
 * Short enough that a user pointing at a tablecloth gets told, long enough that
 * the normal case — half a second of hunting before the quad locks on — never
 * sees a word of it. A tip box that flashes on every capture is noise.
 */
const TIP_DELAY_MS = 4000;

/**
 * How long the Wi-Fi prefetch waits for the corner detector to settle.
 *
 * The ML detector's ~2.3 MB is the download that the *viewfinder* is waiting
 * on, and it must never queue behind a 16 MB favour. So the curved-page engine
 * waits for {@link isMlDetectionReady}; the timeout is only there for the
 * devices where that never happens — a latched-off runtime, a denied camera,
 * a phone too slow — and it is generous on purpose, because being late costs
 * nothing and being early costs the user their viewfinder.
 */
const PREFETCH_WAIT_MS = 15_000;

/** How often the wait above is re-checked. Cheap: it reads one boolean. */
const PREFETCH_POLL_MS = 500;

/**
 * `requestIdleCallback` where it exists.
 *
 * Typed here rather than trusted from lib.dom, and feature-detected rather than
 * assumed: Safari shipped it only recently, and the fallback — a short timeout —
 * is close enough for a download that is already deliberately late.
 */
type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

type StageMode = "starting" | "live" | "fallback";

interface CaptureStageProps {
  onCapture: (capture: Capture) => void;
  /** "Fotografar página 3" — the fallback's title and the shutter's label. */
  captureLabel: string;
  /** 1-based number of the page about to be taken, for the announcement. */
  pageNumber: number;
  disabled?: boolean;
  /** Shown instead of the capture affordance when `disabled`. */
  disabledReason?: string;
  /** Something covers the viewfinder (a preview sheet): stop tracking. */
  paused?: boolean;
  /**
   * Whether to open the camera at all.
   *
   * False after the user chose the gallery on the permission primer: mounting
   * the viewfinder would fire `getUserMedia` and produce exactly the
   * unannounced OS prompt the primer exists to prevent. The fallback surface
   * is already a complete path to a finished PDF, and its `capture` input
   * still reaches the native camera app without any permission of ours.
   */
  useCamera?: boolean;
  /**
   * Overrides the recorded capture path. The retake sheet embeds this same
   * component, and a retake is a different population from a first capture when
   * the gate's floors are re-derived.
   */
  path?: CapturePath;
  /**
   * The control row's right-hand action — "seguir →", "cancelar". A
   * {@link CameraPill}, so it matches the gallery pill opposite it and keeps
   * the shutter on the frame's centre line.
   */
  rightAction?: React.ReactNode;
  /** Slotted between the frame and the controls: the thumbnail rail. */
  children?: React.ReactNode;
  className?: string;
}

export function CaptureStage({
  onCapture,
  captureLabel,
  pageNumber,
  disabled = false,
  disabledReason,
  paused = false,
  useCamera = true,
  path,
  rightAction,
  children,
  className,
}: CaptureStageProps) {
  const copy = useCopy();
  // The asset base the host gave the flow. Every loader below is handed it
  // explicitly rather than reading a module global: two mounts of the library
  // on one page must never race each other to a shared `wasmPaths`.
  const urls = useAssetUrls();
  const { intake, reportError } = useScanRuntime();
  // Whether there is a door left when the camera closes. Read as a boolean
  // rather than through `intake` so the effects below depend on the fact, not
  // on the identity of the object carrying it.
  const intakeImages = intake.images;

  /**
   * A photo the device could not turn into a page.
   *
   * Only `prep` reaches the host: it means a decode, a canvas allocation or an
   * encode gave up, which on the phones this runs on is almost always memory —
   * and memory is a fact the host may want to act on (fewer pages, a warning of
   * its own). `unsupported` and `camera_waking` are the person's problem to
   * retry, said on screen in their language, and would be noise out here.
   * Recoverable in every case: the viewfinder is still up and the next tap is
   * a fresh attempt.
   */
  const reportPrepFailure = React.useCallback(
    (error: unknown) => {
      if (error instanceof ImagePrepError && error.code === "prep") {
        reportError("out_of_memory", true);
      }
    },
    [reportError],
  );
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const stageRef = React.useRef<HTMLDivElement | null>(null);
  const sampleCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  /** Separate from the hint sample: the 5 fps loop owns that one. */
  const gateCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  /** The live video track, kept for the still-photo path only. */
  const trackRef = React.useRef<MediaStreamTrack | null>(null);
  const flashRef = React.useRef<HTMLDivElement | null>(null);
  const shutterRef = React.useRef<HTMLButtonElement | null>(null);
  /** The re-entrancy guard, read synchronously: `busy` state lags a fast tap. */
  const busyRef = React.useRef(false);

  const [mode, setMode] = React.useState<StageMode>("starting");
  /**
   * Whether tapping the fallback surface can only reach a file chooser.
   *
   * The surface is one control with two behaviours, decided by the platform
   * rather than by us: its input carries `capture="environment"`, which a
   * mobile browser honours by opening the camera app and a desktop browser
   * silently ignores. A field report is what that costs on a laptop —
   * a camera glyph over "Fotografar página 1" that opens a file dialog.
   *
   * The signal is `(pointer: coarse)`, and it is a proxy, not a fact: there is
   * no feature detect for "this browser ignores `capture`" (the attribute
   * parses everywhere). A primary pointer that is a finger is the closest
   * honest stand-in for the platforms that honour it, and it answers correctly
   * for the two cases that matter — a phone (coarse, camera copy kept, and a
   * denied permission there still reaches the camera app) and a laptop, with or
   * without a webcam, whose primary pointer is a mouse.
   *
   * `false` on the server and on the first client render, like every other
   * reader of a browser-only fact: the effect adopts the real answer, so a
   * static export cannot hydrate into a disagreement.
   */
  const [pickerOnly, setPickerOnly] = React.useState(false);
  React.useEffect(() => {
    setPickerOnly(!window.matchMedia("(pointer: coarse)").matches);
  }, []);
  const [cameraLost, setCameraLost] = React.useState(false);
  const [hint, setHint] = React.useState<FrameHint>("good");
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [announcement, setAnnouncement] = React.useState("");
  const [struggling, setStruggling] = React.useState(false);

  // ── camera lifecycle ──────────────────────────────────────────────────────
  React.useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;

    const handleTrackEnded = (): void => {
      trackRef.current = null;
      setCameraLost(true);
    };

    /**
     * The camera is not coming. Say so once, out loud, and carry on.
     *
     * This is not the end of the flow while the file intake is on: a photo the
     * person already took is a page like any other, and the fallback surface
     * below is exactly that door. It *is* the end when the host switched images
     * off as well, because then there is genuinely nothing left to scan with —
     * which is what `recoverable` says here, and what turns into `onCancel`
     * upstream.
     */
    const cameraUnavailable = (code: "camera_denied" | "no_camera"): void => {
      if (cancelled) return;
      setMode("fallback");
      reportError(code, intakeImages);
    };

    async function start(): Promise<void> {
      if (!useCamera) {
        // Usually not a failure at all: the host turned the camera off, or the
        // person chose the gallery on the primer, and the file surface below is
        // the whole screen. It only becomes one when there is no file intake
        // either — a configuration with no way to put paper in, which has to
        // end rather than sit there looking broken.
        setMode("fallback");
        if (!intakeImages) cameraUnavailable("no_camera");
        return;
      }
      // `mediaDevices` is typed as always-present but is genuinely absent on
      // insecure origins — the exact case this fallback exists for.
      const media: MediaDevices | undefined = navigator.mediaDevices;
      if (media === undefined || typeof media.getUserMedia !== "function") {
        cameraUnavailable("no_camera");
        return;
      }
      try {
        stream = await media.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 3840 },
            height: { ideal: 2160 },
          },
          audio: false,
        });
      } catch (error) {
        // Two different facts wearing one `catch`: a refusal (or a policy, or
        // an insecure origin) and a device that is not there. The host is told
        // which, because "no camera on this laptop" and "you said no" are
        // different things to put in front of a person.
        const name = error instanceof DOMException ? error.name : "";
        cameraUnavailable(
          name === "NotFoundError" || name === "DevicesNotFoundError"
            ? "no_camera"
            : "camera_denied",
        );
        return;
      }
      if (cancelled) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      // A track that ends (another app grabbed the camera, the OS revoked it)
      // must stop the detection loop — it would be sampling a frozen frame.
      for (const track of stream.getTracks()) {
        track.addEventListener("ended", handleTrackEnded);
      }
      trackRef.current = stream.getVideoTracks()[0] ?? null;
      const video = videoRef.current;
      if (video !== null) {
        video.srcObject = stream;
        try {
          await video.play();
        } catch {
          // Autoplay refusal still leaves a usable frame after user gesture.
        }
      }
      setMode("live");
    }

    void start();
    return () => {
      cancelled = true;
      trackRef.current = null;
      if (stream !== null) {
        for (const track of stream.getTracks()) {
          track.removeEventListener("ended", handleTrackEnded);
          track.stop();
        }
      }
    };
  }, [intakeImages, reportError, useCamera]);

  // ── live hints (~5 fps on a 320 px sample) ────────────────────────────────
  React.useEffect(() => {
    if (mode !== "live") return;
    const timer = window.setInterval(() => {
      const video = videoRef.current;
      const canvas = sampleCanvasRef.current;
      if (video === null || canvas === null) return;
      if (video.videoWidth === 0 || video.videoHeight === 0) return;
      const ratio = video.videoHeight / video.videoWidth;
      canvas.width = HINT_SAMPLE_WIDTH;
      canvas.height = Math.max(1, Math.round(HINT_SAMPLE_WIDTH * ratio));
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (context === null) return;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      setHint(readFrame(image).hint);
    }, HINT_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [mode]);

  /**
   * ── the curved-page engine, fetched on Wi-Fi before anyone asks ───────────
   *
   * On Wi-Fi the ~30 MB the correction needs can be here before the user ever
   * opens the switch, which turns the worst wait in the product into no wait at
   * all. On anything else — mobile data, data saver, or a browser that will not
   * say ({@link connectionKind}) — nothing is fetched and the consent line says
   * why instead.
   *
   * It is arranged to lose every race with the capture path: it waits for the
   * corner detector to be ready (or gives up waiting), then goes at idle, then
   * fetches its two files one after the other. The prefetch itself is latched
   * per page-session, so mounting this screen once per page of a scan still
   * costs exactly one run.
   */
  React.useEffect(() => {
    if (mode !== "live") return;
    if (!shouldPrefetchHeavyAssets(connectionKind())) return;

    let cancelled = false;
    let idle: number | null = null;
    let idleIsTimeout = false;
    const idleWindow = window as IdleWindow;
    const deadline = Date.now() + PREFETCH_WAIT_MS;

    const fire = () => {
      const start = () => {
        if (!cancelled) void prefetchDewarpAssets(urls);
      };
      if (idleWindow.requestIdleCallback !== undefined) {
        idle = idleWindow.requestIdleCallback(start, { timeout: 2000 });
        return;
      }
      idleIsTimeout = true;
      idle = window.setTimeout(start, 500);
    };

    const timer = window.setInterval(() => {
      if (!isMlDetectionReady() && Date.now() < deadline) return;
      window.clearInterval(timer);
      fire();
    }, PREFETCH_POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      if (idle === null) return;
      if (idleIsTimeout) window.clearTimeout(idle);
      else idleWindow.cancelIdleCallback?.(idle);
    };
  }, [mode, urls]);

  /**
   * Frame → page, with the corners resolved in one fixed order of priority
   * ({@link resolveCaptureCorners}):
   *
   *  1. `live` — a quad already measured on *this* frame. Nothing to improve on.
   *  2. one full detect on the frame itself, which never rejects and gets its
   *     own ~3 s budget.
   *  3. `fallback` — the buffered preview quad, used only when that detect came
   *     back with nothing. The caller has already checked it is inside the
   *     capture grace window and that the two frames share a shape; what is left
   *     here is only the priority, and measuring this frame always outranks
   *     remembering another one.
   *
   * The frame is encoded **once**, as the page's canonical. Nothing here warps
   * anything: the corners travel with the page and the warp happens inside its
   * single render, so a capture costs one encode instead of two.
   */
  const emit = React.useCallback(
    async (
      frame: HTMLCanvasElement,
      live: NormalizedQuad | null,
      gate: GateReading | null,
      taken: CapturePath,
      fallback: NormalizedQuad | null = null,
    ) => {
      // Run only when it can change the answer: this is a ~3 s WASM detect and
      // step 1 already outranks it. Only the corners are wanted from it — how
      // sure scanic was gates the app's own decisions, never a photo a person
      // asked for. The wait first: an ML pass the live loop still had airborne
      // at the tap would otherwise silently hand this one frame to the
      // classical detector.
      let detection: QuadDetection | null = null;
      if (live === null) {
        await waitForMlIdle();
        detection = await detectInCanvas(frame, urls);
      }
      const detected = detection?.corners ?? null;
      const corners = resolveCaptureCorners(live, detected, fallback);
      onCapture({
        canonical: await encodeCanvas(frame, "canonical"),
        corners,
        gate,
        path: path ?? taken,
      });
    },
    [onCapture, path, urls],
  );

  const detect = useLiveDetect({
    videoRef,
    containerRef: stageRef,
    active: mode === "live" && !disabled && !cameraLost,
    paused: paused || busy,
  });

  /**
   * The tip box only appears after the detector has genuinely been stuck, and
   * disappears the instant it locks on — the timer restarts on every state
   * change, so a quad that comes and goes never accumulates its way into a
   * scolding.
   */
  React.useEffect(() => {
    if (mode !== "live" || detect.hasQuad || busy || paused) {
      setStruggling(false);
      return;
    }
    const timer = window.setTimeout(() => setStruggling(true), TIP_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [mode, detect.hasQuad, busy, paused]);

  /**
   * One capture path for the shutter and the frame tap, because they must
   * produce byte-identical results: the ONLY difference is which of the two the
   * user's thumb landed on. Nothing else in the app takes a photo.
   *
   * Two things can become the page. A **still photo** from the camera's own
   * photo pipeline is asked for first and used when it arrives — it is a better
   * image of the same page. Otherwise the **preview frame** is grabbed, exactly
   * as this screen has always done.
   *
   * **The corners the viewfinder was showing are buffered and may travel with
   * either.** This amends the rule the file used to hold absolute ("a quad
   * measured on the preview may only ever travel with a preview frame"): on real
   * handsets the still's own re-detection missed at the shutter moment most of
   * the time — the camera is hunting focus at exactly that instant — and the
   * user arrived at the confirm screen with no corners at all, having watched
   * the app track their page a heartbeat earlier.
   *
   * So the order is priority, not prohibition. The still path still re-detects
   * on the photo itself and that answer always wins when it lands; the buffered
   * quad is the rescue underneath it. The still is *requested* at
   * the preview's own shape ({@link takeStillPhoto} passes the aspect down to
   * the size negotiation), and a photo that comes back a different shape
   * anyway is discarded for the preview frame — a wider field of view is a
   * scene the user did not compose, and it is what made pages arrive small,
   * corners untransferable and the coverage gate wrong in the field. The
   * buffered quad additionally has to have been fresh **at the tap**
   * ({@link liveQuadFreshAtTap}) and inside the capture grace window
   * ({@link liveQuadSurvives}, charged the buffer's own age *plus* everything
   * the shutter has spent since).
   *
   * Corners here are an editable suggestion. The mandatory confirm-corners
   * screen — where the user drags the handles — is what protects the crop, which
   * is why a slightly drifted quad beats none at all.
   */
  const runCapture = React.useCallback(async () => {
    const video = videoRef.current;
    if (video === null || busyRef.current || disabled) return;
    // Both read synchronously, at the tap: everything below this line moves the
    // clock, and the whole point is to keep what the user was looking at.
    const grabbed = detect.takeQuadForCapture();
    const previewAspect =
      video.videoWidth > 0 && video.videoHeight > 0
        ? video.videoWidth / video.videoHeight
        : null;
    detect.noteCapture();
    busyRef.current = true;
    setBusy(true);
    setMessage(null);
    let frame: HTMLCanvasElement | null = null;
    try {
      // Feedback first. The still attempt below may cost up to its budget, and
      // it spends that under a flash and a haptic — never under a screen that
      // looks like it missed the tap.
      if (typeof navigator.vibrate === "function") navigator.vibrate(50);
      flash(flashRef.current);

      const startedAt = Date.now();
      const still = await takeStillPhoto(trackRef.current, {
        longEdgeTarget: MAX_LONG_EDGE,
        // The still is *requested* at the preview's shape: a wider
        // photo than the one the user composed is a different scene — the page
        // arrives small, the corner transfer dies, and the coverage gate
        // rejects the detector's correct answer.
        previewAspect,
      });
      // null corners = "detect on the frame you are given", inside `emit`.
      let corners: NormalizedQuad | null = null;
      let fallbackCorners: NormalizedQuad | null = null;
      if (still !== null) {
        try {
          frame = drawStill(still);
        } catch {
          // A canvas that could not be allocated at photo size may still be
          // allocatable at preview size, and a photo is not worth an error
          // message while the viewfinder is right there. It is still a failed
          // still, though — it cost the budget and a full-resolution decode to
          // reach this line — so the two-strike policy hears about it.
          noteStillFailure();
          frame = null;
        }
      }
      if (
        frame !== null &&
        previewAspect !== null &&
        !quadTransfers(previewAspect, frame.width / frame.height)
      ) {
        // The driver ignored the requested shape: this photo is of a scene the
        // user did not compose, and everything downstream — the corner
        // transfer, the coverage gate, the confirm screen itself — is built on
        // the frame being what the viewfinder showed. The preview frame is
        // that, so it wins. Charged as a strike: a driver that answers the
        // wrong shape will keep doing so, and the budget it costs per page
        // buys nothing.
        releaseCanvas(frame);
        frame = null;
        noteStillFailure();
      }
      // Fresh at the tap or not at all: a buffer the detector last confirmed
      // long before the tap points at where the page was. The grace
      // window then covers what the shutter itself spent on top.
      const bufferedQuad =
        grabbed !== null &&
        liveQuadFreshAtTap(grabbed.ageMs) &&
        liveQuadSurvives(grabbed.ageMs + (Date.now() - startedAt))
          ? grabbed.quad
          : null;
      if (frame === null) {
        // The preview path: same surface the quad was measured on, so it is the
        // capture's corners outright and no aspect check is owed.
        frame = frameToCanvas(video);
        corners = bufferedQuad;
      } else if (previewAspect !== null) {
        // The still path: its own detection gets first refusal inside `emit`;
        // this is only what happens when that detection finds nothing. The
        // shape check above already guarantees the still matches the preview,
        // so the buffered quad transfers.
        fallbackCorners = bufferedQuad;
      }
      // The capture-quality reading, on the full-resolution frame and BEFORE
      // any warp. Wrapped because a measurement failure must never cost the
      // user their photo — an unmeasured capture is kept and shown as
      // "não verificada", never as a pass.
      let gate: GateReading | null = null;
      try {
        const gateCanvas = gateCanvasRef.current;
        if (gateCanvas !== null) {
          gate = assessSource(frame, frame.width, frame.height, gateCanvas);
        }
      } catch {
        gate = null;
      }
      await emit(frame, corners, gate, "shutter", fallbackCorners);
      setAnnouncement(copy.capture.captured(pageNumber));
    } catch (error) {
      setMessage(
        error instanceof ImagePrepError
          ? copy.pageErrors[error.code]
          : copy.pageErrors.generic,
      );
      reportPrepFailure(error);
    } finally {
      // A 12 MP frame is ~48 MB of canvas; the next shutter tap allocates
      // another one, so this one goes back now rather than at the next GC.
      releaseCanvas(frame);
      busyRef.current = false;
      setBusy(false);
    }
  }, [copy, detect, disabled, emit, pageNumber]);

  const handleShutter = React.useCallback(() => {
    shutterPulse(shutterRef.current);
    void runCapture();
  }, [runCapture]);

  const handleFile = React.useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Let the same file be picked twice in a row.
      event.target.value = "";
      if (file === undefined) return;
      busyRef.current = true;
      setBusy(true);
      setMessage(null);
      try {
        const capture = await captureFromFile(file, urls, path ?? "gallery");
        if (typeof navigator.vibrate === "function") navigator.vibrate(50);
        onCapture(capture);
        setAnnouncement(copy.capture.captured(pageNumber));
      } catch (error) {
        setMessage(
          error instanceof ImagePrepError
            ? copy.pageErrors[error.code]
            : copy.pageErrors.generic,
        );
        reportPrepFailure(error);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [copy, onCapture, pageNumber, path, reportPrepFailure, urls],
  );

  /**
   * The fallback surface goes through `prepareCapture` + the full detect the
   * same way, but it is the *only* affordance on screen, so it keeps its own
   * label rather than borrowing the control row's.
   */
  const handleFallbackFile = React.useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      await handleFile(event);
    },
    [handleFile],
  );

  // While the quad is on screen it IS the feedback: the blur chip would just
  // argue with it. Poor light is the one thing the quad cannot tell the user.
  const showLightWarning = hint === "low_light";
  const showHint = !detect.hasQuad || showLightWarning;

  /**
   * The one prose box the frame can show, and never more than one at a time —
   * a failed capture, then "no more pages", then the stuck-detector tip. They
   * were three separate boxes under the frame; stacked, they could take a third
   * of the viewfinder's height away and hand it back a second later.
   */
  const stageNotice =
    message ??
    (mode === "live" && disabled
      ? (disabledReason ?? copy.capture.capacityFallback)
      : struggling && mode === "live" && !disabled
        ? copy.capture.tip
        : null);

  return (
    <div className={clsx("flex min-h-0 flex-1 flex-col gap-3", className)}>
      <div
        ref={stageRef}
        className="relative min-h-0 flex-1 overflow-hidden rounded-lg bg-shell-sunken"
      >
        {/* Always mounted: the stream is attached to this node before the mode
            flips to "live", so it must exist from the first render. */}
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          aria-label={copy.capture.videoLabel}
          className={clsx(
            "absolute inset-0 h-full w-full object-cover",
            mode !== "live" && "hidden",
          )}
        />

        {/* Tapping the frame takes the photo — the caption says so, and on a
            phone it is the gesture people reach for before they find a
            shutter. Behind the chips and the caption, so neither is swallowed. */}
        {mode === "live" && !disabled && (
          <button
            type="button"
            aria-label={captureLabel}
            onClick={() => {
              void runCapture();
            }}
            disabled={busy}
            className="absolute inset-0 h-full w-full cursor-pointer"
          />
        )}

        {mode === "live" && !detect.hasQuad && <FramingBrackets />}

        {mode === "live" && detect.available && detect.frameBox !== null && (
          // Positioned over the *rendered* frame, not the stage: object-cover
          // crops the preview, so a 0–1 quad only lines up inside this box.
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute"
            style={{
              left: detect.frameBox.left,
              top: detect.frameBox.top,
              width: detect.frameBox.width,
              height: detect.frameBox.height,
            }}
            viewBox="0 0 1 1"
            preserveAspectRatio="none"
          >
            {/* The overlay the hook paints: four corner brackets, drawn twice,
                and one group that carries the fade.

                **Corners only — never a line round the page.** The marks run
                along the page's real edges, so they say where it is and how it
                is tilted, and the miscrop a full outline would be there to catch
                is caught where it is actually fixable: the mandatory
                confirm-corners screen. The dark halo under each mark is what
                makes them survive white paper and a dark desk without dimming
                anything. Geometry and the fade come from the hook, on the
                animation frame — never from React. */}
            <g ref={detect.overlay.group} style={{ opacity: 0 }}>
              <path
                ref={detect.overlay.bracketsHalo}
                d=""
                className="fill-none stroke-night/85"
                strokeWidth={5.5}
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
              <path
                ref={detect.overlay.brackets}
                d=""
                className="fill-none stroke-warm"
                strokeWidth={3.5}
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          </svg>
        )}

        {mode === "live" && (
          // The aiming vocabulary, and nothing else: these chips report what the
          // detector can see so the user can aim. None of them counts down to
          // anything — the photo is taken when the user takes it.
          <div className="pointer-events-none absolute inset-x-0 top-3 flex flex-col items-center gap-1.5 px-3">
            {detect.hasQuad && (
              <Chip mono tone="found" className="shadow-sm">
                {copy.capture.sheetFound}
              </Chip>
            )}
            {showHint && !detect.hasQuad && (
              <Chip
                mono
                tone={struggling ? "alert" : "night"}
                className="shadow-sm"
              >
                {struggling
                  ? copy.capture.edgesNotFound
                  : detect.searching
                    ? copy.capture.aimAtDocument
                    : copy.capture.fitWholePage}
              </Chip>
            )}
            {showLightWarning && (
              <Chip mono tone="warning" className="shadow-sm">
                {copy.capture.lowLight}
              </Chip>
            )}
          </div>
        )}

        {mode === "starting" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <SpinnerIcon size={28} className="text-shell-accent" />
            <p className="font-display text-2xl font-semibold text-shell-ink">
              {copy.capture.opening}
            </p>
          </div>
        )}

        {mode === "fallback" && !intakeImages && (
          // Camera off or refused, and no file intake behind it. There is
          // nothing to offer, so the surface says why instead of pretending.
          // The flow is already ending upstream; this is what the last frame
          // of it looks like.
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 border-2 border-dashed border-shell-line px-6 text-center">
            <CameraIcon size={40} className="text-shell-ink2/50" />
            <p className="text-base leading-snug text-shell-ink2">
              {copy.primer.body}
            </p>
          </div>
        )}

        {mode === "fallback" &&
          intakeImages &&
          (disabled ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 border-2 border-dashed border-shell-line px-6 text-center">
              <CameraIcon size={40} className="text-shell-ink2/50" />
              <p className="text-base leading-snug text-shell-ink2">
                {disabledReason ?? copy.capture.capacityFallback}
              </p>
            </div>
          ) : (
            // The WHOLE surface is the button. On the fallback path this is the
            // only thing on screen that matters, so it gets all of it.
            <label
              className={clsx(
                "absolute inset-0 flex cursor-pointer flex-col items-center justify-center gap-3",
                "border-2 border-dashed border-shell-accent px-6 text-center",
                "transition-colors duration-200 hover:bg-shell-ink/5 active:bg-shell-ink/5",
              )}
            >
              <input
                type="file"
                accept={ACCEPT_ATTRIBUTE}
                capture="environment"
                disabled={busy}
                className="scan-sr-only"
                onChange={(event) => {
                  void handleFallbackFile(event);
                }}
              />
              {/* Glyph, title and caption all follow the same fact: what this
                  surface will actually open. `captureLabel` is the screen's own
                  phrase ("Fotografar página 3", "Refazer página 3") and stays
                  the word wherever the camera is genuinely reachable. */}
              {busy ? (
                <SpinnerIcon size={40} className="text-shell-accent" />
              ) : pickerOnly ? (
                <ImageIcon size={40} className="text-shell-accent" />
              ) : (
                <CameraIcon size={40} className="text-shell-accent" />
              )}
              <span className="font-display text-2xl font-semibold leading-tight text-shell-ink">
                {busy
                  ? copy.capture.preparing
                  : pickerOnly
                    ? copy.capture.pick(pageNumber)
                    : captureLabel}
              </span>
              <Meta onNight>
                {busy
                  ? copy.capture.oneMoment
                  : pickerOnly
                    ? copy.capture.clickToPick
                    : copy.capture.tapHere}
              </Meta>
            </label>
          ))}

        {/* The foot of the frame: everything that comes and goes down here is
            stacked in ONE overlay, so none of it can push the frame around.
            It sits after the fallback label in the DOM (it has to draw over
            it) and lets every tap through to the frame underneath — tapping
            the frame is one of the two ways to take the photo. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 px-3 pb-3">
          {stageNotice !== null && (
            <Notice tone="night" className="w-full shadow-lg">
              {stageNotice}
            </Notice>
          )}

          {mode === "live" && !disabled && (
            // On its own pill: this caption is over the camera image, which is
            // whatever the user is pointing at, so it cannot take its colour
            // from the shell the way the chrome around it does.
            <Chip mono tone="night">{copy.capture.tapToCapture}</Chip>
          )}
        </div>

        {/* The capture flash, driven by GSAP opacity — never a class toggle. */}
        <div
          ref={flashRef}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-shell-ink opacity-0"
        />
      </div>

      <canvas ref={sampleCanvasRef} className="hidden" />
      <canvas ref={gateCanvasRef} className="hidden" />

      <LiveRegion message={announcement} />

      {children}

      {/* The control row: the gallery escape hatch, the shutter, and whatever
          the screen wants on the right — three real targets rather than two
          captions around a button (see `CameraActionBar`). */}
      <CameraActionBar>
        {mode === "live" && !disabled && intakeImages ? (
          <CameraPill
            icon={<ImageIcon size={16} />}
            label={copy.capture.gallery}
            ariaLabel={copy.capture.galleryAria}
            disabled={busy}
            input={
              <input
                type="file"
                accept={ACCEPT_ATTRIBUTE}
                disabled={busy}
                className="scan-sr-only"
                onChange={(event) => {
                  void handleFile(event);
                }}
              />
            }
          />
        ) : (
          <CameraPillSpacer />
        )}

        {mode === "live" && !disabled ? (
          <CameraShutter
            buttonRef={shutterRef}
            label={captureLabel}
            busy={busy}
            onClick={handleShutter}
          />
        ) : (
          // Keeps the row's height stable so the layout does not jump when
          // the camera resolves into the fallback surface.
          <span aria-hidden="true" className="block h-[62px] w-[62px] shrink-0" />
        )}

        {rightAction ?? <CameraPillSpacer />}
      </CameraActionBar>
    </div>
  );
}

/**
 * The still photo onto the page grid, and its memory straight back.
 *
 * A full-resolution `ImageBitmap` is tens of megabytes of GPU-side image; once
 * it has been drawn there is no reason for both it and the canvas to exist, and
 * on the phones this app is built for that pair is the allocation that fails.
 */
function drawStill(still: ImageBitmap): HTMLCanvasElement {
  try {
    return bitmapToCanvas(still);
  } finally {
    still.close();
  }
}

/**
 * Framing marks, not a border: four corner brackets say "aim here" without
 * drawing a box the user then tries to fit the page inside exactly. They step
 * aside the moment the detector has an actual quad to show — two frames on one
 * page is one frame too many.
 */
function FramingBrackets() {
  // Always light with a dark shadow, whatever the shell: these are drawn over
  // the camera image, and a dark bracket in a dark room is no bracket at all.
  const common =
    "pointer-events-none absolute h-7 w-7 text-warm drop-shadow-[0_1px_3px_rgba(0,0,0,0.85)]";
  return (
    <>
      <Bracket className={clsx(common, "left-4 top-4")} d="M2 10V4.5A2.5 2.5 0 0 1 4.5 2H10" />
      <Bracket className={clsx(common, "right-4 top-4")} d="M26 10V4.5A2.5 2.5 0 0 0 23.5 2H18" />
      <Bracket className={clsx(common, "bottom-4 left-4")} d="M2 18v5.5A2.5 2.5 0 0 0 4.5 26H10" />
      <Bracket className={clsx(common, "bottom-4 right-4")} d="M26 18v5.5A2.5 2.5 0 0 1 23.5 26H18" />
    </>
  );
}

function Bracket({ className, d }: { className: string; d: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 28 28"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}
