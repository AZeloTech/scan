import assert from "node:assert/strict";
import test from "node:test";

import {
  DISAGREE_THRESHOLD,
  disagreement,
  detectionSummary,
  frameToFrameMotion,
  REFINE_AUDIT_MOVE,
  refineMoves,
  refineMoveSummary,
  scoreAgainstLabel,
  scoreReplay,
  scoreReplayCaptures,
  steadiestFrame,
  trackAgainst,
} from "./real-score.mjs";
import { PAGELESS_CAPTURE } from "./session-score.mjs";

/**
 * Real media rarely has a truth, so these numbers lean on the GT-free
 * measures being right about what they claim — and on a label's "uncertain"
 * corner never turning a crop wrong on its own.
 */

const FRAME = { width: 1000, height: 1000 };
const PAGE = [
  [0.2, 0.2],
  [0.8, 0.2],
  [0.8, 0.8],
  [0.2, 0.8],
];
const shift = (quad, dx, dy = 0) => quad.map(([x, y]) => [x + dx, y + dy]);
const quadObject = (q) => ({
  topLeft: { x: q[0][0], y: q[0][1] },
  topRight: { x: q[1][0], y: q[1][1] },
  bottomRight: { x: q[2][0], y: q[2][1] },
  bottomLeft: { x: q[3][0], y: q[3][1] },
});

test("an uncertain corner does not make a crop wrong; a certain one does", () => {
  // One corner 6 % of the diagonal off.
  const detected = PAGE.map((p, i) => (i === 1 ? [p[0] + 0.06, p[1] + 0.06] : p));
  const sure = scoreAgainstLabel(detected, { noDocument: false, quad: PAGE, uncertain: [false, false, false, false] }, FRAME);
  assert.equal(sure.wrongCrop, true);
  const unsure = scoreAgainstLabel(detected, { noDocument: false, quad: PAGE, uncertain: [false, true, false, false] }, FRAME);
  assert.ok(unsure.iou > 0.9);
  assert.equal(unsure.wrongCrop, false);
  assert.equal(unsure.uncertainCorners, 1);
  assert.ok(unsure.maxCertainCornerError < 1e-9);
  // No label: no verdict. A "no document" label: any quad is a false positive.
  assert.equal(scoreAgainstLabel(PAGE, null, FRAME), null);
  assert.equal(scoreAgainstLabel(PAGE, { noDocument: true, quad: null }, FRAME).falsePositive, true);
  assert.equal(scoreAgainstLabel(null, { noDocument: true, quad: null }, FRAME).falsePositive, false);
});

test("a crop in mirrored corner order is wrong against a label too; content stays unknown", () => {
  const label = { noDocument: false, quad: PAGE, uncertain: [false, false, false, false] };
  const mirrored = [PAGE[0], PAGE[3], PAGE[2], PAGE[1]];
  const score = scoreAgainstLabel(mirrored, label, FRAME);
  assert.equal(score.maxCertainCornerError, 0);
  assert.equal(score.orderWrong, true);
  assert.equal(score.wrongCrop, true);
  assert.equal(score.severe, true);
  const right = scoreAgainstLabel(PAGE, label, FRAME);
  assert.equal(right.contentClipped, null);
  assert.equal(right.severe, null, "a label knows the paper, not the print");
});

test("a labelled corner outside the image is not held against a crop to its edge", () => {
  const cut = [[0.5, 0.2], [1.3, 0.2], [1.3, 0.8], [0.5, 0.8]];
  const label = { noDocument: false, quad: cut, uncertain: [false, false, false, false] };
  const toEdge = scoreAgainstLabel([[0.5, 0.2], [1, 0.2], [1, 0.8], [0.5, 0.8]], label, FRAME);
  assert.equal(toEdge.wrongCrop, false);
  assert.ok(toEdge.maxCertainCornerError < 1e-9);
  assert.ok(toEdge.maxCornerErrorAll > 0.2);
});

