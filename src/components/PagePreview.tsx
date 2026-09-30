"use client";

import * as React from "react";
import clsx from "clsx";
import { useStore } from "@/hooks/useScanStore";
import { useDialogChrome } from "@/hooks/useDialogChrome";
import { useScanRuntime } from "@/hooks/useScanRuntime";
import { usePageTurn } from "@/hooks/usePageTurn";
import { usePageView } from "@/hooks/usePageView";
import { useRotatedFit } from "@/hooks/useRotatedFit";
import { overlayIn, overlayOut, prefersReducedMotion } from "@/lib/motion";
import { dragOffset, HOLD_MS, inEdgeZone, pressIntent, swipeStep } from "@/lib/page-swipe";
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
import { PageThumb } from "@/components/PageThumb";
import { PreviewCanvas } from "@/components/PreviewCanvas";
import { hasSeenCompareTip, markCompareTipSeen } from "@/lib/tips";
import {
  createPendingRemoval,
  landingAfterRemoval,
  UNDO_MS,
  withoutHeld,
  type HeldPage,
  type PendingRemoval,
} from "@/lib/page-undo";
import type { PageTile } from "@/lib/page-tiles";
import { displayRotation, effectiveFinish } from "@/lib/scan-store";
import { useCopy } from "@/components/I18n";
import { Meta } from "@/components/ui";
import {
  CameraIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ContrastIcon,
  CropIcon,
  ExclamationIcon,
  InfoIcon,
  RotateIcon,
  SpinnerIcon,
  TrashIcon,
  XIcon,
} from "@/components/icons";

