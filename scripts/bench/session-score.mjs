/**
 * Scoring one played session: the probe's events against the frames that
 * were on screen when they happened.
 *
 * Pure — a session script and the page's record in, numbers out — and
 * unit-tested in `session-score.test.mjs`. Three clocks meet here, all in the
 * page's `performance.now()` milliseconds except where named:
 *
 * - every probe event carries its own `t` (and a detect pass its `frameAt`,
 *   the moment it sampled the video);
 * - the player logged each **push** of a frame into the stream (`{ k, at }`)
 *   and each **presentation** of one by the app's `<video>` (`{ at, k }`);
 * - the script's marks are **camera time**: milliseconds since the camera
 *   opened (`record.startedAt`).
 *
 * The frame on screen at a moment is the last one the `<video>` presented at
 * or before it; its ground truth was logged when it was rendered. Before the
 * first presentation it is **unknown** — never frame 0 — and so is anything
 * scored against it.
 *
 * **A capture names its image by id, not by time.** The app numbers the
 * preview frames it draws to make a page (`grab`) and its still attempts
 * (`still-call`), and carries both numbers in its `capture` event; the page's
 * listener named each grab by the timestamp of the frame the `<video>` held
 * at the draw, and the fake camera stamped each still with the attempt it
 * answered. A capture whose image cannot be named that way is **unscored**
 * and counted as missing data.
 */

import {
  cornersAtConfirmError,
  falseLockExposure,
  falseLocksPerMinute,
  LOCK_TOLERANCE,
  MAX_SAMPLE_GAP_MS,
  mean,
  percentile,
  rate,
  sampleTimeline,
  scoreDetection,
  staleOverlayAfterSwap,
  staticJitter,
  tapToConfirmLatency,
  timeToLock,
  visibleDistance,
  weightedPercentile,
  WRONG_CROP_MAX_CORNER_ERROR,
} from "./metrics.mjs";
import { FOLLOW_RULES, framingMeasure } from "./emulator/session.js";

/** An overlay counts as shown to the user from this opacity up. */
export const OVERLAY_SHOWN_OPACITY = 0.5;

/** A false lock on a page-less scene has to last this long to count. */
export const FALSE_LOCK_MIN_MS = 300;

/** A scoring window with more than this share of its time unobserved is missing data, not a measurement. */
export const MAX_UNOBSERVED_SHARE = 0.2;

/** Capture verdicts that count as a failed capture — a crop the user would have had to fix. */
export const CAPTURE_FAILURES = new Set(["wrong", "false positive", "no corners", "confirm never opened"]);

/**
 * An image with no page in it went into the capture flow. The detector may
 * have been right to find nothing; the capture still made a page of an empty
 * desk. Its own failure class — never "ok", and never mixed into the
 * wrong-crop rate.
 */
export const PAGELESS_CAPTURE = "page-less capture";

/** The bench could not name the image that became the page: missing data, not a verdict. */
export const UNSCORED_CAPTURE = "unscored";

/** The whole image as a crop — what confirming with no corners delivers (the frame goes in flat). */
const WHOLE_IMAGE = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

/** `{ topLeft: { x, y }, … }` (the library's quad) or `[[x, y] × 4]` → `[[x, y] × 4]`; null stays null. */
export function toPoints(quad) {
  if (quad === null || quad === undefined) return null;
  if (Array.isArray(quad)) return quad;
  return [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft].map((p) => [p.x, p.y]);
}

/**
 * The frame index on screen at page time `at`: the last presentation at or
 * before it — `null` before the first one. With no presentation log at all,
 * the last frame pushed at least one frame interval before it (`null` before
 * that).
 */
export function frameOnScreen(record, frameIntervalMs = 1000 / 30) {
  const presented = record.presented ?? [];
  const pushes = record.pushes ?? [];
  return (at) => {
    if (presented.length > 0) {
      if (presented[0].at > at) return null;
      let lo = 0;
      let hi = presented.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (presented[mid].at <= at) lo = mid;
        else hi = mid - 1;
      }
      return presented[lo].k;
    }
    let k = null;
    for (const push of pushes) if (push.at <= at - frameIntervalMs) k = push.k;
    return k;
  };
}

/**
 * The truth on screen at page time `t`: the page's quad, `null` for no page,
 * `undefined` when it is not known which frame was on screen.
 */
export function truthOnScreen(record, frameAt = frameOnScreen(record)) {
  return (t) => {
    const k = frameAt(t);
    if (k === null) return undefined;
    const frame = record.frames[k];
    return frame === undefined ? undefined : (frame.quad ?? null);
  };
}

/** The overlay as the user saw it: `[{ t, quad, gt }]`, page time. */
export function overlaySeries(record, gtAt) {
  return record.events
    .filter((e) => e.type === "overlay")
    .map((e) => ({
      t: e.t,
      quad: e.quad !== null && e.opacity >= OVERLAY_SHOWN_OPACITY ? toPoints(e.quad) : null,
      gt: gtAt(e.t),
    }));
}

/**
 * Over `[from, to]`, **time-weighted**: each overlay sample holds until the
 * next ({@link sampleTimeline}; a gap past {@link MAX_SAMPLE_GAP_MS} is
 * unobserved), and the shares are of the observed time — showing nothing, a
 * quad on the page (within `LOCK_TOLERANCE`), near it, a wrong one (a corner
 * past the wrong-crop threshold), a quad over a frame with no page, or one
 * that cannot be judged (no true corner in the frame). Corners are judged the
 * way a crop's are: only those the frame shows ({@link visibleDistance}).
 * Time on a frame nobody can name counts as unobserved. The corner-error
 * percentiles are weighted by time too.
 */
export function overlayAccuracy(series, { from, to, frame, maxGapMs = MAX_SAMPLE_GAP_MS }) {
  const { intervals, observedMs, unobservedMs } = sampleTimeline(series, { from, to, maxGapMs });
  const ms = { none: 0, locked: 0, near: 0, wrong: 0, onNothing: 0, unjudged: 0, unknown: 0 };
  const errors = [];
  const weights = [];
  for (const interval of intervals) {
    const { sample } = interval;
    const span = interval.to - interval.from;
    if (sample.quad === null) ms.none += span;
    else if (sample.gt === undefined) ms.unknown += span;
    else if (sample.gt === null) ms.onNothing += span;
    else {
      const error = visibleDistance(sample.quad, sample.gt, frame);
      if (error === null) {
        ms.unjudged += span;
        continue;
      }
      errors.push(error);
      weights.push(span);
      if (error <= LOCK_TOLERANCE) ms.locked += span;
      else if (error <= WRONG_CROP_MAX_CORNER_ERROR) ms.near += span;
      else ms.wrong += span;
    }
  }
  const scored = observedMs - ms.unknown;
  return {
    samples: series.filter((s) => s.t >= from && s.t <= to).length,
    observedMs: scored,
    unobservedMs: unobservedMs + ms.unknown,
    noneShare: rate(ms.none, scored),
    lockedShare: rate(ms.locked, scored),
    nearShare: rate(ms.near, scored),
    wrongShare: rate(ms.wrong, scored),
    onNothingShare: rate(ms.onNothing, scored),
    unjudgedShare: rate(ms.unjudged, scored),
    errorP50: weightedPercentile(errors, weights, 50),
    errorP95: weightedPercentile(errors, weights, 95),
  };
}

/**
 * Every detect pass, scored against the frame it sampled — the warm-up ML
 * passes as their own rows (`"ml warm-up"`): an accepted warm-up answer puts
 * corners on screen and into a capture like any other.
 *
 * Page and no-page frames have their own denominators: `wrongRate` is wrong
 * answers over answers accepted **on a frame with a page**, `falsePositiveRate`
 * is answers accepted on a frame without one over the passes that sampled
 * such frames. A pass whose frame cannot be named is `unknownPasses`, and its
 * answer is not scored.
 */
