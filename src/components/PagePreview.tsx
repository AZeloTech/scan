"use client";

import * as React from "react";
import clsx from "clsx";
import { useDocumentName, useStore } from "@/hooks/useScanStore";
import { useDialogChrome } from "@/hooks/useDialogChrome";
import { usePageTurn } from "@/hooks/usePageTurn";
import { usePageView } from "@/hooks/usePageView";
import { useRotatedFit } from "@/hooks/useRotatedFit";
import { overlayIn, overlayOut } from "@/lib/motion";
import {
  DewarpPanel,
  DewarpTile,
  dewarpPanelVisible,
  useDewarpControl,
} from "@/components/DewarpControl";
import {
  dewarpAbCompare,
  resolveGeometryMode,
  type DewarpEngineMode,
} from "@/lib/dewarp/engine-mode";
import { AcabamentoSheet } from "@/components/AcabamentoSheet";
import { CorrectionTile } from "@/components/CorrectionTile";
import { FullImageView } from "@/components/FullImageView";
import { GirarSheet, type PageTurn } from "@/components/GirarSheet";
import { ImprovementsInfoSheet } from "@/components/ImprovementsInfoSheet";
import { DeletePageSheet, PageMenu } from "@/components/PageMenu";
import { PageThumb } from "@/components/PageThumb";
import { PreviewCanvas } from "@/components/PreviewCanvas";
import { hasSeenCompareTip, markCompareTipSeen } from "@/lib/tips";
import { localeTag } from "@/lib/i18n";
import type { PageTile } from "@/lib/page-tiles";
import { displayRotation, effectiveFinish } from "@/lib/scan-store";
import { useCopy, useLang } from "@/components/I18n";
import { Meta, Notice } from "@/components/ui";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ContrastIcon,
  CropIcon,
  ExclamationIcon,
  ExpandIcon,
  MoreIcon,
  RotateIcon,
  SpinnerIcon,
  XIcon,
} from "@/components/icons";

/**
 * The page editor — one fixed structure, every state.
 *
 * The screen it replaces mixed two layouts, stacked two "we are working"
 * indicators on top of each other, truncated its own labels and moved the
 * primary button when the state changed. This one has six bands and they are
 * always the same six, top to bottom:
 *
 *  1. **header** — which page this is, the way out, and the ⋯ menu;
 *  2. **status line**, 38 px — the ONE place on this screen that talks about
 *     state. Every sentence is composed here at render from `rendered.*` and
 *     {@link effectiveFinish}; the store keeps codes, never sentences;
 *  3. **the sheet** — the page itself, absorbing whatever height is left;
 *  4. **the explanation card** — the one band allowed to appear and disappear,
 *     because it only exists when one line is not enough;
 *  5. **the four corrections** — always four columns, applied state on the tile
 *     that applied it, disabled shown rather than hidden;
 *  6. **the footer**, fixed — a secondary and the primary, and neither of them
 *     ever moves.
 *
 * Each state swaps the *content* of those bands and nothing else. The three
 * things that used to float over the picture — the "sem melhorias" chip, the
 * "ver inteira" chip, the status pill and its tap-popover — are gone: a chip
 * over the page is a control claiming to belong to the photograph.
 *
 * ## What it owns that it did not before
 *
 * **The pager.** With more than one page the editor keeps its own cursor: the
 * side arrows and the thumbnail rail move it, and the primary reads "Próxima
 * página" until the last page. The hosts still hand it the page that was
 * tapped; from there this component navigates in place. (Re*ordering* is still
 * deliberately not here — moving a page up is a comparison between rows, and
 * you cannot compare rows from inside one of them.)
 *
 * **Girar and Acabamento are two sheets**, not two doors onto one. They open
 * over the page they change, and the page keeps rendering behind them.
 *
 * **Delete left the header** and is a row of the ⋯ menu, behind a confirmation
 * that states the consequence.
 *
 * Modal hygiene per the a11y bar: focus moves in and is trapped, Escape closes
 * the innermost surface first, no history entry is pushed, and `touch-none` on
 * the picture stops a press-and-hold from being claimed as a pan.
 */

/**
 * Long edge of the un-enhanced compare render. Generous enough that the flip
 * reads on a phone held close, small enough that the pass is imperceptible.
 */
const COMPARE_LONG_EDGE = 1400;

interface PagePreviewProps {
  /** The page the user tapped — the editor's initial cursor. */
  tile: PageTile;
  /** The whole document, in order: the pager, the rail and "de M" read it. */
  tiles: readonly PageTile[];
  /** Leaves the overlay for the retake flow, on whichever page is open. */
  onRetake: (tile: PageTile) => void;
  /** Opens the corner editor, on whichever page is open. */
  onAdjustCorners: (tile: PageTile) => void;
  onClose: () => void;
}

