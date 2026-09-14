/**
 * What crosses the wire to the render worker, and the three decisions that
 * govern the crossing — kept away from anything that touches a canvas so they
 * can be reasoned about, and tested, on their own.
 *
 * The decisions are small but they are the ones that can hurt a user:
 *
 *  * **Which lane** ({@link chooseRenderLane}). The worker is an optimisation,
 *    never a requirement: an old browser, a worker that has already died twice,
 *    or a lane that is busy all fall back to the main thread rather than
 *    queueing megabytes of pixel buffers behind each other.
 *  * **Which reply may land** ({@link GenerationLedger}). Renders are
 *    superseded constantly — three taps through the finish pills is three jobs
 *    — and a stale reply that wins is a page showing a finish the user moved
 *    away from.
 *  * **What the worker is told** ({@link renderJobMessage}). One spec, built
 *    from the same {@link PixelJob} the local lane renders, so the two lanes
 *    cannot disagree about what they were asked for.
 */

import type { PixelJob, PixelStage } from "@/lib/render-pixels";
import type { EncodeRole } from "@/lib/encode";

/** Main thread → worker: render this bitmap's tail. */
export interface RenderJobMessage {
  generation: number;
  job: PixelJob;
  /** Transferred, not copied. The worker owns it and closes it. */
  bitmap: ImageBitmap;
}

/** Worker → main thread. */
export type RenderWorkerReply =
  | {
      kind: "done";
      generation: number;
      final: Blob;
      thumb: Blob | null;
      width: number;
      height: number;
      /** So the main thread's encode ledger can count what the worker wrote. */
      encodes: EncodeRole[];
    }
  | {
      kind: "failed";
      generation: number;
      stage: PixelStage;
      /** For a stack trace, never for a user. */
      message: string;
    }
  | {
      /**
       * The worker could not take the job at all (no surface, no context). Not
       * a stage failure: there is no concession that would make it succeed, so
       * the render goes back to the main thread instead of spending one.
       */
      kind: "unavailable";
      generation: number;
      message: string;
    };

/**
 * The job, addressed.
 *
 * Deliberately a pass-through of the caller's {@link PixelJob}: the moment this
 * function starts *deriving* anything, the worker is rendering a spec the local
 * lane never sees, and "both lanes produce the same pixels" stops being a
 * structural fact.
 */
export function renderJobMessage(
  generation: number,
  job: PixelJob,
  bitmap: ImageBitmap,
): RenderJobMessage {
  return { generation, job, bitmap };
}

/** The platform pieces the worker lane is built out of. */
export interface RenderWorkerSupport {
  worker: boolean;
  offscreenCanvas: boolean;
  /** `OffscreenCanvas.prototype.convertToBlob` — Safari shipped it late. */
  convertToBlob: boolean;
  /** How the post-warp canvas gets to the worker without a re-encode. */
  createImageBitmap: boolean;
}

/**
 * Every piece, or nothing.
 *
 * There is no partial worker lane: without `convertToBlob` the tail would have
 * to send pixels back to be encoded on the main thread, which is the freeze it
 * was moved off the main thread to avoid.
 */
export function supportsRenderWorker(support: RenderWorkerSupport): boolean {
  return (
    support.worker &&
    support.offscreenCanvas &&
    support.convertToBlob &&
    support.createImageBitmap
  );
}

/**
 * The encodes a reply may add to the main thread's ledger.
 *
 * The ledger counts the JPEG generations whose **bytes reached this thread** —
 * never the encodes some realm attempted. A worker that wrote a final and then
 * died before it could answer produced no generation any page carries: those
 * bytes were freed with the thread, the render is re-run from the canonical,
 * and the page the user ends up with has exactly the lineage the counter
 * reports. Anything that is not a delivered `done` therefore contributes
 * nothing.
 */
export function deliveredEncodes(reply: RenderWorkerReply): EncodeRole[] {
  return reply.kind === "done" ? reply.encodes : [];
}

/** Where a render's tail runs. */
export type RenderLane = "worker" | "main";

export interface RenderLaneState {
  supported: boolean;
  /** True while the worker already holds a job. */
  busy: boolean;
  /** Worker deaths so far this session. */
  failures: number;
}

/**
 * How many times a dying worker is worth respawning.
 *
 * A worker that dies is usually a worker that ran out of memory on a 12 MP
 * page, and the page after it will be the same size. Two goes, then the
 * session renders on the main thread — slower, but it is the lane that cannot
 * disappear.
 */
export const MAX_WORKER_FAILURES = 2;

/**
 * The lane this render should take.
 *
 * `busy` is a hard no rather than a queue on purpose: the worker holds a
 * full-resolution surface for the length of a job, and a second job waiting
 * behind it with its own transferred bitmap is ~96 MB of pixel buffers on a
 * phone that has already been seen to fail at ~48 MB. The store renders one
 * page at a time anyway, so this is a guard, not a common path.
 */
export function chooseRenderLane(state: RenderLaneState): RenderLane {
  if (!state.supported) return "main";
  if (state.busy) return "main";
  if (state.failures >= MAX_WORKER_FAILURES) return "main";
  return "worker";
}

/**
 * Which render jobs may still land.
 *
 * A job's generation is retired the moment its reply is accepted, cancelled or
 * lost, and a reply for a generation that is no longer live is dropped without
 * being looked at. That is the whole rule: it makes "a stale render can never
 * overwrite a newer one" a property of the seam rather than something every
 * caller has to remember.
 */
export class GenerationLedger {
  private sequence = 0;
  private readonly live = new Set<number>();

  /** A fresh, strictly increasing id, marked live. */
  next(): number {
    this.sequence += 1;
    this.live.add(this.sequence);
    return this.sequence;
  }

  isLive(generation: number): boolean {
    return this.live.has(generation);
  }

  /** @returns true when this generation was still live — i.e. it won the race. */
  retire(generation: number): boolean {
    return this.live.delete(generation);
  }

  /** @returns the generations that were live, in the order they were issued. */
  retireAll(): number[] {
    const retired = [...this.live].sort((left, right) => left - right);
    this.live.clear();
    return retired;
  }
}
