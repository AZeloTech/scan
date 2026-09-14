"use client";

import * as React from "react";
import clsx from "clsx";
import type { PageFinish } from "@/lib/page-processing";
import type { PageTile } from "@/lib/page-tiles";
import { useStore } from "@/hooks/useScanStore";
import { useCopy } from "@/components/I18n";
import { Sheet, SheetAction } from "@/components/Sheet";
import { LiveRegion } from "@/components/ui";

/**
 * "Acabamento da folha" — how much ink the page is wearing, as three swatches.
 *
 * Exported because the "what are the improvements" sheet lists the same three
 * in the same order, from the same copy: a second hand-written list is a second
 * place to forget a finish.
 */
export const FINISH_ORDER: readonly PageFinish[] = ["original", "clean", "bw"];

/** Which way each arrow key moves inside a radiogroup, per the ARIA pattern. */
export const ARROW_DELTA: Record<string, number | undefined> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

/**
 * The finish sheet: three swatches, one line of explanation, one CTA that says
 * which finish it is applying.
 *
 * **The swatches are abstract, not thumbnails.** Re-rendering the page three
 * times to draw three previews would spend three full render passes on a
 * decision the words already carry, on the device class this app is built for
 * (a cheap Android holding one full-resolution copy at a time). So each swatch
 * draws the *idea*: a dark sheet with faint marks, a light sheet with grey
 * marks, a light sheet with near-black ones — least ink to most, left to right,
 * which is also the order the options are offered in.
 *
 * **The choice is live.** Tapping a swatch writes it to the store immediately
 * and the page behind the sheet re-renders; "Aplicar clarear" only closes.
 * That is the model every edit in this app follows, and it is what makes the
 * explanation line under the swatches worth reading — the reader can see the
 * sentence and the sheet it is about at the same time.
 */
interface AcabamentoSheetProps {
  tile: PageTile;
  onClose: () => void;
}

export function AcabamentoSheet({ tile, onClose }: AcabamentoSheetProps) {
  const copy = useCopy();
  const store = useStore();
  const pageId = tile.pageId;
  // The *request*, not `effectiveFinish`: this is the control that owns the
  // choice, and it has to show what the next render is being asked for even
  // while that render is still in flight.
  const finish = tile.page.finish;

  return (
    <Sheet
      title={copy.finish.title}
      label={copy.finish.dialogLabel(tile.humanNumber)}
      onClose={onClose}
    >
      <LiveRegion
        message={copy.finish.announce(
          tile.humanNumber,
          copy.finish.labels[finish],
        )}
      />

      <div
        role="radiogroup"
        aria-label={copy.finish.title}
        className="flex gap-2.5"
        onKeyDown={(event) => {
          const delta = ARROW_DELTA[event.key];
          if (delta === undefined) return;
          event.preventDefault();
          const at = FINISH_ORDER.indexOf(finish);
          const next =
            FINISH_ORDER[(at + delta + FINISH_ORDER.length) % FINISH_ORDER.length];
          store.setPageFinish(pageId, next);
          // The roving tab stop moves with the selection, so focus has to
          // follow it or the next Tab leaves the group entirely.
          event.currentTarget
            .querySelector<HTMLButtonElement>(`[data-finish="${next}"]`)
            ?.focus();
        }}
      >
        {FINISH_ORDER.map((option) => (
          <FinishSwatch
            key={option}
            finish={option}
            label={copy.finish.labels[option]}
            selected={finish === option}
            onSelect={() => store.setPageFinish(pageId, option)}
          />
        ))}
      </div>

      <p className="text-[12.5px] leading-relaxed text-shell-ink2">
        {copy.finish.help[finish]}
      </p>

      <SheetAction onClick={onClose}>
        {copy.finish.apply(copy.finish.labels[finish])}
      </SheetAction>
    </Sheet>
  );
}

/**
 * What each swatch is made of — the surface it draws, and the weight of the
 * marks on it.
 *
 * A closed map rather than three `className` overrides, for the reason the
 * whole kit works this way: two `bg-*` utilities in one class string are
 * resolved by the generated stylesheet's order, not the string's.
 */
const SWATCH_CLASSES: Record<PageFinish, { sheet: string; mark: string }> = {
  original: { sheet: "bg-gradient-to-br from-night-2 to-night-deep", mark: "bg-warm/30" },
  clean: { sheet: "bg-warm", mark: "bg-ink-3" },
  bw: { sheet: "bg-warm", mark: "bg-ink" },
};

/** The proportions of the four marks inside a swatch, longest first. */
const MARK_WIDTHS = ["w-[78%]", "w-[54%]", "w-[66%]", "w-[42%]"];

function FinishSwatch({
  finish,
  label,
  selected,
  onSelect,
}: {
  finish: PageFinish;
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const swatch = SWATCH_CLASSES[finish];

  return (
    <button
      type="button"
      role="radio"
      data-finish={finish}
      aria-checked={selected}
      // Roving tabindex: a radiogroup is ONE tab stop, and the arrows move
      // within it.
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      className="flex flex-1 flex-col items-center gap-2"
    >
      <span
        aria-hidden="true"
        className={clsx(
          "flex w-full flex-col justify-center gap-[7px] overflow-hidden rounded-lg p-2.5",
          "aspect-[3/4] transition-shadow duration-200",
          swatch.sheet,
          selected
            ? // `mist` is a fixed token, so the glow may carry an opacity
              // modifier; the ring is what the design draws and the border is
              // what carries it at 2.5px.
              "border-[2.5px] border-mist ring-[3px] ring-mist/20"
            : "border-[1.5px] border-shell-line",
        )}
      >
        {MARK_WIDTHS.map((width) => (
          <span key={width} className={clsx("h-[3px] rounded-sm", width, swatch.mark)} />
        ))}
      </span>
      <span
        className={clsx(
          "text-center text-xs leading-tight",
          selected ? "font-bold text-shell-ink" : "text-shell-ink2",
        )}
      >
        {label}
      </span>
    </button>
  );
}
