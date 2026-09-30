import assert from "node:assert/strict";
import test from "node:test";

import { dragOffset, pressIntent, swipeStep, SWIPE_SLOP } from "./page-swipe.ts";
import { APP_COPY } from "./i18n.ts";

test("a press inside the slop is still a tap or a hold", () => {
  assert.equal(pressIntent(0, 0, true), "pending");
  assert.equal(pressIntent(SWIPE_SLOP - 1, -(SWIPE_SLOP - 1), true), "pending");
});

test("a sideways move is a swipe only where there is somewhere to go", () => {
  assert.equal(pressIntent(-24, 6, true), "swipe");
  assert.equal(pressIntent(24, -6, true), "swipe");
  // One page: nothing to swipe to, and the move is not a tap either.
  assert.equal(pressIntent(-24, 6, false), "other");
  // Mostly vertical never turns the page.
  assert.equal(pressIntent(12, 40, true), "other");
});

test("the page follows the finger, and resists towards a closed end", () => {
  assert.equal(dragOffset(-50, true, true), -50);
  assert.equal(dragOffset(50, false, true), 15);
  assert.equal(dragOffset(-50, true, false), -15);
});

test("a released swipe turns the page when it went far enough or was a flick", () => {
  const base = { width: 412, canPrev: true, canNext: true };
  // 22 % of 412 is 90 px, capped at 80.
  assert.equal(swipeStep({ ...base, dx: -81, ms: 400 }), 1);
  assert.equal(swipeStep({ ...base, dx: 81, ms: 400 }), -1);
  assert.equal(swipeStep({ ...base, dx: -60, ms: 400 }), null);
  // A flick: 40 px in 50 ms.
  assert.equal(swipeStep({ ...base, dx: -40, ms: 50 }), 1);
  // Fast but tiny is a twitch, not a flick.
  assert.equal(swipeStep({ ...base, dx: -20, ms: 10 }), null);
});

test("a swipe towards an end with no page, or a cancelled pointer, snaps back", () => {
  assert.equal(swipeStep({ dx: -200, ms: 100, width: 412, canPrev: true, canNext: false }), null);
  assert.equal(swipeStep({ dx: 200, ms: 100, width: 412, canPrev: false, canNext: true }), null);
  assert.equal(swipeStep({ dx: -200, ms: 100, width: 412, canPrev: true, canNext: true, cancelled: true }), null);
});

test("a narrow stage asks for 22 % of itself, not 80 px", () => {
  assert.equal(swipeStep({ dx: -70, ms: 400, width: 300, canPrev: true, canNext: true }), 1);
});

test("the page editor says where it is, and only hints at swiping in words", () => {
  assert.equal(APP_COPY.pt.preview.position(2, 3), "Página 2 de 3");
  assert.equal(APP_COPY.en.preview.position(2, 3), "Page 2 of 3");
  assert.equal(APP_COPY.pt.preview.swipeHint, "deslize para ver as outras");
  assert.match(APP_COPY.pt.preview.surfaceLabel(1, true, true), /inteira.*melhorias/);
  assert.equal(APP_COPY.pt.preview.surfaceLabel(1, false, false), "Página 1.");
});
