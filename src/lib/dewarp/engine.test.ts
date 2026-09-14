/**
 * The client seam, driven end to end against a fake worker.
 *
 * The chain is the product: a page that asks for the curved geometry must come
 * back either dewarped or explicitly, nameably fallen back — never thrown
 * away, never silently flat. These tests replace only the one thing that is
 * genuinely of the browser (the Worker) and let the real crop, guards, sampler
 * and verdict run.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { DEWARP_WASM_VERSION } from "./assets.ts";
import { assetUrls } from "../runtime-config.ts";
import { outputDimsFromQuad, paddedCropBox, renderKeyFor } from "./crop.ts";
import { CLASSICAL_GRID_HEIGHT, CLASSICAL_GRID_WIDTH } from "./grid.ts";
import {
  activeModelVersion,
  createEngine,
  disposeSharedEngine,
  sharedEngine,
  type DewarpWorkerHandle,
} from "./index.ts";
import type { CropBox, DewarpJob, DewarpQuad, RgbaImage } from "./types.ts";
import type {
  DewarpWorkerReply,
  DewarpWorkerRequest,
  RgbaCropBuffer,
} from "./worker-protocol.ts";

/**
 * What a host that ran `scan-copy-assets` would pass. Every engine here spawns
 * a fake worker instead of a real one, so nothing is ever fetched from it — it
 * is present because the engine's type says the engine has to be told.
 */
const TEST_ASSETS = assetUrls("/scan-assets/");

// `dewarpSupported()` asks the platform for a Worker constructor. Node has
// none, and the engine is right to refuse to run there — so the tests that are
// *not* about capability install a stand-in. Reflect rather than assignment:
// the ambient DOM typing of `globalThis.Worker` will not accept a stub, and
// the point here is the `typeof` check, not the interface.
async function withWorkerGlobal<T>(body: () => Promise<T>): Promise<T> {
  const had = "Worker" in globalThis;
  const previous = had ? Reflect.get(globalThis, "Worker") : undefined;
  Reflect.set(globalThis, "Worker", class {});
  try {
    return await body();
  } finally {
    if (had) Reflect.set(globalThis, "Worker", previous);
    else Reflect.deleteProperty(globalThis, "Worker");
  }
}

const CANONICAL_WIDTH = 900;
const CANONICAL_HEIGHT = 1200;

function pageQuad(): DewarpQuad {
  return {
    topLeft: { x: 200, y: 250 },
    topRight: { x: 700, y: 250 },
    bottomRight: { x: 700, y: 950 },
    bottomLeft: { x: 200, y: 950 },
  };
}

function jobFor(quad: DewarpQuad, generation = 1): DewarpJob {
  const crop = paddedCropBox(quad, CANONICAL_WIDTH, CANONICAL_HEIGHT);
  const dims = outputDimsFromQuad(quad);
  return {
    generation,
    renderKey: renderKeyFor({
      sourceId: "page-1",
      quad,
      padVersion: "pad-v1",
      modelVersion: "test",
    }),
    quad,
    canonicalWidth: CANONICAL_WIDTH,
    canonicalHeight: CANONICAL_HEIGHT,
    crop,
    outputWidth: dims.width,
    outputHeight: dims.height,
  };
}

/** Rows of dark blobs on white — enough text evidence for the A/B to speak. */
function canonicalPage(): RgbaImage {
  const data = new Uint8ClampedArray(CANONICAL_WIDTH * CANONICAL_HEIGHT * 4);
  data.fill(255);
  for (let lineY = 300; lineY < 900; lineY += 40) {
    for (let x = 230; x < 670; x += 20) {
      for (let dy = 0; dy < 10; dy += 1) {
        for (let dx = 0; dx < 12; dx += 1) {
          const offset = ((lineY + dy) * CANONICAL_WIDTH + x + dx) * 4;
          data[offset] = 20;
          data[offset + 1] = 20;
          data[offset + 2] = 20;
        }
      }
    }
  }
  return { width: CANONICAL_WIDTH, height: CANONICAL_HEIGHT, data };
}

