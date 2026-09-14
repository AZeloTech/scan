/**
 * The sentence the PDF carries about itself.
 *
 * v1 stamped it into a 24 pt footer band; the ratified geometry is one PDF page
 * per image at the image's own pixel size, so a band would make the page taller
 * than its photo. It lives in the document's `/Subject` instead, and it records
 * **what was actually done to each page** — nothing else.
 *
 * "Actually" is the whole point. A page whose illumination correction failed
 * renders un-enhanced, and the store keeps that as its *effective* finish — so
 * this line says `none` for it rather than repeating the `brighten` the user
 * asked for. The document must not describe a correction it did not get.
 * `dewarped` obeys the same rule from the other direction: it is written from
 * the geometry that produced the pixels, never from the toggle, so a page that
 * asked to be un-curved and fell back to the flat warp says nothing at all
 * about curvature.
 *
 * ## Why it is not translated, and carries no date
 *
 * It used to open with "Cópia fotografada - gerada por AZelo Escanear em
 * 16/08/2026", written in whichever language the app was being read in, with the
 * date formatted for that reader. Both of those are gone, and the reason is the
 * rule they broke: **the finished file carries no user-agent, device, locale or
 * location data**. A translated sentence with a `dd/mm` date in it is a locale
 * fingerprint written into a health document — it tells anybody the file is ever
 * forwarded to which language its maker reads and which date convention they
 * use. The `/CreationDate` already records when the file was made, in UTC, where
 * a viewer renders it for whoever is holding it.
 *
 * What is left is a language-independent inventory of transforms. It is a
 * provenance record rather than a sentence, which is what it always should have
 * been.
 */

import type { PageFinish } from "@/lib/page-processing";
import type { PageRotation } from "@/lib/rotation";

/** What one page in the finished document actually had done to it. */
export interface PageTransform {
  /** The finish that was applied, not the one that was requested. */
  finish: PageFinish;
  rotation: PageRotation;
  /**
   * The curved geometry produced this page's pixels.
   *
   * Required rather than optional: a page that asked for the correction and got
   * the flat geometry back is indistinguishable from one that never asked, and
   * the whole point of this line is that the document cannot describe a
   * correction it did not receive. Every call site has to answer.
   */
  dewarped: boolean;
}

/**
 * One word per finish. Fixed, lowercase, ASCII, English — these are field
 * values in a metadata record, not copy, and they must read the same to every
 * reader of the file.
 */
const FINISH_WORD: Record<PageFinish, string> = {
  original: "none",
  clean: "brighten",
  bw: "black-and-white",
};

/**
 * One page's clause, in the order the work happened: the sheet's treatment,
 * then the geometry it was given, then how it was turned.
 */
function describe(transform: PageTransform): string {
  const clauses = [FINISH_WORD[transform.finish]];
  if (transform.dewarped) clauses.push("dewarped");
  if (transform.rotation !== 0) clauses.push(`rotated ${transform.rotation}deg`);
  return clauses.join(", ");
}

/**
 * Consecutive pages that had the same thing done to them collapse into a range
 * ("1-16 brighten"): a twenty-page document is the common case and twenty
 * repetitions of the same clause is not a record anybody reads.
 */
function summarise(pages: readonly PageTransform[]): string {
  const parts: string[] = [];
  let start = 0;
  for (let index = 0; index <= pages.length; index += 1) {
    const previous = describe(pages[start]);
    if (index < pages.length && describe(pages[index]) === previous) continue;
    const last = index;
    parts.push(`${start + 1 === last ? `${last}` : `${start + 1}-${last}`} ${previous}`);
    start = index;
  }
  return parts.join("; ");
}

/**
 * How the pages were re-encoded to meet the host's size budget, if they were.
 *
 * Recorded because it is a transform like any other: a reader comparing the
 * file with the screen it came from deserves to know the pages were resampled,
 * the final rung therefore belongs in the Subject.
 */
export interface SizeLadderRecord {
  /** 0-based rung of the ladder in `lib/pdf.ts`. Rung 0 is "exactly as reviewed". */
  rung: number;
  /** The JPEG quality that rung encodes at, 0–1. */
  quality: number;
  /** The long-edge cap in pixels that rung resamples to. */
  longEdge: number;
}

/**
 * The `/Subject` line: what was done to the pages, and nothing else.
 *
 * No name, no date, no language, no device. An empty `pages` cannot happen
 * through the flow, but it is answered rather than indexed off the end of the
 * array.
 */
export function honestySubject(
  pages: readonly PageTransform[],
  ladder: SizeLadderRecord | null = null,
): string {
  const parts = ["Photographed copy."];
  if (pages.length > 0) parts.push(`Transforms: ${summarise(pages)}.`);
  if (ladder !== null && ladder.rung > 0) {
    parts.push(
      `Size ladder: rung ${ladder.rung}, q${Math.round(ladder.quality * 100)}, ` +
        `long edge ${ladder.longEdge}px.`,
    );
  }
  return parts.join(" ");
}
