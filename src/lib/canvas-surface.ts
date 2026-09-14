/**
 * One pixel surface, two threads.
 *
 * The render pass used to be written against `HTMLCanvasElement` because that
 * was the only canvas the app had. Moving the heavy half of it into a Worker
 * (`lib/render.worker.ts`) needs the *same arithmetic* to run on an
 * `OffscreenCanvas`, and the one thing that must never happen is a second copy
 * of that arithmetic drifting from the first: two implementations of an
 * illumination correction are two different-looking scans of the same page.
 *
 * So the pixel code is written against the pieces both canvases genuinely
 * share — {@link CanvasSurface} for the buffer, {@link Surface2D} for the
 * handful of 2-D calls the pipeline actually makes — and every operation that
 * needs to *allocate* takes a {@link SurfaceFactory} instead of reaching for
 * `document`. The thread picks the factory once, at its entry point; nothing
 * below that has to know which thread it is on.
 *
 * `Surface2D` is deliberately a hand-written subset rather than the union of
 * the two context types: TypeScript cannot call a method through a union of
 * two overloaded signatures, and naming exactly what the pipeline uses is also
 * the cheapest possible inventory of what has to keep working on both sides.
 */

import type { PageRotation } from "@/lib/rotation";

/** A canvas the pipeline can draw on, whichever thread allocated it. */
export type CanvasSurface = HTMLCanvasElement | OffscreenCanvas;

/** The 2-D operations the render pipeline makes, and nothing else. */
export interface Surface2D {
  drawImage(image: CanvasImageSource, dx: number, dy: number): void;
  drawImage(
    image: CanvasImageSource,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
  getImageData(sx: number, sy: number, sw: number, sh: number): ImageData;
  putImageData(image: ImageData, dx: number, dy: number): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
}

/**
 * How a thread allocates a surface.
 *
 * Passed down rather than resolved from a global so the same function body can
 * run on the main thread and in the worker without a branch — and so a test
 * can see, from the signature alone, that a helper allocates at all.
 */
export type SurfaceFactory<T extends CanvasSurface> = (
  width: number,
  height: number,
) => T;

function sane(value: number): number {
  return Math.max(1, Math.round(value));
}

/** The main thread's factory. Never called from a worker — there is no DOM. */
export const htmlSurface: SurfaceFactory<HTMLCanvasElement> = (width, height) => {
  const canvas = document.createElement("canvas");
  canvas.width = sane(width);
  canvas.height = sane(height);
  return canvas;
};

/** The worker's factory. */
export const offscreenSurface: SurfaceFactory<OffscreenCanvas> = (width, height) =>
  new OffscreenCanvas(sane(width), sane(height));

/**
 * Which kind of surface this is.
 *
 * The `typeof` guard has to come first: `OffscreenCanvas` is undefined on the
 * browsers that lack it, and `instanceof undefined` throws rather than
 * answering false — which would turn "this phone is too old for the worker"
 * into a crash on the main-thread path too.
 */
export function isOffscreen(surface: CanvasSurface): surface is OffscreenCanvas {
  return typeof OffscreenCanvas !== "undefined" && surface instanceof OffscreenCanvas;
}

/**
 * The surface's 2-D context, or null when the browser refuses one.
 *
 * Null rather than a throw: every caller in the pipeline has a documented way
 * to degrade (return the page un-enhanced, fail the stage with its own label),
 * and none of them wants an untyped exception from three frames down.
 */
export function surfaceContext(
  surface: CanvasSurface,
  options?: CanvasRenderingContext2DSettings,
): Surface2D | null {
  return isOffscreen(surface)
    ? surface.getContext("2d", options)
    : surface.getContext("2d", options);
}

/**
 * A surface that is finished with: drop its backing store now rather than when
 * a phone with 200 MB of headroom gets round to collecting it. Zeroing the
 * dimensions is the only portable way to free it.
 */
export function releaseSurface(surface: CanvasSurface | null): void {
  if (surface === null) return;
  surface.width = 0;
  surface.height = 0;
}

/**
 * A quarter turn, as an exact pixel permutation.
 *
 * The transform is written as integer translations rather than
 * `translate(w/2, h/2) + rotate()`: a half-pixel offset on an odd-sized canvas
 * is enough to make the browser resample, and a resample is exactly the
 * generation the one-render-pass rewrite exists to remove.
 *
 * Releases `source` when it produces a new surface, so the caller's tracking
 * list only ever has to free what it is still holding.
 */
export function bakeRotation<T extends CanvasSurface>(
  source: T,
  rotation: PageRotation,
  create: SurfaceFactory<T>,
): T {
  if (rotation === 0) return source;
  const width = source.width;
  const height = source.height;
  const quarter = rotation === 90 || rotation === 270;
  const surface = create(quarter ? height : width, quarter ? width : height);
  const context = surfaceContext(surface);
  if (context === null) throw new Error("no 2-D context for the rotation");
  if (rotation === 90) context.setTransform(0, 1, -1, 0, height, 0);
  else if (rotation === 180) context.setTransform(-1, 0, 0, -1, width, height);
  else context.setTransform(0, -1, 1, 0, 0, width);
  context.drawImage(source, 0, 0);
  context.setTransform(1, 0, 0, 1, 0, 0);
  releaseSurface(source);
  return surface;
}

/**
 * A copy scaled to fit `longEdge`, or the original when it already does.
 *
 * The caller owns both: this one does *not* release the source, because the
 * page's own full-size surface is still the thing being encoded when the
 * thumbnail is taken off it.
 */
export function scaleSurface<T extends CanvasSurface>(
  source: T,
  longEdge: number,
  create: SurfaceFactory<T>,
): T {
  const scale = Math.min(
    1,
    longEdge / Math.max(1, Math.max(source.width, source.height)),
  );
  if (scale >= 1) return source;
  const surface = create(source.width * scale, source.height * scale);
  const context = surfaceContext(surface);
  if (context === null) throw new Error("no 2-D context for the thumbnail");
  context.drawImage(source, 0, 0, surface.width, surface.height);
  return surface;
}
