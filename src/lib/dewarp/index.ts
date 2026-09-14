/**
 * The engine's front door: one page in, one geometry out.
 *
 * Everything below this file is pure maths or a worker; this is where they are
 * put in order and where the decision actually gets made. The chain is a
 * ladder, cheapest rung first, and every rung can only ever do one of two
 * things — carry on, or return the homography with a reason:
 *
 *   capability → eligibility → inference → status → grid contract →
 *   geometric guards → low-resolution A/B against the caller's homography →
 *   full-resolution render
 *
 * Two seams are deliberate. The engine **does not compute homographies**: the
 * caller renders its own flat baseline (small — ~448 px long edge is plenty)
 * and hands it in, because the flat path already exists, already has a
 * canonical implementation, and must not grow a second one in here. And the
 * engine **does not decide what the user waits for**: it measures its own
 * device gate and exposes it, leaving the 12-second policy to integration,
 * where a spinner and a piece of copy live.
 *
 * No UI, no i18n, no store. Every string that leaves this file is a stable
 * identifier for telemetry, never something a person reads.
 */

import {
  dewarpAssets,
  DEWARP_WASM_VERSION,
  encodeDewarpAssets,
} from "./assets.ts";
import type { AssetUrls } from "../runtime-config.ts";
import {
  classicalFallbackReason,
  classicalOptsJson,
  cropToClassicalInput,
  normalizeQuadToCrop,
  parseClassicalStatus,
  type ClassicalStatus,
} from "./classical.ts";
import {
  CLASSICAL_MIN_CROP_SIDE_PX,
  evaluateComposedMap,
  evaluateEligibility,
} from "./guards.ts";
import type { EligibilityResult, MapGuardResult } from "./guards.ts";
import {
  CLASSICAL_GRID_HEIGHT,
  CLASSICAL_GRID_WIDTH,
  GridContractError,
  parseGridTensor,
} from "./grid.ts";
import type { CoarseGrid } from "./grid.ts";
import { fitLongEdge, renderThroughGrid, startTiledRender } from "./sampler.ts";
import {
  SEMANTIC_LONG_EDGE,
  measureSurface,
  semanticVerdict,
} from "./semantic.ts";
import type { SemanticVerdict } from "./semantic.ts";
import type {
  CropBox,
  DeviceGate,
  DewarpFallbackReason,
  DewarpJob,
  DewarpOutcome,
  DewarpProgress,
  RgbaImage,
} from "./types.ts";
import { resolveGeometryMode, type DewarpEngineMode } from "./engine-mode.ts";
import type {
  DewarpWorkerReply,
  DewarpWorkerRequest,
  RgbaCropBuffer,
} from "./worker-protocol.ts";

export { dewarpAssets, DEWARP_WASM_VERSION, type DewarpAssets } from "./assets.ts";
export {
  CLASSICAL_CROP_PAD,
  CROP_PAD_VERSION,
  cropPadForMode,
  outputDimsFromQuad,
  paddedCropBox,
  renderKeyFor,
} from "./crop.ts";
export { resolveGeometryMode, type DewarpEngineMode } from "./engine-mode.ts";
export type * from "./types.ts";

/**
 * The `modelVersion` `dewarp-stage.ts` feeds `renderKeyFor` — the vendored
 * wasm module's content hash, so rebuilding the engine invalidates every
 * cached render key by construction (`crop.ts::renderKeyFor` already hashes
 * `modelVersion` in, nothing new to build there). A free
 * function rather than a field on the shared engine because the caller needs
 * this *before* `runDewarp` exists to ask, to build the very job the run is
 * for.
 */
export function activeModelVersion(_mode: DewarpEngineMode = resolveGeometryMode()): string {
  return DEWARP_WASM_VERSION;
}

/**
 * The wall-clock budget integration applies to a *first* dewarp on a device.
 *
 * Exported as a number, not enforced here: the engine reports what it measured
 * and lets the product decide. A device that misses it once is a device that
 * should stop being offered the feature, which is a session-level decision the
 * engine has no business making.
 */
export const DEVICE_GATE_BUDGET_MS = 12_000;