export function PagePreview({
  tile,
  tiles,
  onRetake,
  onAdjustCorners,
  onClose,
}: PagePreviewProps) {
  const copy = useCopy();
  const { lang } = useLang();
  const store = useStore();
  const documentName = useDocumentName();
  const backdropRef = React.useRef<HTMLDivElement | null>(null);
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const closingRef = React.useRef(false);

  // ── the cursor ────────────────────────────────────────────────────────────
  //
  // The page id rather than its index: a delete elsewhere in the document would
  // silently move an index onto a different page.
  const [cursor, setCursor] = React.useState(tile.pageId);
  // A cursor that no longer names a page (deleted from under the editor) falls
  // back to the first one rather than to -1, which would leave the pager
  // counting from zero and the arrows reaching past both ends.
  const found = tiles.findIndex((candidate) => candidate.pageId === cursor);
  const index = found === -1 ? 0 : found;
  const current = tiles[index] ?? tile;
  const pageCount = tiles.length;
  const multiPage = pageCount > 1;

  // …and the fallback is written back, so the rail, the arrows and the primary
  // agree with the page on screen. Without it the cursor keeps naming a page
  // that is gone: the editor shows page 1 while the rail highlights nothing and
  // "‹" believes there is something to its left.
  React.useEffect(() => {
    const first = tiles[0];
    if (found === -1 && first !== undefined) setCursor(first.pageId);
  }, [found, tiles]);

  // ── the surfaces this one can open over itself ────────────────────────────
  const [fullView, setFullView] = React.useState(false);
  const [girar, setGirar] = React.useState(false);
  const [acabamento, setAcabamento] = React.useState(false);
  const [menu, setMenu] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [about, setAbout] = React.useState(false);
  /**
   * The turn the girar sheet last made — the direction that was tapped and the
   * orientation it landed on — narrated by the status line while that sheet is
   * open. Cleared when it closes, so the verdict comes back.
   */
  const [turning, setTurning] = React.useState<PageTurn | null>(null);

  const page = current.page;
  const pageId = current.pageId;
  const failed = page.status === "failed";
  const processing = page.status === "processing";
  /**
   * The picture and the turn it is wearing, as one value.
   *
   * `final` is the page — the same bytes the PDF will embed; the canonical only
   * stands in for the moment before the first render lands. The angle beside it
   * is the *difference* between the turn the page is wearing and the one its
   * bytes carry — the CSS stand-in that makes "Girar" feel instant while the
   * render catches up.
   *
   * The two used to be read separately, and separately is how they came apart:
   * the hand-over dropped the stand-in the moment the store had new bytes,
   * which is several frames before the `<img>` has decoded them, so the page
   * flicked back to its pre-turn orientation and then popped upright. The hook
   * holds the pair together and hands both over in one commit, once the new
   * bitmap can actually be painted (`lib/page-view.ts`).
   */
  const view = usePageView(page.final ?? page.canonical, displayRotation(page));
  const source = view.url;
  const rotation = view.rotation;
  /**
   * Bumped by the commit where the render caught up: the turn the user watched
   * has moved out of the transform and into the picture's own pixels. Watching
   * it is the only way to tell that commit (which changes nothing on screen)
   * apart from a turn the user actually asked for.
   */
  const handover = view.handover;
  const { frameRef, imageRef, scale, scaleFor, handleImageLoad } =
    useRotatedFit(rotation, "contain");
  const spinRef = React.useRef<HTMLDivElement | null>(null);
  usePageTurn({
    element: spinRef,
    rotation,
    handover,
    scale,
    scaleFor,
    ready: source !== null,
    pageId,
  });

  // ── curvature ─────────────────────────────────────────────────────────────
  //
  // One control, one engine, in every build. The "ab" build drew both engines
  // side by side; the uvdoc tile was pulled from the page view, so
  // "ab" now resolves *here* to the classical engine and shows it alone.
  const geometryMode: DewarpEngineMode = dewarpAbCompare()
    ? "classical"
    : resolveGeometryMode();
  const dewarp = useDewarpControl(page, geometryMode);
  // Not offered on a page that could not be prepared at all, and not on one
  // with no outline to predict a surface for — there is nothing to un-curve.
  const canDewarp = !failed && page.corners !== null;

  // ── "sem melhorias": the same page with the improvements left out ─────────
  //
  // Deliberately not called "original": what it shows is the app's own JPEG of
  // the frame with the improvement skipped, not the untouched thing the sensor
  // saw. It is rendered on demand at display scale and never encoded — a JPEG
  // here would be a lossy generation spent on a comparison.
  //
  // Hidden on a page whose curvature was corrected, for the reason the flip
  // exists at all: the comparison is rendered through the homography, so on a
  // dewarped page the two sides would differ in geometry as well as in finish —
  // two documents either side of the flip, which is what this rules out.
  const rendered = page.rendered;
  const canCompare =
    !failed &&
    rendered !== null &&
    rendered.finish !== "original" &&
    !rendered.dewarped;
  const [comparing, setComparing] = React.useState(false);

  // A new revision is a new page as far as the comparison is concerned — and so
  // is a page that has *started* becoming one: while a re-render runs,
  // `rendered` still describes the old pixels but `page.corners`/`page.rotation`
  // already describe the new ones, so a hold that survived the edit would be
  // comparing across the seam. A page change closes the same window.
  React.useEffect(() => {
    setComparing(false);
  }, [rendered?.revision, processing, pageId]);

  const holdCompare = React.useCallback(() => {
    if (canCompare && !processing) setComparing(true);
  }, [canCompare, processing]);
  const releaseCompare = React.useCallback(() => setComparing(false), []);

  /**
   * The one-time "segure e solte para comparar".
   *
   * A tester pressed the old chip expecting a toggle and got a flicker,
   * which is what a hold looks like when nobody told you it was one. It is
   * shown the first time a page actually has something to compare, for four
   * seconds, and then never again on this device (`lib/tips.ts`).
   *
   * `false` on the server and on the first client render, like every other
   * reader of that flag: the effect below adopts the real answer, so a static
   * export cannot hydrate into a disagreement.
   */
  const [holdTip, setHoldTip] = React.useState(false);
  React.useEffect(() => {
    if (!canCompare || processing || hasSeenCompareTip()) return;
    setHoldTip(true);
    markCompareTipSeen();
    const timer = window.setTimeout(() => setHoldTip(false), 4_000);
    return () => window.clearTimeout(timer);
  }, [canCompare, processing]);
  // The hint has said its piece the moment the gesture is used.
  React.useEffect(() => {
    if (comparing) setHoldTip(false);
  }, [comparing]);

  // ── closing, and who owns the back gesture ────────────────────────────────
  //
  // The innermost surface answers Escape first. Kept as
  // one derived closer rather than a flag per sheet: two dialogs closing on one
  // key is how a user loses the page they were inspecting.
  const closeGirar = React.useCallback(() => {
    setGirar(false);
    setTurning(null);
  }, []);
  const inner: (() => void) | null = fullView
    ? () => setFullView(false)
    : about
        ? () => setAbout(false)
        : confirmDelete
          ? () => setConfirmDelete(false)
          : menu
            ? () => setMenu(false)
            : girar
              ? closeGirar
              : acabamento
                ? () => setAcabamento(false)
                : null;
  const innerRef = React.useRef(inner);
  innerRef.current = inner;

  /** Plays the exit, then hands control back to the screen. */
  const dismiss = React.useCallback(() => {
    if (closingRef.current || innerRef.current !== null) return;
    closingRef.current = true;
    void overlayOut(backdropRef.current, panelRef.current).then(() => {
      onClose();
    });
  }, [onClose]);

  const dismissRef = React.useRef(dismiss);
  dismissRef.current = dismiss;

  // Entrance.
  React.useEffect(() => {
    overlayIn(backdropRef.current, panelRef.current);
  }, []);

  // No history entry, on purpose. A library embedded in somebody else's page
  // must not push onto their history stack: the host owns the back button, and
  // an entry pushed here outlives the overlay in ways only the host can see.
  // The overlay closes through its own controls and Escape.

  // Focus in, focus trapped, focus restored, Escape closes.
  const containerRef = useDialogChrome<HTMLDivElement>(() => {
    dismissRef.current();
  });

  // A page that vanished under the cursor (deleted from another surface) leaves
  // nothing to edit.
  React.useEffect(() => {
    if (pageCount === 0) onClose();
  }, [pageCount, onClose]);

  // Keyed on the page as well as on the work: paging between two pages that are
  // both rendering is a different clock, and a counter carried across would be
  // reporting the other page's seconds.
  const elapsed = useElapsedSeconds(processing, pageId);
  const canOpenFull = page.final !== null && !failed;

  /**
   * The cancel tap's instant acknowledgment. The run itself only unwinds at its
   * next checkpoint, and a button that sits mute until then reads as a hang and
   * collects more (useless) taps.
   *
   * Reset whenever the work changes — it ended, a new one started, or the pager
   * moved to another page. The acknowledgment belongs to one run on one page;
   * carried across, it would leave the next page's live "Cancelar" already
   * reading "cancelando…" and disabled.
   */
  const [cancelling, setCancelling] = React.useState(false);
  React.useEffect(() => {
    setCancelling(false);
  }, [pageId, processing]);

  // ── the status line, composed here and never stored ───────────────────────
  const outcome = dewarp.outcome;
  const retryableOutcome = outcome === "download" || outcome === "transient";
  const status: {
    tone: "ok" | "warn" | "busy" | "plain";
    text: string;
    trailing: "elapsed" | "why" | null;
  } = comparing
    ? { tone: "plain", text: copy.preview.compare, trailing: null }
    : turning !== null
      ? {
          tone: "plain",
          // The direction that was tapped and the turn the page lands on — the
          // sheet's own two facts, not the CSS delta the picture is halfway
          // through, which is back to zero the moment the render lands and
          // would narrate "— 0°" under a sheet that is still open.
          text: copy.preview.status.turning(
            turning.direction === "cw" ? copy.girar.right : copy.girar.left,
            turning.rotation,
          ),
          trailing: null,
        }
      : failed
        ? { tone: "warn", text: copy.preview.failedLine, trailing: null }
        : processing
          ? {
              tone: "busy",
              text: dewarp.running
                ? copy.preview.status.straightening
                : copy.preview.status.working,
              trailing: "elapsed",
            }
          : retryableOutcome && outcome !== null
            ? {
                tone: "warn",
                text: copy.preview.dewarp.outcomes[outcome],
                trailing: "why",
              }
            : current.needsCorners
              ? { tone: "warn", text: copy.preview.status.noCorners, trailing: "why" }
              : {
                  tone: "ok",
                  text: copy.preview.status.ready(effectiveFinish(page)),
                  trailing: null,
                };

  // ── the explanation card ──────────────────────────────────────────────────
  const cardText = failed
    ? copy.preview.cards.failed
    : current.needsCorners
      ? copy.preview.cards.noCorners
      : null;
  // A run in flight is the status line's business, and `DewarpPanel` draws only
  // its screen-reader description while it lasts — so the band must not keep
  // its padding open around nothing, which shifts the picture by 12 px for the
  // length of the run and back again when it ends.
  const showCard = cardText !== null || (dewarpPanelVisible(dewarp) && !dewarp.running);

  // ── the footer ────────────────────────────────────────────────────────────
  const isLast = index >= pageCount - 1;
  const advances = multiPage && !isLast && !failed;
  const primaryLabel = failed
    ? copy.preview.closeAction
    : advances
      ? copy.preview.nextPage
      : copy.preview.useAsIs;

  /**
   * The finish and the turn the page is really wearing, for the two tiles that
   * report a standing choice. `rendered.*` first, per the requested-vs-effective
   * rule: a tile is a claim about the page, not about the request.
   */
  const turned = (rendered?.rotation ?? page.rotation) !== 0;
  const finished = effectiveFinish(page) !== "original";

  return (
    <>
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label={copy.preview.dialogLabel(current.humanNumber)}
        className="fixed inset-0 z-50 flex flex-col overscroll-contain"
      >
        <div
          ref={backdropRef}
          aria-hidden="true"
          className="absolute inset-0 bg-shell"
          onClick={dismiss}
        />

        {/* mx-auto + the app column's 30rem cap: the backdrop fills the desktop
            viewport but the controls must not — full-width 66px tiles read as a
            stretched toolbar, not a phone screen. */}
        <div
          ref={panelRef}
          className="relative mx-auto flex min-h-0 w-full max-w-[30rem] flex-1 flex-col overflow-hidden pb-[max(env(safe-area-inset-bottom),18px)] pt-[max(env(safe-area-inset-top),14px)]"
        >
          {/* ── 1. header ─────────────────────────────────────────────────── */}
          <div className="flex shrink-0 items-center gap-2 px-3.5">
            {/* Disabled only while a *cancellable* run is going: there the
                footer's "Cancelar" is the one way out and two of them is one
                too many. A plain re-render is a second of canvas work that
                nothing waits on, and locking the whole header for it leaves
                the screen with no live control at all on a one-page
                document. */}
            <RoundAction
              label={copy.preview.close}
              disabled={dewarp.running}
              onClick={dismiss}
            >
              <XIcon size={20} />
            </RoundAction>
            <span className="flex min-w-0 flex-1 flex-col items-center gap-px">
              <span className="max-w-full truncate font-display text-lg font-semibold leading-tight text-shell-ink">
                {copy.common.page(current.humanNumber)}
              </span>
              <Meta onNight size="xs" className="block max-w-full truncate">
                {copy.preview.ofTotal(
                  pageCount,
                  documentName === null
                    ? copy.preview.documentWord
                    : documentName.toLocaleLowerCase(localeTag(lang)),
                )}
              </Meta>
            </span>
            <RoundAction
              label={copy.preview.menu}
              // Peach for the confirmation only. The plain menu is three
              // ordinary rows — two of them are "sobre" and "detalhes" — and a
              // warn-toned trigger over them announces a consequence that the
              // sheet does not have until Apagar is actually tapped.
              tone={confirmDelete ? "danger" : "neutral"}
              disabled={dewarp.running}
              expanded={menu}
              onClick={() => setMenu(true)}
            >
              <MoreIcon size={20} />
            </RoundAction>
          </div>

          {/* ── 2. status line: one line, 38px, never two ─────────────────── */}
          <div className="flex h-[38px] shrink-0 items-center gap-[7px] px-4">
            {status.tone === "ok" && (
              <span
                aria-hidden="true"
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-mist/[0.22] text-shell-accent"
              >
                <CheckIcon size={10} strokeWidth={2.6} />
              </span>
            )}
            {status.tone === "warn" && (
              <span
                aria-hidden="true"
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-peach-soft/[0.2] text-shell-warn"
              >
                <ExclamationIcon size={11} strokeWidth={2.6} />
              </span>
            )}
            {status.tone === "busy" && (
              <SpinnerIcon size={14} className="text-shell-accent" />
            )}
            <p
              role="status"
              className={clsx(
                "min-w-0 truncate text-xs leading-none",
                status.tone === "warn" ? "text-shell-warn" : "text-shell-ink2",
              )}
            >
              {status.text}
            </p>
            {status.trailing === "elapsed" && (
              <Meta onNight size="xs" className="ml-auto shrink-0">
                {copy.preview.status.elapsed(elapsed)}
              </Meta>
            )}
            {status.trailing === "why" && (
              <button
                type="button"
                onClick={() => setAbout(true)}
                // 44px of tap inside a band whose height is pinned: the button
                // overflows the 38px line box instead of growing it, so the
                // picture below keeps every pixel it had.
                //
                // The hover has to reach the `Meta` inside as well: the word
                // takes its colour from the kit's own tone map, which a colour
                // on the parent cannot beat. The child variant can — it is one
                // specificity step above a plain utility — and the button keeps
                // its own colour for the underline, which is `currentColor`.
                //
                // `[&>span]:hover:`, in that order: Tailwind applies the
                // rightmost variant first, so `hover:[&>span]:` compiles to
                // `>span:hover` — the hover would have to land on the word
                // itself rather than anywhere on the 44 px target.
                className="ml-auto inline-flex h-11 shrink-0 items-center text-shell-ink2 underline underline-offset-4 transition-colors duration-200 [&>span]:transition-colors [&>span]:duration-200 hover:text-shell-ink [&>span]:hover:text-shell-ink"
              >
                <Meta onNight size="xs">
                  {copy.preview.status.why}
                </Meta>
              </button>
            )}
          </div>

          {/* ── 3. the sheet ─────────────────────────────────────────────── */}
          <div className="relative flex min-h-0 flex-1 items-center justify-center gap-2.5 px-[18px]">
            {multiPage && (
              <PagerArrow
                label={copy.preview.pager.previous}
                disabled={index <= 0}
                onClick={() => {
                  const previous = tiles[index - 1];
                  if (previous !== undefined) setCursor(previous.pageId);
                }}
              >
                <ChevronLeftIcon size={16} />
              </PagerArrow>
            )}

            <div
              ref={frameRef}
              className="flex h-full min-w-0 flex-1 items-center justify-center overflow-hidden py-[2px]"
            >
              {source === null ? (
                <p className="text-base text-shell-ink2">{copy.common.loadingPage}</p>
              ) : (
                <PictureSurface
                  comparable={canCompare}
                  pressed={comparing}
                  label={copy.preview.compareHint}
                  disabled={processing}
                  onHold={holdCompare}
                  onRelease={releaseCompare}
                >
                  {/* The turn is GSAP's, on this wrapper: it tweens rotation
                      and the fit scale together, so the page never leaves the
                      frame mid-spin. */}
                  <div
                    ref={spinRef}
                    className="flex h-full w-full items-center justify-center"
                  >
                    <div className="relative flex max-h-full max-w-full">
                      {/* A local object URL — next/image cannot take one. */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        ref={imageRef}
                        src={source}
                        alt={copy.common.page(current.humanNumber)}
                        onLoad={handleImageLoad}
                        // Otherwise a mouse hold on the desktop starts a drag
                        // and the comparison ends with a ghost under the cursor.
                        draggable={false}
                        className="max-h-full max-w-full rounded-[5px] border border-warm/[0.14] object-contain shadow-2xl"
                      />
                      {/* Same box, same geometry: only the finish differs, so
                          the swap reads as one picture changing, not two. */}
                      {rendered !== null && (
                        <PreviewCanvas
                          request={{
                            // The geometry the final ACTUALLY has, not the one
                            // it asked for: a page whose warp failed went in
                            // flat, and cropping the comparison would put two
                            // different documents either side of the flip.
                            canonical: page.canonical,
                            corners: rendered.warped ? page.corners : null,
                            rotation: rendered.rotation,
                            finish: "original",
                          }}
                          cacheKey={`${page.id}:${rendered.revision}`}
                          active={comparing}
                          longEdge={COMPARE_LONG_EDGE}
                          className="pointer-events-none absolute inset-0 h-full w-full rounded-[5px] object-contain"
                        />
                      )}
                    </div>
                  </div>
                </PictureSurface>
              )}
            </div>

            {multiPage && (
              <PagerArrow
                label={copy.preview.pager.next}
                disabled={index >= pageCount - 1}
                onClick={() => {
                  const next = tiles[index + 1];
                  if (next !== undefined) setCursor(next.pageId);
                }}
              >
                <ChevronRightIcon size={16} />
              </PagerArrow>
            )}

            {/* Said once per device, over the control it is about, and gone
                four seconds later. Not a `role="status"`: the same sentence is
                already the picture's own accessible name, and a screen reader
                that announced both would say it twice for one arrival. */}
            {holdTip && canCompare && (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 bottom-2 mx-auto w-fit rounded-full bg-night-deep/[0.72] px-3.5 py-2.5 text-[12.5px] font-semibold leading-none text-warm"
              >
                {copy.preview.holdTip}
              </span>
            )}
          </div>

          {/* ── 4. the explanation card ──────────────────────────────────── */}
          {/* `space-y` rather than a gap on the flow: the two cards can both be
              up (a page that went in flat and whose curvature also had
              something to report), and stacked flush they read as one box with
              a line through it. */}
          <div className={clsx("shrink-0 space-y-2 px-4", showCard && "pt-3")}>
            {cardText !== null && (
              <Notice tone="night">
                {cardText}
                {/* Only on a failed page, where there is no picture left to
                    protect: a render that failed on a transient (a device that
                    refused a 2-D context) usually succeeds on the second ask,
                    and retaking the photo is a much bigger thing to ask. */}
                {failed && (
                  <button
                    type="button"
                    onClick={() => store.retryPage(pageId)}
                    className="mt-1 flex min-h-tap items-center font-semibold text-shell-ink underline underline-offset-4"
                  >
                    {copy.common.retry}
                  </button>
                )}
              </Notice>
            )}
            <DewarpPanel control={dewarp} />
          </div>

          {/* ── 5a. the band: "CORRIGIR ⤢" on one page, the rail on many ─── */}
          {multiPage ? (
            <PageRail
              tiles={tiles}
              cursor={cursor}
              index={index}
              disabled={processing}
              canOpenFull={canOpenFull}
              onSelect={setCursor}
              onOpenFull={() => setFullView(true)}
            />
          ) : (
            <div className="flex shrink-0 items-center justify-between gap-2.5 px-4 pt-3.5">
              <Meta
                caps
                onNight
                size="2xs"
                className={clsx(processing && "opacity-60")}
              >
                {copy.preview.correctLabel}
              </Meta>
              <VerInteiraPill
                disabled={!canOpenFull || processing}
                onClick={() => setFullView(true)}
              />
            </div>
          )}

          {/* ── 5b. the four corrections ─────────────────────────────────── */}
          {/* Dimmed rather than removed while a render runs: a row that
              disappears is a row whose controls move under the thumb. The
              dimming is each tile's own `disabled:` state and nothing else —
              a wrapper opacity on top of it multiplies (0.42 × 0.40 ≈ 0.17)
              and takes the row to the edge of invisible. */}
          <div className="flex shrink-0 gap-[7px] px-4 pt-2.5">
            <CorrectionTile
              label={copy.preview.tiles.rotate}
              ariaLabel={copy.girar.title}
              icon={<RotateIcon size={16} />}
              state={turned ? "applied" : "default"}
              disabled={processing || failed}
              onClick={() => setGirar(true)}
            />
            <CorrectionTile
              label={copy.preview.tiles.corners}
              ariaLabel={copy.preview.adjustCorners}
              icon={<CropIcon size={16} />}
              // The way out of "não achei as bordas", recommended rather than
              // reported — the design's peach-highlighted exit.
              state={current.needsCorners ? "suggested" : "default"}
              disabled={processing}
              onClick={() => onAdjustCorners(current)}
            />
            <DewarpTile control={dewarp} offered={canDewarp && !processing} />
            <CorrectionTile
              label={copy.preview.tiles.finish}
              ariaLabel={copy.finish.title}
              icon={<ContrastIcon size={16} />}
              state={finished ? "applied" : "default"}
              disabled={processing || failed}
              onClick={() => setAcabamento(true)}
            />
          </div>

          {/* ── 6. the footer, which never grows and never moves ─────────── */}
          <div className="flex h-[70px] shrink-0 items-center gap-2.5 px-4 pt-3.5">
            {processing ? (
              // "Cancelar" takes the same slot "Refazer" had. A dewarp is the
              // only render worth stopping — the others are a second or two of
              // canvas work, and a cancel that does nothing is a lie.
              <FooterSecondary
                disabled={!dewarp.running || cancelling}
                onClick={() => {
                  setCancelling(true);
                  store.cancelDewarp(pageId);
                }}
              >
                {cancelling
                  ? copy.preview.dewarp.cancelling
                  : copy.preview.dewarp.cancel}
              </FooterSecondary>
            ) : (
              <FooterSecondary onClick={() => onRetake(current)}>
                {copy.preview.retake}
              </FooterSecondary>
            )}
            <button
              type="button"
              disabled={processing}
              onClick={() => {
                if (!advances) {
                  dismiss();
                  return;
                }
                const next = tiles[index + 1];
                if (next !== undefined) setCursor(next.pageId);
              }}
              className={clsx(
                "inline-flex h-14 flex-1 items-center justify-center gap-2.5 rounded-[14px] px-3",
                "bg-shell-ink text-lg font-bold leading-none text-shell-on",
                "transition-colors duration-200",
                // Hover is applied only when the button is live — a "cancel the
                // hover" utility stacked on the base one is two rules for the
                // same property in the same state, which Tailwind resolves by
                // stylesheet order (the rule `ui.tsx`'s `VARIANT_HOVER` records).
                processing ? "cursor-not-allowed opacity-45" : "hover:bg-cream",
              )}
            >
              {processing ? (
                <>
                  <SpinnerIcon size={15} />
                  {copy.preview.oneMoment}
                </>
              ) : (
                primaryLabel
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Rendered outside the editor's own dialog element on purpose: nested
          inside it, both focus traps would fight over the same Tab and the
          inner one would lose. */}
      {girar && (
        <GirarSheet tile={current} onTurn={setTurning} onClose={closeGirar} />
      )}
      {acabamento && (
        <AcabamentoSheet tile={current} onClose={() => setAcabamento(false)} />
      )}
      {menu && (
        <PageMenu
          humanNumber={current.humanNumber}
          onAbout={() => {
            setMenu(false);
            setAbout(true);
          }}
          onRemove={() => {
            setMenu(false);
            setConfirmDelete(true);
          }}
          onClose={() => setMenu(false)}
        />
      )}
      {confirmDelete && (
        <DeletePageSheet
          humanNumber={current.humanNumber}
          remaining={pageCount - 1}
          onConfirm={() => {
            store.removePage(pageId);
            onClose();
          }}
          onClose={() => setConfirmDelete(false)}
        />
      )}
      {about && <ImprovementsInfoSheet onClose={() => setAbout(false)} />}
      {fullView && page.final !== null && (
        <FullImageView
          blob={page.final}
          humanNumber={current.humanNumber}
          pageCount={pageCount}
          primary={{
            label: primaryLabel,
            onClick: () => {
              setFullView(false);
              if (!advances) {
                // `dismiss` refuses while an inner surface is open, so the
                // close has to wait for the state above to land.
                window.setTimeout(() => dismissRef.current(), 0);
                return;
              }
              const next = tiles[index + 1];
              if (next !== undefined) setCursor(next.pageId);
            },
          }}
          onClose={() => setFullView(false)}
        />
      )}
    </>
  );
}

/**
 * Seconds since the work started, counted only while it is running.
 *
 * The clock is read inside the effect and never during render: this app is a
 * static export, so a component is executed once on a build machine, and a
 * `Date.now()` in its render path is a hydration mismatch waiting for the first
 * phone to load it.
 *
 * `key` is what the seconds are being counted *for* — the page, here. Two pages
 * rendering at once are two runs that started at different moments, and a clock
 * that survives the pager would report one page's wait on the other.
 */
function useElapsedSeconds(active: boolean, key: string): number {
  const [seconds, setSeconds] = React.useState(0);

  React.useEffect(() => {
    if (!active) {
      setSeconds(0);
      return;
    }
    const started = Date.now();
    setSeconds(0);
    const timer = window.setInterval(() => {
      setSeconds(Math.floor((Date.now() - started) / 1_000));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [active, key]);

  return seconds;
}

/**
 * The picture, and the press-and-hold that takes the improvements off it.
 *
 * A `button` when there is something to compare and a plain box when there is
 * not — the gesture people try on a photo is a hold on the photo, and making
 * the whole picture the control is also the only way a keyboard can reach it
 * now that the floating chip is gone (Space and Enter hold it, exactly as the
 * chip did).
 *
 * `touch-none` stops the browser claiming the press for a pan or a double-tap
 * zoom (nothing on this screen scrolls), `select-none` stops the long-press
 * selection halo, and `onContextMenu` stops Android's long-press menu and iOS's
 * "save image" sheet landing on top of the comparison.
 */
function PictureSurface({
  comparable,
  pressed,
  label,
  disabled,
  onHold,
  onRelease,
  children,
}: {
  comparable: boolean;
  pressed: boolean;
  label: string;
  disabled: boolean;
  onHold: () => void;
  onRelease: () => void;
  children: React.ReactNode;
}) {
  if (!comparable) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        {children}
      </div>
    );
  }

  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={label}
      disabled={disabled}
      onPointerDown={onHold}
      onPointerUp={onRelease}
      onPointerCancel={onRelease}
      onPointerLeave={onRelease}
      onBlur={onRelease}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key !== " " && event.key !== "Enter") return;
        // Space would scroll the dialog, and both keys would fire a click on
        // release — this control is a hold, not a toggle.
        event.preventDefault();
        onHold();
      }}
      onKeyUp={(event) => {
        if (event.key !== " " && event.key !== "Enter") return;
        event.preventDefault();
        onRelease();
      }}
      className="flex h-full w-full touch-none select-none items-center justify-center"
    >
      {children}
    </button>
  );
}

