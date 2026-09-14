"use client";

/**
 * The seam between a page's render and the thread that does the heavy half.
 *
 * `lib/page-processing.ts` asks for a tail — finish, turn, encode — and this
 * module decides where it runs. On a browser with `OffscreenCanvas`,
 * `convertToBlob` and workers it goes to `lib/render.worker.ts` and the rail
 * keeps repainting through a 12 MP illumination pass; on anything else, or on
 * anything that has already gone wrong, it runs exactly the pass that shipped
 * before this seam existed. The fallback is not a degraded copy of the worker
 * path: it *is* the original path, the same function the worker calls.
 *
 * Three lifecycle rules, all of them about a phone that has ~200 MB to spend:
 *
 *  * **One worker, one slot.** The worker is spawned on first use and kept; a
 *    render that arrives while it is busy runs on the main thread rather than
 *    queueing another full-resolution buffer behind the first.
 *  * **The source is handed over, not shared.** The post-warp canvas becomes a
 *    transferred `ImageBitmap` and is released here the moment the worker has
 *    it, so the two threads never hold the same page twice.
 *  * **A dead worker costs one render, not the session, and not forever.** The
 *    thread is replaced at most {@link MAX_WORKER_FAILURES} times; after that
 *    the session renders on the main thread and stops paying for the attempt.
 *  * **No job waits forever.** A worker can stop answering without dying loudly
 *    — killed for memory, stuck inside `convertToBlob` — and the store renders
 *    pages through a serial promise chain, so a job that never settles is not a
 *    slow page, it is a scanner that has stopped accepting pages. Every handoff
 *    therefore carries {@link RENDER_DEADLINE_MS} — and the copy that *makes*
 *    the handoff carries {@link HANDOFF_DEADLINE_MS}, because it runs in that
 *    same chain before the job's own clock exists.
 *
 * Cancellation is a termination, deliberately. A worker executing a synchronous
 * pixel pass cannot service a "please stop" message — it will not read its
 * queue until the pass it is already in has finished — so the only way to get
 * a phone's memory back *now* is to end the thread. What a cancel does
 * cheaply is retire the generation, which is what actually guarantees the
 * reply can never land on a page that has moved on.
 *
 * **Ownership.** The lane is one thread for the whole page, but a store is not:
 * `lib/scan-store.ts` is created per mounted component and disposed on unmount,
 * and under React StrictMode the second store is already live when the first
 * one's dispose runs. So the lane has an *owner* — the store id that claimed it
 * — every reserved job is stamped with it, and cancellation is scoped to it:
 * {@link cancelRemoteRenders} with an owner leaves another owner's job alone,
 * and {@link releaseRenderLane} hands the lane back without touching a render
 * that a newer store is waiting on. One thread, explicit ownership; a thread
 * per instance would be a second full-resolution buffer on a phone, which is
 * the thing this module exists to avoid.
 */

import { htmlSurface, releaseSurface } from "@/lib/canvas-surface";
import type { AssetUrls } from "@/lib/runtime-config";
import { countEncode } from "@/lib/encode";
import {
  chooseRenderLane,
  deliveredEncodes,
  GenerationLedger,
  renderJobMessage,
  supportsRenderWorker,
  type RenderWorkerReply,
  type RenderWorkerSupport,
} from "@/lib/render-protocol";
import { renderPixels, type PixelJob, type RenderedPixels } from "@/lib/render-pixels";

/**
 * How long a handed-over render may stay silent before the lane is written off.
 *
 * Not a latency budget — a liveness one. The tail it is bounding is a
 * full-resolution illumination pass, a turn and two JPEG encodes over a 3000 px
 * page, which on the slowest phone this app supports is seconds; a minute is an
 * order of magnitude past that, so nothing healthy can hit it. What it catches
 * is the thread that will never answer at all (killed for memory without an
 * `onerror`, wedged inside `convertToBlob`), because the store's render chain is
 * serial: an unsettled job is every later page, not just this one.
 */
export const RENDER_DEADLINE_MS = 60_000;

