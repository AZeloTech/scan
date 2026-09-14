import assert from "node:assert/strict";
import test from "node:test";

import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
import {
  PRODUCER,
  SIZE_LADDER,
  buildPdf,
  stripJpegMetadata,
  type PdfBuildResult,
  type SizeRung,
} from "./pdf.ts";
import type { PageTransform } from "./honesty.ts";

/**
 * What the file says about itself, what it refuses to say, and how far it will
 * go to fit a budget.
 *
 * The PDF outlives the tab it was made in — that is the whole point of it — so
 * its metadata is the only place the library can still speak once the scan is
 * gone, and the only place a leak is permanent. Three properties are asserted
 * here and none of them is visible on any screen: **who made it**
 * (`/Producer`, `/Creator`), **what was done to the pages** (`/Subject`,
 * `lib/honesty.ts`), and **what did not come along** — no EXIF, no locale, no
 * device.
 */

/**
 * A 1×1 baseline JPEG, so `embedJpg` has a real stream to copy. Written as
 * base64 because the alternative is a canvas, and there is no canvas here.
 */
const ONE_PIXEL_JPEG =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof" +
  "Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwh" +
  "MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAAR" +
  "CAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAA" +
  "AgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkK" +
  "FhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWG" +
  "h4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl" +
  "5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREA" +
  "AgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYk" +
  "NOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOE" +
  "hYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk" +
  "5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==";

const FLAT: PageTransform = {
  finish: "clean",
  rotation: 0,
  dewarped: false,
};

/**
 * Typed as `Uint8Array<ArrayBuffer>` rather than plain `Uint8Array`: since
 * TypeScript 5.7 the array is generic over its backing buffer, and `BlobPart`
 * accepts only the non-shared one. Copying through a fresh `ArrayBuffer` is
 * what makes that true rather than asserted.
 */
function jpegBytes(): Uint8Array<ArrayBuffer> {
  const source = Buffer.from(ONE_PIXEL_JPEG, "base64");
  const bytes = new Uint8Array(new ArrayBuffer(source.byteLength));
  bytes.set(source);
  return bytes;
}

function onePage(bytes: Uint8Array<ArrayBuffer> = jpegBytes()): Blob {
  return new Blob([bytes], { type: "image/jpeg" });
}

/**
 * The same 1×1 picture, padded after its end-of-image marker so that rung 0 is
 * heavy enough to blow a budget the later rungs can meet.
 *
 * Padding rather than a bigger picture because there is no encoder here: what
 * the ladder cares about is the *size* of the document each rung produces, and
 * a JPEG with trailing bytes is still a JPEG every decoder reads.
 */
function heavyPage(extra: number): Blob {
  return new Blob([jpegBytes(), new Uint8Array(new ArrayBuffer(extra))], { type: "image/jpeg" });
}

/**
 * Splice a segment into a JPEG right after the SOI marker.
 *
 * Handcrafted rather than read from a file, and that is a rule rather than a
 * convenience: no image of a real document — and no photograph at all — enters
 * this repository. An EXIF block is a few dozen bytes of
 * structure, so the fixture that proves EXIF cannot survive is itself written
 * in code, derived from nobody.
 */
function withSegment(
  base: Uint8Array,
  marker: number,
  body: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const length = body.length + 2;
  const out = new Uint8Array(new ArrayBuffer(base.length + 4 + body.length));
  out.set(base.subarray(0, 2), 0);
  out.set([0xff, marker, (length >> 8) & 0xff, length & 0xff], 2);
  out.set(body, 6);
  out.set(base.subarray(2), 6 + body.length);
  return out;
}

/**
 * An APP1 payload a viewer reads as EXIF, carrying a GPS IFD pointer: the
 * `Exif\0\0` header, a little-endian TIFF header and one directory entry.
 * Nothing here parses it — the assertion is that the marker never reaches the
 * PDF at all — but it is well formed so that a change which "keeps EXIF but
 * drops GPS" cannot pass by accident.
 */
