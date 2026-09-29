import assert from "node:assert/strict";
import test from "node:test";

import {
  demoteDetectLane,
  detectLane,
  detectLaneReady,
  detectLaneReason,
  holdDetectLane,
  IDLE_RELEASE_MS,
  laneDetect,
  resetDetectLane,
  startDetectLane,
  type LaneJob,
} from "./detect-lane.ts";
import { isMlDisabled, isMlReady } from "./ml-detection.ts";
import type { DetectMessage, WorkerToMain } from "./detect-protocol.ts";
import { assetUrls } from "@/lib/runtime-config";

/**
 * The detection lane's choice and its worker's lifecycle, against a fake
 * thread and a fake clock — the rules a person never sees until they fail:
 * a worker that cannot run leaves the session on the main thread with a
 * reason; a worker that runs owns the model (its warm-up drives the latch);
 * a job's frame is always handed over (or closed); a worker that dies — or
 * whose model fails — answers every job it held with a miss and hands the
 * session back; a lane nobody holds any more is let go.
 *
 * Node has no DOM: `Worker`, `createImageBitmap` and the `window` timers are
 * installed here. The module keeps page-level state, so each test resets it.
 */

const URLS = assetUrls("/scan-assets");

type Behaviour = "hello" | "hello-no-canvas" | "hello-no-wasm" | "error" | "silent";
let behaviour: Behaviour = "hello";
const spawned: FakeWorker[] = [];

