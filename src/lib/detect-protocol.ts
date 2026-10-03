/**
 * The detection worker's protocol, and the decisions both ends of it make
 * without touching a browser API: which lane a session runs detection on, and
 * which job the worker takes next.
 *
 * Two lanes, chosen **once per page session**, with a reason the bench's
 * probe reports:
 *
 *  - **worker** — `lib/detect.worker.ts`, a module worker served from the
 *    host's asset directory like the render worker. scanic runs *inside* it
 *    (its ML detector through the same self-hosted ONNX Runtime files, its
 *    classical one on `OffscreenCanvas`); the main thread only grabs a frame
 *    (`createImageBitmap` of the `<video>`, resized to the live sample) and
 *    hands it over. A pass that used to block the main thread for its whole
 *    length (49–57 ms a pass on a mid-range phone) costs it a millisecond.
 *  - **main** — exactly the path that shipped before the worker existed, and
 *    a first-class one: no `Worker`, no `createImageBitmap`, no
 *    `OffscreenCanvas` with a 2-D context in a worker (Safari before 16.4), a
 *    worker script that would not load or did not answer, or a worker that
 *    died mid-session. Nothing about detection's *answers* differs between the
 *    two — the same scanic, the same options, the same frame.
 *
 * Pure: tested in `detect-protocol.test.ts`.
 */

import type { CornerPoints } from "scanic";
import type { CoveredCorner, PaperEvidence } from "@/lib/paper-evidence";
import type { FrameReading } from "@/lib/hints";
import type { CornerCheck } from "@/lib/corner-check";

/** Which detector a job asks for. */
export type DetectorKind = "ml" | "classical";

/**
 * What a job runs: one detector, or the model with the classical detector
 * after it when the model found nothing (the capture path's fall-through,
 * when the capture policy allows it — `lib/flatten.ts`).
 */
export type DetectPlan = DetectorKind | "ml-then-classical";

/**
 * A capture's detect never waits behind a *queued* live frame: it jumps the
 * queue. It does wait for a pass already running — a worker cannot be
 * interrupted mid-inference — which bounds the wait at one pass.
 */
export type DetectPriority = "live" | "capture";

/** The ML detector's options, exactly as `mlDetectorOptions` builds them. */
export interface WorkerMlOptions {
  assetBaseUrl: string;
  modelUrl: string;
  wasmPaths: string;
  numThreads: number;
  proxy: boolean;
  minScore: number;
  modelFetchTimeoutMs: number;
}

export interface InitMessage {
  type: "init";
  /** `AssetUrls.scanic`: imported inside the worker, never bundled into it. */
  scanic: string;
  ml: WorkerMlOptions;
  /** The classical detector's `minDocumentCoverageRatio` (`MIN_QUAD_AREA_FRACTION`). */
  classicalFloor: number;
  /**
   * Bench only, and honoured only by the bench's build of the worker: stretch
   * every pass to this many times its measured cost. CDP throttles a page's
   * own thread, never a worker's, and an unthrottled worker would make the
   * worker lane look better on a "slow phone" than it is.
   */
  slowdown?: number;
}

export interface DetectMessage {
  type: "detect";
  id: number;
  /** The asker's epoch: a reply for an epoch that moved on is dropped there. */
  epoch: number;
  priority: DetectPriority;
  plan: DetectPlan;
  /** Transferred; the worker closes it the moment it has drawn it. */
  frame: ImageBitmap;
  /** The sample size the frame is to be read at (a browser that ignored the resize is corrected). */
  width: number;
  height: number;
  /** Main thread's `performance.now()` at the grab — the worker's clock has another origin. */
  capturedAt: number;
  /** Also answer the motion probe's 24×24 luma of this frame. */
  luma: boolean;
  /**
   * Also refine the detected quad onto the paper's edges on this frame
   * (`refineQuad`, `lib/refine.ts`) — what the overlay draws — within this
   * budget (ms); 0: do not.
   */
  refineMs: number;
  /** Also answer the paper evidence for the (refined) quad. */
  evidence: boolean;
  /**
   * The quad the overlay is holding (pixels of this frame's size), to be
   * judged by the evidence on this frame when the detector finds nothing or
   * finds a quad somewhere else — a page that was slid away leaves no edges
   * where it was. `null`: none.
   */
  held: CornerPoints | null;
  /**
   * The held sheet's covered corners (`coveredCorners`): its reading on this
   * frame leaves the same region out as the reading that found it did.
   * Absent: none.
   */
  heldCovered?: CoveredCorner[];
  /**
   * Also answer the viewfinder's hint reading of this frame (`readFrame`,
   * `lib/hints.ts`: sharpness and light) — on the worker lane the live loop
   * carries the hint chip's sampling too, instead of a main-thread timer
   * reading the video a second time.
   */
  hint: boolean;
}

/**
 * The asker stopped waiting for this job (its budget ran out): drop it if it
 * has not started. A job already running finishes — a pass cannot be
 * interrupted — and its late answer lands on nobody.
 */
export interface CancelMessage {
  type: "cancel";
  id: number;
}

export type MainToWorker = InitMessage | DetectMessage | CancelMessage;

/** Sent as the module finishes evaluating — before any network request. */
export interface HelloReply {
  type: "hello";
  /** `OffscreenCanvas` with a 2-D context exists in this worker. */
  offscreen2d: boolean;
  /**
   * This worker may compile WebAssembly — the CSP on its own response allows
   * it (`'wasm-unsafe-eval'`). Without it neither detector can run here,
   * though the page itself may run both. Absent: an older worker; assumed.
   */
  wasm?: boolean;
}

/**
 * scanic has loaded in the worker: from here a job is measured as the
 * detector's work, not as the module's download.
 */