/**
 * The grid a *correct* engine would emit for a flat page at this quad: the
 * affine map from the output rectangle onto the quad, expressed in the crop's
 * own [-1,1] coordinates, at the engine's 65×47 density.
 */
function gridForQuad(quad: DewarpQuad, crop: CropBox): Float32Array {
  const plane = CLASSICAL_GRID_HEIGHT * CLASSICAL_GRID_WIDTH;
  const values = new Float32Array(plane * 2);
  for (let row = 0; row < CLASSICAL_GRID_HEIGHT; row += 1) {
    const v = row / (CLASSICAL_GRID_HEIGHT - 1);
    for (let column = 0; column < CLASSICAL_GRID_WIDTH; column += 1) {
      const u = column / (CLASSICAL_GRID_WIDTH - 1);
      const x = quad.topLeft.x + u * (quad.topRight.x - quad.topLeft.x);
      const y = quad.topLeft.y + v * (quad.bottomLeft.y - quad.topLeft.y);
      const index = row * CLASSICAL_GRID_WIDTH + column;
      values[index] = (2 * (x - crop.left)) / (crop.width - 1) - 1;
      values[plane + index] = (2 * (y - crop.top)) / (crop.height - 1) - 1;
    }
  }
  return values;
}

/** A healthy `dewarp_status_json` payload — nothing in it should fall back. */
function healthyClassicalStatus(): string {
  return JSON.stringify({
    converged: true,
    kept_text_lines: 16,
    total_text_lines: 17,
    kept_segments: 0,
    total_candidates: 0,
    uses_confidence_filter: true,
    bound_saturation: { a: [false, false, true, true], rvec: [false, false, false], log_f: false },
    output_aspect: 0.75,
    input_aspect: 0.75,
    boundary_used: false,
    residual_text_straightness_p90: 1.8,
    residual_boundary_mean_px: null,
    window_clip: { left: 0, right: 0, top: 0, bottom: 0, area_frac: 1 },
    window_clips_text: false,
    quad_corner_residual: 0.01,
    elapsed_ms: 3200,
  });
}

interface FakeWorker {
  handle: DewarpWorkerHandle;
  requests: DewarpWorkerRequest[];
}

function fakeWorker(
  answer: (request: DewarpWorkerRequest) => DewarpWorkerReply | null,
): FakeWorker {
  const requests: DewarpWorkerRequest[] = [];
  let onReply: ((reply: DewarpWorkerReply) => void) | null = null;
  return {
    requests,
    handle: {
      post(message) {
        requests.push(message);
        const reply = answer(message);
        if (reply !== null) queueMicrotask(() => onReply?.(reply));
      },
      terminate() {},
      onReply(handler) {
        onReply = handler;
      },
      onCrash() {},
    },
  };
}

function gridReply(request: DewarpWorkerRequest, data: Float32Array): DewarpWorkerReply {
  const infer = request as Extract<DewarpWorkerRequest, { kind: "infer" }>;
  return {
    kind: "grid",
    generation: infer.generation,
    renderKey: infer.renderKey,
    dims: [1, 2, CLASSICAL_GRID_HEIGHT, CLASSICAL_GRID_WIDTH],
    type: "float32",
    data,
    initMs: 120,
    inferMs: 340,
  };
}

/**
 * A worker that answers only when the test says so.
 *
 * The bugs this file has to be able to see are all about *when* a reply lands
 * — after an abort, for another page, from an instance that has been dropped —
 * so the reply has to be a thing the test holds, not something the fake decides.
 */
interface ScriptedWorker {
  handle: DewarpWorkerHandle;
  requests: Extract<DewarpWorkerRequest, { kind: "infer" }>[];
  terminated: boolean;
  /** Deliver a reply to whoever this instance's handler is. */
  reply(reply: DewarpWorkerReply): void;
  /** Deliver a crash — the thread died on its own, whenever the test says. */
  crash(message: string): void;
  /** Set to make every post die on the next microtask, as a bad deploy does. */
  crashOnPost: string | null;
}

