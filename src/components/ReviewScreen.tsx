"use client";

import * as React from "react";
import clsx from "clsx";
import { useScanStore, useStore } from "@/hooks/useScanStore";
import { useFlowNavigation } from "@/hooks/useFlowNavigation";
import { useEntrance } from "@/hooks/useEntrance";
import { localeTag } from "@/lib/i18n";
import { captureFlip, playFlip } from "@/lib/motion";
import { hasSeenEditTip, markEditTipSeen } from "@/lib/tips";
import {
  isBlocking,
  isProblemRow,
  rowVerdict,
  type PageTile,
  type RowState,
} from "@/lib/page-tiles";
import { AppFrame, FrameStep } from "@/components/AppFrame";
import { CornerAdjustSheet } from "@/components/CornerAdjustSheet";
import { PagePreview } from "@/components/PagePreview";
import { PageThumb } from "@/components/PageThumb";
import { PdfPreviewSheet } from "@/components/PdfPreviewSheet";
import { RetakeSheet } from "@/components/RetakeSheet";
import { useCopy, useLang } from "@/components/I18n";
import type { AppCopy } from "@/lib/i18n";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronRightIcon,
  EyeIcon,
  PencilIcon,
  PlusIcon,
  XIcon,
} from "@/components/icons";
import { Button, LiveRegion, Meta, Notice, useCancelOnEscape } from "@/components/ui";

/** The DOM id a page row carries, so anything can scroll to it. */
function anchorId(tile: PageTile): string {
  return `pagina-${tile.humanNumber}`;
}

/**
 * Step 2 — conferir. The order on this screen is the order in the PDF.
 *
 * The design reduced this screen to three things, and the reduction is
 * the design: a dismissible tip that teaches the one gesture a list cannot show,
 * a list of quiet rows, and a footer that never scrolls away.
 *
 * **The row is a door, and almost nothing else.** It carries the index, the
 * thumbnail, the page's name and one mono word of verdict — plus the two
 * controls that are genuinely about *this list* rather than about a page: move
 * it up, move it down. Everything you can do *to* a page — turn it, lighten it,
 * re-cut its corners, retake it, throw it away, look at it full size — lives
 * behind the row, in `PagePreview`. That is why the tip exists at all: a row
 * that opens an editor has to say so once.
 *
 * Reordering glides (GSAP Flip) rather than teleports, because the difference
 * between "did that work?" and watching your document rearrange itself is the
 * whole feedback.
 *
 * Two rules this screen still enforces, unchanged by the restyle:
 *
 * * **quality warnings never block** — "tremida" is a word in the row, and the
 *   CTA stays live next to it;
 * * **a page that could not be prepared does block.** Generating a PDF that
 *   silently omits a page the user photographed is the one outcome they would
 *   not forgive, so the row wears the peach card, the CTA waits, and the offers
 *   ("tentar de novo", "refazer", "apagar") are one tap away inside the page.
 */
