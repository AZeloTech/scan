/**
 * Scoring real media — where, unlike the emulator's scenes, the truth is
 * usually unknown.
 *
 * Two kinds of number, never blended:
 *
 * - **GT-free**: what can be said with no label at all — how often a detector
 *   answers, how much its quad moves between consecutive video frames (the
 *   page barely moves in 1/15 s; the quad should not either), how often the
 *   ML and classical detectors disagree about the same image, and — for a clip
 *   replayed through the real app — how the overlay behaved against the
 *   detector's own per-frame answer on the frame that was on screen (a
 *   *proxy*: it measures lag and staleness, not correctness).
 * - **labelled**: the same verdicts as the synthetic suites (`metrics.mjs`)
 *   against a hand label (`labels.mjs`), wherever one exists. A corner the
 *   labeller marked *uncertain* does not count towards the corner-error verdict
 *   (it still shapes the IoU).
 *
 * Pure: unit-tested in `real-score.test.mjs`.
 */

import {
  cornerErrors,
  LOCK_HOLD_MS,
  MAX_SAMPLE_GAP_MS,
  mean,
  offImage,
  percentile,
  quadDistance,
  rate,
  sampleTimeline,
  scoreDetection,
  tapToConfirmLatency,
  timeToLock,
  visibleDistance,
  WRONG_CROP_MAX_CORNER_ERROR,
  WRONG_CROP_MIN_IOU,
} from "./metrics.mjs";
import {
  capturedImage,
  frameOnScreen,
  hintTimeline,
  OVERLAY_SHOWN_OPACITY,
  overlayAccuracy,
  PAGELESS_CAPTURE,
  toPoints,
} from "./session-score.mjs";

/** ML and classical "disagree" about an image when a matched corner is farther apart than this (fraction of the diagonal). */
export const DISAGREE_THRESHOLD = 0.05;

/** A detector's quad moving more than this between consecutive 15 fps frames is a jump, not jitter. */
export const JUMP_THRESHOLD = 0.05;

/**
 * One answer against a hand label. `null` when the image has no label.
 *
 * Like {@link scoreDetection}, plus `maxCertainCornerError` — the worst corner
 * the labeller was sure of and the image shows (a label may put a corner the
 * frame cut off outside it) — which is what decides `wrongCrop` here, with
 * the IoU and the corner order; with no such corner only those two can.
 * `maxCornerError` is the certain one too (so summaries read it);
 * `maxCornerErrorAll` keeps the one over all four. A label says where the
 * paper is, not where the print is: `contentClipped` and `severe` stay
 * unknown (`null`) unless the crop is wrong anyway.
 */
export function scoreAgainstLabel(detected, label, frame) {
  if (label === null || label === undefined) return null;
  if (label.noDocument) return scoreDetection(detected, null, frame);
  const score = scoreDetection(detected, label.quad, frame);
  if (!score.detected) return score;
  const uncertain = label.uncertain ?? [false, false, false, false];
  const certain = score.cornerErrors.filter((_, i) => !uncertain[i] && score.cornersInFrame[i]);
  const maxCertainCornerError = certain.length > 0 ? Math.max(...certain) : null;
  const scored = {
    ...score,
    uncertainCorners: uncertain.filter(Boolean).length,
    maxCornerErrorAll: score.maxCornerErrorAll,
    maxCornerError: maxCertainCornerError,
    maxCertainCornerError,
    wrongCrop:
      score.degenerate ||
      score.iou < WRONG_CROP_MIN_IOU ||
      (maxCertainCornerError !== null && maxCertainCornerError > WRONG_CROP_MAX_CORNER_ERROR) ||
      score.orderWrong,
  };
  return { ...scored, severe: scored.wrongCrop ? true : null };
}

/**
 * How much a detector's quad moves between consecutive frames of a clip:
 * `quads[k]` is its accepted answer on frame k or null. Pairs count only when
 * both frames were answered. Distances are the largest matched corner move,
 * fraction of the frame diagonal.
 */
