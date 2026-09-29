import assert from "node:assert/strict";
import test from "node:test";

import { probe, probing, quadMoved, type ProbeEvent } from "./probe.ts";

/**
 * The seam the bench watches through has one job on a real host: to be
 * nothing. Unbundled, as here, the build switch is simply absent — which must
 * read as off, listener or no listener. With the switch on (the bench's
 * bundle), no listener means no call and no error, a listener that throws must
 * not reach the scanner, only a function counts as a listener, and what a
 * listener receives is its own copy. That the published build leaves no
 * forwarding code behind at all is `scripts/bench/probe-build.test.mjs`'s job.
 */

const global = globalThis as Record<string, unknown>;

function withSwitch(on: boolean, body: () => void): void {
  global.__SCAN_PROBE_BUILD__ = on;
  try {
    body();
  } finally {
    delete global.__SCAN_PROBE_BUILD__;
  }
}

function withListener(value: unknown, body: () => void): void {
  global.__SCAN_PROBE__ = value;
  try {
    body();
  } finally {
    delete global.__SCAN_PROBE__;
  }
}

const HINT: ProbeEvent = { type: "hint", t: 1, key: "sheet-found", shown: true };

const QUAD = {
  topLeft: { x: 0.1, y: 0.1 },
  topRight: { x: 0.9, y: 0.1 },
  bottomRight: { x: 0.9, y: 0.9 },
  bottomLeft: { x: 0.1, y: 0.9 },
};

test("without the build switch, an installed listener hears nothing", () => {
  const seen: ProbeEvent[] = [];
  withListener((event: ProbeEvent) => seen.push(event), () => {
    assert.equal(probing(), false);
    probe(HINT);
    withSwitch(false, () => {
      assert.equal(probing(), false);
      probe(HINT);
    });
  });
  assert.deepEqual(seen, []);
});

test("with no listener installed, probing is off and a probe is a no-op", () => {
  withSwitch(true, () => {
    assert.equal(probing(), false);
    assert.doesNotThrow(() => probe(HINT));
  });
});

test("anything that is not a function is not a listener", () => {
  withSwitch(true, () => {
    for (const value of [null, 42, "listener", { call: () => undefined }]) {
      withListener(value, () => {
        assert.equal(probing(), false);
        assert.doesNotThrow(() => probe(HINT));
      });
    }
  });
});

test("an installed listener receives the event as given", () => {
  const seen: ProbeEvent[] = [];
  withSwitch(true, () => {
    withListener((event: ProbeEvent) => seen.push(event), () => {
      assert.equal(probing(), true);
      probe(HINT);
    });
  });
  assert.deepEqual(seen, [HINT]);
});

test("the listener gets a copy: keeping or mutating it cannot reach the scanner's quad", () => {
  const corners = structuredClone(QUAD);
  const event: ProbeEvent = {
    type: "confirm-done",
    t: 2,
    corners,
    edited: false,
    wholePhoto: false,
  };
  let received: ProbeEvent | null = null;
  withSwitch(true, () => {
    withListener(
      (heard: ProbeEvent) => {
        received = heard;
        if (heard.type === "confirm-done" && heard.corners !== null) heard.corners.topLeft.x = 0.5;
      },
      () => probe(event),
    );
  });
  assert.notEqual(received, null);
  assert.notEqual(received, event);
  assert.equal(corners.topLeft.x, 0.1, "the scanner's own quad is untouched");
  assert.equal(event.corners, corners);
});

test("a listener that throws is swallowed", () => {
  withSwitch(true, () => {
    withListener(() => {
      throw new Error("listener bug");
    }, () => {
      assert.doesNotThrow(() => probe(HINT));
    });
  });
});

test("a hook whose getter throws counts as absent", () => {
  Object.defineProperty(global, "__SCAN_PROBE__", {
    configurable: true,
    get() {
      throw new Error("hostile getter");
    },
  });
  try {
    withSwitch(true, () => {
      assert.equal(probing(), false);
      assert.doesNotThrow(() => probe(HINT));
    });
  } finally {
    delete global.__SCAN_PROBE__;
  }
});

test("an editor round-trip is not an edit; a moved handle is", () => {
  const roundTripped = { ...QUAD, topLeft: { x: 0.1002, y: 0.0999 } };
  const moved = { ...QUAD, bottomRight: { x: 0.85, y: 0.9 } };
  assert.equal(quadMoved(QUAD, roundTripped), false);
  assert.equal(quadMoved(QUAD, moved), true);
  assert.equal(quadMoved(null, null), false);
  assert.equal(quadMoved(null, QUAD), true);
});
