/**
 * What the bench measures, as pure functions over corners and time series.
 *
 * The headline is **the page the user receives**: would the crop the detector
 * proposed have been wrong ({@link WRONG_CROP_MIN_IOU},
 * {@link WRONG_CROP_MAX_CORNER_ERROR}), would it have cut content off
 * ({@link CLIPPED_MAX_FRACTION}) or carried desk into the page
 * ({@link LOOSE_MAX_FRACTION}). IoU and corner error are diagnostics under
 * those, never blended into one "accuracy" number.
 *
 * Conventions, shared with the emulator and the labels file:
 *
 * - a quad is four `[x, y]` points, **normalized** to the frame (0–1 on each
 *   axis), nominally TL, TR, BR, BL — but detectors and humans disagree about
 *   which corner is "top-left" on a rotated page, so every comparison first finds
 *   the best cyclic correspondence ({@link matchCorners});
 * - distances are in pixels of the frame and reported as a **fraction of the
 *   frame diagonal**, so a 1080×1920 run and a 1920×1080 run read the same;
 * - a frame is `{ width, height }` in pixels.
 *
 * No DOM, no I/O: unit-tested in `metrics.test.mjs`.
 */

/** Below this IoU with the true page, a proposed crop is wrong. */
export const WRONG_CROP_MIN_IOU = 0.9;

/** Any corner farther than this (fraction of the frame diagonal) and the crop is wrong. */
export const WRONG_CROP_MAX_CORNER_ERROR = 0.03;

/** More of the true page than this outside the proposed quad: content was clipped. */
export const CLIPPED_MAX_FRACTION = 0.01;

/** More than this much non-page area inside the proposed quad (fraction of the page's area): loose. */
export const LOOSE_MAX_FRACTION = 0.03;

/** A displayed quad within this much of the truth (fraction of the diagonal) counts as locked. */
export const LOCK_TOLERANCE = 0.02;

/** …and has to stay there this long before the lock counts. */
export const LOCK_HOLD_MS = 300;

/**
 * Two consecutive samples of the viewfinder farther apart than this leave the
 * time between them **unobserved**: nothing may be concluded about it — not a
 * lock held through it, not an overlay that left in it. The probe samples the
 * overlay every ~100 ms while the loop runs.
 */
export const MAX_SAMPLE_GAP_MS = 250;

/**
 * More than this share of any content box's visible area outside the crop:
 * content was clipped. Tiny on purpose — a crop edge that reaches into a line
 * of text has already eaten the whole margin.
 */
export const CONTENT_CLIP_MIN_FRACTION = 0.01;

/**
 * The content boxes a crop may not cut: printed text, text that identifies a
 * patient or a document (names, dates, protocol numbers, barcodes), and marks
 * made by hand or machine (signatures, handwriting, ticks). Layout — rules,
 * bands, box outlines, fills — may be trimmed with the margin.
 */
export const CONTENT_KINDS = new Set(["text", "identifier", "mark"]);

/** Normalized quad → pixel points. */
export function toPixels(quad, frame) {
  return quad.map(([x, y]) => [x * frame.width, y * frame.height]);
}

export function frameDiagonal(frame) {
  return Math.hypot(frame.width, frame.height);
}

/** Signed shoelace area: positive for counter-clockwise in a y-up plane. */
export function signedArea(points) {
  let doubled = 0;
  for (let index = 0; index < points.length; index += 1) {
    const [ax, ay] = points[index];
    const [bx, by] = points[(index + 1) % points.length];
    doubled += ax * by - bx * ay;
  }
  return doubled / 2;
}

export function polygonArea(points) {
  return Math.abs(signedArea(points));
}

function segmentsCross(a, b, c, d) {
  const orient = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0;
}

/**
 * A quad whose edges cross itself (a "bow-tie") or has no area: its area and
 * its IoU are not meaningful, and the crop it describes is not a page.
 */
export function isDegenerateQuad(points, minArea = 1e-9) {
  if (points.length !== 4) return true;
  if (polygonArea(points) <= minArea) return true;
  return segmentsCross(points[0], points[1], points[2], points[3]) ||
    segmentsCross(points[1], points[2], points[3], points[0]);
}