/**
 * How long the handover itself — the `ImageBitmap` copy of the page — may take
 * before this render gives up on the worker lane.
 *
 * Its own, much shorter clock, because it bounds a different wait. Everything
 * after `postMessage` is covered by {@link RENDER_DEADLINE_MS}, which is armed
 * only once the worker has the job; the copy happens *before* that, inside the
 * store's serial render chain, with nothing else watching it. A
 * `createImageBitmap` that never settles — the browser refusing a 12 MP copy
 * without rejecting — would therefore stall every later page as well, which is
 * the scanner having stopped rather than a slow render. Ten seconds is two
 * orders of magnitude past what the copy costs on the slowest phone this app
 * supports, so nothing healthy can reach it.
 */
export const HANDOFF_DEADLINE_MS = 10_000;

/**
 * The worker died, refused, or said something that says nothing certain about
 * the page.
 *
 * Distinct from a `PixelStageError` (`lib/render-pixels.ts`) because it says
 * nothing about the page: the caller re-runs the whole pass on the main thread
 * rather than spending one of the ladder's concessions on a thread problem.
 */
export class RenderWorkerLostError extends Error {
  constructor(reason: string) {
    super(`render worker lost: ${reason}`);
    this.name = "RenderWorkerLostError";
  }
}

/** The render was abandoned before it could land. Never a page's fault. */
export class RenderCancelledError extends Error {
  constructor() {
    super("render cancelled");
    this.name = "RenderCancelledError";
  }
}

interface InFlight {
  generation: number;
  /** Which store handed this job over. See "Ownership" above. */
  owner: string;
  settle(reply: RenderWorkerReply): void;
  fail(error: Error): void;
}

/**
 * The owner of a job nobody claimed — a direct `renderPageTail` call outside a
 * store, which is what every test and every non-store caller is.
 */
export const UNOWNED_RENDER_LANE = "unowned";

const ledger = new GenerationLedger();
let laneOwner: string = UNOWNED_RENDER_LANE;
let worker: Worker | null = null;
let inFlight: InFlight | null = null;
let deadlineTimer: number | null = null;
let failures = 0;
let supported: boolean | null = null;

function detectSupport(): RenderWorkerSupport {
  const offscreen = typeof OffscreenCanvas === "function";
  return {
    worker: typeof Worker === "function",
    offscreenCanvas: offscreen,
    convertToBlob:
      offscreen && typeof OffscreenCanvas.prototype.convertToBlob === "function",
    createImageBitmap: typeof createImageBitmap === "function",
  };
}

function workerLaneSupported(): boolean {
  if (supported === null) supported = supportsRenderWorker(detectSupport());
  return supported;
}

function discardWorker(): void {
  if (worker === null) return;
  worker.terminate();
  worker = null;
}

function clearDeadline(): void {
  if (deadlineTimer === null) return;
  window.clearTimeout(deadlineTimer);
  deadlineTimer = null;
}

/** Empties the slot, whatever put it there. */
function clearSlot(): void {
  clearDeadline();
  inFlight = null;
}

/** The worker died on its own, or was found dead. Costs one render. */
function loseWorker(reason: string): void {
  discardWorker();
  const job = inFlight;
  clearSlot();
  // The budget counts *lost renders*, not `onerror` events. A worker can throw
  // with nothing in flight — a top-level failure after it has already answered
  // — and charging that would retire a lane that has never dropped a page: two
  // such throws and the session renders on the main thread for ever, with zero
  // failed renders to show for it. The thread still goes (it cannot be trusted
  // with the next page); the next render simply spawns a fresh one.
  if (job === null) return;
  failures += 1;
  ledger.retire(job.generation);
  job.fail(new RenderWorkerLostError(reason));
}

/**
 * The deadline expired on `generation`: this lane is not going to answer.
 *
 * Charged exactly once, like any other worker death — the thread is ended (a
 * synchronous pixel pass cannot be asked to stop), the generation is retired so
 * a late reply can never land, and the render goes back to the caller as a lost
 * worker, which is its cue to re-run this one page on the main thread.
 */
