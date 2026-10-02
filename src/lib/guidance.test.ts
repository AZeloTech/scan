import assert from "node:assert/strict";
import test from "node:test";

import {
  areaShare,
  AUTO_AGREE_MAX,
  AUTO_CONFIRM_AFTER_MS,
  AUTO_FIRE_FAST_MS,
  AUTO_FIRE_MS,
  AUTO_FRAME_AGE_MAX_MS,
  AUTO_FRAME_AGE_MS,
  autoFrameAgeMax,
  AutoCapture,
  readingsAgree,
  settledOn,
  AUTO_MIN_DWELL_MS,
  AUTO_QUIET_MS,
  coveredDirection,
  lastMovedAt,
  settledSince,
  watchOnset,
  WATCH_ONSET_MIN,
  shakeMotion,
  SHAKY_ENTER,
  SETTLE_WINDOW_MS,
  STILL_MAX,
  borderMargin,
  BORDER_ENTER,
  FILL_ENTER,
  FILL_EXIT,
  fillShare,
  fitsCentred,
  FRAMING,
  framingHint,
  HINT_APPEAR_MS,
  HINT_MIN_GAP_MS,
  HINT_MIN_SHOW_MS,
  HintDebounce,
  DIRECTION_SWITCH,
  DirectionLatch,
  moveDirection,
  type MoveDirection,
  motionOf,
  NOT_FOUND_AFTER_MS,
  rawHint,
  READY_AFTER_MS,
  READY_EXIT_MS,
  ReadyCue,
  ReadyTick,
  REARM_GONE_MS,
  TICK_REARM_MS,
  toVisible,
  type GuidanceInput,
  readingSpacing,
} from "./guidance.ts";
import type { NormalizedQuad } from "./quad.ts";

function rect(x0: number, y0: number, x1: number, y1: number): NormalizedQuad {
  return { topLeft: { x: x0, y: y0 }, topRight: { x: x1, y: y0 }, bottomRight: { x: x1, y: y1 }, bottomLeft: { x: x0, y: y1 } };
}

const page = rect(0.2, 0.2, 0.8, 0.75);
/** A page held as the hints want it: across 86 % of the view's width, 7 % clear of each side. */
const framed = rect(0.07, 0.2, 0.93, 0.75);

function input(overrides: Partial<GuidanceInput> = {}): GuidanceInput {
  return {
    now: 10_000,
    since: 0,
    locked: true,
    sheet: framed,
    sheetSeenAt: 10_000,
    aspect: 1.5,
    motion: 0.005,
    sharp: true,
    bright: 230,
    glare: 0,
    ...overrides,
  };
}

/** An auto-capture state's countdown and fire, without its times. */
const cf = ({ countdown, fire }: { countdown: number | null; fire: boolean }) => ({ countdown, fire });

test("geometry: the visible crop, the margin to its edge, the clipped area", () => {
  const v = toVisible(rect(0, 0.075, 1, 0.925), { x: 0, y: 0.075, width: 1, height: 0.85 });
  assert.ok(Math.abs(v.topLeft.y) < 1e-9 && Math.abs(v.bottomRight.y - 1) < 1e-9);
  assert.ok(Math.abs(borderMargin(page) - 0.2) < 1e-9);
  assert.ok(borderMargin(rect(-0.1, 0.2, 0.5, 0.5)) < 0);
  assert.ok(Math.abs(areaShare(page) - 0.33) < 1e-9);
  // Clipped to the view: the half outside does not count.
  assert.ok(Math.abs(areaShare(rect(0.5, 0, 1.5, 1)) - 0.5) < 1e-9);
});

test("motion: the largest corner move over the window, unknown until it spans enough", () => {
  const a = { at: 0, quad: page };
  const b = { at: 100, quad: rect(0.21, 0.2, 0.81, 0.75) };
  assert.equal(motionOf([a, b], 1), null);
  const c = { at: 400, quad: rect(0.2, 0.2, 0.8, 0.75) };
  const motion = motionOf([a, b, c], 1);
  assert.ok(motion !== null && Math.abs(motion - 0.01 / Math.SQRT2) < 1e-9, String(motion));
});

test("hints come in priority order", () => {
  assert.equal(rawHint(input(), null), null);
  assert.equal(rawHint(input({ locked: false, sheet: null, sheetSeenAt: null, since: 9900 }), null), null);
  assert.equal(rawHint(input({ locked: false, sheet: null, sheetSeenAt: null, since: 9000 }), null), "searching");
  assert.equal(rawHint(input({ locked: false, sheet: null, sheetSeenAt: null, since: 10_000 - NOT_FOUND_AFTER_MS }), null), "not-found");
  assert.equal(rawHint(input({ locked: false, sheet: null, bright: 60 }), null), "low-light");
  const cut = rect(-0.05, 0.1, 0.9, 0.9);
  assert.equal(rawHint(input({ sheet: cut, bright: 60, glare: 0.3, motion: 0.1 }), null), "move-back");
  assert.equal(rawHint(input({ locked: false, sheet: cut }), null), "move-back");
  const small = rect(0.4, 0.4, 0.6, 0.6);
  assert.ok(fillShare(small) < FILL_ENTER);
  assert.equal(rawHint(input({ sheet: small, bright: 60 }), null), "move-closer");
  assert.equal(rawHint(input({ locked: false, sheet: small }), null), "move-closer");
  assert.equal(rawHint(input({ bright: 60, glare: 0.3 }), null), "low-light");
  assert.equal(rawHint(input({ glare: 0.3, motion: 0.1 }), null), "glare");
  assert.equal(rawHint(input({ motion: 0.1 }), null), "hold-still");
  assert.equal(rawHint(input({ sharp: false }), null), "hold-still");
  // A page suspected cut off or far away is framed first, dark or not.
  assert.equal(rawHint(input({ locked: false, sheet: cut, bright: 60 }), null), "move-back");
  assert.equal(rawHint(input({ locked: false, sheet: small, bright: 60 }), null), "move-closer");
  // A found sheet whose paper runs on past the edge is cut off, wherever its corners are.
  assert.equal(rawHint(input({ cutOff: true }), null), "move-back");
});

