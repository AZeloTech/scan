"use client";

/**
 * The scan look, on the device.
 *
 * A faithful TypeScript implementation of `normalize_illumination`, the
 * divide-out-the-illumination-field pass. A phone photo of a page carries
 * the room with it: a shadow down one side, a warm lamp on the other, the
 * darker corner where the hand was. Estimating that illumination field with a
 * heavy blur and dividing it out is what makes the result read as a *scan*
 * rather than a photo.
 *
 * The algorithm, step for step with the Python reference:
 *
 *  1. estimate the per-channel illumination field on a 256 px copy, blurred
 *     with σ = long_edge / 8 (never below 3);
 *  2. flatten to the field's own average level, so the correction changes the
 *     *distribution* of light and not the exposure;
 *  3. lift the paper to near-white by anchoring the 95th percentile of the
 *     flattened luma at 245 — the 95th percentile is the background, not the ink;
 *  4. clip the combined per-pixel gain to **2.2×** (and 1/2.2× downward).
 *
 * Step 4 is the whole reason this is an illumination correction and not a
 * threshold: faint print, pencil and the decimal points in a lab table must
 * survive it. Colour is kept, nothing is binarised, nothing is sharpened.
 *
 * The `clean` finish is this pass **plus** {@link deepenInk}, which curves what
 * is left below the paper anchor. The two are separate functions and separate
 * decisions on purpose: one flattens the room's light, the other darkens the
 * ink the flattening exposed, and only the first of them is safe before
 * {@link binarize}.
 *
 * Two deliberate deviations from the Python, neither visible in the output:
 *
 *  * the Gaussian is approximated by three box-blur passes (the standard
 *    equivalence), which keeps the whole pass O(n) on a cheap Android instead
 *    of O(n·σ);
 *  * the field is kept as a small `Float32Array` and sampled bilinearly in the
 *    pixel loop rather than upsampled into a full-resolution buffer — same
 *    arithmetic as `cv2.resize(..., INTER_LINEAR)`, without a second
 *    27 MB allocation on a 3000 px page.
 *
 * The pass runs on the main thread *and* inside the render worker, so it is
 * written against {@link CanvasSurface} rather than `HTMLCanvasElement` and
 * takes the surface factory it needs for the field estimate. That is the whole
 * reason this file is thread-agnostic: two ports of this arithmetic would be
 * two different-looking scans of the same page.
 */

import {
  surfaceContext,
  type CanvasSurface,
  type SurfaceFactory,
} from "@/lib/canvas-surface";

/** Per-pixel gain ceiling. The information-preserving budget — do not raise. */
const MAX_SCAN_GAIN = 2.2;
/** Where the paper's 95th-percentile luma is put. */
const PAPER_WHITE = 245;
/** The field is low-frequency by definition, so it is estimated on a thumbnail. */
const FIELD_EDGE = 256;
/** Luma histogram resolution for the percentile; wide enough that a flattened
 *  value above 255 still lands in its own bin instead of saturating the tail. */
const LUMA_BINS = 1024;

interface Field {
  width: number;
  height: number;
  /** Interleaved RGB, one float per channel per pixel. */
  data: Float32Array;
  /** Per-channel mean of the whole field — the "reference" level. */
  mean: [number, number, number];
}

/**
 * Box radii whose three-pass composition matches a Gaussian of `sigma`
 * (Kovesi's standard construction, as used by every fast-blur implementation).
 */
function boxRadiiForGaussian(sigma: number, passes: number): number[] {
  const idealWidth = Math.sqrt((12 * sigma * sigma) / passes + 1);
  let lower = Math.floor(idealWidth);
  if (lower % 2 === 0) lower -= 1;
  const upper = lower + 2;
  const ideal =
    (12 * sigma * sigma - passes * lower * lower - 4 * passes * lower - 3 * passes) /
    (-4 * lower - 4);
  const split = Math.round(ideal);
  const radii: number[] = [];
  for (let pass = 0; pass < passes; pass += 1) {
    const width = pass < split ? lower : upper;
    radii.push(Math.max(0, (width - 1) / 2));
  }
  return radii;
}

