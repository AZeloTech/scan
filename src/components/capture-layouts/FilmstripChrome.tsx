"use client";

import * as React from "react";
import clsx from "clsx";
import { filmstripState } from "@/lib/capture-layout";
import { popIn } from "@/lib/motion";
import { useCopy } from "@/components/I18n";
import { TorchIcon } from "@/components/icons";
import { PageThumb } from "@/components/PageThumb";
import {
  CloseButton,
  HintPill,
  LayoutShutter,
  SAFE_TOP,
  SafeAreaOccluders,
  type LayoutChromeProps,
} from "@/components/capture-layouts/shared";

/**
 * C · "Tira de páginas": the camera on top with rounded lower corners, and
 * under it the pages taken so far as a numbered strip — a dashed slot for
 * the next one and "n de máx" — then the torch, the shutter and "Conferir".
 *
 * The drawing's "Galeria" pill is the torch here: the design's gallery import
 * is not a feature of this layout, and the torch moves down from the top row
 * so there is one of it. The stage is a `flex-1` over a strip and a row of
 * fixed height, both there on every render, so nothing that comes or goes
 * resizes it.
 */

export const FILMSTRIP_FRAMING = "inset-x-6 top-[calc(max(env(safe-area-inset-top),12px)+4rem)] bottom-16";

export function FilmstripChrome({ parts, bits }: LayoutChromeProps) {
  const copy = useCopy();
  const strip = filmstripState(bits.pageCount, bits.maxPages);
  const stripRef = React.useRef<HTMLDivElement | null>(null);

  // Keep the newest page in view, and let it land with a pop — as the rail does.
  const pageCount = bits.pageCount;
  React.useEffect(() => {
    const node = stripRef.current;
    if (node === null || pageCount === 0) return;
    node.scrollTo({ left: node.scrollWidth, behavior: "smooth" });
    popIn(node.children[pageCount - 1] ?? null);
  }, [pageCount]);

  return (
    <div className="absolute inset-0 flex flex-col bg-night-2">
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-b-[28px]">
        {parts.stage}

        <SafeAreaOccluders bottom={false} />

        <div className={`pointer-events-none absolute inset-x-0 top-0 flex items-center gap-2.5 px-4 ${SAFE_TOP}`}>
          <CloseButton pages={bits.pageCount} onClick={bits.onClose} />
          <p className="min-w-0 flex-1 truncate text-[15px] font-semibold text-warm [text-shadow:0_1px_3px_rgba(0,0,0,0.6)]">
            {strip.nextSlot === null
              ? copy.captureLayout.captureWord
              : copy.captureLayout.filmstripTitle(strip.nextSlot)}
          </p>
        </div>

        <HintPill parts={parts} className="absolute inset-x-0 bottom-6" />
      </div>

      <div className="mt-5 flex h-[62px] shrink-0 items-end gap-2.5 px-5">
        <div
          ref={stripRef}
          role="group"
          aria-label={copy.captureLayout.filmstripLabel}
          className="no-scrollbar flex min-w-0 items-end gap-2.5 overflow-x-auto"
        >
          {bits.tiles.map((tile) => (
            <button
              key={tile.key}
              type="button"
              onClick={() => bits.onTileTap(tile)}
              aria-label={copy.captureLayout.filmstripTile(tile.humanNumber, tile.chipLabel)}
              className="relative h-[62px] w-12 shrink-0 rounded-md"
            >
              <PageThumb tile={tile} onNight radius="md" className="h-full w-full" />
              <span
                aria-hidden="true"
                className={clsx(
                  "absolute bottom-1 left-1 rounded px-1 text-[11px] font-bold leading-tight",
                  tile.stage === "warned" || tile.stage === "retry"
                    ? "bg-peach text-peach-ink"
                    : "bg-warm/90 text-leaf",
                )}
              >
                {tile.humanNumber}
              </span>
            </button>
          ))}
          {strip.nextSlot !== null && (
            <span
              aria-label={copy.captureLayout.filmstripNext(strip.nextSlot)}
              role="img"
              className="flex h-[62px] w-12 shrink-0 items-center justify-center rounded-md border-2 border-dashed border-sage text-xs font-bold text-mist"
            >
              <span aria-hidden="true">{strip.nextSlot}</span>
            </span>
          )}
        </div>
        <span className="ml-auto shrink-0 pb-1 text-xs text-mist">
          {copy.captureLayout.filmstripCount(strip.count, strip.max)}
        </span>
      </div>

      <div className="grid h-24 shrink-0 grid-cols-[1fr_auto_1fr] items-center px-5 pb-0 mb-[max(env(safe-area-inset-bottom),14px)]">
        <span className="justify-self-start">
          {parts.torch.available ? (
            <button
              ref={parts.torch.ref}
              type="button"
              aria-pressed={parts.torch.on}
              onClick={parts.torch.toggle}
              className={clsx(
                "flex h-12 min-w-[92px] items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-[15px] font-semibold",
                parts.torch.on ? "bg-warm text-deep" : "border border-pine text-frost",
              )}
            >
              <TorchIcon size={18} on={parts.torch.on} />
              {copy.capture.torch}
            </button>
          ) : (
            <span aria-hidden="true" className="block h-12 w-[92px]" />
          )}
        </span>
        <LayoutShutter parts={parts} size={80} />
        <span className="justify-self-end">
          <button
            type="button"
            aria-label={copy.captureLayout.reviewAria(bits.pageCount)}
            disabled={bits.pageCount === 0}
            onClick={bits.onReview}
            className={clsx(
              "flex h-12 min-w-[92px] items-center justify-center whitespace-nowrap rounded-full px-4 text-[15px] font-bold disabled:opacity-45",
              bits.warnedCount > 0 ? "border-[1.5px] border-peach text-warm" : "bg-warm text-deep",
            )}
          >
            {copy.captureLayout.review}
          </button>
        </span>
      </div>
    </div>
  );
}
