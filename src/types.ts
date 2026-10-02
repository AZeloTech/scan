/**
 * The public surface of `@azelotech/scan`.
 *
 * Everything a host can see or pass is in this file. It is small on purpose:
 * the library covers capture → corner confirmation → review → PDF build, and
 * ends the moment the PDF exists. What happens to the file after that — upload,
 * download, share, attach to a form — belongs to the host, because only the
 * host knows.
 *
 * Documented at 0.1, frozen at 1.0.
 */

/** The languages the library speaks. Copy is built in; hosts cannot reword it in 0.x. */
export type ScanLang = "pt-BR" | "en-US";

/**
 * Why the flow could not continue.
 *
 * `camera_denied` and `no_camera` are recoverable and the library handles them
 * itself by falling back to the file intake — a host that receives them is being
 * informed, not asked to act. The rest end the session.
 */
export type ScanErrorCode =
  /** The person refused the camera permission prompt, or a policy blocks it. */
  | "camera_denied"
  /** There is no camera, or the browser will not enumerate one. */
  | "no_camera"
  /** An asset under `assetBaseUrl` could not be fetched: wrong path, CSP, MIME type. */
  | "asset_load"
  /** The corner-detection model loaded but would not initialise. */
  | "model_init"
  /** The browser ran out of memory. Older phones, many pages. */
  | "out_of_memory"
  /** PDF assembly failed, including "the size budget cannot be met". */
  | "build_failed";

/**
 * Everything that happens inside, as it happens.
 *
 * Payloads carry numbers and enums only — never image data, never text read from
 * a page, never a file name. A host can forward these straight to analytics
 * without thinking about what is in them. That is a deliberate property of the
 * type, not a convention.
 */
export type ScanEvent =
  | { name: "step"; step: ScanStep }
  | { name: "capture"; page: number; source: "camera" | "file" }
  | { name: "retake"; page: number }
  | { name: "remove"; page: number }
  | { name: "reorder"; from: number; to: number }
  | { name: "dewarp"; page: number; outcome: "applied" | "fallback" | "declined" }
  | { name: "quality"; page: number; verdict: ScanQuality }
  /** The size ladder stepped down to fit `maxBytes`. `rung` is 0-based. */
  | { name: "size_ladder"; rung: number; bytes: number }
  | { name: "pdf_built"; pages: number; bytes: number; ms: number }
  | { name: "error"; code: ScanErrorCode; recoverable: boolean }
  | { name: "cancel"; reason: ScanCancelReason; pages: number };

export type ScanStep = "capture" | "corners" | "review" | "build";

export type ScanQuality = "sharp" | "blurred" | "small_text" | "unchecked";

/**
 * `"user"` — somebody pressed the library's own back or close control, or
 * Escape. Never final: the flow keeps working if the host does not close it.
 * `"error"` — an unrecoverable error ended the session; an `error` event came first.
 */
export type ScanCancelReason = "user" | "error";

/** Which sources of pages the library offers. */
export interface ScanIntake {
  /** The live camera. Default true. Falls back to `images` where there is none. */
  camera?: boolean;
  /** Picking image files, and dropping them. Default true. */
  images?: boolean;
  /**
   * Importing an existing PDF by rasterising its pages. Default **false**.
   *
   * It pulls in the pdf.js runtime (about 4 MB under `assetBaseUrl`) and it is
   * lossy: a PDF that goes in as text comes out as pictures of text. Enable it
   * only where the host cannot accept a PDF any other way.
   */
  pdf?: boolean;
}

export interface ScanResult {
  /** The finished PDF. Its `name` is `defaultFileName` verbatim, or the composed default. */
  file: File;
  pageCount: number;
  /** Exactly `file.size`, repeated here so a host need not reach into the File. */
  bytes: number;
}

export interface ScanFlowProps {
  /**
   * Where `scan-copy-assets` put this package's runtime files, as a URL the host
   * serves same-origin — `"/scan-assets"`, or an absolute URL on the same origin.
   *
   * Required, and deliberately so. The corner-detection model and the ONNX
   * Runtime locate their own files through a string base at runtime, which no
   * bundler can rewrite. The upstream default is a CDN; passing this is what
   * keeps a third party from learning that somebody opened a medical document.
   */
  assetBaseUrl: string;