/**
 * The page editor — "E3 · Deslizar + Editar" (owner-approved, 2026-09-29).
 *
 * One fixed structure, every state, top to bottom:
 *
 *  1. **the way out and the bin** — × top-left, delete top-right. The bin
 *     deletes at once and a toast offers "Desfazer" for a few seconds
 *     (`lib/page-undo.ts`: the page is held out of the document, not removed,
 *     until the toast goes or the editor does); never a browser dialog;
 *  2. **the page**, large and centred, absorbing whatever height is left. With
 *     more than one page it *is* the pager: swipe left and right, the
 *     neighbours peeking at the edges. A tap opens it whole; a hold shows it
 *     without the improvements;
 *  3. **"Página N de M"** with a small (i) beside it — "Sobre as melhorias",
 *     on any page — and "deslize para ver as outras" when M > 1. The position
 *     is also the pager's live announcement;
 *  4. **the status line** — the ONE place on this screen that talks about
 *     state, composed here at render from `rendered.*` and
 *     {@link effectiveFinish} (the store keeps codes, never sentences). It is
 *     silent on a page that is fine; a flagged page, a run in flight or a turn
 *     being narrated gets one short line, with its "por quê?" or "tentar de
 *     novo" beside it. Its height is reserved, so nothing moves when it speaks;
 *  5. **the curvature card**, the one band allowed to appear and disappear —
 *     consent and the honest outcome of a straightening need a paragraph;
 *  6. **four tools**, icon over word — Girar, Cantos, Endireitar, Acabamento —
 *     opening the same sheets and switch they always did;
 *  7. **the footer**, fixed — Refazer (Cancelar while a straightening runs) and
 *     the primary, and neither of them ever moves.
 *
 * ## The pager
 *
 * With more than one page the editor keeps its own cursor: the swipe, the
 * arrow keys and two pager buttons (visually hidden until they take keyboard
 * focus) move it, and the primary reads "Próxima página" until the last page.
 * The hosts still hand it the page that was tapped. Re*ordering* is
 * deliberately not here — moving a page is a comparison between rows, and you
 * cannot compare rows from inside one of them.
 *
 * **Girar and Acabamento are two sheets**, not two doors onto one. They open
 * over the page they change, and the page keeps rendering behind them.
 *
 * Modal hygiene per the a11y bar: focus moves in and is trapped, Escape closes
 * the innermost surface first, no history entry is pushed, and `touch-none` on
 * the stage keeps the swipe and the hold from being claimed as a pan.
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
  const store = useStore();
  const { diagnosticsSink } = useScanRuntime();
  const backdropRef = React.useRef<HTMLDivElement | null>(null);
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const closingRef = React.useRef(false);

  // ── the cursor ────────────────────────────────────────────────────────────
  //
  // The page id rather than its index: a delete elsewhere in the document would
  // silently move an index onto a different page.
  const [cursor, setCursor] = React.useState(tile.pageId);

  // ── the delete, and its undo ──────────────────────────────────────────────
  //
  // The bin holds the page out of the document; the store keeps it, untouched,
  // until the toast runs out, another page is deleted, or the editor goes away
  // (`lib/page-undo.ts`). Created in the effect, not in render: a StrictMode
  // remount disposes the first one, and a disposed hold commits at once.
  const [held, setHeld] = React.useState<HeldPage | null>(null);
  const removalRef = React.useRef<PendingRemoval | null>(null);
  React.useEffect(() => {
    const removal = createPendingRemoval({
      commit: (id) => store.removePage(id),
      onChange: setHeld,
    });
    removalRef.current = removal;
    return () => {
      removalRef.current = null;
      removal.dispose();
    };
  }, [store]);
  /** The document as this editor shows it: without the held page, renumbered. */
  const shown = React.useMemo(
    () => withoutHeld(tiles, held?.pageId ?? null),
    [tiles, held],
  );
  /** The last page was deleted and its undo is still on offer. */
  const emptied = shown.length === 0;

  // A cursor that no longer names a page (deleted from under the editor) falls
  // back to the first one rather than to -1, which would leave the pager
  // counting from zero and the arrows reaching past both ends.
  const found = shown.findIndex((candidate) => candidate.pageId === cursor);
  const index = found === -1 ? 0 : found;
  // With nothing left on show, the held page keeps the hooks below fed; the
  // screen draws the empty state instead of it.
  const current =
    shown[index] ?? tiles.find((candidate) => candidate.pageId === held?.pageId) ?? tile;
  const pageCount = shown.length;
  const multiPage = pageCount > 1;

  // …and the fallback is written back, so the rail, the arrows and the primary
  // agree with the page on screen. Without it the cursor keeps naming a page
  // that is gone: the editor shows page 1 while the rail highlights nothing and
  // "‹" believes there is something to its left.
  React.useEffect(() => {
    const first = shown[0];
    if (found === -1 && first !== undefined) setCursor(first.pageId);
  }, [found, shown]);

  // ── the surfaces this one can open over itself ────────────────────────────
  const [fullView, setFullView] = React.useState(false);
  const [girar, setGirar] = React.useState(false);
  const [acabamento, setAcabamento] = React.useState(false);
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

  // A document with no pages left leaves nothing to edit — counted on the
  // host's list, not on the one shown: the last page held for its undo still
  // counts, and the editor closes onto the empty document only once the hold
  // is made real.
  React.useEffect(() => {
    if (tiles.length === 0) onClose();
  }, [tiles.length, onClose]);

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
    trailing: "elapsed" | "why" | "retry" | null;
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
        ? { tone: "warn", text: copy.preview.failedLine, trailing: "retry" }
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

  // ── the footer ────────────────────────────────────────────────────────────
  const isLast = index >= pageCount - 1;
  const advances = multiPage && !isLast && !failed;
  const primaryLabel = failed
    ? copy.preview.closeAction
    : advances
      ? copy.preview.nextPage
      : copy.preview.useAsIs;

  /**
   * The finish and the turn the page is really wearing, for the two tools that
   * report a standing choice. `rendered.*` first, per the requested-vs-effective
   * rule: a tool is a claim about the page, not about the request.
   */
  const turned = (rendered?.rotation ?? page.rotation) !== 0;
  const finished = effectiveFinish(page) !== "original";
  /** A dimmed tool says why; an applied one says so (its dot is decoration). */
  const notes = copy.preview.toolNotes;
  const toolNote = (applied: boolean): string | undefined =>
    failed ? notes.failed : processing ? notes.busy : applied ? notes.applied : undefined;

  // ── paging: the swipe, the keys, the buttons and the primary ─────────────
  //
  // One way to move, however it was asked for: the page slides out the way it
  // was pushed and its neighbour slides in from the other side. Under reduced
  // motion it simply changes.
  const [slide, setSlide] = React.useState<{ x: number; animate: boolean }>({ x: 0, animate: false });
  const stageRef = React.useRef<HTMLDivElement | null>(null);
  /** When the stage last handled a pointer gesture — so the click it trails is not a second one. */
  const gestureAt = React.useRef(0);
  const slideTimer = React.useRef<number | null>(null);
  React.useEffect(
    () => () => {
      if (slideTimer.current !== null) window.clearTimeout(slideTimer.current);
    },
    [],
  );
  /**
   * The page a slide in flight is heading for, so a second step taken before it
   * lands (a quick →→) counts from there rather than from the page still on
   * screen.
   */
  const headingRef = React.useRef<number | null>(null);
  const goTo = React.useCallback(
    (step: -1 | 1) => {
      const to = (headingRef.current ?? index) + step;
      const target = shown[to];
      if (target === undefined) return;
      if (slideTimer.current !== null) window.clearTimeout(slideTimer.current);
      slideTimer.current = null;
      const width = stageRef.current?.clientWidth ?? 0;
      if (prefersReducedMotion() || width === 0) {
        headingRef.current = null;
        setSlide({ x: 0, animate: false });
        setCursor(target.pageId);
        return;
      }
      headingRef.current = to;
      // Out the way it was pushed…
      setSlide({ x: -step * width, animate: true });
      slideTimer.current = window.setTimeout(() => {
        // …and the neighbour in from the other side.
        setCursor(target.pageId);
        setSlide({ x: step * width, animate: false });
        slideTimer.current = window.setTimeout(() => {
          slideTimer.current = null;
          headingRef.current = null;
          setSlide({ x: 0, animate: true });
        }, 20);
      }, SLIDE_MS);
    },
    [index, shown],
  );

  // ←/→ page, wherever focus is on the editor — or nowhere, which is where a
  // swipe can leave it when the picture under the finger is replaced. Not
  // while a sheet is open over the page: its keys are its own.
  const goToRef = React.useRef(goTo);
  goToRef.current = goTo;
  React.useEffect(() => {
    if (!multiPage) return;
    function onKey(event: KeyboardEvent): void {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) return;
      if (innerRef.current !== null) return;
      const root = containerRef.current;
      const target = event.target;
      if (root === null || !(target instanceof Node)) return;
      if (target !== document.body && !root.contains(target)) return;
      event.preventDefault();
      goToRef.current(event.key === "ArrowLeft" ? -1 : 1);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [containerRef, multiPage]);

  /**
   * The bin. A slide still in flight is settled first, on the page it was
   * heading for — the one about to be on screen — and *that* page, by id, is
   * the one deleted, so a swipe and a quick tap on the bin can never delete a
   * page other than the one the user was landing on. The editor then lands on
   * the page that slid into its place (or the one before, after the last).
   */
  const deleteRef = React.useRef<HTMLButtonElement | null>(null);
  const closeRef = React.useRef<HTMLButtonElement | null>(null);
  const deletePage = () => {
    const removal = removalRef.current;
    if (removal === null || emptied) return;
    let target = current;
    if (headingRef.current !== null) {
      const heading = shown[headingRef.current];
      if (heading !== undefined) target = heading;
    }
    if (slideTimer.current !== null) window.clearTimeout(slideTimer.current);
    slideTimer.current = null;
    headingRef.current = null;
    setSlide({ x: 0, animate: false });
    const landing = landingAfterRemoval(shown, target.pageId);
    removal.remove({ pageId: target.pageId, humanNumber: target.humanNumber });
    diagnosticsSink?.emit({ type: "page", action: "removed", page: target.humanNumber });
    if (landing !== null) setCursor(landing);
  };

  /** "Desfazer": the page is back where it was, with everything it had, and on screen. */
  const undoDelete = () => {
    const page = removalRef.current?.undo() ?? null;
    if (page === null) return;
    setCursor(page.pageId);
    diagnosticsSink?.emit({ type: "page", action: "undone", page: page.humanNumber });
    // The button that had focus is gone with the toast; the bin is where the
    // user was a moment ago.
    window.setTimeout(() => deleteRef.current?.focus(), 0);
  };

  // Emptied: the bin has nothing left to delete, so focus goes to the way out.
  React.useEffect(() => {
    if (emptied) closeRef.current?.focus();
  }, [emptied]);

  const advance = () => {
    if (!advances) {
      dismiss();
      return;
    }
    goTo(1);
  };

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
            viewport but the controls must not. */}
        <div
          ref={panelRef}
          className="relative mx-auto flex min-h-0 w-full max-w-[30rem] flex-1 flex-col overflow-hidden pb-[max(env(safe-area-inset-bottom),18px)] pt-[max(env(safe-area-inset-top),14px)]"
        >
          {/* ── 1. the way out, and the bin ───────────────────────────────── */}
          {/* Both disabled only while a *cancellable* run is going: there the
              footer's "Cancelar" is the one way out and two of them is one too
              many. A plain re-render is a second of canvas work that nothing
              waits on. */}
          <div className="flex shrink-0 items-center justify-between px-4 pt-1.5">
            <RoundAction
              buttonRef={closeRef}
              label={copy.preview.close}
              disabled={dewarp.running}
              onClick={dismiss}
            >
              <XIcon size={20} />
            </RoundAction>
            <RoundAction
              buttonRef={deleteRef}
              label={copy.preview.deletePage}
              disabled={dewarp.running || emptied}
              onClick={deletePage}
            >
              <TrashIcon size={20} />
            </RoundAction>
          </div>

          {emptied ? (
            <>
              {/* The last page went: the document is empty while its undo is
                  on offer, and the editor closes onto it when the toast goes. */}
              <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
                <p className="text-[15px] font-semibold leading-tight text-shell-ink">
                  {copy.preview.emptied.title}
                </p>
                <p className="text-[13px] leading-snug text-shell-ink2">
                  {copy.preview.emptied.body}
                </p>
                <UndoToast held={held} removalRef={removalRef} onUndo={undoDelete} />
              </div>
              <div className="flex shrink-0 items-center px-4 pt-2.5">
                <button
                  type="button"
                  onClick={dismiss}
                  className="inline-flex h-14 min-w-0 flex-1 items-center justify-center rounded-full bg-shell-ink px-3 text-[17px] font-bold leading-none text-shell-on transition-colors duration-200 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-cream"
                >
                  {copy.preview.closeAction}
                </button>
              </div>
            </>
          ) : (
          <>

          {/* ── 2. the page — and, with more than one, the pager ──────────── */}
          <PageStage
            stageRef={stageRef}
            slide={slide}
            onDrag={(x) => setSlide({ x, animate: false })}
            onSnapBack={() => setSlide({ x: 0, animate: true })}
            onSwipe={goTo}
            canPrev={index > 0}
            canNext={index < pageCount - 1}
            holdable={canCompare && !processing}
            onHold={holdCompare}
            onRelease={releaseCompare}
            onTap={canOpenFull ? () => setFullView(true) : null}
            gestureAt={gestureAt}
            previous={shown[index - 1]}
            next={shown[index + 1]}
            overlay={
              <>
                {multiPage && (
                  <>
                <PagerButton
                  side="left"
                  label={copy.preview.pager.previous}
                  disabled={index <= 0}
                  onClick={() => goTo(-1)}
                >
                  <ChevronLeftIcon size={18} />
                </PagerButton>
                <PagerButton
                  side="right"
                  label={copy.preview.pager.next}
                  disabled={index >= pageCount - 1}
                  onClick={() => goTo(1)}
                >
                  <ChevronRightIcon size={18} />
                </PagerButton>
                  </>
                )}
                {canCompare && (
                  <CompareToggle
                    label={copy.preview.compareToggle(comparing)}
                    pressed={comparing}
                    disabled={processing}
                    onClick={comparing ? releaseCompare : holdCompare}
                  />
                )}
                {/* Said once per device, over the control it is about, and
                    gone four seconds later. Not a `role="status"`: the same
                    sentence is already the picture's own accessible name. */}
                <UndoToast held={held} removalRef={removalRef} onUndo={undoDelete} />
                {holdTip && canCompare && held === null && (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-0 bottom-2 z-10 mx-auto w-fit rounded-full bg-night-deep/[0.72] px-3.5 py-2.5 text-[12.5px] font-semibold leading-none text-warm"
                  >
                    {copy.preview.holdTip}
                  </span>
                )}
              </>
            }
          >
            {/* The padding is the room the neighbours peek into; it is outside
                the measured frame so the fit is computed on the page's box. */}
            <div className="flex h-full min-w-0 flex-1 px-[60px]">
            <div
              ref={frameRef}
              className="flex h-full min-w-0 flex-1 items-center justify-center overflow-hidden py-[2px]"
            >
              {source === null ? (
                <p className="text-base text-shell-ink2">{copy.common.loadingPage}</p>
              ) : (
                <PictureSurface
                  gestureAt={gestureAt}
                  label={copy.preview.surfaceLabel(current.humanNumber, canOpenFull, canCompare)}
                  interactive={canOpenFull || canCompare}
                  pressed={canCompare ? comparing : undefined}
                  onOpen={canOpenFull ? () => setFullView(true) : null}
                  onHold={canCompare && !processing ? holdCompare : null}
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
                        className="max-h-full max-w-full rounded-[3px] object-contain shadow-[0_14px_36px_rgba(0,0,0,0.45)]"
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
                          className="pointer-events-none absolute inset-0 h-full w-full rounded-[3px] object-contain"
                        />
                      )}
                    </div>
                  </div>
                </PictureSurface>
              )}
            </div>
            </div>
          </PageStage>

          {/* ── 3. where we are ──────────────────────────────────────────── */}
          <div className="flex shrink-0 flex-col items-center gap-1 px-4 pt-3.5 text-center">
            {/* The (i) is balanced by an empty box of its width on the other
                side, so "Página N de M" stays centred under the page. */}
            <div className="flex items-center justify-center gap-1.5">
              <span aria-hidden="true" className="h-6 w-6 shrink-0" />
              <p
                aria-live="polite"
                aria-atomic="true"
                className="text-[15px] font-semibold leading-tight text-shell-ink"
              >
                {copy.preview.position(index + 1, pageCount)}
              </p>
              <InfoButton
                label={copy.preview.aboutButton}
                onClick={() => setAbout(true)}
              />
            </div>
            {multiPage && (
              <p className="text-[13px] leading-tight text-shell-ink2">
                {copy.preview.swipeHint}
              </p>
            )}
          </div>

          {/* ── 4. the status line: silent when the page is fine ──────────── */}
          {/* The height is reserved either way: a line that appears and
              disappears would resize the page under a turn in flight. */}
          <div className="flex h-8 shrink-0 items-center justify-center gap-[7px] px-4">
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
                "min-w-0 truncate text-[13px] leading-none",
                status.tone === "warn" ? "font-semibold text-shell-warn" : "text-shell-ink2",
              )}
            >
              {status.tone === "ok" ? "" : status.text}
            </p>
            {status.trailing === "elapsed" && (
              <Meta onNight size="xs" className="shrink-0">
                {copy.preview.status.elapsed(elapsed)}
              </Meta>
            )}
            {status.trailing === "why" && (
              <InlineAction onClick={() => setAbout(true)}>
                {copy.preview.status.why}
              </InlineAction>
            )}
            {status.trailing === "retry" && (
              // Only on a failed page, where there is no picture left to
              // protect: a render that failed on a transient (a device that
              // refused a 2-D context) usually succeeds on the second ask,
              // and retaking the photo is a much bigger thing to ask.
              <InlineAction onClick={() => store.retryPage(pageId)}>
                {copy.common.retry}
              </InlineAction>
            )}
          </div>

          {/* ── 5. the curvature card ────────────────────────────────────── */}
          {/* A run in flight is the status line's business, and `DewarpPanel`
              draws only its screen-reader description while it lasts — so the
              band must not keep its padding open around nothing. */}
          <div className={clsx("shrink-0 px-4", dewarpPanelVisible(dewarp) && !dewarp.running && "pb-1")}>
            <DewarpPanel control={dewarp} />
          </div>

          {/* ── 6. the four tools ────────────────────────────────────────── */}
          {/* Dimmed rather than removed while a render runs: a row that
              disappears is a row whose controls move under the thumb. */}
          {/* Four columns down to 340 px; narrower (a 200 % zoom on a phone is
              ~210 px) two rows of two, so no word is cut. */}
          <div className="grid shrink-0 grid-cols-4 gap-1 px-4 pt-1 max-[339px]:grid-cols-2">
            <CorrectionTile
              label={copy.preview.tiles.rotate}
              ariaLabel={copy.girar.title}
              icon={<RotateIcon size={22} />}
              state={turned ? "applied" : "default"}
              disabled={processing || failed}
              note={toolNote(turned)}
              onClick={() => setGirar(true)}
            />
            <CorrectionTile
              label={copy.preview.tiles.corners}
              ariaLabel={copy.preview.adjustCorners}
              icon={<CropIcon size={22} />}
              // The way out of "não achei as bordas", recommended rather than
              // reported.
              state={current.needsCorners ? "suggested" : "default"}
              disabled={processing}
              note={
                processing
                  ? notes.busy
                  : current.needsCorners
                    ? notes.suggested
                    : undefined
              }
              onClick={() => onAdjustCorners(current)}
            />
            <DewarpTile
              control={dewarp}
              offered={canDewarp && !processing}
              unavailableNote={
                failed ? notes.failed : processing ? notes.busy : notes.noCorners
              }
            />
            <CorrectionTile
              label={copy.preview.tiles.finish}
              ariaLabel={copy.finish.title}
              icon={<ContrastIcon size={22} />}
              state={finished ? "applied" : "default"}
              disabled={processing || failed}
              note={toolNote(finished)}
              onClick={() => setAcabamento(true)}
            />
          </div>

          {/* ── 7. the footer, which never grows and never moves ─────────── */}
          {/* Side by side down to 340 px; narrower, stacked, the primary on top. */}
          <div className="flex shrink-0 items-center gap-2.5 px-4 pt-2.5 max-[339px]:flex-col-reverse max-[339px]:items-stretch max-[339px]:gap-2">
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
              <FooterSecondary
                icon={<CameraIcon size={20} />}
                onClick={() => onRetake(current)}
              >
                {copy.preview.retake}
              </FooterSecondary>
            )}
            <button
              type="button"
              disabled={processing}
              onClick={advance}
              className={clsx(
                "inline-flex h-14 min-w-0 flex-1 items-center justify-center gap-2.5 rounded-full px-3 text-center",
                "max-[339px]:h-auto max-[339px]:min-h-14 max-[339px]:flex-none max-[339px]:py-2",
                "bg-shell-ink text-[17px] font-bold leading-none text-shell-on",
                "transition-colors duration-200",
                // Hover is applied only when the button is live — a "cancel the
                // hover" utility stacked on the base one is two rules for the
                // same property in the same state (`ui.tsx`'s `VARIANT_HOVER`).
                processing ? "cursor-not-allowed opacity-45" : "[@media(hover:hover)_and_(pointer:fine)]:hover:bg-cream",
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
          </>
          )}
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
              goTo(1);
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

