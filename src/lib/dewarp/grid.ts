/**
 * The engine's answer, and what it means in canonical pixels.
 *
 * The engine returns one small backward map: a 65×47 lattice laid over the
 * *output* page, each node holding the place in the *input* (the padded crop)
 * that output point should be sampled from, in `grid_sample`'s [-1,1]
 * convention with `align_corners=true`.
 *
 * Two consequences shape this file. First, the grid is coarse — 65×47 for a
 * page that may render at 2000×3000 — so the map has to be interpolated at
 * whatever resolution it is asked for, never materialised. Second, the [-1,1]
 * convention has to be converted *twice*: once into the crop's own pixels, and
 * once more by the crop's offset into the canonical image. Both conversions
 * are `align_corners=true` (−1 is the centre of the first pixel, +1 the centre
 * of the last), and getting one of them wrong by half a pixel is a blur nobody
 * can see the cause of.
 */

import type { CropBox, DewarpPoint } from "./types.ts";

/**
 * The engine's grid density. Odd on both
 * axes so a lattice node sits exactly at the crop's centre.
 * `GRID_ROWS`/`GRID_COLS` in `dewarp-rs/src/wasm.rs` are the same two numbers.
 */
export const CLASSICAL_GRID_WIDTH = 47;
export const CLASSICAL_GRID_HEIGHT = 65;

/** The coarse backward map, split per axis. `x`/`y` are in [-1,1]. */
export interface CoarseGrid {
  width: number;
  height: number;
  /** Row-major, `height × width`: the source x for each lattice node. */
  x: Float32Array;
  /** Row-major, `height × width`: the source y for each lattice node. */
  y: Float32Array;
}

/** The tensor shape we accept, described loosely enough to test without ORT. */
export interface GridTensorLike {
  readonly dims: readonly number[];
  readonly type: string;
  readonly data: ArrayLike<number>;
}

/**
 * The engine answered with something that is not our grid.
 *
 * Its own class because it is the one worker failure that is *not* an
 * environment problem: a wrong shape means the wasm module on disk is not the
 * one this code was written against, and retrying will not help.
 */
export class GridContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GridContractError";
  }
}

/** The `[width, height]` a grid is checked against — one producer, one shape. */
export interface GridDims {
  width: number;
  height: number;
}

/** The engine's own shape. */
const ENGINE_DIMS: GridDims = {
  width: CLASSICAL_GRID_WIDTH,
  height: CLASSICAL_GRID_HEIGHT,
};

/**
 * Validate and unpack the worker's output.
 *
 * Rejects rather than coerces: a grid of the wrong rank, dtype or size is the
 * signal that the vendored wasm module and this file have drifted apart, and
 * the only safe answer to that is the homography.
 *
 * `expected` stays a parameter rather than being read off the constants above
 * so the guard can be exercised against a deliberately wrong shape.
 */
export function parseGridTensor(
  tensor: GridTensorLike,
  expected: GridDims = ENGINE_DIMS,
): CoarseGrid {
  const { dims, type, data } = tensor;
  if (type !== "float32") {
    throw new GridContractError(`grid dtype ${type}, expected float32`);
  }
  const expectedDims = [1, 2, expected.height, expected.width];
  if (
    dims.length !== expectedDims.length ||
    dims.some((d, i) => d !== expectedDims[i])
  ) {
    throw new GridContractError(
      `grid dims [${dims.join(",")}], expected [${expectedDims.join(",")}]`,
    );
  }
  const plane = expected.height * expected.width;
  if (data.length !== plane * 2) {
    throw new GridContractError(
      `grid holds ${data.length} values, expected ${plane * 2}`,
    );
  }
  const x = new Float32Array(plane);
  const y = new Float32Array(plane);
  for (let index = 0; index < plane; index += 1) {
    x[index] = data[index];
    y[index] = data[plane + index];
  }
  return { width: expected.width, height: expected.height, x, y };
}

/**
 * The grid that means "this page is already flat".
 *
 * Exported because it is the engine's own zero: the property tests compose it
 * and expect the crop rectangle back exactly, which is the cheapest possible
 * proof that both `align_corners` conversions are the right way round.
 */
