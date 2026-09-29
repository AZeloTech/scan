import assert from "node:assert/strict";
import test from "node:test";

import {
  frameOnScreen,
  hintSeries,
  hintWindow,
  insideRegion,
  overlayAccuracy,
  overlaySeries,
  PAGELESS_CAPTURE,
  scoreCaptureDetects,
  scoreCaptures,
  scoreLeaks,
  scoreGuidance,
  scorePasses,
  scorePerf,
  scoreSession,
  scoreVisibility,
  toPoints,
  truthOnScreen,
  UNSCORED_CAPTURE,
} from "./session-score.mjs";
import { absoluteViolations } from "./report.mjs";
import { summarize } from "./suites/session.mjs";

/**
 * A played session is scored against the frame that was on screen when each
 * event happened. These tests build small records by hand — a page, a camera
 * that shows it, an overlay that does or does not sit on it — and check that
 * the scoring reads them the way a person watching would.
 */

const FRAME = { width: 1000, height: 1000 };
const PAGE = [
  [0.2, 0.2],
  [0.8, 0.2],
  [0.8, 0.8],
  [0.2, 0.8],
];
const ELSEWHERE = [
  [0.4, 0.1],
  [0.95, 0.15],
  [0.9, 0.7],
  [0.35, 0.65],
];
const libraryQuad = (points) => ({
  topLeft: { x: points[0][0], y: points[0][1] },
  topRight: { x: points[1][0], y: points[1][1] },
  bottomRight: { x: points[2][0], y: points[2][1] },
  bottomLeft: { x: points[3][0], y: points[3][1] },
});

/** A record of `seconds` of camera at 30 fps from page time 1000, the page's truth from `truthAt(t)`. */
function record({ seconds = 4, truthAt = () => PAGE, overlays = [], events = [], stills = [] } = {}) {
  const startedAt = 1000;
  const frames = [];
  const pushes = [];
  const presented = [];
  for (let k = 0; k < seconds * 30; k += 1) {
    const t = (k * 1000) / 30;
    const quad = truthAt(t);
    frames.push({ i: k, t, quad, corners: quad, whole: quad !== null, share: quad === null ? 0 : 1 });
    pushes.push({ k, at: startedAt + t });
    presented.push({ k, at: startedAt + t + 20 });
  }
  return {
    startedAt,
    frames,
    pushes,
    presented,
    skipped: 0,
    stills,
    events: [...overlays.map(([t, quad]) => ({ type: "overlay", t: startedAt + t, quad: quad === null ? null : libraryQuad(quad), opacity: quad === null ? 0 : 1, hasQuad: quad !== null })), ...events],
  };
}

test("quads convert from the library's shape, and the frame on screen is the last presented", () => {
  assert.deepEqual(toPoints(libraryQuad(PAGE)), PAGE);
  assert.equal(toPoints(null), null);
  const r = record({ seconds: 1 });
  const onScreen = frameOnScreen(r);
  // Frame 3 is pushed at 1100 and presented at 1120.
  assert.equal(onScreen(1119), 2);
  assert.equal(onScreen(1121), 3);
  // Without a presentation log, one frame of latency is assumed.
  const bare = frameOnScreen({ ...r, presented: [] });
  assert.equal(bare(1100 + 1000 / 30 + 1), 3);
  // Before anything was presented the frame is unknown — not frame 0 — and so is its truth.
  assert.equal(onScreen(1010), null);
  assert.equal(bare(1010), null);
  assert.equal(truthOnScreen(r)(1010), undefined);
  assert.deepEqual(truthOnScreen(r)(1121), PAGE);
});

test("the overlay is classified against the page it was drawn over, by time", () => {
  // Every 100 ms: nothing, then the page, then a hair off it, then elsewhere.
  const quadAt = (t) => (t < 200 ? null : t < 600 ? PAGE : t < 700 ? PAGE.map(([x, y]) => [x + 0.01, y]) : ELSEWHERE);
  const overlays = [];
  for (let t = 0; t < 1000; t += 100) overlays.push([t, quadAt(t)]);
  const r = record({ overlays });
  const series = overlaySeries(r, truthOnScreen(r));
  const a = overlayAccuracy(series, { from: r.startedAt + 100, to: r.startedAt + 1000, frame: FRAME });
  assert.equal(a.samples, 9);
  assert.equal(a.observedMs, 900);
  assert.equal(a.noneShare, 100 / 900);
  assert.equal(a.lockedShare, 500 / 900);
  assert.equal(a.wrongShare, 300 / 900);
  // The error percentiles weigh what was shown by how long it was shown.
  assert.equal(a.errorP50, 0);
  assert.ok(a.errorP95 > 0.03);
});

test("time the samples do not cover, or on a frame nobody can name, is unobserved — not a share", () => {
  // Shown on the page at 0, 100 and 900: the sample at 0 is on a frame not yet
  // presented (the first presentation is at 20 ms), and after 100 there is
  // silence until 900 — 250 ms is all that sample may be credited with.
  const r = record({ overlays: [[0, PAGE], [100, PAGE], [900, PAGE]] });
  const a = overlayAccuracy(overlaySeries(r, truthOnScreen(r)), { from: r.startedAt, to: r.startedAt + 1000, frame: FRAME });
  assert.equal(a.observedMs, 250 + 100);
  assert.equal(a.unobservedMs, 100 + 550);
  assert.equal(a.lockedShare, 1);
});

