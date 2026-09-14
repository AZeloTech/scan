"use client";

import * as React from "react";
import clsx from "clsx";
import { useBlobUrl } from "@/hooks/useScanStore";
import { useDialogChrome } from "@/hooks/useDialogChrome";
import { useCopy } from "@/components/I18n";
import { Meta } from "@/components/ui";
import { ArrowLeftIcon } from "@/components/icons";

/**
 * The page, whole, at the size it really is.
 *
 * This is the one surface in the app where the user can *judge the file*. Every
 * other view is a fit: the rail thumb is 480 px, the page editor is a contained
 * image inside a phone frame, the PDF preview is a sheet on a desk. None of them
 * can answer "will I be able to read this later", which is the only question
 * somebody photographing an exam actually has.
 *
 * So two rules govern what is on screen here:
 *
 *  * **the bytes are the page's `final`** — the exact JPEG `embedJpg` copies
 *    into the PDF, not the thumbnail and not the pre-warp canonical. Judging the
 *    quality of a picture the file will not contain is worse than not looking.
 *    (The corner editor is the one caller that passes something else, and it
 *    passes the *canonical* deliberately: there the pre-warp frame is the truth
 *    the user is marking corners on.)
 *  * **the browser decodes it at full resolution.** There is no canvas, no
 *    downscale and no re-encode in this component: it is an `<img>` pointed at
 *    the blob, so 1:1 really is one image pixel per CSS pixel.
 *
 * It wears the page editor's own band structure — header, one status line, the
 * sheet, a fixed footer — because it is a *screen* the editor opens rather than
 * a chip over the picture, and arriving somewhere that is laid out differently
 * is how a zoom starts to feel like a different app. The two exits at the foot
 * are the editor's own: back to the corrections, or onward.
 *
 * Fit ↔ 1:1 is the whole interaction. A double-tap switches, because that is the
 * gesture people already try; the mono affordance at the end of the status line
 * says the same thing for anyone who does not, and the header's mono line
 * reports which of the two is on.
 */

interface FullImageViewProps {
  /** The page's `final` — see above. Never the thumb. */
  blob: Blob;
  /** The page's number, for the dialog's name. */
  humanNumber: number;
  /** How many pages the document has, for "página 1 de 2". */
  pageCount: number;
  /**
   * The editor's own primary, mirrored at the foot of this screen so the flow
   * does not have to be walked backwards to continue it. Omitted by the corner
   * editor, which has no "onward" of its own to offer here.
   */
  primary?: { label: string; onClick: () => void };
  onClose: () => void;
}

