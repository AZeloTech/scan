"use client";

/**
 * Canonical → the page you see and the page the PDF gets. **One render pass.**
 *
 * Up to v2.3 a page carried four JPEGs and could suffer four lossy generations
 * on the way to the file: the pre-warp frame, the warp, the finish-applied
 * page, and — for a page the user had turned — a re-encode at build time.
 * There is one source now (`canonical`, q92) and one derived artifact
 * (`final`, q85), and this module is the only thing that turns the first into
 * the second:
 *
 * ```
 * decode canonical → warp (corners) → finish → bake rotation → encode once
 * ```
 *
 * Everything about that chain is deliberate:
 *
 *  * **The rotation is baked here, not at build time.** A quarter turn on a
 *    canvas is an exact pixel permutation — no interpolation, no resample — so
 *    doing it inside the pass costs nothing and removes the build's re-encode
 *    entirely. It also means what the review screen shows IS what `embedJpg`
 *    copies into the PDF, byte for byte.
 *  * **Failures degrade by domain, never by convenience.** A stage that fails
 *    may only cost *its own* contribution: the illumination pass giving up
 *    renders the page un-enhanced (`finish: "original"`, which the store keeps
 *    as the page's effective finish, so nothing ever claims a correction that
 *    did not happen), and the warp giving up renders the frame flat
 *    (`warped: false`, which the screens read as "ajustar cantos"). A decode, a
 *    rotation or the final encode failing costs the page: it goes to `failed`
 *    and the user is asked, rather than being handed content they did not
 *    choose. That distinction is why every stage is labelled
 *    ({@link RenderStage}) — an untyped `catch` around the whole chain would let
 *    a hiccup in the *encoder* silently export the whole camera frame, borders,
 *    desk and all, with `warped: false` blaming the corners for it.
 *  * **The thumbnail is a leaf.** It comes off the same canvas and feeds
 *    nothing: never the PDF, never a re-render, never another thumbnail.
 *  * **The geometry has two implementations and one slot.** A page the user
 *    asked to un-curve goes through the UVDoc chain (`lib/dewarp-stage.ts`),
 *    whose surface *replaces* the warp's output and flows into the same tail;
 *    every other page, and every page the chain declined, gets scanic's
 *    homography exactly as before. The decline is an outcome, not a failure: it
 *    never fails the page and never spends one of the ladder's concessions.
 *  * **The geometry is stuck here; the tail is not.** `scanic` builds a
 *    `<canvas>` to detect on, so the decode and the warp cannot leave the main
 *    thread. Everything after them — the illumination pass, the turn, the two
 *    encodes — is handed to `lib/render-remote.ts`, which runs it in a worker
 *    where the browser allows one and inline where it does not. The stage
 *    labels and the ladder below are unchanged by that: a finish that failed in
 *    the worker arrives as a finish failure and costs exactly the enhancement.
 */

import { bakeRotation, htmlSurface, scaleSurface } from "@/lib/canvas-surface";
import {
  dewarpAvailable,
  replayDewarpStage,
  runDewarpStage,
  type DewarpReplay,
  type DewarpStageReason,
} from "@/lib/dewarp-stage";
import type { DewarpEngineMode, DewarpProgress } from "@/lib/dewarp/index";
import { warpToCanvas } from "@/lib/flatten";
import { decodeCanonical, ImagePrepError, releaseCanvas } from "@/lib/image";
import type { NormalizedQuad } from "@/lib/quad";
import type { PageRotation } from "@/lib/rotation";
import {
  applyFinish,
  PixelStageError,
  type PageFinish,
  type PixelJob,
  type RenderedPixels,
} from "@/lib/render-pixels";
import { renderPageTail, RenderWorkerLostError } from "@/lib/render-remote";
import type { AssetUrls } from "@/lib/runtime-config";

export { DEFAULT_FINISH } from "@/lib/render-pixels";
export type { PageFinish } from "@/lib/render-pixels";

/** Long edge of the rail/review thumbnail. */
const THUMB_LONG_EDGE = 480;