/**
 * A 44px circular icon control for the header.
 *
 * The label is always announced — an icon alone says nothing — and the ring is
 * 1.5px so it reads as a control rather than as decoration against a photograph
 * that may be very light right behind it. 44px rather than the app's 56px floor
 * is the contract's documented exception: a row of related icon buttons with a
 * gap between them.
 */
function RoundAction({
  label,
  tone = "neutral",
  disabled = false,
  expanded,
  onClick,
  children,
}: {
  label: string;
  tone?: "neutral" | "danger";
  disabled?: boolean;
  /**
   * Set on a control that opens a surface over the page — it then announces
   * itself as opening a dialog, and says whether that dialog is up. Left
   * undefined by the plain actions, which go somewhere rather than open
   * something.
   */
  expanded?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-haspopup={expanded === undefined ? undefined : "dialog"}
      aria-expanded={expanded}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-[1.5px]",
        "transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-40",
        tone === "danger"
          ? "border-shell-warn text-shell-warn"
          : "border-shell-line text-shell-ink hover:border-shell-ink",
      )}
    >
      {children}
    </button>
  );
}

/**
 * One step through the document, beside the picture.
 *
 * 26 px of visible pill inside a 44 px target: the extra 9 px either side is an
 * `::after` box, so the hit area lands on the picture's own padding without
 * taking a pixel of layout from it — a real 44 px button here would narrow the
 * page by 36 px on a 375 px phone.
 */