/** One separable box pass over interleaved RGB, with edge clamping. */
function boxBlurPass(
  source: Float32Array,
  target: Float32Array,
  width: number,
  height: number,
  radius: number,
): void {
  if (radius <= 0) {
    target.set(source);
    return;
  }
  const window = radius * 2 + 1;

  // Horizontal.
  for (let y = 0; y < height; y += 1) {
    const row = y * width * 3;
    for (let channel = 0; channel < 3; channel += 1) {
      let sum = source[row + channel] * (radius + 1);
      for (let x = 1; x <= radius; x += 1) {
        sum += source[row + Math.min(x, width - 1) * 3 + channel];
      }
      for (let x = 0; x < width; x += 1) {
        const ahead = Math.min(x + radius, width - 1);
        const behind = Math.max(x - radius - 1, 0);
        target[row + x * 3 + channel] = sum / window;
        sum += source[row + ahead * 3 + channel] - source[row + behind * 3 + channel];
      }
    }
  }

  // Vertical, back into `source` so the caller can ping-pong.
  const stride = width * 3;
  for (let x = 0; x < width; x += 1) {
    const column = x * 3;
    for (let channel = 0; channel < 3; channel += 1) {
      let sum = target[column + channel] * (radius + 1);
      for (let y = 1; y <= radius; y += 1) {
        sum += target[Math.min(y, height - 1) * stride + column + channel];
      }
      for (let y = 0; y < height; y += 1) {
        const ahead = Math.min(y + radius, height - 1);
        const behind = Math.max(y - radius - 1, 0);
        source[y * stride + column + channel] = sum / window;
        sum +=
          target[ahead * stride + column + channel] -
          target[behind * stride + column + channel];
      }
    }
  }
}

