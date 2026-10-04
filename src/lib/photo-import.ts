/**
 * Several photos at once → pages, on the phone.
 *
 * The phone takes one photo per interaction and confirms its corners right
 * after; a person who already holds a handful of photos — handed over by the
 * host (`initialImages`) or picked together from the gallery — wants them in
 * the document, not twelve confirm screens in a row. So this is the desktop
 * pile's runner (`runIntake`) pointed at the phone's store: the same
 * measure-then-detect path per file, the same order, the same cap, the same
 * per-file refusals. What it adds is the one thing the phone screens need and
 * the desktop rows already carry: a **report** — how many came in, which
 * reasons kept the others out, and how many the cap left out — so the review
 * step can say it in one line.
 *
 * Kept free of React and of the store's type so the rules are testable without
 * a DOM, the same way `desktop-intake.ts` is.
 */

import {
  browserDecoders,
  runIntake,
  type IntakeDecoders,
} from "@/lib/desktop-intake";
import type { Capture } from "@/lib/capture-intake";
import { isPdfFile } from "@/lib/pdf-import";
import type { PageErrorCode } from "@/lib/scan-store";
import type { AssetUrls } from "@/lib/runtime-config";

/** The document the photos go into. Implemented by the flow over its store. */
export interface PhotoImportTarget {
  /** Pages already in the document. */
  pageCount: () => number;
  /** The document's cap (`maxPages`). */
  maxPages: number;
  /** Commit one page. Answers its new id, or null if the store refused it. */
  add: (capture: Capture) => string | null;
}

/** How far a run has got. `settled` counts files, whatever became of them. */
export interface PhotoImportProgress {
  total: number;
  settled: number;
  added: number;
}

/** What a finished run did with the photos it was given. */
export interface PhotoImportReport {
  total: number;
  /** Pages that made it into the document. */
  added: number;
  /** One code per refused file, in the files' order. */
  refused: readonly PageErrorCode[];
  /** Files the document had no room for. Never refused silently: the screen says so. */
  overflow: number;
}

/**
 * How many of `count` photos the document can still take.
 *
 * Asked before a single byte is decoded, so the "only the first N fit" line can
 * be on screen while the photos are still being read — not after the person
 * has watched the ones that did not fit disappear.
 */
export function plannedIntake(
  count: number,
  pagesNow: number,
  maxPages: number,
): { fits: number; overflow: number } {
  const room = Math.max(0, maxPages - pagesNow);
  const fits = Math.min(count, room);
  return { fits, overflow: count - fits };
}

export interface PhotoImportOptions {
  assets: AssetUrls;
  /** Defaults to the browser's own decoders with the gallery's capture path. */
  decoders?: IntakeDecoders;
  /** The run was abandoned — the flow unmounted, or a newer run replaced it. */
  cancelled?: () => boolean;
  /** After each file settles. */
  onProgress?: (progress: PhotoImportProgress) => void;
  /** After each page lands, with its 1-based number in the document. */
  onPage?: (pageNumber: number) => void;
}

/**
 * Read the photos into the document, in order, one at a time.
 *
 * Never throws. PDFs are refused (`unsupported`) rather than handed to pdf.js:
 * the phone does not offer PDF intake, and an unexpected 4 MB runtime download
 * is not something a photo pick may trigger.
 */
export async function importPhotos(
  files: readonly File[],
  target: PhotoImportTarget,
  options: PhotoImportOptions,
): Promise<PhotoImportReport> {
  const total = files.length;
  const refusedByKey = new Map<string, PageErrorCode>();
  let added = 0;
  let settled = 0;
  const cancelled = options.cancelled ?? (() => false);

  const items: { key: string; file: File }[] = [];
  files.forEach((file, index) => {
    const key = `p${index}`;
    if (isPdfFile(file)) {
      refusedByKey.set(key, "unsupported");
      settled += 1;
      return;
    }
    items.push({ key, file });
  });
  if (settled > 0) options.onProgress?.({ total, settled, added });

  await runIntake(
    items,
    {
      capacity: () => target.maxPages - target.pageCount(),
      add: (capture) => {
        const id = target.add(capture);
        if (id !== null) {
          added += 1;
          options.onPage?.(target.pageCount());
        }
        return id;
      },
      onStart: () => undefined,
      onSettled: (key, _pageIds, error) => {
        if (error !== null) refusedByKey.set(key, error);
        settled += 1;
        options.onProgress?.({ total, settled, added });
      },
      onCapacityHit: () => undefined,
      cancelled,
    },
    options.assets,
    options.decoders ?? browserDecoders(options.assets, "gallery"),
  );

  // The refusals in the files' own order, whichever came first in the loop.
  const refused: PageErrorCode[] = [];
  files.forEach((_file, index) => {
    const code = refusedByKey.get(`p${index}`);
    if (code !== undefined) refused.push(code);
  });
  // Everything that neither became a page nor was refused for a reason of its
  // own was left out because the document was full — whether the runner
  // stopped before it or the store turned it away.
  const overflow = cancelled() ? 0 : total - added - refused.length;
  return { total, added, refused, overflow };
}