test("frame-to-frame motion counts answered pairs only and flags jumps", () => {
  const quads = [PAGE, shift(PAGE, 0.001), null, shift(PAGE, 0.002), shift(PAGE, 0.2), shift(PAGE, 0.2)];
  const motion = frameToFrameMotion(quads, FRAME);
  assert.equal(motion.pairs, 3);
  assert.equal(motion.jumps, 1);
  assert.ok(Math.abs(motion.p50 - 0.001 / Math.SQRT2) < 1e-9);
});

test("disagreement is measured where both answered, beyond the threshold", () => {
  const a = [PAGE, PAGE, PAGE, null, null];
  const b = [PAGE, shift(PAGE, 0.1), null, PAGE, null];
  const d = disagreement(a, b, FRAME);
  assert.equal(d.comparable, 2);
  assert.equal(d.disagree, 1);
  assert.equal(d.rate, 0.5);
  assert.equal(d.onlyA, 1);
  assert.equal(d.onlyB, 1);
  assert.ok(0.1 / Math.SQRT2 > DISAGREE_THRESHOLD);
});

test("detection summary is GT-free", () => {
  const rows = [
    { det: { ok: true, accepted: true, coverage: 0.4, ms: 10 } },
    { det: { ok: true, accepted: false, coverage: 0.2, ms: 12 } },
    { det: { ok: false, accepted: false, coverage: null, ms: 14 } },
  ];
  const s = detectionSummary(rows);
  assert.equal(s.detectionRate, 1 / 3);
  assert.equal(s.answeredRate, 2 / 3);
  assert.equal(s.coverageP50, 0.4);
});

test("tracking against a reference: on, off, stale stretches and the lock", () => {
  const series = [
    { t: 0, quad: null },
    { t: 100, quad: PAGE },
    { t: 200, quad: PAGE },
    { t: 300, quad: PAGE },
    { t: 400, quad: PAGE },
    { t: 500, quad: PAGE },
    { t: 600, quad: PAGE },
    { t: 700, quad: PAGE },
  ];
  // The page moves away at t = 500; the overlay stays: 200 ms stale.
  const refAt = (t) => (t < 500 ? PAGE : shift(PAGE, 0.2));
  const track = trackAgainst(series, refAt, { frame: FRAME, from: 0, to: 800 });
  assert.equal(track.samples, 8);
  assert.equal(track.timeToLockMs, 100);
  // Time, not samples: 100 ms of nothing, 400 on the page, 300 stale.
  assert.equal(track.noneShare, 100 / 800);
  assert.equal(track.onShare, 400 / 800);
  assert.equal(track.offShare, 300 / 800);
  assert.equal(track.longestOffMs, 300);
  // Frames without a reference are skipped, not counted as misses.
  const sparse = trackAgainst(series, (t) => (t === 300 ? PAGE : undefined), { frame: FRAME, from: 0 });
  assert.equal(sparse.samples, 1);
  // Against references 400 ms apart a 300 ms hold cannot be seen: unknown, not never.
  const labelled = trackAgainst(series, (t) => (t % 400 === 0 ? PAGE : undefined), { frame: FRAME, from: 0 });
  assert.equal(labelled.lockObservable, false);
  assert.equal(labelled.timeToLockMs, null);
  assert.equal(track.lockObservable, true);
});