export function FullImageView({
  blob,
  humanNumber,
  pageCount,
  primary,
  onClose,
}: FullImageViewProps) {
  const copy = useCopy();
  const url = useBlobUrl(blob);
  const [actual, setActual] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const containerRef = useDialogChrome<HTMLDivElement>(onClose);

  /**
   * Entering 1:1 lands in the middle of the sheet rather than at its top-left
   * corner: the corner of a photographed page is white paper, and a viewer that
   * opens on nothing looks broken.
   */
  const toggle = React.useCallback(() => {
    setActual((current) => {
      const next = !current;
      if (next) {
        // After the layout that grows the image — the scroll box has no room to
        // move in until then.
        requestAnimationFrame(() => {
          const box = scrollRef.current;
          if (box === null) return;
          box.scrollTo({
            left: (box.scrollWidth - box.clientWidth) / 2,
            top: (box.scrollHeight - box.clientHeight) / 2,
          });
        });
      }
      return next;
    });
  }, []);

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label={copy.preview.full.label(humanNumber)}
      className="fixed inset-0 z-[60] flex flex-col overscroll-contain bg-night-deep"
    >
      <div className="mx-auto flex h-full w-full max-w-[30rem] flex-col overflow-hidden pb-[max(env(safe-area-inset-bottom),18px)] pt-[max(env(safe-area-inset-top),14px)]">
        <div className="flex shrink-0 items-center gap-2 px-3.5">
          <button
            type="button"
            aria-label={copy.preview.full.close}
            title={copy.preview.full.close}
            onClick={onClose}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-[1.5px] border-warm/40 text-warm transition-colors duration-200 hover:border-warm"
          >
            <ArrowLeftIcon size={20} />
          </button>
          <span className="flex min-w-0 flex-1 flex-col items-center gap-px">
            <span className="max-w-full truncate font-display text-lg font-semibold leading-tight text-warm">
              {copy.preview.full.title}
            </span>
            <Meta tone="warm" size="xs" className="block max-w-full truncate">
              {copy.preview.full.position(
                humanNumber,
                pageCount,
                actual ? copy.preview.full.zoomActual : copy.preview.full.zoomFit,
              )}
            </Meta>
          </span>
          {/* The header's third slot stays empty rather than collapsing, so the
              title is centred on the screen and not on what is left of it. */}
          <span aria-hidden="true" className="h-11 w-11 shrink-0" />
        </div>

        <div className="flex h-[38px] shrink-0 items-center gap-2 px-4">
          <p className="min-w-0 truncate text-xs leading-none text-warm/70">
            {copy.preview.full.hint}
          </p>
          <button
            type="button"
            aria-pressed={actual}
            onClick={toggle}
            // 44px of tap overflowing a band whose height is pinned, so the
            // picture below keeps every pixel it had.
            //
            // The hover has to reach the `Meta` inside as well: the word takes
            // its colour from the kit's own tone map, which a colour on the
            // parent cannot beat. The child variant can — it is one specificity
            // step above a plain utility — and the button keeps its own colour
            // for the underline, which is `currentColor`.
            //
            // `[&>span]:hover:`, in that order: Tailwind applies the rightmost
            // variant first, so `hover:[&>span]:` compiles to `>span:hover` —
            // the hover would have to land on the word itself rather than
            // anywhere on the 44 px target.
            className="ml-auto inline-flex h-11 shrink-0 items-center text-warm/70 underline underline-offset-4 transition-colors duration-200 [&>span]:text-warm/70 [&>span]:transition-colors [&>span]:duration-200 hover:text-warm [&>span]:hover:text-warm"
          >
            <Meta tone="warm" size="xs">
              {actual ? copy.preview.full.fitToScreen : copy.preview.full.actualSize}
            </Meta>
          </button>
        </div>

        <div
          ref={scrollRef}
          onDoubleClick={toggle}
          className={clsx(
            "min-h-0 flex-1 overscroll-contain px-2.5",
            // Fit centres in a flex box; 1:1 is a plain block box, because a flex
            // item wider than its container cannot be scrolled back to its own
            // left edge.
            actual
              ? "overflow-auto"
              : "flex items-center justify-center overflow-hidden",
          )}
        >
          {url === null ? (
            <p className="text-base text-warm/70">{copy.common.loadingPage}</p>
          ) : (
            /* A local object URL — next/image cannot take one, and there is no
               remote asset in this product to optimise. */
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={url}
              alt={copy.common.page(humanNumber)}
              className={clsx(
                "select-none",
                actual
                  ? "mx-auto block max-w-none"
                  : "max-h-full max-w-full rounded-[3px] object-contain",
              )}
            />
          )}
        </div>

        <div className="flex h-[70px] shrink-0 items-center gap-2.5 px-4 pt-3.5">
          <button
            type="button"
            onClick={onClose}
            className={clsx(
              "inline-flex h-14 flex-1 items-center justify-center whitespace-nowrap rounded-[14px] px-3",
              "border-[1.5px] border-warm/40 text-lg font-semibold text-warm",
              "transition-colors duration-200 hover:border-warm",
            )}
          >
            {primary === undefined
              ? copy.preview.full.back
              : copy.preview.full.correct}
          </button>
          {primary !== undefined && (
            <button
              type="button"
              onClick={primary.onClick}
              className={clsx(
                "inline-flex h-14 flex-1 items-center justify-center whitespace-nowrap rounded-[14px] px-3",
                "bg-warm text-lg font-bold text-deep transition-colors duration-200 hover:bg-cream",
              )}
            >
              {primary.label}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
