import assert from "node:assert/strict";
import test from "node:test";

import { DETECT_WORKER_NAME, DetectQueue, laneBlocker, safeWorkerName } from "./detect-protocol.ts";

type Job = { id: number; priority: "live" | "capture" };

test("the queue keeps one live frame and answers the one it displaced", () => {
  const queue = new DetectQueue<Job>();
  assert.equal(queue.push({ id: 1, priority: "live" }), null);
  assert.deepEqual(queue.push({ id: 2, priority: "live" }), { id: 1, priority: "live" });
  assert.equal(queue.size, 1);
  assert.deepEqual(queue.next(), { id: 2, priority: "live" });
  assert.equal(queue.next(), undefined);
});

test("a capture never waits behind a queued live frame", () => {
  const queue = new DetectQueue<Job>();
  queue.push({ id: 1, priority: "live" });
  queue.push({ id: 2, priority: "capture" });
  queue.push({ id: 3, priority: "capture" });
  assert.equal(queue.size, 3);
  assert.deepEqual(
    [queue.next(), queue.next(), queue.next()].map((job) => job?.id),
    [2, 3, 1],
  );
  // Captures are never displaced by live frames.
  queue.push({ id: 4, priority: "capture" });
  assert.equal(queue.push({ id: 5, priority: "live" }), null);
  assert.equal(queue.next()?.id, 4);
});

test("a job whose asker gave up leaves the queue if it has not started", () => {
  const queue = new DetectQueue<Job>();
  queue.push({ id: 1, priority: "live" });
  queue.push({ id: 2, priority: "capture" });
  queue.push({ id: 3, priority: "capture" });
  assert.deepEqual(queue.cancel(2), { id: 2, priority: "capture" });
  assert.deepEqual(queue.cancel(1), { id: 1, priority: "live" });
  assert.equal(queue.cancel(9), null);
  assert.equal(queue.size, 1);
  assert.equal(queue.next()?.id, 3);
});

test("the main thread tries the worker only where one could run", () => {
  assert.equal(laneBlocker({ worker: false, createImageBitmap: true }), "no-worker");
  assert.equal(laneBlocker({ worker: true, createImageBitmap: false }), "no-create-image-bitmap");
  assert.equal(laneBlocker({ worker: true, createImageBitmap: true }), null);
});

test("the worker's name is never one the ONNX Runtime or emscripten claim", () => {
  assert.ok(safeWorkerName(DETECT_WORKER_NAME));
  assert.equal(safeWorkerName("ort-wasm-proxy-worker"), false);
  assert.equal(safeWorkerName("em-pthread-1"), false);
});