/** How long the page takes to slide out (and its neighbour in). */
const SLIDE_MS = 200;

type Gesture = {
  id: number;
  x: number;
  y: number;
  t: number;
  mode: "pending" | "swipe" | "hold" | "other";
  timer: number | null;
  /** Whether it went down on the page itself — a tap anywhere else opens nothing. */
  onSurface: boolean;
};

/**
 * The page's stage: the swipe, the tap and the hold, told apart here.
 *
 * One pointer, three meanings, decided by what it does first: moving sideways
 * past the slop is a swipe (the page follows the finger, resisting
 * at the ends), staying still for {@link HOLD_MS} is the compare hold, and
 * letting go before either on the page itself is a tap — the page opens
 * whole. The arithmetic is `lib/page-swipe.ts`'s. The hold used to start on touch-down; it waits a beat now so a swipe
 * does not flash the un-improved page at its start.
 *
 * `touch-action: pinch-zoom` stops the browser claiming one finger for a pan
 * or a double-tap zoom (nothing on this screen scrolls) while leaving it the
 * two-finger pinch — a second finger abandons the page gesture, so zooming
 * never turns the page. A touch starting in the edge zone
 * ({@link inEdgeZone}) is left to the system's back gesture. `select-none` stops the long-press
 * selection halo, and `onContextMenu` stops Android's long-press menu and iOS's
 * "save image" sheet landing on top of the comparison.
 *
 * The neighbours peek 20 px in from the edges at half strength — the design's
 * cue that there is something to swipe to — and ride along with the drag.
 */