/**
 * The user's request for the curved-page correction, fully resolved.
 *
 * Present or absent rather than a boolean, because the engine cannot be asked
 * without the two things that identify the attempt — which page's pixels these
 * are, and which edit of that page — and a `dewarp: true` with no identity
 * would be a run whose result could land on the wrong revision.
 */
export interface DewarpAsk {
  /** The page id: identifies the pixels for the engine's render key. */
  sourceId: string;
  /** The page revision. A reply for an older one is dropped. */
  generation: number;
  /**
   * Which producer this page's request is for. Passed straight through to
   * {@link runDewarpStage}; absent defaults to the build's own flag, so every
   * caller before the "ab" build is unaffected.
   */
  engineMode?: DewarpEngineMode;
  /**
   * A map this exact page already produced, handed back rather than asked
   * for again.
   *
   * The store's own replay cache (`scan-store.ts`'s `dewarpReplays`), not this
   * module's per-render {@link DewarpMemo} — that one is scoped to a single
   * `renderPage` call and gone the moment it returns. This is what makes
   * switching curvatura off and back on (or a finish/rotation edit that
   * leaves the geometry untouched) a resample instead of a second inference:
   * {@link renderPage} seeds its memo from it via {@link dewarpMemoFor}, and
   * {@link curvedSurface} already resamples whenever it finds an accepted map
   * waiting. Null/absent asks fresh, exactly as before this field existed.
   */
  replay?: DewarpReplay | null;
  onPhase?: (progress: DewarpProgress) => void;
  signal?: AbortSignal;
}

/** Everything it takes to produce a page's pixels, and nothing else. */
export interface RenderRequest {
  /** The page's one immutable source. */
  canonical: Blob;
  /** Normalized to the canonical's own frame; null means no warp. */
  corners: NormalizedQuad | null;
  rotation: PageRotation;
  finish: PageFinish;
  /**
   * Set when the user asked for the curved correction on this page (beta).
   *
   * Null/absent is the overwhelming default and the only shape the un-enhanced
   * compare ({@link renderPreviewCanvas}) ever uses.
   */
  dewarp?: DewarpAsk | null;
  /** Where this library's WebAssembly lives. Needed only when `dewarp` is set. */
  assets?: AssetUrls;
}

/** What one render pass produced, and what it actually managed to apply. */
export interface RenderedPage {
  /** JPEG q85 — shown on screen AND embedded in the PDF, same bytes. */
  final: Blob;
  /** ~480 px JPEG for the rail and the review cards. Best effort. */
  thumb: Blob | null;
  /** Pixel dimensions of `final`; the PDF page is cut to them. */
  width: number;
  height: number;
  /** The finish that was really applied — not necessarily the one asked for. */
  finish: PageFinish;
  /** False when the warp could not be applied and the frame went in flat. */
  warped: boolean;
  /**
   * True only when the pixels came out of the curved geometry.
   *
   * A page that asked and got the homography back is `false` with a
   * {@link RenderedPage.dewarpFallbackReason} — the "requested vs effective"
   * split, in the one place that knows the answer.
   */
  dewarped: boolean;
  /** Why the curved geometry was not used. Diagnostics only, never copy. */
  dewarpFallbackReason?: DewarpStageReason;
  /**
   * The map behind `dewarped: true` pixels, for the store's own replay cache.
   * Present exactly when {@link RenderedPage.dewarped} is, absent otherwise —
   * the same "opaque, good for one more render" contract {@link DewarpReplay}
   * already carries inside this module.
   */
  dewarpReplay?: DewarpReplay | null;
  rotation: PageRotation;
}

/**
 * Which part of the pass gave up.
 *
 * The ladder in {@link renderWithFallback} reacts to *this*, not to the fact of
 * an exception, because the stages have different blast radii: two of them can
 * be dropped and still leave the user a page that is honestly described, and
 * three of them cannot be dropped at all.
 */
export type RenderStage =
  /** The canonical could not be read back. Nothing downstream is possible. */
  | "decode"
  /** The corners could not be applied. Costs the crop, nothing else. */
  | "warp"
  /** The illumination/threshold pass. Costs the enhancement, nothing else. */
  | "finish"
  /** The quarter turn. A page in the wrong orientation is a wrong page. */
  | "rotate"
  /** Writing the final JPEG. The pixels were right; the file is not. */
  | "encode";