export function ReviewScreen() {
  const copy = useCopy();
  const { lang } = useLang();
  const store = useStore();
  const { go } = useFlowNavigation();
  const { tiles } = useScanStore();
  const [retakeKey, setRetakeKey] = React.useState<string | null>(null);
  const [previewKey, setPreviewKey] = React.useState<string | null>(null);
  const [adjustKey, setAdjustKey] = React.useState<string | null>(null);
  const [pdfPreview, setPdfPreview] = React.useState(false);
  const [navigating, setNavigating] = React.useState(false);

  const listRef = React.useRef<HTMLOListElement | null>(null);
  const scope = useEntrance<HTMLDivElement>({ y: 12 });

  // Escape asks the host to close. The sheets this screen can open handle it
  // themselves first, and the guard inside the hook stands down for them.
  useCancelOnEscape();

  // ── the edit tip ──────────────────────────────────────────────────────────
  //
  // Starts hidden and adopts the stored answer in an effect: this is a static
  // export, so the first client render has to match markup generated at build
  // time, and a card that flashes in and out is worse than one that fades in.
  const [tipSeen, setTipSeen] = React.useState(true);
  React.useEffect(() => {
    setTipSeen(hasSeenEditTip());
  }, []);

  // "Never edited a page" is asked of the pages themselves rather than tracked
  // as a second fact: every edit — a turn, a finish, a re-crop, a retake —
  // bumps the page's revision past the 1 it was captured at.
  const edited = tiles.some((tile) => tile.page.revision > 1);
  React.useEffect(() => {
    if (!edited || tipSeen) return;
    markEditTipSeen();
    setTipSeen(true);
  }, [edited, tipSeen]);

  const dismissTip = React.useCallback(() => {
    markEditTipSeen();
    setTipSeen(true);
  }, []);

  /**
   * Flip works in two halves across a React render: snapshot the row geometry
   * before the reorder, then replay it in the layout effect that runs once the
   * new order has been painted.
   */
  const flipState = React.useRef<ReturnType<typeof captureFlip>>(null);
  const orderKey = tiles.map((tile) => tile.key).join("|");

  React.useLayoutEffect(() => {
    if (flipState.current === null) return;
    playFlip(flipState.current);
    flipState.current = null;
  }, [orderKey]);

  const move = React.useCallback(
    (tile: PageTile, delta: -1 | 1) => {
      const list = listRef.current;
      if (list !== null) flipState.current = captureFlip(Array.from(list.children));
      store.movePage(tile.pageId, delta);
    },
    [store],
  );

  const retakeTile = tiles.find((tile) => tile.key === retakeKey) ?? null;
  if (retakeTile !== null) {
    return <RetakeSheet tile={retakeTile} onClose={() => setRetakeKey(null)} />;
  }

  const adjustTile = tiles.find((tile) => tile.key === adjustKey) ?? null;
  if (adjustTile !== null) {
    return (
      <CornerAdjustSheet
        tile={adjustTile}
        pageCount={tiles.length}
        onClose={() => setAdjustKey(null)}
      />
    );
  }

  const previewTile = tiles.find((tile) => tile.key === previewKey) ?? null;
  const brokenTiles = tiles.filter(isBlocking);
  const stillWorking = tiles.some((tile) => tile.stage === "processing");
  const readyTiles = tiles.filter((tile) => tile.page.status === "ready");
  const readyCount = readyTiles.length;
  const blocked = brokenTiles.length > 0;

  if (pdfPreview) {
    return (
      <PdfPreviewSheet
        tiles={readyTiles}
        confirmLabel={copy.review.next}
        onConfirm={() => {
          setPdfPreview(false);
          setNavigating(true);
          go("build");
        }}
        onClose={() => setPdfPreview(false)}
      />
    );
  }

  const announcement = blocked
    ? copy.review.announceBlocked(brokenTiles.length)
    : stillWorking
      ? copy.review.announceWorking
      : copy.review.announceReady(readyCount);

  return (
    <>
      <AppFrame
        title={copy.review.title}
        step={2}
        aside={
          <FrameStep size="xs">{copy.common.pagesShort(tiles.length)}</FrameStep>
        }
        footer={
          <div className="flex flex-col gap-2 pb-1">
            {blocked && (
              <Notice tone="warning">{copy.review.blockedNotice}</Notice>
            )}

            {/* Arrangement 4a: the two side offers share one line, so the
                primary keeps the full width it earns. */}
            <div className="flex gap-2">
              <FooterOffer
                icon={<EyeIcon size={14} />}
                lines={copy.review.footer.preview}
                label={copy.gerar.previewCta}
                disabled={readyCount === 0 || blocked || navigating}
                onClick={() => setPdfPreview(true)}
              />
              <FooterOffer
                icon={<PlusIcon size={14} />}
                lines={copy.review.footer.add}
                label={copy.review.addPage}
                disabled={navigating}
                onClick={() => {
                  setNavigating(true);
                  go("capture");
                }}
              />
            </div>

            <Button
              fullWidth
              disabled={readyCount === 0 || stillWorking || blocked || navigating}
              onClick={() => {
                setNavigating(true);
                go("build");
              }}
            >
              {stillWorking ? copy.review.preparing : copy.review.next}
            </Button>
          </div>
        }
      >
        <div ref={scope} className="flex flex-col gap-3 px-4 py-4">
          <LiveRegion message={announcement} />

          {!tipSeen && tiles.length > 0 && (
            <div
              data-enter
              className="flex items-start gap-2.5 rounded-[13px] border border-mint-line bg-mint p-3"
            >
              <span
                aria-hidden="true"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-leaf text-warm"
              >
                <PencilIcon size={16} />
              </span>
              <p className="min-w-0 flex-1 pt-0.5 text-sm leading-snug text-ink-2">
                {copy.review.tip}
              </p>
              {/* 38 px of visible × inside a 40 px target: the spec draws the
                  circle, the tap floor owns the box around it. */}
              <button
                type="button"
                aria-label={copy.review.dismissTip}
                onClick={dismissTip}
                className="-m-px inline-flex h-10 w-10 shrink-0 items-center justify-center"
              >
                <span
                  aria-hidden="true"
                  className="flex h-[38px] w-[38px] items-center justify-center rounded-full text-pine transition-colors duration-200 hover:bg-mint-line"
                >
                  <XIcon size={18} />
                </span>
              </button>
            </div>
          )}

          <ol ref={listRef} className="flex flex-col gap-2">
            {tiles.map((tile, index) => (
              <li key={tile.key} id={anchorId(tile)} tabIndex={-1} data-enter>
                <PageRow
                  copy={copy}
                  locale={localeTag(lang)}
                  tile={tile}
                  isFirst={index === 0}
                  isLast={index === tiles.length - 1}
                  onOpen={() => setPreviewKey(tile.key)}
                  onMove={(delta) => move(tile, delta)}
                />
              </li>
            ))}
          </ol>

          {tiles.length === 0 && (
            <Notice tone="neutral" title={copy.review.emptyTitle}>
              {copy.review.emptyBody}
            </Notice>
          )}
        </div>
      </AppFrame>

      {/* `tiles` as well as the tapped one: the editor keeps its own cursor
          through the document, so the page it hands back to these callbacks is
          not necessarily the page that was tapped to open it. */}
      {previewTile !== null && (
        <PagePreview
          tile={previewTile}
          tiles={tiles}
          onRetake={(tile) => {
            setPreviewKey(null);
            setRetakeKey(tile.key);
          }}
          // The cursor is moved onto the page the editor was on and the
          // editor is deliberately NOT closed: the corner screen returns the
          // way it came (design scenario 06), so clearing `previewKey` here
          // would drop the user back on this screen the moment they tapped
          // "Voltar". The early return above unmounts the editor for the
          // duration either way.
          onAdjustCorners={(tile) => {
            setPreviewKey(tile.key);
            setAdjustKey(tile.key);
          }}
          onClose={() => setPreviewKey(null)}
        />
      )}
    </>
  );
}