function PageStage({
  stageRef,
  slide,
  onDrag,
  onSnapBack,
  onSwipe,
  canPrev,
  canNext,
  holdable,
  onHold,
  onRelease,
  onTap,
  gestureAt,
  previous,
  next,
  overlay,
  children,
}: {
  stageRef: React.RefObject<HTMLDivElement | null>;
  slide: { x: number; animate: boolean };
  onDrag: (x: number) => void;
  onSnapBack: () => void;
  onSwipe: (step: -1 | 1) => void;
  canPrev: boolean;
  canNext: boolean;
  holdable: boolean;
  onHold: () => void;
  onRelease: () => void;
  onTap: (() => void) | null;
  gestureAt: React.MutableRefObject<number>;
  previous: PageTile | undefined;
  next: PageTile | undefined;
  /** Drawn over the stage and not moved by the slide: the pager buttons, the tip. */
  overlay: React.ReactNode;
  children: React.ReactNode;
}) {
  const gesture = React.useRef<Gesture | null>(null);
  const clear = React.useCallback(() => {
    const g = gesture.current;
    if (g !== null && g.timer !== null) window.clearTimeout(g.timer);
    gesture.current = null;
  }, []);
  React.useEffect(() => clear, [clear]);
  const swipeable = canPrev || canNext;

  /** Drop the gesture in progress without acting on it. */
  const abandon = () => {
    const g = gesture.current;
    if (g === null) return;
    clear();
    gestureAt.current = performance.now();
    if (g.mode === "hold") onRelease();
    else if (g.mode === "swipe") onSnapBack();
  };

  const finish = (event: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    if (!event.isPrimary) return;
    const g = gesture.current;
    if (g === null || g.id !== event.pointerId) return;
    clear();
    gestureAt.current = performance.now();
    if (g.mode === "hold") {
      onRelease();
      return;
    }
    if (g.mode === "swipe") {
      const step = swipeStep({
        dx: event.clientX - g.x,
        ms: performance.now() - g.t,
        width: stageRef.current?.clientWidth ?? 0,
        canPrev,
        canNext,
        cancelled,
      });
      if (step !== null) onSwipe(step);
      else onSnapBack();
      return;
    }
    // (The pointer is captured by the stage, so `event.target` here is the
    // stage itself — where it went down is what says it was the page.)
    if (g.mode === "pending" && !cancelled && g.onSurface && onTap !== null) onTap();
  };

  return (
    <div
      ref={stageRef}
      className="relative flex min-h-0 flex-1 select-none items-center overflow-hidden pt-3 [touch-action:pinch-zoom]"
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        // The pager buttons and the undo toast are controls of their own: a
        // capture here would take their click away.
        if (event.target instanceof Element && event.target.closest("[data-pager], [data-undo-toast]") !== null) return;
        // A second finger is a pinch, not a page gesture: whatever the first
        // one started ends here (a hold lets go, a drag snaps back) and the
        // browser has the pinch.
        if (!event.isPrimary) {
          abandon();
          return;
        }
        // A touch that starts in the platform's edge-swipe zone is the
        // system's back gesture, not a page turn.
        if (event.pointerType === "touch" && inEdgeZone(event.clientX, window.innerWidth)) {
          clear();
          return;
        }
        clear();
        const g: Gesture = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          t: performance.now(),
          mode: "pending",
          timer: null,
          onSurface: event.target instanceof Element && event.target.closest("[data-page-surface]") !== null,
        };
        if (holdable) {
          g.timer = window.setTimeout(() => {
            g.timer = null;
            if (gesture.current === g && g.mode === "pending") {
              g.mode = "hold";
              onHold();
            }
          }, HOLD_MS);
        }
        gesture.current = g;
        // The page's pointer, wherever the finger goes, until it lets go.
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // A pointer the browser already let go of — nothing to keep.
        }
      }}
      onPointerMove={(event) => {
        const g = gesture.current;
        if (g === null || g.id !== event.pointerId) return;
        const dx = event.clientX - g.x;
        const dy = event.clientY - g.y;
        if (g.mode === "pending") {
          const intent = pressIntent(dx, dy, swipeable);
          if (intent === "pending") return;
          if (g.timer !== null) {
            window.clearTimeout(g.timer);
            g.timer = null;
          }
          g.mode = intent;
        }
        if (g.mode === "swipe") onDrag(dragOffset(dx, canPrev, canNext));
      }}
      onPointerUp={(event) => finish(event, false)}
      onPointerCancel={(event) => finish(event, true)}
    >
      <div
        className="relative flex h-full w-full items-center"
        style={{
          transform: slide.x === 0 ? undefined : `translate3d(${Math.round(slide.x)}px,0,0)`,
          transition: slide.animate ? `transform ${SLIDE_MS}ms cubic-bezier(0.3,0,0.2,1)` : undefined,
        }}
      >
        {previous !== undefined && <Peek tile={previous} side="left" />}
        {children}
        {next !== undefined && <Peek tile={next} side="right" />}
      </div>
      {overlay}
    </div>
  );
}