function exifPayload(): Uint8Array {
  return Uint8Array.from([
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // "Exif\0\0"
    0x49, 0x49, 0x2a, 0x00, // little-endian TIFF magic
    0x08, 0x00, 0x00, 0x00, // offset of the first IFD
    0x01, 0x00, // one entry
    0x25, 0x88, // tag 0x8825 — the GPSInfo IFD pointer
    0x04, 0x00, // type LONG
    0x01, 0x00, 0x00, 0x00, // one value
    0x1a, 0x00, 0x00, 0x00, // its offset
    0x00, 0x00, 0x00, 0x00, // no next IFD
  ]);
}

function indexOfAscii(haystack: Uint8Array, needle: string): number {
  return Buffer.from(haystack).indexOf(needle, 0, "latin1");
}

/**
 * Read the file back the way a viewer would.
 *
 * The info dictionary goes into a compressed object stream, so grepping the
 * bytes proves nothing — the document has to be parsed. `load` is deliberately
 * told not to touch the metadata it finds, which is what makes the answer the
 * *written* value rather than a fresh one pdf-lib minted on the way in.
 */
async function metadataOf(blob: Blob): Promise<{
  producer: string | undefined;
  creator: string | undefined;
  title: string | undefined;
  subject: string | undefined;
}> {
  const document = await PDFDocument.load(await blob.arrayBuffer(), {
    updateMetadata: false,
  });
  return {
    producer: document.getProducer(),
    creator: document.getCreator(),
    title: document.getTitle(),
    subject: document.getSubject(),
  };
}

/** Narrow a result to the success branch, failing the test if it refused. */
function built(result: PdfBuildResult) {
  assert.ok(result.ok, "the build refused when it was expected to succeed");
  return result;
}

test("the file says it was made by @azelotech/scan, with its version", async () => {
  const result = built(await buildPdf([{ jpeg: onePage(), transform: FLAT }]));
  const metadata = await metadataOf(result.blob);

  assert.equal(result.pageCount, 1);
  assert.equal(metadata.producer, PRODUCER);
  assert.equal(metadata.creator, PRODUCER);
  // A package somebody can look up and a version somebody can pin — and no
  // product name, no host, no device.
  assert.match(metadata.producer ?? "", /^@azelotech\/scan \d+\.\d+\.\d+$/);
});

test("the subject describes the transforms and nothing else", async () => {
  const result = built(
    await buildPdf([{ jpeg: onePage(), transform: FLAT }], { title: "exame" }),
  );
  const metadata = await metadataOf(result.blob);
  const subject = metadata.subject ?? "";

  assert.equal(metadata.title, "exame");
  assert.match(subject, /Transforms: 1 brighten\./);
  // No date in it: `/CreationDate` already records when, in UTC, and a
  // `dd/mm/yyyy` in the Subject is a locale fingerprint.
  assert.doesNotMatch(subject, /\d{2}\/\d{2}\/\d{4}/);
  // No language, no product, no device.
  assert.doesNotMatch(subject, /AZelo|Escanear|gerada|Mozilla|iPhone|Android/i);
});

/**
 * The raw `/CreationDate` string, not the `Date` pdf-lib parses out of it.
 *
 * The info dictionary is written into a compressed object stream, so the bytes
 * cannot be grepped, and `getCreationDate()` has already thrown away the one
 * thing under test — the zone suffix.
 */
async function creationDateString(blob: Blob): Promise<string> {
  const document = await PDFDocument.load(await blob.arrayBuffer(), {
    updateMetadata: false,
  });
  const info = document.context.lookup(
    document.context.trailerInfo.Info,
    PDFDict,
  );
  return info.get(PDFName.of("CreationDate"))?.toString() ?? "";
}