/**
 * One of the footer's two square offers: a 48 px block with a mono icon and a
 * two-line label, where the second line is the qualifier the first does not
 * need to carry ("prévia" / "do PDF").
 *
 * It is not a `Button`: the kit's button is a full pill with one centred line,
 * and stacking a second line into it through `className` would be exactly the
 * override the kit forbids. Disabled keeps its box and its 48 px — a control
 * that shrinks when it is unavailable moves the one next to it under the thumb.
 */
function FooterOffer({
  icon,
  lines,
  label,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  lines: readonly [string, string];
  /** The accessible name — two stacked fragments are not a sentence. */
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        "flex min-h-[48px] flex-1 items-center gap-2 rounded-[14px] border border-border",
        "bg-warm px-3 py-1.5 text-left transition-colors duration-200",
        disabled ? "cursor-not-allowed opacity-45" : "hover:border-sage",
      )}
    >
      <span aria-hidden="true" className="shrink-0 text-leaf">
        {icon}
      </span>
      <span aria-hidden="true" className="flex min-w-0 flex-col gap-[3px]">
        <span className="truncate text-sm font-semibold leading-none text-ink">
          {lines[0]}
        </span>
        <Meta size="2xs" tone="dim">
          {lines[1]}
        </Meta>
      </span>
    </button>
  );
}

/** The verdict word's colour, per row state. A prop-free closed map. */
const ROW_STATE_CLASSES: Record<RowState, string> = {
  ok: "text-pine",
  quiet: "text-ink-4",
  warned: "text-warning-ink",
  // The design's own hex for this one word (#DD9A74 = `peach`).
  noCorners: "text-peach",
  failed: "text-clay",
};

