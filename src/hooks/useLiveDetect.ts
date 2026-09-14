"use client";

/**
 * The live viewfinder: scanic looking for the page in the camera preview, many
 * times a second, so the user sees the app *find* their document instead of
 * guessing whether the photo will come out straight.
 *
 * **Capture is manual, always.** Nothing here ever takes a photo: the person
 * holding the phone decides when it is taken, and the shutter and the frame tap
 * are the only two things that fire one. What this hook does is *find* the page
 * and show the user it has.
 *
 * Two loops and an adaptive throttle, all of it in refs:
 *
 *  1. **Detection** — a self-scheduling chain (never `setInterval`: a slow pass
 *     must not queue up behind itself), single-flight by construction, sampling
 *     the video into ONE reused canvas at ~640 px. **The pass is scanic's ML
 *     corner model**: opening this screen starts its ~3.4 MB of model
 *     and WASM downloading straight away, and from the moment that runtime is
 *     warm the model *is* the loop. The classical detector runs in its place
 *     until then, so the viewfinder is never dead on a slow connection, and it
 *     takes back over for the rest of the session if anything about the ML path
 *     fails — an asset that will not load, a runtime that will not compile, a
 *     device the inference is measurably too slow on. Silently, either way:
 *     nothing the user could have done changed. Whichever detector is running,
 *     the chain measures it and adapts — slow → half the rate; hopeless →
 *     classical loses the feature for the session (the screen falls back to the
 *     static framing brackets) and ML instead hands back to classical.
 *  2. **Animation** — a rAF that eases the drawn quad toward the newest
 *     detection (35 % per frame) and cross-fades it in and out, writing the
 *     `d` attribute of the overlay's two bracket paths directly. No React state
 *     per frame: at 60 fps that would re-render the whole capture screen sixty
 *     times a second.
 *
 * Everything here stops when the tab is hidden, the camera track ends, a
 * capture is in flight or a sheet covers the viewfinder — and stopping *drops
 * what it was tracking*, overlay included. A quad describes one frame of one
 * live preview; kept across a pause it would be drawn by a loop that is no
 * longer running and offered to a capture taken seconds later.
 */

import * as React from "react";
import {
  detectOnCanvas,
  detectOnCanvasMl,
  disableMlDetection,
  isMlDetectionBusy,
  isMlDetectionDisabled,
  isMlDetectionReady,
  MIN_QUAD_AREA_FRACTION,
  type DetectionSource,
  type FrameDetection,
} from "@/lib/flatten";
import { loadScanic } from "@/lib/scanic-runtime";
import {
  coverageFloor,
  isMlResultFresh,
  ML_CADENCE_MS,
  ML_CALL_BUDGET_MS,
  ML_HOPELESS_PASS_MS,
  ML_SLOW_PASS_MS,
  ML_WARM_UP_BUDGET_MS,
  primaryDetector,
  shouldWarmUpMl,
  supersedesDetection,
  type DetectionCandidate,
} from "@/lib/ml-detection";
import {
  frameMotionScore,
  motionBreaksHold,
  probeLuma,
} from "@/lib/frame-motion";
import { prefersReducedMotion } from "@/lib/motion";
import {
  cornerBracketPath,
  lerpQuad,
  normalizedCoverage,
  normalizeQuad,
  QuadDetectionSmoother,
  type BracketCap,
  type NormalizedQuad,
} from "@/lib/quad";
import { useAssetUrls } from "@/hooks/useScanRuntime";
import { CAPTURE_GRACE_MS } from "@/lib/still-capture";

/**
 * The window inside which the last *accepted* corners may still travel with a
 * capture, even though the loop has since stopped tracking them.
 *
 * Chosen so that a focus flicker immediately before the tap plus a full
 * still-photo budget cannot together cost the user the quad they were looking
 * at — the two together are what the live path actually spends. Owned by
 * `lib/still-capture.ts` (the capture path is what consumes it) and re-exported
 * here because {@link LiveDetect.takeQuadForCapture} is the gate that enforces
 * it; a hook that imported it back from the capture path would be a cycle.
 */
export { CAPTURE_GRACE_MS };

/** Long edge of the frames detection runs on — never the full preview. */
const SAMPLE_LONG_EDGE = 640;
/** The first passes of either detector carry warm-up costs: not "slow". */
const WARMUP_PASSES = 2;

/**
 * What one detector's passes cost and how the loop is allowed to react.
 *
 * The two detectors are different workloads — a contour trace at ~8 fps against
 * a 640 px inference at ~1.4 — so every number the adaptive throttle reads is
 * per detector, and the measurements are thrown away at a handover rather than
 * averaged across one.
 */