export function scorePasses(record, gtAt, frame) {
  const bySource = {};
  for (const e of record.events) {
    if (e.type !== "detect") continue;
    const key = e.warmUp ? `${e.source} warm-up` : e.source;
    const entry = (bySource[key] ??= {
      passes: 0,
      answered: 0,
      accepted: 0,
      pagePasses: 0,
      noPagePasses: 0,
      unknownPasses: 0,
      acceptedOnPage: 0,
      wrong: 0,
      falsePositive: 0,
      ms: [],
    });
    entry.passes += 1;
    entry.ms.push(e.passMs);
    if (e.ok) entry.answered += 1;
    const truth = gtAt(e.frameAt);
    if (truth === undefined) entry.unknownPasses += 1;
    else if (truth === null) entry.noPagePasses += 1;
    else entry.pagePasses += 1;
    if (!e.accepted) continue;
    entry.accepted += 1;
    if (truth === undefined) continue;
    const score = scoreDetection(toPoints(e.quad), truth, frame);
    if (!score.hasTruth) entry.falsePositive += 1;
    else {
      entry.acceptedOnPage += 1;
      if (score.wrongCrop) entry.wrong += 1;
    }
  }
  return Object.fromEntries(
    Object.entries(bySource).map(([source, s]) => [
      source,
      {
        passes: s.passes,
        answered: s.answered,
        accepted: s.accepted,
        pagePasses: s.pagePasses,
        noPagePasses: s.noPagePasses,
        unknownPasses: s.unknownPasses,
        acceptedOnPage: s.acceptedOnPage,
        wrong: s.wrong,
        falsePositive: s.falsePositive,
        wrongRate: rate(s.wrong, s.acceptedOnPage),
        falsePositiveRate: rate(s.falsePositive, s.noPagePasses),
        msP50: percentile(s.ms, 50),
        msP95: percentile(s.ms, 95),
      },
    ]),
  );
}

/**
 * A still's truth (normalized to the whole still) re-expressed in a crop of it
 * (`crop` in the still's pixels): corners, the page quad, the content
 * polygons, and whether the page is still whole inside the crop.
 */
export function cropStillTruth(still, crop) {
  const { width, height } = still;
  if (!(width > 0 && height > 0 && crop.width > 0 && crop.height > 0)) return null;
  const map = ([u, v]) => [(u * width - crop.x) / crop.width, (v * height - crop.y) / crop.height];
  const quad = still.quad === null || still.quad === undefined ? still.quad : still.quad.map(map);
  const corners = still.corners === null || still.corners === undefined ? still.corners : still.corners.map(map);
  const inside = ([u, v]) => u >= 0 && u <= 1 && v >= 0 && v <= 1;
  const content = Array.isArray(still.content)
    ? still.content.map((box) => ({ ...box, polygon: box.polygon.map(map) }))
    : (still.content ?? null);
  return {
    ...still,
    width: crop.width,
    height: crop.height,
    quad,
    corners,
    whole: Array.isArray(corners) ? corners.every(inside) : still.whole,
    content,
  };
}

/**
 * The image a capture made its page of, by the ids it carried: the still the
 * fake camera rendered for its attempt, or the preview frame its grab was
 * stamped with. `known: false` when the ids name nothing — never a guess.
 */
export function capturedImage(script, record, capture) {
  if (capture.stillUsed) {
    const attempt = capture.stillAttempt ?? null;
    const rendered = attempt === null ? null : ((record.stills ?? []).find((s) => s.attempt === attempt) ?? null);
    if (rendered === null) return { known: false, source: "still (unidentified)" };
    // The app cuts a sensor-native still to the preview's field of view
    // (`stillCropFor`): the page's frame is that crop, so the truth moves with it.
    const crop = capture.stillCrop ?? null;
    const cropped = crop === null ? null : cropStillTruth(rendered, crop);
    return {
      known: true,
      truth: cropped ?? rendered,
      content: cropped === null ? (rendered.content ?? null) : cropped.content,
      source:
        cropped === null
          ? `still ${rendered.width}×${rendered.height}`
          : `still ${rendered.width}×${rendered.height} → ${crop.width}×${crop.height}`,
      stillIndex: rendered.index ?? null,
      k: rendered.k ?? null,
    };
  }
  const grab = capture.grab === null || capture.grab === undefined ? null : ((record.grabs ?? []).find((g) => g.id === capture.grab) ?? null);
  const k = grab?.k ?? null;
  const truth = k === null ? undefined : script.framesTruth[k];
  if (truth === undefined) return { known: false, source: "preview frame (unidentified)" };
  return { known: true, truth, content: record.frameContent?.[k] ?? null, source: `preview frame ${k}`, stillIndex: null, k };
}

/**
 * Each capture, from tap to confirm screen and out of it: which image became
 * the page, its truth, and three crops judged against it, never blended —
 *
 * - the **proposal** the confirm screen opened with (`verdict`, `atConfirm`,
 *   `confirmCorners`): what the detector chain offered;
 * - the crop the editor **showed** (`shownVerdict`): the proposal, or the
 *   editor's own inset default when there was none;
 * - the **final** crop the user left with (`finalVerdict`): what the page
 *   became — the corners confirmed, or the whole image with none.
 *
 * Verdicts: `good`, `wrong`, `no corners` (a page, and nothing to crop it
 * with), `false positive` (corners on an image with no page),
 * {@link PAGELESS_CAPTURE} (an image with no page became a capture),
 * `confirm never opened`, and {@link UNSCORED_CAPTURE} (the image could not be
 * named). {@link CAPTURE_FAILURES} are the ones a user would have had to fix.
 * With the image's content boxes, each crop also says whether it cut content
 * (`contentClipped`, `finalContentClipped`) and `severe` = wrong ∨ clipped;
 * a page captured with no content truth is `contentUnknown` — missing data,
 * never "not clipped".
 */
