"use client";

/**
 * The scan, and everything that happens to it — all of it on this device.
 *
 * The page list, their order, their status, their artifacts and the PDF. There
 * is no upload queue, no polling, no idempotency key and no token, because
 * there is nobody to talk to. A capture is *rendered here*
 * (`lib/page-processing.ts`), *judged here* (the on-device gate already ran at
 * shutter time) and *assembled here* (`lib/pdf.ts`).
 *
 * Five properties the screens rely on:
 *
 *  * **One store per mounted component, created by {@link createScanStore}.**
 *    Everything mutable — the state, the listeners, the render queue, the
 *    build latch, the abort handles, the replay cache — lives in that
 *    factory's closure, not in a module global. Mounting `<ScanFlow>` twice, or
 *    unmounting and remounting it, therefore cannot leak one scan's pages into
 *    the next. In 0.x exactly one store may be alive at a time;
 *    see {@link createScanStore} for why that is enforced rather than merely
 *    documented.
 *  * **One page at a time.** Rendering is a serial promise chain: two 12 MP
 *    passes racing each other on a cheap Android is how a capture screen starts
 *    dropping frames.
 *  * **One source, one derived artifact.** A page holds its `canonical`
 *    (the pre-warp frame, encoded once at q92) and, derived from it by a single
 *    render pass, `final` (q85). `final` is what the review screen shows AND
 *    what `embedJpg` copies into the PDF — the same bytes, so what the user
 *    approved is what ships. Every edit re-renders from the canonical rather
 *    than from the last output, so a page cannot accumulate generations.
 *  * **Nothing is written to disk.** The scan lives in this closure and dies
 *    with the component. There is no IndexedDB mirror, no resume card and no
 *    session TTL — see below.
 *  * **INVARIANT — encoded bytes only.** A {@link ScanPage} holds three `Blob`s
 *    (the q92 canonical, the q85 `final`, a ~480 px `thumb`) and nothing else
 *    that weighs anything: no `ImageBitmap`, no `HTMLCanvasElement`, no
 *    `ImageData`. Decoded full-resolution surfaces exist only *inside* one
 *    `pipeline.render` call — and the serial chain above means at most one of
 *    those is running — and the transferred copy handed to the render worker is
 *    released at the handoff (`lib/render-remote.ts`). The only other thing the
 *    store retains per page is a curvature replay map (a coarse `Float32Array`
 *    lattice plus a crop box, single-digit kilobytes), never pixels. This is
 *    load-bearing arithmetic, not hygiene: twenty decoded 3000 px pages would
 *    be roughly 700 MB, which is the tab dying on a phone.
 *
 * **Why memory only.** The store used to write every mutation to IndexedDB so a
 * scan could be resumed after a reload. That bought one convenience and cost
 * the product its simplest true sentence: photographs of somebody's medical
 * paperwork were sitting in browser storage, on a shared phone, until a
 * 24-hour sweep or an explicit "apagar" removed them. Closing the tab is now
 * the delete button, which is the behaviour a user can actually predict, and
 * the privacy claim needs no footnote about what stays behind.
 *
 * The consequence is deliberate and load-bearing: a full reload has no session,
 * and the host is expected to start the flow again from the beginning.
 *
 * User-facing strings are **codes**, not sentences ({@link PageErrorCode},
 * {@link BuildErrorCode}): the app can be read in pt-BR or en-US and the
 * language can change while a page is sitting in `failed`. A sentence frozen
 * into the state at the moment it failed would still be in the old language.
 */

import type { GateReading } from "@/lib/capture-gate";
import type { AssetUrls } from "@/lib/runtime-config";
import type { NormalizedQuad } from "@/lib/quad";
import type { PageTransform } from "@/lib/honesty";
import {
  DEFAULT_FINISH,
  RenderAbandonedError,
  renderPage,
  SUPERSEDED_ABORT,
  type PageFinish,
  type RenderRequest,
  type RenderedPage,
} from "@/lib/page-processing";
import type { DewarpPhase } from "@/lib/dewarp/index";
import { resolveGeometryMode, type DewarpEngineMode } from "@/lib/dewarp/engine-mode";
// A dependency-free lookup table, not the engine: `dewarp/index` is the ~25 kB
// of maths this module is careful never to pull in eagerly.
import { dewarpReasonCode } from "@/lib/dewarp/types";
import type { DewarpReplay } from "@/lib/dewarp-stage";
import {
  cancelRemoteRenders,
  claimRenderLane,
  setRenderWorkerAssets,
  releaseRenderLane,
} from "@/lib/render-remote";
import { ImagePrepError, type ImagePrepCode } from "@/lib/image";
import { currentLang, pdfFallbackName, type Lang } from "@/lib/i18n";
import { pdfFileName } from "@/lib/naming";
import { nextRotation, previousRotation, type PageRotation } from "@/lib/rotation";

/** The product cap on one document. */
/** The default ceiling. A host may lower or raise it through `ScanStoreOptions`. */
export const MAX_PAGES = 20;

export type PageStatus = "processing" | "ready" | "failed";

/**
 * Why a page could not be prepared, as a code the screens translate.
 *
 * `generic` is anything that is not one of the image pipeline's own named
 * failures — a decode that threw for a reason we have no better word for.
 */
export type PageErrorCode = ImagePrepCode | "generic";

/** Why a build stopped, as a code the screens translate. */
export type BuildErrorCode =
  /** Pages are still `failed`: the user has to resolve them first. */
  | "pages_failed"
  /** Pages are still `processing`: a moment, not a problem. */
  | "pages_processing"
  /** Nothing is ready to put in a file. */
  | "no_pages"
  /** A page was edited while the file was being written. */
  | "pages_changed"
  /** pdf-lib or the writer gave up. */
  | "build_failed"
  /**
   * Every rung of the size ladder was tried and the file still does not fit the
   * host's ceiling. Distinct from `build_failed` because it is not a failure at
   * all: nothing broke, there is simply too much paper for the budget, and the
   * only thing that helps is removing pages. `build.removePages` says how many.
   */
  | "over_budget";

/**
 * What the page's `final` actually is — as opposed to what was asked for.
 *
 * The distinction is the whole reason this record exists. A render can degrade
 * (the illumination pass throws, scanic cannot apply the corners) and still
 * hand back a page the user can use; when it does, the app must describe the
 * page it *got*. Screens read the effective finish, the PDF's `/Subject`
 * records it, and the un-enhanced compare knows there is nothing to compare
 * when it is already `original`.
 */
export interface RenderedTransforms {
  /** The page revision these pixels were made from. */
  revision: number;
  /** Baked into `final`, so the picture on screen needs no CSS turn. */
  rotation: PageRotation;
  /** The finish that was really applied. */
  finish: PageFinish;
  /** False when the corners could not be applied and the frame went in flat. */
  warped: boolean;
  /**
   * True only when the curved geometry produced these pixels.
   *
   * Read together with {@link ScanPage.dewarpRequested} this is the whole of
   * the requested-vs-effective rule for the correction: requested and not
   * effective is the state the page view says out loud, and the `/Subject`
   * line is written from **this** field alone.
   */
  dewarped: boolean;
  /**
   * Why the correction did not happen, when it was asked for. A stable engine
   * identifier for `console.debug`, never something a person reads.
   */
  dewarpFallbackReason?: string;
  /**
   * Which producer this render's `dewarped`/`dewarpFallbackReason` are about.
   *
   * Every build before "ab" has exactly one possible value here
   * ({@link resolveGeometryMode}'s own answer), so this changes nothing for
   * them. The "ab" build shows two controls over the same page and only ever
   * renders *one* engine's pixels at a time — this is how {@link dewarpOutcome}
   * and the outcome chip know which of the two controls a fallback (or a
   * success) belongs to, rather than a stale result from the other engine
   * being read as if it were current.
   */
  dewarpEngineMode: DewarpEngineMode;
}

/** How far along a running curved-page correction is, for the page view. */
export interface DewarpActivity {
  pageId: string;
  phase: DewarpPhase;
  /** Bytes of the model fetched so far. 0 outside the download phase. */
  received: number;
  /** Bytes the model weighs. 0 outside the download phase. */
  total: number;
}

