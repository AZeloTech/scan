import assert from "node:assert/strict";
import test from "node:test";

import { FireTimeline, phasesBefore, serialWaits, TIMELINE_CONDITIONS } from "./fire-timeline.ts";

const all = (value: boolean) => Object.fromEntries(TIMELINE_CONDITIONS.map((k) => [k, value])) as Record<(typeof TIMELINE_CONDITIONS)[number], boolean>;

test("each condition keeps when it last came true, and forgets it when it fails", () => {
  const timeline = new FireTimeline();
  timeline.update(0, { ...all(false), lock: true });
  timeline.update(100, { ...all(false), lock: true, check: true, footing: true });
  timeline.update(200, { ...all(true), still: false });
  timeline.update(300, all(true));
  assert.deepEqual(timeline.snapshot(), { lock: 0, hint: 200, slot: 200, still: 300, check: 100, footing: 100 });
  // A wobble restarts that condition's clock only.
  timeline.update(400, { ...all(true), still: false });
  timeline.update(500, all(true));
  assert.equal(timeline.snapshot().still, 500);
  assert.equal(timeline.snapshot().lock, 0);
  timeline.reset();
  assert.deepEqual(timeline.snapshot(), { lock: null, hint: null, slot: null, still: null, check: null, footing: null });
});

test("phases are whole milliseconds before the event; null stays null; nothing negative", () => {
  assert.deepEqual(phasesBefore(1000, { a: 250.4, b: null, c: 1200 }), { a: 750, b: null, c: 0 });
});

test("serial waits charge each condition the time since the one before it", () => {
  assert.deepEqual(serialWaits(100, { still: 600, hint: 400, check: null, footing: 50 }), [
    { key: "footing", ms: 0 },
    { key: "hint", ms: 300 },
    { key: "still", ms: 200 },
  ]);
});