test("tracking is time-weighted: a burst of samples is not a long stretch, and a gap is not one either", () => {
  const off = shift(PAGE, 0.2);
  // Three samples off the page in 20 ms, then 400 ms on it: off for 20 ms of 420.
  const burst = [
    { t: 0, quad: off },
    { t: 7, quad: off },
    { t: 14, quad: off },
    ...[20, 120, 220, 320].map((t) => ({ t, quad: PAGE })),
  ];
  const track = trackAgainst(burst, () => PAGE, { frame: FRAME, from: 0, to: 420 });
  assert.equal(track.offShare, 20 / 420);
  assert.equal(track.onShare, 400 / 420);
  assert.equal(track.longestOffMs, 20);
  // Two samples off the page 4 s apart: each holds for the gap bound, and
  // nobody saw the 3.5 s between — not a 4 s stale stretch.
  const apart = trackAgainst([{ t: 0, quad: off }, { t: 4000, quad: off }], () => PAGE, { frame: FRAME, from: 0, to: 4100 });
  assert.equal(apart.longestOffMs, 250);
  assert.equal(apart.offShare, 1);
  assert.equal(apart.unobservedMs, 4100 - 250 - 100);
  // Time on a frame with no reference is unknown, and breaks a stretch.
  const holed = trackAgainst(
    [0, 100, 200, 300].map((t) => ({ t, quad: off })),
    (t) => (t === 100 ? undefined : PAGE),
    { frame: FRAME, from: 0, to: 400 },
  );
  assert.equal(holed.longestOffMs, 200);
  assert.equal(holed.offShare, 1);
});

test("a replayed capture of an image with no page is a page-less capture, never 'ok'", () => {
  const record = {
    startedAt: 0,
    events: [
      { type: "capture", t: 100, doneAt: 200, trigger: "shutter", stillUsed: false, stillAttempt: null, grab: 1, frameW: 1000, frameH: 1000, cornersFrom: null, detector: null },
      { type: "confirm-open", t: 300, corners: null },
    ],
    grabs: [{ id: 1, at: 150, k: 3 }],
    frames: Array.from({ length: 5 }, (_, i) => ({ i, quad: null, labelled: false })),
  };
  const [capture] = scoreReplayCaptures(record, { labelAt: () => ({ noDocument: true }), referenceAt: () => null });
  assert.equal(capture.verdict, PAGELESS_CAPTURE);
});

test("the steadiest window avoids gaps and motion", () => {
  const still = Array.from({ length: 40 }, (_, k) => (k < 10 ? shift(PAGE, k * 0.01) : k === 25 ? null : PAGE));
  const k = steadiestFrame(still, FRAME, { windowFrames: 8, earliest: 5, tail: 4 });
  assert.ok(k !== null && k >= 10 && (k + 4 < 25 || k - 4 > 25), `got ${k}`);
});

