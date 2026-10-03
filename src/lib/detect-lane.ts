"use client";

/**
 * Where detection runs this session: the main thread's end of the detection
 * worker (`lib/detect.worker.ts`), and the choice between it and the main
 * thread (`lib/detect-protocol.ts` has the rules).
 *
 * **One worker per page, started early, kept while it is used.**
 * {@link holdDetectLane} is called as soon as the scanner's capture screen
 * mounts — before the permission primer has been answered — so the model's
 * download and the WebAssembly compile happen in the worker while the person
 * is still reading the primer, and cost the main thread nothing. A remount
 * within {@link IDLE_RELEASE_MS} of the last unmount reuses the same worker and
 * its warm runtime; after that, with no scanner on the page, the worker (and
 * the ~30 MB its runtime holds) is terminated and the next mount decides
 * afresh. A mount with other asset URLs than the lane was started with, while
 * nothing else holds it, starts over too.
 *
 * **Decided once, with a reason.** No `Worker` or `createImageBitmap`, a
 * worker script that errors or does not say hello in {@link HELLO_TIMEOUT_MS}
 * (measured to its first message, which comes before any download — a slow
 * network is not a missing worker), no 2-D `OffscreenCanvas` in the worker, or
 * scanic not loading there: the session runs on the main thread, exactly as
 * before the worker existed. A worker that dies later hands the session to
 * the main thread for good (`worker-crashed`), and so does one that cannot
 * compile WebAssembly (`no-wasm-in-worker`), whose model fails
 * (`worker-ml-failed`), that stops answering (`worker-stalled`) or whose
 * frames cannot be grabbed (`frame-grab-failed`) — the live loop reports the
 * last two ({@link demoteDetectLane}). Every job it held answers a miss, which
 * every caller already treats as "no detection".
 *
 * **The model is the worker's.** Its warm-up proving the runtime drives the
 * same latch the main-thread path uses (`markMlReady`, `lib/ml-detection.ts`),
 * and while the worker lane is on nothing runs the model on the main thread —
 * each realm would hold its own 3.4 MB ONNX session. A model that fails *in
 * the worker* is not latched off for the page: the session moves to the main
 * thread, which warms its own and latches only if that fails too.
 */

import {
  DETECT_WORKER_NAME,
  laneBlocker,
  type DetectLaneKind,
  type DetectMessage,
  type DetectPlan,
  type DetectPriority,
  type LaneMiss,
  type LaneReason,
  type ResultReply,
  type WorkerToMain,
} from "@/lib/detect-protocol";
import { forgetMlReady, markMlReady, ML_WEAK_CONFIDENCE } from "@/lib/ml-detection";
import { mlDetectorOptions, type AssetUrls } from "@/lib/runtime-config";
import { probe, probeSetting, probing } from "@/lib/probe";
import type { CornerPoints } from "scanic";
import type { CoveredCorner } from "@/lib/paper-evidence";

/**
 * How long a new worker has to say hello. Its first message is sent as its
 * module finishes evaluating, before any network request of its own, so this
 * bounds a worker script that will not load or run — not the model download.
 */
export const HELLO_TIMEOUT_MS = 5000;

/**
 * How long the worker outlives the last scanner on the page. A person going
 * to the page list and back — or a host remounting `<ScanFlow>` — gets the
 * warm worker; a page that has moved on gets its memory back.
 */
export const IDLE_RELEASE_MS = 60_000;

/** The live-sample MIN_QUAD_AREA_FRACTION, passed to the worker's classical detector. */
const CLASSICAL_FLOOR = 0.35;

interface Pending {
  resolve(reply: ResultReply | LaneMiss): void;
}

type State = "idle" | "starting" | DetectLaneKind;

let state: State = "idle";
let reason: LaneReason | null = null;
let decision: Promise<DetectLaneKind> | null = null;
let worker: Worker | null = null;
/** scanic has loaded in the worker (its `ready`). */
let workerReady = false;
let readyWaiters: (() => void)[] = [];
let nextId = 1;
const pending = new Map<number, Pending>();
/** Bumped whenever the lane changes, so a loop can notice it moved. */
let generation = 0;
/** Bumped on every reset, so a decision still in flight from before one lands on nobody. */
let era = 0;
/** The asset URLs the current lane was started with. */
let startedWith: string | null = null;
let holders = 0;
let idleTimer: number | null = null;

function urlsKey(urls: AssetUrls): string {
  return `${urls.detectWorker}|${urls.scanic}|${urls.model}`;
}

/** The lane this session is on — `null` while it is still being decided (or never was). */
export function detectLane(): DetectLaneKind | null {
  return state === "worker" || state === "main" ? state : null;
}

/** Why: `worker`, or what kept the session off it. */
export function detectLaneReason(): LaneReason | null {
  return reason;
}

/** Resolves once no decision is in flight (at once when none was ever started). */
export async function detectLaneSettled(): Promise<void> {
  if (state === "starting" && decision !== null) await decision;
}

