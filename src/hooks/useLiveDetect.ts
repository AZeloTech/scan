"use client";

/**
 * The live viewfinder: scanic looking for the page in the camera preview, many
 * times a second, so the user sees the app *find* their document instead of
 * guessing whether the photo will come out straight.
 *
 * **Capture is the person's, unless they hand it over.** The shutter and the
 * frame tap always work. What this hook does is *find* the page, show the
 * user it has, and *guide* them (`lib/guidance.ts`): one hint at a time, a
 * ready cue on the brackets once the page is framed and still — and, only when
 * they switched auto-capture on, a capture of its own once the ready cue has
 * held (`onAutoCapture`: the same capture path as a tap, confirm screen
 * included).
 *
 * Two loops, all of it in refs:
 *
 *  1. **Detection** — a self-scheduling chain (never `setInterval`: a slow pass
 *     must not queue up behind itself), single-flight by construction, on a
 *     ~640 px sample of the video. **The pass is scanic's ML corner model**:
 *     opening this screen starts its ~3.4 MB of model and WASM downloading
 *     straight away, and from the moment that runtime is warm the model *is*
 *     the loop. The classical detector runs in its place until then, so the
 *     viewfinder is never dead on a slow connection, and it takes back over for
 *     the rest of the session if anything about the ML path fails.
 *
 *     **Where a pass runs** is the session's detection lane
 *     (`lib/detect-lane.ts`): in the detection worker when the browser can —
 *     the main thread then only grabs the frame (`createImageBitmap` of the
 *     video at the sample size) and hands it over — else on the main thread,
 *     exactly as before the worker existed.
 *
 *     **How often** follows what a pass costs (`lib/cadence.ts`): the loop
 *     keeps its detector to a share of its thread's time, so a fast phone
 *     looks up to eight times a second and a slow one backs off by itself.
 *     Whichever detector is running, the chain also measures it for the
 *     *hopeless* verdict — classical hopeless: live detection is off for the
 *     session (the screen falls back to the static framing brackets); ML
 *     hopeless: it hands back to classical.
 *  2. **Animation** — a rAF that eases the drawn quad toward the display
 *     filter's answer and cross-fades it in and out, writing the `d`
 *     attribute of the overlay's two bracket paths directly. No React state
 *     per frame: at 60 fps that would re-render the whole capture screen sixty
 *     times a second.
 *
 * **What is drawn is not what is measured.** Every accepted detection is kept
 * raw and dated by the frame it describes — that is what arbitration, the
 * stale horizon and a capture's buffered corners read. Only the overlay goes
 * through a display filter (a per-corner One-Euro filter, `lib/one-euro.ts`):
 * calm on a still page, quick on a moving one, reset whenever the thing being
 * tracked changes (a new detector, a page swap, a new frame box).
 *
 * **"Sheet found" needs paper.** A quad is drawn — and the viewfinder says it
 * found a sheet — only once the pixels in and around it look like a page
 * (`lib/paper-evidence.ts`): the model's confidence is 1.0 on a laptop lid. A
 * quad without that evidence is tracked (and still travels with a capture)
 * but not shown. The classical detector's quads are held to more: never shown
 * once the model is ready, and before that only when they pass its sanity
 * checks (not the frame's own border, not a sliver, paper inside).
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
  onScreenFloor,
  isMlResultFresh,
  ML_CADENCE_MS,
  ML_CALL_BUDGET_MS,
  ML_HOPELESS_PASS_MS,
  ML_TRUSTED_CONFIDENCE,
  ML_WARM_UP_BUDGET_MS,
  primaryDetector,
  shouldWarmUpMl,
  supersedesDetection,
  type DetectionCandidate,
} from "@/lib/ml-detection";
import {
  frameMotionScore,
  MOTION_PROBE_SIZE,
  motionBreaksHold,
  probeLuma,
} from "@/lib/frame-motion";
import { prefersReducedMotion } from "@/lib/motion";
import {
  cornerBracketPath,
  CORNER_KEYS,
  denormalizeQuad,
  lerpQuad,
  normalizedCoverage,
  normalizeQuad,
  type BracketCap,
  type NormalizedQuad,
} from "@/lib/quad";
import { QuadOneEuro } from "@/lib/one-euro";
import { CadenceController, type CadenceProfile } from "@/lib/cadence";
import { classicalQuadSane, PAPER, paperEvidence, paperSurface, type PaperEvidence } from "@/lib/paper-evidence";
import { refineQuad } from "@/lib/refine";
import { cornerCheckOf, hasUnknown, isUncertain, provenanceDiagnostic, type CornerCheck } from "@/lib/corner-check";
import { FireTimeline, phasesBefore, type TimelineMarks } from "@/lib/fire-timeline";
import type { CornerPoints } from "@/lib/flatten";
import {
  demoteDetectLane,
  detectLane,
  detectLaneGeneration,
  detectLaneReady,
  holdDetectLane,
  laneDetect,
  startDetectLane,
} from "@/lib/detect-lane";
import type { DetectLaneKind } from "@/lib/detect-protocol";
import { HINT_SAMPLE_WIDTH, readFrame, type FrameReading } from "@/lib/hints";
import {
  AutoCapture,
  BORDER_EXIT,
  borderMargin,
  FAR_CANDIDATE_AREA,
  areaShare,
  fillShare,
  HintDebounce,
  motionOf,
  shakeMotion,
  FRAMING_HINTS,
  OCCLUSION_HINT_AFTER_MS,
  rawHint,
  ReadyCue,
  ReadyTick,
  DirectionLatch,
  moveDirection,
  type MoveDirection,
  SHAKE_WINDOW_MS,
  SHAKY_ENTER,
  READY_DENSE_READINGS,
  READY_DRIFT_MAX,
  READY_DRIFT_MAX_SPARSE,
  READY_MIN_READINGS,
  readingSpacing,
  STILL_MAX,
  STILL_WINDOW_MS,
  settledOn,
  autoFrameAgeMax,
  readingsAgree,
  toVisible,
  WHOLE_FRAME,
  type HintKey,
  type VisibleRect,
} from "@/lib/guidance";
import { useAssetUrls } from "@/hooks/useScanRuntime";
import { CAPTURE_GRACE_MS } from "@/lib/still-capture";
import { probe, probing } from "@/lib/probe";
import type { DiagnosticsSink } from "@/lib/diagnostics-events";
import { ringOffset } from "@/lib/capture-layout";
import {
  clearArea,
  cornerUnderSpot,
  frameBoxFor,
  sameRegion,
  spotsInFrame,
  videoBoxFor,
  visibleRegionOf,
  type Box,
  type FitPolicy,
  type FrameRegion,
  type Occluder,
  type OccluderEdge,
} from "@/lib/visible-region";

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
 * What one detector's passes may cost before the loop gives up on it.
 *
 * The two detectors are different workloads — a contour trace against a 640 px
 * inference — so the hopeless verdict and the budget are per detector, and
 * the measurements are thrown away at a handover rather than averaged across
 * one. How often a detector is polled is the cadence's business (below).
 */
interface PassProfile {
  /** Rolling average above this: this device cannot run this detector live. */
  hopelessMs: number;
  /** How long we wait on one pass before abandoning it (it still finishes). */
  budgetMs: number;
}

const PASS_PROFILES: Record<DetectionSource, PassProfile> = {
  classical: { hopelessMs: 250, budgetMs: 2000 },
  ml: { hopelessMs: ML_HOPELESS_PASS_MS, budgetMs: ML_CALL_BUDGET_MS },
};

/**
 * The cadence per lane and detector (`lib/cadence.ts`): the share of its
 * thread a detector may take, and the bounds on the interval.
 *
 * The worker's thread is its own, so it may spend a third of it — the main
 * thread's is the user's: the model gets 15 % of it (a pass that is a long
 * task is charged double), which on a mid-range phone is about the old
 * 700 ms beat and on a desktop four times faster. The ML ceiling is the old
 * fixed cadence; nothing is ever polled slower than it used to be.
 *
 * The ceiling wins over the duty on purpose: on a core where a model pass
 * costs more than ~245 ms the worker runs above its 35 % (a 415 ms pass at
 * the 700 ms beat is ~60 %) rather than letting the overlay fall further
 * behind the hand — the same beat, and the same work, the main thread
 * carried before the worker existed. The warm-up passes are left out of the
 * cadence as well as the hopeless verdict: charged, the first pass's
 * one-time costs would push the second reading — and with it the first lock
 * — most of a second back.
 */
const CADENCE: Record<DetectLaneKind, Record<DetectionSource, CadenceProfile>> = {
  worker: {
    ml: { targetDuty: 0.35, minMs: 120, maxMs: ML_CADENCE_MS, initialMs: 120 },
    classical: { targetDuty: 0.35, minMs: 125, maxMs: 1000, initialMs: 125 },
  },
  main: {
    ml: { targetDuty: 0.15, minMs: 150, maxMs: ML_CADENCE_MS, initialMs: 300 },
    classical: { targetDuty: 0.25, minMs: 125, maxMs: 1000, initialMs: 125 },
  },
};

/**
 * While auto-capture is on and armed and a found page is framed (no hint
 * owed but "Segure firme"), the worker lane may spend up to this share of its
 * thread reading — ~0.6 s of readings is what the fire waits on, and on a
 * phone that reads every 280 ms at 0.35 it is most of the wait. Only on the
 * worker (the main thread's time is the user's), only for those seconds:
 * after the fire, or with no page, it is back to {@link CADENCE}.
 */
const BOOST_DUTY = 0.8;
/**
 * …and while a hint asks the person to move the phone on a page already
 * found (most fires start with an "Aproxime"), for at most this long after
 * the lock: at a slow phone's 0.35 the hint clears (and the readings the cue
 * needs start) one ~600 ms pass after the person got there.
 */
const BOOST_FRAMING_MS = 6000;

/**
 * Time constant of the drawn quad's glide toward the filter's answer: a
 * frame or so — enough to turn each new answer into motion rather than a
 * jump, short enough not to add lag (the bench: every 20 ms of glide cost
 * about a point of on-page time under a trembling hand).
 */
const DISPLAY_EASE_MS = 16;

/**
 * The time a pass may spend moving the model's quad onto the paper's edges
 * on its own ~640 px frame (`lib/refine.ts`, the refinement a capture runs
 * on its full image) before drawing it. On the bench's scenes this took the
 * model's live answer from 71 % to 91 % within 2 % of the page (p50 corner
 * error 1.01 → 0.08 % of the diagonal) for ~7 ms a pass (p95 17).
 */
const LIVE_REFINE_BUDGET_MS = 60;
const FADE_IN_MS = 200;
const FADE_OUT_MS = 300;
/** No successful detection for this long and a classical quad is considered lost. */
const QUAD_STALE_MS = 700;
/** The ML quad's horizon: this plus two beats, within the bounds below. */
const ML_STALE_BASE_MS = 400;
const ML_STALE_MIN_MS = 600;

/**
 * How long a tracked quad survives without a fresh detection behind it.
 *
 * A quad the *model* found gets two of the beats it is actually being polled
 * at plus a margin — never less than {@link ML_STALE_MIN_MS}, never more than
 * the horizon of the old fixed cadence — because a device that has backed off
 * answers more slowly still, and retiring its quad early would blink the
 * overlay off between two good detections.
 *
 * The horizon only carries a **stationary** page: a missed pass whose motion
 * probe says the scene moved ends the hold immediately
 * (`lib/frame-motion.ts`) — time is the wrong test for a quad the user just
 * swung away from.
 */
function staleHorizonMs(source: DetectionSource, intervalMs: number): number {
  return source === "ml"
    ? Math.min(QUAD_STALE_MS + ML_CADENCE_MS, Math.max(ML_STALE_MIN_MS, ML_STALE_BASE_MS + 2 * intervalMs))
    : QUAD_STALE_MS;
}
/** Nothing found for this long → the gentle "aim at the document" chip. */
const SEARCHING_AFTER_MS = 2500;

/**
 * The motion probe compares a pass's frame with the one about this long
 * before it — the spacing `MOTION_DROP_THRESHOLD` was calibrated at — however
 * fast the loop now runs.
 */
const MOTION_SPAN_MS = 700;

/**
 * A raw detection this far (share of the frame's diagonal) from the last one
 * is another page, or the same one somewhere else: the display filter starts
 * over and the sheet has to earn "found" again.
 */
const JUMP_RESET_DIAG = 0.08;

/**
 * A corner check speaks for the tracked page while it was measured on a
 * pass at most this long (frame time) before the newest accepted one…
 */
const CHECK_FRESH_MS = 1000;
/** …on a quad no further than this (fraction of the diagonal) from the one drawn now. */
const CHECK_DRIFT_DIAG = 0.02;

/**
 * Consecutive readings that say "paper" before a tracked quad counts as a
 * found sheet — one lucky reading of a place mat is not a page — and
 * consecutive readings that say "not paper" before a found sheet is let go —
 * one bad reading (a hand's shadow crossing an edge, a glare) is not a lost
 * sheet.
 */
const LOCK_CONFIRM_READINGS = 2;
const LOCK_RELEASE_MISSES = 2;

/**
 * A quad within {@link JUMP_RESET_DIAG} of the last found sheet, seen within
 * this long, is that sheet coming back — after a whip away and back, a
 * remount of the scanner, a page swapped in at the same spot — and one
 * reading that says paper, with every side on its edges
 * ({@link KEEP_SIDE_SUPPORT}), is enough to find it again. One lucky reading of a
 * place mat is the reason for two; one lucky reading exactly where a sheet
 * was just found is not the same bet.
 */
const RECALL_MS = 10_000;

/**
 * A found sheet's surface can stop reading as paper while the sheet is still
 * there — tilted steeply, its print foreshortened into dense, solid-looking
 * blocks and its lighting stretched into a gradient. While the tracked quad
 * moves continuously (no reset), is that foreshortened (its shorter side of
 * a pair at most {@link KEEP_FORESHORTENING} of the longer: 0.57–0.60 at the
 * `steep-tilt` session's 45–55°) and every side the frame shows still steps
 * along at least {@link KEEP_SIDE_SUPPORT} of its profiles, a "not paper"
 * reading is not held against the found sheet. Entering "found" still needs
 * the whole evidence. A quad seen square-on gets no such allowance: a black
 * keyboard read head-on (0.84–0.90) has four strong edges too, and kept
 * "found" it was carried into a capture.
 */
const KEEP_SIDE_SUPPORT = 0.8;
const KEEP_FORESHORTENING = 0.75;

/**
 * A missed pass whose reading of the held sheet says "not paper" ends the
 * hold at once, instead of at the second such reading, when the scene moved
 * at least this much (`frameMotionScore`, `lib/frame-motion.ts`) — a page
 * slid away is the motion, and waiting another pass for it kept the overlay
 * on the old page (`page-swap`'s stale overlay).
 */
const HELD_RELEASE_MOTION = 0.05;

/**
 * How fast the overlay fades once the page it held is known to have gone (a
 * hold broken on evidence or motion, a jump to another page), against
 * {@link FADE_OUT_MS} for the ordinary loss of a quad.
 */
const FADE_OUT_GONE_MS = 100;

/** Consecutive worker passes that timed out before the lane is written off as stalled. */
const WORKER_STALL_LIMIT = 3;
/** Consecutive frames that could not be grabbed or read before the worker lane is written off. */
const WORKER_GRAB_LIMIT = 5;

/**
 * The last found sheet on this page — module state, so a remount of the
 * scanner remembers where the page was a moment ago.
 */
let lastFoundSheet: { quad: NormalizedQuad; at: number } | null = null;