/**
 * The abort reason that means "a newer render of this page is already queued".
 *
 * The difference matters to the *work*, not to the user. An explicit Cancel
 * wants this pass to finish flat, because the page the user is looking at has
 * to settle on something. A supersession wants it to stop where it stands: the
 * revision that replaced it is about to render the same page again, and
 * carrying on would cost a second full-resolution pass whose result is thrown
 * away on arrival.
 */
export const SUPERSEDED_ABORT = "superseded";

/**
 * This pass was replaced while it ran, and its work is nobody's page.
 *
 * Not a `RenderStageError`: no stage failed, nothing degraded, and the ladder
 * must not spend a concession on it. The store recognises it and stays quiet —
 * the render it was replaced by is the one that answers.
 */
export class RenderAbandonedError extends Error {
  constructor() {
    super("render superseded");
    this.name = "RenderAbandonedError";
  }
}

/** A failure, labelled with the stage it happened in. */
export class RenderStageError extends Error {
  readonly stage: RenderStage;
  /** Whatever the stage actually threw — usually an `ImagePrepError`. */
  readonly reason: unknown;

  constructor(stage: RenderStage, reason: unknown) {
    // The message is for a stack trace, never for a user.
    super(`render failed at ${stage}`);
    this.name = "RenderStageError";
    this.stage = stage;
    this.reason = reason;
  }
}

function labelled(stage: RenderStage, error: unknown): RenderStageError {
  // An inner label wins: it names the stage that actually failed, and the
  // ladder's whole decision hangs on that being the truth.
  return error instanceof RenderStageError
    ? error
    : new RenderStageError(stage, error);
}

async function atStageAsync<T>(
  stage: RenderStage,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw labelled(stage, error);
  }
}

/** The code the screens render, dug out of whatever the stage threw. */
function asImagePrepError(error: unknown): ImagePrepError {
  if (error instanceof ImagePrepError) return error;
  if (error instanceof RenderStageError && error.reason instanceof ImagePrepError) {
    return error.reason;
  }
  return new ImagePrepError("prep");
}

/**
 * What one **logical** render already knows about its curved geometry.
 *
 * The ladder below may run the pass more than once — a failed finish, a lost
 * render worker — and each of those retries used to start the curved chain from
 * scratch. That is wrong twice over: it pays for a second twelve-second
 * inference, and, worse, a transient failure on that second run would hand back
 * a flat page while the ladder still believed the only concession it had made
 * was the enhancement. The user would get a page silently missing the very
 * correction they asked for, described as if it had been applied.
 *
 * So the first attempt's *answer* is what is remembered — the accepted map to
 * resample, or the reason it declined — for the life of one `renderPage` call
 * and no longer. It is not a cache: it is keyed by nothing, shared with nobody,
 * and dropped when the render returns.
 */
export interface DewarpMemo {
  accepted: DewarpReplay | null;
  declined: DewarpStageReason | null;
}

/** A fresh memo. One per logical render. */
export function newDewarpMemo(): DewarpMemo {
  return { accepted: null, declined: null };
}

/** Where a curved surface comes from, so the policy can be tested without one. */
export interface DewarpLane<Surface> {
  infer(): Promise<{
    canvas: Surface | null;
    reason: DewarpStageReason | null;
    replay: DewarpReplay | null;
  }>;
  resample(accepted: DewarpReplay): Promise<Surface | null>;
}

/**
 * The curved geometry of one logical render — inferring at most once.
 *
 * First call: ask the engine, and remember what came back. Every call after it,
 * within the same render: resample the accepted map, or repeat the decline
 * verbatim. A resample that fails is reported as `render-failed`, which is the
 * truth — the map was fine, the pixels could not be made — rather than the
 * original decline, which would name a reason that never happened.
 */
