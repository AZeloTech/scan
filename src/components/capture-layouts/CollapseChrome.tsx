"use client";

import * as React from "react";
import clsx from "clsx";
import { chromeCollapsed } from "@/lib/capture-layout";
import { useCopy } from "@/components/I18n";
import { CheckIcon, ChevronRightIcon } from "@/components/icons";
import { PageThumb } from "@/components/PageThumb";
import {
  CloseButton,
  CountBadge,
  HintPill,
  LayoutShutter,
  latestTile,
  SAFE_TOP,
  StepPill,
  TorchButton,
  usePagesLabel,
  type LayoutChromeProps,
} from "@/components/capture-layouts/shared";

/**
 * E · "Cromo que recolhe": while the camera is looking it is the classic
 * screen (A); the moment the ready cue comes on the chrome gets out of the
 * way. The torch fades, close dims, the step pill becomes a status pill
 * ("● Pronto"), and the bottom bar draws itself in to one floating capsule —
 * pages, shutter, ✓. The brackets carry the ready cue exactly as on every
 * screen (heavier, on a light halo).
 *
 * **The shutter does not move.** It is one element on a fixed centre line in
 * both states; only what is around it changes, so a thumb already on its way
 * to it lands on it. Everything animates with CSS transitions, which the
 * stylesheet's reduced-motion rule turns into a cut.
 */

export const COLLAPSE_FRAMING =
  "inset-x-6 top-[calc(max(env(safe-area-inset-top),12px)+6.5rem)] bottom-[calc(max(env(safe-area-inset-bottom),14px)+11rem)]";

const EASE = "motion-safe:duration-300 motion-safe:ease-[cubic-bezier(0.2,0.8,0.2,1)]";