test("fill: the page's reach along the view's limiting axis, clipped to the view", () => {
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  // An upright page in a tall view: width-limited.
  assert.ok(near(fillShare(rect(0.1, 0.3, 0.9, 0.82)), 0.8));
  // A long receipt: height-limited.
  assert.ok(near(fillShare(rect(0.4, 0.05, 0.6, 0.95)), 0.9));
  // Past an edge, only what the view shows counts.
  assert.ok(near(fillShare(rect(-0.2, 0.3, 0.7, 0.6)), 0.7));
  // A page turned in the view reaches by its corners: a diamond across the
  // whole width fills it, though its sides are shorter than the view.
  const diamond: NormalizedQuad = {
    topLeft: { x: 0.5, y: 0.3 },
    topRight: { x: 0.95, y: 0.5 },
    bottomRight: { x: 0.5, y: 0.7 },
    bottomLeft: { x: 0.05, y: 0.5 },
  };
  assert.ok(near(fillShare(diamond), 0.9));
  // Perspective: the near edge is the one that reaches.
  const tilted: NormalizedQuad = {
    topLeft: { x: 0.2, y: 0.25 },
    topRight: { x: 0.8, y: 0.25 },
    bottomRight: { x: 0.9, y: 0.7 },
    bottomLeft: { x: 0.1, y: 0.7 },
  };
  assert.ok(near(fillShare(tilted), 0.8));
});

test("too far: by fill, not area — a page as big as a tall screen allows is never too far", () => {
  // A 0.46-wide view (a tall phone) and an A4 page across 90 % of its width:
  // it covers only ~59 % of the view's area, yet nothing closer is possible.
  const aspect = 1 / 0.46;
  const heightShare = (0.9 * 1.414) / aspect;
  const a4 = rect(0.05, 0.5 - heightShare / 2, 0.95, 0.5 + heightShare / 2);
  assert.ok(areaShare(a4) < 0.6);
  assert.equal(rawHint(input({ sheet: a4, aspect }), null), null);
  // The same page across 60 % of the width: found, sharp, still — and "Aproxime".
  const h = (0.6 * 1.414) / aspect;
  const smaller = rect(0.2, 0.5 - h / 2, 0.8, 0.5 + h / 2);
  assert.equal(rawHint(input({ sheet: smaller, aspect }), null), "move-closer");
  // A page suspected (not yet found) at that size is "Aproxime" too.
  assert.equal(rawHint(input({ locked: false, sheet: smaller, aspect }), null), "move-closer");
});

test("too far has a band: no ping-pong between Aproxime, nothing and Afaste um pouco", () => {
  const centred = (fill: number) => rect(0.5 - fill / 2, 0.25, 0.5 + fill / 2, 0.75);
  const between = (FILL_ENTER + FILL_EXIT) / 2;
  // Inside the band the answer is whatever is showing.
  assert.equal(rawHint(input({ sheet: centred(between) }), null), null);
  assert.equal(rawHint(input({ sheet: centred(between) }), "move-closer"), "move-closer");
  // Below it, always too far; at the exit line, never.
  assert.equal(rawHint(input({ sheet: centred(FILL_ENTER - 0.01) }), null), "move-closer");
  assert.equal(rawHint(input({ sheet: centred(FILL_EXIT) }), "move-closer"), null);
  // Between the exit line and "Afaste um pouco" there is room to hold the
  // page: a centred page clears the cut-off line until it reaches 97 %, so
  // the target leaves at least 6 % of the view's width spare on either side
  // for a hand's tremor and an off-centre aim.
  assert.ok((1 - FILL_EXIT) / 2 - BORDER_ENTER >= 0.06, String(FILL_EXIT));
  for (let fill = FILL_EXIT; fill <= 1 - 2 * BORDER_ENTER - 0.001; fill += 0.01) {
    assert.equal(rawHint(input({ sheet: centred(fill) }), null), null, fill.toFixed(2));
    assert.equal(rawHint(input({ sheet: centred(fill) }), "move-closer"), null, fill.toFixed(2));
  }
  // Too close: "Afaste um pouco", whatever was showing.
  assert.equal(rawHint(input({ sheet: centred(0.99) }), "move-closer"), "move-back");
  // A page drifting across the enter line on alternate readings never makes the slot flicker.
  const hints = new HintDebounce();
  const seen: (string | null)[] = [];
  for (let t = 0; t < 8000; t += 100) {
    const fill = t % 200 === 0 ? FILL_ENTER - 0.005 : FILL_ENTER + 0.005;
    const shown = hints.update(rawHint(input({ sheet: centred(fill) }), hints.current), t);
    if (seen[seen.length - 1] !== shown) seen.push(shown);
  }
  assert.ok(seen.length <= 2, seen.join(" → "));
});

test("answering Aproxime moves the page: the slot clears rather than saying Segure firme", () => {
  // While "Aproxime" (or "Afaste um pouco") is up, a page big enough now but still moving is the approach.
  assert.equal(rawHint(input({ motion: 0.05 }), "move-closer"), null);
  assert.equal(rawHint(input({ motion: 0.05 }), "move-back"), null);
  // A blurred frame is still "Segure firme"; and once the slot is clear, so is a hand still moving.
  assert.equal(rawHint(input({ motion: 0.05, sharp: false }), "move-closer"), "hold-still");
  assert.equal(rawHint(input({ motion: 0.05 }), null), "hold-still");
  // The sequence a person coming in sees: Aproxime, then nothing (the cue waits for stillness), never Segure firme.
  const hints = new HintDebounce();
  const small = rect(0.2, 0.3, 0.7, 0.7);
  const seen: (string | null)[] = [];
  for (let t = 0; t <= 6000; t += 100) {
    const moving = t >= 2000 && t < 3200;
    const sheet = t < 2600 ? small : framed;
    const shown = hints.update(rawHint(input({ sheet, motion: moving ? 0.05 : 0.005 }), hints.current), t);
    if (seen[seen.length - 1] !== shown) seen.push(shown);
  }
  assert.deepEqual(seen, [null, "move-closer", null]);
});

test("each condition has hysteresis", () => {
  assert.equal(rawHint(input({ bright: 110 }), null), null);
  assert.equal(rawHint(input({ bright: 110 }), "low-light"), "low-light");
  assert.equal(rawHint(input({ motion: 0.025 }), null), null);
  assert.equal(rawHint(input({ motion: 0.025 }), "hold-still"), "hold-still");
  assert.equal(rawHint(input({ glare: 0.08 }), null), null);
  assert.equal(rawHint(input({ glare: 0.08 }), "glare"), "glare");
});

