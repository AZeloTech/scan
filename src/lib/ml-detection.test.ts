import assert from "node:assert/strict";
import test from "node:test";

import {
  coverageFloor,
  isMlResultFresh,
  ML_CALL_BUDGET_MS,
  ML_TRUSTED_CONFIDENCE,
  ML_TRUSTED_MIN_COVERAGE,
  primaryDetector,
  shouldWarmUpMl,
  supersedesDetection,
  type DetectionCandidate,
} from "./ml-detection.ts";

test("a sure model is held to the trusted floor, everyone else to the caller's", () => {
  const UNCONDITIONED = 0.35;
  // The field case behind it: ML at ~1.0 confidence over a page that covers 0.30
  // of a wide still. The trusted floor is what lets that answer through.
  assert.equal(coverageFloor("ml", 0.999, UNCONDITIONED), ML_TRUSTED_MIN_COVERAGE);
  assert.equal(coverageFloor("ml", ML_TRUSTED_CONFIDENCE, UNCONDITIONED), ML_TRUSTED_MIN_COVERAGE);
  // Below the trust bar the model is just another detector.
  assert.equal(coverageFloor("ml", 0.89, UNCONDITIONED), UNCONDITIONED);
  // No score is not a reassurance.
  assert.equal(coverageFloor("ml", null, UNCONDITIONED), UNCONDITIONED);
  // The classical pipeline never earns the trusted floor — its confident
  // failure mode (a desk-sized contour) is exactly what the caller's floor
  // cannot catch, and what the confidence there does not mean P(document).
  assert.equal(coverageFloor("classical", 0.99, UNCONDITIONED), UNCONDITIONED);
  // The trusted floor still exists: it is lower, not absent.
  assert.ok(ML_TRUSTED_MIN_COVERAGE > 0);
  assert.ok(ML_TRUSTED_MIN_COVERAGE < UNCONDITIONED);
});

test("the model detects as soon as it can, and never before", () => {
  // The seconds while ~3.4 MB is still downloading are the classical
  // detector's — the viewfinder is never dead.
  assert.equal(primaryDetector({ ready: false, disabled: false }), "classical");
  assert.equal(primaryDetector({ ready: true, disabled: false }), "ml");
});

test("a latched failure hands the session back to the classical detector", () => {
  // Even a runtime that answered before: the latch is for the rest of the
  // session, and it must not be able to take live detection down with it.
  assert.equal(primaryDetector({ ready: true, disabled: true }), "classical");
  assert.equal(primaryDetector({ ready: false, disabled: true }), "classical");
});

test("the warm-up is owed once, eagerly, and never after a failure", () => {
  assert.equal(shouldWarmUpMl({ ready: false, disabled: false }, false), true);
  // In flight, or already paid for.
  assert.equal(shouldWarmUpMl({ ready: false, disabled: false }, true), false);
  assert.equal(shouldWarmUpMl({ ready: true, disabled: false }, true), false);
  // Latched off: retrying costs a repeated multi-megabyte fetch for an answer
  // that will not change.
  assert.equal(shouldWarmUpMl({ ready: false, disabled: true }, false), false);
});

test("a warm-up slower than a normal budget is warm-up, not a detection", () => {
  assert.equal(isMlResultFresh(1000, 1000 + ML_CALL_BUDGET_MS - 1), true);
  assert.equal(isMlResultFresh(1000, 1000 + ML_CALL_BUDGET_MS), false);
});

/** A detection dated by the frame it describes. */
function candidate(
  source: DetectionCandidate["source"],
  confidence: number | null,
  capturedAt: number,
): DetectionCandidate {
  return { source, confidence, capturedAt };
}

const AUTHORITY_MS = 1400;

test("a detector's own answers are taken in frame order, never in reply order", () => {
  const tracked = candidate("classical", 0.8, 2000);
  // The 2.4 s pass that finally answers describes an older frame than the one
  // already on screen.
  assert.equal(
    supersedesDetection(candidate("classical", 0.9, 1500), tracked, 3000, AUTHORITY_MS),
    false,
  );
  assert.equal(
    supersedesDetection(candidate("classical", 0.2, 2100), tracked, 3000, AUTHORITY_MS),
    true,
  );
  const mlTracked = candidate("ml", 0.9, 2000);
  assert.equal(
    supersedesDetection(candidate("ml", 0.9, 1900), mlTracked, 3000, AUTHORITY_MS),
    false,
  );
});

test("a weak classical candidate cannot knock a fresh ML quad off the overlay", () => {
  const model = candidate("ml", 0.9, 2000);
  const tableEdge = candidate("classical", 0.2, 2100);

  assert.equal(supersedesDetection(tableEdge, model, 2200, AUTHORITY_MS), false);
  // An unscored classical detection is unconvincing, not neutral.
  assert.equal(
    supersedesDetection(candidate("classical", null, 2100), model, 2200, AUTHORITY_MS),
    false,
  );
  // Once the ML quad is as old as the horizon that would retire it, it stops
  // outranking anything — which is what makes the fallback usable the moment a
  // latched failure hands the loop back.
  assert.equal(
    supersedesDetection(tableEdge, model, 2000 + AUTHORITY_MS, AUTHORITY_MS),
    true,
  );
  // A confident classical quad always wins.
  assert.equal(
    supersedesDetection(candidate("classical", 0.8, 2100), model, 2200, AUTHORITY_MS),
    true,
  );
});

test("the model may take over a quad the classical detector itself doubts", () => {
  const doubted = candidate("classical", 0.2, 2400);
  // The warm-up pass was launched at 2000 and answers now: an older frame, but
  // the thing it is replacing is a quad its own detector did not believe in.
  assert.equal(
    supersedesDetection(candidate("ml", 0.9, 2000), doubted, 2600, AUTHORITY_MS),
    true,
  );
  // Against a confident, newer classical quad it does not.
  assert.equal(
    supersedesDetection(
      candidate("ml", 0.9, 2000),
      candidate("classical", 0.8, 2400),
      2600,
      AUTHORITY_MS,
    ),
    false,
  );
});

test("the first detection of an attempt is always taken", () => {
  assert.equal(
    supersedesDetection(candidate("classical", null, 10), null, 10, AUTHORITY_MS),
    true,
  );
});
