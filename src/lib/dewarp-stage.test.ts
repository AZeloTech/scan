import assert from "node:assert/strict";
import test from "node:test";

import { DEVICE_GATE_BUDGET_MS } from "./dewarp/index.ts";
import type { DeviceGate } from "./dewarp/types.ts";
import { dewarpAvailable, withinDeviceBudget } from "./dewarp-stage.ts";

/**
 * The two decisions in the stage that are not about pixels: how long a person
 * may be left waiting, and whether to offer the control at all. Both are pure,
 * and both are the sort of rule that quietly inverts in a refactor.
 */

function gate(totalMs: number): DeviceGate {
  // The three components are what the engine measured; only the wall time is
  // the product's business, and the fixture says so by varying just that.
  return { downloadMs: 8_000, initMs: 900, firstInferenceMs: 1_400, totalMs };
}

test("the wait budget is the 12 seconds the product promised", () => {
  assert.equal(DEVICE_GATE_BUDGET_MS, 12_000);
});

test("a device is kept only while it answers inside the budget", () => {
  assert.equal(withinDeviceBudget(gate(4_300), DEVICE_GATE_BUDGET_MS), true);
  // The boundary belongs to the device: 12 s exactly is a wait that was
  // promised, not one that was broken.
  assert.equal(withinDeviceBudget(gate(12_000), DEVICE_GATE_BUDGET_MS), true);
  assert.equal(withinDeviceBudget(gate(12_001), DEVICE_GATE_BUDGET_MS), false);
  assert.equal(withinDeviceBudget(gate(41_000), DEVICE_GATE_BUDGET_MS), false);
});

test("a runtime with no Worker is never offered the correction", () => {
  // Node is that runtime, which is the whole point: the control must not be
  // shown anywhere the engine cannot run, and the probe answers before a
  // single byte of the engine is fetched.
  assert.equal(typeof Worker, "undefined");
  assert.equal(dewarpAvailable(), false);
});
