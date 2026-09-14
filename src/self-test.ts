/**
 * Prove, in the host's own browser, that this library can actually reach its
 * runtime files.
 *
 * Why this exists as a public entry point rather than a test: the corner
 * detection model, the ONNX Runtime and the pdf.js runtime are all located at
 * run time by string, inside third-party code. A bundle can be perfectly
 * well-formed and still 404 on one bundler's production build and not another's
 * — which is exactly the kind of failure a postbuild script ends up papering
 * over. Nothing a build can assert catches it. Loading the
 * files, in a browser, does.
 *
 * Hosts can call this once behind a feature flag after wiring `assetBaseUrl` up
 * for the first time, and get a plain answer instead of a mystery 404 in
 * somebody's console three weeks later. This library's own consumer smoke tests
 * call it for both a Vite and a Next static-export consumer.
 *
 * It fetches nothing but this library's own assets, writes nothing, and keeps
 * no state beyond what warming the model already keeps.
 */

import { encodeSurface } from "@/lib/encode";
import { assetUrls } from "@/lib/runtime-config";
import { isMlDisabled, warmUpMl } from "@/lib/ml-detection";

export interface SelfTestOptions {
  /** The same value you pass to `<ScanFlow assetBaseUrl>`. */
  assetBaseUrl: string;
  /**
   * A picture to run through the pipeline. Provide one that looks like a
   * document on a contrasting ground; a blank canvas exercises the runtime but
   * tells you nothing about detection.
   *
   * Defaults to a small drawn placeholder. Never provide a real document: this
   * is a wiring check, and the image is decoded and re-encoded like any page.
   */
  canvas?: HTMLCanvasElement;
  /**
   * Also load the pdf.js runtime. Off by default, matching `intake.pdf`: a host
   * that does not offer PDF import has no reason to fetch ~4 MB to check it.
   */
  includePdfImport?: boolean;
}

export interface SelfTestResult {
  /** The corner-detection model loaded, compiled and answered once. */
  mlReady: boolean;
  /** A PDF was assembled from the canvas. Its exact size in bytes. */
  pdfBytes: number;
  pages: number;
  /** The pdf.js runtime resolved its worker and fonts. Null when not requested. */
  pdfImportReady: boolean | null;
  /** How long the whole check took, in milliseconds. */
  ms: number;
}

/** A document-shaped picture, drawn rather than photographed. */
function placeholderCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 620;
  canvas.height = 877;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("this browser gave no 2D canvas context");
  context.fillStyle = "#23281f";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#f4f1e8";
  context.fillRect(36, 36, canvas.width - 72, canvas.height - 72);
  context.fillStyle = "#2f3630";
  for (let y = 90, row = 0; y < canvas.height - 90; y += 26, row += 1) {
    const width = (canvas.width - 144) * (row % 7 === 6 ? 0.55 : 1);
    context.fillRect(72, y, width, 4);
  }
  return canvas;
}

export async function selfTest(options: SelfTestOptions): Promise<SelfTestResult> {
  const startedAt = performance.now();
  const urls = assetUrls(options.assetBaseUrl);
  const canvas = options.canvas ?? placeholderCanvas();

  // 1. The model, the ONNX Runtime and its WebAssembly — three files, all
  //    located by a string base that no bundler rewrote.
  const mlReady = await warmUpMl(urls);

  // 2. The PDF writer. Imported the way the flow imports it, so a chunk that
  //    fails to resolve fails here rather than after somebody has photographed
  //    twenty pages.
  const { buildPdf } = await import("@/lib/pdf");
  // Through the library's one encoder, like every other page: a second place
  // that writes a JPEG is a second quality table nobody is counting.
  const jpeg = await encodeSurface(canvas, "final");
  const built = await buildPdf([
    { jpeg, transform: { finish: "original", rotation: 0, dewarped: false } },
  ]);
  if (!built.ok) {
    throw new Error(`the PDF writer refused a single page: ${built.reason}`);
  }

  // 3. pdf.js, only if this host offers PDF import.
  let pdfImportReady: boolean | null = null;
  if (options.includePdfImport === true) {
    const { loadPdfjs } = await import("@/lib/pdf-import");
    await loadPdfjs(urls);
    pdfImportReady = true;
  }

  return {
    mlReady: mlReady && !isMlDisabled(),
    pdfBytes: built.bytes,
    pages: built.pageCount,
    pdfImportReady,
    ms: Math.round(performance.now() - startedAt),
  };
}
