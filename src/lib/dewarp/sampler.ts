/**
 * Where the engine touches pixels.
 *
 * It is one bilinear resample and nothing else: {@link startTiledRender} takes
 * the canonical image through the composed map to the finished page. Otherwise
 * the engine only ever moves coordinates around — which is the whole reason
 * the chain is a *replacement* for the homography rather than a pass on top of
 * it: the page is resampled exactly once, from the canonical, so there is no
 * generation of blur to inherit.
 *
 * The render is tiled and resumable because it is the one expensive thing that
 * runs on whichever thread the caller is on. A 2000×3000 page is six million
 * bilinear samples; done in one call it is a visible freeze, and a page the
 * user has already navigated away from would still be paid for in full.
 */

import { composeInto, pixelFraction, type CoarseGrid } from "./grid.ts";
import type { CropBox, RgbaImage } from "./types.ts";

/**
 * Rows per resumable step.
 *
 * Small enough that one step stays inside a frame's budget on a mid-range
 * phone, large enough that the per-step bookkeeping stays noise.
 */
export const DEFAULT_TILE_ROWS = 256;

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/**
 * Bilinear RGB at a fractional source position, written into `out`.
 *
 * Coordinates are clamped to the image. That is not a bounds *fix* — the map
 * guard has already rejected anything genuinely outside — it only absorbs the
 * sub-pixel epsilon the guard deliberately tolerates at the very edge.
 */
function sampleRgb(
  image: RgbaImage,
  x: number,
  y: number,
  out: Float64Array,
): void {
  const maxX = image.width - 1;
  const maxY = image.height - 1;
  const sx = clamp(x, 0, maxX);
  const sy = clamp(y, 0, maxY);
  const x0 = Math.floor(sx);
  const y0 = Math.floor(sy);
  const x1 = Math.min(maxX, x0 + 1);
  const y1 = Math.min(maxY, y0 + 1);
  const fx = sx - x0;
  const fy = sy - y0;

  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;

  const i00 = (y0 * image.width + x0) * 4;
  const i10 = (y0 * image.width + x1) * 4;
  const i01 = (y1 * image.width + x0) * 4;
  const i11 = (y1 * image.width + x1) * 4;
  const data = image.data;

  out[0] =
    data[i00] * w00 + data[i10] * w10 + data[i01] * w01 + data[i11] * w11;
  out[1] =
    data[i00 + 1] * w00 +
    data[i10 + 1] * w10 +
    data[i01 + 1] * w01 +
    data[i11 + 1] * w11;
  out[2] =
    data[i00 + 2] * w00 +
    data[i10 + 2] * w10 +
    data[i01 + 2] * w01 +
    data[i11 + 2] * w11;
}

/**
 * `origin + index/(size−1) × span`, multiplied before it is divided.
 *
 * The order matters more than it looks: at a 1:1 crop `span` *is* `size − 1`,
 * and only this order makes the result land back on the exact integer pixel.
 * The fraction-first form drifts by one ulp, which turns an exact pixel copy
 * into a bilinear blend of two neighbours weighted 0.9999999/0.0000001 — a
 * difference of one bit per channel that nonetheless changes the output.
 */
function axisPosition(
  index: number,
  size: number,
  origin: number,
  span: number,
): number {
  return size <= 1 ? origin : origin + (index * span) / (size - 1);
}

export interface TiledRenderRequest {
  source: RgbaImage;
  grid: CoarseGrid;
  crop: CropBox;
  width: number;
  height: number;
  tileRows?: number;
}

/** A render in progress. `step()` does one band and reports whether it finished. */
export interface TiledRender {
  readonly image: RgbaImage;
  readonly done: boolean;
  /** Rows completed over rows total, 0–1. */
  readonly progress: number;
  step(): boolean;
}

/**
 * Start sampling the canonical image through the composed map.
 *
 * The caller drives it: one `step()` per band, with whatever it wants to do in
 * between (yield to the host, check an `AbortSignal`, drop the whole thing).
 * Abandoning a `TiledRender` costs nothing but the buffer.
 */
export function startTiledRender(request: TiledRenderRequest): TiledRender {
  const width = Math.max(1, Math.round(request.width));
  const height = Math.max(1, Math.round(request.height));
  const band = Math.max(1, Math.round(request.tileRows ?? DEFAULT_TILE_ROWS));
  const data = new Uint8ClampedArray(width * height * 4);
  const image: RgbaImage = { width, height, data };
  const point = { x: 0, y: 0 };
  const rgb = new Float64Array(3);
  let nextRow = 0;

  return {
    image,
    get done(): boolean {
      return nextRow >= height;
    },
    get progress(): number {
      return Math.min(1, nextRow / height);
    },
    step(): boolean {
      const stop = Math.min(height, nextRow + band);
      for (let row = nextRow; row < stop; row += 1) {
        const v = pixelFraction(row, height);
        let offset = row * width * 4;
        for (let column = 0; column < width; column += 1) {
          composeInto(
            request.grid,
            request.crop,
            pixelFraction(column, width),
            v,
            point,
          );
          sampleRgb(request.source, point.x, point.y, rgb);
          data[offset] = rgb[0];
          data[offset + 1] = rgb[1];
          data[offset + 2] = rgb[2];
          data[offset + 3] = 255;
          offset += 4;
        }
      }
      nextRow = stop;
      return nextRow >= height;
    },
  };
}

/**
 * The whole render in one call — for tests and for the low-resolution pass the
 * semantic check needs, where "tiled" would only add ceremony.
 *
 * Returns null when `shouldCancel` says so between bands.
 */
export function renderThroughGrid(
  request: TiledRenderRequest & { shouldCancel?: () => boolean },
): RgbaImage | null {
  const render = startTiledRender(request);
  while (!render.done) {
    if (request.shouldCancel?.() === true) return null;
    render.step();
  }
  return render.image;
}

/** The largest size with this aspect whose long edge is at most `longEdge`. */
export function fitLongEdge(
  width: number,
  height: number,
  longEdge: number,
): { width: number; height: number } {
  const scale = Math.min(1, longEdge / Math.max(1, Math.max(width, height)));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** A plain box-free downscale of an already-rendered surface, for the A/B pass. */
export function downscale(image: RgbaImage, longEdge: number): RgbaImage {
  const size = fitLongEdge(image.width, image.height, longEdge);
  if (size.width === image.width && size.height === image.height) return image;
  const data = new Uint8ClampedArray(size.width * size.height * 4);
  const rgb = new Float64Array(3);
  const spanX = image.width - 1;
  const spanY = image.height - 1;
  let offset = 0;
  for (let row = 0; row < size.height; row += 1) {
    const sy = axisPosition(row, size.height, 0, spanY);
    for (let column = 0; column < size.width; column += 1) {
      sampleRgb(image, axisPosition(column, size.width, 0, spanX), sy, rgb);
      data[offset] = rgb[0];
      data[offset + 1] = rgb[1];
      data[offset + 2] = rgb[2];
      data[offset + 3] = 255;
      offset += 4;
    }
  }
  return { width: size.width, height: size.height, data };
}
