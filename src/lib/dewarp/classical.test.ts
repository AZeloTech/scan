/**
 * The classical engine's own pieces: the confidence-layer fallback mapping
 * and the TS-side area-average downsample — both load-bearing enough to deserve their own tests independent of the
 * fake-worker plumbing `engine.test.ts` exercises.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  areaAverageDownsample,
  classicalFallbackReason,
  classicalOptsJson,
  CLASSICAL_OPTS_JSON,
  cropToClassicalInput,
  normalizeQuadToCrop,
  parseClassicalStatus,
  WASM_INPUT_MAX_SIDE,
  type ClassicalStatus,
} from "./classical.ts";
import type { CropBox, DewarpQuad, RgbaImage } from "./types.ts";

function status(overrides: Partial<ClassicalStatus> = {}): ClassicalStatus {
  return {
    converged: true,
    kept_text_lines: 16,
    total_text_lines: 17,
    kept_segments: 0,
    total_candidates: 0,
    uses_confidence_filter: true,
    bound_saturation: { a: [false, false, true, true], rvec: [false, false, false], log_f: false },
    output_aspect: 0.75,
    input_aspect: 0.75,
    boundary_used: false,
    residual_text_straightness_p90: 1.8,
    residual_boundary_mean_px: null,
    window_clip: { left: 0, right: 0, top: 0, bottom: 0, area_frac: 1 },
    window_clips_text: false,
    quad_corner_residual: null,
    elapsed_ms: 3200,
    ...overrides,
  };
}

test("a healthy status trips nothing", () => {
  assert.equal(classicalFallbackReason(status()), null);
});

test("non-convergence is checked first, ahead of every other signal", () => {
  assert.equal(
    classicalFallbackReason(status({ converged: false, kept_text_lines: 0 })),
    "classical-non-convergent",
  );
});

test("fewer than two kept lines is the sparse-feature reason", () => {
  assert.equal(
    classicalFallbackReason(status({ kept_text_lines: 1 })),
    "classical-insufficient-features",
  );
  assert.equal(classicalFallbackReason(status({ kept_text_lines: 2 })), null);
});

test("the degenerate-bounds signature needs all four `a` AND some `rvec`", () => {
  // The engine's own "normal path" — a3/a4 saturated alone — must not trip.
  assert.equal(classicalFallbackReason(status()), null);
  assert.equal(
    classicalFallbackReason(
      status({
        bound_saturation: { a: [true, true, true, true], rvec: [true, false, false], log_f: false },
      }),
    ),
    "classical-degenerate-bounds",
  );
  // All-a without any rvec is the documented normal path — must NOT trip.
  assert.equal(
    classicalFallbackReason(
      status({
        bound_saturation: { a: [true, true, true, true], rvec: [false, false, false], log_f: false },
      }),
    ),
    null,
  );
});

test("output/input aspect outside [0.4, 2.5] trips the last rung", () => {
  assert.equal(
    classicalFallbackReason(status({ output_aspect: 3.0, input_aspect: 1.0 })),
    "classical-aspect-outlier",
  );
  assert.equal(
    classicalFallbackReason(status({ output_aspect: 0.3, input_aspect: 1.0 })),
    "classical-aspect-outlier",
  );
  assert.equal(
    classicalFallbackReason(status({ output_aspect: 0.85, input_aspect: 1.0 })),
    null,
  );
});

test("a zero input_aspect cannot divide into a false negative", () => {
  assert.equal(
    classicalFallbackReason(status({ input_aspect: 0, output_aspect: 1 })),
    "classical-aspect-outlier",
  );
});

test("malformed status JSON is null, not a throw", () => {
  assert.equal(parseClassicalStatus("not json"), null);
  assert.equal(parseClassicalStatus("42"), null);
  assert.deepEqual(parseClassicalStatus(JSON.stringify(status())), status());
});

/** A deterministic RGB field with no repeated rows, so a shift is visible. */
function syntheticImage(width: number, height: number): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = (x * 37 + y * 17) % 256;
      data[offset + 1] = (x * 11 + y * 53) % 256;
      data[offset + 2] = (x * 29 + y * 3) % 256;
      data[offset + 3] = 255;
    }
  }
  return { width, height, data };
}

test("area-average downsample: a uniform block halves to the same colour", () => {
  const image: RgbaImage = { width: 4, height: 4, data: new Uint8ClampedArray(4 * 4 * 4) };
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = 200;
    image.data[i + 1] = 100;
    image.data[i + 2] = 50;
    image.data[i + 3] = 255;
  }
  const half = areaAverageDownsample(image, 2, 2);
  assert.equal(half.width, 2);
  assert.equal(half.height, 2);
  for (let i = 0; i < half.data.length; i += 4) {
    assert.equal(half.data[i], 200);
    assert.equal(half.data[i + 1], 100);
    assert.equal(half.data[i + 2], 50);
    assert.equal(half.data[i + 3], 255);
  }
});

