import assert from "node:assert/strict";
import test from "node:test";

import { importPhotos, plannedIntake, type PhotoImportTarget } from "./photo-import.ts";
import { isHeicFile, type IntakeDecoders } from "./desktop-intake.ts";
import type { Capture } from "./capture-intake.ts";
import { ImagePrepError } from "./image-error.ts";
import { assetUrls } from "@/lib/runtime-config";

/**
 * Several photos at once on the phone (`initialImages`, a multi-pick): the
 * bookkeeping the review step reports — order, the cap, refusals one by one,
 * and the "none of them opened" case — with the decoder faked. The decode
 * itself is `captureFromFile`, tested where it lives.
 */

const TEST_ASSETS = assetUrls("/scan-assets");

function photo(name: string, type = "image/jpeg"): File {
  return new File([new Uint8Array(16)], name, { type });
}

/** A capture that remembers which file it came from, so order is checkable. */
function captureOf(file: File): Capture {
  return {
    canonical: new Blob([file.name], { type: "image/jpeg" }),
    corners: null,
    gate: null,
    path: "gallery",
  };
}

interface Doc {
  target: PhotoImportTarget;
  pages: string[];
}

/** A document already holding `existing` pages, capped at `maxPages`. */
function doc(maxPages: number, existing = 0): Doc {
  const pages: string[] = Array.from({ length: existing }, (_, i) => `old${i}`);
  return {
    pages,
    target: {
      maxPages,
      pageCount: () => pages.length,
      add: (capture) => {
        if (pages.length >= maxPages) return null;
        void capture;
        pages.push("page");
        return `id${pages.length}`;
      },
    },
  };
}

function decoders(image: (file: File) => Promise<Capture>): IntakeDecoders {
  return {
    image,
    pdf: async () => {
      throw new Error("pdf.js must never be reached from a photo import");
    },
  };
}

test("the plan is known before a byte is decoded", () => {
  assert.deepEqual(plannedIntake(3, 0, 20), { fits: 3, overflow: 0 });
  assert.deepEqual(plannedIntake(4, 1, 3), { fits: 2, overflow: 2 });
  assert.deepEqual(plannedIntake(5, 3, 3), { fits: 0, overflow: 5 });
  // A document already over its cap (a host lowered maxPages) is simply full.
  assert.deepEqual(plannedIntake(2, 9, 3), { fits: 0, overflow: 2 });
});

test("pages land in the array's order, one at a time, each reported", async () => {
  const files = [photo("c.jpg"), photo("a.jpg"), photo("b.jpg")];
  const order: string[] = [];
  const pageNumbers: number[] = [];
  const progress: number[] = [];
  let open = 0;
  const document = doc(20);
  const report = await importPhotos(files, document.target, {
    assets: TEST_ASSETS,
    decoders: decoders(async (file) => {
      open += 1;
      assert.equal(open, 1, "two photos were being decoded at once");
      await Promise.resolve();
      open -= 1;
      order.push(file.name);
      return captureOf(file);
    }),
    onPage: (page) => pageNumbers.push(page),
    onProgress: ({ settled }) => progress.push(settled),
  });
  // Never re-sorted by name: the host's (or the person's) order is the intent.
  assert.deepEqual(order, ["c.jpg", "a.jpg", "b.jpg"]);
  assert.deepEqual(pageNumbers, [1, 2, 3]);
  assert.deepEqual(progress, [1, 2, 3]);
  assert.deepEqual(report, { total: 3, added: 3, refused: [], overflow: 0 });
});

test("photos past the cap are counted as left out, never decoded", async () => {
  const decoded: string[] = [];
  const document = doc(3, 1);
  const report = await importPhotos(
    [photo("1.jpg"), photo("2.jpg"), photo("3.jpg"), photo("4.jpg")],
    document.target,
    {
      assets: TEST_ASSETS,
      decoders: decoders(async (file) => {
        decoded.push(file.name);
        return captureOf(file);
      }),
    },
  );
  assert.deepEqual(decoded, ["1.jpg", "2.jpg"]);
  assert.equal(document.pages.length, 3);
  assert.deepEqual(report, { total: 4, added: 2, refused: [], overflow: 2 });
});

test("when every photo fails, nothing is added and each reason is kept", async () => {
  const report = await importPhotos(
    [photo("a.jpg"), photo("b.png", "image/png")],
    doc(20).target,
    {
      assets: TEST_ASSETS,
      decoders: decoders(async () => {
        throw new ImagePrepError("prep");
      }),
    },
  );
  assert.equal(report.added, 0);
  assert.deepEqual(report.refused, ["prep", "prep"]);
  assert.equal(report.overflow, 0);
});

test("one bad photo costs one page, and a HEIC says it is the format", async () => {
  const document = doc(20);
  const report = await importPhotos(
    [
      photo("ok-1.jpg"),
      photo("broken.webp", "image/webp"),
      // Several browsers hand a HEIC over with no MIME type at all.
      photo("IMG_0001.HEIC", ""),
      photo("ok-2.jpg"),
      photo("laudo.pdf", "application/pdf"),
    ],
    document.target,
    {
      assets: TEST_ASSETS,
      decoders: decoders(async (file) => {
        if (file.name === "broken.webp") throw new ImagePrepError("unsupported");
        if (file.name.endsWith(".HEIC")) throw new ImagePrepError("unsupported");
        return captureOf(file);
      }),
    },
  );
  assert.equal(report.added, 2);
  // In the files' order, whatever order the loop met them in (the PDF is
  // refused before the loop starts).
  assert.deepEqual(report.refused, ["unsupported", "heic", "unsupported"]);
  assert.equal(report.overflow, 0);
  assert.equal(document.pages.length, 2);
});

test("a run abandoned mid-decode adds nothing more and reports no overflow", async () => {
  let gone = false;
  const document = doc(20);
  const report = await importPhotos([photo("a.jpg"), photo("b.jpg")], document.target, {
    assets: TEST_ASSETS,
    cancelled: () => gone,
    decoders: decoders(async (file) => {
      gone = true; // the flow unmounted while this photo was being read
      return captureOf(file);
    }),
  });
  assert.equal(document.pages.length, 0);
  assert.equal(report.added, 0);
  assert.equal(report.overflow, 0);
});

test("HEIC is recognised by type or by extension", () => {
  assert.equal(isHeicFile(photo("x.heic", "image/heic")), true);
  assert.equal(isHeicFile(photo("x.bin", "image/heif")), true);
  assert.equal(isHeicFile(photo("IMG_1.HEIF", "")), true);
  assert.equal(isHeicFile(photo("x.jpg")), false);
});
