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
  assert.equal(await takeStillPhoto(null, { longEdgeTarget: 3000 }), null);
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

test("a 12 MP sensor is asked for the page grid, not for all of itself", () => {
  const size = pickPhotoSize(
    { min: 0, max: 4000, step: 0 },
    { min: 0, max: 3000, step: 0 },
    3000,
  );
  // Long edge lands on the target; the aspect ratio is kept.
  assert.deepEqual(size, { imageWidth: 3000, imageHeight: 2250 });
});

test("a sensor smaller than the target is asked for everything it has", () => {
  assert.deepEqual(
    pickPhotoSize({ min: 0, max: 1920, step: 0 }, { min: 0, max: 1080, step: 0 }, 3000),
    { imageWidth: 1920, imageHeight: 1080 },
  );
});

test("portrait sensors scale on their own long edge", () => {
  assert.deepEqual(
    pickPhotoSize({ min: 0, max: 3000, step: 0 }, { min: 0, max: 4000, step: 0 }, 2000),
    { imageWidth: 1500, imageHeight: 2000 },
  );
});

test("the request snaps down onto the driver's step grid", () => {
  const size = pickPhotoSize(
    { min: 0, max: 4000, step: 16 },
    { min: 0, max: 3000, step: 16 },
    3000,
  );
  assert.deepEqual(size, { imageWidth: 2992, imageHeight: 2240 });
  assert.ok((size?.imageWidth ?? 0) <= 3000);
});

test("the grid is walked from min, not from zero", () => {
  assert.deepEqual(
    pickPhotoSize({ min: 5, max: 4000, step: 10 }, { min: 5, max: 4000, step: 10 }, 1000),
    { imageWidth: 995, imageHeight: 995 },
  );
});

test("a driver that only supports more than we want still gets a legal request", () => {
  const size = pickPhotoSize(
    { min: 3840, max: 3840, step: 0 },
    { min: 2160, max: 2160, step: 0 },
    1000,
  );
  // Clamped up to the minimum the driver accepts — asking below `min` would be
  // rejected outright, and the canonical cap trims the extra afterwards.
  assert.deepEqual(size, { imageWidth: 3840, imageHeight: 2160 });
});

test("a 4:3 sensor asked for a 16:9 preview's shape is cropped, then scaled", () => {
  // The S25 Ultra field case: sensor 4000×3000, preview 3840×2160.
  const size = pickPhotoSize(
    { min: 0, max: 4000, step: 0 },
    { min: 0, max: 3000, step: 0 },
    3000,
    3840 / 2160,
  );
  assert.deepEqual(size, { imageWidth: 3000, imageHeight: 1688 });
  const aspect = (size?.imageWidth ?? 0) / (size?.imageHeight ?? 1);
  assert.ok(Math.abs(aspect - 16 / 9) / (16 / 9) < 0.02);
});

test("a portrait preview asks for the same crop as its landscape twin", () => {
  // The phone holds the sensor sideways: the driver's ranges stay landscape
  // while the stream reports 2160×3840. Long-over-short means both spellings
  // of 16:9 produce one request.
  const landscape = pickPhotoSize(
    { min: 0, max: 4000, step: 0 },
    { min: 0, max: 3000, step: 0 },
    3000,
    3840 / 2160,
  );
  const portrait = pickPhotoSize(
    { min: 0, max: 4000, step: 0 },
    { min: 0, max: 3000, step: 0 },
    3000,
    2160 / 3840,
  );
  assert.deepEqual(portrait, landscape);
});

test("a preview narrower than the sensor crops the long edge instead", () => {
  // A squarer preview than the sensor: the short edge is kept whole and the
  // long edge gives way.
  const size = pickPhotoSize(
    { min: 0, max: 4000, step: 0 },
    { min: 0, max: 3000, step: 0 },
    4000,
    1,
  );
  assert.deepEqual(size, { imageWidth: 3000, imageHeight: 3000 });
});

test("a sensor already the preview's shape is asked for what it always was", () => {
  const size = pickPhotoSize(
    { min: 0, max: 4000, step: 0 },
    { min: 0, max: 3000, step: 0 },
    3000,
    4 / 3,
  );
  assert.deepEqual(size, { imageWidth: 3000, imageHeight: 2250 });
});

test("an unusable preview aspect falls back to the sensor's own shape", () => {
  const plain = pickPhotoSize(
    { min: 0, max: 4000, step: 0 },
    { min: 0, max: 3000, step: 0 },
    3000,
  );
  for (const aspect of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(
      pickPhotoSize(
        { min: 0, max: 4000, step: 0 },
        { min: 0, max: 3000, step: 0 },
        3000,
        aspect,
      ),
      plain,
    );
  }
});

test("unusable capabilities mean no settings rather than a bad guess", () => {
  assert.equal(pickPhotoSize(null, { min: 0, max: 3000, step: 0 }, 3000), null);
  assert.equal(pickPhotoSize({ min: 0, max: 4000, step: 0 }, null, 3000), null);
  assert.equal(
    pickPhotoSize({ min: 0, max: 4000, step: 0 }, { min: 0, max: 3000, step: 0 }, 0),
    null,
  );
  assert.equal(
    pickPhotoSize({ min: 0, max: 4000, step: 0 }, { min: 0, max: 3000, step: 0 }, Number.NaN),
    null,
  );
});
