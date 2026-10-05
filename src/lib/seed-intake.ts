/**
 * The desktop's seed: the host's `initialImages`, read through step 1's own
 * pile, and the two things only the seed does — report what became of each
 * photo, and decide where the flow goes once they are read.
 *
 * The seed is tied to its **own run**, never to "the list has settled": the
 * list also holds whatever the person adds, and a latch that waited for the
 * whole list would treat the person's next pick as the seed — after a
 * «Limpar», a pick that failed would end the session as if the host's photos
 * had. Kept free of React so that rule is testable without a DOM.
 */

import type { ScanPhotoImportReport } from "@/types";

/** One pile's outcome, as indices into the array it was given. */
export interface PileResult extends ScanPhotoImportReport {
  /** The pile was abandoned («Limpar», or a newer seed replaced it). */
  cancelled: boolean;
}

/** What the flow does with a seed run that finished. */
export interface SeedFinish {
  /** Hand this to the host (`onPhotoImport`). Null: not ours to report. */
  report: ScanPhotoImportReport | null;
  /** Decide where the flow goes with this. Null: the person moved on. */
  settle: PileResult | null;
}

const IGNORE: SeedFinish = { report: null, settle: null };

/**
 * Which seed run is the live one, and whether the person cleared it.
 *
 *  - {@link begin} starts a seed run and abandons any earlier one (StrictMode's
 *    rehearsal seeds a store it then disposes): the abandoned run's finish is
 *    ignored, report and all.
 *  - {@link clear} is «Limpar»: the run still reports what it got to when it
 *    stops, but it no longer decides anything.
 *  - {@link finish} is the run's own end. Reports at most once per seed.
 */
export class SeedTracker {
  private live = 0;
  private cleared = false;
  private reported = false;

  begin(): number {
    this.live += 1;
    this.cleared = false;
    this.reported = false;
    return this.live;
  }

  clear(): void {
    this.cleared = true;
  }

  finish(token: number, result: PileResult): SeedFinish {
    if (token !== this.live || this.reported) return IGNORE;
    this.reported = true;
    const report: ScanPhotoImportReport = {
      imported: [...result.imported],
      refused: [...result.refused],
      overflow: [...result.overflow],
    };
    const settle = result.cancelled || this.cleared ? null : result;
    return { report, settle };
  }
}

/**
 * Where a settled seed takes the flow.
 *
 *  - `unreadable` — not one photo became a page and the document is empty:
 *    there is nothing to check and no camera to fall back to, so the session
 *    ends (`images_unreadable`, terminal on the desktop);
 *  - `conferir` — every photo became a page: that is what they were handed
 *    over for;
 *  - `stay` — one was refused or did not fit: step 1 is where the reason is
 *    written next to the file's name.
 */
export function seedVerdict(
  result: ScanPhotoImportReport,
  pagesNow: number,
): "unreadable" | "conferir" | "stay" {
  if (result.imported.length === 0 && pagesNow === 0) return "unreadable";
  if (result.refused.length === 0 && result.overflow.length === 0) return "conferir";
  return "stay";
}

/** What a pile did with one of its files. `skipped`: read, but no room for it. */
export type PileOutcome = "added" | "refused" | "skipped";

/**
 * One pile's outcome per input index. A file with no outcome was never reached:
 * the document filled up first (overflow) — unless the pile was abandoned, in
 * which case it is in none of the lists.
 */
export function pileResult(
  total: number,
  outcomes: ReadonlyMap<number, PileOutcome>,
  cancelled: boolean,
): PileResult {
  const result: PileResult = { imported: [], refused: [], overflow: [], cancelled };
  for (let index = 0; index < total; index += 1) {
    const outcome = outcomes.get(index);
    if (outcome === "added") result.imported.push(index);
    else if (outcome === "refused") result.refused.push(index);
    else if (outcome === "skipped" || !cancelled) result.overflow.push(index);
  }
  return result;
}
