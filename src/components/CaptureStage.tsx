"use client";

import * as React from "react";
import clsx from "clsx";
import {
  ACCEPT_ATTRIBUTE,
  bitmapToCanvas,
  encodeCanvas,
  frameToCanvas,
  ImagePrepError,
  releaseCanvas,
} from "@/lib/image";
import { encodeQuality } from "@/lib/encode";
import {
  lastStillAttempt,
  liveQuadFreshAtTap,
  liveQuadSurvives,
  noteStillFailure,
  noteStillSuccess,
  resolveCaptureCorners,
  stillPipelineFailed,
  stillPipelineWorking,
  stillCropFor,
  takeStillPhoto,
  type PhotoSizeChoice,
  type StillCrop,
  type StillFallbackReason,
} from "@/lib/still-capture";
import {
  detectInCanvas,
  isMlDetectionReady,
  refineCorners,
  waitForMlIdle,
  type DetectionSource,
  type QuadDetection,
} from "@/lib/flatten";
import { prefetchDewarpAssets } from "@/lib/dewarp/prefetch";
import { connectionKind, shouldPrefetchHeavyAssets } from "@/lib/network";
import { captureFromFile, type Capture, type CapturePath, type CaptureSizes } from "@/lib/capture-intake";
import { FILL_NEAR, type HintKey } from "@/lib/guidance";
import { assessSource, type GateReading } from "@/lib/capture-gate";
import { normalizedCoverage, type NormalizedQuad } from "@/lib/quad";
import { refineOnCanvas } from "@/lib/refine";
import { flash, shutterPulse } from "@/lib/motion";
import { probe, probeSetting, probing, type CaptureProbe, type CornersFrom } from "@/lib/probe";
import { useLiveDetect } from "@/hooks/useLiveDetect";
import { checkStill } from "@/lib/still-check";
import { lumaThumb, registerStill, type LumaThumb, type StillRegistration } from "@/lib/still-register";
import { resolveFit, type FitPolicy } from "@/lib/visible-region";
import {
  applyStreamSize,
  CAPPED_STREAM,
  hasImageCapture,
  isAndroid,
  NATIVE_STREAM,
  STREAM_RESTORE_BUDGET_MS,
  streamCapDecision,
  streamCapEnabled,
  waitForNativeFrame,
} from "@/lib/stream-cap";
import { DiagnosticsHud } from "@/components/DiagnosticsHud";
import { PASS_SAMPLE_MS } from "@/lib/diagnostics-events";
import { detectLaneReason } from "@/lib/detect-lane";
import { useAssetUrls, useScanRuntime } from "@/hooks/useScanRuntime";
import { useCopy } from "@/components/I18n";
import { AutoCaptureIcon, CameraIcon, ImageIcon, SpinnerIcon, TorchIcon } from "@/components/icons";
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
 * **The shutter is always the person's.** The shutter and the frame tap fire a
 * capture in every state — no hint ever blocks them. Detection finds the
 * corners the capture travels with and *guides* (`lib/guidance.ts`): one hint
 * at a time in a reserved slot at the top, and a ready cue on the corner
 * brackets once the page is framed, sharp and still (with one haptic tick and
 * a spoken "ready" per page). **Auto-capture** is experimental: whether its
 * toggle is offered is the layout's and the host's call (`autoCaptureOffered`
 * in `lib/capture-layout.ts`), and only when the person switches it on (off in every new
 * flow; the flow remembers the choice while it is open, never in storage)
 * does the screen take a photo by itself: once the ready cue has held, with a
 * countdown drawn along the brackets — through exactly the path a tap takes,
 * confirm screen included — and once per page. A retake is always manual.
 *
 * **The torch** is offered only where the camera track says it has one
 * (`getCapabilities().torch`), switched with `applyConstraints` one change at
 * a time, re-applied to a new track, off while the viewfinder is covered or
 * the page limit is reached, and a refusal costs nothing but the light — the
 * toggle then shows it off, as it is.
 *
 * **The frame never changes size.** Everything transient this screen has to say
 * — the hint, the tap caption, an error — is drawn *over* the frame, absolutely
 * positioned at its top or foot, in slots whose size does not depend on what
 * they hold.
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

/** The one haptic tick when the ready cue comes on (Android; iOS has no `vibrate`). */
const READY_TICK_MS = 12;

/** The diagnostics stream calls the live loop stalled after this long without a pass while it should be running. */
const STALL_MS = 2000;

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

/**
 * Preview frames drawn to become a page this page load, numbered for the
 * bench's probe (`lib/probe.ts`) — counted only while something listens.
 */
let previewGrabs = 0;

/** Which of the two capture affordances the thumb landed on — or auto-capture. */
type CaptureTrigger = "shutter" | "frame" | "auto";

/**
 * What a capture already knows before `emit` resolves its corners, for the
 * bench's probe (`lib/probe.ts`). Built only while something is listening.
 */
type CaptureTrace = Omit<
  CaptureProbe,
  | "type"
  | "doneAt"
  | "frameW"
  | "frameH"
  | "cornersFrom"
  | "corners"
  | "detector"
  | "confidence"
  | "coverage"
  | "mlWaitMs"
> & {
  /** Who measured the buffered quad, when one travelled. */
  bufferedSource: CaptureProbe["detector"];
  bufferedConfidence: number | null;
};

/**
 * What a full-bleed capture layout (`captureLayout`: `rail`, the default, or
 * an experimental one) is handed to draw its chrome with. The stage is the
 * same viewfinder the `standard` screen shows — video, frame tap, corner brackets, ready cue, countdown,
 * flash, fallback surface — and everything else is state and actions the
 * layout places where its design puts them. The layout owns placement only:
 * what a tap captures, when the torch lights and when auto-capture fires is
 * decided here, once, for every layout.
 */
export interface CaptureChromeParts {
  /** The viewfinder. Put it in a box whose size never depends on the chrome. */
  stage: React.ReactNode;
  mode: StageMode;
  /** Live and taking pages: the shutter is on screen. */
  live: boolean;
  busy: boolean;
  /** The one hint, in words and tone, or none. */
  hint: { key: HintKey; text: string; tone: "night" | "alert" | "warning" } | null;
  /** Light the torch from the low-light hint — null unless that offer stands. */
  torchOffer: (() => void) | null;
  torch: {
    available: boolean;
    on: boolean;
    toggle: () => void;
    ref: React.RefObject<HTMLButtonElement | null>;
  };
  autoCapture: { offered: boolean; on: boolean; toggle: () => void };
  /** The ready cue (the brackets carry it; a layout may echo it). */
  ready: boolean;
  /** A page is tracked right now. */
  hasQuad: boolean;
  /** The one prose box: a failed capture, or the page limit. */
  notice: string | null;
  /**
   * The in-camera "Já tenho a foto" pick — the `standard` screen's gallery
   * pill, same handler: the file goes through the same preparation, detect
   * and confirm-corners screen as a photo. Null whenever that pill would not
   * be there (not live, at the page limit, or no image intake).
   */
  gallery: {
    busy: boolean;
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  } | null;
  shutter: {
    ref: React.RefObject<HTMLButtonElement | null>;
    label: string;
    busy: boolean;
    onClick: () => void;
  };
  /** Pinned to the tracked page's top-left corner (see `LiveOverlayRefs.anchor`). */
  anchorRef: React.RefObject<HTMLDivElement | null>;
  /** Draws the auto-capture countdown as a ring (see `LiveOverlayRefs.ring`). */
  ringRef: React.RefObject<SVGCircleElement | null>;
}

