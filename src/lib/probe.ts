/**
 * A seam the development bench watches the scanner through — and nothing more.
 *
 * The detection bench (`scripts/bench/`, never shipped) runs the real
 * `<ScanFlow>` in a browser against a synthetic camera and has to score what
 * the person holding the phone would have seen: which quad the viewfinder drew
 * and when, which corners a capture carried, how long the confirm screen took to
 * open. None of that is observable from outside the component without reading
 * its internals, so the component reports it here, at the points where it
 * already knows it.
 *
 * **Compiled out of the published library.** Forwarding happens only in a
 * build that defines the constant `globalThis.__SCAN_PROBE_BUILD__` as `true`
 * — the bench's own bundle (`scripts/bench/build-app.mjs`). The library build
 * (`scripts/build.mjs`) defines it `false`: {@link probing} is then a function
 * that answers `false` without reading anything, {@link probe} does nothing,
 * and the module that knows where a listener lives (`lib/probe-hook.ts`) is not
 * in the bundle at all, so no script on a host page can install a listener and
 * receive, stall or tamper with anything. `scripts/check-dist.mjs` checks the
 * published files for it. Unbundled (the unit tests) the constant is simply
 * absent, which reads as off.
 *
 * In the bench build: nothing is buffered, nothing is sent anywhere and
 * nothing is written down. An event is a plain object of numbers, enums and
 * normalized corners, handed synchronously to the listener as a **copy**
 * (`structuredClone`), so a listener that keeps or mutates it cannot reach a
 * quad the scanner is still using. Pixels never travel through here.
 *
 * Call sites check {@link probing} before they build an event: in the
 * published build that is a call answering `false`; in the bench build, a
 * page without a listener pays one property read per call site and allocates
 * nothing. A listener that throws is the listener's problem: {@link probe}
 * swallows it, because an instrument must never be able to break the thing it
 * is measuring.
 *
 * Not exported from the package entry. It is an internal seam, not an API.
 */

import type { DetectionSource } from "@/lib/flatten";
import type { NormalizedQuad } from "@/lib/quad";
import type { SideReport } from "@/lib/refine";
import type { LaneReason } from "@/lib/detect-protocol";
import type { PaperEvidence } from "@/lib/paper-evidence";
import type { FrameReading } from "@/lib/hints";
import { probeListener, probeListenerSetting } from "@/lib/probe-hook";

/**
 * The build-time switch. esbuild's `define` replaces the member expression
 * with a literal, and a literal `false` makes every branch it guards dead —
 * which is what keeps `probe-hook.ts` out of the published bundle. Read
 * inline at each use, never through a variable: a variable would not fold.
 *
 * The guarded branches are also labelled `BENCH_PROBE`, and the library build
 * drops statements with that label (`dropLabels`), so the dead branches leave
 * no text behind either — a readable, unminified bundle would otherwise keep
 * an `if (false)` calling a function it no longer contains.
 */
interface ProbeBuild {
  __SCAN_PROBE_BUILD__?: boolean;
}

/**
 * One pass of the live loop, answered or not.
 *
 * Corners are fractions of the **sampled frame** — the whole sensor frame the
 * loop draws at ~640 px, not the object-cover crop the user sees.
 */