export async function curvedSurface<Surface>(
  memo: DewarpMemo,
  lane: DewarpLane<Surface>,
): Promise<{ canvas: Surface | null; reason: DewarpStageReason | null }> {
  if (memo.accepted !== null) {
    const canvas = await lane.resample(memo.accepted);
    return canvas === null
      ? { canvas: null, reason: "render-failed" }
      : { canvas, reason: null };
  }
  if (memo.declined !== null) return { canvas: null, reason: memo.declined };

  const attempt = await lane.infer();
  if (attempt.canvas === null) {
    memo.declined = attempt.reason ?? "render-failed";
    return { canvas: null, reason: memo.declined };
  }
  memo.accepted = attempt.replay;
  return { canvas: attempt.canvas, reason: null };
}

/**
 * The memo a render starts with.
 *
 * Usually empty — the answer is derived by inference, below. But
 * {@link RenderRequest.dewarp}'s own `replay` (`DewarpAsk.replay`) may already
 * hold a map *this page's pixels* produced before — the store's cache of the
 * last accepted geometry, handed back when curvatura is switched off and back
 * on with nothing else about the page changed. Seeding the memo with it is
 * what turns that "on again" into one resample: {@link curvedSurface} above
 * already takes the resample branch the instant it finds `memo.accepted` set,
 * whether that came from an inference earlier in *this* render or was handed
 * in before it started.
 */
/**
 * A curved-page correction was asked for without saying where the engine is.
 *
 * Only reachable from a caller inside this library that built a request by
 * hand, so it is a programming error rather than something a person can cause.
 */
function requireAssets(request: { assets?: AssetUrls }): AssetUrls {
  if (request.assets === undefined) {
    throw new Error(
      "a dewarp was requested without `assets`: the engine cannot be located " +
        "without the host's asset base URL."
    );
  }
  return request.assets;
}

export function dewarpMemoFor(request: RenderRequest): DewarpMemo {
  return { accepted: request.dewarp?.replay ?? null, declined: null };
}

/** The page's pixels before the tail, and which geometry made them. */
interface Geometry {
  canvas: HTMLCanvasElement;
  warped: boolean;
  dewarped: boolean;
  /** Set only when the curved geometry was asked for and did not happen. */
  dewarpFallbackReason?: DewarpStageReason;
  /** The map behind `dewarped: true` pixels. Absent/null otherwise. */
  dewarpReplay?: DewarpReplay | null;
}

/**
 * The geometry stage: the curved chain when the page asked for it, the flat
 * warp otherwise — and the flat warp again whenever the curved chain declined.
 *
 * The dewarp is deliberately outside the ladder's `atStageAsync` labelling. It
 * cannot fail *the page* and it cannot fail *the warp*: `runDewarpStage` never
 * throws, and its refusals are answers. That is what keeps a fallback from
 * spending a concession — a page whose curvature could not be corrected is
 * still the page the user photographed, cropped exactly as they confirmed it.
 */
async function geometry(
  request: RenderRequest,
  identity: boolean,
  memo: DewarpMemo,
): Promise<Geometry> {
  const { canonical, corners } = request;
  const ask = request.dewarp ?? null;
  let dewarpFallbackReason: DewarpStageReason | undefined;
  // `identity` is the ladder's second attempt, which has already given up on
  // the crop; there is no quad left to predict a surface for.
  if (ask !== null && corners !== null && !identity) {
    if (dewarpAvailable()) {
      const curved = await curvedSurface<HTMLCanvasElement>(memo, {
        infer: () =>
          runDewarpStage({
            canonical,
            corners,
            sourceId: ask.sourceId,
            generation: ask.generation,
            assets: requireAssets(request),
            ...(ask.engineMode === undefined ? {} : { engineMode: ask.engineMode }),
            ...(ask.onPhase === undefined ? {} : { onPhase: ask.onPhase }),
            ...(ask.signal === undefined ? {} : { signal: ask.signal }),
          }),
        resample: (accepted) => replayDewarpStage(canonical, accepted),
      });
      if (curved.canvas !== null) {
        return {
          canvas: curved.canvas,
          warped: true,
          dewarped: true,
          dewarpReplay: memo.accepted,
        };
      }
      // Stopped because this render has already been replaced: the flat path
      // below would be a full-resolution pass for a revision nobody will read.
      if (ask.signal?.aborted === true && ask.signal.reason === SUPERSEDED_ABORT) {
        throw new RenderAbandonedError();
      }
      dewarpFallbackReason = curved.reason ?? "render-failed";
    } else {
      dewarpFallbackReason = "unsupported";
    }
  }

  const decoded = await atStageAsync("decode", () => decodeCanonical(canonical));
  const flat = {
    dewarped: false,
    ...(dewarpFallbackReason === undefined ? {} : { dewarpFallbackReason }),
  };
  if (corners === null || identity) return { canvas: decoded, warped: false, ...flat };
  let warped: HTMLCanvasElement | null;
  try {
    warped = await warpToCanvas(decoded, corners, requireAssets(request));
  } catch (error) {
    // The ladder may retry this page flat, which decodes again — so the canvas
    // this attempt allocated goes back now rather than at the next GC.
    releaseCanvas(decoded);
    throw labelled("warp", error);
  }
  if (warped === null) return { canvas: decoded, warped: false, ...flat };
  releaseCanvas(decoded);
  return { canvas: warped, warped: true, ...flat };
}

