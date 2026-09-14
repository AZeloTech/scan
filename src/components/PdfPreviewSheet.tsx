"use client";

import * as React from "react";
import { useBlobUrl } from "@/hooks/useScanStore";
import { useDialogChrome } from "@/hooks/useDialogChrome";
import { useRotatedFit } from "@/hooks/useRotatedFit";
import type { PageTile } from "@/lib/page-tiles";
import { prefersReducedMotion } from "@/lib/motion";
import { displayRotation } from "@/lib/scan-store";
import type { AppCopy } from "@/lib/i18n";
import { AppFrame } from "@/components/AppFrame";
import { useCopy } from "@/components/I18n";
import { ChevronLeftIcon, ChevronRightIcon } from "@/components/icons";
import { Button, LiveRegion, Meta } from "@/components/ui";

/**
 * "É assim que o arquivo vai sair: uma página por foto, nesta ordem."
 *
 * The claim is deliberately about **layout, not pixels**. It is true because of
 * how the PDF is built: one page per image, cut to the image's own pixel size,
 * with the JPEG drawn edge to edge and the user's turn already baked in
 * (`lib/pdf.ts`). There is no margin, no scaling and no page box
 * to be surprised by — so showing the page images, in order, on a sheet of
 * paper genuinely is the preview, and it costs nothing: no pdf.js, no render
 * pass, no second copy of a 12 MP image in memory. It would NOT be true of the
 * pixels: a page the user turned is re-encoded at q92 on the way into the file,
 * which is why the copy says "assim" and not "exatamente assim".
 *
 * **The shape of the screen is the shape of a PDF reader**, by design: a toolbar on paper, and under it a dark viewport holding a single
 * vertically scrolling column of white sheets — one per ready page, in document
 * order, at each page's own aspect ratio, with a gutter either side and a gap
 * between them. Flicking down it is the same gesture as flipping through the
 * finished file, which is the whole claim this screen makes.
 *
 * Two things that follow from that, and are not decoration:
 *
 *  * **No page is re-rendered here.** Every sheet shows the page's `final` —
 *    the exact bytes the PDF embeds — so a preview cannot be of a file other
 *    than the one being made. There is no fallback to the canonical: the sheet
 *    only ever lists pages that are `ready`.
 *  * **The "current page" is whichever sheet the scroll has nearest the middle**,
 *    and everything that names a page (the header count, the orientation line,
 *    the pager's own ends, the live announcement) reads it from there. The pager
 *    buttons are kept — they now scroll the column rather than swap one image.
 *
 * **What the canvas draws and this does not:** a portrait/landscape toggle and
 * an "A4" label. Both would be false here — the page is the photograph's own
 * shape, which is the decision that keeps the file honest and small. The
 * orientation line still reports what the page in view *is*.
 */

/** Vertical gap between sheets, and the offset a scrolled-to page lands at. */
const SHEET_GAP = 16;

/**
 * The shape a sheet holds before its pixels have decoded — a portrait page,
 * because a photographed sheet almost always is one. It is replaced by the
 * image's own proportions the moment `naturalWidth` exists.
 */
const UNKNOWN_ASPECT = "1 / 1.4142";

interface PdfPreviewSheetProps {
  /** Ready pages only, in document order. */
  tiles: readonly PageTile[];
  /** "Confirmar e gerar" — go straight to the build. */
  onConfirm: () => void;
  /**
   * What the confirm button says, when it does not go straight to the build.
   *
   * Step 2 opens this same sheet, and from there the onward move is step 3, not
   * the file — a button labelled "Confirmar e gerar" that lands on another
   * screen is a promise the sheet did not keep.
   */
  confirmLabel?: string;
  onClose: () => void;
}