function scriptedWorker(): ScriptedWorker {
  let onReply: ((reply: DewarpWorkerReply) => void) | null = null;
  let onCrash: ((message: string) => void) | null = null;
  let dead = false;
  const worker: ScriptedWorker = {
    requests: [],
    terminated: false,
    crashOnPost: null,
    reply(reply) {
      onReply?.(reply);
    },
    crash(message) {
      dead = true;
      onCrash?.(message);
    },
    handle: {
      post(message) {
        // A thread that has already died is silent, whatever is posted to it —
        // which is exactly what makes posting into a stale handle a wait for
        // nothing rather than an error.
        if (dead || worker.terminated) return;
        if (message.kind === "infer") worker.requests.push(message);
        const dying = worker.crashOnPost;
        if (dying !== null) {
          queueMicrotask(() => {
            dead = true;
            onCrash?.(dying);
          });
        }
      },
      terminate() {
        worker.terminated = true;
      },
      onReply(handler) {
        onReply = handler;
      },
      onCrash(handler) {
        onCrash = handler;
      },
    },
  };
  return worker;
}

/** Let every pending microtask and the engine's own yields run. */
function tick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

test("a browser without a Worker gets the homography and spends nothing", async () => {
  const engine = createEngine({
    assets: TEST_ASSETS,
    spawnWorker: () => {
      throw new Error("must not spawn");
    },
  });
  const quad = pageQuad();
  const run = await engine.runDewarp({
    job: jobFor(quad),
    canonical: canonicalPage(),
    baseline: canonicalPage(),
  });
  assert.equal(run.outcome.geometryMode, "homography");
  assert.equal(run.outcome.requestedDewarp, true);
  assert.equal(run.outcome.fallbackReason, "unsupported");
});

test("an ineligible quad never reaches the worker", async () => {
  await withWorkerGlobal(async () => {
    let spawned = 0;
    const worker = fakeWorker(() => null);
    const engine = createEngine({
      assets: TEST_ASSETS,
      spawnWorker: () => {
        spawned += 1;
        return worker.handle;
      },
    });
    // A sliver: fails the fill test long before anything is downloaded.
    const sliver: DewarpQuad = {
      topLeft: { x: 100, y: 100 },
      topRight: { x: 800, y: 900 },
      bottomRight: { x: 800, y: 920 },
      bottomLeft: { x: 100, y: 120 },
    };
    const run = await engine.runDewarp({
      job: jobFor(sliver),
      canonical: canonicalPage(),
      baseline: canonicalPage(),
    });
    assert.equal(run.outcome.fallbackReason, "ineligible-quad");
    assert.equal(spawned, 0);
    assert.equal(worker.requests.length, 0);
  });
});

test("a correct grid produces a dewarped surface at the homography's own size", async () => {
  await withWorkerGlobal(async () => {
    const quad = pageQuad();
    const job = jobFor(quad);
    const worker = fakeWorker((request) =>
      gridReply(request, gridForQuad(quad, job.crop)),
    );
    const phases: string[] = [];
    const engine = createEngine({
      assets: TEST_ASSETS,
      spawnWorker: () => worker.handle,
      yieldToHost: async () => {},
    });
    const canonical = canonicalPage();
    const run = await engine.runDewarp({
      job,
      canonical,
      // The caller's homography of the same quad. For a flat page it is the
      // same pixels the correct grid produces, so the A/B sees a wash.
      baseline: canonical,
      onPhase: (progress) => phases.push(progress.phase),
    });

    assert.equal(run.outcome.geometryMode, "classical", JSON.stringify(run.diagnostics));
    assert.equal(run.outcome.fallbackReason, undefined);
    assert.equal(run.surface?.width, job.outputWidth);
    assert.equal(run.surface?.height, job.outputHeight);
    assert.deepEqual(run.outcome.renderKey, job.renderKey);
    assert.ok(phases.includes("rendering"));
    assert.equal(run.deviceGate.initMs, 120);
    assert.equal(run.deviceGate.firstInferenceMs, 340);
    assert.equal(engine.deviceGate?.firstInferenceMs, 340);
  });
});