export function frameToFrameMotion(quads, frame) {
  const steps = [];
  for (let k = 1; k < quads.length; k += 1) {
    if (quads[k - 1] !== null && quads[k] !== null) steps.push(quadDistance(quads[k], quads[k - 1], frame));
  }
  return {
    pairs: steps.length,
    p50: percentile(steps, 50),
    p95: percentile(steps, 95),
    mean: mean(steps),
    jumps: steps.filter((s) => s > JUMP_THRESHOLD).length,
    jumpRate: rate(steps.filter((s) => s > JUMP_THRESHOLD).length, steps.length),
  };
}

/**
 * Two detectors on the same images: `a[i]`, `b[i]` accepted quads or null,
 * `frames[i]` (or one frame for all) the image size.
 */
export function disagreement(a, b, frames) {
  const distances = [];
  let onlyA = 0;
  let onlyB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const frame = Array.isArray(frames) ? frames[i] : frames;
    if (a[i] !== null && b[i] !== null) distances.push(quadDistance(a[i], b[i], frame));
    else if (a[i] !== null) onlyA += 1;
    else if (b[i] !== null) onlyB += 1;
  }
  const disagree = distances.filter((d) => d > DISAGREE_THRESHOLD).length;
  return {
    images: a.length,
    comparable: distances.length,
    disagree,
    rate: rate(disagree, distances.length),
    onlyA,
    onlyB,
    distanceP50: percentile(distances, 50),
    distanceP95: percentile(distances, 95),
  };
}

/**
 * The GT-free headline for a group of per-image rows of one variant:
 * `{ det: { ok, accepted, coverage, ms } }`.
 */
export function detectionSummary(rows) {
  const accepted = rows.filter((r) => r.det.accepted);
  return {
    images: rows.length,
    answeredRate: rate(rows.filter((r) => r.det.ok).length, rows.length),
    detectionRate: rate(accepted.length, rows.length),
    undetectedRate: rate(rows.length - accepted.length, rows.length),
    coverageP50: percentile(accepted.map((r) => r.det.coverage), 50),
    msP50: percentile(rows.map((r) => r.det.ms), 50),
    msP95: percentile(rows.map((r) => r.det.ms), 95),
  };
}

/* ── the capture-time edge refinement, without a truth ────────────────── */

/**
 * A refinement that moved a corner farther than this (fraction of the
 * diagonal) is flagged for a person to look at: on a real photo nothing says
 * whether the move was the fix or the damage.
 */
export const REFINE_AUDIT_MOVE = 0.03;

/**
 * How far refinement moved each corner of one answer: `before` and `after`
 * are the same four corners (refinement keeps their order), fractions of
 * `frame`. `null` when either side has no quad.
 */
export function refineMoves(before, after, frame) {
  if (before === null || before === undefined || after === null || after === undefined) return null;
  const diagonal = Math.hypot(frame.width, frame.height);
  const corners = before.map(([x, y], i) =>
    Math.hypot((after[i][0] - x) * frame.width, (after[i][1] - y) * frame.height) / diagonal,
  );
  const max = Math.max(...corners);
  return { corners, max, flagged: max > REFINE_AUDIT_MOVE };
}

/**
 * Over a group's rows of one refining variant (`{ id, move, det }`): how many
 * it ran on, moved, and flagged, the size of the largest move per image, and
 * how many answers it left with a corner off the image (the contract says none).
 */
export function refineMoveSummary(rows) {
  const ran = rows.filter((r) => r.move !== null && r.move !== undefined);
  const maxes = ran.map((r) => r.move.max);
  return {
    refined: ran.length,
    moved: ran.filter((r) => r.move.max > 1e-4).length,
    moveP50: percentile(maxes, 50),
    moveP95: percentile(maxes, 95),
    moveMax: maxes.length > 0 ? Math.max(...maxes) : null,
    flagged: ran.filter((r) => r.move.flagged).map((r) => r.id),
    offImage: ran.filter((r) => offImage(r.det?.quad)).length,
    refineMsP50: percentile(ran.map((r) => r.det.refine?.ms ?? null).filter((v) => v !== null), 50),
    refineMsP95: percentile(ran.map((r) => r.det.refine?.ms ?? null).filter((v) => v !== null), 95),
  };
}