interface PassProfile {
  /** Where the cadence starts, before any backing off. */
  intervalMs: number;
  /** The slowest this detector will ever be polled. */
  slowestIntervalMs: number;
  /** Rolling average above this: halve the rate. */
  slowMs: number;
  /** Rolling average above this: this device cannot run this detector live. */
  hopelessMs: number;
  /** How long we wait on one pass before abandoning it (it still finishes). */
  budgetMs: number;
}

const PASS_PROFILES: Record<DetectionSource, PassProfile> = {
  classical: {
    intervalMs: 125,
    slowestIntervalMs: 1000,
    slowMs: 90,
    hopelessMs: 250,
    budgetMs: 2000,
  },
  ml: {
    intervalMs: ML_CADENCE_MS,
    slowestIntervalMs: 2000,
    slowMs: ML_SLOW_PASS_MS,
    hopelessMs: ML_HOPELESS_PASS_MS,
    budgetMs: ML_CALL_BUDGET_MS,
  },
};

/** How much of the remaining distance the drawn quad covers each frame. */
const LERP_FACTOR = 0.35;
const FADE_IN_MS = 200;
const FADE_OUT_MS = 300;
/** No successful detection for this long and the page is considered lost. */
const QUAD_STALE_MS = 700;

/**
 * How long a tracked quad survives without a fresh detection behind it.
 *
 * A quad the *model* found gets the classical horizon plus the beat it is
 * actually being polled at — the current one, not the nominal cadence, because
 * a device that has been throttled answers more slowly still. Retiring it at the
 * classical horizon would blink the overlay off between two perfectly good ML
 * detections.
 *
 * The horizon only carries a **stationary** page: a missed pass whose motion
 * probe says the scene moved ends the hold immediately
 * (`lib/frame-motion.ts`) — time is the wrong test for a quad the user just
 * swung away from.
 */
function staleHorizonMs(source: DetectionSource, intervalMs: number): number {
  return source === "ml"
    ? QUAD_STALE_MS + Math.max(ML_CADENCE_MS, intervalMs)
    : QUAD_STALE_MS;
}
/** Nothing found for this long → the gentle "aim at the document" chip. */
const SEARCHING_AFTER_MS = 2500;

/**
 * How much of its own edge each corner bracket runs along, and the ceiling on
 * that in real pixels.
 *
 * Proportional so a small quad gets small marks; capped so a page filling the
 * frame gets four corner marks rather than four half-edges, which would be the
 * boxed-in outline the brackets exist to replace. The cap travels with the
 * measured frame box and is converted per segment (`cornerBracketPath`), because
 * `preserveAspectRatio: none` stretches the two axes differently and a single
 * normalized number is 28 px on one of them and something else on the other.
 */
const BRACKET_EDGE_FRACTION = 0.12;
const BRACKET_CAP_PX = 28;
/** Used until the frame has been measured — ~9 % of the frame. */
const BRACKET_CAP_FALLBACK = 0.09;

/** Where the preview actually renders inside the stage, after object-cover. */
export interface FrameBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Runtime {
  /** The newest accepted detection. */
  target: NormalizedQuad | null;
  /** What is drawn: eased toward `target`, and what a capture warps with. */
  current: NormalizedQuad | null;
  opacity: number;
  /**
   * The newest accepted detection: which detector found it, how sure it was,
   * and **the time of the frame it describes**.
   *
   * Dated by that frame rather than by the moment it was answered: a pass can
   * take two seconds, and a quad timestamped at completion would let a capture
   * warp with corners measured a frame stream ago.
   */
  tracked: DetectionCandidate | null;
  /**
   * The last quad this loop ACCEPTED, kept past the moment it stops being drawn.
   *
   * `target`/`current` describe what is on screen right now and are retired the
   * instant detection flickers — correct for an overlay, ruinous for a capture,
   * because the tap lands milliseconds after the flicker and the still pipeline
   * then burns up to its whole budget on top. This is the buffer that survives
   * both, and {@link CAPTURE_GRACE_MS} is the only thing keeping it honest.
   *
   * It is the accepted `target` rather than the eased `current`: `current` is a
   * frame of an animation on its way somewhere, and a capture wants the
   * measurement, not the tween. It is cleared by {@link clearTracking} like
   * everything else — corners from a paused or torn-down viewfinder never travel
   * with a photo.
   */
  lastAccepted: { quad: NormalizedQuad; capturedAt: number } | null;
  lastFrameAt: number;
  loopStartedAt: number;
  detecting: boolean;
  /** Which detector the chain is currently running, and measuring. */
  passSource: DetectionSource;
  intervalMs: number;
  averageMs: number | null;
  warmupLeft: number;
  /**
   * The eager ML warm-up has been launched this page-session.
   *
   * Per session rather than per attempt: the download and the WASM compile are
   * facts about the page, not about this camera start or this capture.
   */
  mlWarmUpStarted: boolean;
  /** Removes adjacent-frame edge toggles before they reach the animation. */
  smoother: QuadDetectionSmoother;
  /**
   * The detection loop is running right now.
   *
   * A capture reads `takeQuadForCapture()` synchronously, so this is what stops corners
   * from a paused or torn-down viewfinder — a sheet that was just closed, a
   * camera that went away — from travelling with a photo taken before the first
   * fresh pass lands.
   */
  live: boolean;
  /**
   * The question the detached ML warm-up is answering, bumped whenever it
   * changes — a new page, a loop restart, a fail-closed handover. A pass that
   * answers into a different epoch is describing a question nobody is asking
   * any more.
   */
  mlEpoch: number;
  /**
   * The previous pass's motion probe (`lib/frame-motion.ts`), compared against
   * each new pass's to tell a detection dropout on a still scene (keep the
   * hold) from one on a moved scene (end it). Reset on loop start so a
   * pause never pairs two probes that are minutes apart.
   */
  motionProbe: Uint8ClampedArray | null;
}

