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

  /** Applied to the library's root element, for layout only. */
  className?: string;
}
