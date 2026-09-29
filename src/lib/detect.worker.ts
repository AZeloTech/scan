/**
 * The detection worker: scanic, off the main thread.
 *
 * scanic's detect mode runs on `OffscreenCanvas` when a worker has one, and its
 * ML detector reaches the self-hosted ONNX Runtime through the same
 * `assetBaseUrl` options the main thread uses — so the worker imports the very
 * scanic build the library ships in `assets/scanic/` (never bundled into this
 * file) and calls it exactly as `lib/flatten.ts` does. Everything that decides
 * what a detection *means* — the coverage floor, arbitration, refinement, the
 * confirm screen — stays on the main thread; this answers "where are the
 * corners in this frame" and nothing else.
 *
 * Frames arrive as transferred `ImageBitmap`s (the live loop's ~640 px sample,
 * or a capture's full frame), are drawn into one reused `OffscreenCanvas` and
 * closed at once — a held camera frame can stall the camera. The queue
 * (`DetectQueue`, `lib/detect-protocol.ts`) keeps at most one live frame and
 * puts captures first; one job runs at a time, and the worker yields to its
 * event loop before taking the next so a capture posted mid-pass is seen
 * before the next live frame.
 *
 * Loaded by `lib/detect-lane.ts` as a module worker named
 * `azelo-scan-detect` — never `ort-wasm-proxy-worker` or `em-pthread*`, which
 * the ONNX Runtime and emscripten claim for their own threads.
 */

import {
  DetectQueue,
  type DetectMessage,
  type InitMessage,
  type MainToWorker,
  type ResultReply,
  type WorkerMlOptions,
  type WorkerToMain,
} from "@/lib/detect-protocol";
import { paperEvidence } from "@/lib/paper-evidence";
import { refineQuad } from "@/lib/refine";
import { denormalizeQuad, normalizeQuad } from "@/lib/quad";
import { HINT_SAMPLE_WIDTH, readFrame, type FrameReading } from "@/lib/hints";

/** See `render.worker.ts`: the two members of the worker scope this file uses. */
interface DetectWorkerScope {
  onmessage: ((event: MessageEvent<MainToWorker>) => void) | null;
  postMessage(message: WorkerToMain, transfer?: Transferable[]): void;
}

declare const self: DetectWorkerScope;

/** The bench's build switch (`scripts/probe-switch.mjs`); `false` in the library's worker. */
interface ProbeBuild {
  __SCAN_PROBE_BUILD__?: boolean;
}

type ScanicModule = typeof import("scanic");

/** The motion probe's thumbnail edge — `MOTION_PROBE_SIZE`, `lib/frame-motion.ts`. */
const PROBE_SIDE = 24;

/** The ML warm-up's frame: blank, 64×64 — "does the runtime work here", nothing more. */
const WARM_SIDE = 64;

/** The classical detector's `minDocumentCoverageRatio`, as the main thread passes it (`init`). */
let classicalFloor = 0.35;

let scanic: Promise<ScanicModule> | null = null;
let ml: WorkerMlOptions | null = null;
let slowdown = 1;

interface Job extends DetectMessage {
  receivedAt: number;
}

const queue = new DetectQueue<Job>();
let pumping = false;

let work: OffscreenCanvas | null = null;
let workContext: OffscreenCanvasRenderingContext2D | null = null;
let probeCanvas: OffscreenCanvas | null = null;
let probeContext: OffscreenCanvasRenderingContext2D | null = null;
let hintCanvas: OffscreenCanvas | null = null;
let hintContext: OffscreenCanvasRenderingContext2D | null = null;

function offscreen2d(): boolean {
  try {
    return typeof OffscreenCanvas === "function" && new OffscreenCanvas(1, 1).getContext("2d") !== null;
  } catch {
    return false;
  }
}