/** A neighbour, 20 px of it at the stage's edge, at half strength. Decoration only. */
function Peek({ tile, side }: { tile: PageTile; side: "left" | "right" }) {
  return (
    <div
      aria-hidden="true"
      className={clsx(
        "pointer-events-none absolute top-1/2 aspect-[5/7] h-[78%] -translate-y-1/2 opacity-50",
        side === "left" ? "right-[calc(100%-20px)]" : "left-[calc(100%-20px)]",
      )}
    >
      <PageThumb tile={tile} onNight radius="sm" className="h-full w-full" />
    </div>
  );
}

/**
 * The picture, as a control for the keyboard and for assistive technology.
 *
 * Pointers are the stage's business ({@link PageStage}); this is the same two
 * meanings for everything else: Enter (or an assistive "activate") opens the
 * page whole, and Space held down shows it without the improvements, exactly as
 * the old chip did. A click that trails a pointer gesture the stage already
 * handled is ignored, so a tap never opens the page twice.
 *
 * A plain box when there is nothing to open and nothing to compare.
 */
function PictureSurface({
  label,
  interactive,
  pressed,
  onOpen,
  onHold,
  onRelease,
  gestureAt,
  children,
}: {
  label: string;
  interactive: boolean;
  /** `aria-pressed` while there is something to compare; undefined otherwise. */
  pressed: boolean | undefined;
  onOpen: (() => void) | null;
  onHold: (() => void) | null;
  onRelease: () => void;
  gestureAt: React.MutableRefObject<number>;
  children: React.ReactNode;
}) {
  if (!interactive) {
    return (
      <div data-page-surface className="flex h-full w-full items-center justify-center">
        {children}
      </div>
    );
  }

  return (
    <button
      type="button"
      data-page-surface
      aria-label={label}
      aria-pressed={pressed}
      onClick={() => {
        if (performance.now() - gestureAt.current < 600) return;
        onOpen?.();
      }}
      onBlur={onRelease}
      onKeyDown={(event) => {
        if (event.key !== " ") return;
        // Space would scroll the dialog and fire a click on release — this
        // key is a hold, not a toggle.
        event.preventDefault();
        if (!event.repeat) onHold?.();
      }}
      onKeyUp={(event) => {
        if (event.key !== " ") return;
        event.preventDefault();
        onRelease();
      }}
      className="flex h-full w-full items-center justify-center"
    >
      {children}
    </button>
  );
}

