import assert from "node:assert/strict";
import test from "node:test";

import { stepPageView, type PageView } from "./page-view.ts";

/**
 * These tests are about one promise: the picture and the turn it is wearing
 * never disagree on screen. Every case below is a frame the viewer could paint,
 * and the question is always whether that frame shows the user a page they
 * never asked for.
 */

const A: PageView = { url: "blob:a", rotation: 0 };

test("nothing offered, nothing changes", () => {
  const step = stepPageView(A, A, true);
  assert.equal(step.change, "none");
  assert.equal(step.view, A);
});

test("a turn on the same picture is taken at once, and animates", () => {
  const step = stepPageView(A, { url: "blob:a", rotation: 90 }, false);
  assert.equal(step.change, "turn");
  assert.deepEqual(step.view, { url: "blob:a", rotation: 90 });
});

test("a turn is not made to wait for a decode it does not need", () => {
  // The whole point of the CSS stand-in is that the tap is answered before the
  // render is: gating it on `decoded` would reintroduce the delay it hides.
  const undecoded = stepPageView(A, { url: "blob:a", rotation: 270 }, false);
  const decoded = stepPageView(A, { url: "blob:a", rotation: 270 }, true);
  assert.deepEqual(undecoded, decoded);
});

test("an undecoded hand-over is refused — the old pair stands, whole", () => {
  // The bug: taking this would drop the turn out of the transform while the
  // <img> still paints the pre-turn bitmap, so the page snaps back to where it
  // started for as long as the decode takes.
  const turned: PageView = { url: "blob:a", rotation: 90 };
  const step = stepPageView(turned, { url: "blob:b", rotation: 0 }, false);
  assert.equal(step.change, "none");
  assert.equal(step.view, turned);
  assert.equal(step.view.rotation, 90, "the turn stays in the transform");
});

test("a decoded hand-over swaps both halves in one step, and is placed", () => {
  const turned: PageView = { url: "blob:a", rotation: 90 };
  const step = stepPageView(turned, { url: "blob:b", rotation: 0 }, true);
  assert.equal(step.change, "handover");
  assert.deepEqual(step.view, { url: "blob:b", rotation: 0 });
});

test("a hand-over that still leaves degrees over keeps them", () => {
  // A second turn tapped while the first render was in flight: the new bytes
  // carry one quarter and the transform still owes another.
  const step = stepPageView(
    { url: "blob:a", rotation: 180 },
    { url: "blob:b", rotation: 90 },
    true,
  );
  assert.equal(step.change, "handover");
  assert.equal(step.view.rotation, 90);
});

test("the first picture is placed once it can be painted, never before", () => {
  const empty: PageView = { url: null, rotation: 0 };
  const waiting = stepPageView(empty, { url: "blob:a", rotation: 0 }, false);
  assert.equal(waiting.change, "none");
  assert.equal(waiting.view.url, null);

  const arrived = stepPageView(empty, { url: "blob:a", rotation: 0 }, true);
  assert.equal(arrived.change, "handover");
  assert.equal(arrived.view.url, "blob:a");
});

test("a rotated page opening for the first time does not spin into place", () => {
  // "handover", not "turn": arriving is placed. A page that was already turned
  // would otherwise animate a quarter turn every time the viewer opened it.
  const step = stepPageView(
    { url: null, rotation: 0 },
    { url: "blob:a", rotation: 270 },
    true,
  );
  assert.equal(step.change, "handover");
});