interface PageRowProps {
  copy: AppCopy;
  /** For lowercasing the verdict the way the reader's language does it. */
  locale: string;
  tile: PageTile;
  isFirst: boolean;
  isLast: boolean;
  onOpen: () => void;
  onMove: (delta: -1 | 1) => void;
}

/**
 * One page, at rest.
 *
 * **The whole row is the way in**, done with a stretched, empty button under the
 * card. The chevron sits *under* that button rather than beside it, because it
 * is an affordance and not a second control — only the two arrows are lifted
 * clear with `relative z-10`, so reordering a page can never open it.
 *
 * A page with a problem — no outline found, or a render that failed — wears the
 * peach card and takes its accent through the chevron and the arrows, which is
 * the whole of the treatment: the row still says one word and still opens the
 * same editor, where the offers live.
 */
function PageRow({
  copy,
  locale,
  tile,
  isFirst,
  isLast,
  onOpen,
  onMove,
}: PageRowProps) {
  const { state, word } = rowVerdict(tile, copy);
  const problem = isProblemRow(state);

  return (
    <div
      id={`row-${tile.key}`}
      className={clsx(
        "relative rounded-xl border",
        problem ? "border-peach-soft bg-peach-bg" : "border-frost bg-warm",
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={copy.review.open(tile.humanNumber, word)}
        className="absolute inset-0 rounded-xl"
      />

      <div className="flex items-center gap-2.5 px-2.5 py-2">
        <Meta size="xs" className="w-4 shrink-0 tabular-nums">
          {String(tile.humanNumber).padStart(2, "0")}
        </Meta>
        <PageThumb
          tile={tile}
          radius="sm"
          className="h-[46px] w-[34px] shrink-0"
        />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-base font-semibold leading-tight text-ink">
            {copy.common.page(tile.humanNumber)}
          </span>
          <span
            className={clsx(
              "truncate font-mono text-4xs leading-none",
              ROW_STATE_CLASSES[state],
            )}
          >
            {word.toLocaleLowerCase(locale)}
          </span>
        </span>

        {/* Ordering is a comparison between rows, which is why it cannot live
            inside the page view: you cannot compare rows from inside one of
            them. `z-10` is what keeps these two out of the row's tap target. */}
        <div className="relative z-10 flex shrink-0 flex-col gap-1.5">
          <MoveArrow
            label={copy.review.moveUp(tile.humanNumber)}
            disabled={isFirst}
            problem={problem}
            onClick={() => onMove(-1)}
          >
            <ArrowUpIcon size={16} />
          </MoveArrow>
          <MoveArrow
            label={copy.review.moveDown(tile.humanNumber)}
            disabled={isLast}
            problem={problem}
            onClick={() => onMove(1)}
          >
            <ArrowDownIcon size={16} />
          </MoveArrow>
        </div>

        {/* Not a control: the chevron says the row opens, and the row's own
            stretched button is what opens it. Left out of `z-10` on purpose. */}
        <span
          aria-hidden="true"
          className={clsx(
            "flex h-[38px] w-[34px] shrink-0 items-center justify-center",
            problem ? "text-clay" : "text-pine",
          )}
        >
          <ChevronRightIcon size={18} />
        </span>
      </div>
    </div>
  );
}

/**
 * ↑ or ↓, drawn at the spec's 36×25 and hit at 44×31.
 *
 * The stacked pair is 56 px tall in a 72 px row, so two 40 px targets cannot
 * both fit without overlapping each other — the compromise is an outward hit
 * area that meets its twin exactly in the middle of the 6 px gap and spills 4 px
 * either side, which is the largest honest target this geometry allows.
 *
 * Disabled keeps every pixel of that box and simply changes colour: a control
 * that vanishes at the top of the list is a row that changes shape as it moves.
 */
function MoveArrow({
  label,
  disabled,
  problem,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  /** On a peach card the live arrow takes the card's own accent. */
  problem: boolean;
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
        "relative inline-flex h-[25px] w-9 items-center justify-center rounded-lg border",
        "transition-colors duration-200",
        "after:absolute after:-inset-x-1 after:-inset-y-[3px] after:content-['']",
        disabled
          ? "cursor-not-allowed border-border text-stone"
          : problem
            ? "border-peach-soft text-clay hover:border-clay"
            : "border-moss text-leaf hover:border-sage",
      )}
    >
      {children}
    </button>
  );
}