test("a hint appears after holding, stays a second, and never flickers", () => {
  const hints = new HintDebounce();
  assert.equal(hints.update("searching", 0), null);
  assert.equal(hints.update("searching", HINT_APPEAR_MS - 1), null);
  assert.equal(hints.update("searching", HINT_APPEAR_MS), "searching");
  // A different answer on alternate frames never gets through.
  for (let t = HINT_APPEAR_MS; t < 5000; t += 100) {
    hints.update(t % 200 === 0 ? "move-back" : "searching", t);
    assert.equal(hints.value, "searching");
  }
  // A lasting change replaces it only once it has held and the old one has been up long enough.
  const shownAt = 5000;
  const changes = new HintDebounce();
  changes.update("searching", shownAt - HINT_APPEAR_MS);
  changes.update("searching", shownAt);
  changes.update(null, shownAt + 100);
  assert.equal(changes.update(null, shownAt + 100 + HINT_APPEAR_MS), "searching");
  // Up a second, but the slot changes at most once in 1.5 s.
  assert.equal(changes.update(null, shownAt + HINT_MIN_SHOW_MS), "searching");
  assert.equal(changes.update(null, shownAt + HINT_MIN_GAP_MS), null);
});

test("the ready cue needs its conditions for a while and drops at once when the page is lost", () => {
  const cue = new ReadyCue();
  assert.equal(cue.update(true, true, 0), false);
  assert.equal(cue.update(true, true, READY_AFTER_MS - 1), false);
  assert.equal(cue.update(true, true, READY_AFTER_MS), true);
  assert.equal(cue.onSince, READY_AFTER_MS);
  assert.equal(cue.update(false, false, READY_AFTER_MS + 16), false);
  assert.equal(cue.onSince, null);
  assert.equal(cue.update(true, true, READY_AFTER_MS + 32), false);
});

test("the cue and the countdown's start outlast a short wobble; the fire waits it out", () => {
  const cue = new ReadyCue();
  cue.update(true, true, 0);
  assert.equal(cue.update(true, true, READY_AFTER_MS), true);
  assert.equal(cue.steady, true);
  // One reading drifted: the cue stays, and so does the countdown's start —
  // but the conditions are not steady (no fire) until it passes.
  assert.equal(cue.update(false, true, 200), true);
  assert.equal(cue.onSince, READY_AFTER_MS);
  assert.equal(cue.steady, false);
  assert.equal(cue.update(false, true, 200 + READY_EXIT_MS - 1), true);
  assert.equal(cue.update(true, true, 200 + READY_EXIT_MS - 1 + 16), true);
  assert.equal(cue.onSince, READY_AFTER_MS);
  assert.equal(cue.steady, true);
  // A failure that lasts goes, the countdown's start with it.
  cue.update(false, true, 1000);
  assert.equal(cue.update(false, true, 1000 + READY_EXIT_MS), false);
  assert.equal(cue.onSince, null);
  // A failure with another hint owed (no keep) ends both at once.
  const other = new ReadyCue();
  other.update(true, true, 0);
  other.update(true, true, READY_AFTER_MS);
  assert.equal(other.update(false, false, 200), false);
  assert.equal(other.onSince, null);
});

test("auto-capture: a wobble the cue rides out pauses the fire, it does not restart the countdown", () => {
  // The field run of 2026-10-02: the countdown cancelled twice ("auto: no sheet") under a cue that stayed on.
  const auto = new AutoCapture();
  const sheet = { topLeft: { x: 0.1, y: 0.1 }, topRight: { x: 0.9, y: 0.1 }, bottomRight: { x: 0.9, y: 0.9 }, bottomLeft: { x: 0.1, y: 0.9 } };
  const base = { readyOnSince: 0, sheet, moving: false, aspect: 1.6 };
  assert.equal(auto.update({ ...base, now: 300, steady: true, confirmedAt: 280 }).countdown, 300 / AUTO_FIRE_MS);
  // Countdown complete, mid-wobble: not fired, still counted.
  const held = auto.update({ ...base, now: AUTO_FIRE_MS + 50, steady: false, confirmedAt: AUTO_FIRE_MS + 40 });
  assert.deepEqual(cf(held), { countdown: 1, fire: false });
  // Steady again with a fresh confirming pass: fires, without starting over.
  assert.deepEqual(cf(auto.update({ ...base, now: AUTO_FIRE_MS + 120, steady: true, confirmedAt: AUTO_FIRE_MS + 100 })), { countdown: 1, fire: true });
});

test("the ready tick is once per page, not once per wobble", () => {
  const tick = new ReadyTick();
  assert.equal(tick.update(true, true, 0), true);
  assert.equal(tick.update(true, true, 100), false);
  // Off and back within a second: no second tick.
  tick.update(false, true, 200);
  assert.equal(tick.update(true, true, 900), false);
  // Off for two seconds: owed again.
  tick.update(false, true, 1000);
  tick.update(false, true, 1000 + TICK_REARM_MS);
  assert.equal(tick.update(true, true, 1000 + TICK_REARM_MS + 16), true);
  // The page lost for a second: owed again.
  tick.update(false, false, 5000);
  tick.update(false, false, 5000 + REARM_GONE_MS);
  assert.equal(tick.update(true, true, 5000 + REARM_GONE_MS + 100), true);
});

test("auto-capture counts down on a ready page and fires once per page", () => {
  const auto = new AutoCapture();
  const step = (now: number, readyOnSince: number | null, sheet: NormalizedQuad | null = page, moving = false) =>
    auto.update({ now, readyOnSince, sheet, moving, aspect: 1.5, confirmedAt: now });
  assert.deepEqual(step(1000, null), { countdown: null, fire: false });
  const half = step(1000 + AUTO_FIRE_MS / 2, 1000);
  assert.ok(half.countdown !== null && Math.abs(half.countdown - 0.5) < 1e-9 && !half.fire);
  assert.equal(step(1000 + AUTO_FIRE_MS, 1000).fire, true);
  // Same page, ready again after the confirm screen: no second fire.
  auto.pause();
  for (let t = 4000; t < 9000; t += 100) assert.equal(step(t, 4000).fire, false);
});

test("auto-capture re-arms on another page or a page gone — never on time and motion over the same page", () => {
  const elsewhere = rect(0.35, 0.3, 0.95, 0.85);
  const fire = (auto: AutoCapture, at: number) => auto.update({ now: at + AUTO_FIRE_MS, readyOnSince: at, sheet: page, moving: false, aspect: 1.5, confirmedAt: at + AUTO_FIRE_MS - AUTO_QUIET_MS }).fire;

  const moved = new AutoCapture();
  assert.equal(fire(moved, 0), true);
  moved.update({ now: 2000, readyOnSince: null, sheet: elsewhere, moving: false, aspect: 1.5 });
  assert.equal(moved.armed, true);

  const gone = new AutoCapture();
  assert.equal(fire(gone, 0), true);
  gone.update({ now: 1500, readyOnSince: null, sheet: page, moving: false, aspect: 1.5 });
  gone.update({ now: 1600, readyOnSince: null, sheet: null, moving: false, aspect: 1.5 });
  gone.update({ now: 1600 + REARM_GONE_MS - 1, readyOnSince: null, sheet: null, moving: false, aspect: 1.5 });
  assert.equal(gone.armed, false);
  gone.update({ now: 1600 + REARM_GONE_MS, readyOnSince: null, sheet: null, moving: false, aspect: 1.5 });
  assert.equal(gone.armed, true);

  // The phone moving over the same page (or a corner's reading jittering, which reads as moving), for as long as it
  // likes: still the page that was taken (bench present-auto: second fires 5–7 s after the first).
  const shaken = new AutoCapture();
  assert.equal(fire(shaken, 0), true);
  for (let t = 1000; t <= 9000; t += 100) shaken.update({ now: t, readyOnSince: null, sheet: page, moving: t % 300 === 0, aspect: 1.5 });
  assert.equal(shaken.armed, false);
  // A ready cue that was already on counts from the re-arm, not from before it.
  assert.equal(gone.update({ now: 1600 + REARM_GONE_MS + 10, readyOnSince: 0, sheet: page, moving: false, aspect: 1.5, confirmedAt: 1600 + REARM_GONE_MS }).fire, false);
});