/** A full-bleed layout's chrome, handed to {@link CaptureStage}. */
export interface CaptureChrome {
  /** The stage element's own classes — it must fill a box of fixed size. */
  stageClassName: string;
  /** Where the framing brackets sit while no page is tracked (default: 16px in from the stage). */
  framingClassName?: string;
  /**
   * How the camera frame is scaled into the stage (`lib/visible-region.ts`;
   * default `cover`). The layout's opaque bands are declared in its chrome
   * with `data-scan-occluder` (see `OccluderMark`).
   */
  fit?: FitPolicy;
  render: (parts: CaptureChromeParts) => React.ReactNode;
}

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
  /**
   * Offer the auto-capture toggle (experimental; decided by `<ScanFlow>` from
   * the layout and `experimentalAutoCapture`). Absent or false: no toggle,
   * and nothing ever captures by itself.
   */
  autoCaptureOffered?: boolean;
  /** Auto-capture as the person left it in this flow (off in a new one). */
  autoCaptureOn?: boolean;
  /** They switched it: the flow keeps the choice while it is open — never in storage. */
  onAutoCaptureChange?: (on: boolean) => void;
  /**
   * A full-bleed layout's chrome. Absent: the `standard` screen, exactly —
   * `rightAction`, `children` and the control row are only read without it.
   */
  chrome?: CaptureChrome;
  /**
   * The diagnostics HUD (`experimentalDiagnostics` on `<ScanFlow>`): numbers
   * about the live loop for a real-phone test. Off by default; no storage,
   * no network, no images.
   */
  diagnostics?: boolean;
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
  autoCaptureOffered = false,
  autoCaptureOn = false,
  onAutoCaptureChange,
  chrome,
  diagnostics = false,
}: CaptureStageProps) {
  const copy = useCopy();
  // The asset base the host gave the flow. Every loader below is handed it
  // explicitly rather than reading a module global: two mounts of the library
  // on one page must never race each other to a shared `wasmPaths`.
  const urls = useAssetUrls();
  const { intake, reportError, diagnosticsSink } = useScanRuntime();
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
  /** The capture gate's scratch canvas. */
  const gateCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  /** The live video track, kept for the still-photo path only. */
  const trackRef = React.useRef<MediaStreamTrack | null>(null);
  /** Whether the live stream is capped (`lib/stream-cap.ts`) — per camera, reset when it reopens. */
  const streamCappedRef = React.useRef(false);
  /** One cap change at a time. */
  const streamCapBusyRef = React.useRef<Promise<void> | null>(null);

  /**
   * Cap or uncap the live stream as {@link streamCapDecision} says, and report
   * it (`stream-cap`) when it changes — or, with `announce`, even when it does
   * not (the camera just came up: the host hears the state and its reason).
   */
  const reconsiderStreamCap = React.useCallback(
    async (announce: boolean) => {
      if (streamCapBusyRef.current !== null) await streamCapBusyRef.current;
      const track = trackRef.current;
      const video = videoRef.current;
      if (track === null || video === null || track.readyState !== "live") return;
      const decision = streamCapDecision({
        enabled: streamCapEnabled(),
        android: isAndroid(),
        imageCapture: hasImageCapture(),
        stillWorking: stillPipelineWorking(),
        stillFailed: stillPipelineFailed(),
        streamLongEdge: Math.max(video.videoWidth, video.videoHeight),
        capped: streamCappedRef.current,
      });
      const report = (applied: boolean, reason: string) =>
        diagnosticsSink?.emit({
          type: "stream-cap",
          applied,
          reason,
          stream: video.videoWidth > 0 ? { width: video.videoWidth, height: video.videoHeight } : null,
        });
      if (decision.cap === streamCappedRef.current) {
        if (announce) report(streamCappedRef.current, decision.reason);
        return;
      }
      const change = (async () => {
        const ok = await applyStreamSize(track, decision.cap ? CAPPED_STREAM : NATIVE_STREAM);
        if (trackRef.current !== track) return;
        if (ok) streamCappedRef.current = decision.cap;
        report(streamCappedRef.current, ok ? decision.reason : "constraints-failed");
      })();
      streamCapBusyRef.current = change;
      try {
        await change;
      } finally {
        if (streamCapBusyRef.current === change) streamCapBusyRef.current = null;
      }
    },
    [diagnosticsSink],
  );
  /**
   * Bring a capped live stream back to its native size for a page that is
   * about to be made of the preview frame: `ok` when a native frame is on
   * screen within {@link STREAM_RESTORE_BUDGET_MS}, `timeout` when the camera
   * took the constraints but no native frame came in time, `failed` when it
   * refused them. Either way the stream is not capped afterwards.
   */
  const restoreNativeStream = React.useCallback(
    async (video: HTMLVideoElement): Promise<"ok" | "timeout" | "failed"> => {
      if (streamCapBusyRef.current !== null) await streamCapBusyRef.current;
      const track = trackRef.current;
      if (track === null || track.readyState !== "live") return "failed";
      if (!streamCappedRef.current) return "ok";
      const applied = await applyStreamSize(track, NATIVE_STREAM);
      if (!applied) {
        diagnosticsSink?.emit({ type: "stream-cap", applied: true, reason: "constraints-failed", stream: { width: video.videoWidth, height: video.videoHeight } });
        return "failed";
      }
      streamCappedRef.current = false;
      const back = await waitForNativeFrame(video, STREAM_RESTORE_BUDGET_MS);
      diagnosticsSink?.emit({
        type: "stream-cap",
        applied: false,
        reason: "still-failed",
        stream: video.videoWidth > 0 ? { width: video.videoWidth, height: video.videoHeight } : null,
      });
      return back ? "ok" : "timeout";
    },
    [diagnosticsSink],
  );
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
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [announcement, setAnnouncement] = React.useState("");
  /** The live track, as state: a new one (a restart) re-applies the torch. */
  const [track, setTrack] = React.useState<MediaStreamTrack | null>(null);
  /** The track says it has a torch. */
  const [torchAvailable, setTorchAvailable] = React.useState(false);
  /** The person wants the torch on (it is lit only while the viewfinder is uncovered). */
  const [torchOn, setTorchOn] = React.useState(false);
  const [autoCaptureChosen, setAutoCaptureChosen] = React.useState(autoCaptureOn);
  const autoCapture = autoCaptureOffered && autoCaptureChosen;
  /** The torch toggle, which the low-light offer hands focus to once it has lit the torch. */
  const torchToggleRef = React.useRef<HTMLButtonElement | null>(null);

  // ── camera lifecycle ──────────────────────────────────────────────────────
  React.useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;

    const handleTrackEnded = (): void => {
      diagnosticsSink?.emit({ type: "camera", state: "lost", startMs: null, stream: null, torch: false, fit: fitRef.current });
      trackRef.current = null;
      setTrack(null);
      setTorchAvailable(false);
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
      diagnosticsSink?.emit({ type: "camera", state: "unavailable", startMs: null, stream: null, torch: false, fit: fitRef.current });
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
      const askedAt = performance.now();
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
      setTrack(trackRef.current);
      setTorchAvailable(hasTorch(trackRef.current));
      const video = videoRef.current;
      if (video !== null) {
        video.srcObject = stream;
        try {
          await video.play();
        } catch {
          // Autoplay refusal still leaves a usable frame after user gesture.
        }
      }
      streamCappedRef.current = false;
      if (diagnosticsSink !== null && !cancelled) {
        const settings = trackRef.current?.getSettings();
        const width = video?.videoWidth || settings?.width || 0;
        const height = video?.videoHeight || settings?.height || 0;
        diagnosticsSink.emit({
          type: "camera",
          state: "live",
          startMs: performance.now() - askedAt,
          stream: width > 0 && height > 0 ? { width, height } : null,
          torch: hasTorch(trackRef.current),
          fit: fitRef.current,
        });
      }
      setMode("live");
      // The live stream's cap (`lib/stream-cap.ts`): announced on every camera,
      // applied only on Android Chrome once a still has proven itself.
      if (!cancelled) void reconsiderStreamCap(true);
    }

    void start();
    return () => {
      cancelled = true;
      trackRef.current = null;
      setTrack(null);
      setTorchAvailable(false);
      if (stream !== null) {
        for (const track of stream.getTracks()) {
          track.removeEventListener("ended", handleTrackEnded);
          track.stop();
        }
      }
    };
  }, [diagnosticsSink, intakeImages, reconsiderStreamCap, reportError, useCamera]);

  /**
   * Auto-capture fires through the same path as a tap — set once the capture
   * below exists; the live loop calls whatever this holds.
   */
  const autoFireRef = React.useRef<() => void>(() => undefined);
  const handleAutoCapture = React.useCallback(() => autoFireRef.current(), []);
  // The layout's fit — or, on the bench only, the one a run forces.
  const fit = resolveFit(probeSetting("fit"), chrome?.fit ?? "cover");
  const fitRef = React.useRef(fit);
  fitRef.current = fit;
  /** Automatic captures this mount fired (the diagnostics HUD). */
  const autoFiresRef = React.useRef(0);
  /** The last photo's size (the diagnostics HUD). */
  const lastStillRef = React.useRef<{ width: number; height: number; attention: string | null } | null>(null);
  const detect = useLiveDetect({
    fit,
    videoRef,
    containerRef: stageRef,
    active: mode === "live" && !disabled && !cameraLost,
    // Not paused by a capture in flight: from the tap to the confirm screen
    // the loop holds the overlay frozen on the tapped quad (`capturing`,
    // `noteCapture` → `endCapture`) — tearing it down faded the brackets out
    // and put the framing marks back under the shutter's flash.
    paused,
    autoCapture: autoCapture && mode === "live" && !disabled,
    onAutoCapture: handleAutoCapture,
    diagnosticsSink,
  });

  // ── the ready cue: one haptic tick and one spoken "ready", per page ──────
  // Not on every return of the cue: it can drop for a moment and come back,
  // and a buzz each time would be a buzz train (`ReadyTick`).
  const autoCaptureRef = React.useRef(autoCapture);
  autoCaptureRef.current = autoCapture;
  React.useEffect(() => {
    if (detect.readyTick === 0) return;
    if (typeof navigator.vibrate === "function") navigator.vibrate(READY_TICK_MS);
    setAnnouncement(autoCaptureRef.current ? copy.capture.readyAuto : copy.capture.ready);
  }, [copy, detect.readyTick]);

  // ── the torch ─────────────────────────────────────────────────────────────
  // Lit while wanted, the viewfinder uncovered and the stage taking pages;
  // applied again to every new track. A refusal is silent — the light is a
  // convenience, never a step — but the toggle then says it is off.
  const torchLit = torchAvailable && torchOn && !paused && !disabled && mode === "live";
  const torchQueueRef = React.useRef<Promise<void>>(Promise.resolve());
  React.useEffect(() => {
    if (track === null || !torchAvailable) return;
    // One change at a time, in order: a quick on-off-on must end on.
    const refused = (): void => {
      if (torchLit) setTorchOn(false);
    };
    torchQueueRef.current = torchQueueRef.current.then(() => applyTorch(track, torchLit)).then((ok) => {
      if (!ok) refused();
    });
    return () => {
      if (torchLit) torchQueueRef.current = torchQueueRef.current.then(() => applyTorch(track, false)).then(() => undefined);
    };
  }, [track, torchAvailable, torchLit]);

  // The torch as the person switched it (diagnostics stream only).
  const torchReportedRef = React.useRef(torchOn);
  React.useEffect(() => {
    if (torchReportedRef.current === torchOn) return;
    torchReportedRef.current = torchOn;
    diagnosticsSink?.emit({ type: "torch", on: torchOn });
  }, [diagnosticsSink, torchOn]);

  const toggleAutoCapture = React.useCallback(() => {
    const on = !autoCaptureChosen;
    setAutoCaptureChosen(on);
    onAutoCaptureChange?.(on);
    diagnosticsSink?.emit({ type: "auto-toggle", on });
    setAnnouncement(on ? copy.capture.autoCaptureOnAnnounce : copy.capture.autoCaptureOffAnnounce);
  }, [autoCaptureChosen, copy, diagnosticsSink, onAutoCaptureChange]);

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
   * Whichever of the three wins is then **refined** onto the paper's edge on
   * this frame ({@link refineCorners}) before it seeds the confirm screen: the
   * detect refines its own answer; a `live` or `fallback` quad — measured on a
   * 640 px sample of an earlier frame — is refined here, as the detector that
   * measured it (`carriedSource`) allows. The priority above is untouched:
   * refinement only ever moves corners that were already chosen.
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
      trace: CaptureTrace | null = null,
      carriedSource: DetectionSource | null = null,
      check: {
        live: NormalizedQuad | null;
        preview: { width: number; height: number };
        trigger: CaptureTrigger;
        /** The frame is the still pipeline's photo, not the preview frame the viewfinder judged. */
        stillUsed: boolean;
        /** The viewfinder's picture at the tap, for registering the photo against it. */
        previewThumb: LumaThumb | null;
        /** When the tap was (the diagnostics stream's capture time). */
        tappedAt: number;
        /** The still that arrived, whether or not it became the page. */
        still: { width: number; height: number } | null;
        /** Why the still did not become the page, or null when it did. */
        stillReason: StillFallbackReason | null;
        /** How long the still attempt took, null when none was made. */
        stillMs: number | null;
        /** What `takePhoto` was asked for, when it was asked for a size. */
        requested: PhotoSizeChoice | null;
        /** The part of the still that is the page's frame (null: the preview frame became the page). */
        crop: StillCrop | null;
        /** The browser's canvas limit made the frame smaller than its source. */
        capped: boolean;
        /** The live stream was capped at the tap. */
        streamCapped: boolean;
        /** The live stream's size at the tap. */
        streamAtTap: { width: number; height: number };
        /** A still failed on a capped stream: how restoring the native stream went. */
        restore: "ok" | "timeout" | "failed" | null;
      } | null = null,
    ) => {
      // Run only when it can change the answer: this is a ~3 s WASM detect and
      // step 1 already outranks it. Only the corners are wanted from it — how
      // sure scanic was gates the app's own decisions, never a photo a person
      // asked for. The wait first: an ML pass the live loop still had airborne
      // at the tap would otherwise silently hand this one frame to the
      // classical detector.
      let detection: QuadDetection | null = null;
      let mlWaitMs: number | null = null;
      if (live === null) {
        const waitStarted = performance.now();
        await waitForMlIdle();
        mlWaitMs = performance.now() - waitStarted;
        detection = await detectInCanvas(frame, urls);
      }
      const detected = detection?.corners ?? null;
      let corners = resolveCaptureCorners(live, detected, fallback);
      // The detect refined its own answer; a carried quad is refined here.
      if (corners !== null && corners !== detected) {
        corners = refineCorners(frame, corners, carriedSource, live !== null ? "live" : "fallback");
      }
      // The photo is checked before it is offered (`lib/still-check.ts`): the
      // page the viewfinder vouched for, mapped onto this image, against the
      // corners found on it. A flag never stops the capture — the confirm
      // screen opens either way, asking for a closer look.
      // A photo from the still pipeline has a field of view nobody reports:
      // it is registered against the viewfinder's own picture at the tap
      // (`lib/still-register.ts`), so what it kept of the page is measured
      // from the pictures, not taken on the photo detector's word.
      let registration: StillRegistration | null = null;
      let registerMs: number | null = null;
      if (check !== null && check.stillUsed && check.previewThumb !== null) {
        const registerStarted = performance.now();
        const stillThumb = lumaThumb(frame, frame.width, frame.height);
        registration = stillThumb === null ? null : registerStill(check.previewThumb, stillThumb);
        registerMs = performance.now() - registerStarted;
      }
      const checked =
        check === null
          ? null
          : checkStill({
              live: check.live,
              corners,
              cornersFromPhoto: corners !== null && detected !== null && live === null,
              mapping: { preview: check.preview, still: { width: frame.width, height: frame.height } },
              trigger: check.trigger === "auto" ? "auto" : "manual",
              stillUsed: check.stillUsed,
              registration,
            }).attention;
      // A page made of the capped live stream (a failed still, and the native
      // stream would not come back in time) is never handed over silently.
      const attention =
        checked ?? (check !== null && check.restore !== null && check.restore !== "ok" ? "low-resolution" : null);
      lastStillRef.current = { width: frame.width, height: frame.height, attention };
      if (trace !== null) {
        const cornersFrom: CornersFrom =
          live !== null
            ? "live"
            : detected !== null
              ? "detected"
              : fallback !== null
                ? "fallback"
                : null;
        const { bufferedSource, bufferedConfidence, ...known } = trace;
        const fromDetector = cornersFrom === "detected";
        // The other capture policy, on the same capture: without the classical
        // fall-through the detect would have come back empty and the buffered
        // quad (if one could travel) would have seeded the screen instead.
        let alternative: CaptureProbe["alternative"] = null;
        if (fromDetector && detection?.fellThrough === true) {
          alternative =
            fallback === null
              ? { corners: null, cornersFrom: null }
              : {
                  corners: refineOnCanvas(frame, fallback, { mode: carriedSource === "ml" ? "full" : "local" }).quad,
                  cornersFrom: "fallback",
                };
        }
        probe({
          ...known,
          alternative,
          type: "capture",
          doneAt: performance.now(),
          frameW: frame.width,
          frameH: frame.height,
          cornersFrom,
          corners,
          detector: fromDetector
            ? (detection?.source ?? null)
            : cornersFrom === null
              ? null
              : bufferedSource,
          confidence: fromDetector
            ? (detection?.confidence ?? null)
            : cornersFrom === null
              ? null
              : bufferedConfidence,
          coverage: corners === null ? null : normalizedCoverage(corners),
          mlWaitMs,
          attention,
          register:
            registration === null
              ? null
              : {
                  fovScale: registration.fovScale,
                  shiftX: registration.shiftX,
                  shiftY: registration.shiftY,
                  score: registration.score,
                  overlap: registration.overlap,
                  ms: registerMs ?? 0,
                },
        });
      }
      const canonical = await encodeCanvas(frame, "canonical");
      const sizes: CaptureSizes | undefined =
        check === null
          ? undefined
          : {
              source: check.stillUsed ? "still" : "preview",
              sourceWidth: check.stillUsed && check.still !== null ? check.still.width : check.preview.width,
              sourceHeight: check.stillUsed && check.still !== null ? check.still.height : check.preview.height,
              width: frame.width,
              height: frame.height,
              bytes: canonical.size,
              quality: encodeQuality("canonical"),
              capped: check.capped,
              stillReason: check.stillReason,
            };
      if (diagnosticsSink !== null && check !== null && sizes !== undefined) {
        diagnosticsSink.emit({
          type: "capture",
          trigger: check.trigger === "auto" ? "auto" : "manual",
          tap: check.trigger === "auto" ? null : check.trigger,
          page: pageNumber,
          ms: performance.now() - check.tappedAt,
          still: check.still,
          source: check.stillUsed ? "still" : "preview",
          stillReason: check.stillReason,
          stillMs: check.stillMs,
          requested:
            check.requested === null
              ? null
              : { width: check.requested.imageWidth, height: check.requested.imageHeight },
          stream: check.streamAtTap,
          streamCapped: check.streamCapped,
          restore: check.restore,
          fov: check.crop === null ? null : { width: check.crop.width, height: check.crop.height },
          frame: { width: frame.width, height: frame.height },
          capped: check.capped,
          canonical: { width: frame.width, height: frame.height, bytes: canonical.size, quality: sizes.quality },
          cornersFrom: live !== null ? "live" : detected !== null ? "detected" : fallback !== null ? "fallback" : null,
          registration:
            registration === null
              ? null
              : {
                  fovScale: registration.fovScale,
                  shiftX: registration.shiftX,
                  shiftY: registration.shiftY,
                  score: registration.score,
                  overlap: registration.overlap,
                },
          flag: attention,
        });
      }
      onCapture({
        canonical,
        corners,
        gate,
        path: path ?? taken,
        attention,
        ...(sizes === undefined ? {} : { sizes }),
      });
    },
    [diagnosticsSink, onCapture, pageNumber, path, urls],
  );

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
   * quad is the rescue underneath it. The still is requested at the camera's
   * largest photo size and cut to the preview's field of view by a pure crop
   * ({@link stillCropFor}); a photo whose field of view cannot be matched
   * that way is discarded for the preview frame — a wider or narrower scene
   * than the user composed is what made pages arrive small, corners
   * untransferable and the coverage gate wrong in the field — and the reason
   * is reported (`stillReason`). Either way the page is made at the full
   * resolution of whichever image it came from. The
   * buffered quad additionally has to have been fresh **at the tap**
   * ({@link liveQuadFreshAtTap}) and inside the capture grace window
   * ({@link liveQuadSurvives}, charged the buffer's own age *plus* everything
   * the shutter has spent since).
   *
   * Corners here are an editable suggestion. The mandatory confirm-corners
   * screen — where the user drags the handles — is what protects the crop, which
   * is why a slightly drifted quad beats none at all.
   */
  const runCapture = React.useCallback(async (trigger: CaptureTrigger) => {
    const video = videoRef.current;
    if (video === null || busyRef.current || disabled) return;
    // Auto-capture only ever fires over an uncovered, live viewfinder.
    if (trigger === "auto" && (paused || mode !== "live")) return;
    const tappedAt = performance.now();
    // Both read synchronously, at the tap: everything below this line moves the
    // clock, and the whole point is to keep what the user was looking at.
    const grabbed = detect.takeQuadForCapture();
    // The viewfinder's picture at the tap, as a grey thumbnail: what a photo
    // from the still pipeline is registered against (`emit`). A few
    // milliseconds; nothing is kept past this capture.
    const previewThumb = lumaThumb(video, video.videoWidth, video.videoHeight);
    const previewAspect =
      video.videoWidth > 0 && video.videoHeight > 0
        ? video.videoWidth / video.videoHeight
        : null;
    const streamCappedAtTap = streamCappedRef.current;
    const streamAtTap = { width: video.videoWidth, height: video.videoHeight };
    let stillUsedForCap = false;
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
      // The camera's photo pipeline, at its largest photo size; matched to
      // what the viewfinder showed by a pure crop (`stillCropFor`), never by
      // asking the driver for a smaller photo it would answer with some other
      // shape.
      const still = await takeStillPhoto(trackRef.current);
      // null corners = "detect on the frame you are given", inside `emit`.
      let corners: NormalizedQuad | null = null;
      let fallbackCorners: NormalizedQuad | null = null;
      const stillW = still.bitmap?.width ?? null;
      const stillH = still.bitmap?.height ?? null;
      let stillReason: StillFallbackReason | null = still.reason;
      let stillCrop: StillCrop | null = null;
      let capped = false;
      if (still.bitmap !== null) {
        const fit = stillCropFor(
          { width: still.bitmap.width, height: still.bitmap.height },
          still.requested,
          previewAspect,
        );
        if ("reason" in fit) {
          // A field of view nobody can vouch for: the corner transfer, the
          // coverage gate and the confirm screen are all built on the frame
          // being what the viewfinder showed, and the preview frame is that.
          // Charged as a strike: a driver that answers this will keep doing so.
          still.bitmap.close();
          noteStillFailure();
          stillReason = fit.reason;
        } else {
          try {
            const drawn = drawStill(still.bitmap, fit.crop);
            frame = drawn.canvas;
            capped = drawn.capped;
            stillCrop = fit.crop;
            noteStillSuccess();
            stillUsedForCap = true;
          } catch {
            // A canvas that could not be allocated at photo size may still be
            // allocatable at preview size, and a photo is not worth an error
            // message while the viewfinder is right there. It is still a failed
            // still, though — it cost the budget and a full-resolution decode to
            // reach this line — so the two-strike policy hears about it.
            noteStillFailure();
            stillReason = "alloc-failed";
            frame = null;
          }
        }
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
      const stillUsed = frame !== null;
      let grab: number | null = null;
      let grabbedAt: number | null = null;
      let restore: "ok" | "timeout" | "failed" | null = null;
      if (frame === null && streamCappedRef.current) {
        // The still failed on a capped live stream: the preview frame is about
        // to become the page, so the stream goes back to its native size first
        // (`lib/stream-cap.ts`) — a capped frame is never handed over silently.
        restore = await restoreNativeStream(video);
      }
      if (frame === null) {
        // The preview path: same surface the quad was measured on, so it is the
        // capture's corners outright and no aspect check is owed. At the
        // stream's native size — every pixel the camera is sending.
        const native = frameToCanvas(video);
        frame = native.canvas;
        capped = native.capped;
        if (probing()) {
          // Right after the draw, so the bench can name the frame it took.
          grabbedAt = performance.now();
          previewGrabs += 1;
          grab = previewGrabs;
          probe({ type: "grab", t: grabbedAt, id: grab });
        }
        // A frame taken after the stream was restored is not the frame the
        // quad was measured on: its own detection first, the quad as rescue.
        if (restore === null) corners = bufferedQuad;
        else fallbackCorners = bufferedQuad;
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
      const trace: CaptureTrace | null = probing()
        ? {
            t: tappedAt,
            trigger,
            stillUsed,
            stillW,
            stillH,
            stillCrop,
            stillReason,
            previewW: video.videoWidth,
            previewH: video.videoHeight,
            visible: detect.frameBox === null ? null : { ...detect.visible },
            bufferAgeMs: grabbed?.ageMs ?? null,
            bufferedSource: grabbed?.source ?? null,
            bufferedConfidence: grabbed?.confidence ?? null,
            stillAttempt: lastStillAttempt(),
            grab,
            grabbedAt,
          }
        : null;
      if (trigger === "auto") autoFiresRef.current += 1;
      await emit(
        frame,
        corners,
        gate,
        "shutter",
        fallbackCorners,
        trace,
        grabbed?.source ?? null,
        {
          live: bufferedQuad,
          preview: { width: video.videoWidth, height: video.videoHeight },
          trigger,
          stillUsed,
          previewThumb,
          tappedAt,
          still: stillW !== null && stillH !== null ? { width: stillW, height: stillH } : null,
          stillReason,
          stillMs: still.reason === "unsupported" || still.reason === "no-track" ? null : still.ms,
          requested: still.requested,
          crop: stillCrop,
          capped,
          streamCapped: streamCappedAtTap,
          streamAtTap,
          restore,
        },
      );
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
      detect.endCapture();
      // A still just became the page: the live stream may now be capped
      // (Android Chrome, still pipeline proven) — the confirm screen is over
      // the viewfinder while the camera reconfigures.
      if (stillUsedForCap) void reconsiderStreamCap(false);
    }
  }, [copy, detect, disabled, emit, mode, pageNumber, paused, reconsiderStreamCap, restoreNativeStream]);
  autoFireRef.current = () => {
    void runCapture("auto");
  };

  const handleShutter = React.useCallback(() => {
    shutterPulse(shutterRef.current);
    void runCapture("shutter");
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

  /**
   * The one hint over the viewfinder (`lib/guidance.ts`), while it is live.
   * With no live detection on this device (it could not start, or it is too
   * slow) nothing will find the page: the tap is the way, and the slot says so.
   */
  const shownHint: HintKey | null = mode === "live" && !disabled ? (detect.available ? detect.hint : "not-found") : null;
  /** The low-light hint offers the torch where there is one and it is off. */
  const offerTorch = shownHint === "low-light" && torchAvailable && !torchOn;

  /**
   * The one prose box the frame can show, and never more than one at a time —
   * a failed capture, then "no more pages". They were separate boxes under the
   * frame; stacked, they could take a third of the viewfinder's height away and
   * hand it back a second later. (The stuck-detector tip is the hint slot's
   * "Não achei a folha" now.)
   */
  const stageNotice = message ?? (mode === "live" && disabled ? (disabledReason ?? copy.capture.capacityFallback) : null);

  // What is over the viewfinder right now, as the bench's probe names it
  // (`lib/probe.ts`) — the hint the markup below renders. Only worked out
  // while something listens: a host pays one property read.
  const shownHints = mode === "live" && probing() && shownHint !== null ? shownHint : "";
  const reportedHintsRef = React.useRef("");
  React.useEffect(() => {
    const previous = reportedHintsRef.current;
    reportedHintsRef.current = shownHints;
    if (previous === shownHints || !probing()) return;
    const before = previous === "" ? [] : previous.split(" ");
    const after = shownHints === "" ? [] : shownHints.split(" ");
    const t = performance.now();
    for (const key of before) {
      if (!after.includes(key)) probe({ type: "hint", t, key, shown: false });
    }
    for (const key of after) {
      if (!before.includes(key)) probe({ type: "hint", t, key, shown: true });
    }
  }, [shownHints]);

  // ── the diagnostics stream (`onDiagnostics`): hints, and the live loop sampled ──
  const hintShownRef = React.useRef<{ key: HintKey; at: number } | null>(null);
  React.useEffect(() => {
    if (diagnosticsSink === null) return;
    const previous = hintShownRef.current;
    if ((previous?.key ?? null) === shownHint) return;
    const now = performance.now();
    const fill = detect.diagnostics().fill;
    if (previous !== null) diagnosticsSink.emit({ type: "hint", id: previous.key, shown: false, ms: now - previous.at, fill });
    hintShownRef.current = shownHint === null ? null : { key: shownHint, at: now };
    if (shownHint !== null) diagnosticsSink.emit({ type: "hint", id: shownHint, shown: true, ms: null, fill: detect.hintFill ?? fill });
  }, [diagnosticsSink, shownHint]);

  const loopStateRef = React.useRef({ running: false, found: false });
  // Diagnostics-only state: nothing is built for it without a sink.
  if (diagnosticsSink !== null) {
    loopStateRef.current = { running: mode === "live" && !paused && !disabled && !cameraLost, found: detect.hasQuad };
  }
  const readDiagnostics = detect.diagnostics;
  React.useEffect(() => {
    if (diagnosticsSink === null || mode !== "live") return;
    /**
     * The same numbers the HUD reads, sampled no faster than the stream
     * allows: lane moves, the visible region changing, a pass sample, a
     * stall (no pass for {@link STALL_MS} while the loop should be running)
     * and the first pass after the page comes back into view.
     */
    let lane = "";
    let visibleKey = "";
    let seen = readDiagnostics().passes;
    let sampled = seen;
    let lastPassAt = performance.now();
    let stalledAt: number | null = null;
    let shownAt: number | null = null;
    const onVisibility = () => {
      if (document.visibilityState === "visible") shownAt = performance.now();
    };
    document.addEventListener("visibilitychange", onVisibility);
    const tick = () => {
      const d = readDiagnostics();
      const now = performance.now();
      const loop = loopStateRef.current;
      const laneKey = `${d.lane ?? ""}|${detectLaneReason() ?? ""}`;
      if (laneKey !== lane) {
        lane = laneKey;
        diagnosticsSink.emit({ type: "lane", lane: d.lane, reason: detectLaneReason() });
      }
      const v = d.visible;
      const key = `${v.x.toFixed(3)} ${v.y.toFixed(3)} ${v.width.toFixed(3)} ${v.height.toFixed(3)} ${d.fit}`;
      if (key !== visibleKey) {
        visibleKey = key;
        diagnosticsSink.emit({ type: "visible", x: v.x, y: v.y, width: v.width, height: v.height, fit: d.fit });
      }
      const fresh = d.passes > seen;
      seen = d.passes;
      if (fresh) {
        lastPassAt = now;
        if (stalledAt !== null) {
          diagnosticsSink.emit({ type: "stall", phase: "end", ms: now - stalledAt });
          stalledAt = null;
        }
        if (shownAt !== null) {
          diagnosticsSink.emit({ type: "camera-resume", ms: now - shownAt });
          shownAt = null;
        }
      } else if (!loop.running || document.visibilityState === "hidden" || busyRef.current) {
        // Not expected to answer: nothing is stalled.
        lastPassAt = now;
      } else if (stalledAt === null && now - lastPassAt >= STALL_MS) {
        stalledAt = lastPassAt;
        diagnosticsSink.emit({ type: "stall", phase: "start", ms: now - lastPassAt });
      }
      const answered = d.passes - sampled;
      if (answered > 0 && diagnosticsSink.passDue()) {
        sampled = d.passes;
        diagnosticsSink.emit({
          type: "pass",
          detector: d.detector,
          detectMs: d.detectMs,
          detectP50: d.detectP50,
          intervalMs: d.intervalMs,
          frameAgeMs: d.frameAgeMs,
          passes: answered,
          found: loop.found,
          locked: d.locked,
          ready: d.ready,
          autoArmed: d.autoArmed,
          why: d.blocked,
          conf: d.answer?.conf ?? null,
          rejected: d.answer?.rejected ?? null,
          paper: d.answer?.paper ?? null,
          fill: d.fill,
        });
      }
    };
    tick();
    const timer = window.setInterval(tick, PASS_SAMPLE_MS);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [diagnosticsSink, mode, readDiagnostics]);

  // The HUD reads these through a stable callback: its timer is not restarted by every render.
  const hudStateRef = React.useRef({ torch: false, autoOffered: false, autoOn: false });
  hudStateRef.current = { torch: torchAvailable, autoOffered: autoCaptureOffered, autoOn: autoCapture };
  const hudExtras = React.useCallback(
    () => ({ ...hudStateRef.current, autoFires: autoFiresRef.current, still: lastStillRef.current }),
    [],
  );

  const stage = (
      <div
        ref={stageRef}
        className={
          chrome === undefined
            ? "relative min-h-0 flex-1 overflow-hidden rounded-lg bg-shell-sunken"
            : chrome.stageClassName
        }
      >
        {/* Always mounted: the stream is attached to this node before the mode
            flips to "live", so it must exist from the first render. Kept out
            of sight by opacity, never by `display: none` or `visibility`:
            WebKit leaves a camera stream attached to a video it does not
            render without a frame for good, even once it is shown. */}
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          aria-label={copy.capture.videoLabel}
          aria-hidden={mode !== "live" || undefined}
          className={clsx(
            // `cover` fills the stage; another fit is placed by the live
            // loop (`lib/visible-region.ts`), the frame box clipped to the stage.
            detect.videoBox === null ? "absolute inset-0 h-full w-full object-cover" : "absolute object-cover",
            mode !== "live" && "pointer-events-none opacity-0",
          )}
          style={
            detect.videoBox === null
              ? undefined
              : {
                  left: detect.videoBox.left,
                  top: detect.videoBox.top,
                  width: detect.videoBox.width,
                  height: detect.videoBox.height,
                  objectPosition: `${(detect.videoBox.positionX * 100).toFixed(3)}% ${(detect.videoBox.positionY * 100).toFixed(3)}%`,
                }
          }
        />

        {/* Tapping the frame takes the photo — the caption says so, and on a
            phone it is the gesture people reach for before they find a
            shutter. Behind the chips and the caption, so neither is swallowed. */}
        {mode === "live" && !disabled && (
          <button
            type="button"
            aria-label={captureLabel}
            onClick={() => {
              void runCapture("frame");
            }}
            disabled={busy}
            className="absolute inset-0 h-full w-full cursor-pointer"
          />
        )}

        {/* Not while paused: a capture handing over to its confirm screen
            (or any sheet) covers the stage, and marks popping back under it
            are the "brackets jumping" of a capture. */}
        {mode === "live" && !detect.hasQuad && !paused && <FramingBrackets boxClassName={chrome?.framingClassName} />}

        {mode === "live" && detect.available && detect.frameBox !== null && (
          // Positioned over the *rendered* frame, not the stage: object-cover
          // crops the preview, so a 0–1 quad only lines up inside this box.
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute"
            style={{
              // The scoped reset clamps media to their container
              // (`.scan-root svg { max-width: 100% }`), and a full-bleed
              // cover box is wider than the stage: clamped, the marks were
              // drawn squeezed towards its left edge, off the page's corners.
              maxWidth: "none",
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
              {/* Ready: heavier, and inverted — a graphite mark on a light
                  halo where idle is a white mark on a dark one. Graphite
                  alone would vanish on the dark halo (1.4:1), so the halo
                  flips with it: the graphite core holds 12.7:1 on white
                  paper and 12.2:1 on its own light halo, and the light halo
                  holds 17.5:1 against a dark scene. The weight says it too,
                  for anyone who cannot tell the two apart. A change of the
                  marks themselves, never a new shape round the page. The
                  countdown (auto-capture) only runs while ready: it grows
                  along the marks from each corner as a white line inside the
                  graphite core (12.2:1 against it) — a white mark heavier
                  than the core would sink into the light halo. No
                  transition under reduced motion. */}
              <path
                ref={detect.overlay.bracketsHalo}
                d=""
                className={clsx(
                  "fill-none motion-safe:transition-[stroke,stroke-width] motion-safe:duration-150",
                  detect.ready ? "stroke-warm/90" : "stroke-night/85",
                )}
                strokeWidth={detect.ready ? 8.5 : 5.5}
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
              <path
                ref={detect.overlay.brackets}
                d=""
                className={clsx(
                  "fill-none motion-safe:transition-[stroke,stroke-width] motion-safe:duration-150",
                  detect.ready ? "stroke-ready" : "stroke-warm",
                )}
                strokeWidth={detect.ready ? 5 : 3.5}
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
              <path
                ref={detect.overlay.countdown}
                d=""
                className="fill-none stroke-warm"
                strokeWidth={2.5}
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          </svg>
        )}

        {chrome === undefined && mode === "live" && (
          // The hint slot: one hint at a time, in a box of fixed height that
          // is there whether it holds anything or not — a hint coming or
          // going never moves anything else (and the frame never resizes).
          // Polite: a screen reader hears the change after what it is saying.
          <div
            role="status"
            aria-live="polite"
            className="pointer-events-none absolute inset-x-0 top-3 flex min-h-7 flex-wrap items-center justify-center gap-1.5 px-3"
          >
            {shownHint !== null && (
              <Chip mono tone={HINT_TONE[shownHint]} className="shadow-sm">
                {hintCopy(copy.capture.hints, shownHint, detect.hintFill)}
              </Chip>
            )}
            {offerTorch && (
              // A 44 px target (the pill inside it is smaller): a near miss
              // here would land on the frame and take a photo in the dark.
              // Focus goes to the torch toggle, which stays.
              <button
                type="button"
                onClick={() => {
                  setTorchOn(true);
                  torchToggleRef.current?.focus();
                }}
                className="pointer-events-auto -my-2 inline-flex min-h-11 items-center px-1"
              >
                <span className="inline-flex items-center gap-1 rounded-full bg-shell-ink px-2.5 py-1 font-mono text-2xs leading-none text-shell-on shadow-sm">
                  <TorchIcon size={14} on />
                  {copy.capture.torchOffer}
                </span>
              </button>
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
        {chrome === undefined && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 px-3 pb-3">
          {stageNotice !== null && (
            <Notice tone="night" className="w-full shadow-lg">
              {stageNotice}
            </Notice>
          )}

          {mode === "live" && !disabled && (
            // Auto-capture on the left (when offered), the torch on the
            // right, the caption between them in a middle column that does
            // not move whether or not either control is there.
            <div className="grid w-full grid-cols-[2.75rem_1fr_2.75rem] items-center gap-2">
              {autoCaptureOffered ? (
                <button
                  type="button"
                  aria-label={copy.capture.autoCapture}
                  aria-pressed={autoCapture}
                  onClick={toggleAutoCapture}
                  className={clsx(
                    "pointer-events-auto flex h-11 w-11 flex-col items-center justify-center gap-0.5 rounded-full font-mono text-4xs leading-none shadow-sm",
                    autoCapture ? "bg-shell-ink text-shell-on" : "bg-shell-sunken/85 text-shell-ink",
                  )}
                >
                  <AutoCaptureIcon size={16} />
                  {/* Its state in words too, not only in the fill. */}
                  <span aria-hidden="true">{autoCapture ? copy.capture.autoCaptureShortOn : copy.capture.autoCaptureShort}</span>
                </button>
              ) : (
                <span aria-hidden="true" />
              )}
              <span className="flex justify-center">
                {/* On its own pill: this caption is over the camera image,
                    which is whatever the user is pointing at, so it cannot
                    take its colour from the shell the way the chrome does. */}
                <Chip mono tone="night">{copy.capture.tapToCapture}</Chip>
              </span>
              {torchAvailable ? (
                <button
                  ref={torchToggleRef}
                  type="button"
                  aria-label={copy.capture.torch}
                  aria-pressed={torchOn}
                  onClick={() => setTorchOn((on) => !on)}
                  className={clsx(
                    "pointer-events-auto flex h-11 w-11 items-center justify-center rounded-full shadow-sm",
                    torchOn ? "bg-shell-ink text-shell-on" : "bg-shell-sunken/85 text-shell-ink",
                  )}
                >
                  <TorchIcon size={18} on={torchOn} />
                </button>
              ) : (
                <span aria-hidden="true" />
              )}
            </div>
          )}
        </div>
        )}

        {/* The capture flash, driven by GSAP opacity — never a class toggle. */}
        <div
          ref={flashRef}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-shell-ink opacity-0"
        />

        {diagnostics && mode === "live" && <DiagnosticsHud read={detect.diagnostics} extras={hudExtras} />}
      </div>
  );

  if (chrome !== undefined) {
    return (
      <>
        {chrome.render({
          stage,
          mode,
          live: mode === "live" && !disabled,
          busy,
          hint:
            shownHint === null
              ? null
              : { key: shownHint, text: hintCopy(copy.capture.hints, shownHint, detect.hintFill), tone: HINT_TONE[shownHint] },
          torchOffer: offerTorch
            ? () => {
                setTorchOn(true);
                torchToggleRef.current?.focus();
              }
            : null,
          torch: {
            available: torchAvailable,
            on: torchOn,
            toggle: () => setTorchOn((on) => !on),
            ref: torchToggleRef,
          },
          autoCapture: { offered: autoCaptureOffered, on: autoCapture, toggle: toggleAutoCapture },
          ready: detect.ready,
          hasQuad: detect.hasQuad,
          notice: stageNotice,
          gallery:
            mode === "live" && !disabled && intakeImages
              ? {
                  busy,
                  onChange: (event) => {
                    void handleFile(event);
                  },
                }
              : null,
          shutter: { ref: shutterRef, label: captureLabel, busy, onClick: handleShutter },
          anchorRef: detect.overlay.anchor,
          ringRef: detect.overlay.ring,
        })}
        <canvas ref={gateCanvasRef} className="hidden" />
        <LiveRegion message={announcement} />
      </>
    );
  }

  return (
    <div className={clsx("flex min-h-0 flex-1 flex-col gap-3", className)}>
      {stage}

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
 * Each hint's chip tone: the ones that ask for a change are the quiet night
 * chip; "Não achei a folha" is the one that wants the user to act (tap), and
 * low light is a warning.
 */
const HINT_TONE: Record<HintKey, "night" | "alert" | "warning"> = {
  searching: "night",
  "not-found": "alert",
  "move-back": "night",
  center: "night",
  "move-closer": "night",
  "low-light": "warning",
  glare: "night",
  "hold-still": "night",
};

/**
 * A hint's words. "Aproxime" for a page that already nearly fills the view
 * when the hint appeared (`fill`, kept while it shows) is "Aproxime mais um
 * pouco": a small move asked for, not a big one that overshoots.
 */
function hintCopy(hints: ReturnType<typeof useCopy>["capture"]["hints"], key: HintKey, fill: number | null): string {
  switch (key) {
    case "searching":
      return hints.searching;
    case "not-found":
      return hints.notFound;
    case "move-back":
      return hints.moveBack;
    case "center":
      return hints.center;
    case "move-closer":
      return fill !== null && fill >= FILL_NEAR ? hints.moveCloserNear : hints.moveCloser;
    case "low-light":
      return hints.lowLight;
    case "glare":
      return hints.glare;
    case "hold-still":
      return hints.holdStill;
  }
}

/** The track advertises a torch (`getCapabilities`, where the browser has it). */
function hasTorch(track: MediaStreamTrack | null): boolean {
  if (track === null || typeof track.getCapabilities !== "function") return false;
  try {
    return (track.getCapabilities() as MediaTrackCapabilities & { torch?: boolean }).torch === true;
  } catch {
    return false;
  }
}

/**
 * Switch the torch; a refusal (or a browser without the constraint) costs
 * only the light. Answers whether the torch is now as asked — read back from
 * the track's settings where the browser reports them.
 */
async function applyTorch(track: MediaStreamTrack, on: boolean): Promise<boolean> {
  if (track.readyState !== "live" || typeof track.applyConstraints !== "function") return !on;
  try {
    await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
  } catch {
    return !on;
  }
  try {
    const lit = (track.getSettings() as MediaTrackSettings & { torch?: boolean }).torch;
    return lit === undefined || lit === on;
  } catch {
    return true;
  }
}

/**
 * The still photo onto the page grid, and its memory straight back.
 *
 * A full-resolution `ImageBitmap` is tens of megabytes of GPU-side image; once
 * it has been drawn there is no reason for both it and the canvas to exist, and
 * on the phones this app is built for that pair is the allocation that fails.
 */
function drawStill(still: ImageBitmap, crop: StillCrop): { canvas: HTMLCanvasElement; capped: boolean } {
  try {
    return bitmapToCanvas(still, crop);
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
function FramingBrackets({ boxClassName }: { boxClassName?: string }) {
  // Always light with a dark shadow, whatever the shell: these are drawn over
  // the camera image, and a dark bracket in a dark room is no bracket at all.
  const common =
    "pointer-events-none absolute h-7 w-7 text-warm drop-shadow-[0_1px_3px_rgba(0,0,0,0.85)]";
  // The box the four marks sit in: the whole stage on the `standard` screen; a
  // full-bleed layout insets it clear of the chrome drawn over its stage.
  return (
    <div aria-hidden="true" className={clsx("pointer-events-none absolute", boxClassName ?? "inset-0")}>
      <Bracket className={clsx(common, "left-4 top-4")} d="M2 10V4.5A2.5 2.5 0 0 1 4.5 2H10" />
      <Bracket className={clsx(common, "right-4 top-4")} d="M26 10V4.5A2.5 2.5 0 0 0 23.5 2H18" />
      <Bracket className={clsx(common, "bottom-4 left-4")} d="M2 18v5.5A2.5 2.5 0 0 0 4.5 26H10" />
      <Bracket className={clsx(common, "bottom-4 right-4")} d="M26 18v5.5A2.5 2.5 0 0 1 23.5 26H18" />
    </div>
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