export function scoreCaptures(script, record) {
  const events = record.events;
  const captures = events.filter((e) => e.type === "capture");
  return captures.map((capture, index) => {
    const next = captures[index + 1]?.t ?? Infinity;
    const attempt = capture.stillAttempt ?? null;
    // The attempt's own report — by id; an attempt that never reached the
    // camera has none, and only its outcome is looked up by time.
    const still =
      attempt !== null
        ? events.find((e) => e.type === "still" && e.attempt === attempt)
        : events.find((e) => e.type === "still" && e.t >= capture.t - 1 && e.t <= capture.doneAt);
    const open = events.find((e) => e.type === "confirm-open" && e.t >= capture.t && e.t < next) ?? null;
    const done = events.find((e) => e.type === "confirm-done" && open !== null && e.t >= open.t && e.t < next) ?? null;
    const frame = { width: capture.frameW, height: capture.frameH };
    const image = capturedImage(script, record, capture);
    const truth = image.known ? image.truth : null;
    /** The page's corners on the image; `null` = no page; `undefined` = unknown image. */
    const truthQuad = !image.known ? undefined : truth.quad === null || truth.quad === undefined ? null : (truth.corners ?? truth.quad);
    const content = image.known ? image.content : null;
    const judge = (corners) => (truthQuad === undefined ? null : scoreDetection(corners, truthQuad, frame, { content }));
    const atError = (corners) => (truthQuad === undefined ? null : cornersAtConfirmError(corners, truthQuad, frame));
    const corners = toPoints(open?.corners ?? null);
    const shownCorners = open === null ? null : toPoints(open.shownCorners ?? null);
    const finalCorners = done === null ? null : (toPoints(done.corners) ?? WHOLE_IMAGE);
    const proposal = judge(corners);
    const shown = open === null ? null : judge(shownCorners);
    const final = done === null ? null : judge(finalCorners);
    // The edge refinement that produced the seed, if one did: its input is the
    // seed this capture would have opened with before refinement existed —
    // scored on the same run, so the comparison is paired.
    const refine =
      [...events].reverse().find((e) => e.type === "refine" && e.t >= capture.t && (open === null || e.t <= open.t)) ?? null;
    const refinedSeed = refine !== null && open !== null && sameQuad(toPoints(refine.output), corners);
    const unrefinedCorners = refinedSeed ? toPoints(refine.input) : corners;
    const unrefined = judge(unrefinedCorners);
    // The other capture policy on the same capture (`alternative`: what the
    // screen would have opened with without the classical fall-through).
    const alternativeCorners = capture.alternative ? toPoints(capture.alternative.corners) : corners;
    const alternative = capture.alternative ? judge(alternativeCorners) : proposal;
    const headline = (score) =>
      open === null ? "confirm never opened" : truthQuad === undefined ? UNSCORED_CAPTURE : captureVerdict(score);
    return {
      trigger: capture.trigger,
      tapAt: capture.t - record.startedAt,
      stillAttempt: attempt,
      grab: capture.grab ?? null,
      stillAttempted: still !== undefined,
      stillOk: still?.ok ?? null,
      stillMs: still?.ms ?? null,
      stillUsed: capture.stillUsed,
      stillSize: capture.stillW === null ? null : [capture.stillW, capture.stillH],
      stillCrop: capture.stillCrop ?? null,
      stillReason: capture.stillReason ?? null,
      previewSize: [capture.previewW, capture.previewH],
      frame: [frame.width, frame.height],
      imageSource: image.source,
      imageKnown: image.known,
      k: image.known ? image.k : null,
      stillIndex: image.known ? image.stillIndex : null,
      cornersFrom: capture.cornersFrom,
      detector: capture.detector,
      confidence: capture.confidence,
      bufferAgeMs: capture.bufferAgeMs,
      mlWaitMs: capture.mlWaitMs,
      hasTruth: truthQuad !== undefined && truthQuad !== null,
      truthWhole: truth?.whole ?? null,
      truthCorners: truthQuad ?? null,
      // (a) the proposal the confirm screen opened with
      confirmCorners: corners,
      atConfirm: atError(corners),
      verdict: headline(proposal),
      iou: proposal?.iou ?? null,
      orderWrong: proposal?.orderWrong ?? null,
      contentClipped: proposal?.contentClipped ?? null,
      // A page whose content the bench does not know: its crops' content
      // verdicts are unknown, and so is whether the capture was severe.
      contentUnknown: open !== null && truthQuad !== undefined && truthQuad !== null && (content === null || content === undefined),
      identifierClipped: proposal?.content?.identifierClipped ?? null,
      marginClipped: proposal?.marginClipped ?? null,
      severe: open === null ? true : (proposal?.severe ?? null),
      // (b) what the editor showed
      shownCorners,
      shownAtConfirm: open === null ? null : atError(shownCorners),
      shownVerdict: open === null ? "confirm never opened" : truthQuad === undefined ? UNSCORED_CAPTURE : cropVerdict(shown),
      // (c) what the user left with
      finalCorners,
      finalAtConfirm: final === null ? null : atError(finalCorners),
      finalVerdict:
        open === null ? "confirm never opened" : done === null ? "not confirmed" : truthQuad === undefined ? UNSCORED_CAPTURE : cropVerdict(final),
      finalContentClipped: final?.contentClipped ?? null,
      finalSevere: final === null ? null : final.severe,
      wholePhoto: done?.wholePhoto ?? null,
      pagelessCapture: open !== null && truthQuad === null,
      refine:
        refine === null
          ? null
          : {
              from: refine.from,
              mode: refine.mode,
              changed: refine.changed,
              reason: refine.reason,
              ms: refine.ms,
              modes: refine.sides.map((side) => side.mode),
              seeded: refinedSeed,
            },
      unrefinedCorners,
      unrefinedAtConfirm: atError(unrefinedCorners),
      unrefinedVerdict: headline(unrefined),
      fellThrough: capture.alternative !== undefined && capture.alternative !== null,
      alternativeVerdict: headline(alternative),
      alternativeContentClipped: alternative?.contentClipped ?? null,
      tapToConfirmMs: tapToConfirmLatency(capture, open),
      captureMs: capture.doneAt - capture.t,
      confirmEdited: done?.edited ?? null,
      confirmOpened: open !== null,
      // The app's own check of the image before the confirm screen (Phase 5a):
      // the reason it flagged the page for attention, or null.
      attention: capture.attention ?? null,
      // Some corner of the page lies outside the image that became it.
      cornerOutside: truthQuad === undefined || truthQuad === null ? null : !truthQuad.every(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1),
    };
  });
}

/** Two quads (`[[x, y] × 4]`) that are the same answer, to float noise. */
function sameQuad(a, b) {
  if (a === null || b === null) return a === b;
  return a.every(([x, y], i) => Math.abs(x - b[i][0]) < 1e-6 && Math.abs(y - b[i][1]) < 1e-6);
}

/** The proposal's verdict: on an image with no page, corners are a false positive and none a page-less capture. */
function captureVerdict(score) {
  if (score.hasTruth) return score.detected ? (score.wrongCrop ? "wrong" : "good") : "no corners";
  return score.detected ? "false positive" : PAGELESS_CAPTURE;
}

/** A crop's verdict (shown, final): any crop of an image with no page is a page-less capture. */
function cropVerdict(score) {
  if (score === null) return null;
  if (!score.hasTruth) return PAGELESS_CAPTURE;
  if (!score.detected) return "no corners";
  return score.wrongCrop ? "wrong" : "good";
}

/**
 * Everything the report shows for one played session.
 *
 * `script` is the session script; the record's `frames` are the per-frame
 * truth. `missingData` lists what could not be measured — a window mostly
 * unobserved, a swap with no sample after it, a capture whose image could
 * not be named or whose page's content is not known — which `--compare`
 * refuses to wave through.
 */
export function scoreSession(script, record) {
  const frame = script.frame;
  const t0 = record.startedAt;
  const at = (cameraMs) => t0 + cameraMs;
  const frameAt = frameOnScreen(record);
  const gtAt = truthOnScreen(record, frameAt);
  const withTruth = { ...script, framesTruth: record.frames };
  const series = overlaySeries(record, gtAt);
  const marks = script.marks;
  const out = { frame, marks, missingData: [] };
  const windowed = (name, accuracy) => {
    const total = accuracy.observedMs + accuracy.unobservedMs;
    if (total > 0 && accuracy.unobservedMs > MAX_UNOBSERVED_SHARE * total) {
      out.missingData.push(`${name}: ${Math.round(accuracy.unobservedMs)} of ${Math.round(total)} ms unobserved`);
    }
    return accuracy;
  };

  if (marks.lockFrom !== undefined) {
    const from = at(marks.lockFrom);
    const lock = timeToLock(series, { from, frame });
    out.timeToLockMs = lock;
    const holdTo = at(marks.holdTo);
    const jitterFrom = lock === null ? at(marks.holdFrom ?? marks.lockFrom) : from + lock;
    out.jitter = staticJitter(series, { from: jitterFrom, to: holdTo, frame });
    out.truthMotion = staticJitter(
      series.map((s) => ({ ...s, quad: s.quad === null || s.gt === undefined ? null : s.gt })),
      { from: jitterFrom, to: holdTo, frame },
    );
    out.hold = windowed("hold", overlayAccuracy(series, { from: at(marks.holdFrom ?? marks.lockFrom), to: holdTo, frame }));
  }
  if (marks.swapAt !== undefined) {
    const swapAt = at(marks.swapAt);
    const oldGt = gtAt(swapAt - 1);
    const stale =
      oldGt === null || oldGt === undefined
        ? { outcome: "unobserved", ms: null }
        : staleOverlayAfterSwap(series, { swapAt, oldGt, frame, to: marks.holdTo2 === undefined ? Infinity : at(marks.holdTo2) });
    out.staleAfterSwap = stale.outcome;
    out.staleAfterSwapMs = stale.ms;
    if (stale.outcome === "unobserved") out.missingData.push("swap: the overlay (or the old page) was not observed throughout the swap");
    out.timeToLockAfterSwapMs = timeToLock(series, { from: at(marks.lockFrom2), frame });
    out.holdAfterSwap = windowed(
      "hold after the swap",
      overlayAccuracy(series, { from: at(marks.lockFrom2), to: at(marks.holdTo2), frame }),
    );
  }
  if (marks.negativeFrom !== undefined) {
    const from = at(marks.negativeFrom);
    const to = at(marks.negativeTo);
    out.falseLocksPerMinute = falseLocksPerMinute(series, { from, to, minHoldMs: FALSE_LOCK_MIN_MS });
    out.falseLockExposure = falseLockExposure(series, { from, to });
    out.negative = windowed("no page in view", overlayAccuracy(series, { from, to, frame }));
  }
  if (marks.partialFrom !== undefined) {
    // The page is cut off: the overlay is judged on the corners the frame
    // shows, exactly as a crop of the same frame would be.
    out.partial = windowed("page cut off", overlayAccuracy(series, { from: at(marks.partialFrom), to: at(marks.partialTo), frame }));
  }
  out.passes = scorePasses(record, gtAt, frame);
  out.captures = scoreCaptures(withTruth, record);
  out.captures.forEach((capture, index) => {
    if (capture.verdict === UNSCORED_CAPTURE) out.missingData.push(`capture ${index + 1}: ${capture.imageSource}`);
    else if (capture.contentUnknown) out.missingData.push(`capture ${index + 1}: no content truth for ${capture.imageSource}`);
  });
  // Every scripted tap owes a capture: one that never came is a failure too,
  // not a smaller denominator.
  out.expectedCaptures = (script.actions ?? []).filter((a) => a.tap !== undefined).length;
  out.missingCaptures = Math.max(0, out.expectedCaptures - out.captures.length);
  const pushes = record.pushes ?? [];
  const span = pushes.length > 1 ? pushes[pushes.length - 1].at - pushes[0].at : 0;
  out.stream = {
    pushed: pushes.length,
    fps: span > 0 ? ((pushes.length - 1) * 1000) / span : null,
    skipped: record.skipped ?? 0,
    presented: (record.presented ?? []).length,
    stillRenderMs: mean((record.stills ?? []).map((s) => s.renderMs)),
  };
  out.hints = hintTimeline(record);
  out.guidance = scoreGuidance(script, record, gtAt, out.captures);
  out.visibility = scoreVisibility(script, record, gtAt, out.captures);
  out.framing = scoreFraming(script, record, gtAt, out.captures, out.visibility);
  out.captureDetects = scoreCaptureDetects(record);
  out.captureFreeze = scoreCaptureFreeze(record);
  out.perf = scorePerf(record);
  out.startup = scoreStartup(record, series, frame);
  if ((record.remounts ?? []).length > 0) out.remounts = scoreRemounts(record, series, frame);
  if (record.perfEnd) out.leaks = scoreLeaks(record);
  return out;
}