test("the creation date is UTC", async () => {
  const result = built(await buildPdf([{ jpeg: onePage(), transform: FLAT }]));
  const created = await creationDateString(result.blob);
  // pdf-lib writes `D:YYYYMMDDHHmmSSZ`. The `Z` is the assertion: an offset
  // like `-03'00'` would hand every reader the maker's time zone.
  assert.match(created, /^\(D:\d{14}Z\)$/);
});

test("an unnamed document still gets a title", async () => {
  const result = built(await buildPdf([{ jpeg: onePage(), transform: FLAT }]));
  const metadata = await metadataOf(result.blob);

  assert.equal(metadata.title, "Documento escaneado");
});

// ── EXIF ─────────────────────────────────────────────────────────────────────

test("an EXIF block cannot reach the finished PDF", async () => {
  const carrier = withSegment(jpegBytes(), 0xe1, exifPayload());
  // The fixture really does carry it, or the assertion below proves nothing.
  assert.ok(indexOfAscii(carrier, "Exif") >= 0, "the fixture lost its EXIF block");

  const result = built(await buildPdf([{ jpeg: onePage(carrier), transform: FLAT }]));
  const pdf = new Uint8Array(await result.blob.arrayBuffer());

  assert.equal(
    indexOfAscii(pdf, "Exif"),
    -1,
    "an Exif marker survived into the PDF: GPS, device model and shutter time " +
      "travel with it to everybody the file is ever forwarded to",
  );
  // The image still embedded — stripping is not allowed to cost the page.
  assert.equal(result.pageCount, 1);
});

test("a comment segment goes too, and the picture does not", () => {
  const withComment = withSegment(
    jpegBytes(),
    0xfe,
    new Uint8Array(Buffer.from("scanned at home")),
  );
  const stripped = stripJpegMetadata(withComment);

  assert.equal(indexOfAscii(stripped, "scanned at home"), -1);
  // JFIF/APP0 is geometry, and the entropy-coded scan is the picture: both stay.
  assert.ok(indexOfAscii(stripped, "JFIF") >= 0, "APP0/JFIF was thrown away");
  assert.deepEqual(
    stripped.subarray(stripped.length - 2),
    Uint8Array.from([0xff, 0xd9]),
  );
});

test("a JPEG with nothing to strip is handed back untouched", () => {
  const bytes = jpegBytes();
  assert.equal(stripJpegMetadata(bytes), bytes);
});

test("something that is not a JPEG is not mangled", () => {
  const bytes = Uint8Array.from([1, 2, 3, 4]);
  assert.equal(stripJpegMetadata(bytes), bytes);
});

// ── the size ladder ──────────────────────────────────────────────────────────

/**
 * A fake re-encode with the one property the ladder depends on: a rung's output
 * is smaller than the last rung's. It pads the fixture by a per-rung amount,
 * which is what makes "stopped at the first rung that fits" observable without
 * a canvas.
 */
function shrinkingReencode(padding: readonly number[]) {
  const seen: SizeRung[] = [];
  return {
    seen,
    reencode: async (_jpeg: Blob, rung: SizeRung): Promise<Blob> => {
      seen.push(rung);
      const index = SIZE_LADDER.findIndex(
        (step) => step.quality === rung.quality && step.longEdge === rung.longEdge,
      );
      return new Blob([jpegBytes(), new Uint8Array(padding[index])], {
        type: "image/jpeg",
      });
    },
  };
}

test("with no budget the ladder never runs past rung 0", async () => {
  const fake = shrinkingReencode([0, 0, 0, 0, 0]);
  const rungs: number[] = [];
  const result = built(
    await buildPdf([{ jpeg: onePage(), transform: FLAT }], {
      reencode: fake.reencode,
      onRung: (rung) => rungs.push(rung),
    }),
  );

  assert.equal(result.rung, 0);
  assert.deepEqual(rungs, [0]);
  assert.equal(fake.seen.length, 0, "a page was re-encoded for nothing");
});