test("a replayed clip is scored against labels and the per-frame reference", () => {
  const t0 = 1000;
  const interval = 1000 / 15;
  const pushes = Array.from({ length: 30 }, (_, k) => ({ k, at: t0 + k * interval }));
  const presented = pushes.map((p) => ({ at: p.at + 5, k: p.k }));
  const events = [
    { type: "detect", t: t0 + 150, frameAt: t0 + 100, source: "ml", warmUp: false, ok: true, accepted: true, passMs: 12, intervalMs: 700, quad: quadObject(PAGE) },
    ...Array.from({ length: 18 }, (_, i) => ({ type: "overlay", t: t0 + 200 + i * 100, quad: quadObject(PAGE), opacity: 1 })),
    { type: "capture", t: t0 + 1500, doneAt: t0 + 1700, trigger: "shutter", stillUsed: true, stillAttempt: 1, grab: null, frameW: 1000, frameH: 1000, cornersFrom: "live", detector: "ml", confidence: 0.99, bufferAgeMs: 100 },
    { type: "confirm-open", t: t0 + 1900, corners: quadObject(shift(PAGE, 0.01)) },
  ];
  const record = {
    startedAt: t0,
    events,
    pushes,
    presented,
    skipped: 0,
    frames: pushes.map((p) => ({ i: p.k, quad: null, labelled: false })),
    // A later still, closer in time to the capture's end: the id says attempt 1.
    stills: [
      { index: 0, attempt: 1, calledAt: 1500, k: 24 },
      { index: 1, attempt: 2, calledAt: 1600, k: 26 },
    ],
    grabs: [{ id: 1, at: t0 + 1550, k: 23 }],
  };
  const labels = new Map([
    [8, { noDocument: false, quad: PAGE, uncertain: [false, false, false, false] }],
    [24, { noDocument: false, quad: PAGE, uncertain: [false, false, false, false] }],
  ]);
  const reference = Array.from({ length: 30 }, () => PAGE);
  const score = scoreReplay({ frame: FRAME, fps: 15 }, record, { labels, reference });
  assert.equal(score.firstAcceptedMs, 150);
  assert.equal(score.firstShownMs, 200);
  assert.equal(score.shownShare, 1);
  assert.equal(score.passes.ml.accepted, 1);
  assert.equal(score.vsReference.onShare, 1);
  assert.ok(score.vsLabels.samples >= 1);
  assert.equal(score.captures.length, 1);
  const capture = score.captures[0];
  assert.equal(capture.k, 24);
  assert.equal(capture.labelled, true);
  assert.equal(capture.verdict, "good");
  assert.ok(Math.abs(capture.vsReference - 0.01 / Math.SQRT2) < 1e-9);
  assert.equal(capture.tapToConfirmMs, 400);
  assert.ok(Math.abs(score.stream.fps - 15) < 1e-9);
  assert.equal(score.unidentifiedCaptures, 0);
  // From the preview, the grab names the frame.
  const preview = { ...record, events: events.map((e) => (e.type === "capture" ? { ...e, stillUsed: false, stillAttempt: null, grab: 1 } : e)) };
  assert.equal(scoreReplay({ frame: FRAME, fps: 15 }, preview, { labels, reference }).captures[0].k, 23);
  // An id that names nothing leaves the frame unknown — counted, never guessed.
  const lost = { ...record, events: events.map((e) => (e.type === "capture" ? { ...e, stillAttempt: 9 } : e)) };
  const unknown = scoreReplay({ frame: FRAME, fps: 15 }, lost, { labels, reference });
  assert.equal(unknown.captures[0].k, null);
  assert.equal(unknown.captures[0].verdict, null);
  assert.equal(unknown.unidentifiedCaptures, 1);
});

test("refinement moves are per corner, in diagonals, and flagged past the audit threshold", () => {
  const frame = { width: 300, height: 400 };
  assert.equal(refineMoves(null, PAGE, frame), null);
  const same = refineMoves(PAGE, PAGE, frame);
  assert.deepEqual(same.corners, [0, 0, 0, 0]);
  assert.equal(same.flagged, false);
  // Corner 3 moved 50 px of a 500 px diagonal: 10 %.
  const moved = PAGE.map(([x, y], i) => (i === 3 ? [x, y + 50 / 400] : [x, y]));
  const move = refineMoves(PAGE, moved, frame);
  assert.ok(Math.abs(move.corners[3] - 0.1) < 1e-9);
  assert.ok(Math.abs(move.max - 0.1) < 1e-9);
  assert.equal(move.flagged, true);
  const small = refineMoves(PAGE, PAGE.map(([x, y]) => [x + (0.5 * REFINE_AUDIT_MOVE * 500) / 300, y]), frame);
  assert.equal(small.flagged, false);
  const summary = refineMoveSummary([
    { id: "a", move: same, det: { refine: { ms: 10 } } },
    { id: "b", move, det: { refine: { ms: 30 } } },
    { id: "c", move: null, det: {} },
  ]);
  assert.equal(summary.refined, 2);
  assert.equal(summary.moved, 1);
  assert.deepEqual(summary.flagged, ["b"]);
  assert.ok(Math.abs(summary.moveMax - 0.1) < 1e-9);
  assert.equal(summary.offImage, 0);
  const off = refineMoveSummary([{ id: "d", move: same, det: { quad: PAGE.map(([x, y], i) => (i === 2 ? [x, 1.02] : [x, y])) } }]);
  assert.equal(off.offImage, 1);
});
