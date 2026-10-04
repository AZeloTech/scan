import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPTURE_GRACE_MS,
  LIVE_BUFFER_MAX_AGE_AT_TAP_MS,
  liveQuadFreshAtTap,
  liveQuadSurvives,
  nextFailureCount,
  noteStillFailure,
  pickPhotoSize,
  quadTransfers,
  readPhotoSizeRange,
  resetStillCapturePolicy,
  resolveCaptureCorners,
  STILL_CAPTURE_BUDGET_MS,
  STILL_FAILURE_LIMIT,
  stillAttemptsAllowed,
  stillCaptureFailures,
  stillCropFor,
  takeStillPhoto,
} from "./still-capture.ts";

test("the budget is short enough to stay under the shutter's feedback", () => {
  assert.ok(STILL_CAPTURE_BUDGET_MS > 0);
  assert.ok(STILL_CAPTURE_BUDGET_MS <= 2000);
});

test("two failures end the still path for the session", () => {
  assert.equal(STILL_FAILURE_LIMIT, 2);
  assert.equal(stillAttemptsAllowed(0, false), true);
  assert.equal(stillAttemptsAllowed(1, false), true);
  assert.equal(stillAttemptsAllowed(2, false), false);
  assert.equal(stillAttemptsAllowed(9, false), false);
});

test("a driver that has not answered the last shutter is not asked again", () => {
  // The budget only bounds the wait; the still pipeline is still busy, and a
  // second full-resolution photo on top of it is what the preview frame is for.
  assert.equal(stillAttemptsAllowed(0, true), false);
  assert.equal(stillAttemptsAllowed(1, true), false);
});

test("failures accumulate and are never forgiven", () => {
  let failures = 0;
  failures = nextFailureCount(failures);
  assert.equal(stillAttemptsAllowed(failures, false), true);
  failures = nextFailureCount(failures);
  assert.equal(stillAttemptsAllowed(failures, false), false);
});

test("a photo that cannot become a capture canvas is a strike like any other", () => {
  resetStillCapturePolicy();
  noteStillFailure();
  assert.equal(stillCaptureFailures(), 1);
  noteStillFailure();
  assert.equal(stillCaptureFailures(), STILL_FAILURE_LIMIT);
  assert.equal(stillAttemptsAllowed(stillCaptureFailures(), false), false);
  resetStillCapturePolicy();
  assert.equal(stillCaptureFailures(), 0);
});

test("buffered corners survive a flicker plus a whole still attempt", () => {
  assert.equal(liveQuadSurvives(0), true);
  assert.equal(liveQuadSurvives(CAPTURE_GRACE_MS - 1), true);
  assert.equal(liveQuadSurvives(CAPTURE_GRACE_MS), true);
  assert.equal(liveQuadSurvives(CAPTURE_GRACE_MS + 1), false);
  // The window's whole reason for existing: a shutter that burned its entire
  // budget must not, on its own, cost the user the corners they were shown.
  assert.equal(liveQuadSurvives(STILL_CAPTURE_BUDGET_MS), true);
  assert.ok(CAPTURE_GRACE_MS > STILL_CAPTURE_BUDGET_MS);
  // A clock that ran backwards is not evidence of freshness.
  assert.equal(liveQuadSurvives(-1), false);
});

test("a buffer must have been fresh at the tap, however fast the shutter", () => {
  assert.equal(liveQuadFreshAtTap(0), true);
  assert.equal(liveQuadFreshAtTap(LIVE_BUFFER_MAX_AGE_AT_TAP_MS), true);
  assert.equal(liveQuadFreshAtTap(LIVE_BUFFER_MAX_AGE_AT_TAP_MS + 1), false);
  // A clock that ran backwards is not evidence of freshness.
  assert.equal(liveQuadFreshAtTap(-1), false);
  // The at-tap bound is strictly tighter than the whole-journey grace window —
  // it is the pre-shutter half of it, not a replacement.
  assert.ok(LIVE_BUFFER_MAX_AGE_AT_TAP_MS < CAPTURE_GRACE_MS);
});

test("normalized corners only cross onto a frame of the same shape", () => {
  assert.equal(quadTransfers(4 / 3, 4 / 3), true);
  // A 16:9 still against a 4:3 preview is another field of view.
  assert.equal(quadTransfers(4 / 3, 16 / 9), false);
  // 1.5 % of drift is rounding in the driver's reported size; 2.5 % is not.
  assert.equal(quadTransfers(1, 1.015), true);
  assert.equal(quadTransfers(1, 0.985), true);
  assert.equal(quadTransfers(1, 1.025), false);
  assert.equal(quadTransfers(1, 0.975), false);
  // A frame with no measurable size answers nothing, so nothing transfers.
  assert.equal(quadTransfers(0, 0), false);
  assert.equal(quadTransfers(4 / 3, 0), false);
  assert.equal(quadTransfers(Number.NaN, 4 / 3), false);
  assert.equal(quadTransfers(4 / 3, Number.NaN), false);
  assert.equal(quadTransfers(Number.POSITIVE_INFINITY, 4 / 3), false);
  assert.equal(quadTransfers(4 / 3, Number.POSITIVE_INFINITY), false);
  assert.equal(quadTransfers(-4 / 3, -4 / 3), false);
});