export function CollapseChrome({ parts, bits }: LayoutChromeProps) {
  const copy = useCopy();
  const collapsed = chromeCollapsed({
    live: parts.live,
    ready: parts.ready,
    busy: parts.busy,
    notice: parts.notice !== null,
  });
  const tile = latestTile(bits);
  const pagesLabel = usePagesLabel(bits);
  const { autoCapture } = parts;

  return (
    <>
      {parts.stage}

      {/* Top row: close | step ↔ status | auto. The step and the status share
          one grid cell and cross-fade, so neither pushes the other. */}
      <div
        data-collapsed={collapsed || undefined}
        className={`pointer-events-none absolute inset-x-0 top-0 grid grid-cols-[1fr_auto_1fr] items-center gap-2 px-4 ${SAFE_TOP}`}
      >
        <span className="justify-self-start">
          <CloseButton pages={bits.pageCount} onClick={bits.onClose} dim={collapsed} />
        </span>
        <span className="grid place-items-center [grid-template-areas:'x']">
          <span
            aria-hidden={collapsed || undefined}
            className={clsx("[grid-area:x] motion-safe:transition-opacity", EASE, collapsed ? "opacity-0" : "opacity-100")}
          >
            <StepPill short />
          </span>
          <span
            aria-hidden={!collapsed || undefined}
            className={clsx(
              "[grid-area:x] flex items-center gap-2 whitespace-nowrap rounded-full bg-night/75 px-4 py-2 text-[15px] font-bold text-warm",
              "motion-safe:transition-[opacity,transform]",
              EASE,
              collapsed ? "scale-100 opacity-100" : "scale-95 opacity-0",
            )}
          >
            <span className="h-2 w-2 rounded-full bg-warm shadow-[0_0_0_3px_rgba(250,250,247,0.25)]" />
            {autoCapture.on ? copy.capture.readyAuto : copy.capture.ready}
          </span>
        </span>
        <span className="justify-self-end">
          {autoCapture.offered ? (
            <button
              type="button"
              aria-label={copy.capture.autoCapture}
              aria-pressed={autoCapture.on}
              onClick={autoCapture.toggle}
              className="pointer-events-auto flex h-11 items-center gap-1.5 rounded-full bg-night/55 px-3 text-[13px] font-bold text-warm"
            >
              <span aria-hidden="true">{copy.captureLayout.autoSwitch}</span>
              <span
                aria-hidden="true"
                className={clsx(
                  "relative h-4 w-[26px] rounded-full motion-safe:transition-colors motion-safe:duration-200",
                  autoCapture.on ? "bg-warm" : "bg-warm/30",
                )}
              >
                <span
                  className={clsx(
                    "absolute top-0.5 h-3 w-3 rounded-full motion-safe:transition-[left,background-color] motion-safe:duration-200",
                    autoCapture.on ? "left-[12px] bg-deep" : "left-0.5 bg-warm",
                  )}
                />
              </span>
            </button>
          ) : (
            <TorchButton torch={parts.torch} hidden={collapsed} />
          )}
        </span>
      </div>

      {/* The torch, under the auto switch: a side control, so it steps out
          while the page is ready and comes back with the chrome. */}
      {autoCapture.offered && (
        <div className="pointer-events-none absolute right-4 top-[calc(max(env(safe-area-inset-top),12px)+3.5rem)]">
          <TorchButton torch={parts.torch} hidden={collapsed} />
        </div>
      )}

      <HintPill
        parts={parts}
        className="absolute inset-x-0 bottom-[calc(max(env(safe-area-inset-bottom),14px)+10.25rem)]"
      />

      {/* The bar ↔ capsule: one surface whose box animates between the two. */}
      <div
        aria-hidden="true"
        className={clsx(
          "pointer-events-auto absolute motion-safe:transition-[left,right,bottom,height,border-radius,background-color]",
          EASE,
          collapsed
            ? "bottom-[calc(max(env(safe-area-inset-bottom),14px)+0.8125rem)] left-6 right-6 h-[92px] rounded-[46px] bg-night/65"
            : "bottom-0 left-0 right-0 h-[calc(max(env(safe-area-inset-bottom),14px)+8.625rem)] rounded-none bg-night/80",
        )}
      />

      {/* Pages: the classic stack, or a round thumb with its count. */}
      <button
        type="button"
        aria-label={pagesLabel}
        disabled={tile === null}
        onClick={bits.onShowPages}
        className={clsx(
          "pointer-events-auto absolute bottom-[calc(max(env(safe-area-inset-bottom),14px)+1.8125rem)] h-[60px] w-[60px] motion-safe:transition-[left]",
          EASE,
          collapsed ? "left-9" : "left-6",
        )}
      >
        <span
          aria-hidden="true"
          className={clsx("absolute inset-0 motion-safe:transition-opacity", EASE, collapsed ? "opacity-0" : "opacity-100")}
        >
          {tile === null ? (
            <span className="absolute left-2 top-[3px] h-[54px] w-11 rounded border-2 border-dashed border-warm/40" />
          ) : (
            <>
              {bits.pageCount > 1 && <span className="absolute left-1.5 top-1 h-[54px] w-11 -rotate-6 rounded bg-mist" />}
              <PageThumb tile={tile} onNight radius="sm" className="absolute left-2 top-[3px] h-[54px] w-11 border-2 !border-warm" />
            </>
          )}
          <CountBadge bits={bits} className="-right-0.5 -top-1.5" />
        </span>
        <span
          aria-hidden="true"
          className={clsx(
            "absolute inset-0 flex items-center justify-center overflow-hidden rounded-full border-2 border-warm/90 bg-paper text-base font-bold text-deep",
            "motion-safe:transition-[opacity,transform]",
            EASE,
            collapsed ? "scale-100 opacity-100" : "scale-75 opacity-0",
          )}
        >
          {tile !== null && <PageThumb tile={tile} onNight radius="sm" className="absolute inset-0 h-full w-full !rounded-full !border-0 opacity-40" />}
          {bits.pageCount > 0 && <span className="relative">{bits.pageCount}</span>}
        </span>
      </button>

      {/* The shutter: one element, one place, both states. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-[calc(max(env(safe-area-inset-bottom),14px)+1.1875rem)] flex justify-center">
        <LayoutShutter parts={parts} size={80} ringRef={parts.ringRef} />
      </div>

      {/* Onward: "Conferir ›" draws in to a round ✓. */}
      <button
        type="button"
        aria-label={copy.captureLayout.reviewAria(bits.pageCount)}
        disabled={bits.pageCount === 0}
        onClick={bits.onReview}
        className={clsx(
          "pointer-events-auto absolute flex items-center justify-center overflow-hidden rounded-full text-[15px] font-bold disabled:opacity-45",
          "motion-safe:transition-[right,width,height,bottom]",
          EASE,
          bits.warnedCount > 0 ? "border-[1.5px] border-peach bg-night/55 text-warm" : "bg-warm text-deep",
          collapsed
            ? "bottom-[calc(max(env(safe-area-inset-bottom),14px)+1.8125rem)] right-9 h-[60px] w-[60px]"
            : "bottom-[calc(max(env(safe-area-inset-bottom),14px)+2.1875rem)] right-6 h-12 w-[7.25rem]",
        )}
      >
        <span
          aria-hidden="true"
          className={clsx(
            "absolute inset-0 flex items-center justify-center gap-1.5 whitespace-nowrap motion-safe:transition-opacity",
            EASE,
            collapsed ? "opacity-0" : "opacity-100",
          )}
        >
          {copy.captureLayout.review}
          <ChevronRightIcon size={16} strokeWidth={2.5} />
        </span>
        <span
          aria-hidden="true"
          className={clsx(
            "absolute inset-0 flex items-center justify-center motion-safe:transition-opacity",
            EASE,
            collapsed ? "opacity-100" : "opacity-0",
          )}
        >
          <CheckIcon size={22} strokeWidth={2.5} />
        </span>
      </button>
    </>
  );
}
