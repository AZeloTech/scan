"use client";

/**
 * PDF assembly, in the browser.
 *
 * The geometry is deliberately img2pdf's: **each page is exactly the size of
 * its image in pixels**, with the JPEG drawn edge to edge. On the first rung of
 * the size ladder the page's `final` JPEG is embedded as-is — `embedJpg` copies
 * the compressed stream straight into the file — so nothing is recompressed and
 * a 12-page document costs what its 12 photos cost.
 *
 * There is no text layer. OCR is not part of this library: the
 * `words`/`searchable` path, `drawTextLayer` and the embedded Helvetica are
 * deleted rather than disabled, and the tarball guard fails the build if the
 * OCR engine's name survives anywhere in the built output. A future
 * `@azelotech/scan-ocr` would consume the finished PDF rather than the pages.
 *
 * Two promises this file is the last place to keep:
 *
 *  * **Nothing about the device goes in.** Producer and Creator name the
 *    library and its version and nothing else; the Subject lists transforms;
 *    the dates are UTC. No user-agent, no locale, no location.
 *  * **No EXIF reaches the file.** Every page is canvas-produced upstream,
 *    which strips it — but this file does not *trust* that, because it is the
 *    last gate before bytes become a document somebody forwards. See
 *    {@link stripJpegMetadata}.
 */

import { PDFDocument } from "pdf-lib";
import {
  honestySubject,
  type PageTransform,
  type SizeLadderRecord,
} from "@/lib/honesty";
import { encodeSurface } from "@/lib/encode";

export interface PdfPageInput {
  /**
   * The page's `final` blob — the exact bytes the review screen displayed.
   * Embedded without recompression on rung 0, so what was reviewed is what
   * ships.
   */
  jpeg: Blob;
  /** What was actually done to this page, for the `/Subject` record. */
  transform: PageTransform;
}

/** What the document is called when the user did not name it. */
const DEFAULT_TITLE = "Documento escaneado";

/**
 * The library's version, in `/Producer` and `/Creator`.
 *
 * Written out rather than imported from `package.json`, and that is a decision
 * with two halves. Importing the manifest drags a JSON module into every
 * bundler's graph and into the SSR path, for one string; and the value belongs
 * in the source anyway, because it is the number somebody reading a PDF's
 * properties panel in three years uses to find out which build made their file.
 */
export const SCAN_VERSION = "0.1.0";

/**
 * What made the file.
 *
 * Every viewer, file manager and inspector reads these two fields, so this is
 * the one place the library introduces itself to somebody who was not there
 * when it ran. It names a package that can be looked up and a version that can
 * be pinned — and nothing else. A product name — "Scan. by AZelo." — would
 * name a product rather than an artefact, which is useless in a file whose
 * maker is a dependency inside somebody else's site.
 */
export const PRODUCER = `@azelotech/scan ${SCAN_VERSION}`;

// ── the size ladder ────────────────────────────────────────────────────────

/** One rung: what quality, and what long edge, to re-encode every page at. */
export interface SizeRung {
  quality: number;
  longEdge: number;
}

/**
 * The ladder, walked in order until the **exact** saved size fits `maxBytes`.
 *
 * Quality first, then resolution. That order is the point of the thing: a photo
 * of a printed sheet loses far less that a reader can name to q75 than it does
 * to a third of its pixels, and the document exists so that small print stays
 * legible. Only when quality has run out — q65 is already where JPEG ringing
 * starts to show on serif text — does the ladder begin throwing pixels away,
 * and it stops at 2000 px on the long edge because below that an A4 page's body
 * text drops under the cap height the capture gate measures for.
 *
 * Rung 0 is not an encode: the pages already **are** q85 at ≤3000 px (that is
 * what `lib/encode.ts` writes for the `final` role), so the first attempt
 * embeds exactly the bytes the review screen showed. Every later rung goes back
 * through that same encoder rather than a second one, so a document that had to
 * step down is still a document this library's one quality table produced.
 */
export const SIZE_LADDER: readonly SizeRung[] = [
  { quality: 0.85, longEdge: 3000 },
  { quality: 0.75, longEdge: 3000 },
  { quality: 0.65, longEdge: 3000 },
  { quality: 0.75, longEdge: 2400 },
  { quality: 0.75, longEdge: 2000 },
];

/**
 * A page re-encoded for one rung of the ladder.
 *
 * Injectable because the real implementation needs a canvas and the tests do
 * not have one: the seam is what lets the ladder's *shape* be asserted — that
 * it stops at the first rung that fits, that it measures the saved file rather
 * than estimating it, that it refuses rather than overshooting — without a
 * browser. The default is the real thing, so no caller has to know.
 */