test("the dewarped surface really is the page, not the padded crop", async () => {
  await withWorkerGlobal(async () => {
    const quad = pageQuad();
    const job = jobFor(quad);
    const worker = fakeWorker((request) =>
      gridReply(request, gridForQuad(quad, job.crop)),
    );
    const engine = createEngine({
      assets: TEST_ASSETS,
      spawnWorker: () => worker.handle,
      yieldToHost: async () => {},
    });
    const canonical = canonicalPage();
    const run = await engine.runDewarp({ job, canonical, baseline: canonical });
    const surface = run.surface;
    assert.ok(surface !== undefined);

    // The quad's top-left is white paper; the grid maps output (0,0) there.
    const corner = surface.data.slice(0, 3);
    assert.deepEqual([...corner], [255, 255, 255]);
    // …and somewhere in the middle there is ink, so the page came through.
    let dark = 0;
    for (let index = 0; index < surface.data.length; index += 4) {
      if (surface.data[index] < 128) dark += 1;
    }
    assert.ok(dark > 1000, `only ${dark} dark pixels in the dewarped page`);
  });
});

test("a grid of the wrong shape is a contract failure, not a crash", async () => {
  await withWorkerGlobal(async () => {
    const quad = pageQuad();
    const job = jobFor(quad);
    const worker = fakeWorker((request) => {
      const reply = gridReply(request, new Float32Array(10));
      return { ...reply, dims: [1, 2, 7, 7] } as DewarpWorkerReply;
    });
    const engine = createEngine({
      assets: TEST_ASSETS,
      spawnWorker: () => worker.handle,
    });
    const canonical = canonicalPage();
    const run = await engine.runDewarp({ job, canonical, baseline: canonical });
    assert.equal(run.outcome.geometryMode, "homography");
    assert.equal(run.outcome.fallbackReason, "grid-contract");
  });
});

test("a worker that fails mid-inference hands the page back", async () => {
  await withWorkerGlobal(async () => {
    const quad = pageQuad();
    const job = jobFor(quad);
    const worker = fakeWorker((request) => {
      const infer = request as Extract<DewarpWorkerRequest, { kind: "infer" }>;
      return {
        kind: "failed",
        generation: infer.generation,
        renderKey: infer.renderKey,
        stage: "inferring",
        message: "wasm trap",
      };
    });
    const engine = createEngine({
      assets: TEST_ASSETS,
      spawnWorker: () => worker.handle,
    });
    const canonical = canonicalPage();
    const run = await engine.runDewarp({ job, canonical, baseline: canonical });
    assert.equal(run.outcome.fallbackReason, "worker-failed");
  });
});

test("a module that cannot be instantiated falls back rather than throwing", async () => {
  await withWorkerGlobal(async () => {
    // The worker streams-instantiates its own wasm; a 404 or a bad MIME type
    // surfaces as a `failed` reply at the `initializing` stage, which is the
    // one the ladder names `model-unavailable`.
    const worker = fakeWorker((request) => {
      const infer = request as Extract<DewarpWorkerRequest, { kind: "infer" }>;
      return {
        kind: "failed",
        generation: infer.generation,
        renderKey: infer.renderKey,
        stage: "initializing",
        message: "404",
      };
    });
    const engine = createEngine({ assets: TEST_ASSETS, spawnWorker: () => worker.handle });
    const canonical = canonicalPage();
    const run = await engine.runDewarp({
      job: jobFor(pageQuad()),
      canonical,
      baseline: canonical,
    });
    assert.equal(run.outcome.fallbackReason, "model-unavailable");
  });
});

test("an identity grid is rejected: it would crop to the pad, not to the page", async () => {
  await withWorkerGlobal(async () => {
    const quad = pageQuad();
    const job = jobFor(quad);
    const plane = CLASSICAL_GRID_HEIGHT * CLASSICAL_GRID_WIDTH;
    const values = new Float32Array(plane * 2);
    for (let row = 0; row < CLASSICAL_GRID_HEIGHT; row += 1) {
      for (let column = 0; column < CLASSICAL_GRID_WIDTH; column += 1) {
        const index = row * CLASSICAL_GRID_WIDTH + column;
        values[index] = (2 * column) / (CLASSICAL_GRID_WIDTH - 1) - 1;
        values[plane + index] = (2 * row) / (CLASSICAL_GRID_HEIGHT - 1) - 1;
      }
    }
    const worker = fakeWorker((request) => gridReply(request, values));
    const engine = createEngine({
      assets: TEST_ASSETS,
      spawnWorker: () => worker.handle,
    });
    const canonical = canonicalPage();
    const run = await engine.runDewarp({ job, canonical, baseline: canonical });
    assert.equal(run.outcome.fallbackReason, "guard-boundary");
  });
});