/**
 * Whether this worker may compile WebAssembly: the smallest valid module (the
 * magic number and version, nothing else), compiled synchronously. A CSP on
 * the worker's own response without `'wasm-unsafe-eval'` refuses it — and
 * then scanic's classical detector and the model's runtime both fail here,
 * while the page, under its own CSP, may run them fine.
 */
function wasmAllowed(): boolean {
  try {
    return new WebAssembly.Module(Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00)) instanceof WebAssembly.Module;
  } catch {
    return false;
  }
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** The reused surface a frame is drawn onto, at the sample's size. */
function surface(width: number, height: number): { canvas: OffscreenCanvas; context: OffscreenCanvasRenderingContext2D } {
  if (work === null || workContext === null) {
    work = new OffscreenCanvas(width, height);
    workContext = work.getContext("2d", { willReadFrequently: true });
    if (workContext === null) throw new Error("no 2-D context in the detection worker");
  }
  if (work.width !== width) work.width = width;
  if (work.height !== height) work.height = height;
  return { canvas: work, context: workContext };
}

/** The motion probe's luma: the frame drawn to 24×24, Rec. 601 — as `probeLuma` does on the main thread. */
function lumaOf(canvas: OffscreenCanvas): Uint8ClampedArray | null {
  if (probeCanvas === null) {
    probeCanvas = new OffscreenCanvas(PROBE_SIDE, PROBE_SIDE);
    probeContext = probeCanvas.getContext("2d", { willReadFrequently: true });
  }
  if (probeContext === null) return null;
  probeContext.drawImage(canvas, 0, 0, PROBE_SIDE, PROBE_SIDE);
  const rgba = probeContext.getImageData(0, 0, PROBE_SIDE, PROBE_SIDE).data;
  const luma = new Uint8ClampedArray(PROBE_SIDE * PROBE_SIDE);
  for (let index = 0; index < luma.length; index += 1) {
    const at = index * 4;
    luma[index] = 0.299 * rgba[at] + 0.587 * rgba[at + 1] + 0.114 * rgba[at + 2];
  }
  return luma;
}

/** The hint chip's reading of this frame, on the same 320 px sample the main thread's timer used. */
function hintOf(canvas: OffscreenCanvas): FrameReading | null {
  const width = HINT_SAMPLE_WIDTH;
  const height = Math.max(1, Math.round((HINT_SAMPLE_WIDTH * canvas.height) / canvas.width));
  if (hintCanvas === null) {
    hintCanvas = new OffscreenCanvas(width, height);
    hintContext = hintCanvas.getContext("2d", { willReadFrequently: true });
  }
  if (hintContext === null) return null;
  if (hintCanvas.width !== width) hintCanvas.width = width;
  if (hintCanvas.height !== height) hintCanvas.height = height;
  hintContext.drawImage(canvas, 0, 0, width, height);
  return readFrame(hintContext.getImageData(0, 0, width, height));
}

async function init(message: InitMessage): Promise<void> {
  ml = message.ml;
  classicalFloor = message.classicalFloor;
  BENCH_PROBE: if ((globalThis as ProbeBuild).__SCAN_PROBE_BUILD__ === true) {
    slowdown = message.slowdown !== undefined && message.slowdown > 1 ? message.slowdown : 1;
  }
  // The specifier is a variable: this module is fetched at run time from the
  // host's asset directory, never followed by a bundler (`scanic-runtime.ts`).
  scanic = import(/* webpackIgnore: true */ /* @vite-ignore */ message.scanic) as Promise<ScanicModule>;
  let module: ScanicModule;
  try {
    module = await scanic;
  } catch (error) {
    self.postMessage({ type: "init-failed", reason: describe(error) });
    return;
  }
  self.postMessage({ type: "ready" });
  const started = performance.now();
  try {
    const blank = new ImageData(new Uint8ClampedArray(WARM_SIDE * WARM_SIDE * 4).fill(255), WARM_SIDE, WARM_SIDE);
    await module.scanDocument(blank, { mode: "detect", detector: "ml", ml });
    stretch(started);
    self.postMessage({ type: "ml", ok: true, warmMs: performance.now() - started });
  } catch (error) {
    self.postMessage({ type: "ml", ok: false, warmMs: performance.now() - started, reason: describe(error) });
  }
}