export interface ReadyReply {
  type: "ready";
}

/** scanic could not be loaded in the worker: neither detector can run there. */
export interface InitFailedReply {
  type: "init-failed";
  reason: string;
}

/** The ML warm-up settled: `ok` drives the main thread's ML latch. */
export interface MlReply {
  type: "ml";
  ok: boolean;
  warmMs: number;
  reason?: string;
}

export interface ResultReply {
  type: "result";
  id: number;
  epoch: number;
  capturedAt: number;
  /** Which detector's answer this is (`null`: none ran — scanic missing). */
  detector: DetectorKind | null;
  success: boolean;
  /** Pixels of the `width`×`height` frame. */
  corners: CornerPoints | null;
  confidence: number | null;
  /** The model answered nothing and the classical detector was asked. */
  fellThrough: boolean;
  /** The model's call threw: the runtime failed — latch it off. */
  mlFailed: boolean;
  /** The worker's own time on the job (with a bench slowdown, the slowed time). */
  computeMs: number;
  /**
   * The detector's share of it — without the frame draw, the refinement, the
   * paper evidence and the hint reading that ride on the job. What the live
   * loop's hopeless verdict reads.
   */
  detectMs: number;
  /** Time the job waited in the worker's queue. */
  queueMs: number;
  luma: Uint8ClampedArray | null;
  /** The quad refined onto the paper's edges (pixels), `null` when not asked, unchanged or given up. */
  refined: CornerPoints | null;
  /** What the refinement cost, ms, `null` when it did not run. */
  refineMs: number | null;
  /**
   * What the refinement said about the quad's corners (`lib/corner-check.ts`):
   * seen / inferred / unknown each, and whether another sheet overlaps it.
   * Absent or null when it did not run to its end.
   */
  check?: CornerCheck | null;
  /** The refined quad's covered corners (`coveredCorners`); absent or null when the refinement did not run to its end. */
  covered?: CoveredCorner[] | null;
  evidence: PaperEvidence | null;
  /** The evidence for `held` on this frame, when the detector found nothing or found a quad away from it. */
  heldEvidence: PaperEvidence | null;
  hint: FrameReading | null;
}

/** A live frame superseded by a newer one before it ran. */
export interface DroppedReply {
  type: "dropped";
  id: number;
}

export interface ErrorReply {
  type: "error";
  id: number;
  message: string;
}

export type WorkerToMain = HelloReply | ReadyReply | InitFailedReply | MlReply | ResultReply | DroppedReply | ErrorReply;

/**
 * A job that got no answer, and why: `timeout` — the budget ran out first
 * (the worker is busy or stuck); `dropped` — a newer live frame replaced it;
 * `error` — the worker could not draw or read the frame; `gone` — there is no
 * worker (the lane moved, or the hand-over itself failed).
 */
export interface LaneMiss {
  type: "miss";
  why: "timeout" | "dropped" | "error" | "gone";
}

/**
 * Why a session is on the lane it is on. `worker` is the only reason for the
 * worker lane; everything else names what kept it from there.
 */
export type LaneReason =
  | "worker"
  | "forced"
  | "no-worker"
  | "no-create-image-bitmap"
  | "worker-load-error"
  | "worker-timeout"
  | "no-offscreen-canvas"
  | "no-wasm-in-worker"
  | "worker-init-failed"
  | "worker-crashed"
  | "worker-ml-failed"
  | "worker-stalled"
  | "frame-grab-failed";

export type DetectLaneKind = "worker" | "main";

/** What the page offers, as far as the main thread can tell before trying. */
export interface LaneFeatures {
  worker: boolean;
  createImageBitmap: boolean;
}

/** The reason not to try the worker at all, or null to try it. */
export function laneBlocker(features: LaneFeatures): LaneReason | null {
  if (!features.worker) return "no-worker";
  if (!features.createImageBitmap) return "no-create-image-bitmap";
  return null;
}

/**
 * The worker's queue: at most **one** live frame (a newer one replaces it —
 * the replaced one is answered `dropped` and its bitmap closed), and captures
 * first, in order. One job at a time runs; the worker yields to its event loop
 * before taking the next, so a capture posted during a pass is seen before the
 * next live frame (WebKit otherwise delivers messages only between passes).
 */
export class DetectQueue<T extends { id: number; priority: DetectPriority }> {
  private live: T | null = null;
  private readonly captures: T[] = [];

  /** Queue a job; answers the live job it displaced, if any. */
  push(job: T): T | null {
    if (job.priority === "capture") {
      this.captures.push(job);
      return null;
    }
    const displaced = this.live;
    this.live = job;
    return displaced;
  }

  /** The next job to run: a capture if any is waiting, else the live frame. */
  next(): T | undefined {
    const capture = this.captures.shift();
    if (capture !== undefined) return capture;
    const live = this.live;
    this.live = null;
    return live ?? undefined;
  }

  /** Take a job that has not started out of the queue; answers it, or null when it is not waiting. */
  cancel(id: number): T | null {
    if (this.live !== null && this.live.id === id) {
      const live = this.live;
      this.live = null;
      return live;
    }
    const at = this.captures.findIndex((job) => job.id === id);
    return at < 0 ? null : (this.captures.splice(at, 1)[0] ?? null);
  }

  get size(): number {
    return this.captures.length + (this.live === null ? 0 : 1);
  }
}

/** The one name the worker must never have: ORT and emscripten claim these for their own threads. */
export function safeWorkerName(name: string): boolean {
  return name !== "ort-wasm-proxy-worker" && !name.startsWith("em-pthread");
}

export const DETECT_WORKER_NAME = "azelo-scan-detect";
