/**
 * Everything the render pass does *after* the geometry — on whichever thread.
 *
 * The page's chain is `decode → warp → finish → rotate → encode`. The first two
 * are stuck on the main thread: `scanic`'s detector reaches for
 * `document.createElement("canvas")`, so the warp cannot be moved. The last
 * three are the expensive ones — a full-resolution illumination pass, a
 * full-resolution turn and two JPEG encodes — and on a cheap Android they are
 * the seconds where the rail stops repainting. That is what this module is: the
 * tail of the chain, written once, against a {@link CanvasSurface} and a
 * {@link SurfaceFactory} so the *identical code* runs on the main thread and
 * inside `lib/render.worker.ts`.
 *
 * One implementation is the whole point. "The worker's output is the same as
 * the main thread's" is not a promise anyone can keep by porting the maths
 * twice; it is only structurally true if there is one copy of it, one quality
 * table (`lib/encode.ts`) and one job spec ({@link PixelJob}) — which is why
 * both lanes take the same spec object rather than each building their own.
 */

import {
  bakeRotation,
  releaseSurface,
  scaleSurface,
  type CanvasSurface,
  type SurfaceFactory,
} from "@/lib/canvas-surface";
import { encodeSurface, type EncodeRole } from "@/lib/encode";
import { binarize, deepenInk, normalizeIllumination } from "@/lib/enhance";
import type { PageRotation } from "@/lib/rotation";

/**
 * "Acabamento da folha" — what the page is allowed to look like.
 *
 * `clean` is the default and the product: the scan look, colour intact. The
 * other two exist because two real documents defeat it. A photo of a page that
 * is *meant* to be colourful — a vaccination card's stamps, a chart — is worse
 * for the correction, so `original` skips it. And a grey photocopy that is
 * still grey after the correction reads as a photocopy, so `bw` finishes the
 * job. Neither is a "better" setting; they are the two ways the default is
 * wrong.
 */
export type PageFinish = "original" | "clean" | "bw";

export const DEFAULT_FINISH: PageFinish = "clean";

/**
 * Which part of the tail gave up.
 *
 * The same three words `lib/page-processing.ts` labels its ladder with, on
 * purpose: a worker-side finish failure has to arrive as *the finish stage*
 * failing, or the policy that decides what a failure may cost would be reading
 * a different vocabulary from the one it was written against.
 */
export type PixelStage = "finish" | "rotate" | "encode";

/** A failure in the tail, labelled with the stage it happened in. */
export class PixelStageError extends Error {
  readonly stage: PixelStage;
  /** Whatever the stage actually threw. */
  readonly reason: unknown;

  constructor(stage: PixelStage, reason: unknown) {
    // The message is for a stack trace, never for a user.
    super(`render failed at ${stage}`);
    this.name = "PixelStageError";
    this.stage = stage;
    this.reason = reason;
  }
}

/**
 * Everything the tail needs to know, and nothing that identifies a page.
 *
 * The same object is handed to the local call and posted to the worker, so
 * there is no per-lane spec to drift.
 */
export interface PixelJob {
  finish: PageFinish;
  rotation: PageRotation;
  /** Long edge of the rail/review thumbnail. */
  thumbLongEdge: number;
}

/** What one tail produced. */
export interface RenderedPixels {
  /** JPEG q85 — shown on screen AND embedded in the PDF, same bytes. */
  final: Blob;
  /** ~480 px JPEG for the rail and the review cards. Best effort. */
  thumb: Blob | null;
  /** Pixel dimensions of `final`; the PDF page is cut to them. */
  width: number;
  height: number;
  /**
   * The encodes this pass wrote, in order.
   *
   * Reported rather than assumed because the ledger in `lib/encode.ts` is
   * per-realm: when the tail ran in the worker, this list is how the main
   * thread's counter learns about generations it did not write itself.
   */
  encodes: EncodeRole[];
}

function atStage<T>(stage: PixelStage, run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw new PixelStageError(stage, error);
  }
}

/**
 * The finish, applied in place — the ONE place a finish is decided.
 *
 * Both render lanes reach the pixels through here (`renderPixels` below, which
 * the worker calls with `offscreenSurface` and `render-remote.ts` calls with
 * `htmlSurface`, plus the on-screen compare render in `lib/page-processing.ts`),
 * so worker/main parity is structural rather than remembered.
 *
 * `bw` runs *after* the illumination correction rather than instead of it — a
 * global threshold over a raw phone photo turns the shadowed corner solid
 * black, and removing the gradient first is the only reason it is safe. It
 * deliberately stops there: `deepenInk` before Otsu would move the threshold
 * (see the note on `binarize`), and a binarised page has no ink depth to gain.
 */
export function applyFinish<T extends CanvasSurface>(
  surface: T,
  finish: PageFinish,
  create: SurfaceFactory<T>,
): T {
  if (finish === "original") return surface;
  if (finish === "bw") return binarize(normalizeIllumination(surface, create));
  // "clarear + tinta forte": flatten the room's light, then curve the ink the
  // flattening exposed. This pairing was chosen over plain `clarear`
  // from a side-by-side on his own captures.
  return deepenInk(normalizeIllumination(surface, create));
}

/**
 * Finish, turn, encode — and free every surface it touched, `source` included.
 *
 * The caller hands over ownership of `source`: on a 12 MP page each surface is
 * ~48 MB of backing store, and three of them alive at once is where a cheap
 * Android stops allocating canvases altogether, so the tail frees as it goes
 * rather than leaving a chain of them to the next GC.
 *
 * `yieldBetweenPasses` exists for the main thread only, where it lets the rail
 * repaint between the heavy pixel pass and the encodes instead of freezing
 * through both. In the worker there is nothing to repaint and it is null.
 */
export async function renderPixels<T extends CanvasSurface>(
  source: T,
  job: PixelJob,
  create: SurfaceFactory<T>,
  yieldBetweenPasses: (() => Promise<void>) | null,
): Promise<RenderedPixels> {
  const surfaces: T[] = [source];
  const track = (surface: T): T => {
    if (!surfaces.includes(surface)) surfaces.push(surface);
    return surface;
  };
  const encodes: EncodeRole[] = [];
  try {
    let working = track(atStage("finish", () => applyFinish(source, job.finish, create)));
    working = track(atStage("rotate", () => bakeRotation(working, job.rotation, create)));
    if (yieldBetweenPasses !== null) await yieldBetweenPasses();

    let final: Blob;
    try {
      final = await encodeSurface(working, "final");
    } catch (error) {
      throw new PixelStageError("encode", error);
    }
    encodes.push("final");

    let thumb: Blob | null = null;
    try {
      thumb = await encodeSurface(
        track(scaleSurface(working, job.thumbLongEdge, create)),
        "thumb",
      );
      encodes.push("thumb");
    } catch {
      // A thumbnail is a convenience — the rail falls back to the final. Losing
      // it must never cost the user a page.
      thumb = null;
    }
    return { final, thumb, width: working.width, height: working.height, encodes };
  } finally {
    for (const surface of surfaces) releaseSurface(surface);
  }
}