/**
 * A 44 px round icon control for the top row: a filled disc, no ring, the
 * label always announced (an icon alone says nothing).
 */
function RoundAction({
  label,
  disabled = false,
  buttonRef,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  buttonRef?: React.Ref<HTMLButtonElement>;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-shell-sunken text-shell-ink",
        "transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-40",
        "[@media(hover:hover)_and_(pointer:fine)]:hover:text-shell-ink2",
      )}
    >
      {children}
    </button>
  );
}

/**
 * "Sobre as melhorias": a small (i) beside "Página N de M" that opens the
 * explanation on any page — a fine one included, which had no way to it once
 * the ⋯ menu went. 24 px drawn, 44 px hit (the `after:` box), so it can sit in
 * the position line without making it taller. A flagged page keeps its
 * "por quê?" as well: that one answers the line it sits in.
 */
function InfoButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-haspopup="dialog"
      title={label}
      data-about-button
      onClick={onClick}
      className={clsx(
        "relative inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-shell-ink2",
        "transition-colors duration-200 [@media(hover:hover)_and_(pointer:fine)]:hover:text-shell-ink",
        "after:absolute after:-inset-[10px] after:content-['']",
      )}
    >
      <InfoIcon size={18} />
    </button>
  );
}

/**
 * "Página excluída · Desfazer" — the delete's way back, over the foot of the
 * page for {@link UNDO_MS}.
 *
 * The live region is always in the tree (a region that appears together with
 * its words is announced unreliably); the pill inside it comes and goes. While
 * it is held — keyboard focus inside it, or a mouse over it — the countdown
 * stops, and it starts over in full when let go: a toast must not vanish from
 * under the control someone is on. No motion of its own, so there is nothing
 * for reduced motion to switch off.
 */