test("area-average downsample: every source pixel is weighed, not sampled", () => {
  // Two columns, black then white. A single-tap resize (nearest or a naive
  // bilinear pass landing exactly on a source pixel) could read pure black or
  // pure white; the true area average of the whole row must land at ~127.5 —
  // this is what distinguishes INTER_AREA from "resize"; the naive form is
  // not an acceptable substitute here.
  const width = 8;
  const height = 2;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = x < width / 2 ? 0 : 255;
      const offset = (y * width + x) * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  const shrunk = areaAverageDownsample({ width, height, data }, 1, 1);
  assert.ok(
    Math.abs(shrunk.data[0] - 127.5) < 1,
    `expected ~127.5, got ${shrunk.data[0]}`,
  );
});

test("area-average downsample is a no-op at the identity size", () => {
  const image = syntheticImage(6, 5);
  assert.equal(areaAverageDownsample(image, 6, 5), image);
});

test("cropToClassicalInput extracts without resampling under the ceiling", () => {
  const source = syntheticImage(200, 150);
  const crop: CropBox = { left: 10, top: 5, width: 40, height: 30 };
  const input = cropToClassicalInput(source, crop, WASM_INPUT_MAX_SIDE);
  assert.equal(input.width, 40);
  assert.equal(input.height, 30);
  // The top-left texel of the extracted buffer must be exactly the source's
  // pixel at (10,5) — a plain sub-copy, not a resample, since the crop sits
  // under the ceiling.
  const srcOffset = ((crop.top + 0) * source.width + crop.left) * 4;
  assert.equal(input.data[0], source.data[srcOffset]);
  assert.equal(input.data[1], source.data[srcOffset + 1]);
  assert.equal(input.data[2], source.data[srcOffset + 2]);
});

test("cropToClassicalInput downsamples a crop over the ceiling, preserving aspect", () => {
  const source = syntheticImage(4000, 2000);
  const crop: CropBox = { left: 0, top: 0, width: 3200, height: 1600 };
  const input = cropToClassicalInput(source, crop, 1600);
  assert.equal(Math.max(input.width, input.height), 1600);
  assert.equal(input.width, 1600);
  assert.equal(input.height, 800, "2:1 aspect preserved");
});

test("cropToClassicalInput never upscales a crop already under the ceiling", () => {
  const source = syntheticImage(300, 200);
  const crop: CropBox = { left: 0, top: 0, width: 300, height: 200 };
  const input = cropToClassicalInput(source, crop, 1600);
  assert.equal(input.width, 300);
  assert.equal(input.height, 200);
});

// Quad-aligned export framing.

test("normalizeQuadToCrop: a quad flush with the crop's own bounds lands exactly on [0,1]", () => {
  const crop: CropBox = { left: 100, top: 50, width: 401, height: 201 }; // spans 400/200
  const quad: DewarpQuad = {
    topLeft: { x: 100, y: 50 },
    topRight: { x: 500, y: 50 },
    bottomRight: { x: 500, y: 250 },
    bottomLeft: { x: 100, y: 250 },
  };
  const normalized = normalizeQuadToCrop(quad, crop);
  assert.deepEqual(normalized, {
    topLeft: [0, 0],
    topRight: [1, 0],
    bottomRight: [1, 1],
    bottomLeft: [0, 1],
  });
});

test("normalizeQuadToCrop: an interior quad reads back as the crop-relative fraction", () => {
  const crop: CropBox = { left: 0, top: 0, width: 101, height: 51 }; // spans 100/50
  const quad: DewarpQuad = {
    topLeft: { x: 10, y: 5 },
    topRight: { x: 90, y: 10 },
    bottomRight: { x: 80, y: 45 },
    bottomLeft: { x: 20, y: 40 },
  };
  const normalized = normalizeQuadToCrop(quad, crop);
  assert.deepEqual(normalized, {
    topLeft: [0.1, 0.1],
    topRight: [0.9, 0.2],
    bottomRight: [0.8, 0.9],
    bottomLeft: [0.2, 0.8],
  });
});

test("classicalOptsJson: no quad reproduces the fixed constant byte-for-byte", () => {
  assert.equal(classicalOptsJson(), CLASSICAL_OPTS_JSON);
  assert.equal(classicalOptsJson(undefined), CLASSICAL_OPTS_JSON);
});

test("classicalOptsJson: a quad is carried as [[x,y],...] clockwise from the top-left, base fields unchanged", () => {
  const quad = normalizeQuadToCrop(
    {
      topLeft: { x: 0, y: 0 },
      topRight: { x: 10, y: 0 },
      bottomRight: { x: 10, y: 10 },
      bottomLeft: { x: 0, y: 10 },
    },
    { left: 0, top: 0, width: 11, height: 11 },
  );
  const parsed = JSON.parse(classicalOptsJson(quad)) as {
    preset: string;
    use_line_term: boolean;
    quad: [number, number][];
  };
  assert.equal(parsed.preset, "default");
  assert.equal(parsed.use_line_term, true);
  assert.deepEqual(parsed.quad, [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ]);
});