/** The illumination field: a 256 px copy of the page, heavily blurred. */
function estimateField(
  canvas: CanvasSurface,
  create: SurfaceFactory<CanvasSurface>,
): Field | null {
  const longEdge = Math.max(canvas.width, canvas.height);
  const scale = Math.min(1, FIELD_EDGE / Math.max(1, longEdge));
  const width = Math.max(1, Math.round(canvas.width * scale));
  const height = Math.max(1, Math.round(canvas.height * scale));

  const small = create(width, height);
  const context = surfaceContext(small, { willReadFrequently: true });
  if (context === null) return null;
  context.drawImage(canvas, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;

  const data = new Float32Array(width * height * 3);
  for (let index = 0, source = 0; index < data.length; index += 3, source += 4) {
    data[index] = pixels[source];
    data[index + 1] = pixels[source + 1];
    data[index + 2] = pixels[source + 2];
  }

  const sigma = Math.max(3, Math.max(width, height) / 8);
  const scratch = new Float32Array(data.length);
  for (const radius of boxRadiiForGaussian(sigma, 3)) {
    boxBlurPass(data, scratch, width, height, radius);
  }

  let sumRed = 0;
  let sumGreen = 0;
  let sumBlue = 0;
  for (let index = 0; index < data.length; index += 3) {
    // The floor mirrors NumPy's `np.maximum(field, 1.0)`: a field value of zero
    // would otherwise divide into an infinite gain.
    data[index] = Math.max(1, data[index]);
    data[index + 1] = Math.max(1, data[index + 1]);
    data[index + 2] = Math.max(1, data[index + 2]);
    sumRed += data[index];
    sumGreen += data[index + 1];
    sumBlue += data[index + 2];
  }
  const count = width * height;
  return {
    width,
    height,
    data,
    mean: [sumRed / count, sumGreen / count, sumBlue / count],
  };
}

/** Bilinear read of the small field at a full-resolution pixel centre. */
function sampleField(
  field: Field,
  sourceX: number,
  sourceY: number,
  out: Float32Array,
): void {
  const x0 = Math.max(0, Math.min(field.width - 1, Math.floor(sourceX)));
  const y0 = Math.max(0, Math.min(field.height - 1, Math.floor(sourceY)));
  const x1 = Math.min(field.width - 1, x0 + 1);
  const y1 = Math.min(field.height - 1, y0 + 1);
  const fx = Math.max(0, Math.min(1, sourceX - x0));
  const fy = Math.max(0, Math.min(1, sourceY - y0));

  const topLeft = (y0 * field.width + x0) * 3;
  const topRight = (y0 * field.width + x1) * 3;
  const bottomLeft = (y1 * field.width + x0) * 3;
  const bottomRight = (y1 * field.width + x1) * 3;

  for (let channel = 0; channel < 3; channel += 1) {
    const top =
      field.data[topLeft + channel] +
      (field.data[topRight + channel] - field.data[topLeft + channel]) * fx;
    const bottom =
      field.data[bottomLeft + channel] +
      (field.data[bottomRight + channel] - field.data[bottomLeft + channel]) * fx;
    out[channel] = Math.max(1, top + (bottom - top) * fy);
  }
}

/**
 * Apply the scan look to `canvas`, **in place**, and return it.
 *
 * Never throws and never refuses: a canvas without a 2-D context (or one the
 * browser will not let us read back) is returned untouched, because an
 * un-normalised page is still a perfectly usable page and losing the capture
 * would not be.
 */
export function normalizeIllumination<T extends CanvasSurface>(
  canvas: T,
  create: SurfaceFactory<CanvasSurface>,
): T {
  const width = canvas.width;
  const height = canvas.height;
  if (width === 0 || height === 0) return canvas;

  const context = surfaceContext(canvas, { willReadFrequently: true });
  if (context === null) return canvas;

  let image: ImageData;
  try {
    image = context.getImageData(0, 0, width, height);
  } catch {
    // A tainted canvas — impossible on our own capture path, but never worth a
    // thrown exception in the middle of the user's scan.
    return canvas;
  }

  const field = estimateField(canvas, create);
  if (field === null) return canvas;

  const pixels = image.data;
  const [referenceRed, referenceGreen, referenceBlue] = field.mean;
  const scaleX = field.width / width;
  const scaleY = field.height / height;
  const sample = new Float32Array(3);

  // Pass 1 — the flattened luma histogram, for the 95th-percentile anchor.
  const histogram = new Uint32Array(LUMA_BINS);
  for (let y = 0; y < height; y += 1) {
    const sourceY = (y + 0.5) * scaleY - 0.5;
    for (let x = 0; x < width; x += 1) {
      sampleField(field, (x + 0.5) * scaleX - 0.5, sourceY, sample);
      const offset = (y * width + x) * 4;
      const luma =
        ((pixels[offset] * referenceRed) / sample[0] +
          (pixels[offset + 1] * referenceGreen) / sample[1] +
          (pixels[offset + 2] * referenceBlue) / sample[2]) /
        3;
      histogram[Math.max(0, Math.min(LUMA_BINS - 1, Math.round(luma)))] += 1;
    }
  }

  const target = Math.floor(width * height * 0.95);
  let seen = 0;
  let anchor = LUMA_BINS - 1;
  for (let bin = 0; bin < LUMA_BINS; bin += 1) {
    seen += histogram[bin];
    if (seen >= target) {
      anchor = bin;
      break;
    }
  }
  const lift = anchor > 1 ? PAPER_WHITE / anchor : 1;

  // Pass 2 — the correction itself, gain-capped per pixel and per channel.
  const minGain = 1 / MAX_SCAN_GAIN;
  for (let y = 0; y < height; y += 1) {
    const sourceY = (y + 0.5) * scaleY - 0.5;
    for (let x = 0; x < width; x += 1) {
      sampleField(field, (x + 0.5) * scaleX - 0.5, sourceY, sample);
      const offset = (y * width + x) * 4;
      const gainRed = Math.min(
        MAX_SCAN_GAIN,
        Math.max(minGain, (referenceRed / sample[0]) * lift),
      );
      const gainGreen = Math.min(
        MAX_SCAN_GAIN,
        Math.max(minGain, (referenceGreen / sample[1]) * lift),
      );
      const gainBlue = Math.min(
        MAX_SCAN_GAIN,
        Math.max(minGain, (referenceBlue / sample[2]) * lift),
      );
      // Uint8ClampedArray does the 0–255 clipping for us on assignment.
      pixels[offset] = pixels[offset] * gainRed;
      pixels[offset + 1] = pixels[offset + 1] * gainGreen;
      pixels[offset + 2] = pixels[offset + 2] * gainBlue;
    }
  }

  context.putImageData(image, 0, 0);
  return canvas;
}

/**
 * Luma at and above which nothing is ever darkened.
 *
 * This is a guard on the pass that runs immediately before it, not a taste
 * value. {@link normalizeIllumination} has just anchored the paper's 95th
 * percentile at {@link PAPER_WHITE} (245) — everything from here up *is* that
 * paper. Curving it would put back the same grey the illumination correction
 * was run to remove, which is the one way an ink pass can undo the scan look
 * instead of finishing it.
 */
const PAPER_ANCHOR = 215;

/**
 * Where the curve starts fading out toward {@link PAPER_ANCHOR}.
 *
 * Below this the gamma acts at full strength; between here and the anchor a
 * smoothstep blends it back to identity, so there is no visible tone edge along
 * the boundary where letterforms meet the page.
 */
const INK_BLEND_START = 170;

/**
 * The curve's strength — a deliberate choice, from a side-by-side of
 * `clarear`, `clarear + tinta` (γ 1.30) and `clarear + tinta forte` (γ 1.65) on
 * his own captures. 1.65 is the strong one, and it is the shipped `clean`.
 */
const INK_GAMMA = 1.65;

/** LUT resolution: one entry per 8-bit luma, so the pixel loop never curves. */
const INK_LEVELS = 256;

/**
 * Deepen the ink of an already-normalised canvas, **in place**, and return it.
 *
 * Three properties are the contract, and each is load-bearing:
 *
 *  * **It only ever darkens.** The per-pixel ratio is clamped to ≤ 1, so this
 *    can never lift a tone the illumination pass placed — it is a finishing
 *    curve on the ink, not a second exposure decision.
 *  * **It preserves colour.** The curve is evaluated on Rec. 601 luma (the same
 *    weighting {@link binarize} and the capture gate use) and the three channels
 *    are scaled by that one ratio, so a blue pen stays blue and a red stamp
 *    stays red. A per-channel gamma would drift the hue of everything that is
 *    not already neutral.
 *  * **It never throws and never refuses.** A canvas without a 2-D context, or
 *    one that cannot be read back, is returned untouched — a page with pale ink
 *    is still a perfectly usable page, and losing the capture would not be.
 *
 * Only ever run *after* {@link normalizeIllumination}: {@link PAPER_ANCHOR} is
 * calibrated against the 245 that pass leaves the paper at, and on a raw photo
 * the same curve would deepen the shadowed corner rather than the letters.
 *
 * `gamma` is a parameter rather than a constant only so that
 * side-by-side can be re-run without editing the shipped pass; every caller in
 * the app takes the default.
 */
export function deepenInk<T extends CanvasSurface>(
  canvas: T,
  gamma: number = INK_GAMMA,
): T {
  const width = canvas.width;
  const height = canvas.height;
  if (width === 0 || height === 0) return canvas;

  const context = surfaceContext(canvas, { willReadFrequently: true });
  if (context === null) return canvas;

  // One 256-entry ratio table; the pixel loop is then three multiplies.
  const ratio = new Float32Array(INK_LEVELS);
  for (let luma = 0; luma < INK_LEVELS; luma += 1) {
    if (luma >= PAPER_ANCHOR) {
      ratio[luma] = 1;
      continue;
    }
    const curved = PAPER_ANCHOR * Math.pow(luma / PAPER_ANCHOR, gamma);
    const u = Math.max(
      0,
      Math.min(1, (luma - INK_BLEND_START) / (PAPER_ANCHOR - INK_BLEND_START)),
    );
    // 1 deep in the ink, 0 at the anchor.
    const fade = 1 - u * u * (3 - 2 * u);
    const target = luma + (curved - luma) * fade;
    ratio[luma] = Math.min(1, target / Math.max(1, luma));
  }

  try {
    const image = context.getImageData(0, 0, width, height);
    const pixels = image.data;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const luma =
        pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114;
      const scale = ratio[luma < 0 ? 0 : luma > 255 ? 255 : luma | 0];
      if (scale === 1) continue;
      pixels[offset] = pixels[offset] * scale;
      pixels[offset + 1] = pixels[offset + 1] * scale;
      pixels[offset + 2] = pixels[offset + 2] * scale;
    }
    context.putImageData(image, 0, 0);
  } catch {
    // A tainted or unreadable canvas — the page goes on without the curve.
    return canvas;
  }
  return canvas;
}