export function identityGrid(
  width: number = CLASSICAL_GRID_WIDTH,
  height: number = CLASSICAL_GRID_HEIGHT,
): CoarseGrid {
  const x = new Float32Array(width * height);
  const y = new Float32Array(width * height);
  for (let row = 0; row < height; row += 1) {
    const gy = height === 1 ? 0 : (row / (height - 1)) * 2 - 1;
    for (let column = 0; column < width; column += 1) {
      const gx = width === 1 ? 0 : (column / (width - 1)) * 2 - 1;
      x[row * width + column] = gx;
      y[row * width + column] = gy;
    }
  }
  return { width, height, x, y };
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/** Where a lattice value is sampled from, written into `out` to avoid garbage. */
export interface MutablePoint {
  x: number;
  y: number;
}

/**
 * The coarse grid, bilinearly interpolated at an arbitrary output fraction.
 *
 * `u`/`v` are the output image's own coordinates in [0,1], `align_corners`:
 * u=0 is the centre of the first output column, u=1 the centre of the last.
 */
export function sampleCoarseGrid(
  grid: CoarseGrid,
  u: number,
  v: number,
  out: MutablePoint = { x: 0, y: 0 },
): MutablePoint {
  const lastColumn = grid.width - 1;
  const lastRow = grid.height - 1;
  const gu = clamp(u, 0, 1) * lastColumn;
  const gv = clamp(v, 0, 1) * lastRow;

  const column = Math.min(lastColumn - 1 < 0 ? 0 : lastColumn - 1, Math.floor(gu));
  const row = Math.min(lastRow - 1 < 0 ? 0 : lastRow - 1, Math.floor(gv));
  const fu = gu - column;
  const fv = gv - row;

  const topLeft = row * grid.width + column;
  const topRight = topLeft + (lastColumn > 0 ? 1 : 0);
  const bottomLeft = topLeft + (lastRow > 0 ? grid.width : 0);
  const bottomRight = bottomLeft + (lastColumn > 0 ? 1 : 0);

  const w00 = (1 - fu) * (1 - fv);
  const w10 = fu * (1 - fv);
  const w01 = (1 - fu) * fv;
  const w11 = fu * fv;

  out.x =
    grid.x[topLeft] * w00 +
    grid.x[topRight] * w10 +
    grid.x[bottomLeft] * w01 +
    grid.x[bottomRight] * w11;
  out.y =
    grid.y[topLeft] * w00 +
    grid.y[topRight] * w10 +
    grid.y[bottomLeft] * w01 +
    grid.y[bottomRight] * w11;
  return out;
}

/**
 * The full composition: output fraction → canonical pixel.
 *
 * `[-1,1] → crop pixel` is the `align_corners=true` inverse of the stretch
 * that produced the model's input, so it uses `crop.width - 1` (the distance
 * between the first and last pixel *centres*), not `crop.width`. The crop's
 * own offset is then a plain translation, because the crop is axis-aligned by
 * construction.
 */
export function composeInto(
  grid: CoarseGrid,
  crop: CropBox,
  u: number,
  v: number,
  out: MutablePoint,
): MutablePoint {
  sampleCoarseGrid(grid, u, v, out);
  out.x = crop.left + ((out.x + 1) * (crop.width - 1)) / 2;
  out.y = crop.top + ((out.y + 1) * (crop.height - 1)) / 2;
  return out;
}

/** {@link composeInto}, allocating — for guards, tests and anything not in a loop. */
export function composeToCanonical(
  grid: CoarseGrid,
  crop: CropBox,
  u: number,
  v: number,
): DewarpPoint {
  return composeInto(grid, crop, u, v, { x: 0, y: 0 });
}

/**
 * Output pixel index → its `align_corners` fraction.
 *
 * A one-pixel-wide output has no span to divide by; it is the centre, so 0.
 */
export function pixelFraction(index: number, size: number): number {
  return size <= 1 ? 0 : index / (size - 1);
}

/** The composed map's first derivatives, in canonical pixels per unit of u/v. */
export interface MapJacobian {
  dxdu: number;
  dydu: number;
  dxdv: number;
  dydv: number;
}

/**
 * The exact derivatives *inside one cell*, at a local position in it.
 *
 * The composed map is bilinear within a cell and only continuous across cell
 * borders, so its derivative is genuinely two-valued at every lattice node:
 * one value per side. A finite difference straddling a border averages the two
 * and can report a healthy map over a cell that folds — which is precisely the
 * failure the Jacobian guard exists to catch. Taking the derivative from the
 * closed form, per cell, is what makes "no fold anywhere" checkable rather than
 * approximately checkable.
 *
 * `column`/`row` are the cell's top-left node; `a`/`b` are inside it, in [0,1].
 * The result is with respect to the *output's* own u/v, so it composes with the
 * flat crop's Jacobian the way the guard's normalisation expects.
 */
export function cellJacobian(
  grid: CoarseGrid,
  crop: CropBox,
  column: number,
  row: number,
  a: number,
  b: number,
): MapJacobian {
  const lastColumn = grid.width - 1;
  const lastRow = grid.height - 1;
  const stride = grid.width;
  const topLeft = row * stride + column;
  const topRight = topLeft + (lastColumn > 0 ? 1 : 0);
  const bottomLeft = topLeft + (lastRow > 0 ? stride : 0);
  const bottomRight = bottomLeft + (lastColumn > 0 ? 1 : 0);

  // Two independent rescales, and mixing them up is a silent transpose: the
  // [-1,1] → pixel scale belongs to the *output* axis (x from the crop's width,
  // y from its height), while the local a/b → global u/v scale is the number of
  // cells along the axis being differentiated.
  const pixelX = (crop.width - 1) / 2;
  const pixelY = (crop.height - 1) / 2;

  const dxda =
    (1 - b) * (grid.x[topRight] - grid.x[topLeft]) +
    b * (grid.x[bottomRight] - grid.x[bottomLeft]);
  const dxdb =
    (1 - a) * (grid.x[bottomLeft] - grid.x[topLeft]) +
    a * (grid.x[bottomRight] - grid.x[topRight]);
  const dyda =
    (1 - b) * (grid.y[topRight] - grid.y[topLeft]) +
    b * (grid.y[bottomRight] - grid.y[bottomLeft]);
  const dydb =
    (1 - a) * (grid.y[bottomLeft] - grid.y[topLeft]) +
    a * (grid.y[bottomRight] - grid.y[topRight]);

  return {
    dxdu: dxda * pixelX * lastColumn,
    dydu: dyda * pixelY * lastColumn,
    dxdv: dxdb * pixelX * lastRow,
    dydv: dydb * pixelY * lastRow,
  };
}