/**
 * How far the overlay moved between each capture's tap (or auto fire) and
 * its confirm screen opening — it must hold still on the quad of the tap
 * (`capturing`), whatever the camera does for the photo: the largest corner
 * displacement (share of the frame) from the last quad drawn at the tap, over
 * every overlay sample in between, and whether it faded or vanished there.
 */
export function scoreCaptureFreeze(record) {
  const events = record.events ?? [];
  const overlays = events.filter((e) => e.type === "overlay");
  const out = [];
  for (const capture of events.filter((e) => e.type === "capture")) {
    const open = events.find((e) => e.type === "confirm-open" && e.t >= capture.t);
    const to = open?.t ?? capture.doneAt ?? capture.t;
    // The quad of the tap: the first frozen sample (the loop samples it as
    // it freezes), else the last one drawn before the tap.
    const frozen = overlays.find((o) => o.capturing === true && o.t >= capture.t - 1 && o.t < to) ?? null;
    const before = frozen ?? overlays.filter((o) => o.t <= capture.t).at(-1) ?? null;
    const base = before?.quad ?? null;
    let move = 0;
    let dropped = false;
    let samples = 0;
    for (const o of overlays) {
      if (o === before || o.t < capture.t || o.t >= to) continue;
      samples += 1;
      if (base === null) continue;
      if (o.quad === null || o.opacity < (before.opacity ?? 1) - 1e-6) {
        dropped = true;
        continue;
      }
      for (const key of ["topLeft", "topRight", "bottomRight", "bottomLeft"]) {
        move = Math.max(move, Math.hypot(o.quad[key].x - base[key].x, o.quad[key].y - base[key].y));
      }
    }
    out.push({ trigger: capture.trigger ?? null, from: capture.t, to, drawn: base !== null, samples, move, dropped });
  }
  return out;
}

/**
 * The captures' own detects (`capture-detect`, on the frame and on a stored
 * canonical): how many fell through to the classical detector after the model
 * answered nothing (`fellThrough`, where the probe says; else a classical
 * answer once the model had answered anything), and how many were
 * **downgraded** — the model skipped because a live pass held it (`mlSkipped:
 * "busy"`; `null` when the app does not report it).
 */
export function scoreCaptureDetects(record) {
  const detects = record.events.filter((e) => e.type === "capture-detect");
  let fallThrough = 0;
  let downgraded = 0;
  let known = false;
  for (const e of detects) {
    const mlBefore = record.events.some((d) => d.type === "detect" && d.source === "ml" && d.t < e.t);
    if (e.fellThrough === true || (e.fellThrough === undefined && e.source === "classical" && mlBefore)) fallThrough += 1;
    if (e.mlSkipped !== undefined) known = true;
    if (e.mlSkipped === "busy") downgraded += 1;
  }
  return { detects: detects.length, fallThrough, downgraded: known ? downgraded : null };
}

/** The long tasks this share of a window or longer count as "the main thread was blocked". */
export const LONG_TASK_MS = 50;

/**
 * An interval between two regular passes that spans a capture (tap to the
 * confirm screen closing) measures the pause, not the cadence.
 */
function captureWindows(record) {
  const windows = [];
  for (const e of record.events) {
    if (e.type !== "capture") continue;
    const done = record.events.find((d) => d.type === "confirm-done" && d.t >= e.t);
    windows.push([e.t - 50, (done?.t ?? e.doneAt) + 2000]);
  }
  return windows;
}

/** Least-squares slope of `y` over `x`, or null with fewer than three points. */
function slope(points) {
  if (points.length < 3) return null;
  const n = points.length;
  const mx = points.reduce((s, p) => s + p[0], 0) / n;
  const my = points.reduce((s, p) => s + p[1], 0) / n;
  let num = 0;
  let den = 0;
  for (const [x, y] of points) {
    num += (x - mx) * (y - my);
    den += (x - mx) ** 2;
  }
  return den > 0 ? num / den : null;
}

/**
 * What the live part of a session cost the page (`record.perf`, from
 * `app/perf-watch.js`): main-thread long tasks per minute and their share of
 * the time; the heap at the start, the end and its slope; and the detection
 * loop's cadence as it actually ran — the time between consecutive regular
 * passes (captures excluded), per detector, and what the passes cost: `passMs`
 * as the loop measured it and, where the probe says, the main thread's own
 * share of it (`mainMs`: the worker lane's grab and hand-over).
 */
export function scorePerf(record) {
  const perf = record.perf;
  if (perf === null || perf === undefined) return null;
  const minutes = perf.windowMs / 60000;
  const tasks = perf.longTasks ?? [];
  const taskMs = tasks.map((t) => t.ms);
  const totalTaskMs = taskMs.reduce((s, v) => s + v, 0);
  const heap = (perf.memory ?? []).filter((m) => m.at >= perf.from && m.at <= perf.to);
  const mb = (bytes) => bytes / (1024 * 1024);
  const heapSlope = slope(heap.map((m) => [(m.at - perf.from) / 60000, mb(m.used)]));
  const pauses = captureWindows(record);
  const paused = (a, b) => pauses.some(([from, to]) => a < to && b > from);
  const bySource = {};
  let previous = null;
  for (const e of record.events) {
    if (e.type !== "detect" || e.warmUp || e.frameAt < perf.from || e.frameAt > perf.to) continue;
    const entry = (bySource[e.source] ??= { intervals: [], passMs: [], mainMs: [], computeMs: [], passes: 0 });
    entry.passes += 1;
    entry.passMs.push(e.passMs);
    if (Number.isFinite(e.mainMs)) entry.mainMs.push(e.mainMs);
    if (Number.isFinite(e.computeMs)) entry.computeMs.push(e.computeMs);
    if (previous !== null && previous.source === e.source && !paused(previous.frameAt, e.frameAt)) {
      entry.intervals.push(e.frameAt - previous.frameAt);
    }
    previous = e;
  }
  const cadence = Object.fromEntries(
    Object.entries(bySource).map(([source, e]) => {
      const m = mean(e.intervals);
      const sd = e.intervals.length > 1 ? Math.sqrt(e.intervals.reduce((s, v) => s + (v - m) ** 2, 0) / (e.intervals.length - 1)) : null;
      return [
        source,
        {
          passes: e.passes,
          perMinute: e.passes / minutes,
          intervalP50: percentile(e.intervals, 50),
          intervalP95: percentile(e.intervals, 95),
          intervalCv: m === null || sd === null || m === 0 ? null : sd / m,
          passMsP50: percentile(e.passMs, 50),
          passMsP95: percentile(e.passMs, 95),
          mainMsP50: percentile(e.mainMs, 50),
          mainMsP95: percentile(e.mainMs, 95),
          computeMsP50: percentile(e.computeMs, 50),
          computeMsP95: percentile(e.computeMs, 95),
        },
      ];
    }),
  );
  const lanes = record.events.filter((e) => e.type === "lane").map((e) => ({ lane: e.lane, reason: e.reason }));
  return {
    windowMs: perf.windowMs,
    longTaskSupported: perf.longTaskSupported,
    longTasks: tasks.length,
    longTasksPerMinute: perf.longTaskSupported ? tasks.length / minutes : null,
    longTaskShare: perf.longTaskSupported ? totalTaskMs / perf.windowMs : null,
    longTaskMsP50: percentile(taskMs, 50),
    longTaskMsMax: taskMs.length > 0 ? Math.max(...taskMs) : null,
    heapStartMB: heap.length > 0 ? mb(heap[0].used) : null,
    heapEndMB: heap.length > 0 ? mb(heap[heap.length - 1].used) : null,
    heapMaxMB: heap.length > 0 ? Math.max(...heap.map((m) => mb(m.used))) : null,
    heapSlopeMBPerMin: heapSlope,
    cadence,
    lanes,
    workersCreated: (perf.workers ?? []).length,
  };
}

