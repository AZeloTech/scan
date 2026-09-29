import assert from "node:assert/strict";
import test from "node:test";

import {
  CLIPPED_MAX_FRACTION,
  CONTENT_CLIP_MIN_FRACTION,
  clipPolygon,
  contentClipping,
  cornerErrors,
  cornerOrder,
  cornersAtConfirmError,
  falseLockExposure,
  falseLocksPerMinute,
  imageOrder,
  intersectionArea,
  isDegenerateQuad,
  LOCK_TOLERANCE,
  LOOSE_MAX_FRACTION,
  matchCorners,
  MAX_SAMPLE_GAP_MS,
  offImage,
  percentile,
  polygonArea,
  sampleTimeline,
  scoreDetection,
  staleOverlayAfterSwap,
  staticJitter,
  tapToConfirmLatency,
  timeToLock,
  visibleDistance,
  weightedPercentile,
  WRONG_CROP_MAX_CORNER_ERROR,
  WRONG_CROP_MIN_IOU,
} from "./metrics.mjs";

/**
 * The bench's verdicts are only as good as these functions: a wrong IoU or a
 * corner matched to the wrong corner would turn every report into fiction. The
 * cases are small enough to check by hand.
 */

const FRAME = { width: 1000, height: 1000 };
const DIAG = Math.hypot(1000, 1000);
const PAGE = [
  [0.2, 0.2],
  [0.8, 0.2],
  [0.8, 0.8],
  [0.2, 0.8],
];