/**
 * Resolves as soon as a job on this lane measures detection rather than a
 * download: on the worker lane once scanic has loaded there (or the lane has
 * moved); at once otherwise. The live loop waits for it before its first
 * measured pass — a slow module fetch is not a slow device.
 */
export function detectLaneReady(): Promise<void> {
  if (state !== "worker" || workerReady) return Promise.resolve();
  return new Promise((resolve) => readyWaiters.push(resolve));
}

function wakeReadyWaiters(): void {
  const waiters = readyWaiters;
  readyWaiters = [];
  for (const wake of waiters) wake();
}

/** Changes every time the lane does. */
export function detectLaneGeneration(): number {
  return generation;
}

function settle(lane: DetectLaneKind, why: LaneReason): DetectLaneKind {
  state = lane;
  reason = why;
  generation += 1;
  if (lane !== "worker") wakeReadyWaiters();
  if (probing()) probe({ type: "lane", t: performance.now(), lane, reason: why });
  return lane;
}

/** Every job the worker held answers a miss; the worker is gone. */
function abandonWorker(): void {
  const doomed = worker;
  worker = null;
  workerReady = false;
  if (doomed !== null) {
    doomed.onmessage = null;
    doomed.onerror = null;
    doomed.onmessageerror = null;
    try {
      doomed.terminate();
    } catch {
      // Already gone.
    }
  }
  for (const job of pending.values()) job.resolve({ type: "miss", why: "gone" });
  pending.clear();
}

/**
 * The worker lane cannot carry the session any longer: the main thread takes
 * the rest of it, with the reason. The model was warm in the worker, not
 * here, so the main thread's path warms its own when it next needs it — and
 * only a failure *there* latches it off.
 */
export function demoteDetectLane(why: LaneReason): void {
  if (state !== "worker") return;
  abandonWorker();
  forgetMlReady();
  settle("main", why);
}

function handle(message: WorkerToMain): void {
  switch (message.type) {
    case "ready":
      workerReady = true;
      wakeReadyWaiters();
      return;
    case "ml":
      // A model that fails in the worker — a CSP on its response, its own
      // memory ceiling — may well run on the page: not a latch, a lane move.
      if (message.ok) markMlReady();
      else demoteDetectLane("worker-ml-failed");
      return;
    case "init-failed":
      // scanic will not load in the worker: neither detector can run there.
      demoteDetectLane("worker-init-failed");
      return;
    case "result": {
      const job = pending.get(message.id);
      pending.delete(message.id);
      job?.resolve(message);
      return;
    }
    case "dropped":
    case "error": {
      const job = pending.get(message.id);
      pending.delete(message.id);
      job?.resolve({ type: "miss", why: message.type });
      return;
    }
    default:
      return;
  }
}

/**
 * Decide this session's lane, starting the worker (and, through it, the
 * model's download and compile) if it can be used. Idempotent: every later
 * call answers the same decision until the lane is released.
 */
export function startDetectLane(urls: AssetUrls): Promise<DetectLaneKind> {
  if (decision !== null) return decision;
  startedWith = urlsKey(urls);
  decision = decide(urls, era);
  return decision;
}

/**
 * A scanner on the page needs the lane: start it (or keep the one there is)
 * and answer the release to call on unmount. The last release leaves the
 * worker running for {@link IDLE_RELEASE_MS}, then terminates it.
 */
export function holdDetectLane(urls: AssetUrls): () => void {
  holders += 1;
  if (idleTimer !== null) {
    window.clearTimeout(idleTimer);
    idleTimer = null;
  }
  // Nothing else holds the lane and it was started for other assets (a host
  // that deployed a new version between two mounts): start over.
  if (holders === 1 && decision !== null && startedWith !== urlsKey(urls)) resetDetectLane();
  void startDetectLane(urls);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
    if (holders > 0) return;
    idleTimer = window.setTimeout(() => {
      idleTimer = null;
      if (holders === 0) resetDetectLane();
    }, IDLE_RELEASE_MS);
  };
}

async function decide(urls: AssetUrls, startedIn: number): Promise<DetectLaneKind> {
  state = "starting";
  const forced = probeSetting("lane");
  if (forced === "main") return settle("main", "forced");
  const blocker = laneBlocker({
    worker: typeof Worker === "function",
    createImageBitmap: typeof createImageBitmap === "function",
  });
  if (blocker !== null) return settle("main", blocker);
  const started = await spawnWorker(urls);
  if (startedIn !== era) {
    // Released while the worker was being started: nobody wants it.
    if (typeof started !== "string") started.terminate();
    return "main";
  }
  if (typeof started === "string") return settle("main", started);
  const created = started;
  worker = created;
  workerReady = false;
  created.onmessage = (event: MessageEvent<WorkerToMain>) => handle(event.data);
  created.onerror = () => demoteDetectLane("worker-crashed");
  created.onmessageerror = () => demoteDetectLane("worker-crashed");
  const slowdown = Number(probeSetting("workerSlowdown"));
  created.postMessage({
    type: "init",
    scanic: urls.scanic,
    ml: { ...mlDetectorOptions(urls, ML_WEAK_CONFIDENCE) },
    classicalFloor: CLASSICAL_FLOOR,
    ...(Number.isFinite(slowdown) && slowdown > 1 ? { slowdown } : {}),
  });
  return settle("worker", "worker");
}

