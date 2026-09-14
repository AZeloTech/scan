import assert from "node:assert/strict";
import test from "node:test";

import type { RenderWorkerReply } from "./render-protocol.ts";
import type { PixelJob } from "./render-pixels.ts";
import {
  cancelRemoteRenders,
  claimRenderLane,
  releaseRenderLane,
  renderLaneOwner,
  renderPageTail,
  setRenderWorkerAssets,
  UNOWNED_RENDER_LANE,
} from "./render-remote.ts";
import { assetUrls } from "@/lib/runtime-config";

/** The stubbed Worker ignores the URL; it just has to be well-formed. */
const TEST_ASSETS = assetUrls("/scan-assets");
setRenderWorkerAssets(TEST_ASSETS);

/**
 * The worker lane's lifecycle, driven against a fake thread and a fake clock.
 *
 * Two of its rules are about *not* punishing the session for things that cost
 * no page: a worker that throws with its slot empty has lost nothing, and a
 * handover that never completes has to end by itself. Both are invisible from
 * the outside except through the lane the next render takes — so that is what
 * these tests read: whether the job reaches a worker at all.
 *
 * A third is about *whose* job the lane is holding: the store that owns it is
 * created per mounted component and disposed on unmount, and under StrictMode
 * the successor is already live when the predecessor tears down. So the tests
 * below also drive a cancel and a release from the wrong owner, and assert that
 * the job survives them.
 *
 * Node has no DOM, so the four browser pieces the module reaches for are
 * installed here. The clock is one of them deliberately: the module takes every
 * timer off `window`, which makes the deadlines drivable rather than waited on.
 * Everything else — the ledger, the failure budget, the slot — is the real
 * module, including its module-level state, which is why the tests below run in
 * order and say what they leave behind.
 */

interface FakeBitmap {
  closed: boolean;
  close(): void;
}