/**
 * The engine's own safety net, well past the policy budget.
 *
 * Its job is not to enforce a user-facing wait — that is the gate above — but
 * to guarantee that a wedged WASM runtime cannot hold a page hostage forever.
 * When it fires the worker is terminated outright, because a runtime that has
 * not answered in half a minute is not going to.
 *
 * It is a deadline over the **whole** run — download, session creation,
 * inference, render — not over the worker exchange alone. A model response that
 * stalls after its headers is exactly as wedged as a stuck `session.run`, and it
 * used to have no deadline at all: the page stayed `processing`, the store's
 * render chain stayed blocked behind it, and the export never came back.
 */
export const HARD_TIMEOUT_MS = 30_000;

/* ── Capability ────────────────────────────────────────────────────────── */

/**
 * Can this browser run the engine at all?
 *
 * Checked before anything is fetched, so an old device pays nothing to be told
 * no. WebAssembly and Worker are the runtime; `fetch` streams the module.
 */
export function dewarpSupported(): boolean {
  return (
    typeof Worker === "function" &&
    typeof WebAssembly === "object" &&
    typeof fetch === "function"
  );
}

/* ── Worker handle ─────────────────────────────────────────────────────── */

/**
 * Exactly what the seam needs from a `Worker`.
 *
 * Named so a test — or a future runtime that is not a `Worker` — can stand in
 * without the engine knowing.
 */