/**
 * Bench only: hold the thread until the work since `started` has taken
 * `slowdown` times what it took — a slow phone's core, as an upper bound
 * (the download inside a warm-up is stretched too). A no-op in the library's
 * build, where the branch does not exist.
 */
function stretch(started: number): void {
  BENCH_PROBE: if ((globalThis as ProbeBuild).__SCAN_PROBE_BUILD__ === true) {
    if (slowdown > 1) {
      const until = started + (performance.now() - started) * slowdown;
      while (performance.now() < until) {
        // spin
      }
    }
  }
}

interface Detected {
  detector: "ml" | "classical" | null;
  success: boolean;
  corners: ResultReply["corners"];
  confidence: number | null;
  fellThrough: boolean;
  mlFailed: boolean;
}

async function detect(module: ScanicModule, canvas: OffscreenCanvas, job: Job): Promise<Detected> {
  // scanic reads an OffscreenCanvas in a worker as it reads a canvas on the page.
  const image = canvas as unknown as HTMLCanvasElement;
  let mlFailed = false;
  if (job.plan !== "classical" && ml !== null) {
    try {
      const result = await module.scanDocument(image, { mode: "detect", detector: "ml", ml });
      if (result.success && result.corners !== null && result.corners !== undefined) {
        return { detector: "ml", success: true, corners: result.corners, confidence: result.confidence ?? null, fellThrough: false, mlFailed: false };
      }
      if (job.plan === "ml") return { detector: "ml", success: false, corners: null, confidence: result.confidence ?? null, fellThrough: false, mlFailed: false };
    } catch {
      // The runtime failed (it will be latched off): the classical detector
      // answers instead, whatever the plan — it is the only detector left.
      mlFailed = true;
    }
  }
  const result = await module.scanDocument(image, { mode: "detect", minDocumentCoverageRatio: classicalFloor });
  return {
    detector: "classical",
    success: result.success === true && result.corners !== null && result.corners !== undefined,
    corners: result.success === true ? (result.corners ?? null) : null,
    confidence: result.confidence ?? null,
    fellThrough: job.plan === "ml-then-classical" && !mlFailed,
    mlFailed,
  };
}

