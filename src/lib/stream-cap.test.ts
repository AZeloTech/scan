import assert from "node:assert/strict";
import test from "node:test";

import { STREAM_CAP_ENABLED, STREAM_CAP_LONG_EDGE, streamCapDecision, streamCapEnabled, type StreamCapInputs } from "./stream-cap.ts";

const PROVEN: StreamCapInputs = {
  enabled: true,
  android: true,
  imageCapture: true,
  stillWorking: true,
  stillFailed: false,
  streamLongEdge: 3840,
  capped: false,
};

test("the stream is capped only on Android Chrome with a proven still pipeline", () => {
  assert.deepEqual(streamCapDecision(PROVEN), { cap: true, reason: "still-proven" });
  assert.deepEqual(streamCapDecision({ ...PROVEN, capped: true, streamLongEdge: 1920 }), { cap: true, reason: "still-proven" });
});

test("never on iOS or wherever the preview frame may be the page", () => {
  assert.deepEqual(streamCapDecision({ ...PROVEN, android: false }), { cap: false, reason: "not-android" });
  assert.deepEqual(streamCapDecision({ ...PROVEN, imageCapture: false }), { cap: false, reason: "no-image-capture" });
});

test("not before a still has proven itself, and never after one failed", () => {
  assert.deepEqual(streamCapDecision({ ...PROVEN, stillWorking: false }), { cap: false, reason: "still-unproven" });
  assert.deepEqual(streamCapDecision({ ...PROVEN, stillWorking: false, stillFailed: true }), { cap: false, reason: "still-failed" });
  // A capped stream whose still then failed is uncapped.
  assert.deepEqual(streamCapDecision({ ...PROVEN, capped: true, stillWorking: false, stillFailed: true }), {
    cap: false,
    reason: "still-failed",
  });
});

test("a stream already at or under the cap is left alone", () => {
  assert.deepEqual(streamCapDecision({ ...PROVEN, streamLongEdge: STREAM_CAP_LONG_EDGE }), { cap: false, reason: "stream-small" });
  assert.deepEqual(streamCapDecision({ ...PROVEN, streamLongEdge: 1280 }), { cap: false, reason: "stream-small" });
});

test("the cap is off on every device until a capped stream is proven to keep the field of view", () => {
  // The S25 Ultra's capped mode sees ~1.26x less than its native one (field run 2026-10-02).
  assert.equal(STREAM_CAP_ENABLED, false);
  assert.equal(streamCapEnabled(), false);
  assert.deepEqual(streamCapDecision({ ...PROVEN, enabled: false }), { cap: false, reason: "disabled" });
  // A stream capped before (a host on an older build cannot be, but the decision says how): uncapped.
  assert.deepEqual(streamCapDecision({ ...PROVEN, enabled: false, capped: true, streamLongEdge: 1920 }), { cap: false, reason: "disabled" });
});