/**
 * Start-up, on the camera clock: from the flow's mount to the camera, to the
 * model's first answer (the `ml-ready` probe event where the app reports one,
 * else its first ML pass), to the first lock on the page — the last only
 * means something in a session framed from the start.
 */
export function scoreStartup(record, series, frame) {
  const camera = record.startedAt;
  const mounted = record.mountedAt ?? null;
  const ready = record.events.find((e) => e.type === "ml-ready" && e.ok);
  const firstMl = record.events.find((e) => e.type === "detect" && e.source === "ml");
  const mlAt = ready?.t ?? firstMl?.t ?? null;
  const lock = timeToLock(series, { from: camera, frame });
  return {
    mountToCameraMs: mounted === null || camera === null ? null : camera - mounted,
    cameraToMlMs: mlAt === null || camera === null ? null : mlAt - camera,
    mlFrom: ready !== undefined ? "ml-ready" : firstMl !== undefined ? "first ML pass" : null,
    cameraToLockMs: lock,
  };
}

/**
 * The flow mounted again, the runtime warm: mount → camera → the model's
 * first answer after it → the first lock, each within the remount's own
 * window.
 */
export function scoreRemounts(record, series, frame) {
  return record.remounts.map((r) => {
    const inside = series.filter((s) => s.t >= r.mountedAt && s.t <= r.heldTo);
    const firstMl = record.events.find((e) => e.type === "detect" && e.source === "ml" && e.t >= r.mountedAt && e.t <= r.heldTo);
    return {
      mountToCameraMs: r.cameraLiveAt === null ? null : r.cameraLiveAt - r.mountedAt,
      mountToMlMs: firstMl === undefined ? null : firstMl.t - r.mountedAt,
      mountToLockMs: timeToLock(inside, { from: r.mountedAt, frame }),
    };
  });
}

/** Workers the bench itself starts (the camera's frame pump): not the app's. */
const BENCH_WORKERS = new Set(["bench-camera"]);

/** What outlived the flow: the app's workers not terminated, bitmaps never closed, the heap. */
export function scoreLeaks(record) {
  const end = record.perfEnd;
  const live = record.perf;
  const alive = (workers) => (workers ?? []).filter((w) => w.terminatedAt === null && !BENCH_WORKERS.has(w.name));
  const heap = end.memory ?? [];
  return {
    workersCreated: (end.workers ?? []).filter((w) => !BENCH_WORKERS.has(w.name)).length,
    workersAlive: alive(end.workers).length,
    workersAliveBeforeRemounts: alive(live?.workers).length,
    workers: alive(end.workers).map((w) => w.name ?? w.url),
    bitmapsCreated: end.bitmaps.created,
    bitmapsOpen: end.bitmaps.open,
    bitmapsCollectedOpen: end.bitmaps.collectedOpen,
    gcRan: end.bitmaps.gcRan,
    heapEndMB: heap.length > 0 ? heap[heap.length - 1].used / (1024 * 1024) : null,
  };
}

/** The chips over the viewfinder, in order: `+key` shown, `-key` gone, camera time. */
export function hintTimeline(record) {
  return record.events
    .filter((e) => e.type === "hint")
    .map((e) => ({ t: e.t - record.startedAt, change: `${e.shown ? "+" : "-"}${e.key}` }));
}

/* ── guidance: the hint, the ready cue, auto-capture (Phase 4) ─────────── */

/**
 * The hint keys the viewfinder's single hint slot names (`hint` probe events,
 * one shown at a time). Builds before it had one showed several chips at
 * once under other names; those are mapped to the nearest key so a baseline
 * can be scored on the same windows ("sheet-found" and the prose tip are not
 * hints and are ignored).
 */
export const HINT_KEYS = ["searching", "not-found", "move-back", "move-closer", "low-light", "glare", "hold-still"];
const LEGACY_HINTS = { "aim-at-document": "searching", "edges-not-found": "not-found", "fit-whole-page": "fit-whole-page", "low-light": "low-light" };
const LEGACY_ORDER = ["low-light", "not-found", "searching", "fit-whole-page"];

/**
 * The hint on screen over time: `[{ t, key }]` (page time; `key` null = none),
 * one entry per change. Legacy builds' several chips are reduced to one by
 * {@link LEGACY_ORDER}.
 */
export function hintSeries(record) {
  const shown = new Set();
  const series = [];
  let current = null;
  for (const e of record.events) {
    if (e.type !== "hint") continue;
    const key = HINT_KEYS.includes(e.key) ? e.key : (LEGACY_HINTS[e.key] ?? null);
    if (key === null) continue;
    if (e.shown) shown.add(key);
    else shown.delete(key);
    const next = HINT_KEYS.find((k) => shown.has(k) && !LEGACY_ORDER.includes(k)) ?? LEGACY_ORDER.find((k) => shown.has(k)) ?? null;
    if (next !== current) {
      current = next;
      // One hint replaced by another is one change: the old one's "gone"
      // and the new one's "shown" share their moment.
      const last = series[series.length - 1];
      if (last !== undefined && last.t === e.t) {
        series.pop();
        const before = series[series.length - 1];
        if (before === undefined ? next !== null : before.key !== next) series.push({ t: e.t, key: next });
      } else series.push({ t: e.t, key: next });
    }
  }
  return series;
}

/** The hint in force at page time `t` (null before any was shown). */
function hintAt(series, t) {
  let key = null;
  for (const entry of series) {
    if (entry.t > t) break;
    key = entry.key;
  }
  return key;
}

/**
 * Time-weighted over `[from, to]` (page time): the share the hint was one of
 * `expect` (`null` in it = no hint), the share it was another hint (wrong),
 * and none at all.
 */
export function hintWindow(series, { from, to, expect, conditionFrom }) {
  const cuts = [from, ...series.filter((e) => e.t > from && e.t < to).map((e) => e.t), to];
  let correct = 0;
  let wrong = 0;
  let none = 0;
  for (let i = 0; i < cuts.length - 1; i += 1) {
    const span = cuts[i + 1] - cuts[i];
    const key = hintAt(series, cuts[i]);
    if (expect.includes(key)) correct += span;
    else if (key === null) none += span;
    else wrong += span;
  }
  const total = to - from;
  const first = series.find((e) => e.t >= conditionFrom && expect.includes(e.key));
  const already = expect.includes(hintAt(series, conditionFrom));
  return {
    ms: total,
    share: rate(correct, total),
    wrongShare: rate(wrong, total),
    noneShare: rate(none, total),
    firstCorrectMs: already ? 0 : first === undefined || first.t > to ? null : first.t - conditionFrom,
  };
}

