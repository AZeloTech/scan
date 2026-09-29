"use client";

import * as React from "react";
import clsx from "clsx";
import { useCopy } from "@/components/I18n";
import { ArrowRightIcon } from "@/components/icons";
import { PageThumb } from "@/components/PageThumb";
import {
  CloseButton,
  CountBadge,
  GalleryLink,
  HintPill,
  LayoutShutter,
  latestTile,
  OccluderMark,
  SAFE_TOP,
  SafeAreaOccluders,
  TorchButton,
  usePagesLabel,
  type LayoutChromeProps,
} from "@/components/capture-layouts/shared";

/**
 * B · "Trilho Manual / Auto" — the default capture layout (`captureLayout`).
 * Full-bleed, the hint under the top row, no bar — a dark fade carries the
 * controls — and a MANUAL · AUTOMÁTICO rail above the shutter that switches
 * auto-capture for this flow (when offered: `autoCaptureOffered`). With it
 * on, the countdown runs on the corner brackets (as on every screen) and
 * around the shutter's ring. The shutter works in both modes.
 *
 * Under the shutter row, "Já tenho a foto" (the `standard` screen's gallery
 * pill) as a quiet text button — not in the mockup, which had no gallery
 * pick; it goes where it cannot be mistaken for the shutter or the rail.
 *
 * Bottom-up, from the safe area: the gallery line (44 px), the shutter row
 * (100 px, overlapping the line's box by the shutter's own 8 px margin), the
 * mode rail, then the framing box's bottom edge. Every piece keeps its place
 * whether it is shown or not — nothing here ever moves the frame.
 */

export const RAIL_FRAMING =
  "inset-x-6 top-[calc(max(env(safe-area-inset-top),12px)+7rem)] bottom-[calc(max(env(safe-area-inset-bottom),14px)+13.75rem)]";

/**
 * How the rail fits the camera frame (`lib/visible-region.ts`, Phase 5a):
 * `maxcrop` — the frame covers the part of the screen above the controls,
 * cropping at most 12 % off a side, so on a tall phone every part of the
 * frame the scanner judges is on screen. See the README's "What the camera
 * shows" for the evaluation behind it.
 */
export const RAIL_FIT = "maxcrop" as const;

/**
 * The controls' band, for the live loop: from the safe area up to the top of
 * the mode rail (9 rem + its 44 px) — where the fade under the controls is
 * past half opaque and the rail, the shutter row and the gallery line sit.
 */
const RAIL_BAND = "inset-x-0 bottom-0 h-[calc(max(env(safe-area-inset-bottom),14px)+11.75rem)]";

export function RailChrome({ parts, bits }: LayoutChromeProps) {
  const copy = useCopy();
  const tile = latestTile(bits);
  const pagesLabel = usePagesLabel(bits);
  return (
    <>
      {parts.stage}

      <SafeAreaOccluders bottom={false} />
      <OccluderMark edge="bottom" className={RAIL_BAND} />

      <div className={`pointer-events-none absolute inset-x-0 top-0 grid grid-cols-[1fr_auto_1fr] items-center gap-2 px-4 ${SAFE_TOP}`}>
        <span className="justify-self-start">
          <CloseButton pages={bits.pageCount} onClick={bits.onClose} />
        </span>
        <StepDots />
        <span className="justify-self-end">
          <TorchButton torch={parts.torch} />
        </span>
      </div>

      <HintPill parts={parts} className="absolute inset-x-0 top-[calc(max(env(safe-area-inset-top),12px)+3.75rem)]" />

      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[calc(max(env(safe-area-inset-bottom),14px)+15.25rem)] bg-gradient-to-t from-night/90 from-50% to-night/0"
      />

      {/* Only over a live camera, as on the `standard` screen: with no camera
          (the file surface) or at the page limit nothing can fire by itself. */}
      {parts.autoCapture.offered && parts.live && (
        <ModeRail
          on={parts.autoCapture.on}
          toggle={parts.autoCapture.toggle}
          className="absolute inset-x-0 bottom-[calc(max(env(safe-area-inset-bottom),14px)+9rem)]"
        />
      )}

      <div className="pointer-events-none absolute inset-x-0 bottom-[calc(max(env(safe-area-inset-bottom),14px)+2.25rem)] grid h-[100px] grid-cols-[1fr_auto_1fr] items-center px-6">
        <button
          type="button"
          aria-label={pagesLabel}
          disabled={tile === null}
          onClick={bits.onShowPages}
          className={clsx(
            "pointer-events-auto relative h-14 w-14 justify-self-start rounded-xl border-2",
            tile === null ? "border-dashed border-warm/40" : "border-warm bg-paper",
          )}
        >
          {tile !== null && <PageThumb tile={tile} onNight radius="md" className="h-full w-full !border-0" />}
          <CountBadge bits={bits} className="-right-2 -top-2" />
        </button>
        <LayoutShutter parts={parts} size={84} ringRef={parts.ringRef} />
        <button
          type="button"
          aria-label={copy.captureLayout.reviewAria(bits.pageCount)}
          disabled={bits.pageCount === 0}
          onClick={bits.onReview}
          className={clsx(
            "pointer-events-auto flex h-14 w-14 items-center justify-center justify-self-end rounded-full disabled:opacity-45",
            bits.warnedCount > 0 ? "border-[1.5px] border-peach bg-night/55 text-warm" : "bg-warm text-deep",
          )}
        >
          <ArrowRightIcon size={22} strokeWidth={2.5} />
        </button>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-[max(env(safe-area-inset-bottom),14px)] flex justify-center">
        <GalleryLink parts={parts} />
      </div>
    </>
  );
}