async function renderOnce(
  request: RenderRequest,
  finish: PageFinish,
  identity: boolean,
  remote: boolean,
  memo: DewarpMemo,
): Promise<RenderedPage> {
  const { canvas: source, warped, dewarped, dewarpFallbackReason, dewarpReplay } =
    await geometry(request, identity, memo);
  const job: PixelJob = {
    finish,
    rotation: request.rotation,
    thumbLongEdge: THUMB_LONG_EDGE,
  };
  // `renderPageTail` owns `source` from here — including freeing it — because
  // on the worker lane the pixels leave this thread and holding the canvas as
  // well would keep a second 48 MB copy of a 12 MP page alive for the pass.
  let pixels: RenderedPixels;
  try {
    pixels = await renderPageTail(source, job, remote);
  } catch (error) {
    // The tail's stage names are this ladder's stage names, so a failure keeps
    // its meaning whichever thread it happened on.
    throw error instanceof PixelStageError
      ? labelled(error.stage, error.reason)
      : error;
  }
  return {
    final: pixels.final,
    thumb: pixels.thumb,
    width: pixels.width,
    height: pixels.height,
    finish,
    warped,
    dewarped,
    ...(dewarpFallbackReason === undefined ? {} : { dewarpFallbackReason }),
    ...(dewarpReplay === undefined ? {} : { dewarpReplay }),
    rotation: request.rotation,
  };
}

/**
 * One attempt at the pass, with the worker's own mortality handled.
 *
 * A worker that dies takes the transferred pixels with it, so there is nothing
 * left to salvage — the retry starts again from the canonical, on this thread.
 * It is kept out of {@link renderWithFallback} on purpose: losing a thread says
 * nothing about the page, and it must not spend one of the ladder's
 * concessions.
 *
 * On a page that asked for the curved geometry the retry pays for the inference
 * a second time. That is the honest price of the rule above — the transferred
 * surface is gone, and re-running the *whole* pass is the only way to get the
 * same pixels back — and a lost worker is rare enough not to be worth caching a
 * grid for.
 */
async function renderPass(
  request: RenderRequest,
  finish: PageFinish,
  identity: boolean,
  memo: DewarpMemo,
): Promise<RenderedPage> {
  try {
    return await renderOnce(request, finish, identity, true, memo);
  } catch (error) {
    if (!(error instanceof RenderWorkerLostError)) throw error;
    return renderOnce(request, finish, identity, false, memo);
  }
}

/** One go at the pass: the finish to attempt, and whether to skip the warp. */
interface Attempt {
  finish: PageFinish;
  identity: boolean;
}

/**
 * What this failure is allowed to cost, or null when it costs the page.
 *
 * The two concessions are deliberately narrow and each is spent at most once,
 * which is also why the loop terminates: a finish failure may drop the
 * enhancement, a warp failure may drop the crop, and **nothing else may drop
 * anything**. In particular a failed encode is not a reason to re-render with
 * different content: the pixels were fine, and shipping a wider, un-cropped
 * frame of somebody's medical paperwork — which can hold whatever else was on
 * the desk — because a `toBlob` hiccuped is a content change the user never
 * agreed to.
 */