/** The overlay's ready cue over time, from the overlay samples (`ready`; absent = off). */
function readySeries(record, gtAt) {
  return record.events
    .filter((e) => e.type === "overlay")
    .map((e) => ({
      t: e.t,
      ready: e.ready === true,
      countdown: e.countdown ?? null,
      quad: e.quad !== null && e.opacity >= OVERLAY_SHOWN_OPACITY ? toPoints(e.quad) : null,
      gt: gtAt(e.t),
    }));
}

/** Which page of the script is the one being scanned at camera time `t`. */
function pageAt(script, t) {
  let page = script.primary?.[0]?.page ?? 0;
  for (const step of script.primary ?? []) if (t >= step.t) page = step.page;
  return page;
}

/**
 * The guidance a session showed: each scripted hint window (`marks.hints`),
 * the hint's churn, hints shown over a framed hold, the ready cue's precision
 * (cue-on time with the overlay on the page, within `LOCK_TOLERANCE`) and
 * recall (over `marks.ready`), the cue on a page-less frame, every automatic
 * capture (latency from the last `marks.stable` before it, the page it took,
 * during a tremor, a false fire) and whether the viewfinder's box ever moved.
 */
export function scoreGuidance(script, record, gtAt, captures) {
  const marks = script.marks ?? {};
  const t0 = record.startedAt;
  const at = (cameraMs) => t0 + cameraMs;
  const frame = script.frame;
  const series = hintSeries(record);
  const windows = (marks.hints ?? []).map((w) => ({
    name: w.name,
    expect: w.expect,
    ...hintWindow(series, { from: at(w.from), to: at(w.to), expect: w.expect, conditionFrom: at(w.conditionFrom ?? w.from) }),
  }));
  // Churn over the live viewfinder: from the camera going live to the end.
  const liveFrom = record.actions?.find((a) => a.what === "camera-live")?.at ?? t0;
  const liveTo = at(script.duration);
  const changes = series.filter((e) => e.t >= liveFrom && e.t <= liveTo);
  let fastChanges = 0;
  let minGapMs = null;
  for (let i = 1; i < changes.length; i += 1) {
    const gap = changes[i].t - changes[i - 1].t;
    minGapMs = minGapMs === null ? gap : Math.min(minGapMs, gap);
    if (gap < 1500) fastChanges += 1;
  }
  const liveSeconds = Math.max(0.001, (liveTo - liveFrom) / 1000);
  // Hints over framed holds, where none is owed (the default sessions' hold windows).
  const holds = [];
  if (marks.holdFrom !== undefined && marks.holdTo !== undefined) holds.push([marks.holdFrom, marks.holdTo]);
  if (marks.lockFrom2 !== undefined && marks.holdTo2 !== undefined) holds.push([marks.lockFrom2, marks.holdTo2]);
  let holdMs = 0;
  const holdShown = {};
  for (const [from, to] of holds) {
    const w = { from: at(from), to: at(to) };
    holdMs += w.to - w.from;
    const cuts = [w.from, ...series.filter((e) => e.t > w.from && e.t < w.to).map((e) => e.t), w.to];
    for (let i = 0; i < cuts.length - 1; i += 1) {
      const key = hintAt(series, cuts[i]);
      if (key !== null) holdShown[key] = (holdShown[key] ?? 0) + cuts[i + 1] - cuts[i];
    }
  }
  // The ready cue.
  const cue = readySeries(record, gtAt);
  const { intervals } = sampleTimeline(cue, { from: liveFrom, to: liveTo });
  const ready = { onMs: 0, judgedMs: 0, onPageMs: 0, offPageMs: 0, noPageMs: 0, eligibleMs: 0, eligibleOnMs: 0, countdownMs: 0 };
  const eligible = (marks.ready ?? []).map((w) => [at(w.from), at(w.to)]);
  for (const { from, to, sample } of intervals) {
    const span = to - from;
    for (const [a, b] of eligible) {
      const overlap = Math.max(0, Math.min(b, to) - Math.max(a, from));
      ready.eligibleMs += overlap;
      if (sample.ready) ready.eligibleOnMs += overlap;
    }
    if (!sample.ready) continue;
    ready.onMs += span;
    if (sample.countdown !== null) ready.countdownMs += span;
    if (sample.gt === undefined) continue;
    if (sample.gt === null) {
      ready.noPageMs += span;
      ready.judgedMs += span;
      continue;
    }
    if (sample.quad === null) continue;
    const error = visibleDistance(sample.quad, sample.gt, frame);
    if (error === null) continue;
    ready.judgedMs += span;
    if (error <= LOCK_TOLERANCE) ready.onPageMs += span;
    else ready.offPageMs += span;
  }
  // Automatic captures.
  const stable = (marks.stable ?? []).slice().sort((a, b) => a - b);
  const tremor = marks.tremor ?? [];
  // Where an automatic capture would take a bad image (the breaker
  // sessions' `noFire`: the page cut off, a hot spot on it, still moving),
  // and where a hint is owed (the hint windows): no capture is owed there.
  const noFire = marks.noFire ?? [];
  const hinted = marks.hints ?? [];
  const fires = captures
    .filter((c) => c.trigger === "auto")
    .map((c) => {
      const since = stable.filter((s) => s <= c.tapAt).pop();
      return {
        tapAt: c.tapAt,
        page: pageAt(script, c.tapAt),
        verdict: c.verdict,
        severe: c.severe,
        latencyMs: since === undefined ? null : c.tapAt - since,
        inTremor: tremor.some((w) => c.tapAt >= w.from && c.tapAt <= w.to),
        inNoFire: noFire.find((w) => c.tapAt >= w.from && c.tapAt <= w.to)?.name ?? null,
        inHintWindow: hinted.find((w) => !w.expect.some((k) => k === "searching" || k === "not-found") && c.tapAt >= w.from && c.tapAt <= w.to)?.name ?? null,
        falseFire: marks.pageless === true || c.pagelessCapture === true || c.verdict === "false positive" || c.verdict === PAGELESS_CAPTURE,
      };
    });
  const pages = marks.pageless ? 0 : (marks.pages ?? (marks.stable?.length > 0 ? 1 : 0));
  const firedPages = new Set(fires.filter((f) => !f.falseFire).map((f) => f.page));
  // The viewfinder's box while live.
  const boxes = (record.boxes ?? []).filter((b) => b.at >= liveFrom && b.at <= liveTo);
  let shiftPx = 0;
  let shifts = 0;
  if (boxes.length > 0) {
    const b0 = boxes[0];
    for (const b of boxes) {
      const d = Math.max(Math.abs(b.x - b0.x), Math.abs(b.y - b0.y), Math.abs(b.width - b0.width), Math.abs(b.height - b0.height));
      shiftPx = Math.max(shiftPx, d);
      if (d > 0.5) shifts += 1;
    }
  }
  return {
    windows,
    changes: changes.length,
    changesPerSecond: changes.length / liveSeconds,
    liveSeconds,
    fastChanges,
    minGapMs,
    holdMs,
    holdHintMs: holdShown,
    ready: {
      ...ready,
      precision: rate(ready.onPageMs, ready.judgedMs),
      recall: rate(ready.eligibleOnMs, ready.eligibleMs),
    },
    auto: {
      on: (record.actions ?? []).some((a) => a.what === "auto-on"),
      fires,
      falseFires: fires.filter((f) => f.falseFire).length,
      firesDuringTremor: fires.filter((f) => f.inTremor).length,
      firesInNoFire: fires.filter((f) => f.inNoFire !== null).length,
      firesInHintWindow: fires.filter((f) => f.inHintWindow !== null).length,
      pages,
      pagesFired: firedPages.size,
      repeatFires: Math.max(0, fires.filter((f) => !f.falseFire).length - firedPages.size),
    },
    layout: { samples: boxes.length, shifts, maxShiftPx: shiftPx },
  };
}

/* ── the visible region: what the person can see (Phase 5a) ─────────────── */

/** Step of the time grid the visible-region scores sample (ms). */
const VIS_STEP_MS = 50;
/** The overlay reports at least every 100 ms while the live loop runs; silence past this is no viewfinder. */
const CUE_SILENT_MS = 300;