function expire(generation: number): void {
  // A timer that fired after its job settled can arrive next to a newer job's
  // timer, so the slot is what says whether this expiry still means anything.
  const job = inFlight;
  if (job === null || job.generation !== generation) return;
  if (!ledger.retire(generation)) return;
  clearSlot();
  failures += 1;
  discardWorker();
  job.fail(new RenderWorkerLostError("no reply within the deadline"));
}

function armDeadline(generation: number): void {
  clearDeadline();
  deadlineTimer = window.setTimeout(() => {
    expire(generation);
  }, RENDER_DEADLINE_MS);
}

function receive(reply: RenderWorkerReply): void {
  // A reply whose generation is no longer live was superseded, cancelled or
  // timed out while it was in the air. Dropping it here is what stops a stale
  // render from overwriting the page the user is actually looking at.
  if (!ledger.retire(reply.generation)) return;
  const job = inFlight;
  if (job === null || job.generation !== reply.generation) return;
  clearSlot();
  job.settle(reply);
}

function ensureWorker(): Worker {
  if (worker !== null) return worker;
  if (laneAssets === null) {
    throw new RenderWorkerLostError(
      "the render lane was used before anyone said where this library's assets are"
    );
  }
  /**
   * Loaded as a file from the host's asset directory, NOT through
   * `new Worker(new URL("./render.worker.ts", import.meta.url))`.
   *
   * That form is an instruction to the bundler compiling the file, and inside a
   * published library the bundler that compiles it is ours, not the consumer's.
   * The specifier survives into `dist/` still naming a TypeScript file, and the
   * consumer's build then fails on an entry module that does not exist. It is
   * the kind of breakage that only appears in somebody else's build, which is
   * why the consumer smoke test exists.
   */
  const spawned = new Worker(laneAssets.renderWorker, {
    type: "module",
    name: "azelo-scan-render",
  });
  spawned.onmessage = (event: MessageEvent<RenderWorkerReply>) => {
    receive(event.data);
  };
  spawned.onerror = () => {
    loseWorker("worker error");
  };
  spawned.onmessageerror = () => {
    loseWorker("reply could not be deserialised");
  };
  worker = spawned;
  return spawned;
}