export interface DetectProbe {
  type: "detect";
  /** `performance.now()` when the answer was handled. */
  t: number;
  /** When the frame it describes was sampled — the clock everything else reads. */
  frameAt: number;
  source: DetectionSource;
  /** The detached ML warm-up pass rather than a regular pass of the chain. */
  warmUp: boolean;
  /** The detector answered with a quad at all. */
  ok: boolean;
  quad: NormalizedQuad | null;
  confidence: number | null;
  coverage: number | null;
  /** The conditioned coverage floor this answer was held to. */
  floor: number | null;
  /** Cleared the floor and superseded whatever was being tracked. */
  accepted: boolean;
  passMs: number;
  /** The cadence the loop is on after this pass. */
  intervalMs: number;
  sampleW: number;
  sampleH: number;
  /** Frame-to-frame motion score, `null` when unmeasured. */
  motion: number | null;
  /** The pass blew its budget: its answer was abandoned. */
  timedOut: boolean;
  /** A miss on a moved scene ended the hold on the tracked quad. */
  holdBroken: boolean;
  /** Where the pass ran. */
  lane?: "worker" | "main";
  /** What the pass cost the main thread (the whole pass on the main lane; the grab and hand-over on the worker's). */
  mainMs?: number | null;
  /** The worker's own time on the pass (worker lane). */
  computeMs?: number | null;
  /** Time the frame waited in the worker's queue. */
  queueMs?: number | null;
  /** The answer refined onto the paper's edges on this frame (what is drawn), `null` when that did not move it. */
  refinedQuad?: NormalizedQuad | null;
  refineMs?: number | null;
  /** The paper evidence for the drawn quad, when it was read. */
  evidence?: PaperEvidence | null;
  /** After this pass the tracked quad counts as a found sheet. */
  locked?: boolean;
  /** Why an answer that cleared the floor was not taken (a classical quad that failed its sanity checks, say). */
  rejected?: string | null;
  /** The evidence read where the found sheet was held, when this pass looked there. */
  heldEvidence?: PaperEvidence | null;
  /** The frame's focus and light, when this pass read them (`lib/hints.ts`). */
  reading?: FrameReading | null;
}

/** What the viewfinder is drawing, sampled at most every ~100 ms. */
export interface OverlayProbe {
  type: "overlay";
  t: number;
  /** The eased quad on screen, fractions of the sampled frame. */
  quad: NormalizedQuad | null;
  opacity: number;
  hasQuad: boolean;
  searching: boolean;
  /** The drawn quad is a found sheet (evidence behind it), not a candidate. */
  locked?: boolean;
  /** The ready cue is on the brackets (`lib/guidance.ts`). */
  ready?: boolean;
  /** Auto-capture's countdown (0–1) while it runs, else null. */
  countdown?: number | null;
  /** The last watch of the camera while the cue was on: its motion score against the confirmed frame (`hooks/useLiveDetect.ts`). */
  watch?: number | null;
  /** A photo is being taken: the overlay is frozen on the quad of the tap. */
  capturing?: boolean;
}

/** A chip or notice over the viewfinder appearing (`shown`) or going away. */
export interface HintProbe {
  type: "hint";
  t: number;
  key: string;
  shown: boolean;
}

/** Where corners came from at capture, in `resolveCaptureCorners`' priority. */
export type CornersFrom = "live" | "detected" | "fallback" | null;

/** One shutter or frame tap, from the tap to the corners it resolved. */
export interface CaptureProbe {
  type: "capture";
  /** The tap. */
  t: number;
  /** When the corners were resolved, just before the canonical is encoded. */
  doneAt: number;
  /** `auto`: auto-capture fired it (`lib/guidance.ts`), through the same path as a tap. */
  trigger: "shutter" | "frame" | "auto";
  /** The still photo became the page (it arrived and matched the preview's shape). */
  stillUsed: boolean;
  /** The still that arrived, whether or not it was used. */
  stillW: number | null;
  stillH: number | null;
  previewW: number;
  previewH: number;
  /**
   * The part of the preview the user could see (`lib/visible-region.ts`: the
   * fit, the viewport and the layout's opaque bands) — as fractions of the
   * preview frame. `null` when it could not be measured.
   */
  visible: { x: number; y: number; width: number; height: number } | null;
  /** The photo's check before the confirm screen (`lib/still-check.ts`): why it is flagged, or null. */
  attention?: "no-page" | "corner-outside" | "moved" | "unverified" | null;
  /**
   * The photo registered against the viewfinder's picture at the tap
   * (`lib/still-register.ts`) — only when the still pipeline's photo became
   * the page and both pictures had structure to register.
   */
  register?: { fovScale: number; shiftX: number; shiftY: number; score: number; overlap: number; ms: number } | null;
  /** The canvas that became the page. */
  frameW: number;
  frameH: number;
  cornersFrom: CornersFrom;
  /** Fractions of the page's frame. */
  corners: NormalizedQuad | null;
  /** Who produced the corners that travelled — the live loop's or the capture's own detector. */
  detector: DetectionSource | null;
  confidence: number | null;
  coverage: number | null;
  /** Age of the buffered live quad at the tap, `null` when there was none. */
  bufferAgeMs: number | null;
  /** How long the capture waited for an in-flight ML pass, `null` when it did not detect. */
  mlWaitMs: number | null;
  /**
   * The still attempt this capture made ({@link StillCallProbe}), whether or
   * not its photo became the page — `null` when no attempt reached the camera.
   */
  stillAttempt: number | null;
  /** The preview grab that became the page ({@link GrabProbe}), `null` when the still did. */
  grab: number | null;
  /** When that preview frame was drawn off the `<video>`. */
  grabbedAt: number | null;
  /**
   * When the corners came from the classical fall-through, what the other
   * capture policy (no fall-through) would have opened the confirm screen
   * with: the buffered live quad (refined) where one could travel, else none.
   * Absent when the policies agree.
   */
  alternative?: { corners: NormalizedQuad | null; cornersFrom: CornersFrom } | null;
}