/**
 * A new detection worker that said hello with a 2-D `OffscreenCanvas`, or
 * the reason there is none (the half-started worker terminated).
 */
async function spawnWorker(urls: AssetUrls): Promise<Worker | LaneReason> {
  let created: Worker;
  try {
    created = new Worker(urls.detectWorker, { type: "module", name: DETECT_WORKER_NAME });
  } catch {
    return "worker-load-error";
  }
  const hello = await new Promise<{ offscreen2d: boolean; wasm: boolean } | LaneReason>((resolve) => {
    const timer = window.setTimeout(() => resolve("worker-timeout"), HELLO_TIMEOUT_MS);
    created.onerror = () => {
      window.clearTimeout(timer);
      resolve("worker-load-error");
    };
    created.onmessage = (event: MessageEvent<WorkerToMain>) => {
      if (event.data?.type !== "hello") return;
      window.clearTimeout(timer);
      resolve({ offscreen2d: event.data.offscreen2d === true, wasm: event.data.wasm !== false });
    };
  });
  if (typeof hello === "string" || !hello.offscreen2d || !hello.wasm) {
    created.onerror = null;
    created.onmessage = null;
    created.terminate();
    return typeof hello === "string" ? hello : !hello.offscreen2d ? "no-offscreen-canvas" : "no-wasm-in-worker";
  }
  return created;
}

/**
 * Whether this page could run detection in the worker — its script served,
 * allowed by the CSP on its own response (WebAssembly included), with a 2-D
 * `OffscreenCanvas` — for
 * the self-test (`src/self-test.ts`). A throwaway worker: the session's lane
 * is not touched, and nothing is downloaded.
 */
export async function probeDetectWorker(urls: AssetUrls): Promise<LaneReason> {
  const blocker = laneBlocker({
    worker: typeof Worker === "function",
    createImageBitmap: typeof createImageBitmap === "function",
  });
  if (blocker !== null) return blocker;
  const started = await spawnWorker(urls);
  if (typeof started === "string") return started;
  started.terminate();
  return "worker";
}

/** One job for the worker, as its caller describes it. */
export interface LaneJob {
  frame: ImageBitmap;
  width: number;
  height: number;
  plan: DetectPlan;
  priority: DetectPriority;
  capturedAt: number;
  epoch: number;
  luma: boolean;
  refineMs: number;
  evidence: boolean;
  held: CornerPoints | null;
  heldCovered?: CoveredCorner[];
  hint: boolean;
}

/**
 * Hand a frame to the worker and wait (at most `budgetMs`) for its answer.
 * The frame is transferred — the caller must not touch it again, and it is
 * closed here if the hand-over itself fails. Every kind of "no answer" is a
 * {@link LaneMiss} saying which: no worker, a dropped or failed job, a blown
 * budget (the worker is told to drop the job if it has not started; a late
 * answer is ignored), a worker that died.
 */
export function laneDetect(job: LaneJob, budgetMs: number): Promise<ResultReply | LaneMiss> {
  const target = worker;
  if (state !== "worker" || target === null) {
    job.frame.close();
    return Promise.resolve({ type: "miss", why: "gone" });
  }
  const id = nextId;
  nextId += 1;
  return new Promise<ResultReply | LaneMiss>((resolve) => {
    const timer = window.setTimeout(() => {
      pending.delete(id);
      try {
        target.postMessage({ type: "cancel", id });
      } catch {
        // The worker is gone; nothing to cancel.
      }
      resolve({ type: "miss", why: "timeout" });
    }, budgetMs);
    pending.set(id, {
      resolve(reply) {
        window.clearTimeout(timer);
        resolve(reply);
      },
    });
    const message: DetectMessage = { type: "detect", id, ...job };
    try {
      target.postMessage(message, [job.frame]);
    } catch {
      pending.delete(id);
      window.clearTimeout(timer);
      job.frame.close();
      resolve({ type: "miss", why: "gone" });
    }
  });
}

/**
 * Forget the lane: the worker, if any, is terminated, and the next mount
 * decides afresh. The idle release (and tests) call this.
 */
export function resetDetectLane(): void {
  const wasWorker = state === "worker";
  abandonWorker();
  // The model proven in the worker is gone with it.
  if (wasWorker) forgetMlReady();
  state = "idle";
  reason = null;
  decision = null;
  startedWith = null;
  era += 1;
  generation += 1;
  wakeReadyWaiters();
}
