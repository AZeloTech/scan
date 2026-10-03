/**
 * What the live loop remembers of the tracked sheet's paper readings — the
 * lock's memory and auto-capture's paper footing (5d-paper).
 *
 * Every time is a **frame** time: when the frame a reading describes was
 * sampled (`performance.now()` at the grab), never when the detector got
 * round to answering — a worker pass that answers 800 ms late describes a
 * frame from 800 ms ago, and a page swapped in since must not inherit its
 * reading.
 *
 *  - **Memory** ({@link paperRemembered}): a sheet found on paper evidence
 *    keeps its lock while only its surface stops reading as paper (dim,
 *    uneven light), bounded: at most {@link PAPER_MEMORY_MS} after the last
 *    paper reading, near where it was read, every side on its edges, every
 *    corner in view and none unknown, no side open to the frame's edge.
 *  - **Expiry** ({@link paperMemoryExpired}): past {@link PAPER_MEMORY_MS}
 *    without a paper reading a found sheet is let go at once, whatever path
 *    held it (memory, the steep-tilt allowance, passes that read nothing).
 *  - **Auto** ({@link autoPaperFresh}): auto-capture stands on the sheet's
 *    *current* reading — the newest reading of it said paper, within
 *    {@link AUTO_PAPER_FRESH_MS}, on a frame after the last motion. A
 *    contrary reading (a lid slid in at the same outline) takes that away at
 *    once, whatever the lock's memory keeps.
 *
 * Pure: tested in `paper-memory.test.ts`.
 */

import type { CoveredCorner } from "@/lib/paper-evidence";
import type { NormalizedQuad } from "@/lib/quad";

/** A found sheet's lock outlives its last paper reading by at most this long. */
export const PAPER_MEMORY_MS = 5000;
/** …and only near where that reading was taken (largest corner move, share of the diagonal). */
export const PAPER_MEMORY_DRIFT_DIAG = 0.06;
/** Auto-capture fires only on a sheet whose newest reading said paper, at most this long ago. */
export const AUTO_PAPER_FRESH_MS = 1500;
/** Memory needs every side at least this far on its edges (`KEEP_SIDE_SUPPORT` in the hook). */
export const MEMORY_SIDE_SUPPORT = 0.8;
/** …and every corner at least this far (share of the visible frame) inside the view (`BORDER_ENTER`). */
export const MEMORY_BORDER = 0.015;

export interface PaperMemory {
  /** Frame time of the newest reading of the tracked sheet that said paper; null: none since the sheet was found. */
  paperAt: number | null;
  /** The quad (as drawn) of that reading. */
  paperQuad: NormalizedQuad | null;
  /** Frame time of the newest reading of the tracked sheet at all, and what it said. */
  readAt: number | null;
  lastOk: boolean | null;
  /**
   * The newest measured covered corners of the tracked sheet and their frame
   * time: a held-sheet reading on a missed pass leaves the same region out
   * as the reading that found it did.
   */
  covered: CoveredCorner[];
  coveredAt: number | null;
}

export function freshPaperMemory(): PaperMemory {
  return { paperAt: null, paperQuad: null, readAt: null, lastOk: null, covered: [], coveredAt: null };
}

/** Forget everything: another sheet, a stopped loop, a new stream or lane. */
export function resetPaperMemory(memory: PaperMemory): void {
  memory.paperAt = null;
  memory.paperQuad = null;
  memory.readAt = null;
  memory.lastOk = null;
  memory.covered = [];
  memory.coveredAt = null;
}

/**
 * One reading of the tracked sheet on the frame sampled at `frameAt`: `ok`
 * paper or not, `quad` where (null: keep the quad of the last paper reading
 * — a held-sheet reading is of that quad). A reply about a frame older than
 * one already read changes nothing.
 */
export function notePaperReading(memory: PaperMemory, frameAt: number, ok: boolean, quad: NormalizedQuad | null): void {
  if (memory.readAt !== null && frameAt < memory.readAt) return;
  memory.readAt = frameAt;
  memory.lastOk = ok;
  if (ok) {
    memory.paperAt = frameAt;
    if (quad !== null) memory.paperQuad = quad;
  }
}

/** The covered corners measured on the frame sampled at `frameAt` (an older frame changes nothing). */
export function noteCovered(memory: PaperMemory, frameAt: number, covered: readonly CoveredCorner[]): void {
  if (memory.coveredAt !== null && frameAt < memory.coveredAt) return;
  memory.coveredAt = frameAt;
  memory.covered = covered.map((c) => ({ corner: c.corner, along: [c.along[0], c.along[1]] }));
}

/** No paper reading within {@link PAPER_MEMORY_MS} of the frame at `frameAt`: a found sheet goes. */
export function paperMemoryExpired(memory: PaperMemory, frameAt: number): boolean {
  return memory.paperAt === null || frameAt - memory.paperAt > PAPER_MEMORY_MS;
}

/** What one "not paper" reading's frame says about the sheet, for {@link paperRemembered}. */
export interface MemoryFooting {
  /** Frame time of the reading. */
  frameAt: number;
  /** The reading quad's largest corner move from the last paper reading's (share of the diagonal). */
  drift: number;
  /** The evidence's sides: how many judged, each one's support (null: cut off). */
  sidesKnown: number;
  sideSupport: readonly (number | null)[];
  /** Sides with no edge and the page's paper running on to the frame's edge. */
  open: number;
  /** Some corner is unknown, or another sheet overlaps (the newest corner check). */
  unknownCorner: boolean;
  /** The quad's least distance to the visible frame's edge (share of it; negative: past it). */
  border: number;
}

/**
 * Whether a "not paper" reading is neither a hit nor a miss: the sheet read
 * as paper within {@link PAPER_MEMORY_MS} of this frame, near here, and on
 * this frame every side is on its edges, no side runs open to the frame's
 * edge, every corner is in view and none is unknown.
 */
export function paperRemembered(memory: PaperMemory, footing: MemoryFooting): boolean {
  return (
    !paperMemoryExpired(memory, footing.frameAt) &&
    memory.paperQuad !== null &&
    footing.drift <= PAPER_MEMORY_DRIFT_DIAG &&
    footing.sidesKnown === 4 &&
    footing.sideSupport.every((support) => support !== null && support >= MEMORY_SIDE_SUPPORT) &&
    footing.open === 0 &&
    !footing.unknownCorner &&
    footing.border >= MEMORY_BORDER
  );
}

/**
 * Auto-capture's paper footing at `now`: the newest reading of the sheet
 * said paper, at most {@link AUTO_PAPER_FRESH_MS} ago, on a frame after the
 * last motion (`motionAt`, frame time; null: none).
 */
export function autoPaperFresh(memory: PaperMemory, now: number, motionAt: number | null): boolean {
  return (
    memory.lastOk === true &&
    memory.paperAt !== null &&
    now - memory.paperAt <= AUTO_PAPER_FRESH_MS &&
    (motionAt === null || memory.paperAt > motionAt)
  );
}

/** Why {@link autoPaperFresh} says no, for the HUD. */
export function autoPaperWhy(memory: PaperMemory, now: number, motionAt: number | null): string | null {
  if (memory.lastOk === false) return "paper: newest not paper";
  if (memory.paperAt === null || memory.lastOk === null) return "paper not read";
  if (now - memory.paperAt > AUTO_PAPER_FRESH_MS) return "paper not read lately";
  if (motionAt !== null && memory.paperAt <= motionAt) return "paper not read since motion";
  return null;
}