function PagerArrow({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        "relative inline-flex h-11 w-[26px] shrink-0 items-center justify-center rounded-lg",
        "border border-shell-line text-shell-ink transition-colors duration-200",
        "hover:border-shell-ink disabled:cursor-not-allowed disabled:opacity-35",
        // `inset-y-0` is load-bearing: with the horizontal inset alone the
        // pseudo-element has no height at all, so the "extra 9 px" is a box of
        // zero area and the target stays 26 px wide.
        "after:absolute after:inset-y-0 after:-inset-x-[9px] after:content-['']",
      )}
    >
      {children}
    </button>
  );
}

/**
 * "⤢ ver inteira" — 34 px of visible pill, hit at 44 px through an `::after`
 * box for the same reason the pager arrows are: this band sits between the
 * picture and the tiles, and every pixel it grows by is a pixel off the page.
 * (The old `?` button in this position cost the picture 10 px before its
 * pull-back was measured exactly; see `ImprovementsInfoSheet`.)
 */
function VerInteiraPill({
  disabled,
  onClick,
}: {
  disabled: boolean;
  onClick: () => void;
}) {
  const copy = useCopy();

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        "relative inline-flex h-[34px] shrink-0 items-center gap-1.5 rounded-full px-3",
        "border border-shell-line text-xs leading-none text-shell-ink",
        "transition-colors duration-200 hover:border-shell-ink",
        "disabled:cursor-not-allowed disabled:opacity-40",
        "after:absolute after:-inset-x-2 after:-inset-y-[5px] after:content-['']",
      )}
    >
      <ExpandIcon size={14} />
      {copy.preview.full.open}
    </button>
  );
}