test("auto-capture's final look runs during the countdown: a frame read well into it, fresh at the fire (R3)", () => {
  const at = (auto: AutoCapture, now: number, confirmedAt: number | null, frameAgeMax?: number) =>
    auto.update({ now, readyOnSince: 0, sheet: page, moving: false, aspect: 1.5, confirmedAt, frameAgeMax });
  // A frame read 300 ms into the countdown, landed before its end: fires AT the end, not a pass later.
  assert.equal(at(new AutoCapture(), AUTO_FIRE_MS, 300).fire, true);
  // A frame from before the countdown's minimum dwell does not count, however fresh the pass that read it landed.
  assert.deepEqual(cf(at(new AutoCapture(), AUTO_FIRE_MS, AUTO_CONFIRM_AFTER_MS - 10)), { countdown: 1, fire: false });
  // No frame at all, or one older than the bound at the fire: wait for the next pass.
  assert.deepEqual(cf(at(new AutoCapture(), AUTO_FIRE_MS + 100, null)), { countdown: 1, fire: false });
  assert.deepEqual(cf(at(new AutoCapture(), AUTO_FIRE_MS + 100, AUTO_FIRE_MS + 100 - AUTO_FRAME_AGE_MS - 1)), { countdown: 1, fire: false });
  // The bound follows a slow loop's interval (1.5 of it), within its ceiling.
  assert.equal(autoFrameAgeMax(100), AUTO_FRAME_AGE_MS);
  assert.equal(autoFrameAgeMax(300), 450);
  assert.equal(autoFrameAgeMax(2000), AUTO_FRAME_AGE_MAX_MS);
  assert.equal(at(new AutoCapture(), AUTO_FIRE_MS + 300, AUTO_FIRE_MS - 100, autoFrameAgeMax(300)).fire, true);
});

test("auto-capture: the countdown starts on a settled page, but the fire waits for the full ready cue", () => {
  const auto = new AutoCapture();
  const at = (now: number, steady: boolean, ready: boolean) =>
    auto.update({ now, readyOnSince: 0, sheet: page, moving: false, aspect: 1.5, confirmedAt: now - 20, steady, ready });
  // Counting from the settling, before the cue is on.
  assert.equal(at(200, false, false).countdown, 200 / AUTO_FIRE_MS);
  // Done counting; the cue's full stillness not gathered yet: holds at the end.
  assert.deepEqual(cf(at(AUTO_FIRE_MS + 10, false, false)), { countdown: 1, fire: false });
  // Steady but the cue not yet on (its dwell): still holds.
  assert.deepEqual(cf(at(AUTO_FIRE_MS + 60, true, false)), { countdown: 1, fire: false });
  // Both: fires.
  assert.equal(at(AUTO_FIRE_MS + 120, true, true).fire, true);
});

test("auto-capture: a page held very still gets the short countdown, for as long as its readings agree", () => {
  const step = (auto: AutoCapture, now: number, agree: boolean) =>
    auto.update({ now, readyOnSince: 0, sheet: page, moving: false, aspect: 1.5, confirmedAt: Math.max(AUTO_CONFIRM_AFTER_MS, now - AUTO_QUIET_MS), agree });
  const fast = new AutoCapture();
  assert.equal(step(fast, 100, true).countdown, 100 / AUTO_FIRE_FAST_MS);
  assert.equal(step(fast, 200, true).end, AUTO_FIRE_FAST_MS);
  assert.equal(step(fast, AUTO_FIRE_FAST_MS, true).fire, true);
  // The readings stop agreeing during it: the full wait, and it is not earned back in this countdown.
  const wobbly = new AutoCapture();
  assert.equal(step(wobbly, 100, true).end, AUTO_FIRE_FAST_MS);
  assert.equal(step(wobbly, 200, false).end, AUTO_FIRE_MS);
  assert.equal(step(wobbly, AUTO_FIRE_FAST_MS, true).fire, false);
  assert.equal(step(wobbly, AUTO_FIRE_FAST_MS + 10, true).end, AUTO_FIRE_MS);
  assert.equal(step(wobbly, AUTO_FIRE_MS, true).fire, true);
  // Without the agreement: the full countdown.
  const slow = new AutoCapture();
  assert.equal(step(slow, AUTO_FIRE_FAST_MS, false).fire, false);
  assert.equal(step(slow, AUTO_FIRE_MS, false).fire, true);
  assert.ok(AUTO_FIRE_FAST_MS >= 300);
});

test("readings agree: the newest three within the tight tolerance", () => {
  const shifted = (d: number) => rect(0.2 + d, 0.2, 0.8 + d, 0.75);
  const still = [0, 1, 2].map((i) => ({ at: i * 120, quad: shifted(0.001 * i) }));
  assert.equal(readingsAgree(still, 1.5), true);
  const drifting = [0, 1, 2].map((i) => ({ at: i * 120, quad: shifted(0.01 * i) }));
  assert.equal(readingsAgree(drifting, 1.5), false);
  assert.equal(readingsAgree(still.slice(0, 2), 1.5), false);
  assert.ok(AUTO_AGREE_MAX < STILL_MAX);
});