async function run(job: Job): Promise<void> {
  const started = performance.now();
  let drawn: OffscreenCanvas | null = null;
  try {
    const { canvas, context } = surface(job.width, job.height);
    // Drawn at the sample size whatever size arrived: a browser that ignored
    // `resizeWidth` still gets the frame the main-thread lane would read.
    context.drawImage(job.frame, 0, 0, job.width, job.height);
    drawn = canvas;
  } catch (error) {
    self.postMessage({ type: "error", id: job.id, message: describe(error) });
    return;
  } finally {
    job.frame.close();
  }
  try {
    const module = scanic === null ? null : await scanic;
    const luma = job.luma ? lumaOf(drawn) : null;
    const hint = job.hint ? hintOf(drawn) : null;
    const detectStarted = performance.now();
    const found: Detected =
      module === null
        ? { detector: null, success: false, corners: null, confidence: null, fellThrough: false, mlFailed: false }
        : await detect(module, drawn, job);
    // The detector's own time, stretched like the rest in the bench's build
    // (`slowdown` is 1 in the library's).
    const detectMs = (performance.now() - detectStarted) * slowdown;
    let evidence = null;
    let refined: ResultReply["refined"] = null;
    let refineMs: number | null = null;
    if ((job.evidence || job.refineMs > 0) && found.success && found.corners !== null && workContext !== null) {
      const pixels = workContext.getImageData(0, 0, job.width, job.height);
      let corners = found.corners;
      const quad = job.refineMs > 0 ? normalizeQuad(corners, job.width, job.height) : null;
      if (quad !== null) {
        // The model's quad onto the paper's edges, on this very frame — what
        // the overlay draws. The classical detector's is only snapped nearby.
        const result = refineQuad(pixels, quad, { mode: found.detector === "ml" ? "full" : "local", budgetMs: job.refineMs });
        refineMs = result.ms;
        if (result.changed) {
          corners = denormalizeQuad(result.quad, job.width, job.height);
          refined = corners;
        }
      }
      if (job.evidence) evidence = paperEvidence(pixels.data, job.width, job.height, corners);
    }
    // Nothing found — or a quad found somewhere else entirely: is the page
    // the overlay holds still there?
    let heldEvidence = null;
    if (job.evidence && job.held !== null && workContext !== null && (!found.success || found.corners === null || movedAway(found.corners, job.held, job.width, job.height))) {
      const pixels = workContext.getImageData(0, 0, job.width, job.height);
      heldEvidence = paperEvidence(pixels.data, job.width, job.height, job.held);
    }
    stretch(started);
    const computeMs = performance.now() - started;
    const reply: ResultReply = {
      type: "result",
      id: job.id,
      epoch: job.epoch,
      capturedAt: job.capturedAt,
      detector: found.detector,
      success: found.success,
      corners: found.corners,
      confidence: found.confidence,
      fellThrough: found.fellThrough,
      mlFailed: found.mlFailed,
      computeMs,
      detectMs,
      queueMs: started - job.receivedAt,
      luma,
      refined,
      refineMs,
      evidence,
      heldEvidence,
      hint,
    };
    self.postMessage(reply, luma === null ? [] : [luma.buffer]);
  } catch (error) {
    self.postMessage({ type: "error", id: job.id, message: describe(error) });
  } finally {
    // A capture's frame is full size — tens of megabytes of canvas — and the
    // confirm screen follows it: give the memory back now rather than at the
    // next live pass.
    if (job.priority === "capture" && work !== null) {
      work.width = 1;
      work.height = 1;
    }
  }
}

/**
 * Whether a found quad lies away from the held one — a corner farther than
 * {@link HELD_AWAY} of the frame's diagonal (the live loop's jump threshold,
 * `JUMP_RESET_DIAG`): the page the overlay holds may have gone.
 */
const HELD_AWAY = 0.08;
function movedAway(found: NonNullable<ResultReply["corners"]>, held: NonNullable<DetectMessage["held"]>, width: number, height: number): boolean {
  const diagonal = Math.hypot(width, height);
  for (const key of ["topLeft", "topRight", "bottomRight", "bottomLeft"] as const) {
    if (Math.hypot(found[key].x - held[key].x, found[key].y - held[key].y) > HELD_AWAY * diagonal) return true;
  }
  return false;
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      // Back to the event loop before every pick: a capture posted while the
      // last pass ran must be in the queue before the next job is chosen.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const job = queue.next();
      if (job === undefined) break;
      await run(job);
    }
  } finally {
    pumping = false;
  }
}

self.onmessage = (event: MessageEvent<MainToWorker>) => {
  const message = event.data;
  if (message.type === "init") {
    void init(message);
    return;
  }
  if (message.type === "cancel") {
    // The asker gave up on it: a queued job never runs (a capture's full
    // frame would otherwise hold the next live pass back for nothing).
    const cancelled = queue.cancel(message.id);
    if (cancelled !== null) cancelled.frame.close();
    return;
  }
  if (message.type === "detect") {
    const job: Job = { ...message, receivedAt: performance.now() };
    const displaced = queue.push(job);
    if (displaced !== null) {
      displaced.frame.close();
      self.postMessage({ type: "dropped", id: displaced.id });
    }
    void pump();
  }
};

self.postMessage({ type: "hello", offscreen2d: offscreen2d(), wasm: wasmAllowed() });