test("time to lock, jitter and a stale overlay after a swap come out of the marks", () => {
  // The page is PAGE until 2 s, then ELSEWHERE; the overlay follows 0.6 s late.
  const truthAt = (t) => (t < 2000 ? PAGE : ELSEWHERE);
  const overlays = [];
  for (let t = 0; t < 4000; t += 100) overlays.push([t, t < 500 ? null : t < 2600 ? PAGE : ELSEWHERE]);
  const r = record({ truthAt, overlays });
  const script = {
    frame: FRAME,
    marks: { lockFrom: 0, holdFrom: 0, holdTo: 1900, swapAt: 2000, swapDoneAt: 2000, lockFrom2: 2000, holdTo2: 3900 },
  };
  const s = scoreSession(script, r);
  // The first shown sample on the page is at 500 ms (frame on screen then is the page).
  assert.equal(s.timeToLockMs, 500);
  assert.equal(s.jitter.rms, 0);
  assert.equal(s.staleAfterSwapMs, 600);
  assert.equal(s.timeToLockAfterSwapMs, 600);
  assert.ok(s.holdAfterSwap.wrongShare >= 0.2, "the stale overlay counts as wrong over the new page");
});

test("an empty desk counts every quad the overlay showed as a false lock", () => {
  const overlays = [];
  for (let t = 0; t < 6000; t += 100) overlays.push([t, t >= 1000 && t < 2000 ? PAGE : null]);
  const r = record({ seconds: 6, truthAt: () => null, overlays });
  const s = scoreSession({ frame: FRAME, marks: { negativeFrom: 0, negativeTo: 6000 } }, r);
  close(s.falseLocksPerMinute, 10, 1e-9);
  close(s.negative.onNothingShare, 10 / 60, 1e-9);
});