/**
 * To become a found sheet, every side the frame shows must have at least
 * this share of its profiles stepping on one line (`sideSupport`,
 * `lib/paper-evidence.ts`). On the bench's scenes this keeps 182 of 186
 * right model quads (and 83 of 94 real ones) while turning away a quarter
 * more of the wrong ones than the evidence alone.
 */
const ENTRY_SIDE_SUPPORT = 0.3;

/**
 * The frame's focus and light (`lib/hints.ts`, what the hint and the ready
 * cue read) are read from the live loop's own frames at most this often — by
 * the worker on its lane, from the pass's sample on the main thread's.
 */
const HINT_EVERY_MS = 200;

/** A focus/light reading older than this is not a reading of the frame on screen. */
const READING_FRESH_MS = 1000;

/**
 * A page the loop cannot take as a found sheet may still be *suspected*:
 * the model sure of a paper-looking quad too small for its coverage floor
 * (the page far away), or a quad at or past the viewfinder's edge whose
 * surface is paper and at least two of whose sides stand on edges (the page
 * cut off — its cut sides run along the frame's edge, where no step can be
 * found). Seen on {@link CANDIDATE_READINGS} readings in a row at one place,
 * it gives the hint something to say ("Aproxime", "Afaste um pouco"); it is
 * never drawn and never travels with a capture.
 */
const CANDIDATE_READINGS = 2;
/** A far page whose print the surface reading misses must still read this much background (a clean sheet). */
const FAR_MIN_BACKGROUND = 0.85;
/** A cut-off page's model score may sit under the trusted line; not this far under it. */
const CUT_CANDIDATE_MIN_CONFIDENCE = 0.5;
/** How long a found sheet's readings are kept for its motion (`motionOf`). */
const SHEET_READINGS_MS = 3000;

/**
 * The ready cue (and so auto-capture) stands on detection passes that found
 * the page where it was. The brackets outlive a pass or two — that is what
 * keeps them steady — but the cue may not: a pass that says the page is not
 * where the brackets are (its evidence failed there, a quad found somewhere
 * else, the scene moved) suspends it until a pass on a *later* frame finds
 * it again, and none may be older than this plus two of the loop's
 * intervals.
 */
const READY_STALE_MS = 1000;

/**
 * Between passes, the camera is watched while the cue is on: a
 * {@link MOTION_PROBE_SIZE}² luma probe of the preview itself, every
 * {@link WATCH_EVERY_MS} and once more at the instant auto-capture would
 * fire, against the same probe taken of the frame the newest confirming pass
 * read. A slow phone reads the page two or three times a second; a camera
 * whipped off the page between two readings must not be photographed on the
 * strength of the one before. At or over {@link WATCH_MOVED} the cue waits
 * for a pass on a later frame. A page held still, tremor included, scores
 * well under it; a page leaving the frame far over.
 */
const WATCH_EVERY_MS = 100;
const WATCH_MOVED = 0.05;
/** The probe's first step: the preview drawn this wide, then down to the probe (one step aliases the texture of a desk into "motion"). */
const WATCH_STAGE_WIDTH = 96;
/** A found sheet whose paper runs on past the viewfinder's edge on this many confirming readings in a row is cut off. */
const OPEN_READINGS = 2;

/**
 * The bench's view of the overlay (`lib/probe.ts`) is sampled, not streamed: a
 * 60 fps paint loop reporting every frame would be the instrument dominating
 * what it measures. State changes are reported the frame they happen.
 */
const OVERLAY_PROBE_INTERVAL_MS = 100;

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
/**
 * Whether a marked control is drawn at least half opaque right now: shown,
 * and its opacity (and every ancestor's) multiplied out over one half.
 */
function shownOpaque(element: HTMLElement): boolean {
  let opacity = 1;
  for (let node: HTMLElement | null = element; node !== null && opacity >= 0.5; node = node.parentElement) {
    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const value = Number.parseFloat(style.opacity);
    if (Number.isFinite(value)) opacity *= value;
  }
  return opacity >= 0.5;
}

/** Used until the frame has been measured — ~9 % of the frame. */
const BRACKET_CAP_FALLBACK = 0.09;

/** Where the preview actually renders inside the stage, after object-cover. */
export interface FrameBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The paper evidence of one pass: read and found (`PaperEvidence`), not read
 * this pass (`null`), or not readable at all on this device
 * (`"unavailable"` — the pixels could not be read back, and the loop then
 * behaves as it did before evidence existed: a tracked quad is a found sheet).
 */
type EvidenceReading = PaperEvidence | null | "unavailable";

interface Runtime {
  /** The newest accepted detection, raw — what the stale horizon retires. */
  target: NormalizedQuad | null;
  /** The newest accepted detection as drawn (refined onto the paper's edges), before the display filter. */
  shown: NormalizedQuad | null;
  /** The display filter's answer for it: what the drawn quad glides toward. */
  displayTarget: NormalizedQuad | null;
  /** What is drawn this frame. */
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
   * It is the accepted detection as measured on its frame — the model's
   * answer refined onto the paper's edges there, what the brackets were
   * drawn from — never the display filter's answer or the eased `current`:
   * those are frames of an animation on its way somewhere, and a capture
   * wants the measurement. It carries whether it was a found sheet; one that
   * was not never travels. It is cleared by
   * {@link clearTracking} like everything else — corners from a paused or
   * torn-down viewfinder never travel with a photo.
   *
   * Who measured it and how sure it was are stored **with** the quad, never
   * looked up in `tracked` at capture time: the floor a capture holds the
   * buffer to, and the provenance it reports, must describe this quad, not
   * whatever the loop happens to be tracking by then.
   */
  lastAccepted: AcceptedQuad | null;
  /** The tracked quad has paper evidence behind it: it is drawn, and it is a found sheet. */
  locked: boolean;
  /** Consecutive "not paper" readings of a found sheet. */
  evidenceMisses: number;
  /** Consecutive "paper" readings of a quad not yet found. */
  evidenceHits: number;
  /** Pixels cannot be read on this device: evidence is not required. */
  evidenceUnavailable: boolean;
  /** Consecutive worker passes that timed out, and that could not grab or read their frame. */
  workerTimeouts: number;
  workerGrabFailures: number;
  lastFrameAt: number;
  loopStartedAt: number;
  detecting: boolean;
  /** Which detector the chain is currently running, and measuring. */
  passSource: DetectionSource;
  /** Which lane it was measuring it on. */
  passLane: DetectLaneKind;
  /** The lane generation the chain last saw (`detectLaneGeneration`). */
  laneGeneration: number;
  intervalMs: number;
  cadence: CadenceController;
  averageMs: number | null;
  warmupLeft: number;
  /**
   * The eager ML warm-up has been launched this page-session (main-thread
   * lane; the worker warms its own).
   *
   * Per session rather than per attempt: the download and the WASM compile are
   * facts about the page, not about this camera start or this capture.
   */
  mlWarmUpStarted: boolean;
  /** The overlay's display filter. */
  filter: QuadOneEuro;
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
   * The question the detached ML warm-up (and every worker pass) is
   * answering, bumped whenever it changes — a new page, a loop restart, a
   * fail-closed handover. A pass that answers into a different epoch is
   * describing a question nobody is asking any more.
   */
  mlEpoch: number;
  /**
   * The recent passes' motion probes (`lib/frame-motion.ts`), compared
   * against each new pass's to tell a detection dropout on a still scene
   * (keep the hold) from one on a moved scene (end it). Reset on loop start
   * so a pause never pairs two probes that are minutes apart.
   */
  motionHistory: { at: number; luma: Uint8ClampedArray }[];
  /** The latest focus/light reading of a live frame (`lib/hints.ts`). */
  reading: { at: number; sharp: boolean; luma: number; bright: number } | null;
  /** The found sheet's recent readings (as drawn, in the visible crop): its motion. */
  sheetReadings: { at: number; quad: NormalizedQuad }[];
  /** Share of the found sheet's interior clipped white, from its latest evidence. */
  glare: number | null;
  /** A page suspected but not found (see {@link CANDIDATE_READINGS}), in frame fractions. */
  candidate: { quad: NormalizedQuad; at: number; hits: number; cutOff: boolean } | null;
  /** The motion probe's luma at the last auto-capture: a scene changed since re-arms it. */
  firedLuma: Uint8ClampedArray | null;
  /** When a page (found or suspected) was last seen. */
  sheetSeenAt: number | null;
  /** The auto-capture countdown on the brackets (0–1), null when not counting. */
  countdown: number | null;
  /** The sheet the overlay held is known to have gone: fade it out fast. */
  dropFast: boolean;
  /** The frame time of the newest pass that found the locked sheet where it was (the ready cue's footing). */
  confirmedAt: number | null;
  /** A pass said the page may not be where the brackets are (its frame time); cleared by a confirming pass on a later frame. */
  suspectAt: number | null;
  /** The newest confirming pass's readings say still, on enough of them ({@link READY_MIN_READINGS}). */
  readyVerdict: boolean;
  /** The newest confirming pass's readings say settled: still over the short window the countdown starts on (`SETTLE_WINDOW_MS`). */
  settledVerdict: boolean;
  /** Auto-capture is near a fire on this page: the worker lane reads faster for now ({@link BOOST_DUTY}). */
  boost: boolean;
  /** When a hint asking the person to move the phone last left the slot (`shakeMotion`), or null. */
  framedAt: number | null;
  /**
   * A photo is being taken (from the tap or the auto fire to the end of the
   * capture): the overlay stays frozen on the quad it showed, no pass runs or
   * lands, and a stream that reconfigures for the photo (Android's
   * `takePhoto()` can freeze, re-expose or resize the preview) is not
   * measured — it describes a camera busy with the shutter, not the page.
   */
  capturing: boolean;
  /** Why the newest confirming pass's readings did not say still (the HUD's reason), or null. */
  stillWhy: string | null;
  /** The first thing keeping the ready cue off / auto-capture from firing right now (the HUD's reason). */
  blockWhy: string | null;
  /** The preview's luma probe at the newest confirming pass's frame, and the one being taken for the pass in flight. */
  watchBase: Uint8ClampedArray | null;
  /** When the preview was last watched while the cue was on, and whether it has moved off the confirmed frame since. */
  watchAt: number;
  watchMoved: boolean;
  /** The last watch score (the bench's overlay probe). */
  watchScore: number | null;
  /** Confirming readings in a row whose paper runs on past an edgeless side ({@link OPEN_READINGS}). */
  openHits: number;
  /** How much of the visible region the page (found or suspected) fills (`fillShare`), or null with none. */
  fill: number | null;
  /** What the newest pass's detector answered and what the loop made of it ({@link PassAnswer}). */
  answer: PassAnswer | null;
  /**
   * The tracked page's corners, as the newest pass that measured them said
   * (`lib/corner-check.ts`): the dashed brackets, the occlusion hints and
   * auto-capture's hard gate. Null with no page, or none measured yet.
   */
  check: CornerCheck | null;
  /**
   * What `check` was measured on: the frame time of its pass and the quad it
   * walked (as drawn). A check speaks for the page only while it is fresh
   * and the quad has not drifted from it ({@link checkSpeaks}).
   */
  checkAt: number | null;
  checkQuad: NormalizedQuad | null;
  /** Since when (frame time) the tracked page has had an unknown corner / another sheet over it, or null. */
  unknownSince: number | null;
  separateSince: number | null;
  /** When each of the ready cue's conditions last came true ({@link FireTimeline}): where a fire's time went. */
  timeline: FireTimeline;
  /** When the running auto-capture countdown started, or null. */
  countdownStart: number | null;
  /** Which way "Mova o celular" points while it shows (the nudge arrow, {@link LiveOverlayRefs.nudge}); else null. */
  nudge: MoveDirection | null;
  /** The newest fire's timeline ({@link FireMarks}), for the bench's probe and the diagnostics stream. */
  lastFire: { at: number; marks: FireMarks } | null;
}

/**
 * A fire's timeline, absolute times: each ready condition's last onset
 * ({@link FireTimeline}), then `strict` (all together), `ready` (the cue on),
 * `countdown` and `end` (the countdown's start and end), `confirm` (the frame
 * time of the newest pass that found the page where it was).
 */
export type FireMarks = TimelineMarks & {
  /** When the page settled (the countdown's start condition, `SETTLE_WINDOW_MS`). */
  settled: number | null;
  strict: number | null;
  ready: number | null;
  countdown: number | null;
  end: number | null;
  confirm: number | null;
};

/**
 * The newest pass, for the diagnostics stream: why a page is or is not found
 * — the model's confidence (null: no quad), why the loop turned the quad away
 * (`floor`, `superseded`, …; null: taken), and the paper evidence's verdict
 * (null: not read).
 */
export interface PassAnswer {
  conf: number | null;
  rejected: string | null;
  paper: boolean | null;
}

/** {@link PassAnswer} from a pass's detection, the loop's verdict on it and its evidence. */
function passAnswer(detection: FrameDetection | null, rejected: string | null, evidence: EvidenceReading): PassAnswer {
  return {
    conf: detection === null ? null : (detection.confidence ?? null),
    rejected,
    paper: evidence === null || evidence === "unavailable" ? null : evidence.ok,
  };
}

function freshRuntime(): Runtime {
  return {
    target: null,
    shown: null,
    displayTarget: null,
    current: null,
    opacity: 0,
    tracked: null,
    lastAccepted: null,
    locked: false,
    evidenceMisses: 0,
    evidenceHits: 0,
    evidenceUnavailable: false,
    workerTimeouts: 0,
    workerGrabFailures: 0,
    lastFrameAt: 0,
    loopStartedAt: 0,
    detecting: false,
    passSource: "classical",
    passLane: "main",
    laneGeneration: -1,
    intervalMs: CADENCE.main.classical.initialMs,
    cadence: new CadenceController(CADENCE.main.classical, true),
    averageMs: null,
    warmupLeft: WARMUP_PASSES,
    mlWarmUpStarted: false,
    filter: new QuadOneEuro(),
    live: false,
    mlEpoch: 0,
    motionHistory: [],
    reading: null,
    sheetReadings: [],
    glare: null,
    candidate: null,
    sheetSeenAt: null,
    countdown: null,
    dropFast: false,
    firedLuma: null,
    confirmedAt: null,
    suspectAt: null,
    readyVerdict: false,
    settledVerdict: false,
    boost: false,
    framedAt: null,
    capturing: false,
    stillWhy: null,
    blockWhy: null,
    watchBase: null,
    watchAt: Number.NEGATIVE_INFINITY,
    watchMoved: false,
    watchScore: null,
    openHits: 0,
    fill: null,
    answer: null,
    check: null,
    checkAt: null,
    checkQuad: null,
    unknownSince: null,
    separateSince: null,
    timeline: new FireTimeline(),
    countdownStart: null,
    nudge: null,
    lastFire: null,
  };
}

/**
 * Move the chain onto a detector (or a lane), throwing away what was measured
 * of the other.
 *
 * A rolling average that spans a handover describes neither workload, and the
 * first pass of the detector being handed to carries its own warm-up (an ORT
 * session on the way up, a cold contour trace on the way back down). The
 * display filter starts over too: two detectors answer a corner a little
 * differently, and filtering one into the other would draw the difference as
 * motion.
 */
function switchDetector(runtime: Runtime, source: DetectionSource, lane: DetectLaneKind): void {
  runtime.passSource = source;
  runtime.passLane = lane;
  runtime.cadence = new CadenceController(CADENCE[lane][source], lane === "main");
  runtime.intervalMs = runtime.cadence.intervalMs;
  runtime.averageMs = null;
  runtime.warmupLeft = WARMUP_PASSES;
  runtime.filter.reset();
}