const close = (actual, expected, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≉ ${expected}`);

function shifted(quad, dx, dy) {
  return quad.map(([x, y]) => [x + dx, y + dy]);
}

test("the area and the clip of simple polygons are exact", () => {
  const square = [
    [0, 0],
    [2, 0],
    [2, 2],
    [0, 2],
  ];
  close(polygonArea(square), 4);
  const other = shifted(square, 1, 1);
  close(intersectionArea(other, square), 1);
  // Either winding of the clip polygon gives the same answer.
  close(intersectionArea(other, [...square].reverse()), 1);
  assert.equal(clipPolygon(shifted(square, 5, 5), square).length, 0);
});

test("corners are matched whatever order and winding the detector used", () => {
  const rotated = [PAGE[2], PAGE[3], PAGE[0], PAGE[1]];
  const mirrored = [PAGE[0], PAGE[3], PAGE[2], PAGE[1]];
  for (const detected of [rotated, mirrored]) {
    const { matched } = matchCorners(detected, PAGE);
    assert.deepEqual(matched, PAGE);
    assert.deepEqual(cornerErrors(detected, PAGE, FRAME), [0, 0, 0, 0]);
  }
});

test("a mirrored or turned corner order is a wrong crop, however well it fits", () => {
  const turned = [PAGE[1], PAGE[2], PAGE[3], PAGE[0]];
  const mirrored = [PAGE[0], PAGE[3], PAGE[2], PAGE[1]];
  assert.deepEqual(cornerOrder(PAGE, PAGE, FRAME), { mirrored: false, rotation: 0, wrong: false });
  // The corner it names fourth is the true top-left.
  assert.deepEqual(cornerOrder(turned, PAGE, FRAME), { mirrored: false, rotation: 3, wrong: true });
  assert.equal(cornerOrder(mirrored, PAGE, FRAME).mirrored, true);
  for (const detected of [turned, mirrored]) {
    const score = scoreDetection(detected, PAGE, FRAME);
    close(score.maxCornerError, 0);
    close(score.iou, 1);
    assert.equal(score.orderWrong, true);
    assert.equal(score.wrongCrop, true, "the warp would mirror or turn the page");
  }
  assert.equal(scoreDetection(PAGE, PAGE, FRAME).orderWrong, false);
});

test("the order is the image's: a page the camera sees sideways is judged by where its corners are", () => {
  // The page's own top-left is at the image's top-right (the phone turned):
  // a detector names corners by where they are in the image, and is right to.
  const sideways = [PAGE[1], PAGE[2], PAGE[3], PAGE[0]];
  assert.deepEqual(imageOrder(sideways), PAGE);
  assert.equal(cornerOrder(PAGE, sideways, FRAME).wrong, false);
  assert.equal(scoreDetection(PAGE, sideways, FRAME).wrongCrop, false);
});

/** A content box, normalized: `[x0, y0, x1, y1]` as a polygon. */
function box(kind, x0, y0, x1, y1) {
  return { kind, polygon: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] };
}

// A line of text and a name 20 px inside the page's left edge, and a rule across the page.
const CONTENT = [box("text", 0.22, 0.25, 0.5, 0.28), box("identifier", 0.22, 0.7, 0.4, 0.73), box("layout", 0.2, 0.3, 0.8, 0.302)];

test("a crop that cuts into the text is content clipped and severe, even when geometrically right", () => {
  // 7 px in on the left: IoU 0.99, corner error 0.5 % — not a wrong crop.
  const trimmed = [[0.207, 0.2], [0.8, 0.2], [0.8, 0.8], [0.207, 0.8]];
  const margin = scoreDetection(trimmed, PAGE, FRAME, { content: CONTENT });
  assert.equal(margin.wrongCrop, false);
  assert.equal(margin.contentClipped, false);
  assert.equal(margin.severe, false);
  assert.equal(margin.clipped, true, "the page lost more than 1 % of its area");
  assert.equal(margin.marginClipped, true, "…but only margin: reported apart");
  // 25 px in: the text line (from x = 220) loses 5 px of 280, the name 5 of 180.
  const bitten = [[0.225, 0.2], [0.8, 0.2], [0.8, 0.8], [0.225, 0.8]];
  const clipped = scoreDetection(bitten, PAGE, FRAME, { content: CONTENT });
  assert.ok(clipped.iou > 0.9 && clipped.maxCornerError <= 0.03, "not wrong by geometry");
  assert.equal(clipped.wrongCrop, false);
  assert.equal(clipped.contentClipped, true);
  assert.equal(clipped.content.identifierClipped, true);
  assert.equal(clipped.content.clippedBoxes, 2, "layout is not content");
  close(clipped.content.maxLostFraction, 5 / 180, 1e-9);
  assert.equal(clipped.severe, true);
  assert.equal(clipped.marginClipped, false);
});

test("without content truth, clipping is unknown — never fine", () => {
  const score = scoreDetection(PAGE, PAGE, FRAME);
  assert.equal(score.contentClipped, null);
  assert.equal(score.marginClipped, null);
  assert.equal(score.severe, null);
  // …unless the crop is wrong anyway.
  assert.equal(scoreDetection(shifted(PAGE, 0.1, 0), PAGE, FRAME).severe, true);
});

test("content is judged on its part inside the frame, and a concave crop is measured exactly", () => {
  // A line of text running off the frame's right edge: what the frame lost is not the crop's fault.
  const running = [box("text", 0.5, 0.5, 1.4, 0.52)];
  const inFrame = contentClipping([[0.2, 0.2], [1, 0.2], [1, 0.8], [0.2, 0.8]], running, FRAME);
  assert.equal(inFrame.clipped, false);
  assert.equal(inFrame.judged, 1);
  // A dart-shaped (concave) crop whose notch reaches into a box: 1 % of it lost trips the threshold.
  const text = [box("text", 0.4, 0.4, 0.6, 0.6)];
  const notch = [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.5, 0.405]];
  const cut = contentClipping(notch, text, FRAME);
  assert.ok(cut.maxLostFraction > CONTENT_CLIP_MIN_FRACTION, `lost ${cut.maxLostFraction}`);
  assert.equal(cut.clipped, true);
  const whole = contentClipping(PAGE, text, FRAME);
  close(whole.maxLostFraction, 0);
});

test("visible distance judges only the corners the frame shows", () => {
  const offFrame = [
    [0.5, 0.2],
    [1.3, 0.2],
    [1.3, 0.8],
    [0.5, 0.8],
  ];
  const toEdge = [[0.5, 0.2], [1, 0.2], [1, 0.8], [0.5, 0.8]];
  close(visibleDistance(toEdge, offFrame, FRAME), 0);
  assert.equal(visibleDistance(toEdge, [[1.1, 1.1], [1.5, 1.1], [1.5, 1.5], [1.1, 1.5]], FRAME), null);
});

test("a perfect detection is a perfect score", () => {
  const score = scoreDetection(PAGE, PAGE, FRAME);
  close(score.iou, 1);
  assert.equal(score.wrongCrop, false);
  assert.equal(score.clipped, false);
  assert.equal(score.loose, false);
  close(score.maxCornerError, 0);
});

test("IoU and corner error are measured on the frame's pixels", () => {
  // Shift right by 0.02 of the width: 12 px of a 600 px page.
  const score = scoreDetection(shifted(PAGE, 0.02, 0), PAGE, FRAME);
  close(score.iou, (580 * 600) / (620 * 600), 1e-9);
  close(score.maxCornerError, 20 / DIAG, 1e-12);
  close(score.clippedFraction, 20 / 600, 1e-12);
  close(score.looseFraction, 20 / 600, 1e-12);
  assert.equal(score.clipped, 20 / 600 > CLIPPED_MAX_FRACTION);
  assert.equal(score.loose, 20 / 600 > LOOSE_MAX_FRACTION);
});

test("wrong crop trips on IoU or on a single far corner, at the named thresholds", () => {
  // One corner pulled out by 4 % of the diagonal: IoU stays high, crop is wrong.
  const pull = (0.04 * DIAG) / Math.SQRT2 / 1000;
  const oneCorner = [PAGE[0], PAGE[1], [0.8 + pull, 0.8 + pull], PAGE[3]];
  const score = scoreDetection(oneCorner, PAGE, FRAME);
  assert.ok(score.iou > WRONG_CROP_MIN_IOU, `iou ${score.iou}`);
  assert.ok(score.maxCornerError > WRONG_CROP_MAX_CORNER_ERROR);
  assert.equal(score.wrongCrop, true);
  // The desk lock: a quad around the whole desk mat covers the page but is huge.
  const desk = [
    [0.02, 0.05],
    [0.98, 0.05],
    [0.98, 0.95],
    [0.02, 0.95],
  ];
  const deskScore = scoreDetection(desk, PAGE, FRAME);
  assert.equal(deskScore.clipped, false);
  assert.equal(deskScore.loose, true);
  assert.equal(deskScore.wrongCrop, true);
});

test("a page hanging off the frame is judged on its visible part", () => {
  const offFrame = [
    [0.5, 0.2],
    [1.3, 0.2],
    [1.3, 0.8],
    [0.5, 0.8],
  ];
  // Following the page to the frame's edge crops exactly what can be cropped…
  const clampedDetection = [
    [0.5, 0.2],
    [1.0, 0.2],
    [1.0, 0.8],
    [0.5, 0.8],
  ];
  const clamped = scoreDetection(clampedDetection, offFrame, FRAME);
  close(clamped.iou, 1);
  close(clamped.clippedFraction, 0);
  close(clamped.looseFraction, 0);
  assert.deepEqual(clamped.cornersInFrame, [true, false, false, true]);
  close(clamped.maxCornerError, 0);
  // …the hidden corners' error is still reported, never judged…
  close(clamped.maxCornerErrorAll, 300 / DIAG, 1e-12);
  assert.equal(clamped.wrongCrop, false);
  // …and so is extrapolating them exactly: the part outside the frame is not "loose".
  const exact = scoreDetection(offFrame, offFrame, FRAME);
  close(exact.iou, 1);
  assert.equal(exact.loose, false);
  assert.equal(exact.wrongCrop, false);
  // A visible corner off by 4 % of the diagonal is still wrong.
  const pull = (0.04 * DIAG) / 1000;
  const wrongVisible = scoreDetection([[0.5 - pull, 0.2], ...clampedDetection.slice(1)], offFrame, FRAME);
  assert.ok(wrongVisible.maxCornerError > WRONG_CROP_MAX_CORNER_ERROR);
  assert.equal(wrongVisible.wrongCrop, true);
});

test("a page that overflows the frame on every side is judged by area alone", () => {
  const huge = [
    [-0.2, -0.2],
    [1.2, -0.2],
    [1.2, 1.2],
    [-0.2, 1.2],
  ];
  const wholeFrame = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  const score = scoreDetection(wholeFrame, huge, FRAME);
  assert.equal(score.maxCornerError, null);
  assert.equal(score.meanCornerError, null);
  close(score.iou, 1);
  assert.equal(score.wrongCrop, false);
  assert.equal(scoreDetection(PAGE, huge, FRAME).wrongCrop, true);
});

test("empty scenes and misses are counted, not scored", () => {
  assert.deepEqual(scoreDetection(PAGE, null, FRAME), {
    hasTruth: false,
    detected: true,
    falsePositive: true,
  });
  assert.equal(scoreDetection(null, null, FRAME).falsePositive, false);
  assert.equal(scoreDetection(null, PAGE, FRAME).miss, true);
});

test("a bow-tie quad is degenerate and always a wrong crop", () => {
  const bowTie = [PAGE[0], PAGE[2], PAGE[1], PAGE[3]];
  assert.equal(isDegenerateQuad(bowTie), true);
  assert.equal(isDegenerateQuad(PAGE), false);
  const score = scoreDetection(bowTie, PAGE, FRAME);
  assert.equal(score.degenerate, true);
  assert.equal(score.wrongCrop, true);
});

test("percentiles are nearest-rank and ignore non-finite values", () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([1, 2, 3, 4], 95), 4);
  assert.equal(percentile([Number.NaN, 7], 50), 7);
  assert.equal(percentile([], 50), null);
});

/** A viewfinder series: `quadAt(t)` sampled every `step` ms over `[0, end]`. */
function series(end, step, quadAt, gt = PAGE) {
  const out = [];
  for (let t = 0; t <= end; t += step) out.push({ t, quad: quadAt(t), gt });
  return out;
}

test("time to lock waits for the quad to hold within tolerance", () => {
  const near = shifted(PAGE, 0.005, 0);
  const far = shifted(PAGE, 0.1, 0);
  // Far until 400 ms, one near blip at 500, far again, then near from 800 on.
  const quadAt = (t) => (t === 500 ? near : t < 800 ? far : near);
  const lock = timeToLock(series(2000, 50, quadAt), { from: 200, frame: FRAME });
  assert.equal(lock, 600);
  // Never locks when it never holds.
  assert.equal(timeToLock(series(2000, 50, () => far), { from: 0, frame: FRAME }), null);
  // Needs the hold to have been observed, not just begun.
  assert.equal(timeToLock(series(900, 50, quadAt), { from: 0, frame: FRAME }), null);
  assert.ok(LOCK_TOLERANCE > 0.005 * 1000 / DIAG);
});

test("static jitter is the RMS deviation from each corner's mean", () => {
  const a = shifted(PAGE, 0.01, 0);
  const b = shifted(PAGE, -0.01, 0);
  // Ten samples, alternating: five on each side of the page.
  const jitter = staticJitter(series(900, 100, (t) => (t % 200 === 0 ? a : b)), {
    from: 0,
    to: 900,
    frame: FRAME,
  });
  // Every corner sits 10 px from its mean; each step moves it 20 px.
  close(jitter.rms, 10 / DIAG, 1e-12);
  close(jitter.meanStep, 20 / DIAG, 1e-12);
  assert.equal(staticJitter([], { from: 0, to: 1, frame: FRAME }), null);
});

test("stale overlay after a swap is measured until the quad leaves the old page", () => {
  const other = shifted(PAGE, 0.15, 0);
  const quadAt = (t) => (t < 1300 ? PAGE : other);
  assert.deepEqual(
    staleOverlayAfterSwap(series(2000, 100, quadAt), { swapAt: 1000, oldGt: PAGE, frame: FRAME }),
    { outcome: "left", ms: 300 },
  );
  // Hidden counts as having left.
  assert.deepEqual(
    staleOverlayAfterSwap(series(2000, 100, (t) => (t < 1000 ? PAGE : null)), {
      swapAt: 1000,
      oldGt: PAGE,
      frame: FRAME,
    }),
    { outcome: "never-on", ms: 0 },
  );
  assert.deepEqual(
    staleOverlayAfterSwap(series(2000, 100, () => PAGE), { swapAt: 1000, oldGt: PAGE, frame: FRAME }),
    { outcome: "stuck", ms: null },
  );
});

test("one noisy sample off the old page is not the overlay leaving it", () => {
  // Parked on the old page until 1900, with one sample at 1100 just past the tolerance.
  const nudge = (LOCK_TOLERANCE * 1.05 * DIAG) / 1000;
  const quadAt = (t) => (t === 1100 ? shifted(PAGE, nudge, 0) : t < 2000 ? PAGE : null);
  assert.deepEqual(
    staleOverlayAfterSwap(series(2500, 100, quadAt), { swapAt: 1000, oldGt: PAGE, frame: FRAME }),
    { outcome: "left", ms: 1000 },
  );
  // Bounded by `to`: still there at the end of the window is stuck.
  assert.deepEqual(
    staleOverlayAfterSwap(series(2500, 100, quadAt), { swapAt: 1000, oldGt: PAGE, frame: FRAME, to: 1800 }),
    { outcome: "stuck", ms: null },
  );
});

test("a swap nobody observed is unknown, not a quick departure", () => {
  const other = shifted(PAGE, 0.15, 0);
  // No sample at all after the swap: it used to read as 0 ms stale.
  const before = series(900, 100, () => PAGE);
  assert.deepEqual(staleOverlayAfterSwap(before, { swapAt: 1000, oldGt: PAGE, frame: FRAME }), { outcome: "unobserved", ms: null });
  // The first sample after the swap arrives 800 ms late and is already off
  // the old page: where the overlay was in between nobody saw.
  const late = [...before, ...series(3000, 100, () => other).filter((s) => s.t >= 1800)];
  assert.deepEqual(staleOverlayAfterSwap(late, { swapAt: 1000, oldGt: PAGE, frame: FRAME }), { outcome: "unobserved", ms: null });
  // Samples no more than the gap bound apart are an observation.
  const prompt = [...before, ...series(3000, 100, () => other).filter((s) => s.t >= 900 + MAX_SAMPLE_GAP_MS - 50)];
  assert.deepEqual(staleOverlayAfterSwap(prompt, { swapAt: 1000, oldGt: PAGE, frame: FRAME }), { outcome: "never-on", ms: 0 });
});

test("a stale-overlay outcome needs the whole window observed, not just its first sample", () => {
  const other = shifted(PAGE, 0.15, 0);
  const before = series(900, 100, () => PAGE);
  // One sample 100 ms after the swap, then silence until the window ends:
  // "never on the old page" was seen for 350 ms of 4 s.
  const once = [...before, { t: 1100, quad: null, gt: PAGE }];
  assert.deepEqual(staleOverlayAfterSwap(once, { swapAt: 1000, oldGt: PAGE, frame: FRAME, to: 5000 }), { outcome: "unobserved", ms: null });
  // Two samples 3 s apart, both off the old page: it may have sat on it in between.
  const sparse = [...before, { t: 1100, quad: other, gt: PAGE }, { t: 4100, quad: other, gt: PAGE }];
  assert.deepEqual(staleOverlayAfterSwap(sparse, { swapAt: 1000, oldGt: PAGE, frame: FRAME, to: 4100 }), { outcome: "unobserved", ms: null });
  // Left at 1300 — but a hole after the departure could hide a return to it.
  const quadAt = (t) => (t < 1300 ? PAGE : other);
  const holed = series(3000, 100, quadAt).filter((s) => s.t < 1800 || s.t > 2200);
  assert.deepEqual(staleOverlayAfterSwap(holed, { swapAt: 1000, oldGt: PAGE, frame: FRAME, to: 3000 }), { outcome: "unobserved", ms: null });
  // Observed throughout, the same departure is an answer; so is never-on.
  assert.deepEqual(staleOverlayAfterSwap(series(3000, 100, quadAt), { swapAt: 1000, oldGt: PAGE, frame: FRAME, to: 3000 }), { outcome: "left", ms: 300 });
  assert.deepEqual(
    staleOverlayAfterSwap(series(3000, 100, (t) => (t < 1000 ? PAGE : other)), { swapAt: 1000, oldGt: PAGE, frame: FRAME, to: 3000 }),
    { outcome: "never-on", ms: 0 },
  );
  // A window that runs past the last sample by more than the gap bound is not all seen either.
  assert.deepEqual(
    staleOverlayAfterSwap(series(3000, 100, quadAt), { swapAt: 1000, oldGt: PAGE, frame: FRAME, to: 3500 }),
    { outcome: "unobserved", ms: null },
  );
});

test("a lock is only held through samples that were observed, and within tolerance", () => {
  const near = shifted(PAGE, 0.005, 0);
  const far = shifted(PAGE, 0.1, 0);
  // On the page at 0 and 100, then nothing until 450 (a 350 ms gap), then on
  // the page again: the hold did not survive the gap; it starts over at 450.
  const gappy = [0, 100, 450, 550, 650, 750, 850].map((t) => ({ t, quad: near, gt: PAGE }));
  assert.equal(timeToLock(gappy, { from: 0, frame: FRAME }), 450);
  // The sample that reaches the hold must itself be on the page: one far
  // sample at the 300 ms mark is not a completed hold.
  const broken = [0, 100, 200, 300].map((t) => ({ t, quad: t === 300 ? far : near, gt: PAGE }));
  assert.equal(timeToLock(broken, { from: 0, frame: FRAME }), null);
  // A frame nobody can name is not a frame the quad was on.
  const unknown = [0, 100, 200, 300, 400].map((t) => ({ t, quad: near, gt: t === 200 ? undefined : PAGE }));
  assert.equal(timeToLock(unknown, { from: 0, frame: FRAME }), null);
});

test("false locks need an observed hold; exposure counts every flash, by time", () => {
  // A quad at 0 and 100, a 400 ms gap, then again at 500: without the gap it
  // would be one 500 ms lock; nobody saw it stay.
  const gappy = [0, 100, 500, 600, 700].map((t) => ({ t, quad: PAGE, gt: null }));
  gappy.push({ t: 800, quad: null, gt: null });
  assert.equal(falseLocksPerMinute(gappy, { from: 0, to: 60000, minHoldMs: 300 }), 0);
  // A 150 ms flash is no lock, but it is exposure: 150 ms of the 1000 observed.
  const flash = [
    { t: 0, quad: null, gt: null },
    { t: 100, quad: null, gt: null },
    { t: 200, quad: PAGE, gt: null },
    { t: 300, quad: PAGE, gt: null },
    { t: 350, quad: null, gt: null },
    ...[450, 550, 650, 750, 850, 950].map((t) => ({ t, quad: null, gt: null })),
  ];
  assert.equal(falseLocksPerMinute(flash, { from: 0, to: 1000, minHoldMs: 300 }), 0);
  const exposure = falseLockExposure(flash, { from: 0, to: 1000 });
  close(exposure.shownMs, 150);
  close(exposure.observedMs, 1000);
  close(exposure.share, 0.15);
});

test("a timeline holds each sample until the next, and a long gap is unobserved", () => {
  const samples = [
    { t: 0, v: "a" },
    { t: 100, v: "b" },
    { t: 1000, v: "c" },
  ];
  const { intervals, observedMs, unobservedMs } = sampleTimeline(samples, { from: 50, to: 1100, maxGapMs: 250 });
  assert.deepEqual(
    intervals.map((i) => [i.from, i.to, i.sample.v]),
    [
      [50, 100, "a"],
      [100, 350, "b"],
      [1000, 1100, "c"],
    ],
  );
  close(observedMs, 400);
  close(unobservedMs, 650);
  // Time-weighted percentiles: 90 % of the time at 1, 10 % at 5.
  assert.equal(weightedPercentile([1, 5], [900, 100], 50), 1);
  assert.equal(weightedPercentile([1, 5], [900, 100], 95), 5);
  assert.equal(weightedPercentile([], [], 50), null);
});

test("false locks are counted per onset and per minute", () => {
  // Two onsets in 30 s: 0–1 s and 10–10.05 s.
  const quadAt = (t) => (t < 1000 || (t >= 10000 && t < 10100) ? PAGE : null);
  const all = series(30000, 50, quadAt, null);
  assert.equal(falseLocksPerMinute(all, { from: 0, to: 30000 }), 4);
  // A 100 ms blip does not count once a minimum hold is asked for.
  assert.equal(falseLocksPerMinute(all, { from: 0, to: 30000, minHoldMs: 200 }), 2);
});

test("capture latency and corners at confirm", () => {
  assert.equal(tapToConfirmLatency({ t: 1000 }, { t: 1850 }), 850);
  assert.equal(tapToConfirmLatency(null, { t: 1 }), null);
  const error = cornersAtConfirmError(shifted(PAGE, 0.01, 0), PAGE, FRAME);
  close(error.max, 10 / DIAG, 1e-12);
  close(error.mean, 10 / DIAG, 1e-12);
  assert.equal(cornersAtConfirmError(null, PAGE, FRAME), null);
  // A page cut off by the image: the hidden corners are reported, not judged.
  const offFrame = [
    [0.5, 0.2],
    [1.3, 0.2],
    [1.3, 0.8],
    [0.5, 0.8],
  ];
  const cut = cornersAtConfirmError([[0.5, 0.2], [1, 0.2], [1, 0.8], [0.5, 0.8]], offFrame, FRAME);
  close(cut.max, 0);
  close(cut.maxAll, 300 / DIAG, 1e-12);
});

test("offImage: a corner past the frame's edge, beyond rounding", () => {
  const quad = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  assert.equal(offImage(quad), false);
  assert.equal(offImage(quad.map(([x, y]) => [x + 1e-7, y])), false);
  assert.equal(offImage(quad.map(([x, y], i) => (i === 3 ? [-0.004, y] : [x, y]))), true);
  assert.equal(offImage(null), false);
});