function UndoToast({
  held,
  removalRef,
  onUndo,
}: {
  held: HeldPage | null;
  removalRef: React.MutableRefObject<PendingRemoval | null>;
  onUndo: () => void;
}) {
  const copy = useCopy().preview.undoDelete;
  const pause = (paused: boolean) => removalRef.current?.pause(paused);
  // A toast that goes while held (undone, or replaced by the next delete)
  // must not leave the countdown stopped for the next one.
  React.useEffect(() => {
    if (held === null) return;
    return () => removalRef.current?.pause(false);
  }, [held, removalRef]);
  return (
    <div
      role="status"
      data-undo-toast
      className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-4"
    >
      {held !== null && (
        <div
          className="pointer-events-auto inline-flex min-h-11 max-w-full items-center gap-1 rounded-full bg-night-deep/[0.92] py-0.5 pl-4 pr-1 text-[14px] font-semibold leading-tight text-warm shadow-[0_8px_24px_rgba(0,0,0,0.35)]"
          onFocus={() => pause(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) pause(false);
          }}
          onPointerEnter={(event) => {
            if (event.pointerType === "mouse") pause(true);
          }}
          onPointerLeave={(event) => {
            if (event.pointerType === "mouse") pause(false);
          }}
        >
          <span className="min-w-0">{copy.message}</span>
          <span aria-hidden="true" className="text-shell-ink2">
            ·
          </span>
          <button
            type="button"
            aria-label={copy.actionLabel(held.humanNumber)}
            data-undo-button
            onClick={onUndo}
            className="inline-flex min-h-11 shrink-0 items-center rounded-full px-3 font-bold text-cream underline underline-offset-4"
          >
            {copy.action}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * One step through the document, for the keyboard and screen readers: out of
 * sight until it takes keyboard focus, then a 44 px disc at the stage's edge.
 * The swipe is the gesture; this is its equivalent (so are ← and →).
 */
function PagerButton({
  side,
  label,
  disabled,
  onClick,
  children,
}: {
  side: "left" | "right";
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-pager
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        "sr-only focus-visible:not-sr-only focus-visible:absolute focus-visible:top-1/2 focus-visible:z-10",
        "focus-visible:flex focus-visible:h-11 focus-visible:w-11 focus-visible:-translate-y-1/2",
        "focus-visible:items-center focus-visible:justify-center focus-visible:rounded-full",
        "focus-visible:bg-shell-sunken focus-visible:text-shell-ink",
        side === "left" ? "focus-visible:left-3" : "focus-visible:right-3",
      )}
    >
      {children}
    </button>
  );
}

/**
 * The compare hold's equivalent for a screen reader, whose double-tap is a
 * click and can never be a hold: a toggle, "Mostrar sem as melhorias" /
 * "Mostrar com as melhorias". Out of sight until it takes keyboard focus
 * (like the pager buttons); always in the accessibility tree.
 */
function CompareToggle({
  label,
  pressed,
  disabled,
  onClick,
}: {
  label: string;
  pressed: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-pager
      data-compare-toggle
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        "sr-only focus-visible:not-sr-only focus-visible:absolute focus-visible:bottom-2 focus-visible:z-10",
        "focus-visible:inset-x-0 focus-visible:mx-auto focus-visible:w-fit",
        "focus-visible:flex focus-visible:min-h-11 focus-visible:items-center focus-visible:rounded-full focus-visible:px-4",
        "focus-visible:bg-shell-sunken focus-visible:text-[13px] focus-visible:font-semibold focus-visible:text-shell-ink",
      )}
    >
      {label}
    </button>
  );
}

