import assert from "node:assert/strict";
import test from "node:test";

import { cadenceInterval, CadenceController, LONG_TASK_MS, type CadenceProfile } from "./cadence.ts";

const worker: CadenceProfile = { targetDuty: 0.35, minMs: 120, maxMs: 700, initialMs: 120 };
const main: CadenceProfile = { targetDuty: 0.15, minMs: 150, maxMs: 1400, initialMs: 300 };

test("the interval keeps the detector to its share of the thread, within bounds", () => {
  assert.equal(cadenceInterval(11, worker), 120);
  assert.ok(Math.abs(cadenceInterval(70, worker) - 200) < 1e-9);
  assert.equal(cadenceInterval(900, worker), 700);
});

test("starts at the profile's initial beat and follows the smoothed cost", () => {
  const cadence = new CadenceController(worker, false);
  assert.equal(cadence.intervalMs, 120);
  cadence.record(70);
  assert.ok(Math.abs(cadence.intervalMs - 200) < 1e-9);
  // One odd pass moves the beat only part of the way.
  cadence.record(210);
  assert.ok(cadence.intervalMs > 200 && cadence.intervalMs < 600, String(cadence.intervalMs));
  // Sustained slowness: the beat backs off to the ceiling.
  for (let k = 0; k < 20; k += 1) cadence.record(400);
  assert.equal(cadence.intervalMs, 700);
});

test("a main-thread pass long enough to be a long task is charged double", () => {
  const onMain = new CadenceController(main, true);
  const inWorker = new CadenceController(main, false);
  onMain.record(LONG_TASK_MS + 10);
  inWorker.record(LONG_TASK_MS + 10);
  assert.ok(Math.abs(onMain.intervalMs - 2 * inWorker.intervalMs) < 1e-9);
  const short = new CadenceController(main, true);
  short.record(20);
  assert.equal(short.intervalMs, 150);
});

test("nonsense costs are ignored; a reset forgets", () => {
  const cadence = new CadenceController(worker, false);
  cadence.record(Number.NaN);
  cadence.record(-5);
  assert.equal(cadence.averageCostMs, null);
  cadence.record(100);
  cadence.reset(main);
  assert.equal(cadence.averageCostMs, null);
  assert.equal(cadence.intervalMs, 300);
});

test("a burst at a higher duty reads faster on the same cost, never slower, within bounds", () => {
  const cadence = new CadenceController(worker, false);
  assert.equal(cadence.intervalAt(0.6), 120);
  cadence.record(105);
  assert.ok(Math.abs(cadence.intervalMs - 300) < 1e-9);
  assert.ok(Math.abs(cadence.intervalAt(0.6) - 175) < 1e-9);
  // A lower duty is never slower than the beat already set.
  assert.equal(cadence.intervalAt(0.1), cadence.intervalMs);
  // The floor still holds.
  const fast = new CadenceController(worker, false);
  fast.record(20);
  assert.equal(fast.intervalAt(0.9), 120);
});