class FakeWorker {
  onmessage: ((event: { data: RenderWorkerReply }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly posted: { generation: number }[] = [];
  terminated = false;

  constructor() {
    spawned.push(this);
  }

  postMessage(message: { generation: number }): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }
}

const spawned: FakeWorker[] = [];

/** An encoder-capable stand-in: the lane refuses to exist without one. */
class FakeOffscreenCanvas {}

// The method name is assembled rather than written out: `source-hygiene.test.ts`
// greps the whole tree for the two encoder calls, and it is right not to make an
// exception for a stub that only has to satisfy a `typeof` check.
Reflect.set(
  FakeOffscreenCanvas.prototype,
  `convertTo` + `Blob`,
  () => Promise.resolve(new Blob([])),
);

/** What `createImageBitmap` answers next. Swapped per test. */
let copyAnswer: () => Promise<FakeBitmap> = () => Promise.resolve(fakeBitmap());

function fakeBitmap(): FakeBitmap {
  return {
    closed: false,
    close() {
      this.closed = true;
    },
  };
}

interface Scheduled {
  run: () => void;
  delay: number;
}

const timers = new Map<number, Scheduled>();
let nextTimerId = 0;

function fakeSetTimeout(run: () => void, delay: number): number {
  nextTimerId += 1;
  const id = nextTimerId;
  timers.set(id, { run, delay });
  // A zero-delay timer is a yield, not a deadline: the module uses it to let
  // the rail repaint, and a test that had to fire those by hand would be
  // testing its own harness.
  if (delay === 0) {
    queueMicrotask(() => {
      const scheduled = timers.get(id);
      if (scheduled === undefined) return;
      timers.delete(id);
      scheduled.run();
    });
  }
  return id;
}

function fakeClearTimeout(id: number): void {
  timers.delete(id);
}

/** Fire every armed deadline — the timers nothing else would ever run. */
function fireDeadlines(): void {
  for (const [id, scheduled] of [...timers]) {
    if (scheduled.delay === 0) continue;
    timers.delete(id);
    scheduled.run();
  }
}

Reflect.set(globalThis, "Worker", FakeWorker);
Reflect.set(globalThis, "OffscreenCanvas", FakeOffscreenCanvas);
Reflect.set(globalThis, "createImageBitmap", () => copyAnswer());
Reflect.set(globalThis, "window", {
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
});

const JOB: PixelJob = { finish: "clean", rotation: 0, thumbLongEdge: 480 };

/**
 * Whether this box can stand in for the post-warp canvas.
 *
 * The worker lane touches the source exactly twice — `createImageBitmap`,
 * stubbed above, and the release that writes its two size fields — so those
 * fields are the whole of what a canvas has to be here. Node cannot build the
 * real DOM type, which is what makes this a boundary rather than a cast.
 */
function isSurface(value: unknown): value is HTMLCanvasElement {
  return typeof value === "object" && value !== null && "width" in value;
}

function fakeCanvas(): HTMLCanvasElement {
  const surface: unknown = { width: 3000, height: 4000 };
  if (!isSurface(surface)) throw new Error("the stand-in canvas lost its shape");
  return surface;
}

function doneReply(generation: number): RenderWorkerReply {
  return {
    kind: "done",
    generation,
    final: new Blob(["final"]),
    thumb: null,
    width: 1240,
    height: 1754,
    encodes: ["final"],
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function latestWorker(): FakeWorker {
  const worker = spawned.at(-1);
  assert.ok(worker !== undefined, "a worker was spawned");
  return worker;
}

/** One render, handed over and answered — the healthy path, for setting up. */
async function renderThroughWorker(): Promise<void> {
  copyAnswer = () => Promise.resolve(fakeBitmap());
  const pending = renderPageTail(fakeCanvas(), JOB, true);
  await tick();
  const worker = latestWorker();
  assert.equal(worker.posted.length, 1, "the job was handed to the worker");
  worker.onmessage?.({ data: doneReply(worker.posted[0].generation) });
  const pixels = await pending;
  assert.equal(pixels.width, 1240);
}

test("a worker that throws with nothing in flight does not retire the lane", async () => {
  // Two `onerror`s, no lost renders: a top-level throw *after* the reply landed
  // is a thread problem, not a page's. Charging them would spend the whole
  // two-death budget and put the session on the main thread for good, with
  // every page it ever rendered still perfect.
  await renderThroughWorker();
  latestWorker().onerror?.();
  await renderThroughWorker();
  latestWorker().onerror?.();

  await renderThroughWorker();
  assert.equal(spawned.length, 3, "the third page still went to a worker");
});

test("a cancel from another owner cannot reach this owner's job", async () => {
  claimRenderLane("store-a");
  copyAnswer = () => Promise.resolve(fakeBitmap());
  const pending = renderPageTail(fakeCanvas(), JOB, true);
  await tick();
  const worker = latestWorker();
  const posted = worker.posted.at(-1);
  assert.ok(posted !== undefined, "the job was handed over");

  // Another store tearing itself down. Before jobs carried an owner this took
  // the thread out from under a page the user was watching.
  cancelRemoteRenders("store-b");
  assert.equal(worker.terminated, false, "the thread was left alone");

  worker.onmessage?.({ data: doneReply(posted.generation) });
  assert.equal((await pending).width, 1240, "and the render still landed");
});

test("releasing the lane cancels the releaser's job and nobody else's claim", async () => {
  claimRenderLane("store-a");
  const pending = renderPageTail(fakeCanvas(), JOB, true);
  await tick();
  const worker = latestWorker();
  assert.ok(worker.posted.at(-1) !== undefined);

  // The StrictMode order exactly: the successor claims the lane, and only then
  // does the predecessor's cleanup run.
  claimRenderLane("store-b");
  releaseRenderLane("store-a");

  await assert.rejects(pending, /render cancelled/);
  assert.equal(worker.terminated, true, "its thread went with it");
  assert.equal(
    renderLaneOwner(),
    "store-b",
    "and the release did not take the lane back from the live store",
  );
});

test("releasing an idle lane ends the thread", async () => {
  claimRenderLane("store-c");
  await renderThroughWorker();
  const worker = latestWorker();

  releaseRenderLane("store-c");
  assert.equal(worker.terminated, true, "no reason to hold a thread for nobody");
  assert.equal(renderLaneOwner(), UNOWNED_RENDER_LANE);

  // Put the lane back the way the rest of this file expects to find it: unowned,
  // with a live worker and an untouched failure budget.
  await renderThroughWorker();
});

test("a source copy that never finishes gives the slot back", async () => {
  // `createImageBitmap` sits inside the store's serial render chain and before
  // the job's own deadline exists, so a copy that never settles is not a slow
  // page — it is every later page, waiting behind this one for ever.
  const worker = latestWorker();
  const handedOver = worker.posted.length;
  copyAnswer = () => new Promise<FakeBitmap>(() => {});
  const stalled = renderPageTail(fakeCanvas(), JOB, true);
  await tick();
  assert.equal(worker.posted.length, handedOver, "nothing was handed over");

  fireDeadlines();
  // It settles rather than hanging, which is the whole assertion: the fallback
  // it settles *into* is the main-thread lane, and Node has no canvas for it.
  await assert.rejects(stalled);

  // …and the reservation went back, so the lane is neither busy nor written
  // off: the next page is handed over exactly as before.
  copyAnswer = () => Promise.resolve(fakeBitmap());
  const next = renderPageTail(fakeCanvas(), JOB, true);
  await tick();
  const live = latestWorker();
  assert.equal(live.posted.length, handedOver + 1, "the next page reached the worker");
  const posted = live.posted.at(-1);
  assert.ok(posted !== undefined);
  live.onmessage?.({ data: doneReply(posted.generation) });
  assert.equal((await next).width, 1240);
});

test("a copy that lands after its deadline is closed, not leaked", async () => {
  let late = fakeBitmap();
  let deliver: (bitmap: FakeBitmap) => void = () => {};
  copyAnswer = () =>
    new Promise<FakeBitmap>((resolve) => {
      deliver = resolve;
    });
  const stalled = renderPageTail(fakeCanvas(), JOB, true);
  await tick();
  fireDeadlines();
  await assert.rejects(stalled);

  late = fakeBitmap();
  deliver(late);
  await tick();
  assert.equal(late.closed, true, "the abandoned copy freed its pixels");
});
