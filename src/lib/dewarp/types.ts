/**
 * The dewarp engine's vocabulary — the only file every other module imports.
 *
 * The engine is a *replacement geometry* for a single page: where the normal
 * pipeline flattens a confirmed quad with scanic's homography, this chain
 * predicts a curved surface and samples through it instead. It therefore has
 * to be able to say, for every page it touches, which of the two geometries
 * actually produced the pixels and why — that answer is {@link DewarpOutcome},
 * and it is the reason the engine never simply "fails": a page always comes
 * back with a mode, and `homography` is a legitimate result, not an error.
 *
 * Nothing here imports the app's own image code. The engine is self-contained
 * on purpose: it runs on the main thread, in a Worker and in bare Node tests,
 * so it speaks {@link RgbaImage} (a structural `ImageData`) rather than any
 * DOM type, and its own {@link DewarpPoint}/{@link DewarpQuad} rather than
 * scanic's.
 */

/** A point in canonical-image pixels, unless a signature says otherwise. */
export interface DewarpPoint {
  x: number;
  y: number;
}

/** The confirmed page outline, clockwise from the top-left, in canonical pixels. */
export interface DewarpQuad {
  topLeft: DewarpPoint;
  topRight: DewarpPoint;
  bottomRight: DewarpPoint;
  bottomLeft: DewarpPoint;
}

/** Clockwise from the top-left — the winding every guard in here assumes. */
export const QUAD_CORNERS = [
  "topLeft",
  "topRight",
  "bottomRight",
  "bottomLeft",
] as const;

export type QuadCorner = (typeof QUAD_CORNERS)[number];

/**
 * Structurally an `ImageData`.
 *
 * Declared here rather than imported from `lib.dom` so that every pure module
 * in the engine — the sampler, the semantic check, the guards — can be run and
 * tested on bare Node, where `ImageData` does not exist. A real `ImageData` is
 * assignable to this, so callers never have to convert on the way in.
 */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

/** An axis-aligned crop of the canonical image, in integer canonical pixels. */
export interface CropBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Which geometry actually produced a page's pixels.
 *
 * `"uvdoc"` and `"classical"` are two interchangeable *producers* of the same
 * {@link CoarseGrid} contract — additive, not a rename, so both can ship side
 * by side behind `NEXT_PUBLIC_DEWARP_ENGINE`. Everything from
 * `parseGridTensor` down treats them alike.
 */
export type GeometryMode = "homography" | "uvdoc" | "classical";

/**
 * Why a page that asked for the curved geometry got the flat one instead.
 *
 * Every value is a *decision*, not an exception: the engine is a ladder of
 * cheap-to-expensive checks and each rung has its own way of stepping back to
 * the homography. Integration turns these into telemetry and (for some of
 * them) copy, so they are stable strings rather than free text.
 */
export type DewarpFallbackReason =
  /** The browser cannot run the engine at all (no Worker/WASM/OffscreenCanvas). */
  | "unsupported"
  /** The model bytes could not be fetched, or arrived truncated/wrong. */
  | "model-unavailable"
  /** The worker died, or answered with a structured failure. */
  | "worker-failed"
  /** The caller aborted, or the page was superseded by a newer generation. */
  | "cancelled"
  /** The engine exceeded its own hard budget and was terminated. */
  | "timeout"
  /** The confirmed quad is not the kind of shape this model was trained for. */
  | "ineligible-quad"
  /** The tensor coming out of the session was not the grid we contracted for. */
  | "grid-contract"
  /** A composed coordinate was NaN or infinite. */
  | "guard-nonfinite"
  /** A composed coordinate landed outside the canonical image. */
  | "guard-bounds"
  /** The map folds over itself (Jacobian sign flip or near-zero determinant). */
  | "guard-jacobian"
  /** The map stretches or squashes a cell beyond the allowed band. */
  | "guard-scale"
  /** The map moves pixels further than a plausible page curvature would. */
  | "guard-displacement"
  /** The map's own corners disagree with the corners the user confirmed. */
  | "guard-boundary"
  /** The A/B check says the dewarped page reads worse than the flat one. */
  | "semantic-regression"
  /** Too little text to judge, and the deformation is too large to accept blind. */
  | "semantic-insufficient-evidence"
  /** Sampling could not allocate or complete. */
  | "render-failed"
  /**
   * Classical engine only — the four cheap, pipeline-internal status
   * signals, checked *before* the pixel-level guards above and mapped from
   * `dewarp-rs`'s own `dewarp_status_json`.
   * None of these exist for UVDoc, which has no equivalent status struct.
   */
  /** `status.converged === false` — the solve itself gave up on this page. */
  | "classical-non-convergent"
  /** `status.kept_text_lines < 2` — too few inlier lines to trust the fit. */
  | "classical-insufficient-features"
  /** All four `bound_saturation.a` *and* any `bound_saturation.rvec` — the
   * degenerate-solution signature a catastrophic capture exhibits. */
  | "classical-degenerate-bounds"
  /** `output_aspect / input_aspect` outside `[0.4, 2.5]` — a render whose
   * framing diverged wildly from the crop it was asked to flatten. */
  | "classical-aspect-outlier";

