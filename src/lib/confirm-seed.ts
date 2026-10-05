/**
 * What the confirm screen says about the corners it opens on — and the pill's
 * one sentence (C5: a reason replaces the instruction rather than stacking
 * under it).
 *
 *  - `estimated`: the capture measured the corners and some corner is not
 *    `seen` (something lay over it; `lib/corner-check.ts`) or another sheet
 *    overlaps — those handles say "estimado".
 *  - `unmeasured`: there are corners, but the refinement measured nothing
 *    about them (out of time even on its retry, or nothing to measure on;
 *    `lib/refine-retry.ts`) — every handle asks for a look, and the pill
 *    says "não deu para medir". Never "estimado": nothing was inferred.
 *  - `clear`: measured and all seen, no seed at all (the pill's "not found"
 *    says that), or a seed nobody refined (an older capture, a gallery pick).
 *
 * Pure: tested in `confirm-seed.test.ts`.
 */

import { isUncertain, type CornerCheck } from "@/lib/corner-check";
import type { AppCopy } from "@/lib/i18n";

export type SeedMark = "clear" | "estimated" | "unmeasured";

export function seedMarkOf(
  hasSeed: boolean,
  check: CornerCheck | null | undefined,
  refine: { measured: boolean } | null | undefined,
): SeedMark {
  if (!hasSeed) return "clear";
  if (check !== null && check !== undefined) return isUncertain(check) ? "estimated" : "clear";
  return refine !== null && refine !== undefined && !refine.measured ? "unmeasured" : "clear";
}

export interface ConfirmPillState {
  /** The photo's own check asked for a closer look (`lib/still-check.ts`). */
  attention: keyof AppCopy["confirm"]["attention"] | null;
  ready: boolean;
  /** The editor opened on a seed (false: its own inset quad). */
  found: boolean;
  /** Handles still marked (cleared once the person moves them all). */
  mark: SeedMark;
}

/**
 * The pill's sentence, whether it carries a reason (announced) and the
 * aside under it — the corners' own ask, said even under the photo's reason:
 * the two are different asks, and this one is about these handles.
 */
export function confirmPill(copy: AppCopy["confirm"], state: ConfirmPillState): { text: string; reason: boolean; aside: string | null } {
  const markText = state.mark === "estimated" ? copy.estimatedPill : state.mark === "unmeasured" ? copy.unmeasuredPill : null;
  if (state.attention !== null) {
    return { text: copy.attention[state.attention], reason: true, aside: state.ready ? markText : null };
  }
  if (state.ready && !state.found) return { text: copy.notFound, reason: true, aside: null };
  if (state.ready && markText !== null) return { text: markText, reason: true, aside: null };
  return { text: copy.pill, reason: false, aside: null };
}