/**
 * The multi-page band: the document as a strip of thumbnails, the position, and
 * the way into the full-size view.
 *
 * It takes the slot the "CORRIGIR ⤢ ver inteira" row occupies on a single-page
 * document rather than adding a band of its own — the whole point of the fixed
 * structure is that the number of bands does not depend on the document.
 *
 * The thumbnails are 44 px tall (the tap floor's documented exception for a
 * gapped row of related controls) and hit 44 px wide through an `::after` box
 * that meets its neighbour's exactly in the middle of the 10 px gap, never
 * overlapping it. The current page's own thumb is bigger and wears a mist
 * **ring** rather than a border: `PageThumb` already sets `border`, and a
 * second border utility in the same class string is the stylesheet-order coin
 * flip the kit forbids.
 */
function PageRail({
  tiles,
  cursor,
  index,
  disabled,
  canOpenFull,
  onSelect,
  onOpenFull,
}: {
  tiles: readonly PageTile[];
  cursor: string;
  index: number;
  disabled: boolean;
  canOpenFull: boolean;
  onSelect: (pageId: string) => void;
  onOpenFull: () => void;
}) {
  const copy = useCopy();
  const railRef = React.useRef<HTMLDivElement | null>(null);

  // Keep the page being edited in view when the arrows or the primary move the
  // cursor. Written as a scroll offset rather than `scrollIntoView`, which is
  // free to scroll every ancestor it can find — including the app shell this
  // app deliberately locks.
  React.useEffect(() => {
    const rail = railRef.current;
    if (rail === null) return;
    const active = rail.querySelector<HTMLElement>('[data-current="true"]');
    if (active === null) return;
    rail.scrollTo({
      left: active.offsetLeft - (rail.clientWidth - active.offsetWidth) / 2,
      behavior: "smooth",
    });
  }, [cursor]);

  return (
    <div className="flex shrink-0 items-end gap-2.5 px-4 pt-3">
      <div
        ref={railRef}
        // The padding is the room the first thumb's hit extension needs: a
        // scroll container clips whatever overflows its leading edge, and the
        // negative margin puts that padding back where the rail's own `px-4`
        // is, so nothing on screen moves. (The trailing edge needs no such
        // thing — overflow past it is scrollable, not clipped.)
        className="no-scrollbar relative -ml-[5px] flex min-w-0 flex-1 items-end gap-2.5 overflow-x-auto pl-[5px]"
      >
        {tiles.map((tile) => {
          const isCurrent = tile.pageId === cursor;
          return (
            <button
              key={tile.key}
              type="button"
              data-current={isCurrent}
              aria-current={isCurrent ? "true" : undefined}
              aria-label={copy.preview.pager.thumb(tile.humanNumber)}
              onClick={() => onSelect(tile.pageId)}
              className={clsx(
                "relative shrink-0 rounded",
                // `inset-y-0` for the same reason the pager arrows carry it: a
                // pseudo-element with only a horizontal inset is a box of zero
                // height, and the widened target never exists.
                isCurrent
                  ? "ring-2 ring-mist after:absolute after:inset-y-0 after:-inset-x-[2px] after:content-['']"
                  : "after:absolute after:inset-y-0 after:-inset-x-[5px] after:content-['']",
              )}
            >
              <PageThumb
                tile={tile}
                onNight
                radius="sm"
                className={clsx(
                  isCurrent ? "h-[52px] w-10" : "h-11 w-[34px]",
                )}
              />
            </button>
          );
        })}
      </div>

      <div className="flex shrink-0 items-center gap-2 pb-1">
        <Meta onNight size="2xs">
          {copy.preview.pager.count(index + 1, tiles.length)}
        </Meta>
        <button
          type="button"
          aria-label={copy.preview.full.open}
          title={copy.preview.full.open}
          disabled={!canOpenFull || disabled}
          onClick={onOpenFull}
          className={clsx(
            "relative inline-flex h-[34px] w-[34px] items-center justify-center rounded-full",
            "border border-shell-line text-shell-ink transition-colors duration-200",
            "hover:border-shell-ink disabled:cursor-not-allowed disabled:opacity-40",
            "after:absolute after:-inset-[5px] after:content-['']",
          )}
        >
          <ExpandIcon size={15} />
        </button>
      </div>
    </div>
  );
}

/**
 * The footer's fixed 96 px slot — "Refazer" normally, "Cancelar" while
 * something is running. Same box either way, so the primary beside it never
 * moves and the footer never grows.
 */
function FooterSecondary({
  disabled = false,
  onClick,
  children,
}: {
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        "inline-flex h-14 w-24 shrink-0 items-center justify-center whitespace-nowrap rounded-[14px]",
        "border-[1.5px] border-shell-line text-sm font-semibold text-shell-ink",
        "transition-colors duration-200 hover:border-shell-ink",
        "disabled:cursor-not-allowed disabled:opacity-40",
      )}
    >
      {children}
    </button>
  );
}