/* ── a clip replayed through the real app ──────────────────────────────── */

/**
 * The overlay against a per-frame reference: `refAt(t)` answers the reference
 * quad for the frame on screen at page time `t`, `null` for "no page there",
 * or `undefined` for "no reference for this frame".
 *
 * Read as **time**, the way a session's overlay is ({@link overlayAccuracy}):
 * each sample holds until the next, a gap past {@link MAX_SAMPLE_GAP_MS} is
 * unobserved, and time on a frame with no reference is unknown — neither
 * counts. Shares of the time left: nothing shown, shown on the page (≤
 * `LOCK_TOLERANCE`), near it (≤ the wrong-crop corner threshold), off it,
 * shown where the reference has no page, or not judged (no reference corner
 * in the frame); the time-weighted error of what was shown; the time to lock
 * (the overlay staying within `LOCK_TOLERANCE` for `LOCK_HOLD_MS`, from
 * `from`); and the longest stretch the overlay was **observed** off the page
 * — stale after the page moved, or on something else — which a gap or a
 * frame without a reference ends. Corners are judged the way a crop's are, on
 * the ones the image shows.
 *
 * A lock is only seen through samples no more than {@link MAX_SAMPLE_GAP_MS}
 * apart. Against sparse labels (one frame in several) it cannot be seen at
 * all: `lockObservable` is false and `timeToLockMs` null — unknown, not never.
 */
export function trackAgainst(series, refAt, { frame, from, to = series.length > 0 ? series[series.length - 1].t : from }) {
  const timed = series.map((s) => ({ ...s, gt: refAt(s.t) }));
  const samples = timed.filter((s) => s.gt !== undefined && s.t >= from && s.t <= to);
  const accuracy = overlayAccuracy(timed, { from, to, frame });
  const off = (sample) => {
    if (sample.quad === null || sample.gt === undefined) return false;
    if (sample.gt === null) return true;
    const error = visibleDistance(sample.quad, sample.gt, frame);
    return error !== null && error > WRONG_CROP_MAX_CORNER_ERROR;
  };
  let longestOff = 0;
  let run = 0;
  let runEnd = null;
  for (const interval of sampleTimeline(timed, { from, to }).intervals) {
    if (!off(interval.sample)) {
      run = 0;
      runEnd = null;
      continue;
    }
    run = runEnd === interval.from ? run + (interval.to - interval.from) : interval.to - interval.from;
    runEnd = interval.to;
    longestOff = Math.max(longestOff, run);
  }
  const n = samples.length;
  const gaps = samples.slice(1).map((sample, i) => sample.t - samples[i].t);
  const lockObservable = gaps.length > 0 && percentile(gaps, 50) <= MAX_SAMPLE_GAP_MS;
  return {
    samples: n,
    observedMs: accuracy.observedMs,
    unobservedMs: accuracy.unobservedMs,
    lockObservable,
    noneShare: accuracy.noneShare,
    onShare: accuracy.lockedShare,
    nearShare: accuracy.nearShare,
    offShare: accuracy.wrongShare,
    onNothingShare: accuracy.onNothingShare,
    unjudgedShare: accuracy.unjudgedShare,
    errorP50: accuracy.errorP50,
    errorP95: accuracy.errorP95,
    timeToLockMs: n === 0 || !lockObservable ? null : timeToLock(samples, { from, frame, holdMs: LOCK_HOLD_MS }),
    longestOffMs: n === 0 ? null : longestOff,
  };
}