test("a budget rung 0 already meets is not stepped down", async () => {
  const fake = shrinkingReencode([0, 0, 0, 0, 0]);
  const first = built(await buildPdf([{ jpeg: onePage(), transform: FLAT }]));
  const result = built(
    await buildPdf([{ jpeg: onePage(), transform: FLAT }], {
      maxBytes: first.bytes + 1000,
      reencode: fake.reencode,
    }),
  );

  assert.equal(result.rung, 0);
  assert.equal(fake.seen.length, 0);
});

test("the ladder steps down in order and stops at the first rung that fits", async () => {
  // Rung 0 carries 9 kB of page; rungs 1 and 2 shed some of it and still
  // overshoot; rung 3 is the first that fits.
  const fake = shrinkingReencode([0, 6000, 3000, 0, 0]);
  const base = built(await buildPdf([{ jpeg: onePage(), transform: FLAT }]));
  const rungs: { rung: number; bytes: number }[] = [];

  const result = built(
    await buildPdf([{ jpeg: heavyPage(9000), transform: FLAT }], {
      maxBytes: base.bytes + 1500,
      reencode: fake.reencode,
      onRung: (rung, bytes) => rungs.push({ rung, bytes }),
    }),
  );

  assert.equal(result.rung, 3);
  assert.deepEqual(
    rungs.map((entry) => entry.rung),
    [0, 1, 2, 3],
    "the ladder must try every rung in order, and stop at the first that fits",
  );
  // Each rung reported the exact size of a document that was really saved.
  assert.equal(result.bytes, result.blob.size);
  assert.ok(result.bytes <= base.bytes + 1500);
  // It walked quality before resolution, exactly as SIZE_LADDER declares.
  assert.deepEqual(fake.seen, [SIZE_LADDER[1], SIZE_LADDER[2], SIZE_LADDER[3]]);
});

test("the chosen rung is recorded in the subject", async () => {
  const fake = shrinkingReencode([0, 0, 0, 0, 0]);
  const base = built(await buildPdf([{ jpeg: onePage(), transform: FLAT }]));
  const result = built(
    await buildPdf([{ jpeg: heavyPage(9000), transform: FLAT }], {
      maxBytes: base.bytes + 1500,
      reencode: fake.reencode,
    }),
  );
  const metadata = await metadataOf(result.blob);

  assert.ok(result.rung > 0);
  assert.match(metadata.subject ?? "", /Size ladder: rung 1, q75, long edge 3000px\./);
});

test("when the floor still overshoots, no file is produced", async () => {
  const fake = shrinkingReencode([0, 0, 0, 0, 0]);
  const pages = Array.from({ length: 6 }, () => ({ jpeg: onePage(), transform: FLAT }));
  const rungs: number[] = [];

  const result = await buildPdf(pages, {
    maxBytes: 10,
    reencode: fake.reencode,
    onRung: (rung) => rungs.push(rung),
  });

  assert.ok(!result.ok);
  assert.equal(result.reason, "over_budget");
  assert.equal(result.maxBytes, 10);
  assert.equal(result.pageCount, 6);
  assert.ok(result.bytes > 10);
  // A number the caller can put in a sentence: at least one page, and never all
  // of them, because "remove all 6 pages" is not advice.
  assert.ok(result.removePages >= 1 && result.removePages < 6);
  // Every rung was genuinely attempted before giving up.
  assert.deepEqual(rungs, [0, 1, 2, 3, 4]);
  // And there is no `blob` on this branch at all — the caller cannot ship a
  // file that busts the budget by mistake.
  assert.equal("blob" in result, false);
});

test("a single page that cannot fit still asks for one page to go", async () => {
  const fake = shrinkingReencode([0, 0, 0, 0, 0]);
  const result = await buildPdf([{ jpeg: onePage(), transform: FLAT }], {
    maxBytes: 1,
    reencode: fake.reencode,
  });

  assert.ok(!result.ok);
  assert.equal(result.removePages, 1);
});
