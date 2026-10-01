import assert from "node:assert/strict";
import test from "node:test";

import {
  areaShare,
  AUTO_FIRE_MS,
  AutoCapture,
  borderMargin,
  BORDER_ENTER,
  FILL_ENTER,
  FILL_EXIT,
  fillShare,
  HINT_APPEAR_MS,
  HINT_MIN_GAP_MS,
  HINT_MIN_SHOW_MS,
  HintDebounce,
  motionOf,
  NOT_FOUND_AFTER_MS,
  rawHint,
  READY_AFTER_MS,
  READY_EXIT_MS,
  ReadyCue,
  ReadyTick,
  REARM_AFTER_MS,
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

test("the cue on screen outlasts a short wobble; the countdown's conditions do not", () => {
  const cue = new ReadyCue();
  cue.update(true, true, 0);
  assert.equal(cue.update(true, true, READY_AFTER_MS), true);
  // One reading drifted: the countdown's start is gone, the cue stays.
  assert.equal(cue.update(false, true, 200), true);
  assert.equal(cue.onSince, null);
  assert.equal(cue.update(false, true, 200 + READY_EXIT_MS - 1), true);
  assert.equal(cue.update(true, true, 200 + READY_EXIT_MS - 1 + 16), true);
  // A failure that lasts goes.
  cue.update(false, true, 1000);
  assert.equal(cue.update(false, true, 1000 + READY_EXIT_MS), false);
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

test("auto-capture re-arms on another page, a page gone, or time and motion", () => {
  const elsewhere = rect(0.35, 0.3, 0.95, 0.85);
  const fire = (auto: AutoCapture, at: number) => auto.update({ now: at + AUTO_FIRE_MS, readyOnSince: at, sheet: page, moving: false, aspect: 1.5, confirmedAt: at + AUTO_FIRE_MS }).fire;

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

  const shaken = new AutoCapture();
  assert.equal(fire(shaken, 0), true);
  shaken.update({ now: 1000, readyOnSince: null, sheet: page, moving: true, aspect: 1.5 });
  assert.equal(shaken.armed, false);
  shaken.update({ now: AUTO_FIRE_MS + REARM_AFTER_MS, readyOnSince: null, sheet: page, moving: false, aspect: 1.5 });
  assert.equal(shaken.armed, true);
  const swapped = new AutoCapture();
  assert.equal(fire(swapped, 0), true);
  swapped.update({ now: 3000, readyOnSince: null, sheet: page, moving: false, aspect: 1.5, sceneChange: 0.04 });
  assert.equal(swapped.armed, false);
  swapped.update({ now: 3100, readyOnSince: null, sheet: page, moving: false, aspect: 1.5, sceneChange: 0.2 });
  assert.equal(swapped.armed, true);
  // A ready cue that was already on counts from the re-arm, not from before it.
  const now = AUTO_FIRE_MS + REARM_AFTER_MS + 10;
  assert.equal(shaken.update({ now, readyOnSince: 0, sheet: page, moving: false, aspect: 1.5, confirmedAt: now }).fire, false);
});

test("auto-capture fires only once a frame sampled after the countdown found the page", () => {
  const auto = new AutoCapture();
  const at = (now: number, confirmedAt: number | null) => auto.update({ now, readyOnSince: 0, sheet: page, moving: false, aspect: 1.5, confirmedAt });
  // The countdown is done, but the newest confirmed frame is from before its end.
  assert.deepEqual(at(AUTO_FIRE_MS, AUTO_FIRE_MS - 80), { countdown: 1, fire: false });
  assert.deepEqual(at(AUTO_FIRE_MS + 100, null), { countdown: 1, fire: false });
  assert.equal(at(AUTO_FIRE_MS + 200, AUTO_FIRE_MS + 20).fire, true);
});

test("after the confirm screen, re-arming counts from the viewfinder's return", () => {
  // A 3 s confirm screen, then the page relocks slowly (1.1 s) — the same page.
  const slow = new AutoCapture();
  assert.equal(slow.update({ now: 500, readyOnSince: 0, sheet: page, moving: false, aspect: 1.5, confirmedAt: 500 }).fire, true);
  slow.pause();
  slow.resume(3500);
  for (let t = 3500; t < 4600; t += 50) slow.update({ now: t, readyOnSince: null, sheet: null, moving: false, aspect: 1.5 });
  slow.update({ now: 4600, readyOnSince: null, sheet: page, moving: false, aspect: 1.5 });
  assert.equal(slow.armed, false);
  // One jostle right after the confirm screen: not two seconds of it.
  const jostled = new AutoCapture();
  jostled.update({ now: 500, readyOnSince: 0, sheet: page, moving: false, aspect: 1.5, confirmedAt: 500 });
  jostled.pause();
  jostled.resume(3500);
  jostled.update({ now: 3600, readyOnSince: null, sheet: page, moving: true, aspect: 1.5 });
  jostled.update({ now: 3700, readyOnSince: null, sheet: page, moving: false, aspect: 1.5 });
  assert.equal(jostled.armed, false);
  jostled.update({ now: 3500 + REARM_AFTER_MS, readyOnSince: null, sheet: page, moving: false, aspect: 1.5 });
  assert.equal(jostled.armed, true);
  // Switching auto-capture off and on again does not forget the page taken.
  const toggled = new AutoCapture();
  toggled.update({ now: 500, readyOnSince: 0, sheet: page, moving: false, aspect: 1.5, confirmedAt: 500 });
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