test("a cancel then an immediate re-enable does not inherit the first page's grid", async () => {
  await withWorkerGlobal(async () => {
    const spawned: ScriptedWorker[] = [];
    const engine = createEngine({
      assets: TEST_ASSETS,
      spawnWorker: () => {
        const worker = scriptedWorker();
        spawned.push(worker);
        return worker.handle;
      },
      yieldToHost: async () => {},
    });
    const canonical = canonicalPage();

    const quadA = pageQuad();
    const jobA = jobFor(quadA);
    const controller = new AbortController();
    const first = engine.runDewarp({
      job: jobA,
      canonical,
      baseline: canonical,
      signal: controller.signal,
    });
    await tick();
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].requests.length, 1);

    // The user turns it off. A solve already inside WASM cannot be told to
    // stop, so the runtime itself has to go.
    controller.abort();
    assert.equal((await first).outcome.fallbackReason, "cancelled");
    assert.equal(spawned[0].terminated, true);

    // …and immediately back on, for a different page at the same revision.
    const quadB: DewarpQuad = {
      topLeft: { x: 180, y: 230 },
      topRight: { x: 690, y: 235 },
      bottomRight: { x: 690, y: 930 },
      bottomLeft: { x: 180, y: 925 },
    };
    const jobB = jobFor(quadB);
    assert.notEqual(jobB.renderKey, jobA.renderKey);
    const second = engine.runDewarp({ job: jobB, canonical, baseline: canonical });
    await tick();
    assert.equal(spawned.length, 2, "the abandoned run took its worker with it");

    // The abandoned inference finally finishes, on the instance nobody is
    // listening to any more…
    spawned[0].reply(gridReply(spawned[0].requests[0], gridForQuad(quadA, jobA.crop)));
    // …and page A's answer even turns up on the live instance. Neither is an
    // answer to the question that is actually outstanding.
    spawned[1].reply(gridReply(spawned[0].requests[0], gridForQuad(quadA, jobA.crop)));
    await tick();

    spawned[1].reply(gridReply(spawned[1].requests[0], gridForQuad(quadB, jobB.crop)));
    const run = await second;
    assert.equal(run.outcome.geometryMode, "classical", JSON.stringify(run.diagnostics));
    assert.equal(run.outcome.renderKey, jobB.renderKey);
    assert.equal(run.surface?.width, jobB.outputWidth);
  });
});

test("a stale generation for the same page is not the reply being waited for", async () => {
  await withWorkerGlobal(async () => {
    const worker = scriptedWorker();
    const engine = createEngine({
      assets: TEST_ASSETS,
      spawnWorker: () => worker.handle,
      yieldToHost: async () => {},
    });
    const quad = pageQuad();
    const job = jobFor(quad, 7);
    const canonical = canonicalPage();
    const run = engine.runDewarp({ job, canonical, baseline: canonical });
    await tick();

    const good = gridReply(worker.requests[0], gridForQuad(quad, job.crop));
    // The previous crop of the same page, arriving late. Same worker, same
    // page, older revision — and the pixels it describes are not these.
    const stale = gridReply(
      { ...worker.requests[0], generation: 6 },
      new Float32Array(4),
    );
    worker.reply(stale);
    await tick();
    worker.reply(good);

    const settled = await run;
    assert.equal(settled.outcome.geometryMode, "classical", JSON.stringify(settled.diagnostics));
    assert.equal(settled.deviceGate.firstInferenceMs, 340);
  });
});