class FakeWorker {
  onmessage: ((event: { data: WorkerToMain }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly posted: { message: unknown; transfer: unknown[] }[] = [];
  terminated = false;
  readonly url: string;
  readonly options: { type?: string; name?: string };

  constructor(url: string, options: { type?: string; name?: string }) {
    this.url = url;
    this.options = options;
    spawned.push(this);
    const mode = behaviour;
    queueMicrotask(() => {
      if (mode === "hello") this.reply({ type: "hello", offscreen2d: true });
      else if (mode === "hello-no-canvas") this.reply({ type: "hello", offscreen2d: false });
      else if (mode === "hello-no-wasm") this.reply({ type: "hello", offscreen2d: true, wasm: false });
      else if (mode === "error") this.onerror?.();
    });
  }

  reply(data: WorkerToMain): void {
    this.onmessage?.({ data });
  }

  postMessage(message: unknown, transfer: unknown[] = []): void {
    this.posted.push({ message, transfer });
  }

  terminate(): void {
    this.terminated = true;
  }
}

const timers = new Map<number, { run: () => void; delay: number }>();
let nextTimer = 0;
Reflect.set(globalThis, "Worker", FakeWorker);
Reflect.set(globalThis, "createImageBitmap", () => Promise.resolve({}));
Reflect.set(globalThis, "window", {
  setTimeout(run: () => void, delay: number): number {
    nextTimer += 1;
    timers.set(nextTimer, { run, delay });
    return nextTimer;
  },
  clearTimeout(id: number): void {
    timers.delete(id);
  },
});

function fireTimers(delay?: number): void {
  for (const [id, timer] of [...timers]) {
    if (delay !== undefined && timer.delay !== delay) continue;
    timers.delete(id);
    timer.run();
  }
}

interface FakeFrame {
  closed: boolean;
  close(): void;
}

function frame(): LaneJob["frame"] {
  const fake: FakeFrame = {
    closed: false,
    close() {
      fake.closed = true;
    },
  };
  return fake as unknown as LaneJob["frame"];
}

function job(overrides: Partial<LaneJob> = {}): LaneJob {
  return {
    frame: frame(),
    width: 360,
    height: 640,
    plan: "ml",
    priority: "live",
    capturedAt: 1,
    epoch: 1,
    luma: true,
    refineMs: 0,
    evidence: true,
    held: null,
    hint: false,
    ...overrides,
  };
}

function fresh(mode: Behaviour): void {
  resetDetectLane();
  behaviour = mode;
  spawned.length = 0;
  timers.clear();
}

test("a worker that says hello with a canvas takes the session, and starts the model", async () => {
  fresh("hello");
  assert.equal(await startDetectLane(URLS), "worker");
  assert.equal(detectLaneReason(), "worker");
  const worker = spawned[0];
  assert.equal(worker.url, URLS.detectWorker);
  assert.deepEqual(worker.options, { type: "module", name: "azelo-scan-detect" });
  const init = worker.posted[0].message as { type: string; scanic: string; ml: { modelUrl: string; numThreads: number; proxy: boolean } };
  assert.equal(init.type, "init");
  assert.equal(init.scanic, URLS.scanic);
  assert.equal(init.ml.modelUrl, URLS.model);
  assert.equal(init.ml.numThreads, 1);
  assert.equal(init.ml.proxy, false);
  // Idempotent: one worker per page, whatever remounts.
  assert.equal(await startDetectLane(URLS), "worker");
  assert.equal(spawned.length, 1);
  // The model's warm-up in the worker drives the page's latch.
  assert.equal(isMlReady(), false);
  worker.reply({ type: "ml", ok: true, warmMs: 60 });
  assert.equal(isMlReady(), true);
});

test("no hello, an error, or no canvas in the worker: the main thread, with the reason", async () => {
  fresh("error");
  assert.equal(await startDetectLane(URLS), "main");
  assert.equal(detectLaneReason(), "worker-load-error");

  fresh("hello-no-canvas");
  assert.equal(await startDetectLane(URLS), "main");
  assert.equal(detectLaneReason(), "no-offscreen-canvas");
  assert.equal(spawned[0].terminated, true);

  fresh("hello-no-wasm");
  assert.equal(await startDetectLane(URLS), "main");
  assert.equal(detectLaneReason(), "no-wasm-in-worker");
  assert.equal(spawned[0].terminated, true);

  fresh("silent");
  const decided = startDetectLane(URLS);
  await Promise.resolve();
  fireTimers();
  assert.equal(await decided, "main");
  assert.equal(detectLaneReason(), "worker-timeout");
  assert.equal(spawned[0].terminated, true);
});

test("a job hands its frame over and gets the worker's answer; a dropped one answers null", async () => {
  fresh("hello");
  await startDetectLane(URLS);
  const worker = spawned[0];
  const first = job();
  const answer = laneDetect(first, 2500);
  const posted = worker.posted[1];
  const message = posted.message as DetectMessage;
  assert.equal(message.type, "detect");
  assert.deepEqual(posted.transfer, [first.frame]);
  worker.reply({
    type: "result",
    id: message.id,
    epoch: 1,
    capturedAt: 1,
    detector: "ml",
    success: true,
    corners: null,
    confidence: 0.99,
    fellThrough: false,
    mlFailed: false,
    computeMs: 12,
    detectMs: 9,
    queueMs: 0,
    luma: null,
    refined: null,
    refineMs: null,
    evidence: null,
    heldEvidence: null,
    hint: null,
  });
  const reply = await answer;
  assert.equal(reply.type === "result" ? reply.computeMs : null, 12);

  const second = laneDetect(job(), 2500);
  const secondId = (worker.posted[2].message as DetectMessage).id;
  worker.reply({ type: "dropped", id: secondId });
  assert.deepEqual(await second, { type: "miss", why: "dropped" });

  // A blown budget answers a timeout, and tells the worker to drop the job;
  // the late reply lands on nobody.
  const third = laneDetect(job(), 2500);
  const thirdId = (worker.posted[3].message as DetectMessage).id;
  fireTimers();
  assert.deepEqual(await third, { type: "miss", why: "timeout" });
  assert.deepEqual(worker.posted[4].message, { type: "cancel", id: thirdId });
});

test("a worker that dies answers every job it held with null and hands the session back", async () => {
  fresh("hello");
  await startDetectLane(URLS);
  const worker = spawned[0];
  worker.reply({ type: "ml", ok: true, warmMs: 60 });
  const pending = laneDetect(job(), 2500);
  worker.onerror?.();
  assert.deepEqual(await pending, { type: "miss", why: "gone" });
  assert.equal(detectLane(), "main");
  assert.equal(detectLaneReason(), "worker-crashed");
  assert.equal(worker.terminated, true);
  // The model was warm in the worker, not here: the main thread warms its own.
  assert.equal(isMlReady(), false);
  // A job on a lane that is no longer the worker's closes its frame and answers a miss.
  const late = job();
  assert.deepEqual(await laneDetect(late, 2500), { type: "miss", why: "gone" });
  assert.equal((late.frame as unknown as { closed: boolean }).closed, true);
});

test("the model failing in the worker moves the session to the main thread, never latches it off", async () => {
  fresh("hello");
  await startDetectLane(URLS);
  spawned[0].reply({ type: "ml", ok: false, warmMs: 30, reason: "no wasm" });
  assert.equal(isMlDisabled(), false);
  assert.equal(detectLane(), "main");
  assert.equal(detectLaneReason(), "worker-ml-failed");
  assert.equal(spawned[0].terminated, true);

  // scanic not loading in the worker at all is a lane matter too.
  fresh("hello");
  await startDetectLane(URLS);
  spawned[0].reply({ type: "init-failed", reason: "404" });
  assert.equal(detectLane(), "main");
  assert.equal(detectLaneReason(), "worker-init-failed");

  // The live loop's own verdicts (a stuck worker, frames it cannot take).
  fresh("hello");
  await startDetectLane(URLS);
  demoteDetectLane("worker-stalled");
  assert.equal(detectLane(), "main");
  assert.equal(detectLaneReason(), "worker-stalled");
});

test("the worker lane is ready for measured passes once scanic has loaded there", async () => {
  fresh("hello");
  await startDetectLane(URLS);
  let ready = false;
  void detectLaneReady().then(() => {
    ready = true;
  });
  await Promise.resolve();
  assert.equal(ready, false);
  spawned[0].reply({ type: "ready" });
  await Promise.resolve();
  assert.equal(ready, true);
  // A lane that moves wakes a waiter too.
  fresh("hello");
  await startDetectLane(URLS);
  let woken = false;
  void detectLaneReady().then(() => {
    woken = true;
  });
  spawned[0].onerror?.();
  await Promise.resolve();
  assert.equal(woken, true);
});

test("a held lane outlives its last holder by the idle grace, then lets the worker go", async () => {
  fresh("hello");
  const release = holdDetectLane(URLS);
  await startDetectLane(URLS);
  const worker = spawned[0];
  worker.reply({ type: "ml", ok: true, warmMs: 60 });
  release();
  // A remount inside the grace keeps the warm worker.
  const again = holdDetectLane(URLS);
  fireTimers(IDLE_RELEASE_MS);
  assert.equal(worker.terminated, false);
  assert.equal(spawned.length, 1);
  again();
  fireTimers(IDLE_RELEASE_MS);
  assert.equal(worker.terminated, true);
  assert.equal(detectLane(), null);
  assert.equal(isMlReady(), false);
  // The next mount decides afresh.
  const next = holdDetectLane(URLS);
  assert.equal(await startDetectLane(URLS), "worker");
  assert.equal(spawned.length, 2);
  next();
  timers.clear();
});

test("a mount with other assets, while nobody else holds the lane, starts it over", async () => {
  fresh("hello");
  const release = holdDetectLane(URLS);
  await startDetectLane(URLS);
  release();
  const other = assetUrls("/scan-assets-v2");
  const next = holdDetectLane(other);
  assert.equal(await startDetectLane(other), "worker");
  assert.equal(spawned[0].terminated, true);
  assert.equal(spawned[1].url, other.detectWorker);
  next();
  timers.clear();
});
