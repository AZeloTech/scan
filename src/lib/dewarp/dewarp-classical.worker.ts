/**
 * The classical engine's worker — the only place the vendored
 * `dewarp-rs` wasm module exists, mirroring `dewarp.worker.ts`'s role for
 * ONNX Runtime. No `onnxruntime-web` import anywhere in this
 * file: the two engines' workers are siblings, not one worker branching on a
 * flag, so terminating one never touches the other's runtime.
 *
 * The three worker-protocol invariants this file reproduces exactly:
 *
 *  * **One at a time.** `drain()`/`running`, same as the uvdoc worker.
 *  * **Newest generation per page wins.** Same `Map<renderKey, request>` queue.
 *  * **Never throw a page away.** Every internal failure is a structured
 *    `failed` reply, never a thrown error or a silent `onerror`.
 *
 * What differs from the uvdoc worker is *how the runtime gets here*: instead
 * of a 16 MB model transferred in on the first request, this worker streams
 * its own ~130 KB (gzipped) wasm module from a same-origin URL the moment it
 * is needed (`WebAssembly.instantiateStreaming`)
 * — small enough, and the validator strict enough about truncation, that
 * there is no exact-byte-count check to reproduce here the way `assets.ts`'s
 * `MODEL_BYTES` protects the ONNX fetch.
 *
 * Instantiated only through `index.ts`
 * (`new Worker(new URL("./dewarp-classical.worker.ts", import.meta.url), { name })`)
 * — the bundler-recognised form, so this chunk is emitted rather than resolved
 * at run time. The `name` carries the two asset URLs (`assets.ts`'s
 * {@link decodeDewarpAssets}): this worker has no way to derive where the host
 * copied `assets/`, and it needs that before the first message arrives.
 */

import { CLASSICAL_GRID_HEIGHT, CLASSICAL_GRID_WIDTH } from "./grid.ts";
import { CLASSICAL_OPTS_JSON } from "./classical.ts";
import { type DewarpAssets, decodeDewarpAssets } from "./assets.ts";
import type {
  DewarpInferRequest,
  DewarpWorkerReply,
  DewarpWorkerRequest,
  RgbaCropBuffer,
} from "./worker-protocol.ts";

/** See `dewarp.worker.ts`'s identical comment — `lib.dom` has no ambient
 * `DedicatedWorkerGlobalScope`, and naming the two members used doubles as an
 * inventory of the boundary. */
interface DewarpWorkerScope {
  onmessage: ((event: MessageEvent<DewarpWorkerRequest>) => void) | null;
  postMessage(message: DewarpWorkerReply, transfer?: Transferable[]): void;
  /** Set at construction by `index.ts` — where this worker's two files live. */
  readonly name: string;
}

declare const self: DewarpWorkerScope;

/**
 * The slice of the `wasm-bindgen --target web` glue module this file drives —
 * named narrowly (the wasm module's own ABI, transcribed) rather than typed
 * against the generated `.d.ts`, because the glue is a vendored public asset
 * (`assets/dewarp/`, served from the host's public directory), not a source
 * file this library's TS project owns.
 */
interface DewarpWasmGlue {
  default(init: { module_or_path: string }): Promise<{ memory: WebAssembly.Memory }>;
  dewarp_alloc_input(len: number): number;
  dewarp(inputPtr: number, width: number, height: number, optsJson: string): number;
  dewarp_grid_ptr(handle: number): number;
  dewarp_grid_len(handle: number): number;
  dewarp_status_json(handle: number): string;
  dewarp_free_result(handle: number): void;
}

interface DewarpWasmModule {
  glue: DewarpWasmGlue;
  memory: WebAssembly.Memory;
}

let modulePromise: Promise<DewarpWasmModule> | null = null;

/**
 * Where this worker's two files are, decided once, at construction.
 *
 * Read lazily rather than at module scope: this file must have no side effect
 * at import, and a name that cannot be parsed has to become a structured
 * `failed` reply rather than a module that threw before `onmessage` existed.
 */
function assets(): DewarpAssets {
  const decoded = decodeDewarpAssets(self.name);
  if (decoded === null) {
    throw new Error(
      "dewarp worker: no asset URLs — the worker must be constructed with " +
        "`{ name: encodeDewarpAssets(dewarpAssets(urls)) }`",
    );
  }
  return decoded;
}