  /** Default `"pt-BR"`. */
  lang?: ScanLang;

  /** How many pages one document may hold. Default 20. */
  maxPages?: number;

  /**
   * A hard ceiling on the finished PDF, in bytes.
   *
   * The build steps quality down a fixed ladder until the exact size fits, and
   * refuses rather than exceed it: `onComplete` never fires above this number.
   * Pass the same limit your upload path enforces, so a person cannot spend ten
   * minutes scanning and then be told the file is too large.
   */
  maxBytes?: number;

  /**
   * The name of the finished file, used **verbatim** — no stamp, no slug, no
   * extension added.
   *
   * When set, the flow shows no way to name the document: no marking chips,
   * no free-text field. The PDF's `/Title` is this name without a trailing
   * `.pdf`.
   *
   * When absent, the flow composes `<yyyymmdd>-<hhmm>_<marking>.pdf` from the
   * moment the scan began and the marking picked on the last step ("exame",
   * "receita"…, or a short text typed behind "outro"), slugged to lowercase
   * unaccented letters, digits and hyphens. `/Title` is then that file name
   * without `.pdf` — typed text never reaches the metadata verbatim.
   *
   * Keep personal data out of it. File names travel through query strings, proxy
   * logs and e-mail subjects, and this one is chosen before anybody has read the
   * document. A host that must not receive typed text at all should pass this.
   */
  defaultFileName?: string;

  /** Which sources are offered. Defaults: camera on, images on, pdf off. */
  intake?: ScanIntake;

  /**
   * Fires at most once per mounted instance, after the PDF exists. Final: after
   * it, the flow's controls no longer navigate or cancel.
   */
  onComplete(result: ScanResult): void;

  /**
   * A *request* to close, never an announcement that the library has closed.
   *
   * The library does not unmount itself: the host owns the dialog, the history
   * entry and the "discard these pages?" question. Ignore this callback and the
   * flow simply stays where it is — fully working.
   *
   * `"user"` never ends the flow: a host that answers "keep scanning" gets a
   * scanner that still navigates, still completes, and fires `"user"` again on
   * the next close request. Only a second request inside the same double tap
   * (under ~400 ms) is swallowed. `"error"` is final: it fires once, after the
   * `error` event, and nothing fires after it.
   */
  onCancel(reason: ScanCancelReason): void;

  /**
   * How many pages are held right now, on every change.
   *
   * This is what a host watches to know whether closing would lose work. There
   * is no way to ask the library after the fact, on purpose: a host that tracks
   * the count cannot race it.
   */
  onPagesChange?(count: number): void;

  /** Every internal event. Numbers and enums only. */
  onEvent?(event: ScanEvent): void;

  /**
   * **Experimental.** A field-test instrument: what the capture loop is doing
   * on this device, as {@link ScanDiagnosticsEvent}s — timings, counts,
   * enums, sizes and normalised geometry. Never pixels, thumbnails, crops,
   * image hashes, text read from a page or file names.
   *
   * The library only calls this. It never sends, stores or buffers an event:
   * whether one goes anywhere, and where, is the host's decision — and so is
   * the lawful basis for it (LGPD) when a person is holding a medical
   * document in front of the camera. Absent (the default), nothing is built
   * and nothing is measured for it. Pass samples are limited to two a second.
   * Its shape may change in any release; `v` says which one an event has.
   */
  onDiagnostics?(event: ScanDiagnosticsEvent): void;

  /** Applied to the library's root element, for layout only. */
  className?: string;

  /**
   * **Experimental.** Whether the capture screen offers the auto-capture
   * toggle (on `rail`, the default layout, the MANUAL · AUTOMÁTICO (BETA)
   * rail over the shutter).
   *
   *  - omitted — the layout decides: `"rail"` (the default), `"onehand"` and
   *    `"collapse"` show the toggle; `"standard"` does not;
   *  - `false` — no toggle on any layout: the photo is only ever taken by a
   *    tap. The escape hatch for a host whose people cannot be expected to
   *    look at the confirm screen;
   *  - `true`  — shows it on `"standard"` too.
   *
   * `"classic"` and `"filmstrip"` never show it. Wherever it is shown it is
   * OFF at the start of every flow and the choice is never stored; switched
   * on, the screen takes the page by itself once it has been framed, sharp and
   * still for about half a second (with a countdown on the corner brackets),
   * once per page, through the same capture and confirm-corners screen as a
   * tap. The shutter works in both modes. Retakes stay manual.
   *
   * Experimental because it has not yet met its own bar: on the bench it
   * still fires on some page-less scenes (a woven white place mat, a screen
   * showing a page, two overlapping sheets taken as one) — see the
   * README's "Auto-capture" notes.
   */
  experimentalAutoCapture?: boolean;