function close(actual, expected, tolerance) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≉ ${expected}`);
}

test("a capture is scored against the image that became the page", () => {
  const stillTruth = [
    [0.25, 0.25],
    [0.75, 0.25],
    [0.75, 0.75],
    [0.25, 0.75],
  ];
  const base = record({
    stills: [{ index: 0, attempt: 1, calledAt: 1000, doneAt: 1400, width: 1000, height: 1000, quad: stillTruth, corners: stillTruth, whole: true }],
  });
  const captureAt = base.startedAt + 1000;
  const events = [
    { type: "still", t: captureAt, ms: 400, ok: true, attempt: 1 },
    capture({ t: captureAt, stillUsed: true, stillAttempt: 1 }),
    { type: "confirm-open", t: captureAt + 600, corners: libraryQuad(stillTruth), shownCorners: libraryQuad(stillTruth) },
    { type: "confirm-done", t: captureAt + 1600, corners: libraryQuad(stillTruth), edited: false, wholePhoto: false },
  ];
  const r = { ...base, events, grabs: [{ id: 1, at: captureAt + 450, k: 43 }] };
  const [c] = scoreCaptures({ framesTruth: r.frames }, r);
  assert.equal(c.verdict, "good");
  assert.equal(c.shownVerdict, "good");
  assert.equal(c.finalVerdict, "good");
  assert.equal(c.atConfirm.max, 0);
  assert.equal(c.tapToConfirmMs, 600);
  assert.equal(c.imageSource, "still 1000×1000");
  assert.equal(c.stillIndex, 0);

  // The same capture from the preview frame its grab named: scored against that frame's page.
  const preview = events.map((e) => (e.type === "capture" ? { ...e, stillUsed: false, grab: 1 } : e));
  const [p] = scoreCaptures({ framesTruth: r.frames }, { ...r, events: preview });
  assert.equal(p.imageSource, "preview frame 43");
  assert.equal(p.k, 43);
  assert.equal(p.verdict, "wrong", "the still's corners are not the preview's page");
  assert.ok(p.atConfirm.max > 0.03);
});

/** A `capture` probe event, with the fields every test repeats filled in. */
function capture(fields) {
  return {
    type: "capture",
    doneAt: fields.t + 500,
    trigger: "shutter",
    stillUsed: false,
    stillW: fields.stillUsed ? 1000 : null,
    stillH: fields.stillUsed ? 1000 : null,
    previewW: 1000,
    previewH: 1000,
    frameW: 1000,
    frameH: 1000,
    cornersFrom: "detected",
    detector: "ml",
    confidence: 0.99,
    bufferAgeMs: 100,
    mlWaitMs: 0,
    stillAttempt: null,
    grab: null,
    grabbedAt: null,
    ...fields,
  };
}

test("a capture names its image by id: the attempt's still, the grab's frame — never a guess by time", () => {
  const early = [[0.3, 0.3], [0.7, 0.3], [0.7, 0.7], [0.3, 0.7]];
  // Two stills; by time the later call would have been picked. The capture says attempt 1.
  const base = record({
    stills: [
      { index: 0, attempt: 1, calledAt: 900, doneAt: 1300, width: 1000, height: 1000, quad: early, corners: early, whole: true },
      { index: 1, attempt: 2, calledAt: 1000, doneAt: 1400, width: 1000, height: 1000, quad: PAGE, corners: PAGE, whole: true },
    ],
  });
  const at = base.startedAt + 1000;
  const open = { type: "confirm-open", t: at + 600, corners: libraryQuad(early), shownCorners: libraryQuad(early) };
  const [c] = scoreCaptures({ framesTruth: base.frames }, { ...base, events: [capture({ t: at, stillUsed: true, stillAttempt: 1 }), open] });
  assert.equal(c.verdict, "good");
  assert.equal(c.stillIndex, 0);
  // No id, or an id nothing answers to: unscored, and missing data in the session.
  for (const ids of [{ stillUsed: true, stillAttempt: null }, { stillUsed: true, stillAttempt: 7 }, { grab: null }, { grab: 3 }]) {
    const r = { ...base, grabs: [{ id: 3, at: at + 400, k: null }], events: [capture({ t: at, ...ids }), open] };
    const [u] = scoreCaptures({ framesTruth: base.frames }, r);
    assert.equal(u.verdict, UNSCORED_CAPTURE, JSON.stringify(ids));
    assert.equal(u.imageKnown, false);
    const session = scoreSession({ frame: FRAME, marks: {}, actions: [{ at: 1000, tap: "shutter" }] }, r);
    assert.equal(session.missingData.length, 1);
  }
});

test("proposal, shown and final crops are judged apart; the final one is what the page became", () => {
  const base = record();
  const at = base.startedAt + 1000;
  const inset = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]];
  const r = {
    ...base,
    grabs: [{ id: 1, at: at + 400, k: 42 }],
    events: [
      capture({ t: at, grab: 1, cornersFrom: null, detector: null }),
      // No proposal: the editor showed its own inset default, and the user confirmed it.
      { type: "confirm-open", t: at + 600, corners: null, shownCorners: libraryQuad(inset) },
      { type: "confirm-done", t: at + 1600, corners: libraryQuad(inset), edited: false, wholePhoto: false },
    ],
  };
  const [c] = scoreCaptures({ framesTruth: r.frames }, r);
  assert.equal(c.verdict, "no corners");
  assert.equal(c.shownVerdict, "wrong");
  assert.equal(c.finalVerdict, "wrong");
  // "Use the whole photo": the final crop is the image itself.
  const whole = { ...r, events: r.events.map((e) => (e.type === "confirm-done" ? { ...e, corners: null, wholePhoto: true } : e)) };
  const [w] = scoreCaptures({ framesTruth: r.frames }, whole);
  assert.deepEqual(w.finalCorners, [[0, 0], [1, 0], [1, 1], [0, 1]]);
  assert.equal(w.finalVerdict, "wrong");
  assert.equal(w.wholePhoto, true);
  // Opened but never confirmed.
  const [n] = scoreCaptures({ framesTruth: r.frames }, { ...r, events: r.events.slice(0, 2) });
  assert.equal(n.finalVerdict, "not confirmed");
});

test("an empty desk that became a capture is its own failure, not 'ok'", () => {
  const base = record({ truthAt: () => null });
  const at = base.startedAt + 1000;
  const r = {
    ...base,
    grabs: [{ id: 1, at: at + 400, k: 42 }],
    events: [
      capture({ t: at, grab: 1, cornersFrom: null, detector: null }),
      { type: "confirm-open", t: at + 600, corners: null, shownCorners: libraryQuad(PAGE) },
    ],
  };
  const [c] = scoreCaptures({ framesTruth: r.frames }, r);
  assert.equal(c.verdict, PAGELESS_CAPTURE);
  assert.equal(c.pagelessCapture, true);
  assert.equal(c.shownVerdict, PAGELESS_CAPTURE);
  // With corners proposed, it is a false positive — and still a page-less capture.
  const fp = { ...r, events: r.events.map((e) => (e.type === "confirm-open" ? { ...e, corners: libraryQuad(PAGE) } : e)) };
  const [f] = scoreCaptures({ framesTruth: r.frames }, fp);
  assert.equal(f.verdict, "false positive");
  assert.equal(f.pagelessCapture, true);
  const summary = summarize([
    { session: "s", score: { captures: [c], expectedCaptures: 1, missingCaptures: 0 } },
    { session: "s", score: { captures: [f], expectedCaptures: 1, missingCaptures: 0 } },
  ]).s.all;
  assert.equal(summary.pagelessCaptures, 2);
  assert.equal(summary.pagelessCaptureRate, 1);
  assert.equal(summary.captureWrongRate, 0.5, "only the false positive is a wrong crop");
});

test("a capture that cut into the page's content is severe, even when its corners are right", () => {
  const base = record();
  const at = base.startedAt + 1000;
  // Text 20 px inside the page's left edge on frame 42; the crop starts 25 px in.
  const content = [{ kind: "text", polygon: [[0.22, 0.3], [0.5, 0.3], [0.5, 0.33], [0.22, 0.33]] }];
  const bitten = [[0.225, 0.2], [0.8, 0.2], [0.8, 0.8], [0.225, 0.8]];
  const r = {
    ...base,
    grabs: [{ id: 1, at: at + 400, k: 42 }],
    frameContent: { 42: content },
    events: [
      capture({ t: at, grab: 1 }),
      { type: "confirm-open", t: at + 600, corners: libraryQuad(bitten), shownCorners: libraryQuad(bitten) },
      { type: "confirm-done", t: at + 1600, corners: libraryQuad(PAGE), edited: true, wholePhoto: false },
    ],
  };
  const [c] = scoreCaptures({ framesTruth: r.frames }, r);
  assert.equal(c.verdict, "good");
  assert.equal(c.contentClipped, true);
  assert.equal(c.severe, true);
  // The user dragged the handle back out: the page kept its text.
  assert.equal(c.finalContentClipped, false);
  const summary = summarize([{ session: "s", score: { captures: [c], expectedCaptures: 1, missingCaptures: 0 } }]).s.all;
  assert.equal(summary.captureWrongRate, 0);
  assert.equal(summary.severeCaptureRate, 1);
  assert.equal(summary.contentClippedCaptures, 1);
  // A real image has no content truth: unknown, never "kept".
  const [u] = scoreCaptures({ framesTruth: r.frames }, { ...r, frameContent: null });
  assert.equal(u.contentClipped, null);
});

test("a captured page with no content truth leaves the severe rate unknown and is missing data", () => {
  const base = record();
  const at = base.startedAt + 1000;
  const content = [{ kind: "text", polygon: [[0.22, 0.3], [0.5, 0.3], [0.5, 0.33], [0.22, 0.33]] }];
  const bitten = [[0.225, 0.2], [0.8, 0.2], [0.8, 0.8], [0.225, 0.8]];
  const played = (frameContent) => ({
    ...base,
    grabs: [{ id: 1, at: at + 400, k: 42 }],
    frameContent,
    events: [
      capture({ t: at, grab: 1 }),
      { type: "confirm-open", t: at + 600, corners: libraryQuad(bitten), shownCorners: libraryQuad(bitten) },
      { type: "confirm-done", t: at + 1600, corners: libraryQuad(bitten), edited: false, wholePhoto: false },
    ],
  });
  const script = { frame: FRAME, marks: {}, actions: [{ at: 1000, tap: "shutter" }] };
  const summaryOf = (session) => summarize([{ session: "s", score: session }]).s.all;
  const known = scoreSession(script, played({ 42: content }));
  assert.equal(known.captures[0].contentUnknown, false);
  assert.deepEqual(known.missingData, []);
  assert.equal(summaryOf(known).severeCaptureRate, 1);
  // The same crop with the content truth lost must not read as an improvement.
  const blind = scoreSession(script, played({}));
  assert.equal(blind.captures[0].contentUnknown, true);
  assert.equal(blind.captures[0].severe, null);
  assert.deepEqual(blind.missingData, ["capture 1: no content truth for preview frame 42"]);
  const summary = summaryOf(blind);
  assert.equal(summary.severeCaptureRate, null);
  assert.equal(summary.contentUnknownCaptures, 1);
  assert.ok(absoluteViolations({ suite: "session", summary: { s: { all: summary } } }).some((line) => line.includes("contentUnknownCaptures 1")));
  // An image with no page has no content to know.
  const empty = scoreSession(script, { ...played({}), frames: base.frames.map((f) => ({ ...f, quad: null, corners: null })) });
  assert.equal(empty.captures[0].contentUnknown, false);
});

test("warm-up passes are scored, and page and no-page frames have their own denominators", () => {
  // The page is on screen for the first 2 s, then gone.
  const r = record({ truthAt: (t) => (t < 2000 ? PAGE : null) });
  const pass = (frameAt, fields) => ({ type: "detect", t: frameAt + 50, frameAt, source: "ml", warmUp: false, ok: true, accepted: true, passMs: 40, quad: libraryQuad(PAGE), ...fields });
  r.events = [
    pass(r.startedAt + 10, { warmUp: true, quad: libraryQuad(ELSEWHERE) }), // before the first presentation: unscored
    pass(r.startedAt + 500, { warmUp: true, quad: libraryQuad(ELSEWHERE) }), // on the page, wrong
    pass(r.startedAt + 600, {}),
    pass(r.startedAt + 700, { quad: libraryQuad(ELSEWHERE) }),
    pass(r.startedAt + 2500, {}), // accepted on an empty frame
    pass(r.startedAt + 2600, { ok: false, accepted: false, quad: null }),
    pass(r.startedAt + 2700, { ok: false, accepted: false, quad: null }),
  ];
  const passes = scorePasses(r, truthOnScreen(r), FRAME);
  assert.deepEqual(Object.keys(passes).sort(), ["ml", "ml warm-up"]);
  const warm = passes["ml warm-up"];
  assert.equal(warm.passes, 2);
  assert.equal(warm.unknownPasses, 1);
  assert.equal(warm.wrong, 1);
  assert.equal(warm.wrongRate, 1);
  const ml = passes.ml;
  // One wrong of the two accepted on a page — the false positive does not dilute it.
  assert.equal(ml.acceptedOnPage, 2);
  assert.equal(ml.wrongRate, 0.5);
  assert.equal(ml.falsePositive, 1);
  assert.equal(ml.noPagePasses, 3);
  assert.equal(ml.falsePositiveRate, 1 / 3);
});

test("a refined seed is also scored as the refinement's input, on the same capture", () => {
  const base = record({ stills: [{ index: 0, attempt: 1, calledAt: 1000, doneAt: 1400, width: 1000, height: 1000, quad: PAGE, corners: PAGE, whole: true }] });
  const captureAt = base.startedAt + 1000;
  const inside = PAGE.map(([x, y]) => [0.5 + (x - 0.5) * 0.85, 0.5 + (y - 0.5) * 0.85]);
  const shot = capture({ t: captureAt, stillUsed: true, stillAttempt: 1, confidence: 1 });
  const refine = {
    type: "refine",
    t: captureAt + 450,
    from: "detected",
    detector: "ml",
    mode: "full",
    input: libraryQuad(inside),
    output: libraryQuad(PAGE),
    changed: true,
    reason: "refined",
    sides: [{ mode: "local" }, { mode: "wide" }, { mode: "local" }, { mode: "kept" }],
    ms: 12,
    width: 1000,
    height: 1000,
  };
  const events = [shot, refine, { type: "confirm-open", t: captureAt + 600, corners: libraryQuad(PAGE) }];
  const [c] = scoreCaptures({ framesTruth: base.frames }, { ...base, events });
  assert.equal(c.verdict, "good");
  assert.equal(c.unrefinedVerdict, "wrong");
  assert.ok(c.unrefinedAtConfirm.max > 0.03);
  assert.deepEqual(c.refine, { from: "detected", mode: "full", changed: true, reason: "refined", ms: 12, modes: ["local", "wide", "local", "kept"], seeded: true });
  // A seed the refinement did not produce is its own "unrefined" answer.
  const other = events.map((e) => (e.type === "confirm-open" ? { ...e, corners: libraryQuad(inside) } : e));
  const [d] = scoreCaptures({ framesTruth: base.frames }, { ...base, events: other });
  assert.equal(d.refine.seeded, false);
  assert.equal(d.unrefinedVerdict, d.verdict);
});

test("a capture whose confirm screen never opened is a failure, whatever the scene", () => {
  const base = record();
  const captureAt = base.startedAt + 1000;
  const r = { ...base, grabs: [{ id: 1, at: captureAt + 200, k: 36 }], events: [capture({ t: captureAt, grab: 1, cornersFrom: null, detector: null })] };
  const [c] = scoreCaptures({ framesTruth: r.frames }, r);
  assert.equal(c.verdict, "confirm never opened");
  assert.equal(c.finalVerdict, "confirm never opened");
});

test("the capture rate is over the scripted taps, so a lost capture cannot hide", () => {
  const row = (captures, expected) => ({
    session: "s",
    score: { captures, expectedCaptures: expected, missingCaptures: Math.max(0, expected - captures.length) },
  });
  const good = { verdict: "good", atConfirm: { max: 0.01 } };
  assert.equal(summarize([row([good, good], 2)]).s.all.captureWrongRate, 0);
  // One of two taps produced nothing: half the captures failed, not none.
  assert.equal(summarize([row([good], 2)]).s.all.captureWrongRate, 0.5);
  // No capture at all is a rate of 1, not "–".
  const none = summarize([row([], 1)]).s.all;
  assert.equal(none.captureWrongRate, 1);
  assert.equal(none.cornersAtConfirmMax, null);
  // A corner error the frame could not judge does not pose as zero.
  assert.equal(summarize([row([{ verdict: "good", atConfirm: { max: null } }], 1)]).s.all.cornersAtConfirmMax, null);
});

test("the summary keeps proposal, final, unscored, stuck and missing data apart", () => {
  const row = (score) => ({ session: "s", score: { expectedCaptures: 1, missingCaptures: 0, missingData: [], ...score } });
  const good = { verdict: "good", shownVerdict: "good", finalVerdict: "good", contentClipped: false, atConfirm: { max: 0.001 } };
  const fixedByHand = { ...good, verdict: "no corners", shownVerdict: "wrong", finalVerdict: "good" };
  const unscored = { verdict: UNSCORED_CAPTURE, shownVerdict: UNSCORED_CAPTURE, finalVerdict: UNSCORED_CAPTURE, contentClipped: null };
  const summary = summarize([
    row({ captures: [good], staleAfterSwap: "left", staleAfterSwapMs: 400 }),
    row({ captures: [fixedByHand], staleAfterSwap: "stuck", staleAfterSwapMs: null }),
    row({ captures: [unscored], missingData: ["capture 1: preview frame (unidentified)"], staleAfterSwap: "unobserved", staleAfterSwapMs: null }),
  ]).s.all;
  assert.equal(summary.captureWrongRate, 1 / 3);
  assert.equal(summary.captureWrongRateShown, 1 / 3);
  assert.equal(summary.captureWrongRateFinal, 0);
  assert.equal(summary.unscoredCaptures, 1);
  assert.equal(summary.missingData, 1);
  assert.equal(summary.staleAfterSwapMs, 400);
  assert.equal(summary.staleStuck, 1);
});

test("what a session cost: long tasks per minute, the heap's slope, the cadence without the capture pauses", () => {
  const detect = (frameAt, extra = {}) => ({ type: "detect", t: frameAt + 20, frameAt, source: "ml", warmUp: false, passMs: 20, mainMs: 1, computeMs: 12, ...extra });
  const record = {
    events: [
      detect(1000),
      detect(1120),
      detect(1240),
      { type: "capture", t: 1300, doneAt: 1500 },
      { type: "confirm-done", t: 3000 },
      // After the confirm screen: the gap across the capture is a pause, not a beat.
      detect(5200),
      detect(5320),
      detect(900, { warmUp: true }),
      { type: "lane", t: 10, lane: "worker", reason: "worker" },
    ],
    perf: {
      from: 1000,
      to: 61000,
      windowMs: 60000,
      longTaskSupported: true,
      longTasks: [{ start: 2000, ms: 80 }, { start: 3000, ms: 60 }, { start: 4000, ms: 60 }],
      memory: [
        { at: 1000, used: 100 * 1024 * 1024 },
        { at: 31000, used: 101 * 1024 * 1024 },
        { at: 61000, used: 102 * 1024 * 1024 },
      ],
      workers: [{ url: "x", name: "azelo-scan-detect", createdAt: 0, terminatedAt: null }],
    },
  };
  const perf = scorePerf(record);
  assert.equal(perf.longTasks, 3);
  assert.equal(perf.longTasksPerMinute, 3);
  assert.ok(Math.abs(perf.longTaskShare - 200 / 60000) < 1e-9);
  assert.ok(Math.abs(perf.heapSlopeMBPerMin - 2) < 1e-9);
  assert.deepEqual(perf.lanes, [{ lane: "worker", reason: "worker" }]);
  assert.equal(perf.cadence.ml.passes, 5);
  assert.equal(perf.cadence.ml.intervalP50, 120);
  assert.equal(perf.cadence.ml.intervalP95, 120);
  assert.equal(perf.cadence.ml.computeMsP50, 12);
  // Long tasks cannot be counted where the browser does not report them: unknown, not zero.
  assert.equal(scorePerf({ ...record, perf: { ...record.perf, longTaskSupported: false, longTasks: [] } }).longTasksPerMinute, null);
  assert.equal(scorePerf({ events: [] }), null);
});

test("a capture's detect: a fall-through and a downgrade are told apart", () => {
  const events = [
    { type: "detect", t: 10, source: "ml" },
    { type: "capture-detect", t: 100, source: "classical", fellThrough: true, mlSkipped: null },
    { type: "capture-detect", t: 200, source: "classical", fellThrough: false, mlSkipped: "busy" },
    { type: "capture-detect", t: 300, source: "ml", fellThrough: false, mlSkipped: null },
  ];
  assert.deepEqual(scoreCaptureDetects({ events }), { detects: 3, fallThrough: 1, downgraded: 1 });
  // An app that does not report `mlSkipped`: downgrades are unknown, and a classical
  // answer after the model had answered anything is read as a fall-through.
  const older = [
    { type: "detect", t: 10, source: "ml" },
    { type: "capture-detect", t: 100, source: "classical" },
  ];
  assert.deepEqual(scoreCaptureDetects({ events: older }), { detects: 1, fallThrough: 1, downgraded: null });
});

test("what outlived the flow is counted after the last unmount", () => {
  const worker = (terminatedAt) => ({ url: "w", name: "azelo-scan-detect", createdAt: 0, terminatedAt });
  const leaks = scoreLeaks({
    perf: { workers: [worker(null)] },
    perfEnd: {
      workers: [worker(null), { ...worker(500), name: "render" }, { ...worker(null), name: "bench-camera" }],
      bitmaps: { created: 900, closed: 20, transferred: 880, open: 0, collectedOpen: 0, gcRan: true },
      memory: [{ at: 1, used: 50 * 1024 * 1024 }],
    },
  });
  assert.deepEqual(
    { alive: leaks.workersAlive, before: leaks.workersAliveBeforeRemounts, open: leaks.bitmapsOpen, heap: leaks.heapEndMB },
    { alive: 1, before: 1, open: 0, heap: 50 },
  );
});


test("guidance: the hint over time, one key at a time, legacy chips mapped", () => {
  const record = {
    events: [
      { type: "hint", t: 100, key: "fit-whole-page", shown: true },
      { type: "hint", t: 200, key: "sheet-found", shown: true },
      { type: "hint", t: 300, key: "low-light", shown: true },
      { type: "hint", t: 400, key: "low-light", shown: false },
      { type: "hint", t: 500, key: "move-closer", shown: true },
      { type: "hint", t: 900, key: "move-closer", shown: false },
    ],
  };
  assert.deepEqual(hintSeries(record), [
    { t: 100, key: "fit-whole-page" },
    { t: 300, key: "low-light" },
    { t: 400, key: "fit-whole-page" },
    { t: 500, key: "move-closer" },
    { t: 900, key: "fit-whole-page" },
  ]);
  const series = [
    { t: 0, key: "searching" },
    { t: 1000, key: "move-closer" },
    { t: 3000, key: null },
  ];
  const w = hintWindow(series, { from: 500, to: 3500, expect: ["move-closer"], conditionFrom: 0 });
  assert.ok(Math.abs(w.share - 2 / 3) < 1e-9 && Math.abs(w.wrongShare - 1 / 6) < 1e-9 && Math.abs(w.noneShare - 1 / 6) < 1e-9);
  assert.equal(w.firstCorrectMs, 1000);
  assert.equal(hintWindow(series, { from: 500, to: 900, expect: ["glare"], conditionFrom: 0 }).firstCorrectMs, null);
});

test("guidance: one hint replaced by another is one change, not two", () => {
  const record = {
    events: [
      { type: "hint", t: 100, key: "searching", shown: true },
      { type: "hint", t: 2000, key: "searching", shown: false },
      { type: "hint", t: 2000, key: "move-closer", shown: true },
      { type: "hint", t: 4000, key: "move-closer", shown: false },
    ],
  };
  assert.deepEqual(hintSeries(record), [
    { t: 100, key: "searching" },
    { t: 2000, key: "move-closer" },
    { t: 4000, key: null },
  ]);
});

test("guidance: the ready cue's precision, auto-capture fires, latency, tremor and false fires", () => {
  const t0 = 1000;
  const frames = Array.from({ length: 400 }, () => ({ quad: PAGE }));
  const overlay = (t, ready, quad = PAGE) => ({ type: "overlay", t: t0 + t, quad: quad === null ? null : { topLeft: { x: quad[0][0], y: quad[0][1] }, topRight: { x: quad[1][0], y: quad[1][1] }, bottomRight: { x: quad[2][0], y: quad[2][1] }, bottomLeft: { x: quad[3][0], y: quad[3][1] } }, opacity: 1, ready });
  const off = PAGE.map(([x, y]) => [x + 0.1, y]);
  const record = {
    startedAt: t0,
    frames,
    presented: frames.map((_, k) => ({ k, at: t0 + (k * 1000) / 30 })),
    actions: [{ what: "camera-live", at: t0 }, { what: "auto-on", at: t0 + 10 }],
    boxes: [{ at: t0 + 1, x: 0, y: 0, width: 100, height: 200 }, { at: t0 + 2, x: 0, y: 0, width: 100, height: 200 }],
    events: [0, 200, 400, 600, 800].map((t) => overlay(t, false)).concat([overlay(1000, true), overlay(1100, true), overlay(1200, true), overlay(1300, true), overlay(1400, true, off), overlay(1500, false), overlay(1700, false), overlay(1900, false), overlay(2100, false), overlay(2300, false), overlay(2500, false)]),
  };
  const script = { frame: FRAME, duration: 5000, primary: [{ t: 0, page: 0 }], marks: { ready: [{ from: 500, to: 2500 }], stable: [600], tremor: [{ from: 3000, to: 5000 }] } };
  const captures = [
    { trigger: "auto", tapAt: 1400, verdict: "good", severe: false, pagelessCapture: false },
    { trigger: "auto", tapAt: 3500, verdict: "good", severe: false, pagelessCapture: false },
    { trigger: "shutter", tapAt: 4000, verdict: "good", severe: false, pagelessCapture: false },
  ];
  const g = scoreGuidance(script, record, truthOnScreen(record), captures);
  assert.ok(Math.abs(g.ready.precision - 0.8) < 1e-9, String(g.ready.precision));
  assert.ok(Math.abs(g.ready.recall - 0.25) < 1e-9, String(g.ready.recall));
  assert.equal(g.auto.fires.length, 2);
  assert.equal(g.auto.fires[0].latencyMs, 800);
  assert.equal(g.auto.firesDuringTremor, 1);
  assert.equal(g.auto.repeatFires, 1);
  assert.equal(g.auto.falseFires, 0);
  assert.equal(g.layout.shifts, 0);
  const pageless = scoreGuidance({ ...script, marks: { pageless: true } }, record, truthOnScreen(record), captures);
  assert.equal(pageless.auto.falseFires, 2);
});

test("visible region: holds, a false \"Afaste\", ready outside the region, auto corners outside", () => {
  const t0 = 1000;
  const frames = Array.from({ length: 400 }, () => ({ quad: PAGE }));
  const overlay = (t, ready) => ({ type: "overlay", t: t0 + t, quad: null, opacity: 1, ready });
  const hint = (t, key, shown) => ({ type: "hint", t: t0 + t, key, shown });
  // The page spans 0.2–0.8; the region shows 0.1–0.9 until 2 s, then only 0.25–0.75 across.
  const regions = [
    { at: t0, x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    { at: t0 + 2000, x: 0.25, y: 0.1, width: 0.5, height: 0.8 },
  ];
  const record = {
    startedAt: t0,
    frames,
    presented: frames.map((_, k) => ({ k, at: t0 + (k * 1000) / 30 })),
    actions: [{ what: "camera-live", at: t0 }],
    regions,
    // The overlay reports every 100 ms while the loop runs: the cue is on 1.5–3 s.
    events: [
      ...Array.from({ length: 40 }, (_, k) => overlay(k * 100, k * 100 >= 1500 && k * 100 < 3000)),
      hint(500, "move-back", true),
      hint(1000, "move-back", false),
      hint(3000, "move-back", true),
    ].sort((a, b) => a.t - b.t),
  };
  const script = { frame: FRAME, duration: 4000, marks: { holdFrom: 0, holdTo: 4000 } };
  const captures = [
    { trigger: "auto", cornerOutside: true, attention: "corner-outside" },
    { trigger: "auto", cornerOutside: true, attention: null },
    { trigger: "auto", cornerOutside: false, attention: null },
    { trigger: "shutter", cornerOutside: true, attention: null },
  ];
  const v = scoreVisibility(script, record, truthOnScreen(record), captures);
  assert.equal(v.holds.length, 1);
  const h = v.holds[0];
  assert.equal(h.reached, true);
  assert.equal(h.visibleMs, 2000);
  assert.equal(h.hiddenMs, 2000);
  assert.equal(h.clearMs, 2000);
  assert.equal(h.moveBackFalseMs, 500);
  assert.equal(h.moveBackRightMs, 1000);
  // The cue is on 1.5–3 s, judged every 50 ms: visible until 2 s, a corner hidden after — no onset violation.
  assert.equal(v.ready.samples, 30);
  assert.equal(v.ready.violations, 20);
  assert.equal(v.ready.pageless, 0);
  assert.equal(v.ready.onsets, 1);
  assert.equal(v.ready.onsetViolations, 0);
  assert.ok(Math.abs(v.ready.worstOutside - 0.05) < 1e-9);
  assert.deepEqual(v.auto, { fires: 3, cornerOutside: 2, cornerOutsideFlagged: 1, flagged: 1 });
  assert.equal(insideRegion(PAGE, { x: 0.2, y: 0.2, width: 0.6, height: 0.6 }), true);
  assert.equal(insideRegion(PAGE, { x: 0.2, y: 0.2, width: 0.6, height: 0.6 }, 0.01), false);
});

test("visible region: a cue carried over from the sheet before is not the next hold's; page-less and covered cue time are violations", () => {
  const t0 = 1000;
  // Page A until 3 s, nothing 3–3.5 s, page B from 3.5 s.
  const frames = Array.from({ length: 300 }, (_, k) => ({ quad: k < 90 ? PAGE : k < 105 ? null : PAGE }));
  const overlay = (t, ready) => ({ type: "overlay", t: t0 + t, quad: null, opacity: 1, ready });
  const record = {
    startedAt: t0,
    frames,
    presented: frames.map((_, k) => ({ k, at: t0 + (k * 1000) / 30 })),
    actions: [{ what: "camera-live", at: t0 }],
    regions: [{ at: t0, x: 0, y: 0, width: 1, height: 1 }],
    // On at 1 s for page A, and it lingers through the swap to 3.7 s (reports every 100 ms).
    events: Array.from({ length: 61 }, (_, k) => overlay(k * 100, k * 100 >= 1000 && k * 100 < 3700)),
  };
  const script = { frame: FRAME, duration: 6000, marks: { holdFrom: 500, holdTo: 3000, lockFrom2: 3500, holdTo2: 6000 } };
  const v = scoreVisibility(script, record, truthOnScreen(record), []);
  assert.equal(v.holds[0].reached, true);
  assert.equal(v.holds[1].reached, false, "the lingering cue is page A's");
  assert.equal(v.holds[1].readyMs, 0);
  // 3.0–3.5 s with the cue on and no page: 10 page-less samples.
  assert.equal(v.ready.pageless, 10);
  assert.equal(v.ready.violations, 10);
  // A fresh onset for page B counts.
  const fresh = { ...record, events: Array.from({ length: 61 }, (_, k) => overlay(k * 100, (k * 100 >= 1000 && k * 100 < 3700) || (k * 100 >= 4000 && k * 100 < 6000))) };
  // Silence is no viewfinder: the same lingering cue whose reports stop at 3 s (a confirm screen over it) shows nothing after.
  const silent = { ...record, events: record.events.filter((e) => e.t < t0 + 3000) };
  assert.equal(scoreVisibility(script, silent, truthOnScreen(silent), []).ready.pageless, 0);
  assert.equal(scoreVisibility(script, fresh, truthOnScreen(fresh), []).holds[1].reached, true);
  // An opaque control over a corner (the page spans 0.2–0.8): the cue there is a violation, and an onset under it does not count.
  const covered = { ...fresh, regions: [{ at: t0, x: 0, y: 0, width: 1, height: 1, blocks: [{ x: 0.15, y: 0.15, width: 0.1, height: 0.1 }] }] };
  const c = scoreVisibility(script, covered, truthOnScreen(covered), []);
  assert.equal(c.holds[0].reached, false);
  assert.ok(c.ready.blocked > 0);
  assert.equal(c.ready.onsetViolations, c.ready.onsets);
});