test("a photo that came back turned a quarter never transfers from any phone preview shape", () => {
  // Review finding 6: the still is decoded with its EXIF orientation applied
  // (`createImageBitmap(…, { imageOrientation: "from-image" })`), and a photo
  // whose pixels still came back turned has the other orientation's shape —
  // discarded for the preview frame before any corner is carried or checked.
  for (const [w, h] of [
    [9, 16],
    [3, 4],
    [16, 9],
    [4, 3],
    [9, 19.5],
  ]) {
    assert.equal(quadTransfers(w / h, h / w), false, `${w}:${h}`);
    assert.equal(quadTransfers(w / h, w / h), true, `${w}:${h}`);
  }
});

test("measuring this frame outranks remembering another one", () => {
  const live = "live";
  const detected = "detected";
  const fallback = "fallback";
  assert.equal(resolveCaptureCorners(live, detected, fallback), live);
  assert.equal(resolveCaptureCorners(live, null, fallback), live);
  assert.equal(resolveCaptureCorners(null, detected, fallback), detected);
  // The buffer is the rescue, never the shortcut.
  assert.equal(resolveCaptureCorners(null, null, fallback), fallback);
  assert.equal(resolveCaptureCorners(null, null, null), null);
});

test("no track means no attempt and no failure charged", async () => {
  resetStillCapturePolicy();
  const outcome = await takeStillPhoto(null);
  assert.equal(outcome.bitmap, null);
  assert.equal(outcome.reason, "no-track");
  assert.equal(stillCaptureFailures(), 0);
});

test("capabilities are read defensively", () => {
  assert.equal(readPhotoSizeRange(undefined, "imageWidth"), null);
  assert.equal(readPhotoSizeRange({}, "imageWidth"), null);
  assert.equal(readPhotoSizeRange({ imageWidth: 4000 }, "imageWidth"), null);
  assert.equal(
    readPhotoSizeRange({ imageWidth: { min: 0, max: "4000" } }, "imageWidth"),
    null,
  );
  // max below min, or no max at all, is a driver we do not argue with.
  assert.equal(
    readPhotoSizeRange({ imageWidth: { min: 100, max: 10 } }, "imageWidth"),
    null,
  );
  assert.deepEqual(
    readPhotoSizeRange({ imageWidth: { min: 96, max: 4000, step: 8 } }, "imageWidth"),
    { min: 96, max: 4000, step: 8 },
  );
  // A missing or zero step means continuous, not "steps of zero".
  assert.deepEqual(readPhotoSizeRange({ imageWidth: { min: 0, max: 4000 } }, "imageWidth"), {
    min: 0,
    max: 4000,
    step: 0,
  });
  assert.deepEqual(
    readPhotoSizeRange({ imageWidth: { min: 0, max: 4000, step: 0 } }, "imageWidth"),
    { min: 0, max: 4000, step: 0 },
  );
});

test("the camera is asked for every pixel it has: the range maxima", () => {
  // The S25 Ultra field case: 4000×3000 sensor. The old request (3000×1688,
  // the preview's shape at a 3000 px cap) was answered by Chrome's
  // closest-size match with a 3648×1704 photo of another shape.
  assert.deepEqual(
    pickPhotoSize({ min: 0, max: 4000, step: 0 }, { min: 0, max: 3000, step: 0 }),
    { imageWidth: 4000, imageHeight: 3000 },
  );
  // 50 MP sensors are asked for 50 MP.
  assert.deepEqual(
    pickPhotoSize({ min: 640, max: 8160, step: 1 }, { min: 480, max: 6120, step: 1 }),
    { imageWidth: 8160, imageHeight: 6120 },
  );
  // Portrait-reporting drivers too.
  assert.deepEqual(
    pickPhotoSize({ min: 0, max: 3000, step: 0 }, { min: 0, max: 4000, step: 0 }),
    { imageWidth: 3000, imageHeight: 4000 },
  );
});

test("the maxima snap onto the driver's step grid, walked from min", () => {
  assert.deepEqual(
    pickPhotoSize({ min: 0, max: 4000, step: 16 }, { min: 0, max: 3000, step: 16 }),
    { imageWidth: 4000, imageHeight: 2992 },
  );
  assert.deepEqual(
    pickPhotoSize({ min: 5, max: 4000, step: 10 }, { min: 5, max: 4000, step: 10 }),
    { imageWidth: 3995, imageHeight: 3995 },
  );
});