/**
 * Load the glue and stream-instantiate the wasm behind it, once.
 *
 * `/* webpackIgnore: true *\/` is load-bearing: the glue URL is a runtime
 * string pointing at a file the *host* serves, not a module this library's
 * source tree owns, so a bundler must not try to resolve or bundle it — this
 * stays a genuine browser-native `import()` against a same-origin URL, exactly
 * the shape `WebAssembly.instantiateStreaming(fetch(...))` wants one layer down
 * (the glue's own `default()` does that fetch internally).
 */
async function ensureModule(): Promise<DewarpWasmModule> {
  if (modulePromise === null) {
    modulePromise = (async () => {
      const { glueUrl, wasmUrl } = assets();
      const glue = (await import(/* webpackIgnore: true */ glueUrl)) as DewarpWasmGlue;
      const { memory } = await glue.default({ module_or_path: wasmUrl });
      return { glue, memory };
    })().catch((error: unknown) => {
      modulePromise = null;
      throw error;
    });
  }
  return modulePromise;
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** Newest request per page, plus the order they arrived in. */
const queue = new Map<string, DewarpInferRequest>();
let running = false;

async function infer(request: DewarpInferRequest): Promise<DewarpWorkerReply> {
  let initMs = 0;
  let wasmModule: DewarpWasmModule;
  const warm = modulePromise !== null;
  const initStart = Date.now();
  try {
    wasmModule = await ensureModule();
    initMs = warm ? 0 : Date.now() - initStart;
  } catch (error) {
    return {
      kind: "failed",
      generation: request.generation,
      renderKey: request.renderKey,
      stage: "initializing",
      message: describe(error),
    };
  }

  const input = request.input as RgbaCropBuffer;
  const { glue } = wasmModule;
  let handle = 0;
  try {
    const inferStart = Date.now();
    const length = input.width * input.height * 4;
    const inputPtr = glue.dewarp_alloc_input(length);
    // Re-read `memory.buffer` right before every access: a call into wasm
    // (allocation included) can grow linear memory, which detaches any
    // ArrayBuffer view taken before the call — caching the buffer reference
    // across a wasm call is exactly the bug that produces a silent
    // zero-length write here instead of a thrown error.
    new Uint8Array(wasmModule.memory.buffer, inputPtr, length).set(input.data);

    // Quad-aligned export framing: the main thread pre-builds
    // `opts_json` (crop/quad live there, not here — this file stays
    // deliberately ignorant of both, per this file's own module doc
    // comment). `undefined` reproduces the fixed, quad-less constant.
    const optsJson = request.optsJson ?? CLASSICAL_OPTS_JSON;
    handle = glue.dewarp(inputPtr, input.width, input.height, optsJson);
    const inferMs = Date.now() - inferStart;

    const statusJson = glue.dewarp_status_json(handle);
    const gridPtr = glue.dewarp_grid_ptr(handle);
    const gridLen = glue.dewarp_grid_len(handle);
    // Copied out before `dewarp_free_result`, which owns and frees this
    // memory — the transferred reply must not alias it.
    const data = Float32Array.from(
      new Float32Array(wasmModule.memory.buffer, gridPtr, gridLen),
    );

    return {
      kind: "grid",
      generation: request.generation,
      renderKey: request.renderKey,
      dims: [1, 2, CLASSICAL_GRID_HEIGHT, CLASSICAL_GRID_WIDTH],
      type: "float32",
      data,
      initMs,
      inferMs,
      statusJson,
    };
  } catch (error) {
    return {
      kind: "failed",
      generation: request.generation,
      renderKey: request.renderKey,
      stage: "inferring",
      message: describe(error),
    };
  } finally {
    if (handle !== 0) glue.dewarp_free_result(handle);
  }
}

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.size > 0) {
      const key = queue.keys().next().value as string;
      const request = queue.get(key) as DewarpInferRequest;
      queue.delete(key);
      const reply = await infer(request);
      self.postMessage(reply, reply.kind === "grid" ? [reply.data.buffer] : []);
    }
  } finally {
    running = false;
  }
}

/**
 * `reset` clears the queue only — there is no session to release. The wasm
 * module, once instantiated, has no per-page state (`dewarp()` is a pure
 * function of its input each call) and no exported teardown; the Engine's own
 * `reset()` already achieves a cold restart by terminating this worker
 * outright, so there is nothing this handler needs to undo beyond the queue.
 */
function reset(): void {
  queue.clear();
}

self.onmessage = (event: MessageEvent<DewarpWorkerRequest>) => {
  const message = event.data;
  if (message.kind === "reset") {
    reset();
    return;
  }
  // Newest wins: a queued job for the same page is superseded outright.
  const queued = queue.get(message.renderKey);
  if (queued === undefined || message.generation >= queued.generation) {
    queue.set(message.renderKey, message);
  }
  void drain();
};
