/**
 * What the edge refinement (`lib/refine.ts`) says about a quad's corners —
 * each one seen, inferred (something lies over it and it is where its two
 * edges' visible runs meet) or unknown (something lies over it and its edges
 * are not seen well enough to say) — and whether a second sheet overlaps the
 * page. One small shape for everything downstream: the live overlay's
 * dashed brackets, the hint slot, auto-capture's hard gate, the confirm
 * screen's "estimado" handles and the diagnostics stream.
 *
 * Owner rule: auto-capture never fires on an uncertain page. A page is
 * uncertain while any corner is not `seen`, or another sheet overlaps it
 * ({@link isUncertain}). Manual capture always works.
 *
 * Pure: no DOM; tested in `corner-check.test.ts`.
 */

import type { CornerProvenance, RefineResult } from "@/lib/refine";
import { CORNER_KEYS, type CornerKey, type NormalizedQuad } from "@/lib/quad";

export type { CornerProvenance } from "@/lib/refine";

/** A quad's corners' provenance and the overlap verdict. */
export interface CornerCheck {
  /** Per corner, keyed like the quad it belongs to. */
  corners: Record<CornerKey, CornerProvenance>;
  /** Another sheet overlaps this one: "Separe as folhas". */
  separate: boolean;
}

/** Nothing measured, or nothing found: every corner the page's own. */
export const ALL_SEEN: CornerCheck = Object.freeze({
  corners: Object.freeze({ topLeft: "seen", topRight: "seen", bottomRight: "seen", bottomLeft: "seen" }) as Record<CornerKey, CornerProvenance>,
  separate: false,
}) as CornerCheck;

/** The check a refinement answered, its corners keyed like its quad. */
export function cornerCheckOf(result: Pick<RefineResult, "corners" | "occlusion">): CornerCheck {
  const corners = {} as Record<CornerKey, CornerProvenance>;
  CORNER_KEYS.forEach((key, i) => {
    corners[key] = result.corners[i]?.provenance ?? "seen";
  });
  return { corners, separate: result.occlusion.separate };
}

/** Any corner not seen, or another sheet overlapping: auto-capture holds, the ready cue waits. */
export function isUncertain(check: CornerCheck | null | undefined): boolean {
  if (check === null || check === undefined) return false;
  return check.separate || CORNER_KEYS.some((key) => check.corners[key] !== "seen");
}

/** Some corner is `unknown`: a covered corner its edges do not let anyone place. */
export function hasUnknown(check: CornerCheck | null | undefined): boolean {
  return check !== null && check !== undefined && CORNER_KEYS.some((key) => check.corners[key] === "unknown");
}

/** Some corner is `inferred`. */
export function hasInferred(check: CornerCheck | null | undefined): boolean {
  return check !== null && check !== undefined && CORNER_KEYS.some((key) => check.corners[key] === "inferred");
}

/**
 * The provenance for the diagnostics stream: an object (the stream drops
 * arrays), one enum per corner — metadata only.
 */
export function provenanceDiagnostic(check: CornerCheck | null | undefined): { tl: CornerProvenance; tr: CornerProvenance; br: CornerProvenance; bl: CornerProvenance } | null {
  if (check === null || check === undefined) return null;
  return { tl: check.corners.topLeft, tr: check.corners.topRight, br: check.corners.bottomRight, bl: check.corners.bottomLeft };
}

/**
 * The provenance of each corner of `target` (pixels or fractions, any key
 * order a corner editor uses), taken from the nearest corner of `quad`
 * (same space) — a corner editor may hand its handles back in another
 * order than the quad it was seeded with.
 */
export function provenanceByNearest(
  check: CornerCheck,
  quad: NormalizedQuad,
  target: Record<string, { x: number; y: number }>,
): Record<string, CornerProvenance> {
  const out: Record<string, CornerProvenance> = {};
  for (const [name, point] of Object.entries(target)) {
    let best: CornerKey = "topLeft";
    let bestD = Infinity;
    for (const key of CORNER_KEYS) {
      const d = Math.hypot(quad[key].x - point.x, quad[key].y - point.y);
      if (d < bestD) {
        bestD = d;
        best = key;
      }
    }
    out[name] = check.corners[best];
  }
  return out;
}