/**
 * Every capture of a replayed clip: the frame that became the page (the still
 * the fake camera cut from the replay, or the preview frame on screen — named
 * by the ids the capture carried, as in `session-score.mjs`, never by time),
 * the corners the confirm screen opened with, and those corners against the
 * label of that frame (when it has one) and against the per-frame reference.
 * `k` is `null` when the frame could not be named (`imageKnown: false`).
 */
export function scoreReplayCaptures(record, { labelAt, referenceAt }) {
  const events = record.events;
  const captures = events.filter((e) => e.type === "capture");
  const framesTruth = record.frames ?? [];
  return captures.map((capture, index) => {
    const next = captures[index + 1]?.t ?? Infinity;
    const open = events.find((e) => e.type === "confirm-open" && e.t >= capture.t && e.t < next) ?? null;
    const frame = { width: capture.frameW, height: capture.frameH };
    const image = capturedImage({ framesTruth }, record, capture);
    const k = image.known ? image.k : null;
    const corners = toPoints(open?.corners ?? null);
    const label = k === null ? null : labelAt(k);
    const reference = k === null ? undefined : referenceAt(k);
    const vsLabel = label === null ? null : scoreAgainstLabel(corners, label, frame);
    return {
      trigger: capture.trigger,
      tapAt: capture.t - record.startedAt,
      k,
      imageKnown: k !== null,
      stillUsed: capture.stillUsed,
      frame: [frame.width, frame.height],
      cornersFrom: capture.cornersFrom,
      detector: capture.detector,
      confidence: capture.confidence,
      bufferAgeMs: capture.bufferAgeMs,
      confirmOpened: open !== null,
      confirmCorners: corners,
      labelled: label !== null,
      verdict:
        vsLabel === null
          ? null
          : vsLabel.hasTruth
            ? vsLabel.detected
              ? vsLabel.wrongCrop
                ? "wrong"
                : "good"
              : "no corners"
            : vsLabel.detected
              ? "false positive"
              : PAGELESS_CAPTURE,
      labelError: vsLabel?.detected ? (vsLabel.maxCertainCornerError ?? null) : null,
      referenceQuad: reference ?? null,
      vsReference:
        corners === null || reference === undefined || reference === null ? null : Math.max(...cornerErrors(corners, reference, frame)),
      tapToConfirmMs: tapToConfirmLatency(capture, open),
      captureMs: capture.doneAt - capture.t,
    };
  });
}

/**
 * Everything the real-video report shows for one clip replayed through the
 * real `<ScanFlow>`.
 *
 * `clip` is `{ frame, fps }` (replay frames); `labels` maps a replay frame
 * index to its label (`labels.mjs` → `labelFor`) for the frames that have
 * one; `reference[k]` is the per-frame detector answer on replay frame k (the
 * accepted quad, or null) — the GT-free proxy.
 */