function freshRuntime(): Runtime {
  return {
    target: null,
    current: null,
    opacity: 0,
    tracked: null,
    lastAccepted: null,
    lastFrameAt: 0,
    loopStartedAt: 0,
    detecting: false,
    passSource: "classical",
    intervalMs: PASS_PROFILES.classical.intervalMs,
    averageMs: null,
    warmupLeft: WARMUP_PASSES,
    mlWarmUpStarted: false,
    smoother: new QuadDetectionSmoother(),
    live: false,
    mlEpoch: 0,
    motionProbe: null,
  };
}

/**
 * Move the chain onto a detector, throwing away what was measured of the other.
 *
 * A rolling average that spans a handover describes neither workload, and the
 * first pass of the detector being handed to carries its own warm-up (an ORT
 * session on the way up, a cold contour trace on the way back down).
 */
function switchDetector(runtime: Runtime, source: DetectionSource): void {
  runtime.passSource = source;
  runtime.intervalMs = PASS_PROFILES[source].intervalMs;
  runtime.averageMs = null;
  runtime.warmupLeft = WARMUP_PASSES;
}

/**
 * Drop everything the overlay and a capture could still be reading.
 *
 * Called the moment tracking stops being live — paused behind a sheet, camera
 * gone, device written off — because every one of these outlives the loop that
 * produced it: the drawn `d` and the group's opacity are DOM the rAF is no
 * longer there to update, and `current`/`tracked`/`lastAccepted` are what
 * `takeQuadForCapture()` hands to the next photo.
 *
 * `lastAccepted` deliberately goes with them. It is built to outlive a
 * *detection flicker*, never a stopped loop: a viewfinder that was paused behind
 * a sheet or torn down has no claim on the next capture at all.
 */
function clearTracking(runtime: Runtime, overlay: LiveOverlayRefs): void {
  runtime.target = null;
  runtime.current = null;
  runtime.opacity = 0;
  runtime.tracked = null;
  runtime.lastAccepted = null;
  runtime.smoother.reset();
  overlay.bracketsHalo.current?.setAttribute("d", "");
  overlay.brackets.current?.setAttribute("d", "");
  const group = overlay.group.current;
  if (group !== null) group.style.opacity = "0";
}

export interface UseLiveDetectOptions {
  videoRef: React.MutableRefObject<HTMLVideoElement | null>;
  /** The stage the preview fills — the overlay is positioned inside it. */
  containerRef: React.MutableRefObject<HTMLElement | null>;
  /** Live camera, not at capacity: the loop only exists while this is true. */
  active: boolean;
  /** Frozen without being torn down: capture in flight, sheet open, tab hidden. */
  paused: boolean;
}

/**
 * The two painted elements of the live overlay, plus the group that fades.
 *
 * **Corner brackets only — there is never a perimeter.** The brackets sit on
 * the detected corners, so they say where the page is and how it is tilted, and
 * the mandatory confirm-corners screen is what actually protects the user from
 * a miscrop.
 *
 * They are separate refs rather than one queried subtree because the paint runs
 * on every animation frame: a `querySelector` per frame is a lookup the browser
 * repeats sixty times a second for an answer that never changes.
 *
 * The bracket path is drawn twice — a dark halo first, the warm mark over it —
 * so the overlay reads against white paper and a dark desk alike, which a single
 * light stroke with a drop shadow does not.
 */
export interface LiveOverlayRefs {
  /** Carries the fade. Give it `opacity: 0` at rest. */
  group: React.MutableRefObject<SVGGElement | null>;
  /** The four corner brackets, halo under them. Both take `d`. */
  bracketsHalo: React.MutableRefObject<SVGPathElement | null>;
  brackets: React.MutableRefObject<SVGPathElement | null>;
}