/** Lets the rail repaint between the heavy pixel pass and the encodes. */
function repaintYield(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

function localTail(source: HTMLCanvasElement, job: PixelJob): Promise<RenderedPixels> {
  return renderPixels(source, job, htmlSurface, repaintYield);
}

function settleWith(
  reply: RenderWorkerReply,
  resolve: (pixels: RenderedPixels) => void,
  reject: (error: Error) => void,
): void {
  // The worker's own ledger is a per-realm shadow nobody reads; this is where
  // the generations it *delivered* reach the counter the app asserts on.
  for (const role of deliveredEncodes(reply)) countEncode(role);
  if (reply.kind === "done") {
    resolve({
      final: reply.final,
      thumb: reply.thumb,
      width: reply.width,
      height: reply.height,
      encodes: reply.encodes,
    });
    return;
  }
  if (reply.kind === "failed") {
    // A stage that failed *in the worker* is not yet a fact about the page.
    // The thread it failed in is the one with a second full-resolution surface
    // in it and the smaller memory ceiling, so the same finish, turn or encode
    // can very well succeed on the main thread — and the caller's ladder must
    // not drop the user's enhancement, or fail their page, on the word of a
    // lane that is an optimisation. The render therefore goes back for a local
    // re-run, and whatever *that* says is what the page is judged on.
    //
    // Deliberately not charged to the worker's failure budget: a page that
    // genuinely cannot be finished would otherwise retire a healthy lane for
    // the rest of the session in two pages.
    reject(
      new RenderWorkerLostError(`unconfirmed ${reply.stage} failure: ${reply.message}`),
    );
    return;
  }
  // The thread is alive but could not allocate what the page needs. It is kept
  // — a smaller page may well fit — but it counts, because a phone that refuses
  // twice will refuse again and every attempt costs a transferred copy first.
  failures += 1;
  reject(new RenderWorkerLostError(reply.message));
}

/**
 * The accepted job, wrapped so the handoff's own `await` cannot swallow it.
 *
 * An `async` function that returned the pending render directly would await it
 * — and the whole point of the handoff is to *finish* while the render is still
 * running, so that a failure to hand over can be told apart from a failure to
 * render.
 */
interface HandedOver {
  pending: Promise<RenderedPixels>;
}

/**
 * Take the lane's one slot, before anything can be awaited.
 *
 * The generation and the pending promise exist from here on, which is what
 * makes a cancel arriving mid-handoff mean something: it has a live generation
 * to retire and a promise to reject. Reserving after the first `await` — the
 * bitmap copy of a 12 MP page is not instant — would leave a window in which a
 * new scan cannot stop the render that is about to start.
 */
function reserve(): { generation: number; pending: Promise<RenderedPixels> } {
  const generation = ledger.next();
  // Stamped at reservation, not at post: a cancel that arrives mid-handoff has
  // to be able to tell whose job it would be killing.
  const owner = laneOwner;
  const pending = new Promise<RenderedPixels>((resolve, reject) => {
    inFlight = {
      generation,
      owner,
      settle: (reply) => {
        settleWith(reply, resolve, reject);
      },
      fail: reject,
    };
  });
  return { generation, pending };
}

/** Give the slot back when the handoff never happened. */
function releaseReservation(generation: number): void {
  ledger.retire(generation);
  if (inFlight?.generation === generation) clearSlot();
}

/**
 * The transferable copy of the page, on a clock.
 *
 * A copy that arrives after the lane was written off owns pixels nobody will
 * ever read, so it is closed rather than left to a GC that may be a page or
 * two away on a phone with 200 MB to spend.
 */
function copyForWorker(source: HTMLCanvasElement): Promise<ImageBitmap> {
  const copy = createImageBitmap(source);
  return new Promise((resolve, reject) => {
    let abandoned = false;
    const timer = window.setTimeout(() => {
      abandoned = true;
      reject(new RenderWorkerLostError("the source copy did not finish in time"));
    }, HANDOFF_DEADLINE_MS);
    copy.then(
      (bitmap) => {
        window.clearTimeout(timer);
        if (abandoned) {
          bitmap.close();
          return;
        }
        resolve(bitmap);
      },
      (error: unknown) => {
        window.clearTimeout(timer);
        if (abandoned) return;
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Hand the tail to the worker.
 *
 * Resolves once the job is the worker's, or throws when the *handoff* failed —
 * which is a different thing from the render failing, and the only case the
 * caller may quietly retry on the main thread with the source it still owns.
 */
async function handToWorker(
  source: HTMLCanvasElement,
  job: PixelJob,
): Promise<HandedOver> {
  // Before the reservation: a browser that cannot even spawn the thread has not
  // taken the slot, and this render simply goes down the other lane.
  const live = ensureWorker();
  const { generation, pending } = reserve();

  let bitmap: ImageBitmap;
  try {
    // Bounded: this wait is inside the store's serial chain and no deadline is
    // armed until the job is posted ({@link HANDOFF_DEADLINE_MS}).
    bitmap = await copyForWorker(source);
  } catch (error) {
    releaseReservation(generation);
    throw error;
  }
  if (!ledger.isLive(generation)) {
    // Cancelled while the copy was being made. The promise is already rejected
    // with the cancellation; all that is left is the memory.
    bitmap.close();
    releaseSurface(source);
    return { pending };
  }

  try {
    live.postMessage(renderJobMessage(generation, job, bitmap), [bitmap]);
  } catch (error) {
    releaseReservation(generation);
    bitmap.close();
    throw error;
  }
  armDeadline(generation);
  // The worker owns the pixels now. Holding the canvas as well would mean two
  // copies of a 12 MP page alive for the length of the pass.
  releaseSurface(source);
  return { pending };
}

/**
 * Render a page's tail, wherever it is cheapest to do so.
 *
 * Takes ownership of `source` on every path. Rejects with a `PixelStageError`
 * when a stage genuinely failed **on this thread** (the caller's ladder decides
 * what that costs), with {@link RenderWorkerLostError} when the worker died, hung
 * or failed a stage of its own (the caller re-runs from the canonical on the
 * main thread), and with {@link RenderCancelledError} when the render was
 * abandoned.
 *
 * `remote: false` forces the main thread — that is how the retry after a lost
 * worker avoids handing the same page straight back to a thread that just died.
 */
export async function renderPageTail(
  source: HTMLCanvasElement,
  job: PixelJob,
  remote: boolean,
): Promise<RenderedPixels> {
  const lane = remote
    ? chooseRenderLane({
        supported: workerLaneSupported(),
        busy: inFlight !== null,
        failures,
      })
    : "main";

  if (lane === "worker") {
    let handed: HandedOver | null = null;
    try {
      handed = await handToWorker(source, job);
    } catch {
      // The handoff never happened, so `source` is still ours and still whole:
      // this render simply takes the other lane, and the failure counts so a
      // browser that keeps refusing stops being asked.
      failures += 1;
      handed = null;
    }
    if (handed !== null) return await handed.pending;
  }

  return localTail(source, job);
}

/**
 * Take the lane for a store, so its jobs can be told apart from anybody else's.
 *
 * Deliberately not exclusive: claiming does not evict the previous owner's job,
 * because the StrictMode sequence is claim-then-dispose and evicting here would
 * kill the render the *older* store is still unwinding, for no gain. What the
 * claim decides is only who the next reservation belongs to.
 */
export function claimRenderLane(owner: string): void {
  laneOwner = owner;
}

/** Where the worker file lives. Null until a host has said. */
let laneAssets: AssetUrls | null = null;

/**
 * Tell the lane where this library's worker file is served from.
 *
 * Separate from claiming the lane because the two are different facts: which
 * store owns the current job changes with every mount, while where the asset
 * lives is a property of the page and is the same for everyone on it. A store
 * calls this when it is created; tests call it once.
 */
export function setRenderWorkerAssets(assets: AssetUrls): void {
  laneAssets = assets;
}

/**
 * Hand the lane back on dispose: cancel this owner's job and, if nothing else
 * has taken over, end the thread.
 *
 * The worker is terminated rather than parked because the reason a store is
 * being disposed is that the flow is over — and a live thread holding a 12 MP
 * buffer is the most expensive thing in the app to keep for nobody.
 */
export function releaseRenderLane(owner: string): void {
  cancelRemoteRenders(owner);
  if (laneOwner !== owner) return;
  laneOwner = UNOWNED_RENDER_LANE;
  // Only when the slot is empty: a job still in flight belongs to somebody
  // else (this owner's was just cancelled), and its thread is not ours to end.
  if (inFlight === null) discardWorker();
}

/** Who the lane's next reservation will belong to. For tests and diagnostics. */
export function renderLaneOwner(): string {
  return laneOwner;
}

/**
 * Abandon whatever the worker is holding.
 *
 * Called when the pages themselves are gone (a new scan, a wipe, an unmount):
 * the reply could no longer be attached to anything, and on a phone the
 * megabytes are worth more than the pass.
 *
 * `owner` scopes it. Pass a store's id and a job belonging to a *different*
 * store is left alone — which is the whole point: under StrictMode one store's
 * teardown overlaps the next store's first render, and an unscoped cancel there
 * would drop a page the user is currently watching. Omitting it cancels
 * whatever is there, which is what a caller that owns the whole page means.
 */
export function cancelRemoteRenders(owner?: string): void {
  const job = inFlight;
  if (job !== null && owner !== undefined && job.owner !== owner) return;
  clearSlot();
  ledger.retireAll();
  if (job === null) return;
  discardWorker();
  job.fail(new RenderCancelledError());
}