export interface ScanPage {
  id: string;
  /** 0-based, contiguous, canonical — the order of the PDF. */
  order: number;
  /**
   * The page revision. Bumped by everything that invalidates the pixels: a
   * retake, a corner adjustment, a turn, a finish change.
   *
   * Every asynchronous job — render, gate, OCR, the PDF build — captures the
   * page id **and** this number when it starts and commits only if both still
   * match. It is what stops a slow render from landing its thumbnail over a
   * retake the user made while it was running.
   */
  revision: number;
  /**
   * The revision at which `canonical` was last written.
   *
   * Separate from {@link ScanPage.revision} because the gate measures the
   * *source*, pre-warp: a turn or a finish change bumps the revision without
   * touching the pixels the gate looked at, and dropping a perfectly good
   * reading because the user rotated the page would be a lie in the other
   * direction.
   */
  sourceRevision: number;
  status: PageStatus;
  /**
   * The one source. EXIF honoured once, long edge capped once, JPEG q92 —
   * written at capture, retake or import and byte-immutable until the next one.
   * Every render, and the corner editor, start from these bytes.
   */
  canonical: Blob;
  /**
   * The page outline in the canonical's own frame, as fractions (0–1).
   *
   * Normalized at rest so rotation, finish and a re-decode at a different size
   * can never move them; pixels are spoken only at scanic's boundary. Null
   * means no trustworthy quad — the frame goes in flat (the warp rescue).
   */
  corners: NormalizedQuad | null;
  /** Quarter turns clockwise the user asked for. Baked by the render. */
  rotation: PageRotation;
  /** "Acabamento da folha" — the finish the user asked for. */
  finish: PageFinish;
  /**
   * "Corrigir curvatura" (beta) — the user asked for the curved geometry.
   *
   * A standing choice about this page, exactly like {@link ScanPage.finish}: a
   * turn, a finish change, a re-crop or a retake all leave it alone, because a
   * page photographed out of a bound book is still out of a bound book. It is a
   * *request*, never a claim — what actually happened is
   * {@link RenderedTransforms.dewarped}, and the two are allowed to disagree.
   */
  dewarpRequested: boolean;
  /**
   * Which producer {@link ScanPage.dewarpRequested} is asking for.
   *
   * A standing fact alongside it, not two independent booleans: the "ab"
   * build's two controls are mutually exclusive, so "on" is
   * always on for exactly one engine, and switching tiles just changes this
   * field and re-runs — the same revision bump every other geometry edit
   * gets. Every build before "ab" only ever writes {@link resolveGeometryMode}
   * here, so it is inert for them.
   */
  dewarpEngineMode: DewarpEngineMode;
  /**
   * The one derived artifact: JPEG q85, geometry and finish and rotation all
   * applied. Shown on screen and embedded in the PDF, same bytes. Null until
   * the first render commits.
   */
  final: Blob | null;
  /** ~480 px rail thumbnail, off the same render canvas. Feeds nothing. */
  thumb: Blob | null;
  /** Pixel size of `final`; the PDF page is cut to it. */
  width: number;
  height: number;
  /** What `final` really is. Null until the first render commits. */
  rendered: RenderedTransforms | null;
  /** The on-device capture-gate reading — the page's only quality verdict. */
  gate: GateReading | null;
  /** The revision the reading was taken at; stale readings are not shown. */
  gateRevision: number;
  /** Why it failed, when `status === "failed"`. Translated at render time. */
  error: PageErrorCode | null;
  createdAt: number;
}

export interface ScanSession {
  id: string;
  createdAt: number;
  updatedAt: number;
  pages: ScanPage[];
  /**
   * What the user chose to call this document, verbatim.
   *
   * Since the naming redesign this is the **suffix** of the composed file name
   * — the marking tapped on step 3 ("exame", "receita") or the free text
   * written behind "✎ editar". It is stored exactly as chosen and slugged only
   * at naming time (`lib/naming.ts`); it never reaches the PDF's `/Title`
   * verbatim, and it is ignored entirely when the host named the file. Null
   * until step 3 opens, and never a required decision: the file gets a dated
   * name either way.
   */
  documentName: string | null;
}

export type BuildPhase = "idle" | "working" | "done" | "failed";

/**
 * Which of the build's passes is running.
 *
 * The "gerando" screen renders these as a checklist, so they have to be a
 * closed set the UI can reason about rather than a sentence it has to parse.
 * There is one rung left: the OCR pass went with the text layer,
 * and rotation is baked into each page's own render, so the build has no pixels
 * left to touch either. It stays a union because the checklist is written
 * against one, and a second pass is a plausible thing to add.
 */
export type BuildStep = "assembling";

export interface PdfBuild {
  phase: BuildPhase;
  /**
   * Which pass is running. Null unless `phase === "working"`.
   *
   * This, `pageIndex` and `pageCount` are the whole of what the progress screen
   * renders: the sentence is composed there, in the reader's language, rather
   * than stored here in one.
   */
  step: BuildStep | null;
  /**
   * The user asked to stop and the build has not yet reached a checkpoint.
   *
   * A visible state, not an internal one: cancellation is cooperative, so on a
   * slow phone the gap between the tap and the screen changing can be a whole
   * page of work. Without this the user taps "Cancelar", nothing happens, and
   * they tap it again.
   */
  cancelling: boolean;
  /** 1-based page the current pass is on, for "página 2 de 5". 0 when N/A. */
  pageIndex: number;
  /** 0–1. */
  progress: number;
  blob: Blob | null;
  /**
   * The finished file's name: the host's `defaultFileName` verbatim when it
   * passed one, else the scan's own start stamp plus the chosen marking
   * (`lib/naming.ts`) — exactly the string step 3 showed before the file
   * existed.
   */
  fileName: string | null;
  pageCount: number;
  error: BuildErrorCode | null;
  /**
   * How many pages would have to go for the file to fit, when `error` is
   * `over_budget`. Zero otherwise. Never the whole document.
   */
  removePages: number;
}

export interface ScanState {
  session: ScanSession | null;
  /**
   * The user has been told, once, what "corrigir curvatura" downloads.
   *
   * A session fact rather than a page one — the ~19 MB is fetched once per
   * device, so asking again on page 2 would be theatre. It is the user's
   * standing answer rather than a property of the document in front of them,
   * so it survives `start()` and `clear()` and dies with the tab, like
   * everything else here.
   */
  dewarpConsented: boolean;
  /** The correction running right now, or null. At most one page at a time. */
  dewarpActivity: DewarpActivity | null;
  build: PdfBuild;
}

/**
 * Which affordance produced a capture.
 *
 * It used to feed a `?debug=1` gate-calibration log, which this library does
 * not have. What is left is the one thing the store itself reads it for: `"adjust"` means the frame was re-cropped rather than
 * re-photographed, and a re-crop keeps the page's rotation.
 */
export type CapturePath = "shutter" | "gallery" | "desktop" | "retake" | "adjust";

export interface CaptureInput {
  /** The pre-warp source, already encoded as the page's canonical (q92). */
  canonical: Blob;
  /** The confirmed outline, normalized to the canonical. Null = no warp. */
  corners: NormalizedQuad | null;
  gate: GateReading | null;
  /** Which affordance produced it — recorded for gate calibration only. */
  path: CapturePath;
}

// ── the seams the tests inject ───────────────────────────────────────────────

/** One page on its way into the file: the reviewed bytes, and what they are. */
export interface ScanPdfPage {
  /** The page's `final` blob, embedded without recompression. */
  jpeg: Blob;
  /** What was actually done to this page, for the `/Subject` record. */
  transform: PageTransform;
}

export type ScanPdfResult =
  | { ok: true; blob: Blob; pageCount: number; bytes: number; rung: number }
  | { ok: false; reason: "over_budget"; bytes: number; pageCount: number; removePages: number };

export interface ScanPdfOptions {
  onPage(done: number, total: number): void;
  /** Fires once per size-ladder rung attempted, with that rung's measured size. */
  onRung?(rung: number, bytes: number): void;
  /**
   * `/Title`. Always the file name without its extension — never the text
   * somebody typed, which is free text about a health document and would
   * travel inside the file wherever it is forwarded.
   */
  title: string | null;
  /** The host's hard ceiling. Absent means the ladder never runs past rung 0. */
  maxBytes?: number;
}

