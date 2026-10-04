import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTO_PAPER_FRESH_MS,
  autoPaperFresh,
  autoPaperWhy,
  freshPaperMemory,
  noteCovered,
  notePaperReading,
  PAPER_MEMORY_MS,
  paperMemoryExpired,
  paperRemembered,
  resetPaperMemory,
  type MemoryFooting,
} from "./paper-memory.ts";
import type { NormalizedQuad } from "./quad.ts";

const quad: NormalizedQuad = {
  topLeft: { x: 0.2, y: 0.2 },
  topRight: { x: 0.8, y: 0.2 },
  bottomRight: { x: 0.8, y: 0.8 },
  bottomLeft: { x: 0.2, y: 0.8 },
};

/** A "not paper" reading of a sheet that is otherwise still on its edges, in view, all corners known. */
function footing(frameAt: number, over: Partial<MemoryFooting> = {}): MemoryFooting {
  return { frameAt, drift: 0.01, sidesKnown: 4, sideSupport: [0.9, 0.9, 0.9, 0.9], open: 0, unknownCorner: false, border: 0.1, ...over };
}

test("auto stands on the sheet's newest reading: a contrary reading takes it away at once, whatever memory keeps", () => {
  const m = freshPaperMemory();
  // An imaging report reads paper on the frame of 1000 ms.
  notePaperReading(m, 1000, true, quad);
  assert.equal(autoPaperFresh(m, 1050, null), true);
  // A same-size white lid slides in at the same outline; its own reading on the frame of 1240 ms says "not paper".
  notePaperReading(m, 1240, false, quad);
  // The lock's memory may keep the brackets (four strong sides, same place, within 5 s)…
  assert.equal(paperRemembered(m, footing(1240)), true);
  // …but auto is gone, now — not at 2500 ms when the old reading ages out (adv-paper F2).
  assert.equal(autoPaperFresh(m, 1250, null), false);
  assert.equal(autoPaperWhy(m, 1250, null), "paper: newest not paper");
  // A held-sheet reading on a missed pass that says paper gives it back.
  notePaperReading(m, 1360, true, null);
  assert.equal(autoPaperFresh(m, 1370, null), true);
  assert.deepEqual(m.paperQuad, quad);
});

test("auto needs a paper reading on a frame after the last motion", () => {
  const m = freshPaperMemory();
  notePaperReading(m, 1000, true, quad);
  // The scene moved at 1100 (a reading that moved, a watch trip): the 1000 reading is of the scene before.
  assert.equal(autoPaperFresh(m, 1150, 1100), false);
  assert.equal(autoPaperWhy(m, 1150, 1100), "paper not read since motion");
  notePaperReading(m, 1220, true, quad);
  assert.equal(autoPaperFresh(m, 1230, 1100), true);
  // And within AUTO_PAPER_FRESH_MS of now.
  assert.equal(autoPaperFresh(m, 1220 + AUTO_PAPER_FRESH_MS + 1, 1100), false);
  assert.equal(autoPaperWhy(m, 1220 + AUTO_PAPER_FRESH_MS + 1, 1100), "paper not read lately");
});

test("readings are dated by their frame: a late reply about an older frame changes nothing", () => {
  const m = freshPaperMemory();
  // A cpu-4 worker pass on the frame of 1000 ms, delayed: meanwhile the frame of 1200 ms (after a swap) read "not paper".
  notePaperReading(m, 1200, false, quad);
  notePaperReading(m, 1000, true, quad);
  assert.equal(m.paperAt, null);
  assert.equal(m.lastOk, false);
  assert.equal(autoPaperFresh(m, 1800, null), false);
  // The same for the covered corners.
  noteCovered(m, 1200, [{ corner: 0, along: [0.3, 0.3] }]);
  noteCovered(m, 1000, []);
  assert.deepEqual(m.covered, [{ corner: 0, along: [0.3, 0.3] }]);
});

test("one hard bound on the lock: PAPER_MEMORY_MS after the last paper reading, on frame time", () => {
  const m = freshPaperMemory();
  assert.equal(paperMemoryExpired(m, 0), true, "never read as paper: nothing to remember");
  notePaperReading(m, 1000, true, quad);
  assert.equal(paperMemoryExpired(m, 1000 + PAPER_MEMORY_MS), false);
  assert.equal(paperMemoryExpired(m, 1000 + PAPER_MEMORY_MS + 1), true);
  // Not-paper readings, or none, never extend it.
  notePaperReading(m, 3000, false, quad);
  notePaperReading(m, 5000, false, quad);
  assert.equal(paperMemoryExpired(m, 6001), true);
  assert.equal(paperRemembered(m, footing(6001)), false);
});

test("memory holds only a sheet still whole, in view and where it read as paper", () => {
  const m = freshPaperMemory();
  notePaperReading(m, 1000, true, quad);
  assert.equal(paperRemembered(m, footing(2000)), true);
  // A corner slid to (or past) the edge of the view: a cut-off page is not remembered (adv-paper F3).
  assert.equal(paperRemembered(m, footing(2000, { border: 0.005 })), false);
  assert.equal(paperRemembered(m, footing(2000, { border: -0.02 })), false);
  // A side open to the frame's edge: the quad was drawn short of a page the frame cuts off.
  assert.equal(paperRemembered(m, footing(2000, { open: 1 })), false);
  // A corner nobody can place, or another sheet over it.
  assert.equal(paperRemembered(m, footing(2000, { unknownCorner: true })), false);
  // A side cut off (null) or weak, three sides judged, drifted away.
  assert.equal(paperRemembered(m, footing(2000, { sideSupport: [0.9, null, 0.9, 0.9], sidesKnown: 3 })), false);
  assert.equal(paperRemembered(m, footing(2000, { sideSupport: [0.9, 0.7, 0.9, 0.9] })), false);
  assert.equal(paperRemembered(m, footing(2000, { drift: 0.07 })), false);
});

test("forgotten with the sheet", () => {
  const m = freshPaperMemory();
  notePaperReading(m, 1000, true, quad);
  noteCovered(m, 1000, [{ corner: 2, along: [0.2, 0.1] }]);
  resetPaperMemory(m);
  assert.deepEqual(m, freshPaperMemory());
  assert.equal(autoPaperFresh(m, 1001, null), false);
  assert.equal(paperRemembered(m, footing(1001)), false);
});
