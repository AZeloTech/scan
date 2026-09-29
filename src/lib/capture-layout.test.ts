import assert from "node:assert/strict";
import test from "node:test";

import {
  autoCaptureOffered,
  CAPTURE_LAYOUTS,
  chromeCollapsed,
  DEFAULT_CAPTURE_LAYOUT,
  filmstripState,
  hintPlacement,
  pickCaptureLayout,
  resolveCaptureLayout,
  ringOffset,
} from "./capture-layout.ts";

test("rail is the default: a missing or unknown layout lands on it", () => {
  assert.equal(DEFAULT_CAPTURE_LAYOUT, "rail");
  assert.equal(resolveCaptureLayout(undefined), "rail");
  assert.equal(resolveCaptureLayout(null), "rail");
  assert.equal(resolveCaptureLayout("Classic"), "rail");
  assert.equal(resolveCaptureLayout("gallery"), "rail");
  assert.equal(resolveCaptureLayout(3), "rail");
  // Not a key of a plain object's prototype either.
  assert.equal(resolveCaptureLayout("constructor"), "rail");
  assert.equal(resolveCaptureLayout("toString"), "rail");
  for (const layout of CAPTURE_LAYOUTS) assert.equal(resolveCaptureLayout(layout), layout);
});

test("the old screen stays selectable as standard; default is its deprecated alias", () => {
  assert.equal(resolveCaptureLayout("standard"), "standard");
  assert.equal(resolveCaptureLayout("default"), "standard");
  assert.ok(!(CAPTURE_LAYOUTS as readonly string[]).includes("default"));
});

test("captureLayout wins over its deprecated alias experimentalCaptureLayout", () => {
  assert.equal(pickCaptureLayout(undefined, undefined), "rail");
  assert.equal(pickCaptureLayout(undefined, "classic"), "classic");
  assert.equal(pickCaptureLayout(undefined, "default"), "standard");
  assert.equal(pickCaptureLayout("standard", "classic"), "standard");
  assert.equal(pickCaptureLayout("onehand", undefined), "onehand");
  // A typo in the new prop does not fall through to the old one: it is the default.
  assert.equal(pickCaptureLayout("rial", "classic"), "rail");
});

test("rail, the default, shows the auto toggle unless the host sets experimentalAutoCapture={false}", () => {
  assert.equal(autoCaptureOffered("rail", undefined), true);
  assert.equal(autoCaptureOffered("rail", true), true);
  assert.equal(autoCaptureOffered("rail", false), false);
  // The whole default path, from props to decision.
  assert.equal(autoCaptureOffered(pickCaptureLayout(undefined, undefined), undefined), true);
  assert.equal(autoCaptureOffered(pickCaptureLayout(undefined, undefined), false), false);
});

test("standard keeps its old rule: the toggle only when the host sets true", () => {
  assert.equal(autoCaptureOffered("standard", undefined), false);
  assert.equal(autoCaptureOffered("standard", false), false);
  assert.equal(autoCaptureOffered("standard", true), true);
});

test("onehand and collapse behave like rail; classic and filmstrip never offer it", () => {
  for (const layout of ["onehand", "collapse"] as const) {
    assert.equal(autoCaptureOffered(layout, undefined), true);
    assert.equal(autoCaptureOffered(layout, true), true);
    assert.equal(autoCaptureOffered(layout, false), false);
  }
  for (const flag of [undefined, false, true]) {
    assert.equal(autoCaptureOffered("classic", flag), false);
    assert.equal(autoCaptureOffered("filmstrip", flag), false);
  }
});

test("the chrome folds only while ready, live, idle and with nothing to read", () => {
  const base = { live: true, ready: true, busy: false, notice: false };
  assert.equal(chromeCollapsed(base), true);
  assert.equal(chromeCollapsed({ ...base, ready: false }), false);
  assert.equal(chromeCollapsed({ ...base, live: false }), false);
  // A capture in flight unfolds it: the person is about to see the confirm screen.
  assert.equal(chromeCollapsed({ ...base, busy: true }), false);
  // An error on screen must be readable in the full chrome.
  assert.equal(chromeCollapsed({ ...base, notice: true }), false);
});

test("onehand attaches the hint to a tracked page and falls back to the top", () => {
  assert.equal(hintPlacement(true), "anchor");
  assert.equal(hintPlacement(false), "top");
});

test("the filmstrip's dashed slot is the next page, and goes away at the cap", () => {
  assert.deepEqual(filmstripState(0, 20), { nextSlot: 1, count: 0, max: 20 });
  assert.deepEqual(filmstripState(3, 20), { nextSlot: 4, count: 3, max: 20 });
  assert.deepEqual(filmstripState(20, 20), { nextSlot: null, count: 20, max: 20 });
  assert.deepEqual(filmstripState(-1, 0), { nextSlot: 1, count: 0, max: 1 });
});

test("the countdown ring is empty when not running and closes as it runs", () => {
  assert.equal(ringOffset(null, 100), 100);
  assert.equal(ringOffset(0, 100), 100);
  assert.equal(ringOffset(Number.NaN, 100), 100);
  assert.equal(ringOffset(0.25, 100), 75);
  assert.equal(ringOffset(1, 100), 0);
  assert.equal(ringOffset(4, 100), 0);
});
