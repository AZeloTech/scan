import assert from "node:assert/strict";
import test from "node:test";

import { PAPERS, run, VIEWS } from "./framing-sim.mjs";

test("framing-sim: imperfect people reach the ready cue, and never hear Afaste under the exit line", () => {
  // The owner's field phone and a tall viewport with insets; A4 and an ID card.
  const rows = run({ trials: 40, views: [VIEWS[0], VIEWS[3]], papers: [PAPERS[0], PAPERS[2]], seed: 3 });
  for (const row of rows) {
    assert.ok(row.readyShare >= 0.95, `${row.view} ${row.paper}: ready ${row.readyShare}`);
    assert.equal(row.moveBackUnderExit, 0, `${row.view} ${row.paper}: Afaste under the exit line`);
    assert.ok(row.readyMedMs !== null && row.readyMedMs < 5000, `${row.view} ${row.paper}: median ${row.readyMedMs} ms`);
  }
});
