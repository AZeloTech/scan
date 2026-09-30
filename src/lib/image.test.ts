import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CANVAS_LIMIT,
  fitCanvasLimit,
  WEBKIT_MOBILE_CANVAS_LIMIT,
} from "./image.ts";

test("a camera frame or photo keeps every pixel below the browser's canvas limit", () => {
  // The S25 Ultra stream, a 12 MP still's preview crop, and a 50 MP one.
  for (const [w, h] of [
    [2160, 3840],
    [2250, 4000],
    [4590, 8160],
    [6120, 8160],
  ]) {
    assert.deepEqual(fitCanvasLimit(w, h, DEFAULT_CANVAS_LIMIT), { width: w, height: h, capped: false });
  }
  // iOS: a 12 MP camera frame is under WebKit's 16.7 MP; the stream's 4K too.
  assert.deepEqual(fitCanvasLimit(3024, 4032, WEBKIT_MOBILE_CANVAS_LIMIT), {
    width: 3024,
    height: 4032,
    capped: false,
  });
  assert.deepEqual(fitCanvasLimit(2160, 3840, WEBKIT_MOBILE_CANVAS_LIMIT), {
    width: 2160,
    height: 3840,
    capped: false,
  });
});

test("only a source the browser cannot draw is fitted, same shape, and says so", () => {
  // A 48 MP library photo on iOS WebKit: 16,777,216 px of area at most.
  const fitted = fitCanvasLimit(6048, 8064, WEBKIT_MOBILE_CANVAS_LIMIT);
  assert.equal(fitted.capped, true);
  assert.ok(fitted.width * fitted.height <= WEBKIT_MOBILE_CANVAS_LIMIT.maxArea);
  assert.ok(Math.abs(fitted.width / fitted.height - 6048 / 8064) < 0.001);
  // It gives up as little as it can: within a pixel of the limit on each side.
  assert.ok((fitted.width + 1) * (fitted.height + 1) > WEBKIT_MOBILE_CANVAS_LIMIT.maxArea);
  // A side over the per-side limit.
  const long = fitCanvasLimit(40_000, 1000, DEFAULT_CANVAS_LIMIT);
  assert.equal(long.capped, true);
  assert.ok(long.width <= DEFAULT_CANVAS_LIMIT.maxSide);
});

test("the documented limits", () => {
  assert.equal(WEBKIT_MOBILE_CANVAS_LIMIT.maxArea, 4096 * 4096);
  assert.equal(DEFAULT_CANVAS_LIMIT.maxArea, 16_384 * 16_384);
  assert.equal(DEFAULT_CANVAS_LIMIT.maxSide, 32_767);
});
