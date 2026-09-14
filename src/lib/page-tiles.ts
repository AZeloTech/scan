"use client";

/**
 * One view model for "a page the user can see".
 *
 * There is no server and no upload queue here, so this is exactly what it
 * looks like: a pure projection of the local page list into the words, tone
 * and affordances a screen renders.
 *
 * The verdict comes straight from the on-device capture gate — `blurry` and
 * `too_small` are the only two things that measurably break OCR. A capture the
 * gate could not measure is reported as unverified rather than as a pass: a
 * page is only ever said to have come out well when it was actually looked
 * at.
 */

import type { GateReason } from "@/lib/capture-gate";
import type { AppCopy } from "@/lib/i18n";
import { pageGate, type ScanPage, type ScanSession } from "@/lib/scan-store";

/**
 * `unverified` is a third, neutral verdict, not a softer warning: the gate
 * measured nothing, so the app has nothing to claim in either direction.
 */
export type TileStage = "processing" | "ok" | "unverified" | "warned" | "retry";

export interface PageTile {
  /** Stable for the page's whole life — the page's own id. */
  key: string;
  pageId: string;
  /** 1-based, for the user ("Página 3"). */
  humanNumber: number;
  page: ScanPage;
  stage: TileStage;
  /** Short chip copy, in the reader's language. */
  chipLabel: string;
  /** Longer, warmer sentence for the review cards. */
  detail: string;
  /**
   * scanic could not find a trustworthy page outline, so the raw frame is in
   * the document. Not a failure and never a blocker — but the one case where
   * pointing at "Ajustar cantos" genuinely helps (the warp rescue).
   */
  needsCorners: boolean;
}

/**
 * The gate's vocabulary, in the user's words.
 *
 * `too_small` says what it means rather than being folded into a coarser
 * verdict. `dark` and `glare` are not here at all — the 144-sample bench
 * retired them as false alarms. `unknown` has its own word: it used to fold
 * into `ok`, which promised "dá para ler tudo" about a capture that was never
 * measured.
 */
type ReasonKey = "ok" | "unverified" | "blurry" | "tooSmall";

const REASON_KEY: Record<GateReason, ReasonKey> = {
  ok: "ok",
  unknown: "unverified",
  blurry: "blurry",
  too_small: "tooSmall",
};

const REASON_STAGE: Record<ReasonKey, TileStage> = {
  ok: "ok",
  unverified: "unverified",
  blurry: "warned",
  tooSmall: "warned",
};

/** A quality warning — an offer to retake, never a blocker. */
export function isWarned(tile: PageTile): boolean {
  return tile.stage === "warned";
}

/**
 * A page that could not be prepared. These block "Gerar PDF": a PDF silently
 * missing the page the user photographed is the one failure they would not
 * forgive. Quality warnings (tremida, letras pequenas) never block.
 */
export function isBlocking(tile: PageTile): boolean {
  return tile.stage === "retry";
}

/**
 * How a page reads as **one word in a list row** — step 2's own register.
 *
 * Deliberately coarser than {@link TileStage}, and not a rename of it: the page
 * view has room for a chip, an icon and a sentence, while the row has room for
 * a single mono word next to a 34 px thumbnail. So the two "nothing to report"
 * stages collapse into `quiet`, and the two states that are genuinely *about
 * this row* get their own faces — `noCorners`, which has an obvious next step
 * behind the row, and `failed`, which blocks the PDF.
 */
export type RowState = "ok" | "quiet" | "warned" | "noCorners" | "failed";

/** A row wearing the peach card: something on it needs the user. */
export function isProblemRow(state: RowState): boolean {
  return state === "noCorners" || state === "failed";
}

/**
 * The row's state and the word it shows, in the reader's language.
 *
 * Order matters and is the order of severity: a page that could not be prepared
 * says so even if the gate also disliked it, and "bordas não encontradas" beats
 * "tremida" because it is the one the user can act on from the row.
 */
export function rowVerdict(
  tile: PageTile,
  copy: AppCopy,
): { state: RowState; word: string } {
  if (isBlocking(tile)) return { state: "failed", word: copy.review.state.failed };
  if (tile.stage === "processing") {
    return { state: "quiet", word: copy.review.state.processing };
  }
  if (tile.needsCorners) {
    return { state: "noCorners", word: copy.review.state.noCorners };
  }
  // The gate's own two warnings keep their specific words ("tremida", "letras
  // pequenas"): they are already short, and which one it is changes what the
  // user would do about it.
  if (tile.stage === "warned") return { state: "warned", word: tile.chipLabel };
  if (tile.stage === "unverified") {
    return { state: "quiet", word: copy.review.state.unverified };
  }
  return { state: "ok", word: copy.review.state.ok };
}

function describe(
  page: ScanPage,
  copy: AppCopy,
): { stage: TileStage; chipLabel: string; detail: string } {
  if (page.status === "failed") {
    return {
      stage: "retry",
      chipLabel: copy.tiles.chip.retry,
      detail: copy.pageErrors[page.error ?? "generic"],
    };
  }
  if (page.status === "processing") {
    return {
      stage: "processing",
      chipLabel: copy.tiles.chip.processing,
      detail: copy.tiles.detail.processing,
    };
  }
  // A page with no reading at all — a device that refused a 2-D context, or a
  // reading the page has since outgrown (`pageGate` drops a verdict taken on
  // bytes the user has replaced) — is exactly the `unknown` case: unmeasured,
  // not approved.
  const reason: GateReason = pageGate(page)?.reason ?? "unknown";
  const key = REASON_KEY[reason];
  return {
    stage: REASON_STAGE[key],
    chipLabel: copy.tiles.chip[key],
    detail: copy.tiles.detail[key],
  };
}

/** Canonical order always — the order on screen is the order in the PDF. */
export function buildTiles(
  session: ScanSession | null,
  copy: AppCopy,
): PageTile[] {
  const pages = [...(session?.pages ?? [])].sort(
    (left, right) => left.order - right.order,
  );
  return pages.map((page, index) => ({
    key: page.id,
    pageId: page.id,
    humanNumber: index + 1,
    page,
    // Read off what the render actually managed, not off what was asked for:
    // a page whose corners could not be applied went in flat, and that is the
    // page the nudge is for.
    needsCorners: page.status === "ready" && page.rendered?.warped === false,
    ...describe(page, copy),
  }));
}

/** True while anything on screen is still moving. */
export function hasWorkInFlight(tiles: readonly PageTile[]): boolean {
  return tiles.some((tile) => tile.stage === "processing");
}