/**
 * The capture is about to ask the camera for a still — emitted synchronously,
 * immediately before `takePhoto()`, so whatever answers the call can tell
 * which attempt it is answering. Numbered per page load.
 */
export interface StillCallProbe {
  type: "still-call";
  t: number;
  attempt: number;
}

/**
 * A preview frame was just drawn off the `<video>` to become a page —
 * emitted synchronously right after the draw, so a listener that knows which
 * frame the element is showing can name it. Numbered per page load.
 */
export interface GrabProbe {
  type: "grab";
  t: number;
  id: number;
}

/**
 * A one-shot detect on a frame the caller holds — the capture's, or a
 * confirm/adjust screen's fresh look at a canonical — before the floor decides
 * whether it counts.
 */
export interface CaptureDetectProbe {
  type: "capture-detect";
  /**
   * What was looked at: a live `frame` at capture time, or a stored
   * `canonical` (the confirm screen, the corner editors, the gallery intake).
   */
  on: "frame" | "canonical";
  t: number;
  ms: number;
  source: DetectionSource | null;
  quad: NormalizedQuad | null;
  confidence: number | null;
  coverage: number | null;
  floor: number | null;
  accepted: boolean;
  width: number;
  height: number;
  /** Where it ran. */
  lane?: "worker" | "main";
  /** Time it waited in the worker's queue (behind a live pass already running). */
  queueMs?: number | null;
  /** The model answered nothing and the classical detector was asked. */
  fellThrough?: boolean;
  /** Why the model was not asked: `busy` = a live pass held it (a downgrade), else `null`. */
  mlSkipped?: "busy" | "not-ready" | "disabled" | null;
}

/** The session's detection lane was decided (or changed). */
export interface LaneProbe {
  type: "lane";
  t: number;
  lane: "worker" | "main";
  reason: LaneReason;
}

/** The model's runtime came up (`ok`) or was latched off. */
export interface MlReadyProbe {
  type: "ml-ready";
  t: number;
  ok: boolean;
}

/**
 * Capture-time edge refinement (`lib/refine.ts`) run on corners about to seed
 * a confirm screen: what went in, what came out, and why, side by side.
 */
export interface RefineProbe {
  type: "refine";
  t: number;
  /**
   * Whose corners were refined: the capture's own detect (`detected`), the
   * live loop's quad on the preview frame (`live`) or carried to the still
   * (`fallback`), or a fresh detect on a stored canonical (`canonical`).
   */
  from: "detected" | "live" | "fallback" | "canonical";
  detector: DetectionSource | null;
  /** `local` for the classical detector's quads: never searched wide. */
  mode: "full" | "local";
  input: NormalizedQuad;
  output: NormalizedQuad;
  changed: boolean;
  reason: string;
  /** TL→TR, TR→BR, BR→BL, BL→TL. */
  sides: SideReport[];
  ms: number;
  /** The image the corners are fractions of. */
  width: number;
  height: number;
}