/**
 * The tracked page's corner check still describes it: measured on a pass
 * within {@link CHECK_FRESH_MS} of the newest accepted one, on a quad within
 * {@link CHECK_DRIFT_DIAG} of the one drawn now. Otherwise the page is
 * unmeasured — and an unmeasured page is never ready nor auto-captured.
 */
function checkSpeaks(runtime: Runtime, aspect: number): boolean {
  if (runtime.check === null || runtime.checkAt === null || runtime.checkQuad === null) return false;
  if (runtime.shown === null || runtime.lastAccepted === null) return false;
  if (runtime.lastAccepted.capturedAt - runtime.checkAt > CHECK_FRESH_MS) return false;
  return quadJump(runtime.checkQuad, runtime.shown, aspect) <= CHECK_DRIFT_DIAG;
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
  runtime.check = null;
  runtime.checkAt = null;
  runtime.checkQuad = null;
  runtime.unknownSince = null;
  runtime.separateSince = null;
  runtime.target = null;
  runtime.displayTarget = null;
  runtime.current = null;
  runtime.opacity = 0;
  runtime.tracked = null;
  runtime.lastAccepted = null;
  runtime.locked = false;
  runtime.evidenceMisses = 0;
  runtime.evidenceHits = 0;
  runtime.filter.reset();
  runtime.sheetReadings = [];
  runtime.glare = null;
  runtime.candidate = null;
  runtime.countdown = null;
  runtime.countdownStart = null;
  runtime.timeline.reset();
  runtime.confirmedAt = null;
  runtime.suspectAt = null;
  runtime.readyVerdict = false;
  runtime.settledVerdict = false;
  runtime.boost = false;
  runtime.stillWhy = null;
  runtime.watchBase = null;
  runtime.watchMoved = false;
  runtime.openHits = 0;
  overlay.bracketsHalo.current?.setAttribute("d", "");
  overlay.brackets.current?.setAttribute("d", "");
  overlay.inferredHalo.current?.setAttribute("d", "");
  overlay.inferred.current?.setAttribute("d", "");
  overlay.countdown.current?.setAttribute("d", "");
  const group = overlay.group.current;
  if (group !== null) group.style.opacity = "0";
  const anchor = overlay.anchor.current;
  if (anchor !== null) anchor.style.opacity = "0";
  const nudge = overlay.nudge?.current ?? null;
  if (nudge !== null) nudge.dataset.direction = "";
  paintRing(overlay.ring.current, null);
}

/** The countdown ring (see {@link LiveOverlayRefs.ring}) at a progress, or empty. */
function paintRing(ring: SVGCircleElement | null, progress: number | null): void {
  if (ring === null) return;
  const length = Number(ring.dataset.length);
  if (!Number.isFinite(length) || length <= 0) return;
  ring.style.strokeDashoffset = ringOffset(progress, length).toFixed(2);
}

/**
 * How foreshortened a quad is: over its two pairs of opposite sides, the
 * smallest ratio of the shorter to the longer (1: a parallelogram).
 */
function foreshortening(quad: NormalizedQuad, aspect: number): number {
  const side = (a: NormalizedQuad["topLeft"], b: NormalizedQuad["topLeft"]): number =>
    Math.hypot(a.x - b.x, (a.y - b.y) * aspect);
  const top = side(quad.topLeft, quad.topRight);
  const right = side(quad.topRight, quad.bottomRight);
  const bottom = side(quad.bottomRight, quad.bottomLeft);
  const left = side(quad.bottomLeft, quad.topLeft);
  const ratio = (a: number, b: number): number => (Math.max(a, b) <= 0 ? 1 : Math.min(a, b) / Math.max(a, b));
  return Math.min(ratio(top, bottom), ratio(left, right));
}

/** Largest corner move between two quads, as a share of the frame's diagonal. */
function quadJump(a: NormalizedQuad, b: NormalizedQuad, aspect: number): number {
  let largest = 0;
  for (const key of CORNER_KEYS) {
    largest = Math.max(largest, Math.hypot(a[key].x - b[key].x, (a[key].y - b[key].y) * aspect));
  }
  return largest / Math.hypot(1, aspect);
}

export interface UseLiveDetectOptions {
  videoRef: React.MutableRefObject<HTMLVideoElement | null>;
  /** The stage the preview fills — the overlay is positioned inside it. */
  containerRef: React.MutableRefObject<HTMLElement | null>;
  /** Live camera, not at capacity: the loop only exists while this is true. */
  active: boolean;
  /** Frozen without being torn down: capture in flight, sheet open, tab hidden. */
  paused: boolean;
  /** The person switched auto-capture on (`lib/guidance.ts`, {@link AutoCapture}). */
  autoCapture?: boolean;
  /** Called when auto-capture fires: take the photo exactly as a tap would. */
  onAutoCapture?: () => void;
  /**
   * How the stage scales the frame (`lib/visible-region.ts`; default
   * `cover`, the video filling the stage). Anything else is laid out here: the
   * hook measures the layout's declared opaque bands and answers the video's
   * own box ({@link LiveDetect.videoBox}).
   */
  fit?: FitPolicy;
  /**
   * The host's diagnostics stream (`onDiagnostics`), or null: the ready cue
   * and auto-capture report their transitions to it. Null costs a check.
   */
  diagnosticsSink?: DiagnosticsSink | null;
}

/** The video element's box and `object-position` for a fit other than `cover` (stage pixels). */
export interface VideoBox {
  left: number;
  top: number;
  width: number;
  height: number;
  positionX: number;
  positionY: number;
}

/** What the diagnostics HUD reads, once per tick (`experimentalDiagnostics`). */
export interface LiveDiagnostics {
  lane: DetectLaneKind | null;
  detector: DetectionSource;
  /** The newest pass's detector time, and the median of the recent ones (ms). */
  detectMs: number | null;
  detectP50: number | null;
  /** The loop's current interval between passes (ms). */
  intervalMs: number;
  /** How old the newest pass's frame was when its answer landed (ms). */
  frameAgeMs: number | null;
  stream: { width: number; height: number } | null;
  visible: FrameRegion;
  fit: FitPolicy;
  locked: boolean;
  ready: boolean;
  autoArmed: boolean;
  /** The first thing keeping the ready cue off or auto-capture from firing, or null. */
  blocked: string | null;
  /** Passes answered since this hook mounted (a stalled loop stops counting). */
  passes: number;
  /** How much of the visible region the page fills along its limiting axis (`fillShare`), or null with no page. */
  fill: number | null;
  /** The newest pass's answer ({@link PassAnswer}), or null before the first. */
  answer: PassAnswer | null;
  /** The tracked page's corners and overlap, as the newest measuring pass said (`lib/corner-check.ts`); null or absent with none. */
  check?: CornerCheck | null;
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
  /**
   * The corner brackets, halo under them. Both take `d`. A corner something
   * lies over (`lib/corner-check.ts`) is not among them: an inferred one is
   * drawn on the two paths below instead, an unknown one not at all.
   */
  bracketsHalo: React.MutableRefObject<SVGPathElement | null>;
  brackets: React.MutableRefObject<SVGPathElement | null>;
  /**
   * The brackets of the corners placed where their edges meet because
   * something lies over them (inferred): drawn dashed, so the person sees the
   * page's corner is estimated, not seen. Optional; both take `d`.
   */
  inferredHalo: React.MutableRefObject<SVGPathElement | null>;
  inferred: React.MutableRefObject<SVGPathElement | null>;
  /**
   * The auto-capture countdown: the same brackets, grown from each corner
   * along its marks as the countdown runs (empty `d` when it is not).
   */
  countdown: React.MutableRefObject<SVGPathElement | null>;
  /**
   * Optional, for the experimental capture layouts: an element pinned to the
   * page's top-left corner, in stage pixels. The paint sets `--scan-anchor-x`
   * and `--scan-anchor-y` on it and fades it with the brackets; the element
   * places itself from those (`onehand` hangs its hint there).
   */
  anchor: React.MutableRefObject<HTMLDivElement | null>;
  /**
   * Optional: a circle that draws the auto-capture countdown as a ring
   * (a shutter's). Give it `data-length` (its circumference) and a matching
   * `stroke-dasharray`; the paint sets its `stroke-dashoffset`.
   */
  ring: React.MutableRefObject<SVGCircleElement | null>;
  /**
   * Optional: the arrow of "Mova o celular" — an element the live loop pins
   * to the middle of the visible region's edge the phone should move toward
   * (stage pixels in `--scan-nudge-x` / `--scan-nudge-y`, the way in
   * `data-direction`), shown only while that hint is.
   */
  nudge?: React.MutableRefObject<HTMLDivElement | null>;
}

/** An accepted quad, with the detection that produced it. */
interface AcceptedQuad {
  quad: NormalizedQuad;
  /** When the frame it describes was sampled. */
  capturedAt: number;
  source: DetectionSource;
  confidence: number | null;
  /**
   * It was a found sheet — drawn, with paper evidence behind it — when it was
   * accepted. Only such a quad may travel with a capture: the buffer exists
   * to carry what the user was looking at, and an unconvincing quad (the
   * laptop lid the model is sure of) was never on screen.
   */
  found: boolean;
}

/** The capture buffer as a capture receives it. */
export interface BufferedQuad {
  quad: NormalizedQuad;
  ageMs: number;
  source: DetectionSource;
  confidence: number | null;
}

export interface LiveDetect {
  /** False once the device proved too slow — the brackets take over. */
  available: boolean;
  /** A sheet is found and drawn right now. */
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
   * before using it. Which detector found them rides along for the probe.
   */
  takeQuadForCapture: () => BufferedQuad | null;
  /** The capture is over (its confirm screen is up, or it failed): the loop takes the camera back. */
  endCapture: () => void;
  /** A capture just happened: the next page is a new question for the ML policy. */
  noteCapture: () => void;
  /** The one hint over the viewfinder (`lib/guidance.ts`), or none. */
  hint: HintKey | null;
  /** How much of the view the page filled (`fillShare`) when {@link hint} appeared — its wording's band; null with no page. */
  hintFill: number | null;
  /** Which way "Mova o celular" says to move the phone (`moveDirection`), while that hint shows; else null. */
  hintDirection: MoveDirection | null;
  /** The ready cue: a found sheet, framed, sharp and still. */
  ready: boolean;
  /** Bumped once per page as the ready cue comes on: the one haptic tick (and a spoken "ready"). */
  readyTick: number;
  /**
   * The part of the frame the person can see (`lib/visible-region.ts`), in
   * frame fractions — what the hints, the ready cue and auto-capture judge.
   */
  visible: FrameRegion;
  /** Where the video element goes for a fit other than `cover`; null: fill the stage. */
  videoBox: VideoBox | null;
  /** A snapshot for the diagnostics HUD — cheap, read on demand. */
  diagnostics: () => LiveDiagnostics;
}

/** One pass, whichever lane ran it. */
interface PassOutcome {
  detection: FrameDetection | null;
  /** The detection refined onto the paper's edges (pixels), when that moved it. */
  refined: CornerPoints | null;
  refineMs: number | null;
  /** On a miss: the evidence for the quad the overlay was holding, on this frame (`null`: not read). */
  heldEvidence: PaperEvidence | null;
  width: number;
  height: number;
  /** When the frame was sampled (main thread's clock). */
  frameAt: number;
  luma: Uint8ClampedArray | null;
  evidence: EvidenceReading;
  /** What the cadence is charged: the main thread's pass, or the worker's compute. */
  costMs: number;
  /**
   * The detector's own share of it — the pass without the edge refinement and
   * the paper evidence that ride on it. The hopeless verdict reads this: those
   * extras have budgets of their own, and on a slow phone they were enough to
   * push a classical loop the device could run over the line before the model
   * was ready to take over.
   */
  detectMs: number;
  /** The main thread's own time on it. */
  mainMs: number;
  computeMs: number | null;
  queueMs: number | null;
  /** The model's call failed at runtime (worker lane): the lane moves. */
  mlFailed: boolean;
  /** The frame's focus and light, when this pass read them. */
  reading: FrameReading | null;
  /**
   * What the refinement said about the drawn quad's corners — seen, inferred
   * or unknown — and whether another sheet overlaps it (`lib/corner-check.ts`);
   * null when it did not run or gave up.
   */
  check?: CornerCheck | null;
  /**
   * Worker lane: why the pass got no answer — `timeout` (the worker is busy
   * or stuck), `grab` (the frame could not be grabbed, drawn or read), or
   * null when it was answered.
   */
  miss: "timeout" | "grab" | null;
}