export function PdfPreviewSheet({
  tiles,
  onConfirm,
  confirmLabel,
  onClose,
}: PdfPreviewSheetProps) {
  const copy = useCopy();
  const containerRef = useDialogChrome<HTMLDivElement>(onClose);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const sheetRefs = React.useRef<(HTMLDivElement | null)[]>([]);
  const [index, setIndex] = React.useState(0);

  // A page removed underneath us (or a shorter list on re-entry) must not leave
  // the pager pointing past the end.
  const safeIndex = Math.min(index, Math.max(0, tiles.length - 1));
  const tile = tiles[safeIndex];

  /**
   * Which sheet the reader is looking at: the one whose middle is closest to
   * the middle of the viewport. Measured from `offsetTop` rather than
   * `getBoundingClientRect`, so it costs no layout on a scroll event.
   */
  const trackScroll = React.useCallback(() => {
    const root = scrollRef.current;
    if (root === null) return;
    const centre = root.scrollTop + root.clientHeight / 2;
    let nearest = 0;
    let best = Number.POSITIVE_INFINITY;
    sheetRefs.current.forEach((sheet, position) => {
      if (sheet === null) return;
      const distance = Math.abs(sheet.offsetTop + sheet.offsetHeight / 2 - centre);
      if (distance < best) {
        best = distance;
        nearest = position;
      }
    });
    setIndex((current) => (current === nearest ? current : nearest));
  }, []);

  const step = React.useCallback(
    (delta: -1 | 1) => {
      const target = Math.max(0, Math.min(tiles.length - 1, safeIndex + delta));
      const root = scrollRef.current;
      const sheet = sheetRefs.current[target];
      setIndex(target);
      if (root === null || sheet === null) return;
      root.scrollTo({
        top: Math.max(0, sheet.offsetTop - SHEET_GAP),
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
    },
    [safeIndex, tiles.length],
  );

  if (tile === undefined) return null;

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label={copy.pdfPreview.title}
      className="fixed inset-0 z-50 flex flex-col overscroll-contain"
    >
      <AppFrame
        title={copy.pdfPreview.title}
        onBack={onClose}
        aside={
          <Meta>{copy.common.pageOfTotal(safeIndex + 1, tiles.length)}</Meta>
        }
        fill
        className="bg-paper"
        footer={
          <div className="flex flex-col gap-2 pb-1">
            <Button variant="secondary" fullWidth onClick={onClose}>
              {copy.pdfPreview.back}
            </Button>
            <Button fullWidth onClick={onConfirm}>
              {confirmLabel ?? copy.pdfPreview.confirm}
            </Button>
          </div>
        }
      >
        <div className="flex min-h-0 flex-1 flex-col">
          {/* The reader's toolbar: what the file will be, what the page in view
              is, and the two ways to step through it. It stays on paper and
              never scrolls, so the dark viewport below is only ever pages. */}
          <div className="flex shrink-0 items-start justify-between gap-3 bg-paper px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm leading-snug text-ink-2">
                {copy.pdfPreview.claim}
              </p>
              {/* Orientation is the only fact left on this line: the
                  searchable-PDF option is gone from the UI, so "texto
                  pesquisável: não" was a stat that could never say anything
                  else. */}
              <p className="mt-1.5">
                <Meta>{copy.pdfPreview.orientation(isLandscape(tile))}</Meta>
              </p>
            </div>
            <div className="flex shrink-0 gap-1 rounded-lg border border-border p-1">
              <PagerButton
                label={copy.pdfPreview.previous}
                disabled={safeIndex === 0}
                onClick={() => step(-1)}
              >
                <ChevronLeftIcon size={16} />
              </PagerButton>
              <PagerButton
                label={copy.pdfPreview.next}
                disabled={safeIndex === tiles.length - 1}
                onClick={() => step(1)}
              >
                <ChevronRightIcon size={16} />
              </PagerButton>
            </div>
          </div>

          {/* The viewport. `relative` is load-bearing: it is the offset parent
              the sheet positions above are measured against. */}
          <div
            ref={scrollRef}
            onScroll={trackScroll}
            className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain bg-night-2 px-5 py-4"
          >
            <div className="flex flex-col gap-4">
              {tiles.map((candidate, position) => (
                <PdfPageSheet
                  key={candidate.key}
                  copy={copy}
                  tile={candidate}
                  position={position}
                  total={tiles.length}
                  sheetRef={(node) => {
                    sheetRefs.current[position] = node;
                  }}
                />
              ))}
            </div>
          </div>

          <LiveRegion
            message={copy.pdfPreview.announce(safeIndex + 1, tiles.length)}
          />
        </div>
      </AppFrame>
    </div>
  );
}

/**
 * One page of the file, as a physical sheet on the reader's dark ground.
 *
 * The sheet takes the *image's own* proportions rather than the store's
 * dimensions: `naturalWidth` is the one measurement that cannot disagree with
 * the bytes on screen, and a page mid-re-render carries a turn its `final` has
 * not been given yet ({@link displayRotation}), which the fit hook rotates and
 * rescales into the same box.
 */
function PdfPageSheet({
  copy,
  tile,
  position,
  total,
  sheetRef,
}: {
  copy: AppCopy;
  tile: PageTile;
  /** 0-based, for the badge and for the pager's measurements. */
  position: number;
  total: number;
  sheetRef: (node: HTMLDivElement | null) => void;
}) {
  // The preview shows the page's `final` and nothing else: those are the exact
  // bytes the PDF embeds, so a fallback here would preview a file that is not
  // the one being made.
  const url = useBlobUrl(tile.page.final);
  const rotation = displayRotation(tile.page);
  const { frameRef, imageRef, scale, handleImageLoad } = useRotatedFit(
    rotation,
    "contain",
  );
  const [natural, setNatural] = React.useState<{
    width: number;
    height: number;
  } | null>(null);

  const handleLoad = React.useCallback(() => {
    const image = imageRef.current;
    if (image !== null && image.naturalWidth > 0) {
      setNatural({ width: image.naturalWidth, height: image.naturalHeight });
    }
    handleImageLoad();
  }, [handleImageLoad, imageRef]);

  const quarter = rotation === 90 || rotation === 270;
  const aspect =
    natural === null
      ? UNKNOWN_ASPECT
      : quarter
        ? `${natural.height} / ${natural.width}`
        : `${natural.width} / ${natural.height}`;

  return (
    <div ref={sheetRef} className="relative">
      <div
        ref={frameRef}
        style={{ aspectRatio: aspect }}
        className="relative w-full overflow-hidden rounded-sm border border-border bg-warm shadow-[0_10px_28px_-12px_rgba(0,0,0,0.8)]"
      >
        {url !== null && (
          <div
            className="absolute inset-0 flex items-center justify-center"
            style={{ transform: `rotate(${rotation}deg) scale(${scale})` }}
          >
            {/* A local object URL — next/image cannot take one. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={imageRef}
              src={url}
              alt={copy.pdfPreview.firstPageAlt(tile.humanNumber)}
              onLoad={handleLoad}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        )}
      </div>

      {/* Where you are in the file, the way a reader shows it. Numerals only —
          nothing to translate — and hidden from the screen reader, which is
          already told the position by the live region and by each page's alt
          text. */}
      {total > 1 && (
        <span
          aria-hidden="true"
          className="absolute bottom-2 right-2 rounded-full bg-night-deep/[0.72] px-2 py-1"
        >
          <Meta tone="warm" size="sm">
            {position + 1}/{total}
          </Meta>
        </span>
      )}
    </div>
  );
}

/**
 * The page's own shape, after the turn the user asked for — which is what the
 * PDF page will be, because the turn is baked into the pixels before the embed.
 * Reads as portrait while the dimensions are still unknown, which is the shape
 * a photographed sheet almost always has.
 */
function isLandscape(tile: PageTile): boolean {
  const { width, height, rotation } = tile.page;
  if (width === 0 || height === 0) return false;
  const quarter = rotation === 90 || rotation === 270;
  return (quarter ? height : width) > (quarter ? width : height);
}

function PagerButton({
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
      className={
        "inline-flex h-11 w-11 items-center justify-center rounded-md transition-colors duration-200 " +
        (disabled ? "text-ink-4 opacity-40" : "bg-leaf text-warm hover:bg-deep")
      }
    >
      {children}
    </button>
  );
}
