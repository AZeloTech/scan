import assert from "node:assert/strict";
import test from "node:test";

import { hudLines } from "./diagnostics.ts";

test("the diagnostics HUD says what the loop is doing, in numbers only", () => {
  const lines = hudLines(
    {
      lane: "main",
      detector: "ml",
      detectMs: 41.4,
      detectP50: 38.6,
      intervalMs: 320,
      frameAgeMs: 97.2,
      stream: { width: 720, height: 1280 },
      visible: { x: 0, y: 0.029, width: 1, height: 0.941 },
      fit: "maxcrop",
      locked: true,
      ready: true,
      autoArmed: true,
      blocked: "auto: countdown 40 %",
    },
    { torch: false, autoOffered: true, autoOn: true, autoFires: 2, still: { width: 2250, height: 4000, attention: "corner-outside" } },
    false,
    "no-offscreen-canvas",
  );
  assert.deepEqual(lines, [
    "lane main (no-offscreen-canvas) · ml",
    "detect 41 ms · p50 39 · every 320",
    "frame age 97 ms",
    "stream 720×1280 · still 2250×4000",
    "visible x0 y3 w100 h94 % · fit maxcrop",
    "torch no · vibrate no",
    "locked · ready on · auto armed · fired 2",
    "why: auto: countdown 40 %",
    "last photo: corner-outside",
  ]);
});