export type Reencode = (jpeg: Blob, rung: SizeRung) => Promise<Blob>;

/**
 * The real re-encode: decode, resample to the rung's long edge, encode through
 * `lib/encode.ts`.
 *
 * Every pixel therefore makes the round trip through a canvas, which is the
 * belt to {@link stripJpegMetadata}'s braces: a rung above 0 cannot carry an
 * input's metadata even in principle.
 */
export async function reencodeThroughCanvas(
  jpeg: Blob,
  rung: SizeRung,
): Promise<Blob> {
  const bitmap = await createImageBitmap(jpeg);
  try {
    const longEdge = Math.max(bitmap.width, bitmap.height);
    const scale = longEdge > rung.longEdge ? rung.longEdge / longEdge : 1;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("no 2d context for the size ladder");
    context.drawImage(bitmap, 0, 0, width, height);
    try {
      return await encodeSurface(canvas, "final", rung.quality);
    } finally {
      // Hand the backing store back now: the next rung allocates another one
      // under exactly the memory pressure this page just created.
      canvas.width = 0;
      canvas.height = 0;
    }
  } finally {
    bitmap.close();
  }
}

// ── EXIF ─────────────────────────────────────────────────────────────────────

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const APP0 = 0xe0;

/**
 * Remove every application and comment segment from a JPEG except APP0/JFIF.
 *
 * EXIF is an APP1 segment, and it carries GPS coordinates, the device make and
 * model, serial numbers and the moment the shutter fired. None of that may
 * reach a health document somebody is about to e-mail to a clinic.
 *
 * Upstream, every page is already canvas-produced — the camera frame, the
 * gallery pick and the desktop file all become the page's canonical JPEG
 * through `prepareCapture`, which draws into a canvas and re-encodes, and a
 * canvas has no metadata to write out. So in the shipping flow there is nothing
 * here to remove. This runs anyway, because `buildPdf` is a function with an
 * argument: "no EXIF in the PDF" has to be a property of the code that writes
 * the PDF, not a convention every present and future caller happens to honour.
 * It costs one linear pass over the segment headers and recompresses nothing.
 *
 * APP0 is kept because it is JFIF's density header — geometry rather than
 * provenance — and everything from the start-of-scan marker on is copied
 * verbatim. Anything that does not parse as a JPEG is returned untouched: this
 * is a filter, not a validator, and `embedJpg` is the thing entitled to reject
 * it.
 */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== SOI) return bytes;
  const kept: [number, number][] = [[0, 2]];
  let offset = 2;
  let stripped = false;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return bytes; // not a marker where one must be
    const marker = bytes[offset + 1];
    if (marker === SOS || marker === EOI) {
      kept.push([offset, bytes.length]);
      break;
    }
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (length < 2 || offset + 2 + length > bytes.length) return bytes;
    const isAppOrComment = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
    if (isAppOrComment && marker !== APP0) {
      stripped = true;
    } else {
      kept.push([offset, offset + 2 + length]);
    }
    offset += 2 + length;
  }
  if (!stripped) return bytes;
  const size = kept.reduce((total, [start, end]) => total + (end - start), 0);
  const out = new Uint8Array(size);
  let cursor = 0;
  for (const [start, end] of kept) {
    out.set(bytes.subarray(start, end), cursor);
    cursor += end - start;
  }
  return out;
}

// ── the build ────────────────────────────────────────────────────────────────

/** The document was assembled, and it fits whatever budget it was given. */
export interface PdfBuilt {
  ok: true;
  blob: Blob;
  pageCount: number;
  /** The exact size of the saved file. Never an estimate. */
  bytes: number;
  /** Which rung of {@link SIZE_LADDER} produced it. 0 = exactly as reviewed. */
  rung: number;
}

/**
 * The floor of the ladder still does not fit, so no file was produced.
 *
 * Deliberately data rather than an exception or a message: this module emits
 * nothing and knows no language. `removePages` is what the caller turns into
 * "Remova N páginas"; it is computed from the floor rung's own measured bytes,
 * so it is an answer about a document that really was assembled rather than a
 * guess at a quality nobody tried.
 */
export interface PdfOverBudget {
  ok: false;
  reason: "over_budget";
  /** The floor rung's exact size. */
  bytes: number;
  maxBytes: number;
  pageCount: number;
  /** At least 1, and never the whole document. */
  removePages: number;
}

export type PdfBuildResult = PdfBuilt | PdfOverBudget;

export interface BuildPdfOptions {
  /** Fires after each page is embedded, so a progress bar moves on something real. */
  onPage?: (done: number, total: number) => void;
  /** Fires once per rung attempted, with that rung's exact measured size. */
  onRung?: (rung: number, bytes: number) => void;
  /** `/Title`. The store passes the file name without its extension, never typed text. */
  title?: string | null;
  /** The host's hard ceiling. Absent means the ladder never runs past rung 0. */
  maxBytes?: number;
  /** Test seam; see {@link Reencode}. */
  reencode?: Reencode;
}