/**
 * The support code for every reason above — the one thing a screenshot can
 * carry that a sentence cannot.
 *
 * The user is told a consequence ("mantivemos a original"); five sentences
 * cover twenty-two guards (`scan-store.ts`'s `DEWARP_OUTCOMES`), so a field
 * report of "it said it kept the original" names a bucket, never a guard.
 * These codes close that gap: they are appended to the visible line, written
 * in front of the same reason in the diagnostics ring buffer, and are the same
 * string in both places and in every locale.
 *
 * **Stable identifiers. Never renumber, never reuse.** A code that changes
 * meaning between two builds is worse than no code at all: the support thread
 * it appears in outlives the deploy. A retired reason keeps its number, and a
 * new one takes the next free number in its family.
 *
 * The families are the ladder itself: `#00x` semantic, `#01x` the eligibility
 * and pixel-level guards, `#02x` the classical engine's own status signals,
 * `#03x` assets, `#04x` the machinery around a run (including the two the
 * *stage* adds rather than the engine — `source-unavailable` and
 * `baseline-unavailable`, which happen before the engine is called and are
 * listed here so that support has one table rather than two). `#1xx` is the
 * session latch's own family and lives with the latch (`lib/dewarp-stage.ts`).
 *
 * Keyed by `string` rather than by {@link DewarpFallbackReason} on purpose:
 * the reason travels through the store as a plain string (`ScanPage`'s
 * `rendered.dewarpFallbackReason`), so the lookup has to answer for a value
 * the type system has already let go of — which is what
 * {@link DEWARP_UNKNOWN_CODE} is for.
 */
export const DEWARP_REASON_CODES: Record<string, string> = {
  "semantic-regression": "#001",
  "semantic-insufficient-evidence": "#002",
  "ineligible-quad": "#010",
  "grid-contract": "#011",
  "guard-nonfinite": "#012",
  "guard-bounds": "#013",
  "guard-jacobian": "#014",
  "guard-scale": "#015",
  "guard-displacement": "#016",
  "guard-boundary": "#017",
  "classical-non-convergent": "#020",
  "classical-insufficient-features": "#021",
  "classical-degenerate-bounds": "#022",
  "classical-aspect-outlier": "#023",
  "model-unavailable": "#030",
  unsupported: "#040",
  "worker-failed": "#041",
  timeout: "#042",
  "render-failed": "#043",
  "source-unavailable": "#044",
  "baseline-unavailable": "#045",
};

/**
 * Anything the table above does not name — a reason from a newer build, or
 * `cancelled`, which never reaches a user-visible line because a cancel is the
 * user's own act rather than an outcome.
 */
export const DEWARP_UNKNOWN_CODE = "#099";

/** The code for one reason, always answering something a user can read out. */
export function dewarpReasonCode(reason: string): string {
  return DEWARP_REASON_CODES[reason] ?? DEWARP_UNKNOWN_CODE;
}

/** The phases integration is allowed to show progress for. */
export type DewarpPhase =
  | "checking"
  | "downloading"
  | "initializing"
  | "inferring"
  | "validating"
  | "rendering";

/** A phase tick; `received`/`total` are set only while downloading. */
export interface DewarpProgress {
  phase: DewarpPhase;
  received?: number;
  total?: number;
}

/**
 * What the engine reports about a page, whichever way it went.
 *
 * `requestedDewarp` and `geometryMode` are deliberately separate: a page that
 * never asked for the curved geometry and a page that asked and fell back are
 * both `homography`, and only the first is uninteresting.
 */
export interface DewarpOutcome {
  geometryMode: GeometryMode;
  requestedDewarp: boolean;
  fallbackReason?: DewarpFallbackReason;
  modelVersion: string;
  renderKey: string;
}

/**
 * One page's request, fully resolved.
 *
 * The crop and the output size are computed once (in `crop.ts`) and carried
 * here rather than recomputed downstream, so the guards, the sampler and the
 * key all describe the same geometry by construction.
 */
export interface DewarpJob {
  /** Monotonic per page: a reply for an older generation is dropped. */
  generation: number;
  /** Identifies the pixels this job would produce — see `renderKeyFor`. */
  renderKey: string;
  quad: DewarpQuad;
  canonicalWidth: number;
  canonicalHeight: number;
  crop: CropBox;
  outputWidth: number;
  outputHeight: number;
}

/**
 * How long this device took to get its first answer.
 *
 * Measured, never judged: the 12 s policy lives in integration, because it is
 * a product decision about how long a user waits, not a property of the maths.
 */
export interface DeviceGate {
  /** Fetching the model bytes (0 when they were already in hand). */
  downloadMs: number;
  /** Spawning the worker and creating the ORT session. */
  initMs: number;
  /** The first `session.run` on this device. */
  firstInferenceMs: number;
  /** Wall time from `runDewarp` to the outcome. */
  totalMs: number;
}