test("a worker that never answers ends the run on the deadline", async () => {
  await withWorkerGlobal(async () => {
    const engine = createEngine({
      assets: TEST_ASSETS,
      // A thread that takes the request and goes quiet: no reply, no crash, no
      // end. Without the run-wide deadline this holds the page for ever.
      spawnWorker: () => scriptedWorker().handle,
      hardTimeoutMs: 20,
    });
    const canonical = canonicalPage();
    const run = await engine.runDewarp({
      job: jobFor(pageQuad()),
      canonical,
      baseline: canonical,
    });
    assert.equal(run.outcome.geometryMode, "homography");
    assert.equal(run.outcome.fallbackReason, "timeout");
  });
});

/**
 * The broken-deploy case: a worker whose module fetch is served with the wrong
 * MIME type takes the thread down the moment it tries to instantiate it. This
 * is about time as much as outcome — before {@link Engine.exchange} refused a
 * stale handle, the run posted into a terminated instance and every page
 * waited out the full hard timeout for a reply that could never come.
 */
test("a thread that cannot be kept alive hands the page back at once, not on the deadline", async () => {
  await withWorkerGlobal(async () => {
    const spawned: ScriptedWorker[] = [];
    const engine = createEngine({
      assets: TEST_ASSETS,
      spawnWorker: () => {
        const worker = scriptedWorker();
        // Every instance of this deploy dies the same way, replacement included.
        worker.crashOnPost = "failed to instantiate the engine module";
        spawned.push(worker);
        return worker.handle;
      },
      hardTimeoutMs: 2_000,
      yieldToHost: async () => {},
    });
    const canonical = canonicalPage();
    const started = Date.now();
    const run = engine.runDewarp({
      job: jobFor(pageQuad()),
      canonical,
      baseline: canonical,
    });
    await tick();

    const settled = await run;
    assert.equal(settled.outcome.fallbackReason, "worker-failed");
    assert.ok(
      Date.now() - started < 1_000,
      "the page waited for the hard deadline instead of the dead thread",
    );
  });
});

test("an aborted run is cancelled, not fallen back on some other grounds", async () => {
  await withWorkerGlobal(async () => {
    const controller = new AbortController();
    const quad = pageQuad();
    const job = jobFor(quad);
    const worker = fakeWorker((request) => {
      controller.abort();
      return gridReply(request, gridForQuad(quad, job.crop));
    });
    const engine = createEngine({
      assets: TEST_ASSETS,
      spawnWorker: () => worker.handle,
    });
    const canonical = canonicalPage();
    const run = await engine.runDewarp({
      job,
      canonical,
      baseline: canonical,
      signal: controller.signal,
    });
    assert.equal(run.outcome.geometryMode, "homography");
    assert.equal(run.outcome.fallbackReason, "cancelled");
  });
});

/* ── The status rung ──────────────────────────────────────────────────────
 * Everything above drives the ladder with a status-less reply, which the
 * status rung skips by design. These two put a real `dewarp_status_json` on
 * the reply and exercise it in both directions.
 */

test("a healthy status and a correct 65×47 grid dewarp the page", async () => {
  await withWorkerGlobal(async () => {
    const quad = pageQuad();
    const job = jobFor(quad);
    const worker = fakeWorker((request) => {
      const infer = request as Extract<DewarpWorkerRequest, { kind: "infer" }>;
      return {
        kind: "grid",
        generation: infer.generation,
        renderKey: infer.renderKey,
        dims: [1, 2, CLASSICAL_GRID_HEIGHT, CLASSICAL_GRID_WIDTH],
        type: "float32",
        data: gridForQuad(quad, job.crop),
        initMs: 40,
        inferMs: 900,
        statusJson: healthyClassicalStatus(),
      };
    });
    const canonical = canonicalPage();
    const engine = createEngine({
      assets: TEST_ASSETS,
      spawnWorker: () => worker.handle,
      yieldToHost: async () => {},
    });
    const phases: string[] = [];
    const run = await engine.runDewarp({
      job,
      canonical,
      baseline: canonical,
      onPhase: (progress) => phases.push(progress.phase),
    });

    assert.equal(run.outcome.geometryMode, "classical", JSON.stringify(run.diagnostics));
    assert.equal(run.outcome.fallbackReason, undefined);
    assert.equal(run.outcome.modelVersion, DEWARP_WASM_VERSION);
    assert.equal(run.surface?.width, job.outputWidth);
    assert.equal(run.surface?.height, job.outputHeight);
    assert.equal(run.diagnostics.classicalStatus?.converged, true);
    // Never the "downloading" phase — the worker's own streaming instantiate
    // is invisible to the main thread, and since the
    // ONNX path was removed nothing on this thread fetches anything at all.
    assert.ok(!phases.includes("downloading"));
    assert.ok(phases.includes("initializing"));

    // And the request the worker actually received was the RGBA crop shape.
    const sent = worker.requests[0] as Extract<DewarpWorkerRequest, { kind: "infer" }>;
    const buffer: RgbaCropBuffer = sent.input;
    assert.equal(buffer.data.length, buffer.width * buffer.height * 4);
  });
});