/**
 * "Clearly inside": every corner at least this far in from the region's
 * edges (a share of its width and height) — the app's own exit threshold for
 * "Afaste um pouco" (`BORDER_EXIT`, `src/lib/guidance.ts`). A page closer to
 * the edge than that is *tight*: the hint may rightly still be up there
 * (hysteresis, a detector a few pixels out), so it counts neither as a false
 * "Afaste" nor as a right one.
 */
export const VIS_CLEAR_MARGIN = 0.03;

/** Every corner of `quad` at least `share` of the region's own width/height inside it. */
export function clearlyInside(quad, region, share = VIS_CLEAR_MARGIN) {
  const mx = share * region.width;
  const my = share * region.height;
  return quad.every(
    ([x, y]) => x >= region.x + mx && x <= region.x + region.width - mx && y >= region.y + my && y <= region.y + region.height - my,
  );
}

/**
 * The visible region at page time `t`: the last `regions` sample the page
 * measured at or before it (`page-session.js`: the video's content box, its
 * clips and the layout's declared occluders), else the crop the page measured
 * as the camera went live (`record.visible`), else the whole frame.
 */
export function regionAt(record) {
  const regions = record.regions ?? [];
  const fallback = record.visible ?? { x: 0, y: 0, width: 1, height: 1 };
  return (t) => {
    let lo = 0;
    let hi = regions.length - 1;
    if (hi < 0 || regions[0].at > t) return regions[0] ?? fallback;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (regions[mid].at <= t) lo = mid;
      else hi = mid - 1;
    }
    return regions[lo];
  };
}

/** Every corner of `quad` (`[[x, y] × 4]`, frame fractions) inside `region`, `margin` in from its edges (fractions of the frame). */
/**
 * The opaque controls over the picture at a region sample (`blocks`, frame
 * fractions, measured by the page independently of what the app declares:
 * `page-session.js`) — does one of them sit on a corner of `quad`?
 */
export function cornerBlocked(quad, region) {
  const blocks = region.blocks ?? [];
  return quad.some(([x, y]) => blocks.some((b) => x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height));
}

/** Every corner inside the region and under no opaque control. */
export function visibleOnScreen(quad, region) {
  return insideRegion(quad, region) && !cornerBlocked(quad, region);
}

export function insideRegion(quad, region, margin = 0) {
  return quad.every(
    ([x, y]) =>
      x >= region.x + margin && x <= region.x + region.width - margin && y >= region.y + margin && y <= region.y + region.height - margin,
  );
}

/**
 * The page against the part of the frame the person can see:
 *
 * - `holds` — each framed hold (`marks.ready` windows where a script has
 *   them, else the default sessions' `holdFrom…holdTo` and
 *   `lockFrom2…holdTo2`): whether the ready cue came on in it (`reached`),
 *   the share of it the whole page was visible, and "Afaste um pouco" shown
 *   while the whole page was clearly visible ({@link clearlyInside};
 *   `moveBackFalseMs` over `clearMs`) or
 *   while it was not (`moveBackRightMs` over `hiddenMs`);
 * - `ready` — every displayed instant (every VIS_STEP_MS) with the ready
 *   cue on, judged against the truth on screen: `violations` where a corner
 *   of the page lay outside the visible region or under an opaque control
 *   (`blocked`), or where there was no page at all (`pageless`); and the
 *   same at the cue's onsets. A hold is `reached` only from an onset of its
 *   own page with the whole page on screen (a cue carried over from the
 *   sheet before does not count);
 * - `auto` — automatic captures whose page has a corner outside the image
 *   that became it, and how many of those the app flagged;
 * - `area` — the visible region's size as a share of the viewport (the
 *   camera the person perceives), median over the live run.
 */
export function scoreVisibility(script, record, gtAt, captures) {
  const marks = script.marks ?? {};
  const t0 = record.startedAt;
  const at = (cameraMs) => t0 + cameraMs;
  const region = regionAt(record);
  const series = hintSeries(record);
  const windows =
    (marks.ready ?? []).length > 0
      ? marks.ready.map((w) => [w.from, w.to])
      : [
          ...(marks.holdFrom !== undefined && marks.holdTo !== undefined ? [[marks.holdFrom, marks.holdTo]] : []),
          ...(marks.lockFrom2 !== undefined && marks.holdTo2 !== undefined ? [[marks.lockFrom2, marks.holdTo2]] : []),
        ];
  // A report frozen by a capture in flight (`capturing`) is the tapped
  // photo's marks held still, not a cue inviting one: no cue.
  const cue = record.events.filter((e) => e.type === "overlay").map((e) => ({ t: e.t, ready: e.ready === true && e.capturing !== true }));
  // The cue as displayed at `t`: the overlay's last report, while it is
  // still reporting (every ≤ 100 ms while the loop runs). A longer silence
  // is a viewfinder that is not on screen — a confirm screen over it, the
  // loop stopped — and shows no cue.
  const readyAt = (t) => {
    let last = null;
    for (const s of cue) {
      if (s.t > t) break;
      last = s;
    }
    return last !== null && last.ready && t - last.t <= CUE_SILENT_MS;
  };
  // Where the cue came ON (its onsets), from the overlay's reports.
  const onsets = [];
  {
    let previous = false;
    for (const s of cue) {
      if (s.ready && !previous) onsets.push(s.t);
      previous = s.ready;
    }
  }
  /** Every corner of the truth on screen at `t` inside the region and clear of every opaque control. */
  const seenWhole = (t) => {
    const gt = gtAt(t);
    if (gt === undefined || gt === null) return false;
    return visibleOnScreen(toPoints(gt), region(t));
  };
  const holds = windows.map(([from, to], index) => {
    const w = { ms: 0, readyMs: 0, visibleMs: 0, hiddenMs: 0, clearMs: 0, moveBackFalseMs: 0, moveBackRightMs: 0, unknownMs: 0 };
    // A hold is "ready" only from a cue onset of ITS page: after the previous
    // hold ended (a cue carried over from the sheet before is not this
    // one's), before this one ends, with all four corners of the page on
    // screen at that onset (review finding 8).
    const pageSince = index === 0 ? Number.NEGATIVE_INFINITY : at(windows[index - 1][1]);
    const onset = onsets.find((t) => t > pageSince && t < at(to) && seenWhole(t)) ?? null;
    for (let t = at(from); t < at(to); t += VIS_STEP_MS) {
      w.ms += VIS_STEP_MS;
      if (onset !== null && t >= onset && readyAt(t)) w.readyMs += VIS_STEP_MS;
      const gt = gtAt(t);
      if (gt === undefined || gt === null) {
        w.unknownMs += VIS_STEP_MS;
        continue;
      }
      const r = region(t);
      const visible = visibleOnScreen(toPoints(gt), r);
      const moveBack = hintAt(series, t) === "move-back";
      if (visible) {
        w.visibleMs += VIS_STEP_MS;
        if (clearlyInside(toPoints(gt), r)) {
          w.clearMs += VIS_STEP_MS;
          if (moveBack) w.moveBackFalseMs += VIS_STEP_MS;
        }
      } else {
        w.hiddenMs += VIS_STEP_MS;
        if (moveBack) w.moveBackRightMs += VIS_STEP_MS;
      }
    }
    return {
      from,
      to,
      ...w,
      onsetAt: onset === null ? null : onset - t0,
      reached: w.readyMs > 0,
      visibleShare: rate(w.visibleMs, w.visibleMs + w.hiddenMs),
      moveBackFalseShare: rate(w.moveBackFalseMs, w.clearMs),
    };
  });
  // The cue as displayed, every VIS_STEP_MS from the first report to the
  // last (not only at the overlay's reports): each instant it is on is
  // judged against the truth on screen. A page-less instant with the cue on
  // is a violation too (`pageless`); an instant with no truth is not judged.
  const ready = { samples: 0, violations: 0, pageless: 0, blocked: 0, onsets: 0, onsetViolations: 0, worstOutside: 0 };
  const judge = (t) => {
    const gt = gtAt(t);
    if (gt === undefined) return null;
    if (gt === null) return { ok: false, pageless: true, blocked: false, outside: 0 };
    const quad = toPoints(gt);
    const r = region(t);
    const inside = insideRegion(quad, r);
    const clear = inside && !cornerBlocked(quad, r);
    const outside = inside ? 0 : Math.max(...quad.map(([x, y]) => Math.max(r.x - x, x - (r.x + r.width), r.y - y, y - (r.y + r.height))));
    return { ok: clear, pageless: false, blocked: inside && !clear, outside };
  };
  if (cue.length > 0) {
    for (let t = cue[0].t; t <= cue[cue.length - 1].t; t += VIS_STEP_MS) {
      if (!readyAt(t)) continue;
      const j = judge(t);
      if (j === null) continue;
      ready.samples += 1;
      if (j.ok) continue;
      ready.violations += 1;
      if (j.pageless) ready.pageless += 1;
      if (j.blocked) ready.blocked += 1;
      ready.worstOutside = Math.max(ready.worstOutside, j.outside);
    }
  }
  for (const t of onsets) {
    const j = judge(t);
    if (j === null) continue;
    ready.onsets += 1;
    if (!j.ok) ready.onsetViolations += 1;
  }
  const autos = captures.filter((c) => c.trigger === "auto");
  const outside = autos.filter((c) => c.cornerOutside === true);
  const liveFrom = record.actions?.find((a) => a.what === "camera-live")?.at ?? t0;
  const areas = (record.regions ?? [])
    .filter((r) => r.at >= liveFrom && r.viewW > 0 && r.viewH > 0)
    .map((r) => (r.cssW * r.cssH) / (r.viewW * r.viewH))
    .sort((a, b) => a - b);
  const last = (record.regions ?? []).at(-1) ?? null;
  return {
    holds,
    ready,
    auto: {
      fires: autos.length,
      cornerOutside: outside.length,
      cornerOutsideFlagged: outside.filter((c) => c.attention !== null).length,
      flagged: autos.filter((c) => c.attention !== null).length,
    },
    area: areas.length === 0 ? null : areas[Math.floor(areas.length / 2)],
    region: last === null ? (record.visible ?? null) : { x: last.x, y: last.y, width: last.width, height: last.height, fit: last.fit },
  };
}