export function scoreReplay(clip, record, { labels = new Map(), reference = null } = {}) {
  const frame = clip.frame;
  const frameAt = frameOnScreen(record, 1000 / clip.fps);
  const t0 = record.startedAt;
  const overlays = record.events.filter((e) => e.type === "overlay" && e.t >= t0);
  const series = overlays.map((e) => ({
    t: e.t,
    quad: e.quad !== null && e.opacity >= OVERLAY_SHOWN_OPACITY ? toPoints(e.quad) : null,
    k: frameAt(e.t),
  }));
  const labelAt = (k) => labels.get(k) ?? null;
  const referenceAt = (k) => (reference === null || k === null || k >= reference.length ? undefined : reference[k]);
  const out = { frame };

  const detects = record.events.filter((e) => e.type === "detect" && !e.warmUp);
  const firstAccepted = detects.find((e) => e.accepted);
  const firstShown = series.find((s) => s.quad !== null);
  out.firstAcceptedMs = firstAccepted === undefined ? null : firstAccepted.t - t0;
  out.firstShownMs = firstShown === undefined ? null : firstShown.t - t0;
  // The replay's overlay as time, like the tracks below: from the camera
  // opening to the last sample, gaps unobserved.
  const end = series.length > 0 ? series[series.length - 1].t : t0;
  const shown = sampleTimeline(series, { from: t0, to: end });
  out.shownShare = rate(
    shown.intervals.filter((i) => i.sample.quad !== null).reduce((sum, i) => sum + (i.to - i.from), 0),
    shown.observedMs,
  );

  const bySource = {};
  for (const e of detects) {
    const entry = (bySource[e.source] ??= { passes: 0, answered: 0, accepted: 0, ms: [], interval: [] });
    entry.passes += 1;
    if (e.ok) entry.answered += 1;
    if (e.accepted) entry.accepted += 1;
    entry.ms.push(e.passMs);
    entry.interval.push(e.intervalMs);
  }
  out.passes = Object.fromEntries(
    Object.entries(bySource).map(([source, s]) => [
      source,
      {
        passes: s.passes,
        answered: s.answered,
        accepted: s.accepted,
        msP50: percentile(s.ms, 50),
        msP95: percentile(s.ms, 95),
        intervalP50: percentile(s.interval, 50),
      },
    ]),
  );

  const labelled = [...labels.keys()];
  out.vsLabels =
    labelled.length === 0
      ? null
      : trackAgainst(
          series,
          (t) => {
            const k = frameAt(t);
            const label = k === null ? undefined : labels.get(k);
            return label === undefined ? undefined : label.noDocument ? null : label.quad;
          },
          { frame, from: t0, to: end },
        );
  out.vsReference = reference === null ? null : trackAgainst(series, (t) => referenceAt(frameAt(t)), { frame, from: t0, to: end });

  // How much the overlay moved between samples, against how much the
  // reference moved between the frames on screen at those samples.
  const shownSteps = [];
  const referenceSteps = [];
  for (let i = 1; i < series.length; i += 1) {
    const a = series[i - 1];
    const b = series[i];
    if (a.quad !== null && b.quad !== null) shownSteps.push(quadDistance(b.quad, a.quad, frame));
    const ra = referenceAt(a.k);
    const rb = referenceAt(b.k);
    if (ra && rb) referenceSteps.push(quadDistance(rb, ra, frame));
  }
  out.overlayMotion = { p50: percentile(shownSteps, 50), p95: percentile(shownSteps, 95), samples: shownSteps.length };
  out.referenceMotion = { p50: percentile(referenceSteps, 50), p95: percentile(referenceSteps, 95), samples: referenceSteps.length };

  out.captures = scoreReplayCaptures(record, { labelAt, referenceAt });
  out.unidentifiedCaptures = out.captures.filter((c) => !c.imageKnown).length;
  const pushes = record.pushes ?? [];
  const span = pushes.length > 1 ? pushes[pushes.length - 1].at - pushes[0].at : 0;
  out.stream = {
    pushed: pushes.length,
    fps: span > 0 ? ((pushes.length - 1) * 1000) / span : null,
    skipped: record.skipped ?? 0,
    presented: (record.presented ?? []).length,
  };
  out.hints = hintTimeline(record);
  return out;
}

/**
 * When to tap the shutter on a real clip, with no truth to go by: the middle
 * of the steadiest window of `windowFrames` frames (the reference quad moving
 * least), starting no earlier than `earliest` and ending `tail` frames before
 * the clip does. `reference[k]` is the per-frame answer (null = none; a
 * window with a gap is not steady). Answers a frame index, or null.
 */
export function steadiestFrame(reference, frame, { windowFrames, earliest, tail }) {
  let best = null;
  for (let start = earliest; start + windowFrames <= reference.length - tail; start += 1) {
    let worst = 0;
    let gap = false;
    for (let k = start + 1; k < start + windowFrames; k += 1) {
      if (reference[k] === null || reference[k - 1] === null) {
        gap = true;
        break;
      }
      worst = Math.max(worst, quadDistance(reference[k], reference[k - 1], frame));
    }
    if (gap) continue;
    if (best === null || worst < best.worst) best = { start, worst };
  }
  return best === null ? null : best.start + Math.floor(windowFrames / 2);
}