/** One still-photo attempt, however it ended. */
export interface StillProbe {
  type: "still";
  t: number;
  ms: number;
  ok: boolean;
  width: number | null;
  height: number | null;
  /** The session's failure count after this attempt. */
  failures: number;
  /** The {@link StillCallProbe} this attempt made, `null` when it never reached the camera. */
  attempt: number | null;
}

/** The confirm screen opened, fractions of the captured image. */
export interface ConfirmOpenProbe {
  type: "confirm-open";
  t: number;
  /** The corners it was seeded with — `null` when neither the capture nor a fresh detect had any. */
  corners: NormalizedQuad | null;
  /** What the editor drew: the seed, or its own inset default when there was none. */
  shownCorners: NormalizedQuad | null;
  /** Carried by the capture, found by a fresh detect on the canonical, or neither. */
  seededFrom: "capture" | "detected" | "editor-default";
  width: number;
  height: number;
  /** The flag the screen opened with (`Capture.attention`), or null. */
  attention?: "no-page" | "corner-outside" | "moved" | "unverified" | null;
}

/** The user left the confirm screen with these corners. */
export interface ConfirmDoneProbe {
  type: "confirm-done";
  t: number;
  corners: NormalizedQuad | null;
  /**
   * The corners differ from the ones the editor showed at open; `null` when
   * that is unknown (nobody was listening when the screen opened).
   */
  edited: boolean | null;
  /** "Usar a foto inteira" rather than the editor's answer. */
  wholePhoto: boolean;
}

export type ProbeEvent =
  | DetectProbe
  | OverlayProbe
  | HintProbe
  | CaptureProbe
  | StillCallProbe
  | GrabProbe
  | CaptureDetectProbe
  | RefineProbe
  | StillProbe
  | ConfirmOpenProbe
  | ConfirmDoneProbe
  | LaneProbe
  | MlReadyProbe;

/** Whether anyone is listening — checked before an event is built. */
export function probing(): boolean {
  BENCH_PROBE: if ((globalThis as ProbeBuild).__SCAN_PROBE_BUILD__ === true) {
    return probeListener() !== null;
  }
  return false;
}

/**
 * A bench-only setting the page gave its listener, or `undefined` — always
 * `undefined` in the published build, where there is no listener to ask.
 */
export function probeSetting(name: string): unknown {
  BENCH_PROBE: if ((globalThis as ProbeBuild).__SCAN_PROBE_BUILD__ === true) {
    return probeListenerSetting(name);
  }
  return undefined;
}

/**
 * Hand one event to the listener, if there is one — as a copy of it, so the
 * listener owns what it received and nothing it does to it reaches the
 * scanner. Never throws.
 */
export function probe(event: ProbeEvent): void {
  BENCH_PROBE: if ((globalThis as ProbeBuild).__SCAN_PROBE_BUILD__ === true) {
    const hook = probeListener();
    if (hook === null) return;
    try {
      hook(structuredClone(event));
    } catch {
      // The instrument is not allowed to break the scanner.
    }
  }
}

/**
 * Below this, two normalized quads are the same answer — the editor round-trips
 * corners through its own pixel grid, which is not the user moving a handle.
 */
const QUAD_EDIT_TOLERANCE = 1e-3;

/** Whether the user moved any corner between two answers. */
export function quadMoved(
  from: NormalizedQuad | null,
  to: NormalizedQuad | null,
): boolean {
  if (from === null || to === null) return from !== to;
  for (const key of ["topLeft", "topRight", "bottomRight", "bottomLeft"] as const) {
    if (
      Math.abs(from[key].x - to[key].x) > QUAD_EDIT_TOLERANCE ||
      Math.abs(from[key].y - to[key].y) > QUAD_EDIT_TOLERANCE
    ) {
      return true;
    }
  }
  return false;
}