test("after the confirm screen, re-arming counts from the viewfinder's return", () => {
  // A 3 s confirm screen, then the page relocks slowly (1.1 s) — the same page.
  const slow = new AutoCapture();
  assert.equal(slow.update({ now: 500, readyOnSince: 0, sheet: page, moving: false, aspect: 1.5, confirmedAt: 300 }).fire, true);
  slow.pause();
  slow.resume(3500);
  for (let t = 3500; t < 4600; t += 50) slow.update({ now: t, readyOnSince: null, sheet: null, moving: false, aspect: 1.5 });
  slow.update({ now: 4600, readyOnSince: null, sheet: page, moving: false, aspect: 1.5 });
  assert.equal(slow.armed, false);
  // A jostle after the confirm screen, then the same page for seconds: not another page.
  const jostled = new AutoCapture();
  assert.equal(jostled.update({ now: 500, readyOnSince: 0, sheet: page, moving: false, aspect: 1.5, confirmedAt: 300 }).fire, true);
  jostled.pause();
  jostled.resume(3500);
  jostled.update({ now: 3600, readyOnSince: null, sheet: page, moving: true, aspect: 1.5 });
  jostled.update({ now: 3700, readyOnSince: null, sheet: page, moving: false, aspect: 1.5 });
  assert.equal(jostled.armed, false);
  jostled.update({ now: 3500 + 5000, readyOnSince: null, sheet: page, moving: false, aspect: 1.5 });
  assert.equal(jostled.armed, false);
  // Switching auto-capture off and on again does not forget the page taken.
  const toggled = new AutoCapture();
  assert.equal(toggled.update({ now: 500, readyOnSince: 0, sheet: page, moving: false, aspect: 1.5, confirmedAt: 300 }).fire, true);
  toggled.enable(600);
  assert.equal(toggled.armed, false);
});

test("the ready window follows how often the page is actually read", () => {
  assert.equal(readingSpacing([]), 0);
  assert.equal(readingSpacing([{ at: 0 }, { at: 200 }]), 0);
  // A pass every ~200 ms (a 4K stream on a 120 ms interval): the spacing, not the interval.
  assert.equal(readingSpacing([{ at: 0 }, { at: 190 }, { at: 400 }, { at: 600 }, { at: 810 }, { at: 1000 }, { at: 1200 }]), 200);
  // One late pass does not stretch it.
  assert.equal(readingSpacing([{ at: 0 }, { at: 120 }, { at: 240 }, { at: 900 }, { at: 1020 }]), 120);
});

/** A page `width` across (share of the view's width) of `aspect` (height over width, physical), centred at (cx, cy), turned `deg`, in a view `viewAspect` tall (px h/w). */
function held(cx: number, cy: number, width: number, aspect: number, deg: number, viewAspect: number): NormalizedQuad {
  const c = Math.cos((deg * Math.PI) / 180);
  const s = Math.sin((deg * Math.PI) / 180);
  // In view-width units: x as is, y scaled by the view's aspect.
  const hw = width / 2;
  const hh = (width * aspect) / 2;
  const at = (dx: number, dy: number) => ({ x: cx + dx * c - dy * s, y: cy + (dx * s + dy * c) / viewAspect });
  return { topLeft: at(-hw, -hh), topRight: at(hw, -hh), bottomRight: at(hw, hh), bottomLeft: at(-hw, hh) };
}

test("framing: a page at the edge that would fit centred is asked to re-centre, never to back off", () => {
  // The field run of 2026-10-02: "Afaste um pouco" at fill 0.745, under the closer exit line.
  const offTop = rect(0.13, 0.008, 0.87, 0.6);
  assert.ok(fillShare(offTop) < FILL_EXIT);
  assert.equal(framingHint(offTop, {}, null), "move-phone");
  assert.equal(framingHint(offTop, {}, "move-closer"), "move-phone");
  // Already as big as asked, or too big to fit at all: back off.
  assert.equal(framingHint(rect(0.01, 0.1, 0.99, 0.8), {}, null), "move-back");
  assert.equal(framingHint(rect(0.2, -0.05, 0.8, 1.02), {}, null), "move-back");
  // The page's paper runs on past the edge: only backing off shows how big it is.
  assert.equal(framingHint(rect(0.3, 0.3, 0.6, 0.6), { cutOff: true }, null), "move-back");
  // A corner under a control is cut off to the person, as at an edge.
  assert.equal(framingHint(rect(0.15, 0.2, 0.85, 0.7), { covered: true }, null), "move-phone");
  // Re-centred: it clears at the exit line, and a page then over the entry line is framed.
  assert.equal(framingHint(rect(0.14, 0.035, 0.86, 0.6), {}, "move-phone"), null);
});

test("framing: Aproxime asks only while the page has room to come closer", () => {
  // Centred and small: closer.
  assert.equal(framingHint(rect(0.25, 0.3, 0.75, 0.6), {}, null), "move-closer");
  // Off to one side, a corner 4 % from the edge, at 0.68 of the view: as framed as it gets without re-aiming.
  const offSide = rect(0.04, 0.3, 0.72, 0.62);
  assert.ok(fillShare(offSide) >= FRAMING.fillFloor && fillShare(offSide) < FILL_ENTER);
  assert.equal(framingHint(offSide, {}, null), null);
  // While "Aproxime" shows, it clears once the room is down to its exit line…
  assert.equal(framingHint(rect(0.06, 0.3, 0.73, 0.62), {}, "move-closer"), "move-closer");
  assert.equal(framingHint(rect(0.04, 0.3, 0.73, 0.62), {}, "move-closer"), null);
  // …and a small page in a corner is re-centred first.
  assert.equal(framingHint(rect(0.03, 0.03, 0.45, 0.4), {}, null), "move-phone");
});

test("framing: every paper, held off-centre and turned, has a band where no hint shows", () => {
  // The rail layout's visible regions on the owner's viewports (with insets) and the field phone: height over width in px.
  const views = [1.365, 1.65, 1.715, 1.785, 1.79, 1.8];
  const papers = [Math.SQRT2, 11 / 8.5, 53.98 / 85.6];
  for (const viewAspect of views) {
    for (const aspect of papers) {
      for (const off of [-0.08, 0, 0.08]) {
        for (const deg of [-10, 0, 10]) {
          // Grow the page from small to too big: some size must leave the slot empty,
          // and no size under the exit line may say "Afaste um pouco".
          let quiet = false;
          for (let width = 0.2; width <= 1.2; width += 0.005) {
            const quad = held(0.5 + off, 0.5 + off, width, aspect, deg, viewAspect);
            const hint = framingHint(quad, {}, null);
            if (hint === null) quiet = true;
            if (hint === "move-back") assert.ok(fillShare(quad) >= FILL_EXIT || !fitsCentred(quad, FRAMING.borderExit), `back under the exit line: view ${viewAspect} paper ${aspect} off ${off} turn ${deg} fill ${fillShare(quad)}`);
          }
          assert.ok(quiet, `no quiet band: view ${viewAspect} paper ${aspect.toFixed(2)} off ${off} turn ${deg}`);
        }
      }
    }
  }
});