function concession(
  attempt: Attempt,
  error: unknown,
  request: RenderRequest,
): Attempt | null {
  const stage = error instanceof RenderStageError ? error.stage : null;
  if (stage === "finish" && attempt.finish !== "original") {
    return { ...attempt, finish: "original" };
  }
  if (stage === "warp" && !attempt.identity && request.corners !== null) {
    return { ...attempt, identity: true };
  }
  return null;
}

/**
 * The failure ladder, as a policy over a pixel pass.
 *
 * Separated from {@link renderOnce} because the interesting part is the
 * *decision* — which failures may quietly change what the user gets, and which
 * must stop the page — and that decision is worth testing on its own, without a
 * canvas anywhere near it ({@link renderPage} is the production wiring).
 */
export async function renderWithFallback(
  request: RenderRequest,
  pass: (finish: PageFinish, identity: boolean) => Promise<RenderedPage>,
): Promise<RenderedPage> {
  let attempt: Attempt = { finish: request.finish, identity: false };
  for (;;) {
    try {
      return await pass(attempt.finish, attempt.identity);
    } catch (error) {
      // A pass that was replaced is not a failure and has no stage: it must
      // reach the store as itself, or the store's `instanceof` guard never
      // matches and a superseded render is reported to the user as a broken
      // page — with only the revision check standing between them and that.
      if (error instanceof RenderAbandonedError) throw error;
      const next = concession(attempt, error, request);
      // The failure that stopped us is the one the screen should name — not the
      // first one, which we already recovered from.
      if (next === null) throw asImagePrepError(error);
      attempt = next;
    }
  }
}

/**
 * The page's one render. Rejects with `ImagePrepError` when the failure is one
 * the page cannot survive (a decode, the rotation, the final encode); a finish
 * or warp failure degrades within its own domain and still hands back a page —
 * one whose `finish`/`warped` say exactly what it is. A pass that was
 * superseded rejects with {@link RenderAbandonedError} unwrapped, which is not
 * a failure at all: the render that replaced it owns the page.
 */
export function renderPage(request: RenderRequest): Promise<RenderedPage> {
  // One logical render, one memo: every retry below resamples the map this
  // page's inference already produced (see {@link curvedSurface}) — and if
  // the caller already held one from before this render even started
  // ({@link dewarpMemoFor}), the *first* attempt resamples too.
  const memo = dewarpMemoFor(request);
  return renderWithFallback(request, (finish, identity) =>
    renderPass(request, finish, identity, memo),
  );
}

/**
 * The same pixels, on demand, at display scale and **without an encode**.
 *
 * This is what "segure para ver sem melhorias" shows: the page's own geometry
 * with the enhancement left out, so the flip isolates exactly what the
 * improvement changed. It returns a canvas because a JPEG here would be a lossy generation
 * the user never asked for — and one they would then be comparing *against*.
 *
 * The caller owns the canvas and must release it (`releaseCanvas`).
 */
export async function renderPreviewCanvas(
  request: RenderRequest,
  longEdge: number,
): Promise<HTMLCanvasElement> {
  // Never the curved geometry: this is the un-enhanced *comparison*, and a
  // second inference under a press-and-hold is not a thing the phone can do.
  // The control that holds it is hidden on a dewarped page for the same reason
  // it is hidden on a page with no enhancement — there would be two documents
  // either side of the flip (`components/PagePreview.tsx`).
  const { canvas: source } = await geometry(
    { ...request, dewarp: null },
    false,
    newDewarpMemo(),
  );
  const spent: HTMLCanvasElement[] = [];
  let working = source;
  try {
    // Scaled BEFORE the finish, not after: a 3000 px illumination pass for a
    // 400 px overlay is a second of frozen UI on the phones this is for.
    const scaled = scaleSurface(working, longEdge, htmlSurface);
    if (scaled !== working) spent.push(working);
    working = scaled;
    const finished = applyFinish(working, request.finish, htmlSurface);
    if (finished !== working) spent.push(working);
    working = finished;
    // `bakeRotation` releases its own source, so only the result survives.
    return bakeRotation(working, request.rotation, htmlSurface);
  } catch (error) {
    releaseCanvas(working);
    throw error;
  } finally {
    for (const canvas of spent) releaseCanvas(canvas);
  }
}