/**
 * How far *above* Otsu's split the ramp is centred, as a fraction of the gap
 * between that split and pure white.
 *
 * Biased toward the ink on purpose. Otsu balances the two clusters, but the
 * clusters are not equally precious: losing a pencil annotation or the decimal
 * point in a lab value is a real loss, while a little extra grey around the
 * letterforms costs nothing anyone can see. Raising the midpoint pushes faint
 * strokes back onto the ink side of the ramp — the same information-preserving
 * posture as {@link MAX_SCAN_GAIN}.
 */
const BW_INK_BIAS = 0.12;

/**
 * Half the width of the ramp either side of the threshold, in luma units.
 *
 * A hard threshold is the wrong tool for a JPEG: a one-pixel step between 0 and
 * 255 is the exact edge DCT ringing loves, and the artefacts it produces are
 * both ugly and bad for OCR. Ramping across a narrow band keeps the letterforms
 * anti-aliased, so the result compresses cleanly and still reads as black ink
 * on white paper.
 */
const BW_RAMP = 26;

/**
 * The "preto e branco" finish, applied **in place** to an already-normalised
 * canvas, and returned.
 *
 * Only ever run after {@link normalizeIllumination}: the whole reason a global
 * threshold is safe here is that the illumination correction has already
 * removed the gradient that would otherwise make one corner of the page solid
 * black. Running it on a raw photo would do exactly that.
 *
 * And only ever after {@link normalizeIllumination} **alone**: `bw` must not be
 * preceded by {@link deepenInk}, which the `clean` finish now runs. Otsu's split
 * is computed from the luma histogram it is handed, so darkening the ink first
 * moves the two clusters apart and moves the threshold with them — a different
 * cut on the same photograph, for no gain a binarised page could show.
 *
 * Never throws and never refuses — a canvas it cannot read back is returned
 * untouched, because a colour page is still a perfectly usable page.
 */