export interface DewarpWorkerHandle {
  post(message: DewarpWorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
  onReply(handler: (reply: DewarpWorkerReply) => void): void;
  onCrash(handler: (reason: string) => void): void;
}

function wrapWorker(worker: Worker): DewarpWorkerHandle {
  return {
    post: (message, transfer) => worker.postMessage(message, transfer ?? []),
    terminate: () => worker.terminate(),
    onReply: (handler) => {
      worker.onmessage = (event: MessageEvent<DewarpWorkerReply>) =>
        handler(event.data);
    },
    onCrash: (handler) => {
      worker.onerror = (event: ErrorEvent) =>
        handler(event.message || "worker error");
      worker.onmessageerror = () => handler("worker message error");
    },
  };
}

/**
 * The `new URL(..., import.meta.url)` form is the one bundlers recognise, so the
 * worker's chunk is emitted rather than resolved at run time against a path that
 * does not exist. The literal has to stay inline at the call site — the
 * `new URL("./x.worker.ts", …)` expression itself is what is analysed, not a
 * variable holding one.
 *
 * The worker's **name** carries where the host put `assets/`: it cannot derive
 * that from its own URL, and it needs it before the first message
 * (`dewarp-classical.worker.ts`, `assets.ts::encodeDewarpAssets`).
 */
function spawnClassicalWorker(urls: AssetUrls): DewarpWorkerHandle {
  return wrapWorker(
    new Worker(urls.dewarpWorker, {
      type: "module",
      name: encodeDewarpAssets(dewarpAssets(urls)),
    }),
  );
}

/* ── Engine ────────────────────────────────────────────────────────────── */

export interface RunDewarpOptions {
  job: DewarpJob;
  /** The full-resolution canonical image the page was captured from. */
  canonical: RgbaImage;
  /**
   * The caller's own homography rendering of the same quad, small.
   * Anything up to ~448 px on the long edge; larger is downscaled here.
   */
  baseline: RgbaImage;
  onPhase?: (progress: DewarpProgress) => void;
  signal?: AbortSignal;
}

/** Numbers for telemetry and debugging. Never for copy. */
export interface DewarpDiagnostics {
  eligibility?: EligibilityResult;
  map?: MapGuardResult;
  verdict?: SemanticVerdict;
  /** Classical engine only — `dewarp_status_json`, parsed. */
  classicalStatus?: ClassicalStatus;
}

/**
 * The map a run accepted, kept so the *same* render can be produced again.
 *
 * A grid is ~11 kB and an inference is up to twelve seconds; when one logical
 * render has to be attempted twice — the finish failed, the render worker died
 * — the second attempt must resample this rather than ask the model again. Not
 * because the second answer would be different, but because it might not
 * arrive: a transient failure there would quietly cost the page its curvature
 * while the ladder believed it was only giving up the enhancement.
 *
 * Deliberately *not* a cache: it identifies nothing and outlives nothing. The
 * caller holds it for one logical render and drops it.
 */
export interface AcceptedGeometry {
  grid: CoarseGrid;
  crop: CropBox;
  width: number;
  height: number;
}

export interface DewarpRun {
  outcome: DewarpOutcome;
  /** Present only when `outcome.geometryMode !== "homography"` — i.e. either
   * producer succeeded. */
  surface?: RgbaImage;
  /** The accepted map, present exactly when `surface` is. */
  geometry?: AcceptedGeometry;
  deviceGate: DeviceGate;
  diagnostics: DewarpDiagnostics;
}

/**
 * The same page again, from a map that has already been accepted.
 *
 * One resample of the canonical, no worker, no model, no guards — they all ran
 * when the map was accepted and nothing about it has changed.
 */
export function renderAcceptedGeometry(
  source: RgbaImage,
  accepted: AcceptedGeometry,
): RgbaImage | null {
  return renderThroughGrid({
    source,
    grid: accepted.grid,
    crop: accepted.crop,
    width: accepted.width,
    height: accepted.height,
  });
}

export interface EngineConfig {
  /**
   * Where the host serves this library's runtime files (`assetBaseUrl`, run
   * through `runtime-config.ts::assetUrls`).
   *
   * Required, and a parameter rather than module state: the engine's worker
   * fetches the wasm from it, and a library that remembered a base in a module
   * variable would be a singleton the host cannot own. A test that supplies its
   * own {@link EngineConfig.spawnWorker} still passes one — the type says the
   * engine needs to know, and a stand-in worker is free to ignore it.
   */
  assets: AssetUrls;
  hardTimeoutMs?: number;
  /** The producer this instance is for — one value today, kept so the shared
   * engine map and the render key stay provably about the same one. */
  mode?: DewarpEngineMode;
  spawnWorker?: () => DewarpWorkerHandle;
  /** How the render loop gives the host a turn between tiles. */
  yieldToHost?: () => Promise<void>;
}

export interface DewarpEngine {
  runDewarp(options: RunDewarpOptions): Promise<DewarpRun>;
  /** Terminate the worker; the next run spawns a fresh one. */
  reset(): void;
  /** Terminate and refuse further runs. */
  dispose(): void;
  /** The last completed run's timings, or null before the first one. */
  readonly deviceGate: DeviceGate | null;
}

function defaultYield(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * The promise, or a rejection the instant the run's signal fires.
 *
 * The deadline has to be able to end a wait it does not own. A runtime that
 * swallows the abort would otherwise keep the whole run alive past its
 * deadline, which is the exact failure the deadline exists for. The abandoned
 * work is left to finish into nothing; what matters is that the page comes
 * back.
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(new Error("aborted"));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

/** Everything one {@link Engine.exchange} can end as. */
type ExchangeResult =
  | DewarpWorkerReply
  | { kind: "crash"; message: string }
  | { kind: "cancelled" };

/**
 * The one outstanding request, and what identifies its answer.
 *
 * The correlation is the point. A reply carries the page and the revision it
 * was computed for, and a reply that does not match the request we are waiting
 * for is *somebody else's page* — the previous one, still coming out of a WASM
 * run that could not be interrupted. Resolving the current wait with it would
 * apply one page's curvature to another's pixels, which is the single worst
 * thing this engine can do and is invisible in the result.
 */
interface PendingExchange {
  renderKey: string;
  generation: number;
  /** The worker instance the request was posted to. */
  worker: DewarpWorkerHandle;
  settle: (value: ExchangeResult) => void;
}

class Engine implements DewarpEngine {
  private worker: DewarpWorkerHandle | null = null;
  private workerHasSession = false;
  private pending: PendingExchange | null = null;
  private disposed = false;
  private lastGate: DeviceGate | null = null;
  private generationSeen = new Map<string, number>();
  // A plain field, not a parameter property: the test runner strips types
  // rather than compiling them, and parameter properties are real syntax.
  private readonly config: EngineConfig;
  /** Resolved once, at construction — never re-read. */
  private readonly mode: DewarpEngineMode;

  constructor(config: EngineConfig) {
    this.config = config;
    this.mode = config.mode ?? resolveGeometryMode();
  }

  get deviceGate(): DeviceGate | null {
    return this.lastGate;
  }

  reset(): void {
    this.worker?.terminate();
    this.worker = null;
    this.workerHasSession = false;
    const waiting = this.pending;
    this.pending = null;
    waiting?.settle({ kind: "crash", message: "reset" });
  }

  dispose(): void {
    this.reset();
    this.disposed = true;
  }

  private ensureWorker(): DewarpWorkerHandle {
    if (this.worker !== null) return this.worker;
    const worker =
      this.config.spawnWorker?.() ?? spawnClassicalWorker(this.config.assets);
    // `instance` is captured, not read off `this`: a terminated worker can
    // still deliver a message that was already in flight, and the only way to
    // recognise it is to remember which handle the handler belongs to.
    const instance = worker;
    worker.onReply((reply) => {
      const waiting = this.pending;
      if (waiting === null) return;
      if (waiting.worker !== instance || this.worker !== instance) return;
      if (
        reply.renderKey !== waiting.renderKey ||
        reply.generation !== waiting.generation
      ) {
        return;
      }
      this.pending = null;
      waiting.settle(reply);
    });
    worker.onCrash((message) => {
      // A crashed worker cannot be trusted with the next page either.
      if (this.worker === instance) {
        this.worker = null;
        this.workerHasSession = false;
      }
      const waiting = this.pending;
      if (waiting === null || waiting.worker !== instance) return;
      this.pending = null;
      waiting.settle({ kind: "crash", message });
    });
    this.worker = worker;
    return worker;
  }

  async runDewarp(options: RunDewarpOptions): Promise<DewarpRun> {
    const started = Date.now();
    const { job } = options;
    const diagnostics: DewarpDiagnostics = {};
    // Always 0 since the ONNX path was removed: the worker streams-instantiates
    // its own wasm, so what used to be a separate main-thread download is now
    // inside `initMs`. Kept in the gate so a device's timings stay comparable
    // across the cutover rather than silently changing shape.
    const downloadMs = 0;
    let initMs = 0;
    let firstInferenceMs = 0;

    // One deadline over the whole run, composed with the caller's own signal.
    // Everything below waits on `life` and nothing waits on a stage-local
    // timer, so a stall anywhere — a module that never instantiates, a wedged
    // inference — ends the same way, in
    // bounded time, with the page handed back.
    const life = new AbortController();
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      life.abort();
    }, this.config.hardTimeoutMs ?? HARD_TIMEOUT_MS);
    const onCallerAbort = (): void => life.abort();
    if (options.signal?.aborted === true) life.abort();
    else options.signal?.addEventListener("abort", onCallerAbort, { once: true });

    const finish = (
      reason: DewarpFallbackReason | null,
      surface?: RgbaImage,
      geometry?: AcceptedGeometry,
    ): DewarpRun => {
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", onCallerAbort);
      const gate: DeviceGate = {
        downloadMs,
        initMs,
        firstInferenceMs,
        totalMs: Date.now() - started,
      };
      this.lastGate = gate;
      const outcome: DewarpOutcome = {
        geometryMode: reason === null ? this.mode : "homography",
        requestedDewarp: true,
        modelVersion: DEWARP_WASM_VERSION,
        renderKey: job.renderKey,
        ...(reason === null ? {} : { fallbackReason: reason }),
      };
      return { outcome, surface, geometry, deviceGate: gate, diagnostics };
    };

    const aborted = (): boolean => life.signal.aborted;
    /** Why the run stopped: the deadline and the user are told apart here. */
    const stopped = (): DewarpFallbackReason => (timedOut ? "timeout" : "cancelled");

    options.onPhase?.({ phase: "checking" });
    if (this.disposed || !dewarpSupported()) return finish("unsupported");
    if (aborted()) return finish(stopped());

    // The newest generation for a page wins on this side too: a reply that
    // arrives for a quad the user has already moved past is not rendered.
    const seen = this.generationSeen.get(job.renderKey);
    if (seen !== undefined && job.generation < seen) return finish("cancelled");
    // A session is a handful of pages, each with a handful of re-crops; the cap
    // only stops a very long session from turning bookkeeping into a leak.
    if (this.generationSeen.size > 64) this.generationSeen.clear();
    this.generationSeen.set(job.renderKey, job.generation);

    const eligibility = evaluateEligibility(
      job.quad,
      job.crop,
      CLASSICAL_MIN_CROP_SIDE_PX,
    );
    diagnostics.eligibility = eligibility;
    if (!eligibility.eligible) return finish("ineligible-quad");

    const worker = this.ensureWorker();

    // `!workerHasSession` is the real question: the worker never receives model
    // bytes — it streams-instantiates its own wasm from a same-origin URL
    // (~130 KB gzipped) — but it still pays its one-time
    // instantiate cost on precisely this call.
    options.onPhase?.({ phase: this.workerHasSession ? "inferring" : "initializing" });
    const input: RgbaCropBuffer = cropToClassicalInput(options.canonical, job.crop);
    // Quad-aligned export framing: the confirmed quad is always in
    // hand by this point (eligibility already checked it above), so a run
    // always gets the quad-aligned framing hint — there is no
    // partial-confirmation state this ladder runs a job from.
    const optsJson = classicalOptsJson(normalizeQuadToCrop(job.quad, job.crop));

    const reply = await this.exchange(worker, {
      kind: "infer",
      generation: job.generation,
      renderKey: job.renderKey,
      input,
      optsJson,
    }, life.signal);

    // `cancelled` covers the deadline as well: the exchange has no clock of its
    // own any more, it simply waits on the run's one signal.
    if (reply.kind === "cancelled") return finish(stopped());
    if (reply.kind === "crash") {
      return finish(reply.message === "reset" ? "cancelled" : "worker-failed");
    }
    if (reply.kind === "failed") {
      if (reply.stage === "initializing") this.reset();
      return finish(reply.stage === "initializing" ? "model-unavailable" : "worker-failed");
    }
    this.workerHasSession = true;
    initMs = reply.initMs;
    firstInferenceMs = reply.inferMs;

    options.onPhase?.({ phase: "validating" });
    let grid: CoarseGrid;
    try {
      grid = parseGridTensor(reply, {
        width: CLASSICAL_GRID_WIDTH,
        height: CLASSICAL_GRID_HEIGHT,
      });
    } catch (error) {
      return finish(error instanceof GridContractError ? "grid-contract" : "worker-failed");
    }

    // The engine's own confidence layer — a
    // pre-guard rung, cheaper and earlier than the pixel-level guards below,
    // catching the degenerate-solution signatures those guards were never
    // designed to name. Unparseable or absent status is not itself a reason
    // to fall back: the guards and the semantic A/B are still coming.
    if (reply.statusJson !== undefined) {
      const status = parseClassicalStatus(reply.statusJson);
      if (status !== null) {
        diagnostics.classicalStatus = status;
        const reason = classicalFallbackReason(status);
        if (reason !== null) return finish(reason);
      }
    }

    const map = evaluateComposedMap(
      grid,
      job.crop,
      job.quad,
      job.canonicalWidth,
      job.canonicalHeight,
    );
    diagnostics.map = map;
    if (!map.ok) {
      const reason: DewarpFallbackReason =
        map.failure === "nonfinite"
          ? "guard-nonfinite"
          : map.failure === "out-of-bounds"
            ? "guard-bounds"
            : map.failure === "jacobian"
              ? "guard-jacobian"
              : map.failure === "scale"
                ? "guard-scale"
                : map.failure === "displacement"
                  ? "guard-displacement"
                  : "guard-boundary";
      return finish(reason);
    }
    if (aborted()) return finish(stopped());

    // The A/B runs at the comparison size, not the page's: it decides whether
    // the expensive render is worth doing at all.
    const preview = fitLongEdge(job.outputWidth, job.outputHeight, SEMANTIC_LONG_EDGE);
    const candidate = renderThroughGrid({
      source: options.canonical,
      grid,
      crop: job.crop,
      width: preview.width,
      height: preview.height,
      shouldCancel: aborted,
    });
    if (candidate === null) return finish(stopped());

    const verdict = semanticVerdict({
      baseline: measureSurface(options.baseline),
      candidate: measureSurface(candidate),
      structuralOk: map.ok,
      meanDisplacementFraction: map.stats.meanDisplacementFraction,
      boundaryOffsetFraction: map.stats.maxBoundaryOffsetFraction,
    });
    diagnostics.verdict = verdict;
    if (!verdict.accept) {
      return finish(
        verdict.rejection === "insufficient-evidence"
          ? "semantic-insufficient-evidence"
          : "semantic-regression",
      );
    }

    options.onPhase?.({ phase: "rendering" });
    const yieldToHost = this.config.yieldToHost ?? defaultYield;
    let surface: RgbaImage;
    try {
      const render = startTiledRender({
        source: options.canonical,
        grid,
        crop: job.crop,
        width: job.outputWidth,
        height: job.outputHeight,
      });
      while (!render.done) {
        if (aborted()) return finish(stopped());
        render.step();
        if (!render.done) await yieldToHost();
      }
      surface = render.image;
    } catch (error) {
      return finish("render-failed");
    }

    return finish(null, surface, {
      grid,
      crop: job.crop,
      width: job.outputWidth,
      height: job.outputHeight,
    });
  }