/**
 * Everything the store does to *bytes*, behind one interface.
 *
 * The store's own job is bookkeeping — revisions, supersede rules, the export
 * transaction — and none of that needs a canvas. Holding the pixel work behind
 * this seam is what lets those rules be tested at their own level, with a fake
 * codec that counts encodes instead of a headless browser that cannot.
 *
 * There is no OCR rung: the text layer, its engine and the `searchable` flag
 * are not part of this library. A future `@azelotech/scan-ocr`
 * would consume the finished PDF, not the pages.
 */
export interface ScanPipeline {
  render(request: RenderRequest): Promise<RenderedPage>;
  assemble(pages: readonly ScanPdfPage[], options: ScanPdfOptions): Promise<ScanPdfResult>;
}

/**
 * The real one. pdf-lib is imported lazily rather than at module scope: it is
 * ~120 kB and it does not belong in the bundle a user downloads to photograph
 * a page.
 */
const BROWSER_PIPELINE: ScanPipeline = {
  render: renderPage,
  async assemble(pages, options) {
    // Typed structurally at this one boundary rather than by importing
    // `lib/pdf.ts`'s own types. The store's contract with the writer is "these
    // bytes, this provenance, one blob back", and stating it here keeps the
    // bookkeeping layer compilable against any shape the writer settles on.
    const module = (await import("@/lib/pdf")) as unknown as {
      buildPdf: (
        pages: readonly ScanPdfPage[],
        options: ScanPdfOptions,
      ) => Promise<ScanPdfResult>;
    };
    return module.buildPdf(pages, options);
  },
};

let defaultPipeline: ScanPipeline = BROWSER_PIPELINE;

/**
 * Swaps the pixel/PDF layer for stores created *after* this call.
 *
 * Kept for the handful of call sites that predate {@link createScanStore};
 * new code passes `pipeline` to the factory instead, which is per-instance and
 * therefore cannot leak one test's codec into the next.
 */
export function setScanPipeline(next: ScanPipeline | null): void {
  defaultPipeline = next ?? BROWSER_PIPELINE;
}

// ── reading a page ───────────────────────────────────────────────────────────

/**
 * The page's quality verdict, or null when the reading no longer describes the
 * pixels it was taken on (a retake, a re-crop). A stale verdict is worse than
 * none: it is the app being confident about a photo it never measured.
 */
export function pageGate(page: ScanPage): GateReading | null {
  return page.gateRevision === page.sourceRevision ? page.gate : null;
}

/** The finish the page really has — not necessarily the one it asked for. */
export function effectiveFinish(page: ScanPage): PageFinish {
  return page.rendered?.finish ?? page.finish;
}

/**
 * What the page view says about a correction that did not happen — five
 * sentences for seventeen engine reasons, because the reader needs the
 * *consequence*, not the diagnosis.
 *
 * The first three are **deterministic for these pixels**: running again gives
 * the same answer, so their copy closes the matter ("fica melhor como está")
 * and {@link scanStore.setPageDewarp} refuses to spend twelve seconds
 * re-deriving it. The last two are worth a retry, and their copy says so.
 * `better-flat` is deliberately not a warning at all: the A/B ran end to end
 * and kept the better image — reporting that as a failure was the
 * original complaint, and it violated the honesty rule in the mirror
 * direction (claiming a failure that did not happen).
 */
export type DewarpOutcome =
  /** The A/B compared both and the flat page reads better. Deterministic. */
  | "better-flat"
  /** Too little evidence to judge; kept the flat page. Deterministic. */
  | "unverified"
  /** This page's shape is outside what the model can do. Deterministic. */
  | "page"
  /** The model bytes did not arrive. Worth a retry on better signal. */
  | "download"
  /** The machinery failed mid-run. Worth a retry. */
  | "transient";

const DEWARP_OUTCOMES: Record<string, DewarpOutcome> = {
  "semantic-regression": "better-flat",
  "semantic-insufficient-evidence": "unverified",
  "ineligible-quad": "page",
  "grid-contract": "page",
  "guard-nonfinite": "page",
  "guard-bounds": "page",
  "guard-jacobian": "page",
  "guard-scale": "page",
  "guard-displacement": "page",
  "guard-boundary": "page",
  // Classical engine only — cheap, pipeline-internal
  // signals that stand in for a guard rejection when the grid itself never
  // got the chance to fold: same family, same bucket, same deterministic
  // "this page's shape is outside what the model can do" sentence.
  "classical-non-convergent": "page",
  "classical-insufficient-features": "page",
  "classical-degenerate-bounds": "page",
  "classical-aspect-outlier": "page",
  "model-unavailable": "download",
  // `unsupported` also latches the whole feature off in dewarp-stage; the
  // mapping here only covers the render that carried the answer back.
  unsupported: "transient",
  "worker-failed": "transient",
  timeout: "transient",
  "render-failed": "transient",
  "source-unavailable": "transient",
  "baseline-unavailable": "transient",
  // A cancel is the user's own act, not an outcome to report.
};

/** True when a re-run on the same pixels would give the same answer. */
export function dewarpOutcomeIsFinal(outcome: DewarpOutcome): boolean {
  return outcome === "better-flat" || outcome === "unverified" || outcome === "page";
}

/**
 * The outcome of this page's last correction attempt, or null when there is
 * nothing to say (never asked, still rendering, edited since, belongs to the
 * *other* engine, or cancelled).
 *
 * Keyed off the *rendered* record rather than the request: a fallback hands
 * the switch back (the toggle reflects the outcome, not the
 * wish), so the record of what happened has to live with the pixels it
 * happened to — and it expires with them, because an edit bumps the revision.
 *
 * `mode` defaults to {@link resolveGeometryMode}, so every call site before
 * the "ab" build reads unchanged. The "ab" build's two controls each pass
 * their own mode, and the `dewarpEngineMode` check below is what keeps them
 * from reading each other's result: a render is either about *this* control's
 * engine or it says nothing to it, full stop.
 */
export function dewarpOutcome(
  page: ScanPage,
  mode: DewarpEngineMode = resolveGeometryMode(),
): DewarpOutcome | null {
  const reason = dewarpFallbackReason(page, mode);
  if (reason === null) return null;
  return DEWARP_OUTCOMES[reason] ?? "transient";
}

/**
 * The engine's own reason behind {@link dewarpOutcome}, under exactly the same
 * conditions — one predicate, so the sentence and the code can never disagree
 * about whether there is anything to say.
 */
function dewarpFallbackReason(page: ScanPage, mode: DewarpEngineMode): string | null {
  const rendered = page.rendered;
  if (rendered === null || rendered.revision !== page.revision) return null;
  if (rendered.dewarpEngineMode !== mode) return null;
  if (rendered.dewarped || rendered.dewarpFallbackReason === undefined) return null;
  // A cancel is the user's own act — nothing happened worth a sentence.
  if (rendered.dewarpFallbackReason === "cancelled") return null;
  return rendered.dewarpFallbackReason;
}

/**
 * The support code for what actually happened to this page — `#017`, not the
 * bucket its sentence came from.
 *
 * Five sentences cover twenty-two guards ({@link DEWARP_OUTCOMES}), which is
 * right for the person holding the phone and useless for the person being sent
 * their screenshot. This is the difference, and it is deliberately the *reason*
 * rather than the outcome: two pages showing "mantivemos a original" can have
 * failed four rungs apart.
 */
export function dewarpOutcomeCode(
  page: ScanPage,
  mode: DewarpEngineMode = resolveGeometryMode(),
): string | null {
  const reason = dewarpFallbackReason(page, mode);
  return reason === null ? null : dewarpReasonCode(reason);
}

/**
 * Whether this engine's download is big enough to ask permission for first.
 *
 * The consent sheet used to exist to gate uvdoc's ~19 MB model on mobile
 * data. `DewarpEngineMode` is now narrowed to the single `"classical"`
 * engine, whose whole payload is ~130 KB of wasm — small enough that gating
 * it behind the same paragraph would be theatre, not disclosure. This always
 * answers `false` now; there is no heavy model left to gate consent on.
 */
export function dewarpConsentRequired(mode: DewarpEngineMode): boolean {
  return mode !== "classical";
}

/** True when `final` was rendered from the page as it stands right now. */
export function isRendered(page: ScanPage): boolean {
  return (
    page.status === "ready" &&
    page.final !== null &&
    page.rendered !== null &&
    page.rendered.revision === page.revision
  );
}