/** The status line's one action — "por quê?" or "tentar de novo" — hit at 44 px. */
function InlineAction({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "relative inline-flex shrink-0 items-center text-[13px] leading-none text-shell-ink2",
        "underline underline-offset-4 transition-colors duration-200 [@media(hover:hover)_and_(pointer:fine)]:hover:text-shell-ink",
        "after:absolute after:-inset-x-2 after:-inset-y-4 after:content-['']",
      )}
    >
      {children}
    </button>
  );
}

/**
 * The footer's fixed slot — "Refazer" normally, "Cancelar" while a
 * straightening runs. Same box either way, so the primary beside it never
 * moves and the footer never grows.
 */
function FooterSecondary({
  icon,
  disabled = false,
  onClick,
  children,
}: {
  icon?: React.ReactNode;
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
        "inline-flex h-14 w-[132px] shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-full",
        "max-[339px]:h-auto max-[339px]:min-h-14 max-[339px]:w-full max-[339px]:whitespace-normal max-[339px]:py-2",
        "border border-shell-line text-base font-semibold text-shell-ink",
        "transition-colors duration-200 [@media(hover:hover)_and_(pointer:fine)]:hover:border-shell-ink",
        "disabled:cursor-not-allowed disabled:opacity-40",
      )}
    >
      {icon}
      {children}
    </button>
  );
}