export function binarize<T extends CanvasSurface>(canvas: T): T {
  const width = canvas.width;
  const height = canvas.height;
  if (width === 0 || height === 0) return canvas;

  const context = surfaceContext(canvas, { willReadFrequently: true });
  if (context === null) return canvas;

  // The whole body is guarded, not just the read: a 3000 px page needs a 9 MB
  // luma buffer on top of the ImageData, and an allocation failure here must
  // degrade to "the page in colour" exactly like a tainted canvas does — not
  // turn a page the user photographed into a failed one.
  try {
  const image = context.getImageData(0, 0, width, height);

  const pixels = image.data;
  const histogram = new Uint32Array(256);
  const luma = new Uint8ClampedArray(width * height);
  for (let index = 0, offset = 0; index < luma.length; index += 1, offset += 4) {
    // Rec. 601, the same weighting the gate measures text height with.
    const value =
      pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114;
    luma[index] = value;
    histogram[luma[index]] += 1;
  }

  const threshold = otsuThreshold(histogram, luma.length);
  const midpoint = threshold + (255 - threshold) * BW_INK_BIAS;
  const low = midpoint - BW_RAMP;
  const span = Math.max(1, BW_RAMP * 2);

  for (let index = 0, offset = 0; index < luma.length; index += 1, offset += 4) {
    const ramped = Math.max(0, Math.min(1, (luma[index] - low) / span));
    // smoothstep: no visible corner where the ramp meets flat black or white.
    const level = 255 * ramped * ramped * (3 - 2 * ramped);
    pixels[offset] = level;
    pixels[offset + 1] = level;
    pixels[offset + 2] = level;
  }

  context.putImageData(image, 0, 0);
  } catch {
    return canvas;
  }
  return canvas;
}

/**
 * Otsu's between-class variance maximiser, over a 256-bin luma histogram.
 *
 * Returns the luma at which ink and paper separate best. `total` is the pixel
 * count the histogram was built from; a degenerate image (one single level)
 * returns that level, which the ramp then handles without a special case.
 */
function otsuThreshold(histogram: Uint32Array, total: number): number {
  let sum = 0;
  for (let level = 0; level < 256; level += 1) sum += level * histogram[level];

  let sumBackground = 0;
  let weightBackground = 0;
  let best = 0;
  let bestVariance = -1;

  for (let level = 0; level < 256; level += 1) {
    weightBackground += histogram[level];
    if (weightBackground === 0) continue;
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;
    sumBackground += level * histogram[level];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const delta = meanBackground - meanForeground;
    const variance = weightBackground * weightForeground * delta * delta;
    if (variance > bestVariance) {
      bestVariance = variance;
      best = level;
    }
  }
  return best;
}