  /**
   * One request, one reply — correlated, and abandoned by dropping the runtime.
   *
   * The worker is single-flight by contract, so a second `exchange` while one
   * is outstanding is a bug, not a race — it settles the earlier one as a crash
   * rather than leaving a promise dangling.
   *
   * Abort **terminates the worker**. Nothing softer works: a `session.run` is
   * one synchronous call into WASM, so a `reset` message would not be read
   * until it finished, and the grid it eventually produced would arrive for a
   * page the user has already moved past. Losing the session costs one warm-up;
   * keeping it costs the chance of rendering the wrong page's curvature.
   */
  private exchange(
    worker: DewarpWorkerHandle,
    request: Extract<DewarpWorkerRequest, { kind: "infer" }>,
    signal: AbortSignal | undefined,
  ): Promise<ExchangeResult> {
    return new Promise((resolve) => {
      // A handle is only worth posting to while it is still *the* worker. One
      // that was dropped between being captured and being used — a crash
      // during the model download, a `reset` from another edit — answers
      // nothing, and its silence would be indistinguishable from a slow
      // inference until the run's hard deadline fired. Failing here turns a
      // 30-second wait into an immediate fallback.
      if (this.worker !== worker) {
        resolve({ kind: "crash", message: "worker-lost" });
        return;
      }
      let settled = false;
      const settle = (value: ExchangeResult): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        if (this.pending?.settle === settle) this.pending = null;
        resolve(value);
      };

      const onAbort = (): void => {
        settle({ kind: "cancelled" });
        this.reset();
      };

      const waiting = this.pending;
      this.pending = null;
      waiting?.settle({ kind: "crash", message: "superseded" });
      this.pending = {
        renderKey: request.renderKey,
        generation: request.generation,
        worker,
        settle,
      };
      if (signal?.aborted === true) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      // The crop is transferred, not cloned: a structured clone would be a
      // second full-resolution copy held on the phone for as long as the
      // worker takes to read the first.
      const transfer: Transferable[] = [request.input.data.buffer as ArrayBuffer];
      worker.post(request, transfer);
    });
  }
}

export function createEngine(config: EngineConfig): DewarpEngine {
  return new Engine(config);
}

/**
 * The one engine per mode — and therefore the one worker per mode — this app
 * is allowed.
 *
 * A second live instance is a second copy of the *same* wasm module and its
 * arena, on devices chosen for how little memory they have. With one producer
 * the map holds exactly one entry, which is the singleton this always was; it
 * stays a map keyed by {@link DewarpEngineMode} so the invariant survives a
 * second producer being added back rather than having to be rediscovered.
 */
const shared = new Map<DewarpEngineMode, DewarpEngine>();

export function sharedEngine(config: EngineConfig): DewarpEngine {
  const mode = config.mode ?? resolveGeometryMode();
  let engine = shared.get(mode);
  if (engine === undefined) {
    engine = createEngine({ ...config, mode });
    shared.set(mode, engine);
  }
  return engine;
}

/** Drop every shared engine; the next `sharedEngine()` builds fresh ones. */
export function disposeSharedEngine(): void {
  for (const engine of shared.values()) engine.dispose();
  shared.clear();
}
