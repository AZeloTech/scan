import assert from "node:assert/strict";
import test from "node:test";

import { pileResult, seedVerdict, SeedTracker, type PileOutcome } from "./seed-intake.ts";

/**
 * The desktop seed's bookkeeping: what the host is told about its photos, and
 * which run is allowed to move the flow on (or end it).
 */

function outcomes(entries: [number, PileOutcome][]): Map<number, PileOutcome> {
  return new Map(entries);
}

test("a pile's outcome is per input index; unreached files are overflow", () => {
  const result = pileResult(
    5,
    outcomes([
      [0, "added"],
      [1, "refused"],
      [2, "added"],
      [3, "skipped"],
    ]),
    false,
  );
  assert.deepEqual(result, { imported: [0, 2], refused: [1], overflow: [3, 4], cancelled: false });
});

test("an abandoned pile lists only what it reached", () => {
  const result = pileResult(4, outcomes([[0, "added"]]), true);
  assert.deepEqual(result, { imported: [0], refused: [], overflow: [], cancelled: true });
});

test("a finished seed is reported once and settles the flow", () => {
  const tracker = new SeedTracker();
  const token = tracker.begin();
  const result = pileResult(2, outcomes([[0, "added"], [1, "added"]]), false);
  const first = tracker.finish(token, result);
  assert.deepEqual(first.report, { imported: [0, 1], refused: [], overflow: [] });
  assert.equal(first.settle, result);
  assert.deepEqual(tracker.finish(token, result), { report: null, settle: null });
});

test("after «Limpar» the seed still reports, but no longer moves the flow", () => {
  const tracker = new SeedTracker();
  const token = tracker.begin();
  tracker.clear();
  // The seed's run stops at the clear: it reports what it got to.
  const stopped = tracker.finish(token, pileResult(3, outcomes([[0, "refused"]]), true));
  assert.deepEqual(stopped.report, { imported: [], refused: [0], overflow: [] });
  assert.equal(stopped.settle, null);
});

test("after «Limpar» a seed that had already read everything decides nothing either", () => {
  const tracker = new SeedTracker();
  const token = tracker.begin();
  tracker.clear();
  // Every photo refused, and the run ended normally just after the clear: had
  // this settled, the session would end with images_unreadable even though
  // the person had already moved on to picking their own files.
  const finished = tracker.finish(token, pileResult(2, outcomes([[0, "refused"], [1, "refused"]]), false));
  assert.notEqual(finished.report, null);
  assert.equal(finished.settle, null);
});

test("a pick made after «Limpar» is never taken for the seed", () => {
  const tracker = new SeedTracker();
  const token = tracker.begin();
  tracker.clear();
  tracker.finish(token, pileResult(1, outcomes([]), true));
  // The person's own pile has no seed token; the only way into the tracker
  // is a token from begin(), and the old one is spent.
  assert.deepEqual(tracker.finish(token, pileResult(1, outcomes([[0, "refused"]]), false)), {
    report: null,
    settle: null,
  });
});

test("a seed replaced by a newer one (StrictMode's rehearsal) reports nothing", () => {
  const tracker = new SeedTracker();
  const rehearsal = tracker.begin();
  const real = tracker.begin();
  assert.deepEqual(tracker.finish(rehearsal, pileResult(1, outcomes([]), true)), {
    report: null,
    settle: null,
  });
  const result = pileResult(1, outcomes([[0, "added"]]), false);
  assert.equal(tracker.finish(real, result).settle, result);
});

test("the verdict: all in → Conferir; some out → stay; none and empty → unreadable", () => {
  assert.equal(seedVerdict({ imported: [0, 1], refused: [], overflow: [] }, 2), "conferir");
  assert.equal(seedVerdict({ imported: [0], refused: [1], overflow: [] }, 1), "stay");
  assert.equal(seedVerdict({ imported: [0, 1], refused: [], overflow: [2] }, 2), "stay");
  assert.equal(seedVerdict({ imported: [], refused: [0, 1], overflow: [] }, 0), "unreadable");
  // A page the person added meanwhile keeps the session open.
  assert.equal(seedVerdict({ imported: [], refused: [0], overflow: [] }, 1), "stay");
});
