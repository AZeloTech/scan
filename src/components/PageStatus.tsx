"use client";

import * as React from "react";
import clsx from "clsx";
import type { TileStage } from "@/lib/page-tiles";
import { localeTag } from "@/lib/i18n";
import { swapIn } from "@/lib/motion";
import { useLang } from "@/components/I18n";
import {
  AlertTriangleIcon,
  CheckIcon,
  EyeIcon,
  RefreshIcon,
  SpinnerIcon,
} from "@/components/icons";
import { CHIP_TONE_CLASSES, Chip, type ChipTone } from "@/components/ui";

/**
 * One mapping from "what is happening to this page" to how it looks, shared by
 * the capture rail, the review cards and the retake sheet — so a page never
 * says "Nítida" in green in one place and something else in another.
 *
 * The verdict is carried by an SVG, never by a ✓ or ⚠ glyph: glyph coverage is
 * a lottery across cheap-Android fonts and it can't take the palette.
 */

export const STAGE_TONE: Record<TileStage, ChipTone> = {
  processing: "busy",
  ok: "ok",
  // Never `ok`: the green tick is the app claiming it read the page.
  unverified: "quiet",
  warned: "warning",
  retry: "warning",
};

/**
 * Exhaustive on purpose — no `default`. A new stage must be given a face here
 * rather than silently inheriting the tick.
 */
export function StageIcon({
  stage,
  size = 16,
}: {
  stage: TileStage;
  size?: number;
}) {
  switch (stage) {
    case "processing":
      return <SpinnerIcon size={size} />;
    case "unverified":
      return <EyeIcon size={size} />;
    case "warned":
      return <AlertTriangleIcon size={size} />;
    case "retry":
      return <RefreshIcon size={size} />;
    case "ok":
      return <CheckIcon size={size} />;
  }
}

/**
 * The icon-only badge that sits on the bottom edge of a 64px rail thumb, where
 * a worded chip would be unreadable. It re-pops whenever the stage changes, so
 * "enviando → lendo → ótima" is something the user watches happen.
 */
export function StageDot({
  stage,
  onNight = false,
  className,
}: {
  stage: TileStage;
  /** The rail on the capture screen: the halo has to read against `night`. */
  onNight?: boolean;
  className?: string;
}) {
  const ref = React.useRef<HTMLSpanElement | null>(null);
  // Skipped on mount: the whole thumb is already popping into the rail, and two
  // overshoots on nested elements compound into a wobble.
  const settled = React.useRef(false);
  React.useEffect(() => {
    if (settled.current) swapIn(ref.current);
    settled.current = true;
  }, [stage]);

  return (
    <span
      ref={ref}
      aria-hidden="true"
      className={clsx(
        "inline-flex h-6 w-6 items-center justify-center rounded-full shadow-sm",
        "ring-1",
        onNight ? "ring-night" : "ring-warm",
        CHIP_TONE_CLASSES[STAGE_TONE[stage]],
        className,
      )}
    >
      <StageIcon stage={stage} size={14} />
    </span>
  );
}

/** The worded chip, for the sheets where there is room for words. */
export function StageChip({
  stage,
  label,
  className,
}: {
  stage: TileStage;
  label: string;
  className?: string;
}) {
  const ref = React.useRef<HTMLSpanElement | null>(null);
  React.useEffect(() => {
    swapIn(ref.current);
  }, [stage]);

  return (
    <span ref={ref} className={clsx("inline-flex", className)}>
      <Chip tone={STAGE_TONE[stage]} icon={<StageIcon stage={stage} size={14} />}>
        {label}
      </Chip>
    </span>
  );
}

/** How a stage's verdict is coloured as bare mono text on a page row. */
export const STAGE_TEXT_CLASSES: Record<TileStage, string> = {
  processing: "text-ink-4",
  ok: "text-pine",
  unverified: "text-ink-4",
  warned: "text-warning-ink",
  retry: "text-destroyed",
};

/**
 * The verdict as one mono word under the page's name — the review list's own
 * register, where a filled chip on every row would be four chips too many.
 *
 * The colours are the chips' colours read as *text*, which is why `warned`
 * uses `warning-ink` rather than the `peach` the canvas draws: peach on warm
 * is ~2.2:1, and a status nobody can read is not a status.
 */
export function StageLabel({
  stage,
  label,
  className,
}: {
  stage: TileStage;
  label: string;
  className?: string;
}) {
  const { lang } = useLang();
  const ref = React.useRef<HTMLSpanElement | null>(null);
  React.useEffect(() => {
    swapIn(ref.current);
  }, [stage]);

  return (
    <span
      ref={ref}
      className={clsx(
        "font-mono text-2xs leading-none",
        STAGE_TEXT_CLASSES[stage],
        className,
      )}
    >
      {label.toLocaleLowerCase(localeTag(lang))}
    </span>
  );
}