test("a non-convergent status falls back before the pixel guards ever run", async () => {
  await withWorkerGlobal(async () => {
    const quad = pageQuad();
    const job = jobFor(quad);
    const worker = fakeWorker((request) => {
      const infer = request as Extract<DewarpWorkerRequest, { kind: "infer" }>;
      return {
        kind: "grid",
        generation: infer.generation,
        renderKey: infer.renderKey,
        dims: [1, 2, CLASSICAL_GRID_HEIGHT, CLASSICAL_GRID_WIDTH],
        type: "float32",
        // A geometrically perfect grid — if the status check did not run
        // first, the pixel guards and the semantic A/B would happily accept
        // this and the test would (wrongly) see "classical" as the outcome.
        data: gridForQuad(quad, job.crop),
        initMs: 40,
        inferMs: 900,
        statusJson: JSON.stringify({
          converged: false,
          kept_text_lines: 0,
          total_text_lines: 0,
          kept_segments: 0,
          total_candidates: 0,
          uses_confidence_filter: false,
          bound_saturation: { a: [false, false, false, false], rvec: [false, false, false], log_f: false },
          output_aspect: 0.75,
          input_aspect: 0.75,
          boundary_used: false,
          residual_text_straightness_p90: 0,
          residual_boundary_mean_px: null,
          elapsed_ms: 80,
        }),
      };
    });
    const canonical = canonicalPage();
    const engine = createEngine({
      assets: TEST_ASSETS,
      spawnWorker: () => worker.handle,
      yieldToHost: async () => {},
    });
    const run = await engine.runDewarp({ job, canonical, baseline: canonical });

    assert.equal(run.outcome.geometryMode, "homography");
    assert.equal(run.outcome.fallbackReason, "classical-non-convergent");
    // The status rung ran before the pixel guards even had a chance to score
    // this (geometrically fine) grid — `diagnostics.map` was never set.
    assert.equal(run.diagnostics.map, undefined);
  });
});

/**
 * One producer, therefore one live instance — a second one is a second copy of
 * the same wasm module and its arena on a phone chosen for how little memory it
 * has. Nothing here spawns a real worker: `sharedEngine` only builds the
 * instance, it does not talk to it, so these are plain identity checks.
 */
test("sharedEngine hands back the same instance every time", () => {
  disposeSharedEngine();
  const first = sharedEngine({ assets: TEST_ASSETS });
  assert.equal(sharedEngine({ assets: TEST_ASSETS }), first);
  assert.equal(sharedEngine({ assets: TEST_ASSETS, mode: "classical" }), first);
  disposeSharedEngine();
});

test("disposeSharedEngine drops the instance rather than reusing a disposed one", () => {
  disposeSharedEngine();
  const before = sharedEngine({ assets: TEST_ASSETS });
  disposeSharedEngine();
  assert.notEqual(sharedEngine({ assets: TEST_ASSETS }), before);
  disposeSharedEngine();
});

test("activeModelVersion is the vendored wasm module's content hash", () => {
  assert.equal(activeModelVersion(), DEWARP_WASM_VERSION);
  assert.equal(activeModelVersion("classical"), DEWARP_WASM_VERSION);
});
