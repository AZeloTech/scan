import assert from "node:assert/strict";
import test from "node:test";

import {
  chooseRenderLane,
  deliveredEncodes,
  GenerationLedger,
  MAX_WORKER_FAILURES,
  renderJobMessage,
  supportsRenderWorker,
  type RenderWorkerSupport,
} from "./render-protocol.ts";
import type { PixelJob } from "./render-pixels.ts";

/**
 * The worker lane's three decisions, tested where they are pure. The pixels
 * themselves need a browser; *whether* the pixels go to another thread, and
 * *whether* the answer that comes back is still wanted, do not — and those are
 * the two that can show a user the wrong page.
 */

const FULL_SUPPORT: RenderWorkerSupport = {
  worker: true,
  offscreenCanvas: true,
  convertToBlob: true,
  createImageBitmap: true,
};

const JOB: PixelJob = { finish: "bw", rotation: 90, thumbLongEdge: 480 };

test("the worker lane needs every piece, not most of them", () => {
  assert.equal(supportsRenderWorker(FULL_SUPPORT), true);

  for (const missing of [
    "worker",
    "offscreenCanvas",
    "convertToBlob",
    "createImageBitmap",
  ] as const) {
    assert.equal(
      supportsRenderWorker({ ...FULL_SUPPORT, [missing]: false }),
      false,
      `${missing} missing should keep the render on the main thread`,
    );
  }
});

test("an unsupported browser, a busy worker and a dead one all render locally", () => {
  assert.equal(
    chooseRenderLane({ supported: true, busy: false, failures: 0 }),
    "worker",
  );
  assert.equal(
    chooseRenderLane({ supported: false, busy: false, failures: 0 }),
    "main",
  );
  // Never a queue: a second transferred page behind the first is ~96 MB.
  assert.equal(
    chooseRenderLane({ supported: true, busy: true, failures: 0 }),
    "main",
  );
  assert.equal(
    chooseRenderLane({
      supported: true,
      busy: false,
      failures: MAX_WORKER_FAILURES,
    }),
    "main",
  );
  assert.equal(
    chooseRenderLane({
      supported: true,
      busy: false,
      failures: MAX_WORKER_FAILURES - 1,
    }),
    "worker",
    "the last respawn is still worth taking",
  );
});

test("the job the worker is told to render is the job that was asked for", () => {
  // `ImageBitmap` is exactly width/height/close, so a stand-in needs no cast.
  const bitmap: ImageBitmap = { width: 1200, height: 1600, close: () => {} };
  const message = renderJobMessage(7, JOB, bitmap);

  assert.equal(message.generation, 7);
  assert.equal(message.bitmap, bitmap);
  // Same object, not a copy: the two lanes cannot drift over a spec they share.
  assert.equal(message.job, JOB);
  assert.deepEqual(message.job, { finish: "bw", rotation: 90, thumbLongEdge: 480 });
});

test("generations are handed out in order and each is live exactly once", () => {
  const ledger = new GenerationLedger();
  const first = ledger.next();
  const second = ledger.next();

  assert.ok(second > first);
  assert.equal(ledger.isLive(first), true);
  assert.equal(ledger.retire(first), true);
  assert.equal(ledger.isLive(first), false);
  // The reply that arrives after its own retirement — the stale render.
  assert.equal(ledger.retire(first), false);
  assert.equal(ledger.isLive(second), true);
});

test("a reply for a generation nobody issued is never live", () => {
  const ledger = new GenerationLedger();
  ledger.next();

  assert.equal(ledger.isLive(99), false);
  assert.equal(ledger.retire(99), false);
});

test("the ledger counts delivered generations, not encode attempts", () => {
  const final = new Blob();
  assert.deepEqual(
    deliveredEncodes({
      kind: "done",
      generation: 1,
      final,
      thumb: null,
      width: 900,
      height: 1200,
      encodes: ["final"],
    }),
    ["final"],
  );
  // A worker that encoded and then could not answer wrote bytes no page ever
  // carries: the local re-run's own encode is the only generation there is.
  assert.deepEqual(
    deliveredEncodes({
      kind: "failed",
      generation: 2,
      stage: "encode",
      message: "convertToBlob refused",
    }),
    [],
  );
  assert.deepEqual(
    deliveredEncodes({ kind: "unavailable", generation: 3, message: "no surface" }),
    [],
  );
});

test("retiring everything names what was still in the air, oldest first", () => {
  const ledger = new GenerationLedger();
  const first = ledger.next();
  const second = ledger.next();
  const third = ledger.next();
  ledger.retire(second);

  assert.deepEqual(ledger.retireAll(), [first, third]);
  assert.deepEqual(ledger.retireAll(), []);
  assert.equal(ledger.isLive(third), false);
  // Ids keep moving forward, so a cancelled job's number can never be reused.
  assert.ok(ledger.next() > third);
});