/**
 * The turn a screen still has to apply in CSS.
 *
 * Rotation is baked into `final`, so once a render has caught up this is 0 and
 * the picture is shown as it is. In the window between the tap and the render
 * landing it is the quarter turn the user just asked for, which is what keeps
 * "Girar" feeling instant: the current pixels spin under the animation and the
 * freshly baked ones arrive already turned, at which point the transform drops
 * to 0 without anything moving on screen.
 */
export function displayRotation(page: ScanPage): PageRotation {
  // Before the first render there is no `final` to show, so the screens fall
  // back to the canonical — which is upright by construction, hence 0.
  const baked = page.rendered?.rotation ?? 0;
  return (((page.rotation - baked + 360) % 360) as PageRotation);
}

/**
 * `/Title` from the file name: the name without a trailing `.pdf`.
 *
 * Never the typed document name. The file name is already public in every
 * sense that matters — it is on screen and in the host's hands — while `/Title`
 * is invisible metadata that travels with the bytes; the two saying the same
 * thing means nothing rides along that nobody saw.
 */
export function titleFromFileName(fileName: string): string | null {
  const title = fileName.replace(/\.pdf$/i, "").trim();
  return title.length === 0 ? null : title;
}

const IDLE_BUILD: PdfBuild = {
  phase: "idle",
  step: null,
  cancelling: false,
  pageIndex: 0,
  progress: 0,
  blob: null,
  fileName: null,
  pageCount: 0,
  error: null,
  removePages: 0,
};

// ── one store at a time ──────────────────────────────────────────────────────

/**
 * How many stores are alive right now.
 *
 * 0.x supports exactly one mounted `<ScanFlow>`. Not because the state could
 * not be duplicated — after this refactor it can — but because three things
 * below the state are still device-wide and cannot be: the render worker lane
 * (`lib/render-remote.ts`, one thread by design on a phone with ~200 MB to
 * spend), the dewarp engine's session latches (`lib/dewarp-stage.ts`), and the
 * ML detector's own. Two flows would quietly share and fight over all three.
 * Multi-instance support waits until those three are per-instance too.
 *
 * Enforced rather than documented because the failure mode is invisible: two
 * stores produce a scan that works until the second page, and then drops a
 * render for a reason nobody can reproduce.
 */
let liveStores = 0;
let warnedAboutConcurrency = false;

const CONCURRENCY_MESSAGE =
  "@azelotech/scan: a second scan store was created while one was still alive. " +
  "0.x supports one mounted <ScanFlow> at a time; unmount the first, or wait " +
  "for its dispose, before mounting another.";

/** True when the bundle was built for development. Safe where `process` is not. */
function isDevelopment(): boolean {
  if (typeof process === "undefined") return false;
  return process.env?.NODE_ENV !== "production";
}

function claimInstanceSlot(): void {
  if (liveStores === 0) {
    liveStores += 1;
    return;
  }
  // Dev: loud, because this is a wiring mistake in the host and the symptoms
  // are not. Production: never take a working page down over it — warn once
  // and let both run, which the owner-scoped render lane makes survivable.
  if (isDevelopment()) throw new Error(CONCURRENCY_MESSAGE);
  if (!warnedAboutConcurrency) {
    warnedAboutConcurrency = true;
    console.warn(CONCURRENCY_MESSAGE);
  }
  liveStores += 1;
}

export interface ScanStoreOptions {
  /**
   * Where this library's WebAssembly lives on the host's origin.
   *
   * The store does not fetch anything itself, but the render pipeline it drives
   * instantiates the curved-page engine, and that engine has to be told. It is
   * a store option rather than a module global because two hosts on one page
   * could serve their assets from two different places.
   */
  assets?: AssetUrls;
  /**
   * The host's hard ceiling on the finished file, in bytes.
   *
   * Absent means no ceiling and the size ladder never runs: the document is
   * assembled exactly as reviewed. Present means the writer steps quality down
   * until the measured file fits, and refuses rather than exceed it.
   */
  maxBytes?: number | null;
  /**
   * How many pages one document may hold. Defaults to {@link MAX_PAGES}.
   *
   * The store enforces it as well as the screens, and deliberately: a screen
   * that forgets the cap is a courtesy failing, while a document that quietly
   * grows past what the host can accept is the person's ten minutes wasted.
   */
  maxPages?: number;
  /** Fires once per ladder rung attempted. The flow turns it into an event. */
  onRung?: ((rung: number, bytes: number) => void) | null;
  /**
   * The host's name for the finished file, used verbatim.
   *
   * When present the store never composes a name from the marking or from
   * typed text, and the screens offer no way to type one.
   */
  fileName?: string | null;
  /**
   * The pixel/PDF layer. Defaults to the browser one (or to whatever
   * {@link setScanPipeline} last installed). Per-instance, so one test's fake
   * codec cannot reach the next test's store.
   */
  pipeline?: ScanPipeline | null;
}

/**
 * A scan, and the machinery that keeps it honest — one per mounted component.
 *
 * Everything mutable lives in this closure: the state, its listeners, the
 * serial render chain, the queued-render set, the build latches, the per-page
 * dewarp abort handles and the curvature replay cache. Nothing is shared with
 * another store except the render worker *thread*, and every job handed to it
 * carries this instance's id, so one store's cancel can never take another
 * store's render down with it.
 *
 */
export interface ScanStore {
  /** This instance's id — the owner stamped on every job it hands the lane. */
  readonly id: string;
  /** True once {@link ScanStore.dispose} has run. Every operation is inert. */
  readonly disposed: boolean;
  /** Give everything back. Idempotent, never throws. See the implementation. */
  dispose(): void;

  subscribe(listener: () => void): () => void;
  getSnapshot(): ScanState;
  getServerSnapshot(): ScanState;

  start(): void;
  clear(): void;
  addCapture(input: CaptureInput): void;
  replaceCapture(pageId: string, input: CaptureInput): void;
  setGate(pageId: string, revision: number, reading: GateReading | null): void;
  retryPage(pageId: string): void;
  setPageFinish(pageId: string, finish: PageFinish): void;
  setPageDewarp(pageId: string, requested: boolean, mode?: DewarpEngineMode): void;
  cancelDewarp(pageId: string): void;
  acceptDewarpConsent(): void;
  rotatePage(pageId: string, direction?: "cw" | "ccw"): void;
  setPageRotation(pageId: string, rotation: PageRotation): void;
  setDocumentName(name: string): void;
  removePage(pageId: string): void;
  movePage(pageId: string, delta: -1 | 1): void;
  movePageTo(pageId: string, targetIndex: number): void;
  resetBuild(): void;
  cancelBuild(): void;
  buildPdf(): Promise<void>;
}

