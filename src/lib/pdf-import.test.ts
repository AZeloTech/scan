import assert from "node:assert/strict";
import test from "node:test";

import { MAX_LONG_EDGE } from "./image.ts";
import { isPdfFile, PDFJS_VERSION, rasterScale } from "./pdf-import.ts";
import { assetUrls } from "./runtime-config.ts";

/**
 * The two decisions PDF import makes before pdf.js is even loaded: whether a
 * file is one, and how big to draw it.
 *
 * The rasterisation itself needs a canvas and a worker, so it is verified in the
 * browser against real PDFs; what is checkable here is the arithmetic that
 * decides the resolution — and it matters, because a page drawn at pdf.js's own
 * scale 1 is 72 dpi and unreadable, while one drawn without a cap is the canvas
 * allocation a cheap machine dies on.
 */

test("a PDF is recognised by its type, and by its name when there is none", () => {
  assert.equal(
    isPdfFile(new File([new Uint8Array(4)], "exame.pdf", { type: "application/pdf" })),
    true,
  );
  // Some file managers hand over no MIME type at all.
  assert.equal(isPdfFile(new File([new Uint8Array(4)], "exame.PDF", { type: "" })), true);
  assert.equal(
    isPdfFile(new File([new Uint8Array(4)], "exame.jpg", { type: "image/jpeg" })),
    false,
  );
});

test("a page is drawn up to the same cap every camera frame is capped at", () => {
  // A4 at pdf.js's scale 1 is 595×842 points — the long edge lands exactly on
  // the cap, which is roughly 250 dpi and is the whole point: anything less is
  // an unreadable scan of a readable document.
  const scale = rasterScale(595, 842);
  assert.ok(Math.abs(842 * scale - MAX_LONG_EDGE) < 0.5);
  // Landscape is the same rule read off the other axis.
  assert.equal(rasterScale(842, 595), rasterScale(595, 842));
});

test("a degenerate page is drawn rather than divided by zero", () => {
  assert.equal(rasterScale(0, 0), 1);
});

test("the pdf.js runtime is looked for under the host's own asset base", () => {
  // The version is a fact about the bytes the package ships, checked against
  // the installed dependency by `scripts/build-assets.mjs`.
  assert.match(PDFJS_VERSION, /^\d+\.\d+\.\d+$/);
  // Every URL is the host's. A default that reached for a CDN would be a
  // cross-origin fetch this library is not allowed to make.
  const urls = assetUrls("/scan-assets/");
  assert.equal(urls.pdfWorker, "/scan-assets/pdfjs/pdf.worker.min.mjs");
  assert.ok(urls.pdfjsBase.startsWith("/scan-assets/"));
});