test("framing: a framing hint whose ask is met clears at once, before its minimum show", () => {
  const hints = new HintDebounce();
  hints.update("move-closer", 0);
  assert.equal(hints.update("move-closer", HINT_APPEAR_MS), "move-closer");
  // The page got there 200 ms later: the hint goes now, not after a second.
  assert.equal(hints.update(null, HINT_APPEAR_MS + 200), null);
  // Any other hint still keeps its pace.
  const other = new HintDebounce();
  other.update("glare", 0);
  assert.equal(other.update("glare", HINT_APPEAR_MS), "glare");
  assert.equal(other.update(null, HINT_APPEAR_MS + 200), "glare");
});

test("covered corners: a sheet over the page asks after framing and before light, glare and stillness", () => {
  // Framing first: the page cut off at the view's edge is asked for before what lies on it.
  assert.equal(rawHint(input({ sheet: rect(0.0, 0.2, 0.9, 0.75), occlusion: "covered" }), null), "move-back");
  assert.equal(rawHint(input({ occlusion: "covered" }), null), "corner-covered");
  assert.equal(rawHint(input({ occlusion: "separate" }), null), "separate-sheets");
  // Another sheet over the page outranks a covered corner.
  assert.equal(rawHint(input({ occlusion: "separate", bright: 40, glare: 0.3, motion: 0.05 }), null), "separate-sheets");
  assert.equal(rawHint(input({ occlusion: "covered", bright: 40 }), null), "corner-covered");
  // An inferred corner (placed from its edges) says nothing: the dashed bracket is its cue.
  assert.equal(rawHint(input({ occlusion: null }), null), null);
  // No page found: nothing about what lies on it.
  assert.equal(rawHint(input({ locked: false, sheet: null, occlusion: "covered", sheetSeenAt: null }), null), "not-found");
});

test("covered corners: a page whole in the view hears what lies over it before how to frame it", () => {
  // A small page (or two sheets taken for one, off centre): what lies over
  // it is the ask, not "Aproxime" / "Mova o celular".
  const small = rect(0.35, 0.4, 0.65, 0.6);
  assert.equal(rawHint(input({ sheet: small }), null), "move-closer");
  assert.equal(rawHint(input({ sheet: small, occlusion: "covered" }), null), "corner-covered");
  assert.equal(rawHint(input({ sheet: small, occlusion: "separate" }), null), "separate-sheets");
  // Clipped by the view — a corner at its edge, cut off past it, under a
  // control: framing first, still.
  const edge = rect(0.005, 0.2, 0.9, 0.75);
  assert.equal(rawHint(input({ sheet: edge, occlusion: "separate" }), null), "move-back");
  assert.equal(rawHint(input({ sheet: small, occlusion: "separate", cutOff: true }), null), "move-back");
  assert.equal(rawHint(input({ sheet: small, occlusion: "covered", covered: true }), null), "move-phone");
});

test("covered corners: the hint goes through the slot's debounce like any other — it never flickers", () => {
  const slot = new HintDebounce();
  assert.equal(slot.update("corner-covered", 0), null);
  assert.equal(slot.update("corner-covered", HINT_APPEAR_MS), "corner-covered");
  // A pass that reads the corner seen for a moment does not take it down before its minimum show.
  assert.equal(slot.update(null, HINT_APPEAR_MS + 200), "corner-covered");
  assert.equal(slot.update(null, HINT_APPEAR_MS + HINT_MIN_GAP_MS + 10), null);
});

/** The picture after the phone moved `step` (share of the view) in `direction`: the scene slides the other way. */
function afterMoving(quad: NormalizedQuad, direction: MoveDirection, step: number): NormalizedQuad {
  const [dx, dy] = direction === "up" ? [0, step] : direction === "down" ? [0, -step] : direction === "left" ? [step, 0] : [-step, 0];
  const move = (p: { x: number; y: number }) => ({ x: p.x + dx, y: p.y + dy });
  return { topLeft: move(quad.topLeft), topRight: move(quad.topRight), bottomRight: move(quad.bottomRight), bottomLeft: move(quad.bottomLeft) };
}

test("move the phone: the way is toward the side the page is cut on, one axis at a time", () => {
  const cases: [NormalizedQuad, MoveDirection][] = [
    [rect(0.13, 0.008, 0.87, 0.6), "up"],
    [rect(0.13, 0.4, 0.87, 0.995), "down"],
    [rect(0.005, 0.2, 0.6, 0.75), "left"],
    [rect(0.4, 0.2, 0.996, 0.75), "right"],
  ];
  for (const [quad, way] of cases) {
    assert.equal(framingHint(quad, {}, null), "move-phone", way);
    assert.equal(moveDirection(quad), way);
  }
  // A small page in the top-left corner: the axis it is further off on, for the room it has there.
  assert.equal(moveDirection(rect(0.03, 0.03, 0.45, 0.4)), "up");
  assert.equal(moveDirection(rect(0.01, 0.2, 0.45, 0.6)), "left");
});

test("move the phone: turned and tilted pages point the same way", () => {
  for (const viewAspect of [1.365, 1.79]) {
    for (const deg of [-25, -10, 10, 25]) {
      // Off to the top, the left, the right, the bottom of the view.
      assert.equal(moveDirection(held(0.5, 0.26, 0.6, Math.SQRT2, deg, viewAspect)), "up", `up ${deg}° ${viewAspect}`);
      assert.equal(moveDirection(held(0.5, 0.74, 0.6, Math.SQRT2, deg, viewAspect)), "down", `down ${deg}° ${viewAspect}`);
      assert.equal(moveDirection(held(0.36, 0.5, 0.6, Math.SQRT2, deg, viewAspect)), "left", `left ${deg}° ${viewAspect}`);
      assert.equal(moveDirection(held(0.64, 0.5, 0.6, Math.SQRT2, deg, viewAspect)), "right", `right ${deg}° ${viewAspect}`);
    }
  }
  // A page seen in perspective (its far edge shorter), cut at the top.
  const tilted: NormalizedQuad = { topLeft: { x: 0.3, y: 0.004 }, topRight: { x: 0.7, y: 0.004 }, bottomRight: { x: 0.79, y: 0.62 }, bottomLeft: { x: 0.21, y: 0.62 } };
  assert.equal(framingHint(tilted, {}, null), "move-phone");
  assert.equal(moveDirection(tilted), "up");
});

