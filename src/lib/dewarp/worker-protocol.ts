/**
 * What crosses the worker boundary — and nothing else.
 *
 * Its own module so the client seam can name these types without importing
 * `dewarp-classical.worker.ts`, which would drag the engine's wasm bootstrap
 * into the main bundle for the sake of an `interface`.
 *
 * The boundary is deliberately narrow: a float tensor goes in, a float tensor
 * comes back. The worker knows nothing about crops, quads, pages or sessions,
 * so terminating it at any instant loses nothing that cannot be recomputed
 * from the canonical image.
 */

/**
 * The engine's input: the padded-quad-bbox crop, RGBA8,
 * native resolution up to a 1600px-long-edge ceiling. `data` is
 * `width*height*4` bytes, row-major, no padding; transferred via
 * `data.buffer`.
 */
export interface RgbaCropBuffer {
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * One inference.
 *
 * There is no model buffer here: the worker streams-instantiates its own wasm
 * module from a same-origin URL, so nothing multi-megabyte is
 * ever fetched on the main thread and transferred across.
 */
export interface DewarpInferRequest {
  kind: "infer";
  generation: number;
  renderKey: string;
  /** The padded crop the surface is predicted from. */
  input: RgbaCropBuffer;
  /**
   * The engine's `opts_json`, including the optional quad-aligned export
   * framing field, pre-built by `classical.ts::classicalOptsJson` on the main
   * thread — where the crop and quad this worker is deliberately kept ignorant
   * of both live. Opaque to this file. `undefined` falls back to the fixed,
   * quad-less `CLASSICAL_OPTS_JSON`.
   */
  optsJson?: string;
}

/** Drop the session and everything queued — the explicit way back to cold. */
export interface DewarpResetRequest {
  kind: "reset";
}

export type DewarpWorkerRequest = DewarpInferRequest | DewarpResetRequest;

export interface DewarpGridReply {
  kind: "grid";
  generation: number;
  renderKey: string;
  dims: number[];
  type: string;
  data: Float32Array;
  /** Session creation, 0 when the session was already warm. */
  initMs: number;
  inferMs: number;
  /**
   * The engine's confidence layer, verbatim from
   * `dewarp_status_json` — a raw JSON string, not parsed here, for the same
   * additive-forward-compatible reason the Rust ABI itself chose JSON: a new
   * status field must never require a protocol version bump.
   */
  statusJson?: string;
}

/**
 * The worker could not answer.
 *
 * A reply rather than a thrown error on purpose: a page that fails must still
 * come back to the seam so it can fall back, and an `onerror` on the Worker
 * carries no generation to match it against.
 */
export interface DewarpFailureReply {
  kind: "failed";
  generation: number;
  renderKey: string;
  stage: "initializing" | "inferring";
  message: string;
}

export type DewarpWorkerReply = DewarpGridReply | DewarpFailureReply;
