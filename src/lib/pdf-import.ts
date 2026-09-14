"use client";

/**
 * Reading a PDF **in**.
 *
 * `lib/pdf.ts` writes PDFs with pdf-lib. This is the other half, and it exists
 * only for the desktop mode: a person at a computer very often
 * already has the exam as a PDF, either because the lab e-mailed one or because
 * a flatbed scanner wrote one, and telling them to photograph their own screen
 * would be absurd.
 *
 * What happens to such a file is deliberately unremarkable: **each PDF page is
 * rasterised into exactly the kind of image the rest of the app already
 * handles** — one JPEG, capped at the same 3000 px long edge every camera frame
 * is capped at, encoded once through `lib/encode.ts` — and from there it is a
 * page like any other. There is no second pipeline, no PDF-passthrough mode and
 * no vector path; a PDF that goes in comes out re-drawn, and the app's single
 * honest claim about fidelity ("one lossy generation from the canonical to the
 * PDF") stays true because the rasterisation *is* that one generation.
 *
 * Three shapes worth naming:
 *
 *  * **The library is lazy.** pdf.js is ~400 kB of parser that a person
 *    photographing a sheet of paper must never download; it arrives on the
 *    first PDF the user actually picks and not before.
 *  * **Every byte is the host's.** `pdfjs-dist` defaults its worker and its
 *    font, cmap and WASM lookups to a CDN. All five are pointed at the host's
 *    own `assetBaseUrl` instead (`lib/runtime-config.ts::pdfjsOptions`), which
 *    is where `scan-copy-assets` put the package's `assets/pdfjs/` tree. This
 *    library never fetches across an origin.
 *  * **No corner detection runs on a rasterised page.** A PDF page is already
 *    a flat rectangle, so it enters with {@link FULL_FRAME_QUAD} — the identity
 *    quad — rather than with `null`, which the page view would report as
 *    "bordas não encontradas" and ask the user to fix something that is not
 *    wrong. The corner editor still works on it afterwards, for the scan that
 *    came out crooked inside its own PDF.
 */

import type { PDFDocumentProxy } from "pdfjs-dist";
import { assessBlob } from "@/lib/capture-gate";
import type { Capture } from "@/lib/capture-intake";
import { encodeCanvas, MAX_LONG_EDGE, releaseCanvas } from "@/lib/image";
import { ImagePrepError } from "@/lib/image-error";
import { FULL_FRAME_QUAD } from "@/lib/quad";
import { pdfjsOptions, type AssetUrls } from "@/lib/runtime-config";

/**
 * The pdfjs-dist version this library's `assets/pdfjs/` tree was built from, as
 * a constant `scripts/build-assets.mjs` checks against the installed package.
 *
 * Stated here rather than read from the package at runtime: the browser bundle
 * cannot import `node_modules/pdfjs-dist/package.json`, and a mismatch between
 * the worker the host serves and the library the page loads is a silent,
 * baffling failure worth catching at build time. It is a *fact about the
 * bytes*, not a URL — where those bytes are served from is the host's
 * `assetBaseUrl`, and nothing here may ever reach for a CDN.
 */
export const PDFJS_VERSION = "5.4.149";

/** How many pages of one PDF this app will take, however long the file is. */
export const MAX_PDF_PAGES = 40;

/** A file the browser will hand us as `application/pdf`, or a `.pdf` by name. */
export function isPdfFile(file: File): boolean {
  return (
    file.type === "application/pdf" || /\.pdf$/i.test(file.name)
  );
}

let libraryPromise: Promise<typeof import("pdfjs-dist")> | null = null;

/**
 * The library, loaded once per tab and configured before anyone sees it.
 *
 * The dynamic `import()` is the laziness: pdf.js never enters the page unless
 * someone actually picks a PDF. The worker URL is set on the module's own
 * global rather than per-document, which is pdf.js's only offer; setting it
 * here, inside the one place that loads the module, means no caller can forget
 * it and silently reintroduce the CDN fetch the host's CSP would block anyway.
 *
 * The URL comes from the caller's {@link AssetUrls}, so it is settled on the
 * first import and not re-read — which is honest, because `GlobalWorkerOptions`
 * is a single global that the second base could only fight over.
 */
/**
 * Exported so a host can prove its asset wiring works before somebody relies on
 * it — see `@azelotech/scan/self-test`. Idempotent and memoised.
 */
export async function loadPdfjs(urls: AssetUrls): Promise<typeof import("pdfjs-dist")> {
  if (libraryPromise === null) {
    libraryPromise = import("pdfjs-dist").then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = urls.pdfWorker;
      return pdfjs;
    });
  }
  return libraryPromise;
}