test("move the phone: doing as it says brings the cut side into view, and the hint clears", () => {
  const cases: NormalizedQuad[] = [
    rect(0.13, 0.008, 0.87, 0.6),
    rect(0.13, 0.4, 0.87, 0.995),
    rect(0.005, 0.2, 0.6, 0.75),
    rect(0.4, 0.2, 0.996, 0.75),
    held(0.5, 0.18, 0.55, Math.SQRT2, 12, 1.79),
  ];
  for (const start of cases) {
    let quad = start;
    let current: "move-phone" | "move-back" | "move-closer" | null = framingHint(quad, {}, null);
    assert.equal(current, "move-phone");
    const way = moveDirection(quad);
    const before = borderMargin(quad);
    for (let i = 0; i < 40 && current === "move-phone"; i += 1) {
      quad = afterMoving(quad, moveDirection(quad, way), 0.01);
      current = framingHint(quad, {}, current);
    }
    assert.notEqual(current, "move-phone", `still asked after moving ${way}`);
    assert.ok(borderMargin(quad) > before, `${way}: the cut side came into view`);
    // Moving the other way would have cut it further.
    const opposite: MoveDirection = way === "up" ? "down" : way === "down" ? "up" : way === "left" ? "right" : "left";
    assert.ok(borderMargin(afterMoving(start, opposite, 0.02)) < before, `${way}: the opposite cuts it more`);
  }
});

test("move the phone: the other axis takes over only when clearly further off", () => {
  // Off by about as much on both axes: the axis showing keeps it.
  const both = rect(0.02, 0.025, 0.62, 0.62);
  const first = moveDirection(both);
  const other: MoveDirection = first === "up" ? "left" : "up";
  assert.equal(moveDirection(both, other), other);
  assert.ok(DIRECTION_SWITCH > 1);
});

test("move the phone: the way shown keeps the hint's rules — kept while it shows, changed only after its minimum", () => {
  const latch = new DirectionLatch();
  assert.equal(latch.update("up", 0), "up");
  // Another answer at once does not replace it…
  assert.equal(latch.update("left", 100), "up");
  assert.equal(latch.update("left", 100 + HINT_APPEAR_MS), "up");
  // …until the shown one has had its minimum and the new one its appear time.
  assert.equal(latch.update("left", HINT_MIN_SHOW_MS + 100), "left");
  // The hint gone: nothing; back: chosen afresh.
  assert.equal(latch.update(null, 2000), null);
  assert.equal(latch.update("down", 2100), "down");
});

test("settled: the newest three readings still, over at least the settle window, at any cadence", () => {
  const at = (spacing: number, step: number) => [0, 1, 2].map((i) => ({ at: i * spacing, quad: rect(0.2 + step * i, 0.2, 0.8 + step * i, 0.75) }));
  // A fast loop (125 ms apart): settled after three readings — the window spanned by them is 250 ms.
  assert.equal(settledOn(at(125, 0.001), 1.5), true);
  // A slow one (600 ms apart): the same.
  assert.equal(settledOn(at(600, 0.001), 1.5), true);
  // Too close together to say anything yet, or still moving.
  assert.equal(settledOn(at(SETTLE_WINDOW_MS / 2 - 10, 0.001), 1.5), false);
  assert.equal(settledOn(at(125, 0.02), 1.5), false);
  assert.equal(settledOn(at(125, 0).slice(0, 2), 1.5), false);
});

test("hold still: the move a framing hint asked for is not shaking — the readings count from its clear", () => {
  // An "Aproxime" followed: the page grows 1 % of its width per 100 ms reading until t = 1000, then is held still.
  const readings = Array.from({ length: 16 }, (_, i) => {
    const t = i * 100;
    const grow = Math.min(t, 1000) / 100 * 0.01;
    return { at: t, quad: rect(0.25 - grow, 0.25 - grow, 0.75 + grow, 0.75 + grow) };
  });
  const upTo = (t: number) => readings.filter((r) => r.at <= t);
  // Measured over the whole window the approach's tail reads as shaking…
  assert.ok((motionOf(upTo(1200), 1.5, 600) ?? 0) > SHAKY_ENTER);
  // …from the hint's clear (at 1000) it is unknown, then still.
  assert.equal(shakeMotion(upTo(1150), 1.5, 600, 1000), null);
  assert.ok((shakeMotion(upTo(1300), 1.5, 600, 1000) ?? 1) < SHAKY_ENTER);
  // No hint cleared: the whole window, as before.
  assert.equal(shakeMotion(upTo(1200), 1.5, 600, null), motionOf(upTo(1200), 1.5, 600));
  // A hand still shaking after the clear is caught once the readings since span the minimum.
  const shaking = [1000, 1100, 1200, 1300].map((t, i) => ({ at: t, quad: rect(0.25 + (i % 2) * 0.08, 0.25, 0.75 + (i % 2) * 0.08, 0.75) }));
  assert.ok((shakeMotion(shaking, 1.5, 600, 1000) ?? 0) > SHAKY_ENTER);
});

test("auto-capture: a fire vetoed at its instant is not the page's one fire — but the next one waits for fresh evidence after the veto", () => {
  const auto = new AutoCapture();
  const step = (now: number, confirmedAt: number, motionAt: number | null = null, stillSinceMotion = true) =>
    auto.update({ now, readyOnSince: 0, sheet: page, moving: false, aspect: 1.5, steady: true, confirmedAt, motionAt, stillSinceMotion });
  step(300, 280);
  assert.equal(step(AUTO_FIRE_MS, AUTO_FIRE_MS - 20).fire, true);
  // The live loop's last look at the camera said it moved (a watch trip: a new motion epoch at 500): not taken.
  auto.retract();
  assert.equal(auto.armed, true);
  const trip = AUTO_FIRE_MS;
  // The frames read before the trip no longer count, however fresh.
  assert.deepEqual(cf(step(trip + 30, trip - 10, trip)), { countdown: 1, fire: false });
  // A frame after it, but the stillness since the trip not gathered yet: holds.
  assert.deepEqual(cf(step(trip + 200, trip + 120, trip, false)), { countdown: 1, fire: false });
  // Stillness since the trip, but not yet quiet for AUTO_QUIET_MS since the first frame after it: holds.
  assert.deepEqual(cf(step(trip + 260, trip + 240, trip)), { countdown: 1, fire: false });
  // Quiet long enough, on a fresh frame: fires — the countdown, done, is not run again.
  assert.deepEqual(cf(step(trip + 120 + AUTO_QUIET_MS, trip + 240, trip)), { countdown: 1, fire: true });
  // Taken now: once per page, as ever.
  assert.equal(step(trip + 800, trip + 780, trip).fire, false);
});