/** The step as dots — the current one long — beside the verb. */
function StepDots() {
  const copy = useCopy();
  return (
    <span className="flex items-center gap-2 rounded-full bg-night/55 px-3.5 py-2.5 text-[13px] font-semibold leading-none text-warm">
      <span className="scan-sr-only">{copy.captureLayout.stepAria}</span>
      <span aria-hidden="true" className="flex items-center gap-1.5">
        <span className="h-1.5 w-[18px] rounded-full bg-warm" />
        <span className="h-1.5 w-1.5 rounded-full bg-warm/40" />
        <span className="h-1.5 w-1.5 rounded-full bg-warm/40" />
      </span>
      <span aria-hidden="true" className="ml-1">
        {copy.captureLayout.captureWord}
      </span>
    </span>
  );
}

/**
 * The two capture modes as a radio group. The chosen one is full `warm` with
 * a bar under it; the other is `warm` at 60 % — told apart by the bar and the
 * weight of the colour, never by hue alone. Arrow keys move between them, as
 * in any radio group.
 */
export function ModeRail({ on, toggle, className }: { on: boolean; toggle: () => void; className?: string }) {
  const copy = useCopy();
  const manualRef = React.useRef<HTMLButtonElement | null>(null);
  const autoRef = React.useRef<HTMLButtonElement | null>(null);
  const choose = (auto: boolean) => {
    if (auto !== on) toggle();
    (auto ? autoRef : manualRef).current?.focus();
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (["ArrowLeft", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      choose(false);
    } else if (["ArrowRight", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      choose(true);
    }
  };
  const option = (auto: boolean) => {
    const checked = auto === on;
    return (
      <button
        ref={auto ? autoRef : manualRef}
        type="button"
        role="radio"
        aria-checked={checked}
        tabIndex={checked ? 0 : -1}
        onClick={() => choose(auto)}
        onKeyDown={onKeyDown}
        className={clsx(
          "pointer-events-auto relative flex min-h-11 items-center gap-1.5 px-1 text-[13px] font-bold uppercase tracking-[0.08em]",
          "motion-safe:transition-colors motion-safe:duration-200",
          checked ? "text-warm" : "text-warm/60",
        )}
      >
        {auto ? copy.captureLayout.modeAuto : copy.captureLayout.modeManual}
        {auto && (
          <span className="rounded border border-current px-1 py-px text-[10px] leading-none tracking-[0.06em]">
            {copy.captureLayout.beta}
          </span>
        )}
        <span
          aria-hidden="true"
          className={clsx(
            "absolute inset-x-1 bottom-1 h-0.5 rounded-full bg-warm motion-safe:transition-opacity motion-safe:duration-200",
            checked ? "opacity-100" : "opacity-0",
          )}
        />
      </button>
    );
  };
  return (
    <div className={clsx("pointer-events-none flex justify-center", className)}>
      <div role="radiogroup" aria-label={copy.captureLayout.modeLabel} className="flex gap-6">
        {option(false)}
        {option(true)}
      </div>
    </div>
  );
}