/**
 * Sutherland–Hodgman: the part of `subject` inside the convex polygon `clip`.
 * The subject may be concave; the clip must be convex (a true page is: it is a
 * projected rectangle).
 */
export function clipPolygon(subject, clip) {
  // Normalize the clip polygon's winding so "inside" is always the same side.
  const ccw = signedArea(clip) > 0 ? clip : [...clip].reverse();
  let output = subject;
  for (let index = 0; index < ccw.length && output.length > 0; index += 1) {
    const a = ccw[index];
    const b = ccw[(index + 1) % ccw.length];
    const inside = (p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0;
    const intersect = (p, q) => {
      const dx1 = q[0] - p[0];
      const dy1 = q[1] - p[1];
      const dx2 = b[0] - a[0];
      const dy2 = b[1] - a[1];
      const denominator = dx1 * dy2 - dy1 * dx2;
      if (denominator === 0) return q;
      const t = ((a[0] - p[0]) * dy2 - (a[1] - p[1]) * dx2) / denominator;
      return [p[0] + t * dx1, p[1] + t * dy1];
    };
    const input = output;
    output = [];
    for (let k = 0; k < input.length; k += 1) {
      const current = input[k];
      const previous = input[(k + input.length - 1) % input.length];
      if (inside(current)) {
        if (!inside(previous)) output.push(intersect(previous, current));
        output.push(current);
      } else if (inside(previous)) {
        output.push(intersect(previous, current));
      }
    }
  }
  return output;
}

/** Area of `a ∩ b`, `b` convex. */
export function intersectionArea(a, b) {
  const clipped = clipPolygon(a, b);
  return clipped.length < 3 ? 0 : polygonArea(clipped);
}

/**
 * The correspondence between two quads that minimizes the summed squared
 * corner distance, over the four rotations and both windings.
 *
 * @returns {{ matched: number[][], shift: number, reversed: boolean }} `matched`
 *   is `detected` reordered so `matched[i]` pairs with `truth[i]`.
 */
export function matchCorners(detected, truth) {
  let best = null;
  for (const reversed of [false, true]) {
    const base = reversed ? [...detected].reverse() : detected;
    for (let shift = 0; shift < 4; shift += 1) {
      const candidate = [0, 1, 2, 3].map((i) => base[(i + shift) % 4]);
      let cost = 0;
      for (let i = 0; i < 4; i += 1) {
        cost += (candidate[i][0] - truth[i][0]) ** 2 + (candidate[i][1] - truth[i][1]) ** 2;
      }
      if (best === null || cost < best.cost) best = { matched: candidate, shift, reversed, cost };
    }
  }
  return { matched: best.matched, shift: best.shift, reversed: best.reversed };
}

/**
 * A quad relabelled the way the library labels one (`src/lib/quad.ts`):
 * clockwise on the image (y down) from the corner nearest the image's top-left.
 * Pixel points in, pixel points out. A detector that follows the page names
 * its corners by where they are in the image, not by which way the print
 * reads — so a page the camera sees sideways is judged against this order,
 * not against the page's own.
 */
export function imageOrder(points) {
  const clockwise = signedArea(points) >= 0 ? points : [...points].reverse();
  let first = 0;
  for (let i = 1; i < 4; i += 1) {
    if (clockwise[i][0] + clockwise[i][1] < clockwise[first][0] + clockwise[first][1]) first = i;
  }
  return [0, 1, 2, 3].map((i) => clockwise[(first + i) % 4]);
}

/**
 * Whether a quad's corner **order** is one the warp can use: the geometry may
 * be spot on and the page still come out mirrored (the corners run the other
 * way round) or turned (the corner named top-left is another one). `rotation`
 * is how many corners the naming is shifted by against {@link imageOrder} of
 * the truth; `wrong` when mirrored or shifted. Normalized quads and a frame.
 */
export function cornerOrder(detected, truth, frame) {
  const det = toPixels(detected, frame);
  const expected = imageOrder(toPixels(truth, frame));
  const { shift, reversed } = matchCorners(det, expected);
  return { mirrored: reversed, rotation: reversed ? null : shift, wrong: reversed || shift !== 0 };
}

/** Per-corner error after matching, each as a fraction of the frame diagonal. */
export function cornerErrors(detected, truth, frame) {
  const det = toPixels(detected, frame);
  const gt = toPixels(truth, frame);
  const { matched } = matchCorners(det, gt);
  const diagonal = frameDiagonal(frame);
  return matched.map((p, i) => Math.hypot(p[0] - gt[i][0], p[1] - gt[i][1]) / diagonal);
}

function framePolygon(frame) {
  return [
    [0, 0],
    [frame.width, 0],
    [frame.width, frame.height],
    [0, frame.height],
  ];
}

/** How far past the frame's edge a corner may sit and still count as in it (normalized; rounding). */
const IN_FRAME_EPSILON = 1e-6;

/**
 * Which of a normalized quad's corners lie inside the frame (edges included) —
 * the same test the emulator's `inFrame` flags make.
 */
export function cornersInFrame(quad) {
  return quad.map(
    ([x, y]) =>
      x >= -IN_FRAME_EPSILON &&
      y >= -IN_FRAME_EPSILON &&
      x <= 1 + IN_FRAME_EPSILON &&
      y <= 1 + IN_FRAME_EPSILON,
  );
}

/**
 * A quad with a corner off the image — a `NormalizedQuad` is 0–1 on each axis,
 * and one outside it seeds the confirm screen's handle off the picture.
 */
export function offImage(quad) {
  return quad !== null && quad !== undefined && !cornersInFrame(quad).every(Boolean);
}

/** Largest of `errors` where `judged[i]`; `null` when none is judged. */
function judgedMax(errors, judged) {
  const kept = errors.filter((_, i) => judged[i]);
  return kept.length > 0 ? Math.max(...kept) : null;
}

/**
 * Scores one detector answer against the truth for one frame.
 *
 * `detected` is the quad the variant would have handed on (after its own
 * gates) or `null`; `truth` is the page's quad or `null` for a scene with no
 * document.
 *
 * **A page cut off by the frame is judged on what the frame shows.** The crop
 * is taken of the image, so nothing outside it can reach the user: both quads
 * are clipped to the frame before the area terms (IoU, clipped, loose), and a
 * true corner outside the frame is reported (`cornerErrors`,
 * `maxCornerErrorAll`) but not judged — nobody can see where it is, and a
 * detector that follows the page to the frame's edge and one that extrapolates
 * the hidden corner exactly are both right. `maxCornerError` and
 * `meanCornerError` are over the corners the frame shows (`null` when it shows
 * none: then only the area terms decide).
 *
 * **The corner order counts** ({@link cornerOrder}): a quad whose corners run
 * the wrong way round, or start at the wrong corner, warps the page mirrored or
 * turned however well it fits — `wrongCrop` with `orderWrong`.
 *
 * **Content** ({@link contentClipping}): with `content` — the page's text,
 * identifier and mark boxes, normalized to the frame, when the truth knows
 * them (the emulator's does; a hand label does not) — `contentClipped` says
 * whether the crop cut into any of them, and `severe` is `wrongCrop ||
 * contentClipped`. `clipped` stays the page-area measure; `marginClipped` is
 * page lost without content lost. Without content these are `null`: unknown,
 * never "fine".
 */
export function scoreDetection(detected, truth, frame, { content = null } = {}) {
  if (truth === null) {
    return { hasTruth: false, detected: detected !== null, falsePositive: detected !== null };
  }
  if (detected === null) {
    return { hasTruth: true, detected: false, miss: true };
  }
  const box = framePolygon(frame);
  const det = toPixels(detected, frame);
  const gt = clipPolygon(toPixels(truth, frame), box);
  const gtArea = gt.length < 3 ? 0 : polygonArea(gt);
  const degenerate = isDegenerateQuad(det);
  const detIn = degenerate ? [] : clipPolygon(det, box);
  const detArea = detIn.length < 3 ? 0 : polygonArea(detIn);
  const overlap = detArea === 0 || gtArea === 0 ? 0 : intersectionArea(detIn, gt);
  const union = detArea + gtArea - overlap;
  const iou = union > 0 ? overlap / union : 0;
  const errors = cornerErrors(detected, truth, frame);
  const inFrame = cornersInFrame(truth);
  const judged = errors.filter((_, i) => inFrame[i]);
  const maxCornerError = judgedMax(errors, inFrame);
  const meanCornerError = judged.length > 0 ? judged.reduce((sum, e) => sum + e, 0) / judged.length : null;
  const clippedFraction = gtArea > 0 ? (gtArea - overlap) / gtArea : 1;
  const looseFraction = gtArea > 0 ? Math.max(0, detArea - overlap) / gtArea : 0;
  const order = cornerOrder(detected, truth, frame);
  const wrongCrop =
    degenerate ||
    iou < WRONG_CROP_MIN_IOU ||
    (maxCornerError !== null && maxCornerError > WRONG_CROP_MAX_CORNER_ERROR) ||
    order.wrong;
  const clipped = clippedFraction > CLIPPED_MAX_FRACTION;
  const contentScore = degenerate || content === null || content === undefined ? null : contentClipping(detected, content, frame);
  const contentClipped = contentScore === null ? null : contentScore.clipped;
  return {
    hasTruth: true,
    detected: true,
    miss: false,
    degenerate,
    iou,
    cornerErrors: errors,
    cornersInFrame: inFrame,
    maxCornerError,
    maxCornerErrorAll: Math.max(...errors),
    meanCornerError,
    clippedFraction,
    looseFraction,
    clipped,
    loose: looseFraction > LOOSE_MAX_FRACTION,
    order,
    orderWrong: order.wrong,
    wrongCrop,
    content: contentScore,
    contentClipped,
    marginClipped: contentClipped === null ? null : clipped && !contentClipped,
    severe: wrongCrop || contentClipped === true ? true : contentClipped === null ? null : false,
  };
}

/** Whether a simple polygon is convex (either winding). */
function isConvex(points) {
  let sign = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [ax, ay] = points[i];
    const [bx, by] = points[(i + 1) % points.length];
    const [cx, cy] = points[(i + 2) % points.length];
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (Math.abs(cross) < 1e-12) continue;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return true;
}

/**
 * Area of `subject` inside a simple quad, convex or not: a concave quad is
 * split along its inner diagonal into two triangles, each convex.
 */
function areaInsideQuad(subject, quad) {
  if (isConvex(quad)) return intersectionArea(subject, quad);
  const [a, b, c, d] = quad;
  const s1 = signedArea([a, b, c]);
  const s2 = signedArea([a, c, d]);
  const halves = Math.sign(s1) === Math.sign(s2) ? [[a, b, c], [a, c, d]] : [[b, c, d], [b, d, a]];
  return halves.reduce((sum, triangle) => sum + intersectionArea(subject, triangle), 0);
}

/**
 * How much of the page's content a crop cut off. `content` is the truth's
 * content boxes — `[{ kind, polygon }]`, each polygon normalized to the frame
 * (a projected box: four corners, more where the page curls). Each box is
 * judged on its part inside the frame (the frame lost the rest, not the crop):
 * the share of that part outside `detected`. A box of a
 * {@link CONTENT_KINDS} kind losing more than {@link CONTENT_CLIP_MIN_FRACTION}
 * clips content; `identifierClipped` names the worst case.
 *
 * @returns {{ boxes: number, judged: number, clippedBoxes: number, clipped: boolean,
 *   identifierClipped: boolean, maxLostFraction: number | null, byKind: object }}
 */
export function contentClipping(detected, content, frame) {
  const box = framePolygon(frame);
  const det = toPixels(detected, frame);
  let judged = 0;
  let clippedBoxes = 0;
  let identifierClipped = false;
  let maxLost = null;
  const byKind = {};
  for (const item of content) {
    if (!CONTENT_KINDS.has(item.kind)) continue;
    const visible = clipPolygon(toPixels(item.polygon, frame), box);
    const area = visible.length < 3 ? 0 : polygonArea(visible);
    if (area <= 0) continue;
    judged += 1;
    const kept = areaInsideQuad(visible, det);
    const lost = Math.max(0, Math.min(1, (area - kept) / area));
    maxLost = maxLost === null ? lost : Math.max(maxLost, lost);
    const kind = (byKind[item.kind] ??= { boxes: 0, clipped: 0 });
    kind.boxes += 1;
    if (lost > CONTENT_CLIP_MIN_FRACTION) {
      clippedBoxes += 1;
      kind.clipped += 1;
      if (item.kind === "identifier") identifierClipped = true;
    }
  }
  return {
    boxes: content.length,
    judged,
    clippedBoxes,
    clipped: clippedBoxes > 0,
    identifierClipped,
    maxLostFraction: maxLost,
    byKind,
  };
}

/** Largest matched corner distance between two normalized quads, fraction of the diagonal. */
export function quadDistance(a, b, frame) {
  return Math.max(...cornerErrors(a, b, frame));
}

/**
 * {@link quadDistance} over the truth's corners the frame shows — `null` when
 * it shows none. The one visible-content rule: a shown quad is judged by the
 * same corners a crop is ({@link scoreDetection}), never against a corner
 * nobody can see.
 */
export function visibleDistance(quad, truth, frame) {
  return judgedMax(cornerErrors(quad, truth, frame), cornersInFrame(truth));
}

/** Nearest-rank percentile of an unsorted list; `null` when empty. */
export function percentile(values, p) {
  const finite = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (finite.length === 0) return null;
  const rank = Math.min(finite.length - 1, Math.max(0, Math.ceil((p / 100) * finite.length) - 1));
  return finite[rank];
}

export function mean(values) {
  const finite = values.filter((v) => Number.isFinite(v));
  return finite.length === 0 ? null : finite.reduce((s, v) => s + v, 0) / finite.length;
}

/** `part / whole`, `null` when there is no whole. */
export function rate(part, whole) {
  return whole > 0 ? part / whole : null;
}

/* ── time series: the viewfinder, sampled ───────────────────────────────────
 *
 * A series is `[{ t, quad, gt }]` in time order: `t` in ms, `quad` the quad the
 * viewfinder displayed (normalized, or null when nothing was drawn) and `gt`
 * the true page quad on the frame that was on screen then (or null) —
 * `undefined` when it is not known which frame that was.
 *
 * Samples are not exposure: the probe reports the overlay on a ~100 ms beat
 * and on every change, so a sample holds **until the next one**, and a gap
 * longer than {@link MAX_SAMPLE_GAP_MS} is time nobody saw. Every function
 * here says so rather than guessing: a hold is not held through a gap, a quad
 * that left the old page is not assumed to have left in one.
 */

function within(sample, frame, tolerance) {
  if (sample.quad === null || sample.gt === null || sample.gt === undefined) return false;
  const distance = visibleDistance(sample.quad, sample.gt, frame);
  return distance !== null && distance <= tolerance;
}

/**
 * Time to lock: from `from` (the page is fully in view and the camera still)
 * to the first moment the displayed quad stays within `tolerance` of the
 * truth for at least `holdMs` — **observed** throughout: every sample of the
 * hold within tolerance, one at or past `holdMs` included, none of them more
 * than `maxGapMs` after the one before. `null` if it never does.
 */
export function timeToLock(
  series,
  { from, frame, tolerance = LOCK_TOLERANCE, holdMs = LOCK_HOLD_MS, maxGapMs = MAX_SAMPLE_GAP_MS },
) {
  const samples = series.filter((s) => s.t >= from);
  for (let start = 0; start < samples.length; start += 1) {
    if (!within(samples[start], frame, tolerance)) continue;
    const startT = samples[start].t;
    for (let k = start + 1; k < samples.length; k += 1) {
      if (samples[k].t - samples[k - 1].t > maxGapMs) break;
      if (!within(samples[k], frame, tolerance)) break;
      if (samples[k].t - startT >= holdMs) return startT - from;
    }
  }
  return null;
}

/**
 * Static jitter over a hold segment: RMS distance of each displayed corner
 * from its own mean position, as a fraction of the diagonal, plus the mean
 * frame-to-frame step. Only samples with a displayed quad count.
 */
export function staticJitter(series, { from, to, frame }) {
  const quads = series
    .filter((s) => s.t >= from && s.t <= to && s.quad !== null)
    .map((s) => toPixels(s.quad, frame));
  if (quads.length < 2) return null;
  const diagonal = frameDiagonal(frame);
  let squared = 0;
  for (let corner = 0; corner < 4; corner += 1) {
    const mx = quads.reduce((s, q) => s + q[corner][0], 0) / quads.length;
    const my = quads.reduce((s, q) => s + q[corner][1], 0) / quads.length;
    for (const q of quads) squared += (q[corner][0] - mx) ** 2 + (q[corner][1] - my) ** 2;
  }
  let steps = 0;
  for (let k = 1; k < quads.length; k += 1) {
    for (let corner = 0; corner < 4; corner += 1) {
      steps += Math.hypot(
        quads[k][corner][0] - quads[k - 1][corner][0],
        quads[k][corner][1] - quads[k - 1][corner][1],
      );
    }
  }
  return {
    rms: Math.sqrt(squared / (quads.length * 4)) / diagonal,
    meanStep: steps / ((quads.length - 1) * 4) / diagonal,
    samples: quads.length,
  };
}

/**
 * Stale overlay after a page swap: how long after `swapAt` the displayed quad
 * kept sitting on the OLD page (within `tolerance` of `oldGt`) — until its
 * **final** departure, so one noisy sample a little off the old page does not
 * read as "it left". The outcome says which of these it was:
 *
 * - `left` — it was on the old page and then left: `ms` is the departure (the
 *   first sample off it for good);
 * - `never-on` — never on the old page after the swap: `ms` 0;
 * - `stuck` — still on the old page at the last sample up to `to`: `ms` null;
 * - `unobserved` — some of the window from the swap to `to` (to the last
 *   sample when `to` is open) went unobserved ({@link sampleTimeline}: a gap
 *   past `maxGapMs`): `ms` null. Each outcome is a claim about the whole
 *   window — never on it, or gone from it for good — and not seeing the
 *   overlay is not the overlay having left.
 */
export function staleOverlayAfterSwap(
  series,
  { swapAt, oldGt, frame, tolerance = LOCK_TOLERANCE, to = Infinity, maxGapMs = MAX_SAMPLE_GAP_MS },
) {
  const after = series.filter((s) => s.t >= swapAt && s.t <= to);
  if (after.length === 0) return { outcome: "unobserved", ms: null };
  const end = Number.isFinite(to) ? to : after[after.length - 1].t;
  if (sampleTimeline(series, { from: swapAt, to: end, maxGapMs }).unobservedMs > 0) return { outcome: "unobserved", ms: null };
  let lastOn = -1;
  after.forEach((sample, index) => {
    if (within({ quad: sample.quad, gt: oldGt }, frame, tolerance)) lastOn = index;
  });
  if (lastOn === -1) return { outcome: "never-on", ms: 0 };
  if (lastOn === after.length - 1) return { outcome: "stuck", ms: null };
  return { outcome: "left", ms: after[lastOn + 1].t - swapAt };
}

/**
 * The series as time: each sample holds from its `t` until the next sample
 * (or `to`), for at most `maxGapMs` — the rest of a longer gap, and anything
 * before the first sample, is `unobservedMs`.
 *
 * @returns {{ intervals: { from: number, to: number, sample: object }[], observedMs: number, unobservedMs: number }}
 */
export function sampleTimeline(series, { from, to, maxGapMs = MAX_SAMPLE_GAP_MS }) {
  const intervals = [];
  let observedMs = 0;
  // The sample in force at `from` is the last one at or before it.
  let startIndex = series.findIndex((s) => s.t > from);
  if (startIndex === -1) startIndex = series.length;
  const inForce = startIndex > 0 ? startIndex - 1 : startIndex;
  for (let i = inForce; i < series.length && series[i].t < to; i += 1) {
    const sample = series[i];
    const begin = Math.max(from, sample.t);
    const nextT = i + 1 < series.length ? series[i + 1].t : Infinity;
    const end = Math.min(to, nextT, sample.t + maxGapMs);
    if (end > begin) {
      intervals.push({ from: begin, to: end, sample });
      observedMs += end - begin;
    }
  }
  return { intervals, observedMs, unobservedMs: Math.max(0, to - from - observedMs) };
}

/** Nearest-rank percentile of `values` weighted by `weights`; `null` when there is no weight. */
export function weightedPercentile(values, weights, p) {
  const pairs = values
    .map((v, i) => [v, weights[i]])
    .filter(([v, w]) => Number.isFinite(v) && w > 0)
    .sort((a, b) => a[0] - b[0]);
  const total = pairs.reduce((sum, [, w]) => sum + w, 0);
  if (total <= 0) return null;
  const target = (p / 100) * total;
  let acc = 0;
  for (const [v, w] of pairs) {
    acc += w;
    if (acc >= target - 1e-9) return v;
  }
  return pairs[pairs.length - 1][0];
}

/**
 * False locks per minute on a scene with no document: how often a quad
 * appeared and stayed — observed — at least `minHoldMs` over `[from, to]`. A
 * gap longer than `maxGapMs` ends a run: nobody saw it stay. How long a quad
 * was shown at all, however briefly, is {@link falseLockExposure}.
 */
export function falseLocksPerMinute(series, { from, to, minHoldMs = 0, maxGapMs = MAX_SAMPLE_GAP_MS }) {
  const samples = series.filter((s) => s.t >= from && s.t <= to);
  let locks = 0;
  let onsetAt = null;
  let counted = false;
  let previousT = null;
  for (const sample of samples) {
    if (previousT !== null && sample.t - previousT > maxGapMs) onsetAt = null;
    previousT = sample.t;
    if (sample.quad !== null) {
      if (onsetAt === null) {
        onsetAt = sample.t;
        counted = false;
      }
      if (!counted && sample.t - onsetAt >= minHoldMs) {
        locks += 1;
        counted = true;
      }
    } else {
      onsetAt = null;
    }
  }
  const minutes = (to - from) / 60000;
  return minutes > 0 ? locks / minutes : null;
}

/**
 * How long a quad was on screen over `[from, to]` of a scene with no document,
 * time-weighted — every flash counts, however short, unlike a
 * {@link falseLocksPerMinute} lock. `share` is of the observed time; `null`
 * when nothing was observed.
 */
export function falseLockExposure(series, { from, to, maxGapMs = MAX_SAMPLE_GAP_MS }) {
  const { intervals, observedMs, unobservedMs } = sampleTimeline(series, { from, to, maxGapMs });
  const shownMs = intervals.filter((i) => i.sample.quad !== null).reduce((sum, i) => sum + (i.to - i.from), 0);
  return { shownMs, observedMs, unobservedMs, share: observedMs > 0 ? shownMs / observedMs : null };
}

/** Tap → confirm screen open, from the two probe events. `null` if either is missing. */
export function tapToConfirmLatency(capture, confirmOpen) {
  if (capture == null || confirmOpen == null) return null;
  return confirmOpen.t - capture.t;
}

/**
 * The corners the confirm screen opened with, against the truth for the
 * captured image. Like {@link scoreDetection}, `max` and `mean` are over the
 * true corners inside the image (`null` when none is); `maxAll` and `errors`
 * cover all four.
 */
export function cornersAtConfirmError(corners, truth, frame) {
  if (corners === null || truth === null) return null;
  const errors = cornerErrors(corners, truth, frame);
  const inFrame = cornersInFrame(truth);
  const judged = errors.filter((_, i) => inFrame[i]);
  return {
    max: judgedMax(errors, inFrame),
    mean: judged.length > 0 ? judged.reduce((s, e) => s + e, 0) / judged.length : null,
    maxAll: Math.max(...errors),
    errors,
    cornersInFrame: inFrame,
  };
}