export function useLiveDetect({
  videoRef,
  containerRef,
  active,
  paused,
  autoCapture = false,
  onAutoCapture,
  fit = "cover",
  diagnosticsSink = null,
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
  const inferredHaloRef = React.useRef<SVGPathElement | null>(null);
  const inferredRef = React.useRef<SVGPathElement | null>(null);
  const countdownRef = React.useRef<SVGPathElement | null>(null);
  const anchorRef = React.useRef<HTMLDivElement | null>(null);
  const ringRef = React.useRef<SVGCircleElement | null>(null);
  const nudgeRef = React.useRef<HTMLDivElement | null>(null);
  // One stable object so the consumer can spread it into JSX without giving the
  // stage a new set of ref identities on every render.
  const overlay = React.useMemo<LiveOverlayRefs>(
    () => ({
      group: groupRef,
      bracketsHalo: bracketsHaloRef,
      brackets: bracketsRef,
      inferredHalo: inferredHaloRef,
      inferred: inferredRef,
      countdown: countdownRef,
      anchor: anchorRef,
      ring: ringRef,
      nudge: nudgeRef,
    }),
    [],
  );
  /**
   * The guidance (`lib/guidance.ts`): the hint slot's debounce, the ready cue
   * and auto-capture. Per mount, and — auto-capture's memory of the page it
   * took above all — kept across the pauses a capture and its confirm screen
   * put the loop through.
   */
  const guidanceRef = React.useRef({
    hints: new HintDebounce(),
    direction: new DirectionLatch(),
    ready: new ReadyCue(),
    /** The page settled — what auto-capture's countdown starts on (the cue's conditions, on a short stillness window). */
    settled: new ReadyCue(),
    tick: new ReadyTick(),
    auto: new AutoCapture(),
  });
  const autoCaptureRef = React.useRef(autoCapture);
  const onAutoCaptureRef = React.useRef(onAutoCapture);
  onAutoCaptureRef.current = onAutoCapture;
  const diagRef = React.useRef(diagnosticsSink);
  diagRef.current = diagnosticsSink;
  /**
   * The diagnostics stream's memory of the transitions it reports: when the
   * ready cue came on, when auto-capture's countdown started, whether it was
   * armed. Kept whether or not a stream is attached — three fields.
   */
  const diagStateRef = React.useRef<{ readyAt: number | null; countdownAt: number | null; armed: boolean }>({
    readyAt: null,
    countdownAt: null,
    armed: true,
  });
  React.useEffect(() => {
    // Switched on: count from now, whatever was ready before.
    if (autoCapture && !autoCaptureRef.current) guidanceRef.current.auto.enable(performance.now());
    autoCaptureRef.current = autoCapture;
  }, [autoCapture]);
  /** The main-thread lane's 320 px copy of the sample, for the focus/light reading. */
  const readingCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const sampleRef = React.useRef<HTMLCanvasElement | null>(null);
  /** The 24×24 scratch the motion probe redraws every pass. */
  const motionScratchRef = React.useRef<HTMLCanvasElement | null>(null);
  /** The watch's own two canvases (the preview at {@link WATCH_STAGE_WIDTH}, then the probe): never the pass's. */
  const watchStageRef = React.useRef<HTMLCanvasElement | null>(null);
  const watchScratchRef = React.useRef<HTMLCanvasElement | null>(null);
  /**
   * The warm-up pass gets its own copy of the frame (main-thread lane).
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
  /** The video's own size at the last measure: a change is a new sensor frame (a rotation). */
  const videoSizeRef = React.useRef<{ width: number; height: number } | null>(null);
  /**
   * The part of the frame the person can see — the frame box ∩ the stage ∩
   * the viewport, minus the layout's opaque bands (`lib/visible-region.ts`):
   * what the hints, the ready cue and auto-capture judge.
   */
  const visibleRef = React.useRef<VisibleRect>(WHOLE_FRAME);
  const [visible, setVisible] = React.useState<FrameRegion>(WHOLE_FRAME);
  /**
   * The controls drawn over the picture away from its edges
   * (`[data-scan-occluder="spot"]`: a glass button, the hint pill),
   * in frame fractions — a page with a corner under one is not fully visible.
   */
  const spotsRef = React.useRef<FrameRegion[]>([]);
  /**
   * Whether any of the frame is on screen at all. A stage scrolled or pinched
   * out of the visual viewport shows nothing: the loop stops (and with it the
   * ready cue and auto-capture) until it is back, and then starts afresh.
   */
  const [onScreen, setOnScreen] = React.useState(true);
  const [videoBox, setVideoBox] = React.useState<VideoBox | null>(null);
  const fitRef = React.useRef<FitPolicy>(fit);
  fitRef.current = fit;
  /** The newest passes' detector times, for the HUD's median. */
  const passTimesRef = React.useRef<number[]>([]);
  const passCountRef = React.useRef(0);
  const frameAgeRef = React.useRef<number | null>(null);

  const [available, setAvailable] = React.useState(true);
  const [hasQuad, setHasQuad] = React.useState(false);
  const [searching, setSearching] = React.useState(false);
  const [frameBox, setFrameBox] = React.useState<FrameBox | null>(null);
  const [tabHidden, setTabHidden] = React.useState(false);
  const [hint, setHint] = React.useState<HintKey | null>(null);
  const [hintFill, setHintFill] = React.useState<number | null>(null);
  const [hintDirection, setHintDirection] = React.useState<MoveDirection | null>(null);
  const [ready, setReady] = React.useState(false);
  /** Bumped once per page when the ready cue comes on: the haptic tick and the spoken "ready" ({@link ReadyTick}). */
  const [readyTick, setReadyTick] = React.useState(0);
  /** When the frame's focus and light were last read. */
  const hintRef = React.useRef<{ at: number }>({ at: Number.NEGATIVE_INFINITY });

  // Start deciding where detection runs — and, on the worker lane, the
  // model's download — the moment the capture screen mounts, whether or not
  // the camera is live yet. The lane is the page's, not this mount's: held
  // while mounted, released (after an idle grace) when the last holder goes.
  React.useEffect(() => holdDetectLane(assetsRef.current), []);

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

  /** Watches the stage and the layout's opaque bands, as `measure` finds them. */
  const occluderObserverRef = React.useRef<ResizeObserver | null>(null);
  /**
   * Where the frame renders in the stage under the fit policy, and the part
   * of it the person can see (`lib/visible-region.ts`): the stage ∩ the
   * visual viewport (pinch zoom), minus the opaque bands the layout declares
   * (`[data-scan-occluder]` inside its `[data-scan-layout]` root — the notch,
   * the shutter row over the rail's fade). Re-measured on any resize of the
   * stage or a band, the viewport, the video's own size, and once a second
   * while live (a chrome state change that moves a band without resizing it).
   */
  const measure = React.useCallback(() => {
    const video = videoRef.current;
    const host = containerRef.current;
    if (video === null || host === null) return;
    // Mid-capture the geometry is the photo's business: nothing moves under the frozen overlay.
    if (runtimeRef.current.capturing) return;
    if (video.videoWidth === 0 || video.videoHeight === 0) return;
    const rect = host.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      // A stage with no size shows nothing.
      setOnScreen(false);
      return;
    }
    const stageSize = { width: rect.width, height: rect.height };
    const occluders: Occluder[] = [];
    const spots: Box[] = [];
    const layoutRoot = host.closest("[data-scan-layout]") ?? host;
    for (const element of layoutRoot.querySelectorAll<HTMLElement>("[data-scan-occluder]")) {
      const edge = element.dataset.scanOccluder;
      const r = element.getBoundingClientRect();
      const box = { left: r.left - rect.left, top: r.top - rect.top, width: r.width, height: r.height };
      if (edge === "spot") {
        // Only while it is actually drawn: a faded-out control hides nothing.
        if (!shownOpaque(element)) continue;
        spots.push(box);
      } else if (edge === "top" || edge === "bottom" || edge === "left" || edge === "right") {
        occluders.push({ edge: edge as OccluderEdge, box });
      } else continue;
      occluderObserverRef.current?.observe(element);
    }
    const vv = typeof window.visualViewport === "object" ? window.visualViewport : null;
    const viewport =
      vv !== null
        ? { left: vv.offsetLeft - rect.left, top: vv.offsetTop - rect.top, width: vv.width, height: vv.height }
        : { left: -rect.left, top: -rect.top, width: window.innerWidth, height: window.innerHeight };
    const clear = clearArea(stageSize, viewport, occluders);
    const policy = fitRef.current;
    const next: FrameBox = frameBoxFor(policy, { width: video.videoWidth, height: video.videoHeight }, stageSize, clear);
    const region = visibleRegionOf(next, clear);
    const placed = videoBoxFor(policy, next, stageSize);
    const nextVideoBox: VideoBox | null =
      placed === null ? null : { ...placed.box, positionX: placed.position.x, positionY: placed.position.y };
    setVideoBox((current) =>
      current === null || nextVideoBox === null
        ? nextVideoBox
        : Math.abs(current.left - nextVideoBox.left) < 0.5 &&
            Math.abs(current.top - nextVideoBox.top) < 0.5 &&
            Math.abs(current.width - nextVideoBox.width) < 0.5 &&
            Math.abs(current.height - nextVideoBox.height) < 0.5 &&
            Math.abs(current.positionX - nextVideoBox.positionX) < 1e-3 &&
            Math.abs(current.positionY - nextVideoBox.positionY) < 1e-3
          ? current
          : nextVideoBox,
    );
    const previous = frameBoxRef.current;
    const same =
      previous !== null &&
      Math.abs(previous.left - next.left) < 0.5 &&
      Math.abs(previous.top - next.top) < 0.5 &&
      Math.abs(previous.width - next.width) < 0.5 &&
      Math.abs(previous.height - next.height) < 0.5;
    // A new frame box is a new geometry under the overlay: the display filter
    // must not glide from where the brackets were drawn in the old one.
    if (!same && previous !== null) runtimeRef.current.filter.reset();
    // A new video size is a new frame altogether — the phone rotated, the
    // camera renegotiated — and every quad held describes the old one: drop
    // them (overlay and capture buffer) rather than draw old corners into
    // the new geometry until the next detection lands.
    const videoSize = videoSizeRef.current;
    if (videoSize !== null && (videoSize.width !== video.videoWidth || videoSize.height !== video.videoHeight)) {
      clearTracking(runtimeRef.current, overlay);
    }
    videoSizeRef.current = { width: video.videoWidth, height: video.videoHeight };
    // Nothing of the frame on screen (a stage scrolled or pinched away):
    // the loop stops until it is back — no region is judged, none is kept.
    const shown = region !== null && region.width > 0 && region.height > 0;
    setOnScreen(shown);
    if (shown) {
      if (!sameRegion(visibleRef.current, region)) visibleRef.current = region;
      setVisible((current) => (sameRegion(current, region) ? current : region));
    }
    spotsRef.current = spotsInFrame(next, spots);
    frameBoxRef.current = next;
    setFrameBox((current) => (same && current !== null ? current : next));
  }, [containerRef, overlay, videoRef]);

  React.useEffect(() => {
    if (!active) return;
    const video = videoRef.current;
    const host = containerRef.current;
    const observer =
      typeof ResizeObserver === "function" && host !== null
        ? new ResizeObserver(() => measure())
        : null;
    occluderObserverRef.current = observer;
    measure();
    if (observer !== null && host !== null) observer.observe(host);
    video?.addEventListener("loadedmetadata", measure);
    video?.addEventListener("resize", measure);
    const vv = typeof window.visualViewport === "object" ? window.visualViewport : null;
    vv?.addEventListener("resize", measure);
    vv?.addEventListener("scroll", measure);
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    // A band that moves without resizing (a chrome state change), a text
    // size change the observers miss: a second is soon enough, and a
    // measure is a handful of rect reads.
    const tick = window.setInterval(measure, 1000);
    return () => {
      observer?.disconnect();
      occluderObserverRef.current = null;
      window.clearInterval(tick);
      video?.removeEventListener("loadedmetadata", measure);
      video?.removeEventListener("resize", measure);
      vv?.removeEventListener("resize", measure);
      vv?.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
    };
  }, [active, containerRef, measure, videoRef]);

  // A new fit is a new layout of the same stage.
  React.useEffect(() => {
    measure();
  }, [fit, measure]);

  // Nothing to track while the loop is not running — the stage is gone, a sheet
  // covers it, the tab is hidden, the device was written off. Everything the
  // last pass left behind goes now: it would otherwise be drawn by nobody,
  // outlive the frame it describes, and still be there for the next capture.
  const loopLive = active && !paused && !tabHidden && available && onScreen;
  React.useEffect(() => {
    if (loopLive) return;
    const runtime = runtimeRef.current;
    runtime.live = false;
    clearTracking(runtime, overlay);
    runtime.mlEpoch += 1;
    setHasQuad(false);
    setSearching(false);
    // The guidance stops with the loop: no hint, no cue, and a stale reading
    // ("low light") never outlives it. Auto-capture keeps its memory of the
    // page it took — this pause is its confirm screen.
    hintRef.current = { at: Number.NEGATIVE_INFINITY };
    runtime.reading = null;
    runtime.sheetSeenAt = null;
    const guidance = guidanceRef.current;
    guidance.hints.reset();
    guidance.direction.reset();
    guidance.ready.reset();
    guidance.settled.reset();
    // The next cue is another page's (or this one retaken): it ticks.
    guidance.tick.reset();
    guidance.auto.pause();
    setHint(null);
    setHintFill(null);
    setHintDirection(null);
    setReady(false);
  }, [loopLive, overlay]);

  const noteCapture = React.useCallback(() => {
    // The next page is a new question, so a warm-up pass still in flight over
    // the sheet that was just photographed no longer has one to answer. The
    // download itself is untouched — it is a fact about the page.
    const runtime = runtimeRef.current;
    runtime.mlEpoch += 1;
    // From here to the confirm screen the overlay holds still (`capturing`).
    runtime.capturing = true;
    // This page is taken, whoever took it: auto-capture waits for another.
    const sheet = runtime.locked && runtime.shown !== null ? toVisible(runtime.shown, visibleRef.current) : null;
    guidanceRef.current.auto.took(performance.now(), sheet);
    const memo = diagStateRef.current;
    if (memo.countdownAt !== null) {
      const now = performance.now();
      diagRef.current?.emit({ type: "auto", phase: "cancel", ms: now - memo.countdownAt, reason: "manual capture" });
      memo.countdownAt = null;
    }
    if (sheet !== null) runtime.firedLuma = runtime.motionHistory[runtime.motionHistory.length - 1]?.luma ?? null;
  }, []);

  const endCapture = React.useCallback(() => {
    const runtime = runtimeRef.current;
    if (!runtime.capturing) return;
    runtime.capturing = false;
    // What the camera did during the shutter is not motion of the page.
    runtime.lastFrameAt = 0;
    runtime.motionHistory = [];
    runtime.sheetReadings = [];
    runtime.watchBase = null;
    runtime.watchMoved = false;
    measure();
  }, [measure]);

  /**
   * The corners a capture may fall back on, and how old they already are.
   *
   * Only a loop that is running right now can vouch for these corners, the
   * quad must have been a found sheet when it was accepted (drawn, paper
   * evidence behind it), and it must cover enough of the frame to be a page. The overlay's stale
   * horizon is replaced by {@link CAPTURE_GRACE_MS}, because that horizon is about what may
   * still be *drawn* and this is about what the user was looking at when they
   * tapped. The age travels with the quad rather than being resolved here: the
   * caller is about to spend more time still (a photo pipeline that can burn a
   * second and a half), and only it can add that leg before asking
   * `liveQuadSurvives` the real question.
   */
  const takeQuadForCapture = React.useCallback((): BufferedQuad | null => {
    const runtime = runtimeRef.current;
    const buffered = runtime.lastAccepted;
    // Only corners the viewfinder was showing as a found sheet travel.
    if (!runtime.live || buffered === null || !buffered.found) return null;
    const ageMs = performance.now() - buffered.capturedAt;
    if (ageMs < 0 || ageMs > CAPTURE_GRACE_MS) return null;
    // The buffer was accepted by `accept`, so it is judged by the same
    // conditioned floor it cleared there — from the candidate that produced
    // it, which travels with it.
    const floor = onScreenFloor(
      coverageFloor(buffered.source, buffered.confidence, MIN_QUAD_AREA_FRACTION),
      visibleRef.current,
    );
    if (normalizedCoverage(buffered.quad) < floor) return null;
    return {
      quad: buffered.quad,
      ageMs,
      source: buffered.source,
      confidence: buffered.confidence,
    };
  }, []);

  React.useEffect(() => {
    if (!loopLive) return;
    const runtime = runtimeRef.current;
    let cancelled = false;
    let detectTimer: number | null = null;
    let frameHandle: number | null = null;
    let trackedQuad = false;
    let announcedSearching = false;
    let announcedHint: HintKey | null = null;
    let announcedDirection: MoveDirection | null = null;
    let announcedReady = false;
    // What the probe last reported of the overlay (`lib/probe.ts`).
    let overlayProbedAt = Number.NEGATIVE_INFINITY;
    let probedTracking = false;
    let probedSearching = false;
    let probedReady = false;
    runtime.mlEpoch += 1;
    runtime.live = true;
    // Back from the confirm screen (or any pause): auto-capture's "another
    // page" is judged from now, against the scene as it is now — the first
    // motion probe of this run replaces the one from before the capture.
    guidanceRef.current.auto.resume(performance.now());
    runtime.firedLuma = null;
    // A probe kept across a pause would pair two frames minutes apart and read
    // the difference as a swing; the loop re-learns stillness from scratch.
    runtime.motionHistory = [];
    runtime.locked = false;
    runtime.evidenceMisses = 0;
    runtime.evidenceHits = 0;

    // ── 1. detection chain ───────────────────────────────────────────────────

    /**
     * The quad the overlay is showing as a found sheet, in the pixels of a
     * `width`×`height` sample — what a missed pass checks is still there.
     */
    function heldQuad(width: number, height: number): CornerPoints | null {
      if (!runtime.locked || runtime.displayTarget === null || runtime.evidenceUnavailable) return null;
      return denormalizeQuad(runtime.displayTarget, width, height);
    }

    /** The sample size for this video: its long edge at {@link SAMPLE_LONG_EDGE}. */
    function sampleSize(video: HTMLVideoElement): { width: number; height: number } {
      const scale = Math.min(
        1,
        SAMPLE_LONG_EDGE / Math.max(video.videoWidth, video.videoHeight),
      );
      return {
        width: Math.max(1, Math.round(video.videoWidth * scale)),
        height: Math.max(1, Math.round(video.videoHeight * scale)),
      };
    }

    /**
     * The preview's luma probe for the watch ({@link WATCH_MOVED}): drawn at
     * {@link WATCH_STAGE_WIDTH} first, then down to the probe — the same two
     * steps every time, so two probes differ by what the camera saw.
     */
    function watchProbe(video: HTMLVideoElement): Uint8ClampedArray | null {
      if (video.videoWidth === 0 || video.videoHeight === 0) return null;
      try {
        const stage = watchStageRef.current ?? document.createElement("canvas");
        watchStageRef.current = stage;
        const width = WATCH_STAGE_WIDTH;
        const height = Math.max(MOTION_PROBE_SIZE, Math.round((WATCH_STAGE_WIDTH * video.videoHeight) / video.videoWidth));
        if (stage.width !== width) stage.width = width;
        if (stage.height !== height) stage.height = height;
        const context = stage.getContext("2d", { willReadFrequently: true });
        if (context === null) return null;
        context.drawImage(video, 0, 0, width, height);
        const scratch = watchScratchRef.current ?? document.createElement("canvas");
        watchScratchRef.current = scratch;
        return probeLuma(stage, scratch);
      } catch {
        return null;
      }
    }

    /** The reused sample canvas, redrawn from the preview on every main-lane pass. */
    function sample(video: HTMLVideoElement): HTMLCanvasElement | null {
      const { width, height } = sampleSize(video);
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
      switchDetector(runtime, "classical", runtime.passLane);
    }

    /**
     * Whether this device can run this detector live at all. The model being
     * hopeless hands back to the classical loop; a classical loop measured as
     * hopeless is the end of live detection on this device and the screen
     * falls back to the static framing brackets. The verdict averages the
     * detector's own time (`detectMs`); the cadence is charged the whole pass.
     * How often a detector that *can* run is polled is the cadence's business
     * ({@link CadenceController}).
     */
    function adapt(costMs: number, detectMs: number, profile: PassProfile): boolean {
      if (runtime.warmupLeft > 0) {
        runtime.warmupLeft -= 1;
        return true;
      }
      runtime.cadence.record(costMs);
      // Auto-capture near a fire on the worker lane: read faster for these
      // few seconds — the fire waits on readings (`BOOST_DUTY`).
      runtime.intervalMs = runtime.boost && runtime.passLane === "worker" ? runtime.cadence.intervalAt(BOOST_DUTY) : runtime.cadence.intervalMs;
      runtime.averageMs =
        runtime.averageMs === null
          ? detectMs
          : runtime.averageMs * 0.7 + detectMs * 0.3;
      if (runtime.averageMs > profile.hopelessMs) {
        if (runtime.passSource === "ml") {
          fallBackToClassical();
          return true;
        }
        setAvailable(false);
        return false;
      }
      return true;
    }

    /** The luma probe of about {@link MOTION_SPAN_MS} ago, for this pass to compare with. */
    function motionAgainst(frameAt: number, luma: Uint8ClampedArray | null): number | null {
      if (luma === null) return null;
      const history = runtime.motionHistory;
      let reference: { at: number; luma: Uint8ClampedArray } | null = null;
      for (const entry of history) {
        if (frameAt - entry.at <= MOTION_SPAN_MS + 100) {
          reference = entry;
          break;
        }
      }
      reference ??= history[history.length - 1] ?? null;
      history.push({ at: frameAt, luma });
      while (history.length > 0 && frameAt - history[0].at > MOTION_SPAN_MS * 2) history.shift();
      return frameMotionScore(reference?.luma ?? null, luma);
    }

    /** One pass on the main thread: the path that shipped before the worker, plus the evidence. */
    async function mainPass(video: HTMLVideoElement, source: DetectionSource, profile: PassProfile): Promise<PassOutcome | null> {
      const started = performance.now();
      const canvas = sample(video);
      if (canvas === null) return null;
      // The motion probe reads the same frame the detector is about to —
      // probed before the await so the comparison is between what the two
      // passes actually saw, not whatever the preview shows afterwards.
      const scratch = motionScratchRef.current ?? document.createElement("canvas");
      motionScratchRef.current = scratch;
      const luma = probeLuma(canvas, scratch);
      // The chain's own frame is safe to hand either detector directly:
      // nothing redraws it until this pass has answered.
      const detection =
        source === "ml"
          ? await detectOnCanvasMl(canvas, profile.budgetMs, assetsRef.current)
          : await detectOnCanvas(canvas, profile.budgetMs, assetsRef.current);
      const detectMs = performance.now() - started;
      // Focus and light, off the same frame, outside the detector's own time.
      const reading = started - hintRef.current.at >= HINT_EVERY_MS ? readOn(canvas) : null;
      let evidence: EvidenceReading = null;
      let refined: CornerPoints | null = null;
      let refineMs: number | null = null;
      let check: CornerCheck | null = null;
      if (detection !== null) {
        let pixels: ImageData | null = null;
        try {
          pixels = canvas.getContext("2d", { willReadFrequently: true })?.getImageData(0, 0, canvas.width, canvas.height) ?? null;
        } catch {
          pixels = null;
        }
        let corners = detection.corners;
        const quad = pixels === null ? null : normalizeQuad(corners, canvas.width, canvas.height);
        if (pixels !== null && quad !== null) {
          const result = refineQuad(pixels, quad, { mode: detection.source === "ml" ? "full" : "local", budgetMs: LIVE_REFINE_BUDGET_MS });
          refineMs = result.ms;
          // Only an answer that ran to its end says anything about the corners.
          check = cornerCheckOf(result);
          if (result.changed) {
            corners = denormalizeQuad(result.quad, canvas.width, canvas.height);
            refined = corners;
          }
        }
        if (!runtime.evidenceUnavailable) {
          evidence = pixels === null ? "unavailable" : paperEvidence(pixels.data, canvas.width, canvas.height, corners);
        }
      }
      let heldEvidence: PaperEvidence | null = null;
      const held = heldQuad(canvas.width, canvas.height);
      const heldAt = held === null ? null : normalizeQuad(held, canvas.width, canvas.height);
      const foundAt = detection === null ? null : normalizeQuad(detection.corners, canvas.width, canvas.height);
      // Nothing found, or a quad found away from the held sheet: is it still there?
      if (held !== null && heldAt !== null && (foundAt === null || quadJump(foundAt, heldAt, canvas.height / canvas.width) > JUMP_RESET_DIAG)) {
        try {
          const pixels = canvas.getContext("2d", { willReadFrequently: true })?.getImageData(0, 0, canvas.width, canvas.height) ?? null;
          heldEvidence = pixels === null ? null : paperEvidence(pixels.data, canvas.width, canvas.height, held);
        } catch {
          heldEvidence = null;
        }
      }
      const elapsed = performance.now() - started;
      return {
        detection,
        refined,
        refineMs,
        check,
        heldEvidence,
        width: canvas.width,
        height: canvas.height,
        frameAt: started,
        luma,
        evidence,
        costMs: elapsed,
        detectMs,
        mainMs: elapsed,
        computeMs: null,
        queueMs: null,
        mlFailed: false,
        miss: null,
        reading,
      };
    }

    /** The frame's focus and light on the main-thread lane: the sample at the reading's 320 px. */
    function readOn(canvas: HTMLCanvasElement): FrameReading | null {
      try {
        const target = readingCanvasRef.current ?? document.createElement("canvas");
        readingCanvasRef.current = target;
        const width = HINT_SAMPLE_WIDTH;
        const height = Math.max(1, Math.round((HINT_SAMPLE_WIDTH * canvas.height) / canvas.width));
        if (target.width !== width) target.width = width;
        if (target.height !== height) target.height = height;
        const context = target.getContext("2d", { willReadFrequently: true });
        if (context === null) return null;
        context.drawImage(canvas, 0, 0, width, height);
        return readFrame(context.getImageData(0, 0, width, height));
      } catch {
        return null;
      }
    }

    /**
     * One pass in the worker: the frame grabbed at the sample size (the
     * browser's default resize quality — a finer one changes the model's
     * answers) and handed over; the worker answers corners, the motion probe
     * and the evidence of the same frame.
     */
    async function workerPass(video: HTMLVideoElement, source: DetectionSource, profile: PassProfile): Promise<PassOutcome | null> {
      const { width, height } = sampleSize(video);
      const frameAt = performance.now();
      const missed = (miss: "timeout" | "grab", mainMs: number): PassOutcome => ({
        detection: null,
        refined: null,
        refineMs: null,
        heldEvidence: null,
        width,
        height,
        frameAt,
        luma: null,
        evidence: null,
        costMs: performance.now() - frameAt,
        detectMs: performance.now() - frameAt,
        mainMs,
        computeMs: null,
        queueMs: null,
        mlFailed: false,
        miss,
        reading: null,
      });
      let frame: ImageBitmap;
      try {
        frame = await createImageBitmap(video, { resizeWidth: width, resizeHeight: height });
      } catch {
        return missed("grab", performance.now() - frameAt);
      }
      // A browser that hands back an empty bitmap for a video has grabbed nothing.
      if (frame.width === 0 || frame.height === 0) {
        frame.close();
        return missed("grab", performance.now() - frameAt);
      }
      const mainMs = performance.now() - frameAt;
      const reply = await laneDetect(
        {
          frame,
          width,
          height,
          plan: source,
          priority: "live",
          capturedAt: frameAt,
          epoch: runtime.mlEpoch,
          luma: true,
          refineMs: LIVE_REFINE_BUDGET_MS,
          evidence: !runtime.evidenceUnavailable,
          held: heldQuad(width, height),
          hint: frameAt - hintRef.current.at >= HINT_EVERY_MS,
        },
        profile.budgetMs,
      );
      if (reply.type === "miss") {
        // Dropped for a newer frame, or no worker any more: nothing to hold
        // against the lane. A worker that could not draw the frame, or did
        // not answer in time, is counted by the caller.
        return reply.why === "timeout" ? missed("timeout", mainMs) : reply.why === "error" ? missed("grab", mainMs) : null;
      }
      const detection: FrameDetection | null =
        reply.success && reply.corners !== null && reply.detector !== null
          ? { corners: reply.corners, confidence: reply.confidence, source: reply.detector }
          : null;
      return {
        detection,
        refined: detection === null ? null : reply.refined,
        check: detection === null ? null : (reply.check ?? null),
        refineMs: reply.refineMs,
        heldEvidence: reply.heldEvidence,
        width,
        height,
        frameAt,
        luma: reply.luma,
        // `null` — nothing read this pass (or a quad too degenerate to read):
        // the found state stays as it was. A worker that cannot read its own
        // pixels answers no detection at all.
        evidence: detection === null ? null : reply.evidence,
        costMs: reply.computeMs,
        // The detector's own time: the draw, refinement, evidence and hint
        // reading riding on the job have budgets of their own.
        detectMs: reply.detectMs,
        mainMs,
        computeMs: reply.computeMs,
        queueMs: reply.queueMs,
        mlFailed: reply.mlFailed,
        miss: null,
        reading: reply.hint,
      };
    }

    /**
     * One pass, with whichever detector this session is on, on whichever lane
     * it runs. Answers the delay before the next one, or null to stop the loop
     * for good — which only the classical detector may say: a device measured
     * as hopeless, and a pass that blew its budget (the same conclusion,
     * sooner). The model saying either hands the loop back rather than ending
     * it.
     */
    async function runPass(): Promise<number | null> {
      const video = videoRef.current;
      // Single-flight: the chain only ever schedules itself once a pass ends,
      // and this guard is the belt to that pair of braces. No pass while a
      // photo is being taken: the frames are the shutter's transition.
      if (runtime.detecting || runtime.capturing || video === null || video.videoWidth === 0) {
        return runtime.intervalMs;
      }
      const lane: DetectLaneKind = detectLane() ?? "main";
      if (runtime.laneGeneration !== detectLaneGeneration()) {
        // The lane moved (the worker died, stalled or lost its model): the
        // main thread warms its own model if it needs one, and everything is
        // measured afresh — the frame's focus and light included.
        runtime.laneGeneration = detectLaneGeneration();
        runtime.workerTimeouts = 0;
        runtime.workerGrabFailures = 0;
        if (lane === "main") {
          runtime.mlWarmUpStarted = false;
          hintRef.current = { at: Number.NEGATIVE_INFINITY };
          // scanic never loaded on this thread while the worker had it: pay
          // its import and WASM compile now, outside any measured pass — the
          // same reason the loop's start does on the main lane.
          runtime.detecting = true;
          try {
            await loadScanic(assetsRef.current);
          } finally {
            runtime.detecting = false;
          }
          if (cancelled) return null;
          return 0;
        }
      }
      // The handover, in one place: the warm-up settling promotes the model, a
      // latched failure demotes it, and the throttle starts measuring the
      // detector it is actually running, where it runs.
      const source = primaryDetector({
        ready: isMlDetectionReady(),
        disabled: isMlDetectionDisabled(),
      });
      if (source !== runtime.passSource || lane !== runtime.passLane) switchDetector(runtime, source, lane);
      const profile = PASS_PROFILES[source];
      // The question this pass answers: a capture or a restart that moves it
      // on while the pass is out makes the answer nobody's.
      const epoch = runtime.mlEpoch;
      runtime.detecting = true;
      // The watch's probe of the very frame this pass is about to read — the
      // ready cue's footing if the pass finds the sheet where it was.
      const watchLuma = runtime.locked ? watchProbe(video) : null;
      const started = performance.now();
      let outcome: PassOutcome | null = null;
      try {
        outcome = lane === "worker" ? await workerPass(video, source, profile) : await mainPass(video, source, profile);
      } finally {
        runtime.detecting = false;
      }
      if (cancelled) return null;
      const elapsed = performance.now() - started;
      if (outcome === null) return runtime.intervalMs;
      if (runtime.mlEpoch !== epoch || runtime.capturing) return runtime.intervalMs;
      if (lane === "worker") {
        // The worker runs one job at a time, so a pass it did not answer in
        // time is a pass behind another job (a capture's), not two
        // detections overlapping: a missed pass, never a verdict on the
        // detector. Only a worker that keeps missing — stuck, suspended, or
        // unable to take this browser's frames — hands the lane back.
        if (outcome.miss !== null) {
          reportPass(source, false, null, outcome, elapsed, false, null, outcome.miss === "timeout", false, null);
          if (outcome.miss === "timeout") runtime.workerTimeouts += 1;
          else runtime.workerGrabFailures += 1;
          if (runtime.workerTimeouts >= WORKER_STALL_LIMIT) demoteDetectLane("worker-stalled");
          else if (runtime.workerGrabFailures >= WORKER_GRAB_LIMIT) demoteDetectLane("frame-grab-failed");
          return runtime.intervalMs;
        }
        runtime.workerTimeouts = 0;
        runtime.workerGrabFailures = 0;
        if (outcome.mlFailed) {
          // The model failed in the worker: the page may still run it.
          demoteDetectLane("worker-ml-failed");
          return runtime.intervalMs;
        }
      } else if (outcome.mlFailed) {
        fallBackToClassical();
        return runtime.intervalMs;
      }
      // The pass blew through its budget, so its real work is still running
      // somewhere behind us — the ONE way two detections could overlap. For the
      // classical detector that is also proof this device has no business doing
      // live detection, and ending the loop keeps the single-flight guarantee
      // absolute; for the model, the same guarantee is kept by never running it
      // again this session.
      if (lane === "main" && elapsed >= profile.budgetMs) {
        reportPass(source, false, null, outcome, elapsed, false, null, true, false, null);
        if (source !== "ml") {
          setAvailable(false);
          return null;
        }
        fallBackToClassical();
        return runtime.intervalMs;
      }
      if (outcome.reading !== null) {
        hintRef.current.at = outcome.frameAt;
        runtime.reading = { at: outcome.frameAt, sharp: outcome.reading.hint !== "hold_still", luma: outcome.reading.meanLuma, bright: outcome.reading.brightLuma };
      }
      const motionScore = motionAgainst(outcome.frameAt, outcome.luma);
      // The frame this describes is the one the pass sampled, not the moment
      // the detector got round to answering.
      const { accepted, rejected } = accept(
        outcome.detection,
        outcome.width,
        outcome.height,
        outcome.frameAt,
        outcome.evidence,
        outcome.refined,
        outcome.check ?? null,
      );
      runtime.answer = passAnswer(outcome.detection, rejected, outcome.evidence);
      // A missed detection on a moved scene ends the hold: the stale
      // horizon exists to carry a stationary page through a flicker, and the
      // probe is what proves the page was not stationary. The capture buffer
      // goes with it — corners measured before a swing must not travel with a
      // photo taken after it. A missed detection on a *still* scene changes
      // nothing; that is the flicker the hold was built for.
      // A missed pass on a found sheet looks at where the sheet was: a page
      // slid away (on a white table the motion probe barely notices) leaves
      // no edges there, and two such readings end the hold — the overlay, the
      // found state and the capture buffer with it.
      // A quad found somewhere else that the loop did not take (under its
      // floor, superseded) says the same when nothing is left where the
      // sheet was — and so does a single such reading on a scene that moved
      // ({@link HELD_RELEASE_MOTION}): the page going is the motion.
      const heldGone =
        runtime.locked && outcome.heldEvidence !== null && !outcome.heldEvidence.ok && (outcome.detection !== null || (motionScore ?? 0) >= HELD_RELEASE_MOTION)
          ? true
          : outcome.detection === null && heldLost(outcome.heldEvidence);
      const holdBroken = (outcome.detection === null && motionBreaksHold(motionScore)) || (!accepted && heldGone);
      if (holdBroken) runtime.dropFast = true;
      if (holdBroken) {
        runtime.target = null;
        runtime.displayTarget = null;
        runtime.tracked = null;
        runtime.lastAccepted = null;
        runtime.locked = false;
        runtime.evidenceMisses = 0;
        runtime.evidenceHits = 0;
        runtime.filter.reset();
      }
      noteGuidance(outcome, accepted, rejected, holdBroken, motionScore, watchLuma);
      // The diagnostics HUD's numbers: a few floats, kept whether or not it is shown.
      const times = passTimesRef.current;
      times.push(outcome.detectMs);
      if (times.length > 31) times.shift();
      // Counted only for the diagnostics stream's sampler, which reads deltas.
      if (diagRef.current !== null) passCountRef.current += 1;
      frameAgeRef.current = performance.now() - outcome.frameAt;
      const keepGoing = adapt(outcome.costMs, outcome.detectMs, profile);
      reportPass(source, false, outcome.detection, outcome, elapsed, accepted, motionScore, false, holdBroken, rejected);
      if (!keepGoing) return null;
      // Deliberately after `adapt`: the warm-up is detached and carries a
      // multi-megabyte download, so nothing it costs may reach the average that
      // decides whether live detection is possible on this device at all.
      if (lane === "main") {
        try {
          maybeWarmUpMl(video);
        } catch {
          // An ML-only failure — the frame copy, the launch — is a fact about
          // this device or this deploy, exactly like a runtime that will not
          // load. The classical loop is untouched by it, which is the point.
          fallBackToClassical();
        }
      }
      return runtime.intervalMs - elapsed;
    }

    /**
     * The ready cue's stillness, judged once per confirming pass (never per
     * animation frame — a window that grows with every frame drops the cue
     * for a frame at a time): still over the last {@link STILL_WINDOW_MS},
     * not drifting since the conditions began, on enough readings — each
     * window at least 1.2 of the loop's interval, which a slow phone stretches.
     */
    function stillEnough(at: number): boolean {
      const aspect = visibleAspect();
      const readings = runtime.sheetReadings;
      // How often the page is actually read: the loop's interval, or — when a
      // pass takes longer than that (a big stream to grab, a busy worker) —
      // the spacing of the readings themselves. Judged on the interval alone,
      // a loop reading every 200 ms on a 120 ms interval never gathered
      // READY_MIN_READINGS readings in its window, and the cue never came on.
      const period = Math.max(runtime.intervalMs, readingSpacing(readings));
      const stillWindow = Math.max(STILL_WINDOW_MS, 1.2 * period);
      const stillness = motionOf(readings, aspect, stillWindow);
      const since = guidanceRef.current.ready.since;
      // At least READY_MIN_READINGS readings' worth of time, however slowly
      // the loop reads — and, when the readings came unevenly, the span of
      // the newest READY_MIN_READINGS of them (up to one interval more): five
      // readings held still are five readings, not "4 of 5" because one gap
      // ran over the median. A wider window only adds readings to the drift.
      const fifth = readings[readings.length - READY_MIN_READINGS]?.at ?? null;
      const spanOfMin = fifth === null ? 0 : Math.min(at - fifth, (READY_MIN_READINGS + 0.5) * period);
      const driftWindow = Math.max((since === null ? 0 : at - since) + stillWindow, (READY_MIN_READINGS - 0.5) * period, spanOfMin);
      const drift = motionOf(readings, aspect, driftWindow);
      const newest = readings[readings.length - 1]?.at ?? at;
      const seen = readings.filter((r) => newest - r.at <= driftWindow).length;
      const driftMax = seen >= READY_DENSE_READINGS ? READY_DRIFT_MAX : READY_DRIFT_MAX_SPARSE;
      const pc = (v: number) => (v * 100).toFixed(1);
      runtime.stillWhy =
        seen < READY_MIN_READINGS
          ? `readings ${seen}/${READY_MIN_READINGS}`
          : stillness === null || stillness > STILL_MAX
            ? `stillness ${stillness === null ? "–" : pc(stillness)}>${pc(STILL_MAX)} %`
            : drift === null || drift > driftMax
              ? `drift ${drift === null ? "–" : pc(drift)}>${pc(driftMax)} %`
              : null;
      return runtime.stillWhy === null;
    }

    /**
     * Settled, what auto-capture's countdown starts on: the newest
     * {@link SETTLE_READINGS} readings still within {@link STILL_MAX}, over at
     * least {@link SETTLE_WINDOW_MS} — the ready cue's full stillness and
     * drift are then gathered during the countdown, and the fire waits for
     * them.
     */
    function settledEnough(): boolean {
      return settledOn(runtime.sheetReadings, visibleAspect());
    }

    /**
     * What a pass tells the guidance (`lib/guidance.ts`): the found sheet's
     * reading (its motion) and its glare, or — no sheet found — a page
     * suspected too far away or cut off by the viewfinder's edge
     * ({@link CANDIDATE_READINGS}).
     */
    function noteGuidance(
      outcome: PassOutcome,
      accepted: boolean,
      rejected: string | null,
      holdBroken: boolean,
      motionScore: number | null,
      watch: Uint8ClampedArray | null,
    ): void {
      const aspect = outcome.height / outcome.width;
      if (holdBroken || !runtime.locked) {
        runtime.sheetReadings = [];
        runtime.glare = null;
        runtime.openHits = 0;
      }
      const detection = outcome.detection;
      const confirmed = accepted && runtime.locked && !holdBroken && runtime.shown !== null;
      if (confirmed && runtime.shown !== null) {
        const readings = runtime.sheetReadings;
        readings.push({ at: outcome.frameAt, quad: toVisible(runtime.shown, visibleRef.current) });
        while (readings.length > 0 && outcome.frameAt - readings[0].at > SHEET_READINGS_MS) readings.shift();
        if (outcome.evidence !== null && outcome.evidence !== "unavailable") {
          runtime.glare = outcome.evidence.glare;
          runtime.openHits = outcome.evidence.open > 0 ? runtime.openHits + 1 : 0;
        }
        // The ready cue's footing: this frame, found where it was.
        runtime.confirmedAt = Math.max(runtime.confirmedAt ?? outcome.frameAt, outcome.frameAt);
        if (runtime.suspectAt !== null && outcome.frameAt > runtime.suspectAt) runtime.suspectAt = null;
        if (watch !== null || runtime.watchBase === null) {
          runtime.watchBase = watch;
          runtime.watchMoved = false;
        }
        runtime.readyVerdict = stillEnough(outcome.frameAt);
        runtime.settledVerdict = settledEnough();
      } else {
        // A miss on a still scene with the held sheet still paper where it
        // was is the flicker the hold is for: it changes nothing. Anything
        // else says the page may not be where the brackets are.
        const neutral =
          !holdBroken &&
          detection === null &&
          (outcome.heldEvidence === null || outcome.heldEvidence.ok) &&
          (motionScore ?? 0) < HELD_RELEASE_MOTION;
        if (!neutral) {
          runtime.suspectAt = Math.max(runtime.suspectAt ?? outcome.frameAt, outcome.frameAt);
          runtime.readyVerdict = false;
          runtime.settledVerdict = false;
        }
      }
      // A suspected page: only while nothing is found.
      const evidence = outcome.evidence;
      // A found sheet speaks for itself; a suspicion from just before it
      // stands until it goes stale (a lock that comes and goes on a cut-off
      // page must not reset it).
      if (runtime.locked) return;
      // Nothing answered: the suspicion stands until it goes stale.
      if (detection === null) return;
      if (evidence === null || evidence === "unavailable" || detection.source !== "ml") {
        runtime.candidate = null;
        return;
      }
      const quad = normalizeQuad(outcome.refined ?? detection.corners, outcome.width, outcome.height);
      if (quad === null) {
        runtime.candidate = null;
        return;
      }
      const seen = toVisible(quad, visibleRef.current);
      const confidence = detection.confidence ?? 0;
      const onEdges = evidence.sideSupport.every((support) => support === null || support >= ENTRY_SIDE_SUPPORT);
      // Far away the print blurs to a few specks and the surface reading may
      // fail, but a small sheet the model is sure of still stands on four
      // clean edges with a smooth, one-way interior.
      const farPaper =
        evidence.ok ||
        (evidence.sidesKnown === 4 &&
          evidence.sidesSupported === 4 &&
          evidence.background >= FAR_MIN_BACKGROUND &&
          evidence.counterInk <= evidence.ink * PAPER.maxCounterRatio + PAPER.counterFloor &&
          evidence.solidInk <= PAPER.maxSolidInk);
      const far = confidence >= ML_TRUSTED_CONFIDENCE && farPaper && onEdges && areaShare(seen) < FAR_CANDIDATE_AREA && (rejected === "floor" || rejected === null);
      // Cut off: a corner at or past the viewfinder's edge, or an edgeless
      // side with the page's paper running on past it to the frame's edge.
      const cutOff = evidence.open > 0;
      const cut = confidence >= CUT_CANDIDATE_MIN_CONFIDENCE && (borderMargin(seen) < BORDER_EXIT || cutOff) && paperSurface(evidence) && evidence.sidesSupported >= 2;
      if (!far && !cut) {
        runtime.candidate = null;
        return;
      }
      // Readings in a row, wherever they fall: the model's quad for a page
      // the frame cuts off swings between readings, and the suspicion is
      // about the page, not a place.
      const previous = runtime.candidate;
      runtime.candidate = { quad, at: outcome.frameAt, hits: previous === null ? 1 : previous.hits + 1, cutOff: cut && cutOff && borderMargin(seen) >= BORDER_EXIT };
    }

    /**
     * One pass, as the bench sees it (`lib/probe.ts`). Positional so a page
     * without a listener builds nothing: the check comes first.
     */
    function reportPass(
      source: DetectionSource,
      warmUp: boolean,
      detection: FrameDetection | null,
      outcome: Pick<PassOutcome, "width" | "height" | "frameAt" | "mainMs" | "computeMs" | "queueMs" | "evidence"> &
        Partial<Pick<PassOutcome, "refined" | "refineMs" | "heldEvidence" | "reading">> & { lane?: DetectLaneKind },
      passMs: number,
      accepted: boolean,
      motion: number | null,
      timedOut: boolean,
      holdBroken: boolean,
      rejected: string | null,
    ): void {
      if (!probing()) return;
      const { width, height } = outcome;
      const quad =
        detection === null ? null : normalizeQuad(detection.corners, width, height);
      probe({
        type: "detect",
        t: performance.now(),
        frameAt: outcome.frameAt,
        source,
        warmUp,
        ok: detection !== null,
        quad,
        confidence: detection?.confidence ?? null,
        coverage: quad === null ? null : normalizedCoverage(quad),
        floor:
          detection === null
            ? null
            : onScreenFloor(
                coverageFloor(detection.source, detection.confidence, MIN_QUAD_AREA_FRACTION),
                visibleRef.current,
              ),
        accepted,
        passMs,
        intervalMs: runtime.intervalMs,
        sampleW: width,
        sampleH: height,
        motion,
        timedOut,
        holdBroken,
        lane: outcome.lane ?? runtime.passLane,
        mainMs: outcome.mainMs,
        computeMs: outcome.computeMs,
        queueMs: outcome.queueMs,
        evidence: outcome.evidence === "unavailable" ? null : outcome.evidence,
        refinedQuad:
          detection === null || outcome.refined === null || outcome.refined === undefined
            ? null
            : normalizeQuad(outcome.refined, width, height),
        refineMs: outcome.refineMs ?? null,
        locked: runtime.locked,
        rejected,
        heldEvidence: outcome.heldEvidence ?? null,
        reading: outcome.reading ?? null,
      });
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
     * A missed pass's reading of the held sheet. Answers true once
     * {@link LOCK_RELEASE_MISSES} readings in a row say it is no longer there.
     */
    function heldLost(evidence: PaperEvidence | null): boolean {
      if (evidence === null || !runtime.locked) return false;
      if (evidence.ok) {
        runtime.evidenceMisses = 0;
        return false;
      }
      runtime.evidenceMisses += 1;
      return runtime.evidenceMisses >= LOCK_RELEASE_MISSES;
    }

    /**
     * The found-sheet state after an accepted detection. "Found" needs
     * {@link LOCK_CONFIRM_READINGS} readings in a row that say paper with
     * every visible side on some edge; a found sheet survives one bad reading
     * (a shadow, a glare on an edge) and is let go after
     * {@link LOCK_RELEASE_MISSES}. A pass that did not read the
     * evidence changes nothing; a device that cannot read it has every
     * tracked quad found, as before evidence existed.
     *
     * Two exceptions, both about a sheet this page has just seen: a quad
     * where a sheet was found within {@link RECALL_MS} is found again on one
     * reading, and a found sheet whose sides all still stand on edges
     * ({@link KEEP_SIDE_SUPPORT}) does not lose a reading to its surface
     * alone.
     */
    function updateLock(evidence: EvidenceReading, shown: NormalizedQuad, aspect: number): void {
      if (evidence === "unavailable") {
        runtime.evidenceUnavailable = true;
        runtime.locked = true;
        return;
      }
      if (runtime.evidenceUnavailable) {
        runtime.locked = true;
        return;
      }
      if (evidence === null) return;
      const now = performance.now();
      // To become found, every side the frame shows must lie on some edge: a
      // quad with a corner pulled onto the text or the desk has a side across
      // the page with no step under it at all, and drawing it would put
      // brackets off the page. (A weak side — a thumb over it, a faint white
      // table — still has steps along part of it.) A found sheet keeps its
      // lock with one side lost, as the evidence itself allows.
      const convincing = runtime.locked
        ? evidence.ok
        : evidence.ok && evidence.sideSupport.every((support) => support === null || support >= ENTRY_SIDE_SUPPORT);
      if (convincing) {
        runtime.evidenceMisses = 0;
        runtime.evidenceHits += 1;
        // Only a reading with every side the frame shows standing on its
        // edges: the model flipping between a page and a corner pulled
        // onto the table must not be drawn on every other flip.
        const recalled =
          evidence.sideSupport.every((support) => support === null || support >= KEEP_SIDE_SUPPORT) &&
          lastFoundSheet !== null &&
          now - lastFoundSheet.at <= RECALL_MS &&
          quadJump(lastFoundSheet.quad, shown, aspect) <= JUMP_RESET_DIAG;
        if (runtime.evidenceHits >= (recalled ? 1 : LOCK_CONFIRM_READINGS)) runtime.locked = true;
        if (runtime.locked) lastFoundSheet = { quad: shown, at: now };
        return;
      }
      runtime.evidenceHits = 0;
      if (!runtime.locked) return;
      // Steeply tilted and still on its edges, all round: the surface
      // reading is what failed, not the sheet. Neither a hit nor a miss.
      const onEdges =
        foreshortening(shown, aspect) <= KEEP_FORESHORTENING &&
        evidence.sidesKnown >= 3 &&
        evidence.sideSupport.every((support) => support === null || support >= KEEP_SIDE_SUPPORT);
      if (onEdges) {
        lastFoundSheet = { quad: shown, at: now };
        return;
      }
      runtime.evidenceMisses += 1;
      if (runtime.evidenceMisses >= LOCK_RELEASE_MISSES) {
        runtime.locked = false;
        runtime.evidenceMisses = 0;
        runtime.evidenceHits = 0;
      }
    }

    /**
     * Take a detection the loop is willing to track. `accepted` when it was;
     * `rejected` names why an answer was turned away.
     *
     * A miss is not a loss: the animation loop retires a quad on staleness, so
     * one dropped detection doesn't make the overlay blink. Only capture-worthy
     * page candidates are tracked — smaller contours are usually text blocks
     * and made the overlay jump — and the coverage gate is also the ONLY thing
     * bounding an ML quad, whose detector ignores `minDocumentCoverageRatio`.
     * A classical quad must also pass its sanity checks, and none is taken
     * once the model is ready.
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
      evidence: EvidenceReading,
      refined: CornerPoints | null = null,
      check: CornerCheck | null = null,
    ): { accepted: boolean; rejected: string | null } {
      if (detection === null) return { accepted: false, rejected: null };
      const quad = normalizeQuad(detection.corners, width, height);
      // Conditioned like the capture path: a page that fills the visible
      // object-cover window can still be well under 0.35 of the full 16:9 frame
      // this loop samples, and holding a sure model to the classical floor is
      // what made the brackets flash on and off over a perfectly framed page.
      // …and judged as a share of what the person SEES: a full-bleed
      // viewfinder over a stream wider than the screen shows a fraction of
      // the frame, and a page filling the screen is that fraction's page.
      const floor = onScreenFloor(
        coverageFloor(detection.source, detection.confidence, MIN_QUAD_AREA_FRACTION),
        visibleRef.current,
      );
      if (quad === null || normalizedCoverage(quad) < floor) {
        return { accepted: false, rejected: "floor" };
      }
      if (detection.source === "classical") {
        // Honest classical: the model is the better detector, and the
        // classical one's confident failures — the desk, the frame's edge, a
        // text block, a sliver — are exactly what a user must not be shown.
        if (isMlDetectionReady() && !isMlDetectionDisabled()) return { accepted: false, rejected: "ml-ready" };
        const read = evidence === "unavailable" ? null : evidence;
        if (!classicalQuadSane(detection.corners, width, height, read)) return { accepted: false, rejected: "classical-sanity" };
      }
      const now = performance.now();
      const candidate: DetectionCandidate = {
        source: detection.source,
        confidence: detection.confidence,
        capturedAt,
      };
      const authorityMs = staleHorizonMs("ml", runtime.intervalMs);
      if (!supersedesDetection(candidate, runtime.tracked, now, authorityMs)) {
        return { accepted: false, rejected: "superseded" };
      }
      const aspect = height / width;
      // Drawn: the answer moved onto the paper's edges on this very frame,
      // when the refinement could; tracked and buffered: the detector's own.
      const shown = refined === null ? quad : (normalizeQuad(refined, width, height) ?? quad);
      // "Another page" is judged on where the page is — the refined quads.
      // The model's own answer can swing between two readings of one page (a
      // corner pulled onto the print on every other frame) that its
      // refinement puts back on the same edges.
      const previous = runtime.target === null ? null : runtime.shown;
      const jumped =
        previous === null || runtime.tracked?.source !== detection.source || quadJump(previous, shown, aspect) > JUMP_RESET_DIAG;
      if (jumped) {
        // Another page, or the same one somewhere else: nothing to smooth
        // from, "found" is earned again, and its motion starts afresh.
        if (runtime.locked) runtime.dropFast = true;
        runtime.filter.reset();
        runtime.sheetReadings = [];
        runtime.locked = false;
        runtime.evidenceMisses = 0;
        runtime.evidenceHits = 0;
        runtime.check = null;
        runtime.checkAt = null;
        runtime.checkQuad = null;
        runtime.unknownSince = null;
        runtime.separateSince = null;
      }
      // What the newest measuring pass said about the corners holds until the
      // next one says otherwise (a pass that ran out of time says nothing).
      if (check !== null) {
        runtime.check = check;
        runtime.checkAt = capturedAt;
        runtime.checkQuad = shown;
        runtime.unknownSince = hasUnknown(check) ? (runtime.unknownSince ?? capturedAt) : null;
        runtime.separateSince = check.separate ? (runtime.separateSince ?? capturedAt) : null;
      }
      runtime.target = quad;
      runtime.shown = shown;
      runtime.displayTarget = runtime.filter.update(shown, capturedAt, aspect);
      runtime.tracked = candidate;
      // The capture buffer takes the accepted quad as drawn — the model's
      // answer on the paper's edges, never the display filter's — dated by
      // the frame it describes: the same clock the stale horizon reads, so an
      // age computed against it means what a capture thinks it means.
      updateLock(evidence, shown, aspect);
      runtime.lastAccepted = {
        quad: shown,
        capturedAt,
        source: candidate.source,
        confidence: candidate.confidence,
        found: runtime.locked,
      };
      return { accepted: true, rejected: null };
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
     * Start the model on the main thread, on the first frame this screen ever
     * sampled — the main-thread lane only: on the worker lane the worker
     * warmed its own the moment the screen mounted.
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
        const { accepted, rejected } = accept(detection, width, height, now, null);
        runtime.answer = passAnswer(detection, rejected, null);
        const ms = performance.now() - now;
        reportPass(
          "ml",
          true,
          detection,
          { width, height, frameAt: now, mainMs: ms, computeMs: null, queueMs: null, evidence: null, lane: "main" },
          ms,
          accepted,
          null,
          false,
          false,
          rejected,
        );
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
        const cap = bracketCap();
        // Seen corners get the solid bracket, inferred ones the dashed, an
        // unknown one none (`lib/corner-check.ts`).
        const check = runtime.check;
        const seen = check === null ? undefined : CORNER_KEYS.map((key) => check.corners[key] === "seen");
        const inferred = check === null ? null : CORNER_KEYS.map((key) => check.corners[key] === "inferred");
        const brackets = cornerBracketPath(quad, BRACKET_EDGE_FRACTION, cap, seen);
        overlay.bracketsHalo.current?.setAttribute("d", brackets);
        overlay.brackets.current?.setAttribute("d", brackets);
        const dashed = inferred === null || !inferred.some(Boolean) ? "" : cornerBracketPath(quad, BRACKET_EDGE_FRACTION, cap, inferred);
        overlay.inferredHalo.current?.setAttribute("d", dashed);
        overlay.inferred.current?.setAttribute("d", dashed);
        // The countdown grows along each mark from its corner.
        const progress = runtime.countdown;
        overlay.countdown.current?.setAttribute(
          "d",
          progress === null || progress <= 0
            ? ""
            : cornerBracketPath(quad, BRACKET_EDGE_FRACTION * progress, { ...cap, length: cap.length * progress }),
        );
        paintRing(overlay.ring.current, progress);
      } else {
        overlay.countdown.current?.setAttribute("d", "");
        paintRing(overlay.ring.current, null);
      }
      group.style.opacity = runtime.opacity.toFixed(3);
      // The experimental layouts' corner anchor: in stage pixels, through the
      // frame box the quad is drawn in, faded with the brackets.
      const anchor = overlay.anchor.current;
      if (anchor !== null) {
        const box = frameBoxRef.current;
        if (quad !== null && box !== null) {
          anchor.style.setProperty("--scan-anchor-x", `${(box.left + quad.topLeft.x * box.width).toFixed(1)}px`);
          anchor.style.setProperty("--scan-anchor-y", `${(box.top + quad.topLeft.y * box.height).toFixed(1)}px`);
          anchor.style.opacity = runtime.opacity.toFixed(3);
        } else {
          anchor.style.opacity = "0";
        }
      }
    }

    /**
     * The arrow of "Mova o celular" ({@link LiveOverlayRefs.nudge}): at the
     * middle of the visible region's edge on the side to move toward, in
     * stage pixels; hidden with no direction.
     */
    function paintNudge(direction: MoveDirection | null): void {
      const element = overlay.nudge?.current ?? null;
      if (element === null) return;
      const box = frameBoxRef.current;
      if (direction === null || box === null) {
        if (element.dataset.direction !== "") element.dataset.direction = "";
        return;
      }
      const v = visibleRef.current;
      const left = box.left + v.x * box.width;
      const top = box.top + v.y * box.height;
      const width = v.width * box.width;
      const height = v.height * box.height;
      const x = direction === "left" ? left : direction === "right" ? left + width : left + width / 2;
      const y = direction === "up" ? top : direction === "down" ? top + height : top + height / 2;
      element.style.setProperty("--scan-nudge-x", `${x.toFixed(1)}px`);
      element.style.setProperty("--scan-nudge-y", `${y.toFixed(1)}px`);
      if (element.dataset.direction !== direction) element.dataset.direction = direction;
    }

    /** The visible crop's height over its width, in pixels of the frame. */
    function visibleAspect(): number {
      const size = videoSizeRef.current;
      const visible = visibleRef.current;
      if (size === null || size.width === 0 || visible.width === 0) return 1;
      return (visible.height * size.height) / (visible.width * size.width);
    }

    /**
     * One moment of guidance (`lib/guidance.ts`): the hint, the ready cue and
     * auto-capture, from what the loop holds right now. Answers whether
     * auto-capture fires.
     */
    function guide(now: number, tracking: boolean): boolean {
      const guidance = guidanceRef.current;
      const visible = visibleRef.current;
      const aspect = visibleAspect();
      const candidate = runtime.candidate;
      const convincing =
        !tracking && candidate !== null && candidate.hits >= CANDIDATE_READINGS && now - candidate.at <= staleHorizonMs("ml", runtime.intervalMs);
      const suspected = convincing ? candidate.quad : null;
      const sheetFrame = tracking ? runtime.shown : suspected;
      const sheet = sheetFrame === null ? null : toVisible(sheetFrame, visible);
      if (sheet !== null) runtime.sheetSeenAt = now;
      runtime.fill = sheet === null ? null : fillShare(sheet);
      // A corner under a control drawn over the picture is a corner the
      // person cannot see: the page is cut off to them, as at an edge.
      const covered =
        sheetFrame !== null &&
        spotsRef.current.length > 0 &&
        cornerUnderSpot([sheetFrame.topLeft, sheetFrame.topRight, sheetFrame.bottomRight, sheetFrame.bottomLeft], spotsRef.current);
      // The hint's window over the found sheet's readings (a trembling hand)
      // — at least 2.5 of the loop's interval, which a slow phone stretches.
      const shakeWindow = Math.max(SHAKE_WINDOW_MS, 2.5 * runtime.intervalMs);
      const motion = tracking ? motionOf(runtime.sheetReadings, aspect, shakeWindow) : null;
      // …the hint's own on the readings since a framing hint left the slot:
      // the move it asked for is not shaking.
      const shake = tracking ? shakeMotion(runtime.sheetReadings, aspect, shakeWindow, runtime.framedAt) : null;
      const reading = runtime.reading !== null && now - runtime.reading.at <= READING_FRESH_MS ? runtime.reading : null;
      // What lies over the page (`lib/corner-check.ts`). An uncertain page —
      // a corner inferred or unknown, another sheet over it — is never ready
      // and never auto-captured (owner rule); its hint is owed only once it
      // has held on a found page, so a pass that misreads a corner once does
      // not put words on screen.
      const check = tracking ? runtime.check : null;
      // Fails closed: a page whose corners no recent pass measured on (about)
      // this quad — every pass out of its refinement budget, or the quad
      // drifted since — is as uncertain as one with a covered corner.
      const measured = tracking && checkSpeaks(runtime, aspect);
      const uncertain = tracking && (!measured || isUncertain(check));
      const occlusion =
        !tracking || !runtime.locked
          ? null
          : runtime.separateSince !== null && now - runtime.separateSince >= OCCLUSION_HINT_AFTER_MS
            ? "separate"
            : runtime.unknownSince !== null && now - runtime.unknownSince >= OCCLUSION_HINT_AFTER_MS
              ? "covered"
              : null;
      const raw = rawHint(
        {
          now,
          since: runtime.loopStartedAt,
          locked: tracking,
          sheet,
          sheetSeenAt: runtime.sheetSeenAt,
          cutOff: tracking ? runtime.openHits >= OPEN_READINGS : convincing && candidate.cutOff,
          covered,
          aspect,
          motion: shake,
          sharp: reading?.sharp ?? null,
          bright: reading?.bright ?? null,
          glare: tracking ? runtime.glare : null,
          occlusion,
        },
        guidance.hints.current,
      );
      // The camera watched between passes while the cue is on or counting.
      const watching = tracking && (guidance.ready.since !== null || announcedReady || runtime.countdown !== null);
      if (watching && now - runtime.watchAt >= WATCH_EVERY_MS) watch(now);
      // On its footing: the page found where it was by a recent pass, and
      // nothing since saying otherwise.
      const footed =
        tracking &&
        runtime.suspectAt === null &&
        runtime.confirmedAt !== null &&
        now - runtime.confirmedAt <= READY_STALE_MS + 2 * runtime.intervalMs;
      const footing = footed && !runtime.watchMoved;
      // The hint slot and the brackets never disagree: the cue comes on only
      // once the slot has emptied (at its own pace — a hint snatched away the
      // moment it appeared is the flicker the debounce exists to prevent),
      // and while the cue is on the slot stays empty.
      const before = guidance.hints.current;
      const shown = announcedReady ? guidance.hints.value : guidance.hints.update(raw, now);
      if (FRAMING_HINTS.has(before) && !FRAMING_HINTS.has(guidance.hints.current)) runtime.framedAt = now;
      const strict = footing && !covered && !uncertain && raw === null && shown === null && runtime.readyVerdict && reading?.sharp !== false;
      // A wobble keeps the cue; shaking (the hold-still hint owed) does not —
      // nor a corner that something lies over.
      const keep = footing && !covered && !uncertain && shown === null && raw === null;
      const isReady = guidance.ready.update(strict, keep, now);
      // Settled: the same, on the short stillness window — auto-capture's
      // countdown starts here, and the cue's full stillness is gathered while
      // it runs (the fire waits for the cue). The camera watch blocks the
      // fire (through the cue, and once more at its instant) but does not
      // restart the countdown: a hand's tremor at a slow cadence trips it
      // every few hundred milliseconds, each trip cleared by the next pass
      // on a later frame, and a countdown restarted on every one never
      // finished (bench present-auto: 3 s of "camera moved" / "countdown 0 %").
      // A camera that really left the page loses the footing at that pass.
      const settledStrict = footed && !covered && !uncertain && raw === null && shown === null && runtime.settledVerdict && reading?.sharp !== false;
      const settledKeep = footed && !covered && !uncertain && shown === null && raw === null;
      guidance.settled.update(settledStrict, settledKeep, now);
      runtime.timeline.update(now, {
        lock: tracking,
        hint: raw === null && !covered,
        slot: shown === null,
        still: runtime.readyVerdict && reading?.sharp !== false,
        check: tracking && !uncertain,
        footing,
      });
      // The HUD's reason: the first condition keeping the cue off.
      runtime.blockWhy = isReady
        ? null
        : !tracking
          ? "no page locked"
          : covered
            ? "corner under a control"
            : uncertain
              ? !measured
                ? "corners unmeasured"
                : check?.separate
                  ? "sheets overlap"
                  : `corner ${hasUnknown(check) ? "unknown" : "inferred"}`
              : raw !== null
              ? `hint ${raw}`
              : shown !== null
                ? `hint slot ${shown}`
                : runtime.suspectAt !== null
                  ? "a pass missed the page"
                  : runtime.watchMoved
                    ? `camera moved (watch ${runtime.watchScore === null ? "–" : runtime.watchScore.toFixed(3)})`
                    : runtime.confirmedAt === null || now - runtime.confirmedAt > READY_STALE_MS + 2 * runtime.intervalMs
                      ? `no fresh pass (${runtime.confirmedAt === null ? "none" : `${Math.round(now - runtime.confirmedAt)} ms`})`
                      : !runtime.readyVerdict
                        ? (runtime.stillWhy ?? "not still")
                        : reading?.sharp === false
                          ? "blurry"
                          : "dwell";
      if (guidance.tick.update(isReady, tracking, now)) setReadyTick((n) => n + 1);
      let fire = false;
      runtime.countdown = null;
      const lockedSince = runtime.timeline.since("lock");
      runtime.boost =
        autoCaptureRef.current &&
        tracking &&
        runtime.locked &&
        guidance.auto.armed &&
        (raw === null || raw === "hold-still" || (FRAMING_HINTS.has(raw) && lockedSince !== null && now - lockedSince <= BOOST_FRAMING_MS));
      if (autoCaptureRef.current) {
        const latest = runtime.motionHistory[runtime.motionHistory.length - 1]?.luma ?? null;
        // Back from the confirm screen, the scene is compared with itself as it was then.
        if (!guidance.auto.armed && runtime.firedLuma === null) runtime.firedLuma = latest;
        const auto = guidance.auto.update({
          now,
          readyOnSince: guidance.settled.onSince,
          sheet: tracking ? sheet : null,
          moving: motion !== null && motion > SHAKY_ENTER,
          aspect,
          sceneChange: runtime.firedLuma === null || latest === null ? null : frameMotionScore(runtime.firedLuma, latest),
          confirmedAt: runtime.confirmedAt,
          steady: guidance.ready.steady,
          ready: guidance.ready.onSince !== null,
          agree: tracking && readingsAgree(runtime.sheetReadings, aspect),
          frameAgeMax: autoFrameAgeMax(runtime.intervalMs),
        });
        runtime.countdown = auto.countdown;
        runtime.countdownStart = auto.countdown === null ? null : (auto.start ?? null);
        if ((isReady || auto.countdown !== null) && !auto.fire) {
          runtime.blockWhy = !guidance.auto.armed
            ? "auto: waiting for another page"
            : auto.countdown === null
              ? sheet === null || !tracking
                ? "auto: no sheet"
                : `auto: ${runtime.stillWhy ?? (raw !== null ? `hint ${raw}` : "not steady")}`
              : auto.countdown < 1
                ? `auto: countdown ${Math.round(auto.countdown * 100)} %`
                : !guidance.ready.steady
                  ? `auto: holding (${runtime.stillWhy ?? "wobble"})`
                  : guidance.ready.onSince === null
                    ? "auto: waiting for the cue"
                    : "auto: waiting for a fresh pass";
        }
        // One last look at the camera, at the instant of the photo — and,
        // whatever the cue said, never on an uncertain page (owner rule: a
        // corner inferred or unknown, or another sheet over the page, is for
        // the person to judge, with the shutter).
        fire = auto.fire && !uncertain && watch(now);
        if (auto.fire && !fire) {
          runtime.blockWhy = uncertain
            ? measured
              ? "auto: cancelled, corner uncertain"
              : "auto: cancelled, corners unmeasured"
            : `auto: cancelled, camera moved (watch ${runtime.watchScore === null ? "–" : runtime.watchScore.toFixed(3)})`;
          // Not taken: the page is still owed its one fire.
          guidance.auto.retract();
          guidance.ready.update(false, false, now);
          runtime.countdown = null;
          runtime.countdownStart = null;
        }
        if (fire) {
          runtime.firedLuma = latest;
          runtime.lastFire = {
            at: now,
            marks: {
              ...runtime.timeline.snapshot(),
              strict: guidance.ready.since,
              ready: guidance.ready.onSince,
              settled: guidance.settled.onSince,
              countdown: auto.start ?? null,
              end: auto.end ?? null,
              confirm: runtime.confirmedAt,
            },
          };
        }
        else if (guidance.auto.armed) runtime.firedLuma = null;
      }
      // "Mova o celular": which way, kept while the hint shows (`DirectionLatch`).
      const direction = guidance.direction.update(shown === "move-phone" && sheet !== null ? moveDirection(sheet, guidance.direction.value) : null, now);
      runtime.nudge = direction;
      paintNudge(direction);
      if (direction !== announcedDirection) {
        announcedDirection = direction;
        setHintDirection(direction);
      }
      if (shown !== announcedHint) {
        announcedHint = shown;
        setHint(shown);
        setHintFill(runtime.fill);
      }
      const diag = diagRef.current;
      if (diag !== null) noteDiagnostics(diag, now, isReady, fire);
      if (isReady !== announcedReady) {
        announcedReady = isReady;
        setReady(isReady);
      }
      return fire;
    }

    /**
     * The ready cue's and auto-capture's transitions, for the diagnostics
     * stream: read from the state this pass of the guidance just left.
     */
    function noteDiagnostics(diag: DiagnosticsSink, now: number, isReady: boolean, fire: boolean): void {
      const memo = diagStateRef.current;
      const guidance = guidanceRef.current;
      if (isReady !== announcedReady) {
        diag.emit({
          type: "ready",
          on: isReady,
          ms: isReady || memo.readyAt === null ? null : now - memo.readyAt,
          why: isReady ? null : runtime.blockWhy,
          fill: runtime.fill,
          ...(isReady ? { phases: { ...phasesBefore(now, runtime.timeline.snapshot()), intervalMs: Math.round(runtime.intervalMs) } } : {}),
        });
        memo.readyAt = isReady ? now : null;
      }
      const armed = guidance.auto.armed;
      if (armed && !memo.armed && autoCaptureRef.current) diag.emit({ type: "auto", phase: "rearmed", ms: null, reason: null });
      memo.armed = armed;
      if (fire) {
        const since = guidance.ready.onSince;
        const marks = runtime.lastFire?.marks ?? null;
        diag.emit({
          type: "auto",
          phase: "fire",
          ms: since === null ? null : now - since,
          reason: null,
          phases: marks === null ? null : { ...phasesBefore(now, marks), intervalMs: Math.round(runtime.intervalMs) },
        });
        memo.countdownAt = null;
      } else if (runtime.countdown !== null && memo.countdownAt === null) {
        memo.countdownAt = now;
        diag.emit({
          type: "auto",
          phase: "countdown",
          ms: null,
          reason: null,
          phases: { ...phasesBefore(now, runtime.timeline.snapshot()), intervalMs: Math.round(runtime.intervalMs) },
        });
      } else if (runtime.countdown === null && memo.countdownAt !== null) {
        diag.emit({
          type: "auto",
          phase: "cancel",
          ms: now - memo.countdownAt,
          reason: autoCaptureRef.current ? (runtime.blockWhy ?? "ready lost") : "switched off",
        });
        memo.countdownAt = null;
      }
    }

    /**
     * Look at the camera now ({@link WATCH_MOVED}): answers whether it still
     * shows what the newest confirming pass read. A probe that cannot be
     * taken, or nothing to compare it with, is no evidence either way.
     */
    function watch(now: number): boolean {
      runtime.watchAt = now;
      const video = videoRef.current;
      const base = runtime.watchBase;
      if (video === null || base === null) return !runtime.watchMoved;
      const seen = watchProbe(video);
      const score = seen === null ? null : frameMotionScore(base, seen);
      runtime.watchScore = score;
      if (score !== null && score >= WATCH_MOVED) runtime.watchMoved = true;
      return !runtime.watchMoved;
    }

    /** Whether the overlay has been sampled since the capture froze it. */
    let frozenProbed = false;

    function frame(now: number): void {
      frameHandle = null;
      if (cancelled) return;
      if (runtime.capturing) {
        // Frozen on the quad the tap was made on: no easing, no fade, no
        // guidance — only the same brackets, painted where they were.
        runtime.lastFrameAt = now;
        paint();
        if (probing() && (!frozenProbed || now - overlayProbedAt >= OVERLAY_PROBE_INTERVAL_MS)) {
          // The first frozen frame is always sampled: the quad of the tap.
          frozenProbed = true;
          overlayProbedAt = now;
          probe({
            type: "overlay",
            t: now,
            quad: runtime.current,
            opacity: runtime.opacity,
            hasQuad: trackedQuad,
            searching: announcedSearching,
            locked: runtime.locked,
            ready: announcedReady,
            countdown: null,
            watch: runtime.watchScore,
            capturing: true,
          });
        }
        frameHandle = window.requestAnimationFrame(frame);
        return;
      }
      frozenProbed = false;
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
        runtime.displayTarget = null;
        runtime.locked = false;
        runtime.evidenceMisses = 0;
        runtime.evidenceHits = 0;
        runtime.filter.reset();
      }
      // Drawn only once found: a tracked quad without paper behind it is a
      // candidate, and the brackets are a claim. A classical quad still held
      // from before the model came up stops being drawn the moment it has.
      const classicalAfterMl =
        detected?.source === "classical" && isMlDetectionReady() && !isMlDetectionDisabled();
      const tracking = runtime.displayTarget !== null && runtime.locked && !classicalAfterMl;

      if (tracking && runtime.displayTarget !== null) {
        runtime.current =
          runtime.current === null || reducedRef.current
            ? runtime.displayTarget
            : lerpQuad(runtime.current, runtime.displayTarget, 1 - Math.exp(-deltaMs / DISPLAY_EASE_MS));
      }
      if (tracking) runtime.dropFast = false;
      if (reducedRef.current) {
        runtime.opacity = tracking ? 1 : 0;
      } else {
        const step = deltaMs / (tracking ? FADE_IN_MS : runtime.dropFast ? FADE_OUT_GONE_MS : FADE_OUT_MS);
        runtime.opacity = Math.min(
          1,
          Math.max(0, runtime.opacity + (tracking ? step : -step)),
        );
      }
      if (runtime.opacity === 0) runtime.current = null;
      const fire = guide(now, tracking);
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
      if (
        probing() &&
        (tracking !== probedTracking ||
          isSearching !== probedSearching ||
          announcedReady !== probedReady ||
          now - overlayProbedAt >= OVERLAY_PROBE_INTERVAL_MS)
      ) {
        overlayProbedAt = now;
        probedTracking = tracking;
        probedSearching = isSearching;
        probedReady = announcedReady;
        probe({
          type: "overlay",
          t: now,
          quad: runtime.current,
          opacity: runtime.opacity,
          hasQuad: tracking,
          searching: isSearching,
          locked: runtime.locked,
          ready: announcedReady,
          countdown: runtime.countdown,
          watch: runtime.watchScore,
          why: runtime.blockWhy,
          corners: tracking ? provenanceDiagnostic(runtime.check) : null,
          separate: tracking ? (runtime.check?.separate ?? null) : null,
        });
      }

      if (fire) {
        // What the page's corners were said to be at the fire: never an
        // uncertain page (owner rule) — the bench checks it held.
        if (probing()) {
          probe({
            type: "auto-fire",
            t: now,
            corners: provenanceDiagnostic(runtime.check),
            separate: runtime.check?.separate ?? null,
            timeline: runtime.lastFire?.marks ?? null,
            intervalMs: runtime.intervalMs,
          });
        }
        // The same capture as a tap: the capture screen's path, which pauses
        // this loop and opens the confirm screen.
        onAutoCaptureRef.current?.();
      }
      frameHandle = window.requestAnimationFrame(frame);
    }

    runtime.lastFrameAt = 0;
    runtime.loopStartedAt = performance.now();
    frameHandle = window.requestAnimationFrame(frame);
    // Decide the lane first (the mount already started deciding it), and pay
    // the WASM load BEFORE the first measured pass: a slow module fetch is not
    // a slow device, and letting it into the average would switch the feature
    // off on a perfectly capable phone with a bad connection. On the worker
    // lane the worker loads its own, and says when it has.
    void (async () => {
      let lane = await startDetectLane(assetsRef.current);
      if (cancelled) return;
      if (lane === "worker") {
        await detectLaneReady();
        if (cancelled) return;
        lane = detectLane() ?? "main";
      }
      runtime.laneGeneration = detectLaneGeneration();
      switchDetector(
        runtime,
        primaryDetector({ ready: isMlDetectionReady(), disabled: isMlDetectionDisabled() }),
        lane,
      );
      // The focus/light reading rides on the loop's own frames, on either lane.
      hintRef.current = { at: Number.NEGATIVE_INFINITY };
      if (lane === "main") await loadScanic(assetsRef.current);
      scheduleDetect(0);
    })().catch(() => setAvailable(false));

    return () => {
      cancelled = true;
      runtime.live = false;
      if (detectTimer !== null) window.clearTimeout(detectTimer);
      if (frameHandle !== null) window.cancelAnimationFrame(frameHandle);
    };
  }, [loopLive, overlay, videoRef]);

  const diagnostics = React.useCallback((): LiveDiagnostics => {
    const runtime = runtimeRef.current;
    const times = passTimesRef.current;
    const sorted = [...times].sort((a, b) => a - b);
    return {
      lane: detectLane(),
      detector: runtime.passSource,
      detectMs: times.length === 0 ? null : times[times.length - 1],
      detectP50: sorted.length === 0 ? null : sorted[Math.floor(sorted.length / 2)],
      intervalMs: runtime.intervalMs,
      frameAgeMs: frameAgeRef.current,
      stream: videoSizeRef.current,
      visible: visibleRef.current,
      fit: fitRef.current,
      locked: runtime.locked,
      ready: guidanceRef.current.ready.onSince !== null,
      autoArmed: guidanceRef.current.auto.armed,
      blocked: runtime.blockWhy,
      passes: passCountRef.current,
      fill: runtime.fill,
      answer: runtime.answer,
      check: runtime.target === null ? null : runtime.check,
    };
  }, []);

  return {
    available,
    hasQuad,
    searching,
    frameBox,
    overlay,
    takeQuadForCapture,
    noteCapture,
    endCapture,
    hint,
    hintFill,
    hintDirection,
    ready,
    readyTick,
    visible,
    videoBox,
    diagnostics,
  };
}