  /**
   * A small diagnostics HUD over the viewfinder, for testing on a real
   * phone: the detection lane, detection time and cadence, frame age, the
   * stream and photo sizes, the part of the frame the person can see and the
   * layout's fit, torch and vibration support, the ready cue and
   * auto-capture's state. Default `false`. It stores nothing, sends nothing
   * and reads no pixels. Experimental: its content may change in any release.
   */
  experimentalDiagnostics?: boolean;

  /**
   * The capture screen's layout (step 1). Default `"rail"`.
   *
   * Every layout is the same capture stage — the same detection, hints,
   * ready cue on the corner brackets, torch, confirm-corners screen after
   * every photo, and a shutter that works in every state — under different
   * controls:
   *
   *  - `"rail"`      — the default: full-bleed camera, a MANUAL · AUTOMÁTICO
   *                    mode rail over the shutter, "Já tenho a foto" under it;
   *  - `"standard"`  — the screen that shipped before `"rail"`: header,
   *                    viewfinder card, thumbnail rail, control row
   *                    (`"default"` is its deprecated old name);
   *
   * and, **experimental** (may change or go away in any release):
   *
   *  - `"classic"`   — full-bleed camera, a translucent bottom bar;
   *  - `"filmstrip"` — the camera on top, the pages taken as a strip under it;
   *  - `"onehand"`   — no bars, the controls down the right edge;
   *  - `"collapse"`  — like `"classic"`, folding into one capsule while the
   *                    page is ready.
   *
   * Whether the auto-capture toggle shows is `experimentalAutoCapture`'s
   * rule. `"rail"` and `"standard"` have the in-camera "Já tenho a foto"
   * picker (when `intake.images` is on); the experimental layouts do not. An
   * unknown value falls back to `"rail"`.
   */
  captureLayout?: ScanCaptureLayout;

  /**
   * @deprecated Use {@link ScanFlowProps.captureLayout} — the same values.
   * Read only when `captureLayout` is absent.
   */
  experimentalCaptureLayout?: ScanCaptureLayout;
}

/**
 * See {@link ScanFlowProps.captureLayout}. `"default"` is a deprecated alias
 * of `"standard"`.
 */
export type ScanCaptureLayout =
  | "rail"
  | "standard"
  | "classic"
  | "filmstrip"
  | "onehand"
  | "collapse"
  | "default";

/** The schema version every {@link ScanDiagnosticsEvent} carries as `v`. */
export type ScanDiagnosticsVersion = 1;

/** A size in pixels. */
export interface ScanDiagnosticsSize {
  width: number;
  height: number;
}

/**
 * One diagnostics event (`onDiagnostics`, experimental). Every event has the
 * schema version `v`, a sequence number `seq` (per mounted flow, from 0) and
 * `t`, milliseconds since the flow mounted. The rest depends on `type`.
 * Numbers, booleans, enums, library-made reason strings and fractions of a
 * frame only — see {@link ScanFlowProps.onDiagnostics}.
 */
export type ScanDiagnosticsEvent = { v: ScanDiagnosticsVersion; seq: number; t: number } & ScanDiagnosticsPayload;