/**
 * The scale that puts a page's long edge exactly on the cap — always on it,
 * never merely under it.
 *
 * pdf.js measures pages in PDF units at scale 1, which is 72 dpi: an A4 is
 * 595×842 pixels there, and a lab report drawn at that size is unreadable and
 * un-OCR-able. So the scale *reaches* for the cap rather than clamping to it —
 * the page is drawn at the largest size the rest of the app is willing to carry
 * (`MAX_LONG_EDGE`), which for a typical A4 works out around 250 dpi, and no
 * larger, because above that a cheap machine starts failing canvas allocations.
 */
export function rasterScale(width: number, height: number): number {
  const longEdge = Math.max(width, height);
  if (longEdge <= 0) return 1;
  return MAX_LONG_EDGE / longEdge;
}

/** What one PDF turned into, page by page, as the pages become available. */
export interface PdfPageSink {
  /** A rasterised page, ready to become a {@link Capture}. */
  onPage: (capture: Capture) => Promise<void> | void;
  /** Asked before every page: 0 means the document is full, stop here. */
  capacity: () => number;
  /** The user navigated away or cleared the list mid-import. */
  cancelled?: () => boolean;
}

/**
 * Rasterise a PDF, one page at a time, straight into the sink.
 *
 * A sink rather than an array, and a strict one-page-at-a-time loop, for the
 * memory rule this whole app is built around: a 12-page PDF held as twelve
 * 3000 px canvases is 400 MB of backing store, and the reference device has
 * less. Each canvas is released before the next is drawn.
 *
 * Throws {@link ImagePrepError} with `unsupported` for a file pdf.js cannot
 * open at all — encrypted, truncated, not really a PDF — which the caller
 * renders as the same per-file refusal a broken image gets.
 *
 * Answers **whether it stopped because the document filled up**, which the
 * caller cannot work out for itself: a PDF truncated at the cap on its last
 * page still delivered pages, so "did anything arrive" says nothing about
 * whether anything was left behind.
 */
export async function importPdf(
  file: File,
  sink: PdfPageSink,
  urls: AssetUrls,
): Promise<boolean> {
  const pdfjs = await loadPdfjs(urls);
  const bytes = new Uint8Array(await file.arrayBuffer());

  // Kept, rather than reduced straight to its `.promise`: a loading task that
  // rejects has already started a worker, and only the task can stop it. Left
  // to the garbage collector it is a live thread per unreadable PDF, and a
  // folder of e-mailed exams can hold a handful of them.
  const task = pdfjs.getDocument({
    data: bytes,
    // All four of these default to a CDN. Pointed at the host's own tree.
    ...pdfjsOptions(urls),
    // A password-protected PDF is a refusal, not a prompt: this library has no
    // business collecting a password for a document it will not keep.
    password: "",
    // `isEvalSupported` was removed in pdf.js 5 — the font path it guarded no
    // longer evaluates anything, so there is nothing left to switch off. Kept
    // as a note rather than a dangling option so nobody re-adds it.
  });

  let document: PDFDocumentProxy;
  try {
    document = await task.promise;
  } catch {
    await task.destroy().catch(() => undefined);
    throw new ImagePrepError("unsupported");
  }

  try {
    const pageCount = Math.min(document.numPages, MAX_PDF_PAGES);
    for (let number = 1; number <= pageCount; number += 1) {
      if (sink.cancelled?.() === true) return false;
      if (sink.capacity() <= 0) return true;
      const capture = await rasterisePage(document, number);
      // Re-asked after the raster and not only before it: a page takes long
      // enough to draw that "limpar" can land in the middle of one, and a
      // capture committed after that is a page with no row to belong to.
      if (sink.cancelled?.() === true) return false;
      await sink.onPage(capture);
    }
    return false;
  } finally {
    // pdf.js holds a worker and a parsed structure per document; both are the
    // caller's to release and neither is small.
    await document.destroy();
  }
}

async function rasterisePage(
  document: PDFDocumentProxy,
  number: number,
): Promise<Capture> {
  const page = await document.getPage(number);
  try {
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({
      scale: rasterScale(base.width, base.height),
    });
    const canvas = window.document.createElement("canvas");
    try {
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      const context = canvas.getContext("2d");
      if (context === null) throw new ImagePrepError("prep");
      // A PDF page has no background of its own; without this every
      // transparent region renders black and the whole sheet inverts.
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      // The one encode this page ever gets — q92, the same canonical quality a
      // camera frame is written at.
      const canonical = await encodeCanvas(canvas, "canonical");
      const gate = await assessBlob(canonical);
      return {
        canonical,
        // Identity, never null: the page is flat by construction, and `null`
        // would make the app report an edge-detection failure that never
        // happened (the honesty invariant).
        corners: FULL_FRAME_QUAD,
        gate,
        path: "desktop",
      };
    } finally {
      releaseCanvas(canvas);
    }
  } finally {
    page.cleanup();
  }
}