test("unusable capabilities mean no settings rather than a bad guess", () => {
  assert.equal(pickPhotoSize(null, { min: 0, max: 3000, step: 0 }), null);
  assert.equal(pickPhotoSize({ min: 0, max: 4000, step: 0 }, null), null);
});

const S25_REQUEST = { imageWidth: 4000, imageHeight: 3000 };
const PORTRAIT_16_9 = 2160 / 3840;

test("a sensor-native still is cut to the preview's field of view without a resample", () => {
  // 4000×3000 sensor, portrait 9:16 stream: the upright still is 3000×4000;
  // the preview is its centre 2250×4000.
  const fit = stillCropFor({ width: 3000, height: 4000 }, S25_REQUEST, PORTRAIT_16_9);
  assert.ok("crop" in fit);
  assert.equal(fit.basis, "sensor-crop");
  assert.deepEqual(fit.crop, { x: 375, y: 0, width: 2250, height: 4000 });
  // The kept region has the preview's shape and every pixel of the still's long edge.
  assert.ok(quadTransfers(PORTRAIT_16_9, fit.crop.width / fit.crop.height));
  // Landscape preview, landscape still: the short edge (height) gives way.
  const landscape = stillCropFor({ width: 4000, height: 3000 }, S25_REQUEST, 3840 / 2160);
  assert.ok("crop" in landscape);
  assert.deepEqual(landscape.crop, { x: 0, y: 375, width: 4000, height: 2250 });
  // 50 MP: 6120×8160 upright → 4590×8160.
  const big = stillCropFor({ width: 6120, height: 8160 }, { imageWidth: 8160, imageHeight: 6120 }, PORTRAIT_16_9);
  assert.ok("crop" in big);
  assert.deepEqual(big.crop, { x: 765, y: 0, width: 4590, height: 8160 });
});

test("a still already the preview's shape is used whole", () => {
  const fit = stillCropFor({ width: 2252, height: 4000 }, S25_REQUEST, PORTRAIT_16_9);
  assert.ok("crop" in fit);
  assert.equal(fit.basis, "whole");
  assert.deepEqual(fit.crop, { x: 0, y: 0, width: 2252, height: 4000 });
});

test("the S25 field still — another size of another shape — is never guessed at", () => {
  // 1704×3648 (2.14:1) answered a request it did not match: it has lost part
  // of the preview's short edge, so no crop of it is the preview.
  const fit = stillCropFor({ width: 1704, height: 3648 }, { imageWidth: 3000, imageHeight: 1688 }, PORTRAIT_16_9);
  assert.deepEqual(fit, { reason: "aspect-mismatch" });
  // Nor with the new request: it is not the size asked for either.
  assert.deepEqual(stillCropFor({ width: 1704, height: 3648 }, S25_REQUEST, PORTRAIT_16_9), {
    reason: "aspect-mismatch",
  });
  // And a still of an unknown request that is not the preview's shape.
  assert.deepEqual(stillCropFor({ width: 3000, height: 4000 }, null, PORTRAIT_16_9), {
    reason: "aspect-mismatch",
  });
});

test("a still that came back turned a quarter is an orientation mismatch", () => {
  assert.deepEqual(stillCropFor({ width: 4000, height: 3000 }, S25_REQUEST, PORTRAIT_16_9), {
    reason: "orientation-mismatch",
  });
});

test("a square preview keeps the still's short edge whole", () => {
  const fit = stillCropFor({ width: 4000, height: 3000 }, S25_REQUEST, 1);
  assert.ok("crop" in fit);
  assert.deepEqual(fit.crop, { x: 500, y: 0, width: 3000, height: 3000 });
});

test("with no preview shape to match, the still is used whole", () => {
  for (const aspect of [null, 0, -1, Number.NaN]) {
    const fit = stillCropFor({ width: 3000, height: 4000 }, S25_REQUEST, aspect);
    assert.ok("crop" in fit);
    assert.equal(fit.basis, "whole");
  }
});

test("the still pipeline is proven by a used photo and unproven by any failure", async () => {
  const { noteStillSuccess, stillPipelineFailed, stillPipelineWorking } = await import("./still-capture.ts");
  resetStillCapturePolicy();
  assert.equal(stillPipelineWorking(), false);
  assert.equal(stillPipelineFailed(), false);
  noteStillSuccess();
  assert.equal(stillPipelineWorking(), true);
  noteStillFailure();
  assert.equal(stillPipelineWorking(), false);
  assert.equal(stillPipelineFailed(), true);
  noteStillSuccess();
  assert.equal(stillPipelineWorking(), true);
  // Two strikes end it for the session, success or not.
  noteStillFailure();
  noteStillSuccess();
  assert.equal(stillPipelineWorking(), false);
  resetStillCapturePolicy();
});