/* ── framing: how close the page is held, and what that gives the PDF ──── */

/**
 * The app's "too far" line (`FILL_ENTER` / `FILL_EXIT`, `src/lib/guidance.ts`,
 * mirrored by the emulator's `FOLLOW_RULES.fill`) and the share past it the
 * scorer counts a page as plainly big enough — "Aproxime" shown over such a
 * page is a wrong hint (the hysteresis and a detector a few pixels out
 * excuse anything closer to the line).
 */
export const FRAMING_RULE = FOLLOW_RULES.fill;
export const FRAMING_CLEAR = 0.03;
/** "Aproxime mais um pouco" from this fill up (`FILL_NEAR`). */
export const FRAMING_NEAR = 0.6;

/**
 * The phone the PDF's resolution is reported for: the Galaxy S25 Ultra's
 * still (4080×3060), cut to the preview's field of view — 2295×4080 for a
 * 9:16 stream, 3060×4080 for 3:4 (the owner's field run). The page's pixels
 * in the PDF are its edges' lengths in that crop.
 */
export const FIELD_STILL_LONG = 4080;
export const FIELD_STILL_SHORT = 3060;
/** A4's short side, inches: the PDF's dpi for an A4 page. */
const A4_SHORT_IN = 210 / 25.4;

/** A truth quad (`[[x, y] × 4]`, frame fractions) in fractions of `region`. */
function inRegionPoints(points, region) {
  return points.map(([x, y]) => [(x - region.x) / region.width, (y - region.y) / region.height]);
}

/**
 * The page's size in the field phone's still (cut to the preview's field of
 * view, `frame` the stream's shape): the longer of each pair of opposite
 * edges, as the warp makes it — `{ short, long }` px.
 */
export function fieldPagePixels(points, frame) {
  const portrait = frame.height >= frame.width;
  const aspect = portrait ? frame.width / frame.height : frame.height / frame.width;
  const shortPx = Math.min(FIELD_STILL_SHORT, FIELD_STILL_LONG * aspect);
  const [w, h] = portrait ? [shortPx, FIELD_STILL_LONG] : [FIELD_STILL_LONG, shortPx];
  const edge = (a, b) => Math.hypot((b[0] - a[0]) * w, (b[1] - a[1]) * h);
  const [tl, tr, br, bl] = points;
  const across = Math.max(edge(tl, tr), edge(bl, br));
  const down = Math.max(edge(tl, bl), edge(tr, br));
  return { short: Math.min(across, down), long: Math.max(across, down) };
}

/**
 * Framing over each hold (the windows {@link scoreVisibility} judges, from
 * when the page was *presented* — a hold the scripted user came in on,
 * `marks.follow`, counts from before the approach):
 *
 * - `fillAtStart` / `fillAtReady` — the page's fill (its reach along the
 *   visible region's limiting axis, as the app measures it) when presented
 *   and when the ready cue came on; `toReadyMs` — presented → cue on;
 * - `closerMs` "Aproxime" shown, `closerWrongMs` shown over a page plainly
 *   big enough ({@link FRAMING_CLEAR} past the exit line), `moveBackMs`
 *   "Afaste um pouco" shown, `otherMs` any other hint, `changes` the hint's
 *   changes inside the hold;
 * - the session's "Aproxime" onsets with the page's fill then (`closerOnsets`)
 *   — near ones get "Aproxime mais um pouco";
 * - every capture: the page's fill at the tap and its size in the field
 *   phone's still ({@link fieldPagePixels}) and the dpi that is for A4.
 */
export function scoreFraming(script, record, gtAt, captures, visibility) {
  const marks = script.marks ?? {};
  const t0 = record.startedAt;
  const at = (cameraMs) => t0 + cameraMs;
  const region = regionAt(record);
  const series = hintSeries(record);
  const follow = marks.follow ?? [];
  const fillAt = (t) => {
    const gt = gtAt(t);
    if (gt === undefined || gt === null) return null;
    return framingMeasure("fill", inRegionPoints(toPoints(gt), region(t)));
  };
  const holds = (visibility?.holds ?? []).map((h) => {
    const approach = follow.find((f) => f.arriveAt === h.from || f.from === h.from) ?? null;
    const presented = approach === null ? h.from : approach.from;
    const w = { closerMs: 0, closerWrongMs: 0, moveBackMs: 0, otherMs: 0, ms: 0 };
    for (let t = at(presented); t < at(h.to); t += 50) {
      w.ms += 50;
      const key = hintAt(series, t);
      if (key === null) continue;
      if (key === "move-closer") {
        w.closerMs += 50;
        const fill = fillAt(t);
        if (fill !== null && fill >= FRAMING_RULE.exit + FRAMING_CLEAR) w.closerWrongMs += 50;
      } else if (key === "move-back") w.moveBackMs += 50;
      else w.otherMs += 50;
    }
    const changes = series.filter((e) => e.t > at(presented) && e.t < at(h.to)).length;
    return {
      from: presented,
      to: h.to,
      approached: approach?.approached === true,
      approach,
      fillAtStart: fillAt(at(presented)),
      reached: h.reached,
      toReadyMs: h.onsetAt === null ? null : Math.max(0, h.onsetAt - presented),
      fillAtReady: h.onsetAt === null ? null : fillAt(at(h.onsetAt)),
      changes,
      ...w,
    };
  });
  const closerOnsets = series.filter((e) => e.key === "move-closer").map((e) => ({ t: e.t - t0, fill: fillAt(e.t) }));
  const shots = captures.map((c) => {
    const gt = gtAt(at(c.tapAt));
    if (gt === undefined || gt === null) return { trigger: c.trigger, tapAt: c.tapAt, fill: null, px: null, dpi: null };
    const points = toPoints(gt);
    const px = fieldPagePixels(points, script.frame);
    return { trigger: c.trigger, tapAt: c.tapAt, fill: fillAt(at(c.tapAt)), px, dpi: px.short / A4_SHORT_IN };
  });
  return { rule: FRAMING_RULE, holds, closerOnsets, captures: shots };
}