test("auto-capture: the quiet before the shutter — the camera seen still for AUTO_QUIET_MS since a qualifying frame, restarted by any motion", () => {
  const auto = new AutoCapture();
  const step = (now: number, confirmedAt: number, motionAt: number | null = null) =>
    auto.update({ now, readyOnSince: 0, sheet: page, moving: false, aspect: 1.5, steady: true, confirmedAt, motionAt });
  // The first frame that qualifies lands at the countdown's end: the fire waits AUTO_QUIET_MS from it, on fresh frames.
  assert.equal(step(AUTO_FIRE_MS, AUTO_FIRE_MS - 5).fire, false);
  assert.equal(step(AUTO_FIRE_MS + 100, AUTO_FIRE_MS + 90).fire, false);
  // Motion seen (a watch trip at +120): the quiet starts again from a frame after it.
  assert.equal(step(AUTO_FIRE_MS + AUTO_QUIET_MS, AUTO_FIRE_MS + 90, AUTO_FIRE_MS + 120).fire, false);
  assert.equal(step(AUTO_FIRE_MS + 250, AUTO_FIRE_MS + 200, AUTO_FIRE_MS + 120).fire, false);
  assert.equal(step(AUTO_FIRE_MS + 200 + AUTO_QUIET_MS - 1, AUTO_FIRE_MS + 330, AUTO_FIRE_MS + 120).fire, false);
  assert.equal(step(AUTO_FIRE_MS + 200 + AUTO_QUIET_MS, AUTO_FIRE_MS + 330, AUTO_FIRE_MS + 120).fire, true);
  assert.ok(AUTO_QUIET_MS >= 100);
});

test("auto-capture: never sooner than the minimum dwell after the page was found, and only on a frame read after it", () => {
  const auto = new AutoCapture();
  const step = (now: number, confirmedAt = now - 20) => auto.update({ now, readyOnSince: 200, sheet: page, moving: false, aspect: 1.5, steady: true, confirmedAt, lockedSince: 0 });
  // Settled at 200: the 500 ms countdown alone would end at 700; the dwell holds it to 1200, drawn over 200…1200.
  const half = step(700);
  assert.equal(half.fire, false);
  assert.ok(half.countdown !== null && Math.abs(half.countdown - 0.5) < 1e-9);
  assert.equal(half.end, AUTO_MIN_DWELL_MS);
  assert.equal(step(AUTO_MIN_DWELL_MS - 1).fire, false);
  // The dwell is over, but the freshest frame was read before it ended (the review's S25 case: read at 980, 220 ms
  // old at 1200 — inside the age bound, after the countdown's start): no fire on it.
  assert.equal(step(AUTO_MIN_DWELL_MS, 980).fire, false);
  assert.equal(step(AUTO_MIN_DWELL_MS + 100, AUTO_MIN_DWELL_MS - 1).fire, false);
  // A frame read after the dwell, then the quiet: fires.
  assert.equal(step(AUTO_MIN_DWELL_MS + 120, AUTO_MIN_DWELL_MS + 10).fire, false);
  assert.equal(step(AUTO_MIN_DWELL_MS + 10 + AUTO_QUIET_MS, AUTO_MIN_DWELL_MS + 130).fire, true);
  // No lock: no countdown to finish.
  const lost = new AutoCapture();
  assert.equal(lost.update({ now: 5000, readyOnSince: 0, sheet: page, moving: false, aspect: 1.5, steady: true, confirmedAt: 4990, lockedSince: null }).fire, false);
});

test("auto-capture's motion epoch: when the readings last moved, and stillness gathered after it", () => {
  const at = (t: number, dx: number) => ({ at: t, quad: rect(0.2 + dx, 0.2, 0.8 + dx, 0.75) });
  const still = [at(0, 0), at(120, 0.001), at(240, 0), at(360, 0.001)];
  assert.equal(lastMovedAt(still, 1.5), null);
  // A step of 4 % between two readings: motion at the later one's frame.
  const moved = [at(0, 0), at(120, 0.04), at(240, 0.041), at(360, 0.041), at(480, 0.04)];
  assert.equal(lastMovedAt(moved, 1.5), 120);
  // Stillness from before the motion does not count; after it, three readings over the settle window do.
  assert.equal(settledOn(moved, 1.5), true);
  assert.equal(settledSince(moved.slice(0, 4), 1.5, 240), false);
  assert.equal(settledSince(moved, 1.5, 120), true);
  assert.equal(settledSince(moved, 1.5, 240), false);
  assert.equal(settledSince(still, 1.5, null), true);
});

test("'Mova o celular' with a corner under a control: towards the control, not by the page's centre", () => {
  const view = { x: 0, y: 0, width: 1, height: 1 };
  // The review's case: a page centred a little high (centre would say "up") whose lower-left corner lies under the
  // bottom bar — "up" would push it further under; "down" moves the picture up, off the bar.
  const high = rect(0.2, 0.05, 0.8, 0.9);
  assert.equal(moveDirection(high), "up");
  const bottomBar = { x: 0, y: 0.86, width: 1, height: 0.14 };
  assert.equal(coveredDirection(bottomBar, view), "down");
  // A control at the top, at the left or right side.
  assert.equal(coveredDirection({ x: 0.1, y: 0, width: 0.8, height: 0.08 }, view), "up");
  assert.equal(coveredDirection({ x: 0.88, y: 0.3, width: 0.12, height: 0.4 }, view), "right");
  assert.equal(coveredDirection({ x: 0, y: 0.3, width: 0.12, height: 0.4 }, view), "left");
  // Against the visible crop, not the whole frame: a bar at the crop's bottom inside a taller frame.
  const crop = { x: 0, y: 0.1, width: 1, height: 0.7 };
  assert.equal(coveredDirection({ x: 0.3, y: 0.72, width: 0.4, height: 0.08 }, crop), "down");
  assert.equal(coveredDirection({ x: 0.3, y: 0.1, width: 0.4, height: 0.08 }, crop), "up");
});

test("the camera watch's onset: a jump over its own baseline on the page, under the fixed line", () => {
  // The bench's whip (5b): a hold scoring 0.002–0.005, then 0.018 on a frame 83 ms into the pull.
  const hold = [0.003, 0.002, 0.005, 0.004, 0.003];
  assert.equal(watchOnset(0.018, hold), true);
  assert.equal(watchOnset(0.008, hold), false);
  // Under the floor, however quiet the hold: not motion.
  assert.equal(watchOnset(WATCH_ONSET_MIN - 0.001, [0.001, 0.001, 0.001]), false);
  // A textured desk whose tremor scores 0.015–0.04: its own baseline, not the floor, sets the line.
  const busy = [0.015, 0.024, 0.011, 0.024, 0.038];
  assert.equal(watchOnset(0.035, busy), false);
  assert.equal(watchOnset(0.08, busy), true);
  // Fewer than three scores on the page: no baseline yet.
  assert.equal(watchOnset(0.04, [0.002, 0.002]), false);
});