export interface LiveDetect {
  /** False once the device proved too slow — the brackets take over. */
  available: boolean;
  /** A page is being tracked right now. */
  hasQuad: boolean;
  /** Nothing has been found for a couple of seconds. */
  searching: boolean;
  frameBox: FrameBox | null;
  /** The nodes this hook paints. Put them in a `0 0 1 1` viewBox. */
  overlay: LiveOverlayRefs;
  /**
   * The last accepted corners, for a capture that could not measure its own.
   *
   * Answers `null` outside {@link CAPTURE_GRACE_MS}, and the age alongside the
   * quad so the caller can charge its own shutter time against that window
   * before using it.
   */
  takeQuadForCapture: () => { quad: NormalizedQuad; ageMs: number } | null;
  /** A capture just happened: the next page is a new question for the ML policy. */
  noteCapture: () => void;
}

export function useLiveDetect({
  videoRef,
  containerRef,
  active,
  paused,
}: UseLiveDetectOptions): LiveDetect {
  /**
   * Where the corner-detection model lives. Read from the flow's runtime rather
   * than taken as an option: the capture screen has no business knowing about
   * asset paths, and a detection loop that had to be handed a URL by its parent
   * would put that URL in every component between here and `<ScanFlow>`.
   */
  const assets = useAssetUrls();
  const assetsRef = React.useRef(assets);
  assetsRef.current = assets;

  const runtimeRef = React.useRef<Runtime>(freshRuntime());
  const groupRef = React.useRef<SVGGElement | null>(null);
  const bracketsHaloRef = React.useRef<SVGPathElement | null>(null);
  const bracketsRef = React.useRef<SVGPathElement | null>(null);
  // One stable object so the consumer can spread it into JSX without giving the
  // stage a new set of ref identities on every render.
  const overlay = React.useMemo<LiveOverlayRefs>(
    () => ({
      group: groupRef,
      bracketsHalo: bracketsHaloRef,
      brackets: bracketsRef,
    }),
    [],
  );
  const sampleRef = React.useRef<HTMLCanvasElement | null>(null);
  /** The 24×24 scratch the motion probe redraws every pass. */
  const motionScratchRef = React.useRef<HTMLCanvasElement | null>(null);
  /**
   * The warm-up pass gets its own copy of the frame.
   *
   * It is the one ML pass that runs detached from the detection chain — it
   * carries the multi-megabyte download, and the classical detector has to keep
   * answering the whole time — so by the time it reads its input the chain has
   * long since redrawn `sampleRef` with a newer frame. Every pass after it is
   * the chain's own and detects on `sampleRef` directly.
   */
  const mlSampleRef = React.useRef<HTMLCanvasElement | null>(null);
  const reducedRef = React.useRef(false);
  /** The measured frame box, for the bracket cap — the state copy is for React. */
  const frameBoxRef = React.useRef<FrameBox | null>(null);

  const [available, setAvailable] = React.useState(true);
  const [hasQuad, setHasQuad] = React.useState(false);
  const [searching, setSearching] = React.useState(false);
  const [frameBox, setFrameBox] = React.useState<FrameBox | null>(null);
  const [tabHidden, setTabHidden] = React.useState(false);

  // A hidden tab still ticks timers on some Androids; detecting into a frozen
  // preview would burn battery for nothing.
  React.useEffect(() => {
    const sync = (): void => {
      setTabHidden(document.visibilityState === "hidden");
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  // Read after mount only: on the server this would answer "reduce" and the
  // markup would disagree with the client's.
  React.useEffect(() => {
    reducedRef.current = prefersReducedMotion();
  }, []);

  /** The rendered video box, which object-cover crops out of the stage. */
  const measure = React.useCallback(() => {
    const video = videoRef.current;
    const host = containerRef.current;
    if (video === null || host === null) return;
    if (video.videoWidth === 0 || video.videoHeight === 0) return;
    const rect = host.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const scale = Math.max(
      rect.width / video.videoWidth,
      rect.height / video.videoHeight,
    );
    const width = video.videoWidth * scale;
    const height = video.videoHeight * scale;
    const next: FrameBox = {
      left: (rect.width - width) / 2,
      top: (rect.height - height) / 2,
      width,
      height,
    };
    frameBoxRef.current = next;
    setFrameBox((previous) =>
      previous !== null &&
      Math.abs(previous.left - next.left) < 0.5 &&
      Math.abs(previous.top - next.top) < 0.5 &&
      Math.abs(previous.width - next.width) < 0.5 &&
      Math.abs(previous.height - next.height) < 0.5
        ? previous
        : next,
    );
  }, [containerRef, videoRef]);

  React.useEffect(() => {
    if (!active) return;
    const video = videoRef.current;
    const host = containerRef.current;
    measure();
    const observer =
      typeof ResizeObserver === "function" && host !== null
        ? new ResizeObserver(() => measure())
        : null;
    if (observer !== null && host !== null) observer.observe(host);
    video?.addEventListener("loadedmetadata", measure);
    video?.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      video?.removeEventListener("loadedmetadata", measure);
      video?.removeEventListener("resize", measure);
    };
  }, [active, containerRef, measure, videoRef]);

  // Nothing to track while the loop is not running — the stage is gone, a sheet
  // covers it, the tab is hidden, the device was written off. Everything the
  // last pass left behind goes now: it would otherwise be drawn by nobody,
  // outlive the frame it describes, and still be there for the next capture.
  const loopLive = active && !paused && !tabHidden && available;
  React.useEffect(() => {
    if (loopLive) return;
    const runtime = runtimeRef.current;
    runtime.live = false;
    clearTracking(runtime, overlay);
    runtime.mlEpoch += 1;
    setHasQuad(false);
    setSearching(false);
  }, [loopLive, overlay]);

  const noteCapture = React.useCallback(() => {
    // The next page is a new question, so a warm-up pass still in flight over
    // the sheet that was just photographed no longer has one to answer. The
    // download itself is untouched — it is a fact about the page.
    runtimeRef.current.mlEpoch += 1;
  }, []);

  /**
   * The corners a capture may fall back on, and how old they already are.
   *
   * Only a loop that is running right now can vouch for these corners, and the
   * quad must cover enough of the frame to be a page. The overlay's stale
   * horizon is replaced by {@link CAPTURE_GRACE_MS}, because that horizon is about what may
   * still be *drawn* and this is about what the user was looking at when they
   * tapped. The age travels with the quad rather than being resolved here: the
   * caller is about to spend more time still (a photo pipeline that can burn a
   * second and a half), and only it can add that leg before asking
   * `liveQuadSurvives` the real question.
   */
  const takeQuadForCapture = React.useCallback((): {
    quad: NormalizedQuad;
    ageMs: number;
  } | null => {
    const runtime = runtimeRef.current;
    const buffered = runtime.lastAccepted;
    if (!runtime.live || buffered === null) return null;
    const ageMs = performance.now() - buffered.capturedAt;
    if (ageMs < 0 || ageMs > CAPTURE_GRACE_MS) return null;
    // The buffer was accepted by `accept`, so it is judged by the same
    // conditioned floor it cleared there — `tracked` is the candidate that
    // produced it.
    const floor = coverageFloor(
      runtime.tracked?.source ?? "classical",
      runtime.tracked?.confidence ?? null,
      MIN_QUAD_AREA_FRACTION,
    );
    if (normalizedCoverage(buffered.quad) < floor) return null;
    return { quad: buffered.quad, ageMs };
  }, []);

  React.useEffect(() => {
    if (!loopLive) return;
    const runtime = runtimeRef.current;
    let cancelled = false;
    let detectTimer: number | null = null;
    let frameHandle: number | null = null;
    let trackedQuad = false;
    let announcedSearching = false;
    runtime.mlEpoch += 1;
    runtime.live = true;
    // A probe kept across a pause would pair two frames minutes apart and read
    // the difference as a swing; the loop re-learns stillness from scratch.
    runtime.motionProbe = null;
    // Whichever detector the session is on, this loop starts measuring it from
    // scratch: a camera that was just restarted is not the device the last
    // attempt's rolling average describes.
    switchDetector(
      runtime,
      primaryDetector({
        ready: isMlDetectionReady(),
        disabled: isMlDetectionDisabled(),
      }),
    );

    // ── 1. detection chain ───────────────────────────────────────────────────

    /** The reused sample canvas, redrawn from the preview on every pass. */
    function sample(video: HTMLVideoElement): HTMLCanvasElement | null {
      const scale = Math.min(
        1,
        SAMPLE_LONG_EDGE / Math.max(video.videoWidth, video.videoHeight),
      );
      const width = Math.max(1, Math.round(video.videoWidth * scale));
      const height = Math.max(1, Math.round(video.videoHeight * scale));
      const canvas = sampleRef.current ?? document.createElement("canvas");
      sampleRef.current = canvas;
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (context === null) return null;
      context.drawImage(video, 0, 0, width, height);
      return canvas;
    }

    function scheduleDetect(delayMs: number): void {
      if (cancelled) return;
      detectTimer = window.setTimeout(() => {
        detectTimer = null;
        void detect();
      }, Math.max(0, delayMs));
    }

    /**
     * Hand the session back to the classical detector, for good.
     *
     * Every ML failure converges here — a runtime that will not load, a pass
     * that blew its budget, a device the inference is measurably too slow on.
     * The latch is what stops the next pass from being an ML one; the epoch bump
     * withdraws the question any pass still in flight was answering; the profile
     * switch throws away an average that describes a workload this loop is no
     * longer running.
     */
    function fallBackToClassical(): void {
      disableMlDetection();
      runtime.mlEpoch += 1;
      switchDetector(runtime, "classical");
    }

    /**
     * Slow devices lose rate; hopeless ones lose the detector.
     *
     * What "lose the detector" means is the one thing that differs between the
     * two: the model hands back to the classical loop, while a classical loop
     * measured as hopeless is the end of live detection on this device and the
     * screen falls back to the static framing brackets.
     */
    function adapt(elapsedMs: number, profile: PassProfile): boolean {
      if (runtime.warmupLeft > 0) {
        runtime.warmupLeft -= 1;
        return true;
      }
      runtime.averageMs =
        runtime.averageMs === null
          ? elapsedMs
          : runtime.averageMs * 0.7 + elapsedMs * 0.3;
      if (runtime.averageMs > profile.hopelessMs) {
        if (runtime.passSource === "ml") {
          fallBackToClassical();
          return true;
        }
        setAvailable(false);
        return false;
      }
      if (
        runtime.averageMs > profile.slowMs &&
        runtime.intervalMs < profile.slowestIntervalMs
      ) {
        runtime.intervalMs = Math.min(
          profile.slowestIntervalMs,
          runtime.intervalMs * 2,
        );
        // Re-measure at the new cadence instead of doubling again immediately.
        runtime.averageMs = null;
      }
      return true;
    }

    /**
     * One pass, with whichever detector this session is on. Answers the delay
     * before the next one, or null to stop the loop for good — which only the
     * classical detector may say: a device measured as hopeless, and a pass that
     * blew its budget (the same conclusion, sooner). The model saying either
     * hands the loop back rather than ending it.
     */
    async function runPass(): Promise<number | null> {
      const video = videoRef.current;
      // Single-flight: the chain only ever schedules itself once a pass ends,
      // and this guard is the belt to that pair of braces.
      if (runtime.detecting || video === null || video.videoWidth === 0) {
        return runtime.intervalMs;
      }
      // The handover, in one place: the warm-up settling promotes the model, a
      // latched failure demotes it, and the throttle starts measuring the
      // detector it is actually running.
      const source = primaryDetector({
        ready: isMlDetectionReady(),
        disabled: isMlDetectionDisabled(),
      });
      if (source !== runtime.passSource) switchDetector(runtime, source);
      const profile = PASS_PROFILES[source];
      runtime.detecting = true;
      const started = performance.now();
      let detection: FrameDetection | null = null;
      let canvasWidth = 0;
      let canvasHeight = 0;
      let motionScore: number | null = null;
      try {
        const canvas = sample(video);
        if (canvas !== null) {
          canvasWidth = canvas.width;
          canvasHeight = canvas.height;
          // The motion probe reads the same frame the detector is about to —
          // probed before the await so the comparison is between what the two
          // passes actually saw, not whatever the preview shows afterwards.
          const scratch =
            motionScratchRef.current ?? document.createElement("canvas");
          motionScratchRef.current = scratch;
          const luma = probeLuma(canvas, scratch);
          if (luma !== null) {
            motionScore = frameMotionScore(runtime.motionProbe, luma);
            runtime.motionProbe = luma;
          }
          // The chain's own frame is safe to hand either detector directly:
          // nothing redraws it until this pass has answered.
          detection =
            source === "ml"
              ? await detectOnCanvasMl(canvas, profile.budgetMs, assetsRef.current)
              : await detectOnCanvas(canvas, profile.budgetMs, assetsRef.current);
        }
      } finally {
        runtime.detecting = false;
      }
      if (cancelled) return null;
      const elapsed = performance.now() - started;
      // The pass blew through its budget, so its real work is still running
      // somewhere behind us — the ONE way two detections could overlap. For the
      // classical detector that is also proof this device has no business doing
      // live detection, and ending the loop keeps the single-flight guarantee
      // absolute; for the model, the same guarantee is kept by never running it
      // again this session.
      if (elapsed >= profile.budgetMs) {
        if (source !== "ml") {
          setAvailable(false);
          return null;
        }
        fallBackToClassical();
        return runtime.intervalMs;
      }
      // The frame this describes is the one `sample` drew, not the moment the
      // detector got round to answering.
      accept(detection, canvasWidth, canvasHeight, started);
      // A missed detection on a moved scene ends the hold: the stale
      // horizon exists to carry a stationary page through a flicker, and the
      // probe is what proves the page was not stationary. The capture buffer
      // goes with it — corners measured before a swing must not travel with a
      // photo taken after it. A missed detection on a *still* scene changes
      // nothing; that is the flicker the hold was built for.
      if (detection === null && motionBreaksHold(motionScore)) {
        runtime.target = null;
        runtime.tracked = null;
        runtime.lastAccepted = null;
      }
      if (!adapt(elapsed, profile)) return null;
      // Deliberately after `adapt`: the warm-up is detached and carries a
      // multi-megabyte download, so nothing it costs may reach the average that
      // decides whether live detection is possible on this device at all.
      try {
        maybeWarmUpMl(video);
      } catch {
        // An ML-only failure — the frame copy, the launch — is a fact about
        // this device or this deploy, exactly like a runtime that will not
        // load. The classical loop is untouched by it, which is the point.
        fallBackToClassical();
      }
      return runtime.intervalMs - elapsed;
    }

    async function detect(): Promise<void> {
      if (cancelled) return;
      let delayMs: number | null;
      try {
        delayMs = await runPass();
      } catch {
        // A frame that could not be grabbed — a canvas the phone would not
        // allocate this instant, a context it refused — is a fact about this
        // pass, never about the next one. The loop keeps its own cadence
        // rather than dying quietly behind an `available` that still says yes.
        delayMs = runtime.intervalMs;
      }
      if (delayMs !== null) scheduleDetect(delayMs);
    }

    /**
     * Take a detection the loop is willing to track. True when it was accepted.
     *
     * A miss is not a loss: the animation loop retires a quad on staleness, so
     * one dropped detection doesn't make the overlay blink. Only capture-worthy
     * page candidates are drawn — smaller contours are usually text blocks and
     * made the overlay jump — and the coverage gate is also the ONLY thing
     * bounding an ML quad, whose detector ignores `minDocumentCoverageRatio`.
     *
     * `capturedAt` is when the *frame* was sampled. Everything downstream — the
     * stale horizon, `takeQuadForCapture`, the arbitration between the two detectors —
     * reads that rather than the moment the detector answered, because the two
     * can be seconds apart and it is the frame the corners describe.
     */
    function accept(
      detection: FrameDetection | null,
      width: number,
      height: number,
      capturedAt: number,
    ): boolean {
      if (detection === null) return false;
      const quad = normalizeQuad(detection.corners, width, height);
      // Conditioned like the capture path: a page that fills the visible
      // object-cover window can still be well under 0.35 of the full 16:9 frame
      // this loop samples, and holding a sure model to the classical floor is
      // what made the brackets flash on and off over a perfectly framed page.
      const floor = coverageFloor(
        detection.source,
        detection.confidence,
        MIN_QUAD_AREA_FRACTION,
      );
      if (quad === null || normalizedCoverage(quad) < floor) {
        return false;
      }
      const now = performance.now();
      const candidate: DetectionCandidate = {
        source: detection.source,
        confidence: detection.confidence,
        capturedAt,
      };
      const authorityMs = staleHorizonMs("ml", runtime.intervalMs);
      if (!supersedesDetection(candidate, runtime.tracked, now, authorityMs)) {
        return false;
      }
      runtime.target = runtime.smoother.update(quad, now);
      runtime.tracked = candidate;
      // The capture buffer takes the accepted target, dated by the frame it
      // describes — the same clock the stale horizon reads, so an age computed
      // against it means what a capture thinks it means.
      runtime.lastAccepted = { quad: runtime.target, capturedAt };
      return true;
    }

    /**
     * The ~640 px frame the warm-up pass owns for as long as it is running.
     *
     * Reusing one canvas is safe because `detectOnCanvasMl` is single-flight
     * over the *underlying* inference: no second pass can be reading this one
     * while it is being redrawn.
     */
    function copyForMl(): HTMLCanvasElement | null {
      const source = sampleRef.current;
      if (source === null) return null;
      const canvas = mlSampleRef.current ?? document.createElement("canvas");
      mlSampleRef.current = canvas;
      if (canvas.width !== source.width) canvas.width = source.width;
      if (canvas.height !== source.height) canvas.height = source.height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (context === null) return null;
      context.drawImage(source, 0, 0);
      return canvas;
    }

    /**
     * Start the model, on the first frame this screen ever sampled.
     *
     * Eager: nothing has to go wrong first, because the model is the
     * primary detector and the only reason it is not already running is that
     * ~3.4 MB of it is still arriving. Exactly one pass gets launched this way —
     * every later one is the chain's own, on the beat the throttle sets.
     *
     * Detached on purpose. This pass downloads the model and compiles the WASM,
     * and the classical detector must keep answering the whole time: a
     * viewfinder that goes dead for the seconds of a download on a 3G phone is
     * the failure this is meant to avoid, not one it may cause.
     *
     * Detached also means the answer arrives into a session that may have moved
     * on, so its corners land only if the frame they describe is still recent
     * *and* the epoch they were launched under is still the question being
     * asked. Landing nothing is fine — the assets are warm either way, and that
     * is what this pass was really for.
     */
    function maybeWarmUpMl(video: HTMLVideoElement): void {
      const started = shouldWarmUpMl(
        {
          ready: isMlDetectionReady(),
          disabled: isMlDetectionDisabled(),
        },
        runtime.mlWarmUpStarted,
      );
      if (!started || isMlDetectionBusy()) return;
      const canvas = copyForMl();
      if (canvas === null) return;
      const width = canvas.width;
      const height = canvas.height;
      const now = performance.now();
      const epoch = runtime.mlEpoch;
      runtime.mlWarmUpStarted = true;
      void detectOnCanvasMl(canvas, ML_WARM_UP_BUDGET_MS, assetsRef.current).then((detection) => {
        // A pass that ran long describes a frame that has gone, and one that
        // answers into a different epoch is answering a question that has been
        // withdrawn; either way all it leaves behind is a warm session.
        if (cancelled || runtime.mlEpoch !== epoch) return;
        if (!isMlResultFresh(now, performance.now())) return;
        if (video.videoWidth === 0) return;
        accept(detection, width, height, now);
      });
      // `detectOnCanvasMl` never rejects — it answers null and latches itself
      // off — so there is no rejection path to swallow here.
    }

    // ── 2. animation ─────────────────────────────────────────────────────────

    /** The bracket ceiling, against the box the overlay is stretched onto. */
    function bracketCap(): BracketCap {
      const box = frameBoxRef.current;
      if (box === null || box.width <= 0 || box.height <= 0) {
        // Nothing measured yet: a square box makes the fallback a plain
        // fraction of the frame, which is what it is.
        return { length: BRACKET_CAP_FALLBACK, width: 1, height: 1 };
      }
      return { length: BRACKET_CAP_PX, width: box.width, height: box.height };
    }

    function paint(): void {
      const group = overlay.group.current;
      if (group === null) return;
      const quad = runtime.current;
      if (quad !== null) {
        const brackets = cornerBracketPath(
          quad,
          BRACKET_EDGE_FRACTION,
          bracketCap(),
        );
        overlay.bracketsHalo.current?.setAttribute("d", brackets);
        overlay.brackets.current?.setAttribute("d", brackets);
      }
      group.style.opacity = runtime.opacity.toFixed(3);
    }

    function frame(now: number): void {
      frameHandle = null;
      if (cancelled) return;
      const deltaMs =
        runtime.lastFrameAt === 0
          ? 16
          : Math.min(100, now - runtime.lastFrameAt);
      runtime.lastFrameAt = now;

      const detected = runtime.tracked;
      if (
        runtime.target !== null &&
        (detected === null ||
          now - detected.capturedAt >
            staleHorizonMs(detected.source, runtime.intervalMs))
      ) {
        runtime.target = null;
      }
      const tracking = runtime.target !== null;

      if (runtime.target !== null) {
        runtime.current =
          runtime.current === null || reducedRef.current
            ? runtime.target
            : lerpQuad(runtime.current, runtime.target, LERP_FACTOR);
      }
      if (reducedRef.current) {
        runtime.opacity = tracking ? 1 : 0;
      } else {
        const step = deltaMs / (tracking ? FADE_IN_MS : FADE_OUT_MS);
        runtime.opacity = Math.min(
          1,
          Math.max(0, runtime.opacity + (tracking ? step : -step)),
        );
      }
      if (runtime.opacity === 0) runtime.current = null;
      paint();

      if (tracking !== trackedQuad) {
        trackedQuad = tracking;
        setHasQuad(tracking);
      }
      const quietSince = Math.max(
        detected?.capturedAt ?? 0,
        runtime.loopStartedAt,
      );
      const isSearching = !tracking && now - quietSince > SEARCHING_AFTER_MS;
      if (isSearching !== announcedSearching) {
        announcedSearching = isSearching;
        setSearching(isSearching);
      }

      frameHandle = window.requestAnimationFrame(frame);
    }

    runtime.lastFrameAt = 0;
    runtime.loopStartedAt = performance.now();
    frameHandle = window.requestAnimationFrame(frame);
    // Pay the WASM load BEFORE the first measured pass: a slow module fetch is
    // not a slow device, and letting it into the average would switch the
    // feature off on a perfectly capable phone with a bad connection.
    void loadScanic(assetsRef.current)
      .then(() => scheduleDetect(0))
      .catch(() => setAvailable(false));

    return () => {
      cancelled = true;
      runtime.live = false;
      if (detectTimer !== null) window.clearTimeout(detectTimer);
      if (frameHandle !== null) window.cancelAnimationFrame(frameHandle);
    };
  }, [loopLive, overlay, videoRef]);

  return {
    available,
    hasQuad,
    searching,
    frameBox,
    overlay,
    takeQuadForCapture,
    noteCapture,
  };
}