/** Assemble the pages of one rung into a finished document. */
async function assemble(
  pages: readonly { jpeg: Blob; transform: PageTransform }[],
  title: string | null,
  ladder: SizeLadderRecord,
  onPage: ((done: number, total: number) => void) | undefined,
): Promise<Blob> {
  const document = await PDFDocument.create();
  const trimmedTitle = (title ?? "").trim();
  document.setTitle(trimmedTitle.length === 0 ? DEFAULT_TITLE : trimmedTitle);
  document.setSubject(
    honestySubject(
      pages.map((input) => input.transform),
      ladder,
    ),
  );
  document.setProducer(PRODUCER);
  document.setCreator(PRODUCER);
  // pdf-lib formats every date as `D:…Z` off the UTC getters, so both dates are
  // UTC with no offset for anybody to read a time zone out of. Setting them
  // from one `Date` keeps them identical.
  const now = new Date();
  document.setCreationDate(now);
  document.setModificationDate(now);

  for (const [index, input] of pages.entries()) {
    const raw = new Uint8Array(await input.jpeg.arrayBuffer());
    const image = await document.embedJpg(stripJpegMetadata(raw));
    const page = document.addPage([image.width, image.height]);
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
    onPage?.(index + 1, pages.length);
  }

  const bytes = await document.save();
  // `save()` returns a Uint8Array over its own buffer; copy the exact view into
  // the Blob so a larger backing ArrayBuffer can never leak into the file.
  return new Blob([bytes.slice()], { type: "application/pdf" });
}

/**
 * Assemble the document, stepping down {@link SIZE_LADDER} until it fits.
 *
 * The pages arrive already upright: rotation is baked into each page's single
 * render (`lib/page-processing.ts`), so nothing in this file ever writes a
 * `/Rotate` entry.
 *
 * Every rung is **measured, not estimated**. The store's `image bytes + 2%`
 * guess is fine for the warning on the review screen and is not fine here,
 * because the promise to the host is that `onComplete` never fires above
 * `maxBytes`, and the only number that can keep it is the length of a file that
 * really was saved. So each rung assembles a whole document and asks it how big
 * it is, and the ladder stops at the first one that fits.
 */
export async function buildPdf(
  pages: readonly PdfPageInput[],
  options: BuildPdfOptions = {},
): Promise<PdfBuildResult> {
  const {
    onPage,
    onRung,
    title = null,
    maxBytes,
    reencode = reencodeThroughCanvas,
  } = options;

  let floor: { bytes: number; rung: number } | null = null;

  for (const [rung, step] of SIZE_LADDER.entries()) {
    const jpegs =
      rung === 0
        ? pages.map((input) => input.jpeg)
        : await Promise.all(pages.map((input) => reencode(input.jpeg, step)));
    const blob = await assemble(
      pages.map((input, index) => ({
        jpeg: jpegs[index],
        transform: input.transform,
      })),
      title,
      { rung, quality: step.quality, longEdge: step.longEdge },
      onPage,
    );
    onRung?.(rung, blob.size);
    floor = { bytes: blob.size, rung };
    if (maxBytes === undefined || blob.size <= maxBytes) {
      return { ok: true, blob, pageCount: pages.length, bytes: blob.size, rung };
    }
  }

  // Unreachable with a non-empty ladder, and `maxBytes` is necessarily set to
  // have got here — but neither fact is in the types.
  if (floor === null) throw new Error("the size ladder has no rungs");
  const budget = maxBytes ?? floor.bytes;
  return {
    ok: false,
    reason: "over_budget",
    bytes: floor.bytes,
    maxBytes: budget,
    pageCount: pages.length,
    removePages: pagesToRemove(floor.bytes, budget, pages.length),
  };
}

/**
 * How many pages have to go for the floor rung to fit.
 *
 * Computed from the floor's own measured bytes: the pages of one document are
 * near enough the same weight that an average is honest, and the alternative is
 * re-assembling the whole document once per candidate count. Always at least 1
 * — a document that overshoots has to lose something — and never the whole
 * document, because "remove all 6 pages" is not an instruction anybody can act
 * on.
 */
function pagesToRemove(bytes: number, maxBytes: number, pageCount: number): number {
  if (pageCount <= 1) return 1;
  const perPage = bytes / pageCount;
  const needed = Math.ceil((bytes - maxBytes) / perPage);
  return Math.min(Math.max(1, needed), pageCount - 1);
}
