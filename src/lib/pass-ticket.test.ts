import assert from "node:assert/strict";
import test from "node:test";

import { cameraChanged, passStillCurrent, type PassTicket } from "./pass-ticket.ts";

const started: PassTicket = { epoch: 4, lane: 1, width: 720, height: 1280 };

test("a pass answers only the camera it was started under", () => {
  assert.equal(passStillCurrent(started, { ...started }), true);
  // The loop restarted, a capture froze it, the model fell back: the question changed.
  assert.equal(passStillCurrent(started, { ...started, epoch: 5 }), false);
  assert.equal(cameraChanged(started, { ...started, epoch: 5 }), false);
  // The lane restarted or was demoted while the pass was out.
  assert.equal(passStillCurrent(started, { ...started, lane: 2 }), false);
  assert.equal(cameraChanged(started, { ...started, lane: 2 }), true);
  // The stream renegotiated (a resolution switch) or the phone turned.
  assert.equal(passStillCurrent(started, { ...started, width: 960 }), false);
  assert.equal(passStillCurrent(started, { ...started, width: 1280, height: 720 }), false);
  assert.equal(cameraChanged(started, { ...started, width: 1280, height: 720 }), true);
});
