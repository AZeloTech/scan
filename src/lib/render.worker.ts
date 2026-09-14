/**
 * The render worker: the tail of a page's render, off the main thread.
 *
 * It is deliberately thin. Everything about *how* a page is finished, turned
 * and encoded lives in `lib/render-pixels.ts` and `lib/encode.ts`, which the
 * main thread runs too; this file only supplies the worker's own surface
 * factory and translates between messages and that one shared pass. Nothing
 * here may grow a second opinion about pixels.
 *
 * What it never sees is as deliberate: no canonical JPEG, no page id, no
 * session. A transferred `ImageBitmap` and three settings go in, two blobs come
 * back, and the thread can be terminated at any moment without taking anything
 * that is not reproducible from the canonical with it.
 *
 * Instantiated only through `lib/render-remote.ts`
 * (`new Worker(new URL("./render.worker.ts", import.meta.url))`) — the form
 * webpack recognises, so the chunk is emitted into the static export.
 */

import { offscreenSurface, surfaceContext } from "@/lib/canvas-surface";
import { PixelStageError, renderPixels } from "@/lib/render-pixels";
import type { RenderJobMessage, RenderWorkerReply } from "@/lib/render-protocol";

/**
 * The slice of the worker's global scope this file uses.
 *
 * `lib.dom` types the ambient `self` as a `Window` and does not ship
 * `DedicatedWorkerGlobalScope` (that lives in `lib.webworker`, which cannot be
 * loaded beside `lib.dom` in the same program). Naming the two members the
 * worker actually has is both the smaller lie and a readable inventory of the
 * protocol's two ends.
 */
interface RenderWorkerScope {
  onmessage: ((event: MessageEvent<RenderJobMessage>) => void) | null;
  postMessage(message: RenderWorkerReply): void;
}

declare const self: RenderWorkerScope;

/** For a stack trace, never for a user. */
function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

async function run(message: RenderJobMessage): Promise<RenderWorkerReply> {
  const { generation, job, bitmap } = message;

  let source: OffscreenCanvas | null = null;
  try {
    const surface = offscreenSurface(bitmap.width, bitmap.height);
    // The option only takes effect on a canvas's FIRST getContext call, and
    // this is it: `applyFinish` (clean/bw) reads this same surface back with
    // getImageData a few lines later in `renderPixels`, by which point the
    // browser has already locked in whatever this call passed.
    const context = surfaceContext(surface, { willReadFrequently: true });
    if (context === null) throw new Error("no 2-D context in the worker");
    context.drawImage(bitmap, 0, 0);
    source = surface;
  } catch (error) {
    // The worker could not even take the job — an allocation this thread cannot
    // make, on a phone that may still manage it on the main one. "Unavailable"
    // rather than a stage failure: no concession the ladder could make (drop
    // the enhancement, drop the crop) would change the outcome, so the honest
    // answer is to hand the render back rather than to spend the page's budget.
    return { kind: "unavailable", generation, message: describe(error) };
  } finally {
    // The bitmap is ours; its pixels are in the surface now (or lost with it).
    bitmap.close();
  }

  try {
    const pixels = await renderPixels(source, job, offscreenSurface, null);
    return {
      kind: "done",
      generation,
      final: pixels.final,
      thumb: pixels.thumb,
      width: pixels.width,
      height: pixels.height,
      encodes: pixels.encodes,
    };
  } catch (error) {
    if (error instanceof PixelStageError) {
      return {
        kind: "failed",
        generation,
        stage: error.stage,
        message: describe(error.reason),
      };
    }
    return { kind: "unavailable", generation, message: describe(error) };
  }
}

self.onmessage = (event: MessageEvent<RenderJobMessage>) => {
  // One job at a time is the seam's contract, not a hope: the main thread never
  // posts a second job while one is in flight (`chooseRenderLane`), because two
  // full-resolution surfaces in this thread is where a cheap Android dies.
  void run(event.data).then((reply) => {
    self.postMessage(reply);
  });
};