/** {@link ScanDiagnosticsEvent} without its envelope. */
export type ScanDiagnosticsPayload =
  /** The flow mounted. No user agent: a host that wants one has it already. */
  | {
      type: "session-start";
      layout: string;
      autoOffered: boolean;
      lang: ScanLang;
      /** CSS pixels. */
      viewport: ScanDiagnosticsSize;
      dpr: number;
      /** CSS pixels (`env(safe-area-inset-*)`). */
      safeArea: { top: number; right: number; bottom: number; left: number };
      vibrate: boolean;
    }
  /** The camera came up for a capture screen (`live`), or could not (`unavailable`), or its track ended (`lost`). */
  | {
      type: "camera";
      state: "live" | "unavailable" | "lost";
      /** From asking for the camera to a playing preview. */
      startMs: number | null;
      stream: ScanDiagnosticsSize | null;
      torch: boolean;
      fit: string;
    }
  /** The detection lane was decided or moved; `reason` is `worker` or why not. */
  | { type: "lane"; lane: "worker" | "main" | null; reason: string | null }
  /** The live loop, sampled at most twice a second. */
  | {
      type: "pass";
      detector: "classical" | "ml";
      detectMs: number | null;
      detectP50: number | null;
      /** The loop's interval between passes (its cadence). */
      intervalMs: number;
      frameAgeMs: number | null;
      /** Passes since the previous sample. */
      passes: number;
      found: boolean;
      locked: boolean;
      ready: boolean;
      autoArmed: boolean;
      /** The first thing keeping the ready cue off or auto-capture from firing (the HUD's "why:"). */
      why: string | null;
      /** The newest pass's detector confidence; null when it answered no quad. */
      conf?: number | null;
      /** Why the loop turned the newest pass's quad away (`floor`, `superseded`, `classical-sanity`, `ml-ready`); null when taken or none. */
      rejected?: string | null;
      /** The newest pass's paper evidence verdict on its quad; null when not read. */
      paper?: boolean | null;
      /** How much of the visible region the page fills (as for `hint`); null with no page. */
      fill?: number | null;
    }
  /** The part of the frame the person can see changed (fractions of the frame). */
  | { type: "visible"; x: number; y: number; width: number; height: number; fit: string }
  /**
   * A hint appeared, or went away after `ms`. `fill`: how much of the visible
   * region the page filled along its limiting axis at that moment (0–1; null
   * with no page) — what "Aproxime" is judged on.
   */
  | { type: "hint"; id: string; shown: boolean; ms: number | null; fill: number | null }
  /** The ready cue came on, or went off after `ms` (with why, when it is known); `fill` as for `hint`. */
  | { type: "ready"; on: boolean; ms: number | null; why: string | null; fill: number | null }
  /**
   * Auto-capture: its countdown started, was cancelled (`reason`; `ms` into
   * it), fired (`ms` since the page was steady and ready), or re-armed for
   * another page.
   */
  | { type: "auto"; phase: "countdown" | "cancel" | "fire" | "rearmed"; ms: number | null; reason: string | null }
  /** A photo was taken and handed to the confirm screen. */
  | {
      type: "capture";
      trigger: "manual" | "auto";
      /** What was tapped: the shutter or the frame; null for auto. */
      tap: "shutter" | "frame" | null;
      page: number;
      /** From the tap to the confirm screen's hand-off. */
      ms: number;
      /** The camera's still photo as it arrived (upright, before any crop), when one arrived. */
      still: ScanDiagnosticsSize | null;
      /** What became the page: the still photo or the preview frame. */
      source: "still" | "preview";
      /**
       * Why the still did not become the page — `unsupported` (no
       * ImageCapture: Safari, Firefox), `no-track`, `gave-up` (two failed
       * stills this session), `busy`, `construct-failed`, `timeout`,
       * `take-failed`, `decode-failed`, `alloc-failed`, `aspect-mismatch`,
       * `orientation-mismatch` — or null when it did.
       */
      stillReason: string | null;
      /** How long the still attempt took; null when none was made. */
      stillMs: number | null;
      /** What `takePhoto` was asked for (sensor orientation); null when it was not asked for a size. */
      requested: ScanDiagnosticsSize | null;
      /** The camera stream at the tap (the preview frame's size). */
      stream: ScanDiagnosticsSize;
      /** The live stream was capped (`stream-cap`) at the tap. */
      streamCapped: boolean;
      /**
       * A still failed on a capped stream: whether the native stream came back
       * for the page (`ok`) or the capped frame was used and the page flagged
       * `low-resolution` (`timeout`, `failed`); null when nothing was restored.
       */
      restore: "ok" | "timeout" | "failed" | null;
      /** The part of the still that is the preview's field of view (a pixel-exact cut), when the still became the page. */
      fov: ScanDiagnosticsSize | null;
      /** The canvas that became the page — the page's source pixels. */
      frame: ScanDiagnosticsSize;
      /** True only when the browser's canvas limit made `frame` smaller than its source. */
      capped: boolean;
      /** The page's canonical JPEG: its pixels, bytes and quality. */
      canonical: { width: number; height: number; bytes: number; quality: number };
      cornersFrom: "live" | "detected" | "fallback" | null;
      registration: { fovScale: number; shiftX: number; shiftY: number; score: number; overlap: number } | null;
      /** Why the photo's own check asked for a closer look, or null. */
      flag: "no-page" | "corner-outside" | "moved" | "unverified" | "low-resolution" | null;
    }
  /**
   * The confirm-corners screen was answered: kept as seeded (`accepted`),
   * corners moved (`adjusted`, the largest move as % of the photo's
   * diagonal), `retake`, or the whole photo.
   */
  | {
      type: "confirm";
      page: number;
      result: "accepted" | "adjusted" | "retake" | "whole-photo";
      maxMovePct: number | null;
      /** From the screen opening to the answer. */
      ms: number;
      seededFrom: "capture" | "detected" | "editor-default" | null;
      flag: "no-page" | "corner-outside" | "moved" | "unverified" | "low-resolution" | null;
      /** Where the page's pixels came from; null when unknown (a PDF import). */
      source: "still" | "preview" | "file" | null;
      /** The page's canonical JPEG being confirmed: pixels, bytes, quality. */
      canonical: { width: number; height: number; bytes: number; quality: number } | null;
      /** True only when the browser's canvas limit made the canonical smaller than its source. */
      capped: boolean | null;
    }
  /**
   * A page's pixels were rendered from its canonical (after the capture, and
   * after every edit — each edit re-renders from the canonical, never from an
   * earlier render): the geometry's output and the final JPEG.
   */
  | {
      type: "render";
      page: number;
      /** The page region at its true pixel size in the canonical (before the turn). */
      warped: ScanDiagnosticsSize;
      /** The final JPEG — what the review shows and the PDF embeds. */
      final: { width: number; height: number; bytes: number; quality: number };
      /** True when the corners could not be applied and the frame went in whole. */
      flat: boolean;
      dewarped: boolean;
    }
  /** One page of a finished PDF: the image embedded for it (one per page, after the build). */
  | {
      type: "build";
      page: number;
      pages: number;
      width: number;
      height: number;
      bytes: number;
      /** The size-ladder rung that shipped (0 = the reviewed bytes, embedded as they are). */
      rung: number;
      quality: number;
      /** True only when the size ladder resampled the page below its reviewed size. */
      resampled: boolean;
    }
  /**
   * The live preview stream's cap (Android Chrome only, while the still
   * pipeline is proven): whether it is capped now, and why or why not —
   * `disabled` (the cap is off on every device — the default), `still-proven` (capped), `not-android`, `no-image-capture`,
   * `still-unproven`, `still-failed`, `stream-small`, `constraints-failed`.
   * Emitted when the camera comes up and whenever the cap changes.
   */
  | { type: "stream-cap"; applied: boolean; reason: string; stream: ScanDiagnosticsSize | null }
  /** The page was hidden or shown (locked phone, app switch). */
  | { type: "visibility"; state: "hidden" | "visible" }
  /** The first live pass after the page came back into view. */
  | { type: "camera-resume"; ms: number }
  /** The live loop stopped answering (`start`, after `ms` without a pass) and came back (`end`, `ms` in all). */
  | { type: "stall"; phase: "start" | "end"; ms: number }
  /**
   * A page was removed, brought back by the editor's undo, or replaced by a
   * retake, after it was taken (1-based). A removal is reported when the bin
   * is tapped; an `undone` for the same page means it never left.
   */
  | { type: "page"; action: "removed" | "undone" | "retaken"; page: number }
  | { type: "torch"; on: boolean }
  /** The MANUAL · AUTOMÁTICO toggle changed. */
  | { type: "auto-toggle"; on: boolean }
  /** A {@link ScanEvent}, as `onEvent` receives it (page removed or retaken, steps, errors…). */
  | { type: "flow"; event: ScanEvent };