export function createScanStore(options: ScanStoreOptions = {}): ScanStore {
  claimInstanceSlot();

  /** This store's identity, as worn by every render job it hands to the lane. */
  const instanceId = newId();
  const pipeline: ScanPipeline = options.pipeline ?? defaultPipeline;
  /** Null in tests, which never reach the engine. */
  const assets: AssetUrls | null = options.assets ?? null;
  const maxBytes: number | null = options.maxBytes ?? null;
  const maxPages: number = options.maxPages ?? MAX_PAGES;
  const onRung = options.onRung ?? null;
  const hostFileName: string | null = options.fileName ?? null;
  /**
   * Inert from here on: every operation returns without touching anything, and
   * `getSnapshot` answers the empty state. Disposal happens on unmount, and an
   * unmount races async work by construction — a render that settles after it,
   * a build that was mid-`await`. Throwing at them would turn an ordinary
   * teardown into an error the host has to catch.
   */
  let disposed = false;
  if (assets !== null) setRenderWorkerAssets(assets);
  claimRenderLane(instanceId);

  type Listener = () => void;

  const listeners = new Set<Listener>();

  const SERVER_STATE: ScanState = {
    session: null,
    dewarpConsented: false,
    dewarpActivity: null,
    build: IDLE_BUILD,
  };

  let state: ScanState = SERVER_STATE;
  /** Serial render chain — one heavy pixel pass at a time. */
  let chain: Promise<void> = Promise.resolve();
  /**
   * Pages with a render job sitting in the chain that has not started yet.
   *
   * At most **one active render and one waiting one** per page. The waiting job
   * carries no revision of its own: it reads the page's current state when it
   * finally runs, so tapping through the three finish pills faster than a 12 MP
   * pass completes queues one job, not three, and that job renders the pill the
   * user actually settled on.
   */
  const queuedRenders = new Set<string>();

  /**
   * The build allowed to own the state, exactly like a page's revision does for
   * its render.
   *
   * Without it a build has no identity: `resetBuild`, `start` and `clear` all put
   * the state back to idle while an async build is still running, so a second
   * build can begin beside the first. The first would then publish its blob over
   * the second's, and — worse — its `finally` would clear the shared cancel flag
   * *after* the user cancelled the second, making that cancellation a no-op.
   */
  let currentBuild = 0;
  let buildSeq = 0;

  /**
   * Set by {@link ScanStore.cancelBuild} and read between passes of a running
   * build. Cancellation is cooperative on purpose: pdf-lib runs synchronous work
   * we cannot interrupt, so the honest granularity is "at the next page
   * boundary", which on the slowest device is one page of serialization.
   */
  let buildCancelled = false;

  /** Thrown by the build's own checkpoints. Never surfaced to the user. */
  const CANCELLED = Symbol("build-cancelled");
  /** Thrown when the document changed under a running build. */
  const STALE = Symbol("build-stale");

  function emit(): void {
    for (const listener of listeners) listener();
  }

  /**
   * The one funnel every state write goes through — and therefore the one place
   * disposal has to be honoured.
   *
   * Guarding here rather than at each of the twenty-odd operations is not
   * brevity, it is coverage: the writes that actually race a dispose are not the
   * ones a user taps, they are the ones a settled render or a mid-`await` build
   * makes on its way out, and those reach the state through here too.
   */
  function setState(next: Partial<ScanState>): void {
    if (disposed) return;
    state = { ...state, ...next };
    emit();
  }

  function newId(): string {
    const globalCrypto: Crypto | undefined =
      typeof crypto === "undefined" ? undefined : crypto;
    if (globalCrypto !== undefined && typeof globalCrypto.randomUUID === "function") {
      return globalCrypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function touch(session: ScanSession): ScanSession {
    return { ...session, updatedAt: Date.now() };
  }

  function findPage(pageId: string): ScanPage | undefined {
    return state.session?.pages.find((page) => page.id === pageId);
  }

  // ── mutation helpers ─────────────────────────────────────────────────────────

  function withPages(mutate: (pages: ScanPage[]) => ScanPage[]): void {
    const session = state.session;
    if (session === null) return;
    const pages = mutate([...session.pages]).map((page, index) => ({
      ...page,
      order: index,
    }));
    setState({ session: touch({ ...session, pages }) });
  }

  function patchPage(pageId: string, patch: Partial<ScanPage>): void {
    const session = state.session;
    if (session === null) return;
    // The page may have been deleted while its render ran; silently dropping the
    // patch is exactly right — the user already said no to it.
    if (!session.pages.some((page) => page.id === pageId)) return;
    withPages((pages) =>
      pages.map((page) => (page.id === pageId ? { ...page, ...patch } : page)),
    );
  }

  /**
   * An edit that invalidates the pixels: bump the revision and go back to
   * `processing`, so nothing downstream — the rail, the review list, the PDF
   * button, a running build — can mistake the old artifacts for current ones.
   */
  function reviseAndRender(
    pageId: string,
    patch: (page: ScanPage) => Partial<ScanPage>,
  ): void {
    const page = findPage(pageId);
    if (page === undefined) return;
    // Whatever this edit is — a turn, a finish, a re-crop, a retake, the switch
    // itself — the pixels a running correction is working towards are already
    // obsolete. It is told so before the revision moves.
    abortDewarp(pageId, SUPERSEDED_ABORT);
    const revision = page.revision + 1;
    patchPage(pageId, {
      ...patch(page),
      revision,
      status: "processing",
      error: null,
    });
    requestRender(pageId);
  }

  function enqueue(work: () => Promise<void>): void {
    // No new pixel work after dispose. The pass already running cannot be
    // interrupted mid-decode, but it can be stopped from having a successor.
    if (disposed) return;
    chain = chain.then(work).catch(() => {
      // Every job already handles its own failure; this only stops one broken
      // page from poisoning the chain for the next capture.
    });
  }

  function describeFailure(error: unknown): PageErrorCode {
    return error instanceof ImagePrepError ? error.code : "generic";
  }

  /**
   * The controller a running correction listens to, per page.
   *
   * Cancellation has to reach *into* the render that is already in the chain, and
   * the chain only carries a function — so the handle lives beside it, keyed by
   * the page it belongs to, and is dropped the moment that render settles.
   */
  const dewarpAborts = new Map<string, AbortController>();

  /**
   * Stop the correction running for a page, and say why.
   *
   * Both reasons stop the inference; they differ in what the *render* does next.
   * `"cancelled"` lets the pass finish flat, because the user asked for it to
   * stop and the page has to settle on the pixels they are looking at.
   * {@link SUPERSEDED_ABORT} unwinds it instead — the edit that superseded it has
   * already queued its own render, and a second full-resolution pass whose result
   * is dropped on arrival is a phone doing 12 MP of work for nobody.
   *
   * Every invalidating edit goes through here. Leaving it out is not a
   * correctness bug — the revision check drops the stale result either way — it
   * is a page-sized amount of battery, memory and queue spent on an answer that
   * cannot be used.
   */
  function abortDewarp(pageId: string, reason: string): void {
    dewarpAborts.get(pageId)?.abort(reason);
  }

  /**
   * How much has to arrive before the screen is told again.
   *
   * The engine reports every chunk the reader hands it, which on a 16 MB model is
   * hundreds of ticks — and every tick here is a store write that re-renders each
   * subscribed screen. A ~0.25 MB step is still a visibly moving number and costs
   * about sixty repaints for the whole download.
   */
  const DEWARP_PROGRESS_STEP_BYTES = 262_144;

  /** The last accepted map a page's curved geometry produced, and its identity. */
  interface DewarpReplayEntry {
    /** Reference identity, not content — `canonical` is byte-immutable and only
     * a retake or a corner adjustment ever produces a *new* `Blob` for a page
     * (`replaceCapture` below), so `===` is the exact "these are still the same
     * pixels" test. */
    canonicalRef: Blob;
    engineMode: DewarpEngineMode;
    replay: DewarpReplay;
  }

  /**
   * One page's last successful curvature map, kept across the render it was
   * made in — unlike `page-processing.ts`'s own `DewarpMemo`, which forgets it
   * the instant that `renderPage` call returns.
   *
   * This is what makes turning curvatura off and back on a resample instead of
   * a second inference (the switch-hands-back rule plus this cache): off does
   * not touch the page's `canonical`, so the entry below is still good the
   * moment the switch goes back on, and {@link renderRequestFor} hands it to
   * the pipeline as `dewarp.replay`. It goes stale — silently, safely — the
   * instant the canonical actually changes, because nothing here is ever read
   * without the reference check in {@link replayFor} passing first.
   */
  const dewarpReplays = new Map<string, DewarpReplayEntry>();

  /** The stored replay for this page's *current* pixels and engine, if any. */
  function replayFor(page: ScanPage): DewarpReplay | null {
    const entry = dewarpReplays.get(page.id);
    if (entry === undefined) return null;
    if (entry.canonicalRef !== page.canonical) return null;
    if (entry.engineMode !== page.dewarpEngineMode) return null;
    return entry.replay;
  }

  function renderRequestFor(page: ScanPage, signal?: AbortSignal): RenderRequest {
    let announced = -1;
    const replay = page.dewarpRequested ? replayFor(page) : null;
    return {
      canonical: page.canonical,
      corners: page.corners,
      rotation: page.rotation,
      finish: page.finish,
      ...(assets === null ? {} : { assets }),
      dewarp: page.dewarpRequested
        ? {
            sourceId: page.id,
            generation: page.revision,
            engineMode: page.dewarpEngineMode,
            ...(replay === null ? {} : { replay }),
            onPhase: (progress) => {
              const received = progress.received ?? 0;
              const total = progress.total ?? 0;
              const phase = progress.phase;
              const moved =
                received === 0 ||
                received === total ||
                received - announced >= DEWARP_PROGRESS_STEP_BYTES;
              if (state.dewarpActivity?.phase === phase && !moved) return;
              announced = received;
              setState({
                dewarpActivity: { pageId: page.id, phase, received, total },
              });
            },
            ...(signal === undefined ? {} : { signal }),
          }
        : null,
    };
  }

  /**
   * Ask for the page to be rendered from its canonical.
   *
   * Idempotent while a job is already waiting: the waiting job reads the page's
   * state when it starts, so a second request would only render the same thing
   * twice.
   */
  function requestRender(pageId: string): void {
    if (queuedRenders.has(pageId)) return;
    queuedRenders.add(pageId);
    enqueue(async () => {
      queuedRenders.delete(pageId);
      const page = findPage(pageId);
      if (page === undefined) return;
      if (isRendered(page)) return;
      const revision = page.revision;
      // Frozen at the same moment `revision` is: the mode a running render used
      // does not follow a later edit to `page.dewarpEngineMode` any more than
      // its pixels follow a later edit to `page.canonical`.
      const mode = page.dewarpEngineMode;
      const controller = page.dewarpRequested ? new AbortController() : null;
      if (controller !== null) dewarpAborts.set(pageId, controller);
      try {
        const rendered = await pipeline.render(
          renderRequestFor(page, controller?.signal),
        );
        // The page moved on while we worked. Its successor owns the state now.
        if (findPage(pageId)?.revision !== revision) return;
        const reason = rendered.dewarpFallbackReason;
        patchPage(pageId, {
          status: "ready",
          final: rendered.final,
          thumb: rendered.thumb,
          width: rendered.width,
          height: rendered.height,
          rendered: {
            revision,
            rotation: rendered.rotation,
            finish: rendered.finish,
            warped: rendered.warped,
            dewarped: rendered.dewarped,
            dewarpEngineMode: mode,
            ...(reason === undefined ? {} : { dewarpFallbackReason: reason }),
          },
          // Any fallback hands the switch back: the toggle reflects the
          // page the user is looking at, not the wish they once expressed — a
          // switch that says ON over an uncorrected page is a lie
          // reported as a bug. The outcome itself stays on `rendered`, where
          // the page view reads it. Clearing the request *here* rather than at
          // the tap is also what keeps a cancel from costing a second render.
          ...(reason === undefined ? {} : { dewarpRequested: false }),
          error: null,
        });
        // The store's own replay cache, independent of `page-processing.ts`'s
        // per-render memo: this is what a *later* toggle-off/toggle-on reads
        // (`replayFor`, above), not just a retry inside this one render.
        if (rendered.dewarped && rendered.dewarpReplay) {
          dewarpReplays.set(pageId, {
            canonicalRef: page.canonical,
            engineMode: mode,
            replay: rendered.dewarpReplay,
          });
        }
      } catch (error) {
        // A pass that was replaced mid-flight is not a failure to report: the
        // render that replaced it is already queued and owns the page's state.
        if (error instanceof RenderAbandonedError) return;
        if (findPage(pageId)?.revision !== revision) return;
        patchPage(pageId, { status: "failed", error: describeFailure(error) });
      } finally {
        if (dewarpAborts.get(pageId) === controller) dewarpAborts.delete(pageId);
        if (state.dewarpActivity?.pageId === pageId) {
          setState({ dewarpActivity: null });
        }
      }
    });
  }

  /**
   * Stop every running correction.
   *
   * Called when the pages themselves are going away: an inference nobody can
   * accept the result of is a minute of a phone's battery and 16 MB of its
   * memory, spent on a page that no longer exists.
   */
  function abandonDewarps(): void {
    // The pages are going away, so finishing flat would be work for nobody —
    // the same reason an edit gives, for the same effect on the running pass.
    for (const controller of dewarpAborts.values()) controller.abort(SUPERSEDED_ABORT);
    dewarpAborts.clear();
    // The replay cache is keyed by page id, and a fresh scan reuses ids from
    // nothing — but a stale entry here is only ever dead weight, never wrong
    // (`replayFor`'s reference check would refuse it anyway), so this is
    // hygiene, not correctness.
    dewarpReplays.clear();
  }

  // ── the store ────────────────────────────────────────────────────────────────

  const store: ScanStore = {
    id: instanceId,

    get disposed(): boolean {
      return disposed;
    },

    /**
     * Give everything back: the pixel work, the worker lane, the listeners, and
     * the pages themselves.
     *
     * The order matters and is the whole of this method's difficulty:
     *
     *  1. **Latch first.** `disposed` closes {@link setState} and
     *     {@link enqueue} before anything else runs, so nothing that unwinds
     *     below — a render rejecting, a build's `finally` — can write state on
     *     its way out or queue a successor.
     *  2. **Then stop the work.** Corrections are aborted as superseded, the
     *     queue is emptied, the build loses its identity (`currentBuild = 0`
     *     makes every checkpoint throw and every late writer silent), and this
     *     instance's render job is cancelled through the lane. Cancellation is
     *     *owner-scoped*: if another store has since claimed the lane, its job
     *     is untouched — which is exactly the StrictMode case, where this
     *     store's dispose runs while its successor is already live.
     *  3. **Then drop the bytes.** The state goes back to empty, which releases
     *     every `canonical`, `final` and `thumb` blob at once rather than
     *     waiting for the last component holding a snapshot to be collected.
     *  4. **Then the listeners.** Last, because a subscriber that is torn down
     *     between steps would otherwise be notified of a store that no longer
     *     has an answer.
     *
     * Object URLs: the store creates none. Every picture in the app becomes a
     * URL in `useBlobUrl`, which revokes its own on unmount — keeping a second
     * registry here would be a second thing to forget.
     *
     * Idempotent, and never throws: unmount is not a place to fail.
     */
    dispose(): void {
      if (disposed) return;
      disposed = true;
      abandonDewarps();
      queuedRenders.clear();
      currentBuild = 0;
      buildCancelled = true;
      releaseRenderLane(instanceId);
      state = SERVER_STATE;
      emit();
      listeners.clear();
      liveStores = Math.max(0, liveStores - 1);
    },

    subscribe(listener: Listener): () => void {
      // A subscription to a disposed store would never fire; handing back a
      // no-op unsubscribe keeps the caller's cleanup honest either way.
      if (disposed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /** Identity-stable between writes, as `useSyncExternalStore` requires. */
    getSnapshot(): ScanState {
      return state;
    },

    getServerSnapshot(): ScanState {
      return SERVER_STATE;
    },

    /** A brand new, empty scan. Discards whatever was there. */
    start(): void {
      // The pages a running render belongs to are about to stop existing, so the
      // thread holding their pixels is told to drop them rather than finish work
      // nothing can accept (`lib/render-remote.ts`).
      cancelRemoteRenders(instanceId);
      abandonDewarps();
      queuedRenders.clear();
      currentBuild = 0;
      const now = Date.now();
      setState({
        session: {
          id: newId(),
          createdAt: now,
          updatedAt: now,
          pages: [],
          documentName: null,
        },
        dewarpActivity: null,
        build: IDLE_BUILD,
      });
    },

    /** Wipes everything: pages, artifacts, the PDF. */
    clear(): void {
      cancelRemoteRenders(instanceId);
      abandonDewarps();
      queuedRenders.clear();
      currentBuild = 0;
      setState({ session: null, dewarpActivity: null, build: IDLE_BUILD });
    },

    addCapture(input: CaptureInput): void {
      if (state.session === null) store.start();
      const session = state.session;
      if (session === null) return;
      if (session.pages.length >= maxPages) return;

      const page: ScanPage = {
        id: newId(),
        order: session.pages.length,
        revision: 1,
        sourceRevision: 1,
        status: "processing",
        canonical: input.canonical,
        corners: input.corners,
        rotation: 0,
        finish: DEFAULT_FINISH,
        dewarpRequested: false,
        dewarpEngineMode: resolveGeometryMode(),
        final: null,
        thumb: null,
        width: 0,
        height: 0,
        rendered: null,
        gate: input.gate,
        gateRevision: 1,
        error: null,
        createdAt: Date.now(),
      };
      withPages((pages) => [...pages, page]);
      requestRender(page.id);
    },

    /**
     * A retake or a corner adjustment. The page keeps its id and its place — the
     * whole point of both flows — and goes back to `processing` while the new
     * artifacts are made.
     *
     * Rotation follows the source of the new pixels. A **retake** is a fresh
     * photo held however the user held it this time, so the old quarter turn is
     * meaningless and resets; a **corner adjustment** re-warps the frame the
     * rotation was chosen against, so it survives — losing it there would make
     * the page flip back on its side for no reason the user could name.
     *
     * The finish is the user's standing choice for this page, not a property of
     * the bytes — a retake of a photocopy is still a photocopy — so it is left
     * exactly as it was.
     */
    replaceCapture(pageId: string, input: CaptureInput): void {
      if (findPage(pageId) === undefined) return;
      reviseAndRender(pageId, (page) => ({
        canonical: input.canonical,
        corners: input.corners,
        // The reading was taken on THESE bytes, so it is bound to the revision
        // they arrive at.
        gate: input.gate,
        gateRevision: page.revision + 1,
        sourceRevision: page.revision + 1,
        ...(input.path === "adjust" ? {} : { rotation: 0 }),
      }));
    },

    /**
     * Records a gate reading taken asynchronously against a known revision.
     *
     * Dropped when the page has moved on: a verdict that describes bytes the user
     * has already replaced is worse than no verdict at all.
     */
    setGate(pageId: string, revision: number, reading: GateReading | null): void {
      const page = findPage(pageId);
      if (page === undefined || page.revision !== revision) return;
      patchPage(pageId, { gate: reading, gateRevision: page.sourceRevision });
    },

    /** Re-runs the render for a page that failed, from the bytes it has. */
    retryPage(pageId: string): void {
      const page = findPage(pageId);
      if (page === undefined) return;
      patchPage(pageId, { status: "processing", error: null });
      requestRender(pageId);
    },

    /**
     * "Acabamento da folha": re-render with a different treatment.
     *
     * A genuine change of pixels, so it bumps the revision and goes back through
     * `processing` — the user can tap through all three pills faster than a 12 MP
     * pass completes, and the loser of that race must not land its thumbnail over
     * the winner's.
     */
    setPageFinish(pageId: string, finish: PageFinish): void {
      const page = findPage(pageId);
      if (page === undefined || page.finish === finish) return;
      reviseAndRender(pageId, () => ({ finish }));
    },

    /**
     * "Corrigir curvatura" (beta), on or off for one page — for one engine.
     *
     * A change of geometry, so it goes through the same revision bump every other
     * pixel edit does — which is also what makes tapping it twice safe: the
     * superseded render is dropped on its revision check, exactly like a finish
     * the user tapped past.
     *
     * Turning it *off* while a correction is running abandons that run rather
     * than waiting for it, and rather than letting it finish flat: the render the
     * user just asked for is already queued, so the one they turned off unwinds
     * where it stands instead of paying for a second full-resolution pass to
     * produce pixels that would be dropped on arrival.
     *
     * `mode` defaults to {@link resolveGeometryMode}, so every call before the
     * "ab" build is unaffected. In the "ab" build the two controls are mutually
     * exclusive: "on" is compared against *this* engine specifically
     * (`active`, below), so asking one engine on while the other is already on
     * switches — a genuine change of what the page asks for, not a no-op — and
     * asking an engine off that was never the active one is a no-op, same as
     * asking for what is already true always has been.
     */
    setPageDewarp(
      pageId: string,
      requested: boolean,
      mode: DewarpEngineMode = resolveGeometryMode(),
    ): void {
      const page = findPage(pageId);
      if (page === undefined) return;
      const active = page.dewarpRequested && page.dewarpEngineMode === mode;
      if (requested === active) return;
      if (requested) {
        // A verdict that is deterministic for these exact pixels is not worth
        // twelve seconds to re-derive: the outcome line is already on screen,
        // and the answer cannot change until an edit changes the pixels.
        const outcome = dewarpOutcome(page, mode);
        if (outcome !== null && dewarpOutcomeIsFinal(outcome)) return;
      }
      reviseAndRender(pageId, () => ({
        dewarpRequested: requested,
        dewarpEngineMode: mode,
      }));
    },

    /**
     * "Cancelar" under a running correction.
     *
     * Only the run is stopped; the page's request is cleared when the cancelled
     * render lands (see {@link requestRender}), so the page settles on the flat
     * geometry it already has instead of paying for a second pass to get there.
     */
    cancelDewarp(pageId: string): void {
      abortDewarp(pageId, "cancelled");
    },

    /**
     * The user has read what the correction downloads and said yes.
     *
     * Session-wide and one-way: the bytes are fetched once per device, so the
     * second page must not be asked again.
     */
    acceptDewarpConsent(): void {
      setState({ dewarpConsented: true });
    },

    /**
     * One tap of "girar": a quarter turn, clockwise by default.
     *
     * The turn is baked into the page's own render rather than into a
     * re-encode at build time, so it costs one re-render from the canonical — and
     * the PDF stops paying a lossy generation for it. It still *feels* instant:
     * the current picture spins under the animation while the render runs, and
     * the freshly baked pixels arrive already turned (see
     * {@link displayRotation}).
     */
    rotatePage(pageId: string, direction: "cw" | "ccw" = "cw"): void {
      reviseAndRender(pageId, (page) => ({
        rotation:
          direction === "cw"
            ? nextRotation(page.rotation)
            : previousRotation(page.rotation),
      }));
    },

    /**
     * Put the page at an absolute turn, in one render.
     *
     * The girar sheet's "desfazer" goes back to the orientation the page had when
     * the sheet opened, which can be three quarter-turns away — and three
     * {@link ScanStore.rotatePage} calls would spend three full renders getting
     * back to where the user started. A no-op turn is dropped rather than
     * re-rendered for nothing.
     */
    setPageRotation(pageId: string, rotation: PageRotation): void {
      const page = findPage(pageId);
      if (page === undefined || page.rotation === rotation) return;
      reviseAndRender(pageId, () => ({ rotation }));
    },

    /**
     * The user's own name for the document, stored exactly as typed — the field
     * is controlled by this value, so trimming here would eat a space the moment
     * it is typed. `lib/naming.ts` does the tidying when the file is named, and
     * a blank string is simply no name.
     */
    setDocumentName(name: string): void {
      const session = state.session;
      if (session === null) return;
      setState({
        session: touch({
          ...session,
          documentName: name.length === 0 ? null : name,
        }),
      });
    },

    removePage(pageId: string): void {
      queuedRenders.delete(pageId);
      // The page is going away; the correction still grinding towards it is the
      // most expensive thing in the app to leave running for nobody.
      abortDewarp(pageId, SUPERSEDED_ABORT);
      dewarpReplays.delete(pageId);
      withPages((pages) => pages.filter((page) => page.id !== pageId));
    },

    /** ±1 in the document. Out-of-range moves are no-ops, not errors. */
    movePage(pageId: string, delta: -1 | 1): void {
      withPages((pages) => {
        const index = pages.findIndex((page) => page.id === pageId);
        const target = index + delta;
        if (index === -1 || target < 0 || target >= pages.length) return pages;
        const reordered = [...pages];
        const [moved] = reordered.splice(index, 1);
        reordered.splice(target, 0, moved);
        return reordered;
      });
    },

    /**
     * Put the page at an absolute position in the document.
     *
     * {@link ScanStore.movePage}'s sibling, not its replacement: a phone moves a
     * page one row at a time with two arrows, and a delta is the honest shape of
     * that gesture. A desktop drags a row from position 5 to position 1 in one
     * motion, and expressing that as four swaps would fire four renumberings and
     * four re-renders of the rail for one drop. Both go through the same
     * `withPages` funnel, so `order` comes out contiguous and canonical either
     * way.
     *
     * The target is clamped rather than refused: a drop past the end of the list
     * is a drop at the end, which is what the user's hand said.
     */
    movePageTo(pageId: string, targetIndex: number): void {
      withPages((pages) => {
        const index = pages.findIndex((page) => page.id === pageId);
        if (index === -1) return pages;
        const target = Math.max(0, Math.min(pages.length - 1, targetIndex));
        if (target === index) return pages;
        const reordered = [...pages];
        const [moved] = reordered.splice(index, 1);
        reordered.splice(target, 0, moved);
        return reordered;
      });
    },

    /** Drops a finished/failed build so the host can offer to generate again. */
    resetBuild(): void {
      currentBuild = 0;
      buildCancelled = false;
      setState({ build: IDLE_BUILD });
    },

    /**
     * "Cancelar" on the assembling screen.
     *
     * Sets the flag and returns; the running build notices at its next page
     * boundary, unwinds (closing the OCR worker on its way out) and puts the
     * build back to `idle`. Deliberately NOT optimistic about the state: flipping
     * to idle here would let the user start a second build while the first is
     * still holding a recognition worker.
     */
    cancelBuild(): void {
      if (state.build.phase !== "working") return;

      buildCancelled = true;
      setState({ build: { ...state.build, cancelling: true } });
    },

    /**
     * Assemble the PDF from the pages, in order — **transactionally**.
     *
     * The build takes a snapshot of page ids, revisions and order up front and is
     * bound to it. Every page in that snapshot must be `ready` with a
     * revision-matched `final`, and those exact bytes are what gets embedded; if
     * anything is missing, failed or edited while the file is being written, the
     * build aborts with a visible error and no download. A PDF that quietly omits
     * a page the user photographed, or that ships the pixels they replaced ten
     * seconds ago, is the one failure they would not forgive — so the file is
     * either the document they reviewed or it does not exist.
     */
    async buildPdf(): Promise<void> {
      // Not merely inert: assembling a PDF nobody can receive would still
      // cost a phone the whole serialization.
      if (disposed) return;
      if (state.build.phase === "working") return;

      const ordered = [...(state.session?.pages ?? [])].sort(
        (left, right) => left.order - right.order,
      );
      if (ordered.length === 0) {
        setState({ build: { ...IDLE_BUILD, phase: "failed", error: "no_pages" } });
        return;
      }

      interface SnapshotPage {
        id: string;
        revision: number;
        jpeg: Blob;
        transform: PageTransform;
      }

      const snapshot: SnapshotPage[] = [];
      const unresolved: ScanPage[] = [];
      for (const page of ordered) {
        const final = page.final;
        const rendered = page.rendered;
        if (!isRendered(page) || final === null || rendered === null) {
          unresolved.push(page);
          continue;
        }
        snapshot.push({
          id: page.id,
          revision: page.revision,
          jpeg: final,
          // Every field here is what the render *achieved*, never what the page
          // asked for — `dewarped` included, which is why a page whose curvature
          // could not be corrected leaves no trace in the file's own account of
          // itself.
          transform: {
            finish: rendered.finish,
            rotation: rendered.rotation,
            dewarped: rendered.dewarped,
          },
        });
      }
      // Invariant 3: a page the user photographed and we could not prepare must
      // never be silently dropped from the file. A host's review screen may
      // block on this, but the store cannot rely on that — the screens are a
      // courtesy, this is the guarantee.
      if (unresolved.length > 0) {
        setState({
          build: {
            ...IDLE_BUILD,
            phase: "failed",
            error: unresolved.some((page) => page.status === "failed")
              ? "pages_failed"
              : "pages_processing",
          },
        });
        return;
      }

      buildSeq += 1;
      const buildId = buildSeq;
      currentBuild = buildId;
      buildCancelled = false;
      setState({
        build: {
          ...IDLE_BUILD,
          phase: "working",
          step: "assembling",
          pageCount: snapshot.length,
        },
      });

      /**
       * Stop unless this build still owns the state AND the document is still the
       * one it snapshotted. A superseded build unwinds down the same path as a
       * cancelled one — it must not touch the state either.
       */
      const checkpoint = (): void => {
        if (buildCancelled || currentBuild !== buildId) throw CANCELLED;
        const pages = state.session?.pages ?? [];
        if (pages.length !== snapshot.length) throw STALE;
        for (const [index, entry] of snapshot.entries()) {
          const page = pages[index];
          if (page?.id !== entry.id || page.revision !== entry.revision) {
            throw STALE;
          }
        }
      };

      const progress = (fraction: number, step: BuildStep, pageIndex = 0): void => {
        // A build that has already been cancelled must not have its progress
        // rewritten by work that was already in flight when the user tapped.
        if (buildCancelled || currentBuild !== buildId) return;
        setState({
          build: {
            ...state.build,
            progress: Math.min(1, fraction),
            step,
            pageIndex,
          },
        });
      };

      const documentName = state.session?.documentName ?? null;
      // The session is created when the user walks into the capture screen, so
      // its `createdAt` *is* the moment the scan began — the stamp the file name
      // carries (`lib/naming.ts`).
      const startedAt = state.session?.createdAt ?? Date.now();
      // Read once, up front: the language toggle is reachable while a build runs,
      // and the file's provenance line should be the one the user was reading when
      // they asked for it, not whichever they happened to land on.
      const lang = currentLang();
      // Minted from the moment the **scan began**, not from now: the user
      // files this next to the photos they took at the clinic that morning,
      // and a document stamped with the minute they got round to tapping
      // "Gerar" sorts away from the event it records. It also makes the name
      // on step 3 the name of the file, rather than a preview of one that
      // drifts every minute they spend on the screen. The unnamed-document
      // fallback follows the reader's language, because it is the only word
      // in the file name they did not choose. A host that passed its own name
      // gets exactly that name.
      const fileName =
        hostFileName ??
        pdfFileName(documentName, new Date(startedAt), pdfFallbackName(lang));

      try {
        checkpoint();
        const inputs: ScanPdfPage[] = snapshot.map((entry) => ({
          jpeg: entry.jpeg,
          transform: entry.transform,
        }));

        checkpoint();
        progress(0.8, "assembling");
        const result = await pipeline.assemble(inputs, {
          onPage: (done, total) => {
            progress(0.8 + (done / total) * 0.2, "assembling", done);
          },
          ...(onRung === null ? {} : { onRung }),
          title: titleFromFileName(fileName),
          ...(maxBytes === null ? {} : { maxBytes }),
        });
        checkpoint();
        /**
         * Too much paper for the host's ceiling, at the floor of the ladder.
         *
         * Not an error state dressed up: the pages are untouched and still on
         * screen, and the screen says how many would have to go. Telling
         * somebody this *after* they spent ten minutes photographing is bad
         * enough; telling them only "it failed" would be worse.
         */
        if (!result.ok) {
          setState({
            build: {
              ...IDLE_BUILD,
              phase: "failed",
              error: "over_budget",
              pageCount: result.pageCount,
              removePages: result.removePages,
            },
          });
          return;
        }
        setState({
          build: {
            phase: "done",
            step: null,
            cancelling: false,
            pageIndex: result.pageCount,
            progress: 1,
            blob: result.blob,
            fileName,
            pageCount: result.pageCount,
            error: null,
            removePages: 0,
          },
        });
      } catch (error) {
        // A build that is no longer the current one unwinds silently: the state
        // it would write belongs to its successor now.
        if (currentBuild !== buildId) return;
        // The user asked to stop. That is not a failure and must not be dressed
        // as one: the pages are untouched and exactly where they were.
        if (error === CANCELLED) {
          setState({ build: IDLE_BUILD });
          return;
        }
        setState({
          build: {
            ...IDLE_BUILD,
            phase: "failed",
            error: error === STALE ? "pages_changed" : "build_failed",
          },
        });
      } finally {
        // Only the build that still owns the state may release the shared flag;
        // a superseded one clearing it would silently un-cancel its successor.
        if (currentBuild === buildId) {
          currentBuild = 0;
          buildCancelled = false;
        }
      }
    },
  };

  return store;
}

/**
 * Roughly what the finished PDF will weigh, for a "tamanho estimado" row —
 * before the file exists.
 *
 * The PDF embeds each page's `final` stream without recompressing it, so the
 * sum of those blobs is the floor and the only thing left to account for is the
 * object table — a few hundred bytes a page, not knowable in advance, which is
 * why the screen says "~" and not a number pretending to be exact. There is no
 * build-time re-encode at all, so a turned page no longer lands either side of
 * its estimate.
 *
 * `searchable` is vestigial: the text layer went with OCR and
 * every caller passes `false`. It is still in the signature only so the two
 * screens that call it can lose the argument in their own commit.
 */
export function estimatedPdfBytes(
  session: ScanSession | null,
  searchable = false,
): number {
  const pages = (session?.pages ?? []).filter(
    (page) => page.status === "ready" && page.final !== null,
  );
  const images = pages.reduce((total, page) => total + (page.final?.size ?? 0), 0);
  if (images === 0) return 0;
  // ~2% structural overhead, plus ~4 kB a page of text layer when asked for.
  return Math.round(images * 1.02 + (searchable ? pages.length * 4096 : 0));
}


// ── the 0.x migration shim ───────────────────────────────────────────────────

