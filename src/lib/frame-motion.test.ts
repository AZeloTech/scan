import assert from "node:assert/strict";
import test from "node:test";

import {
  frameMotionScore,
  MOTION_DROP_THRESHOLD,
  motionBreaksHold,
} from "./frame-motion.ts";

function probe(fill: number, length = 576): Uint8ClampedArray {
  return new Uint8ClampedArray(length).fill(fill);
}

test("an unchanged scene scores zero and a full flip scores one", () => {
  assert.equal(frameMotionScore(probe(120), probe(120)), 0);
  assert.equal(frameMotionScore(probe(0), probe(255)), 1);
});

test("the score is the mean, not the sum", () => {
  // Half the pixels move by 51 (0.2 of the range): mean is 0.1.
  const before = probe(100);
  const after = probe(100);
  for (let index = 0; index < after.length / 2; index += 1) after[index] = 151;
  const score = frameMotionScore(before, after);
  assert.ok(score !== null && Math.abs(score - 0.1) < 1e-6);
});

test("nothing to compare against is null, never zero", () => {
  // Zero would read as "provably still" — the one thing a first pass is not.
  assert.equal(frameMotionScore(null, probe(10)), null);
  // A resized sample (camera rotation) is a geometry change, not motion.
  assert.equal(frameMotionScore(probe(10, 576), probe(10, 100)), null);
  assert.equal(frameMotionScore(probe(10, 0), probe(10, 0)), null);
});

test("tremor holds, repositioning drops, the unknown holds", () => {
  // Bands measured on handheld field footage at 700 ms probe spacing:
  // steady hold <=0.03, aiming tremor 0.03-0.09, repositioning 0.10-0.22.
  assert.equal(motionBreaksHold(0.02), false);
  assert.equal(motionBreaksHold(0.08), false);
  assert.equal(motionBreaksHold(MOTION_DROP_THRESHOLD), true);
  assert.equal(motionBreaksHold(0.22), true);
  assert.equal(motionBreaksHold(null), false);
});
