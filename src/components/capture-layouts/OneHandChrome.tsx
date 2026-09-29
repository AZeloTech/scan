"use client";

import * as React from "react";
import clsx from "clsx";
import { hintPlacement } from "@/lib/capture-layout";
import { useCopy } from "@/components/I18n";
import { ChevronRightIcon, TorchIcon } from "@/components/icons";
import {
  CloseButton,
  HintBubble,
  hintLine,
  LayoutShutter,
  SAFE_TOP,
  SafeAreaOccluders,
  type LayoutChromeProps,
} from "@/components/capture-layouts/shared";

/**
 * D · "Uma mão": no bars at all. Close and the step at the top; everything a
 * thumb needs down the right edge — a glass column (auto-capture, torch) over
 * an 88 px shutter — and the pages with "Conferir" bottom-left.
 *
 * The hint hangs off the page itself: a white label just above its top-left
 * corner bracket, following it on the animation frame (the live loop paints
 * the anchor, never React). With no page tracked there is no corner to hang it
 * from, and it becomes a pill under the top row. What a screen reader hears is
 * one polite region with the same words, wherever the eye is sent.
 */

export const ONEHAND_FRAMING =
  "inset-x-6 top-[calc(max(env(safe-area-inset-top),12px)+4.5rem)] bottom-[calc(max(env(safe-area-inset-bottom),14px)+9.5rem)]";

export function OneHandChrome({ parts, bits }: LayoutChromeProps) {
  const copy = useCopy();
  const line = hintLine(parts);
  // A notice (a failed photo) is never hung on the page: it is not about the page.
  const placement = parts.notice === null ? hintPlacement(parts.hasQuad) : "top";
  const { autoCapture, torch } = parts;
  const column = parts.live && (autoCapture.offered || torch.available);

  return (
    <>
      {parts.stage}

      <SafeAreaOccluders />

      <div className={`pointer-events-none absolute left-4 top-0 ${SAFE_TOP}`}>
        <CloseButton pages={bits.pageCount} onClick={bits.onClose} />
      </div>
      <div className={`pointer-events-none absolute right-4 top-0 ${SAFE_TOP}`}>
        <span className="flex h-11 items-center text-[13px] font-semibold text-warm/85 [text-shadow:0_1px_3px_rgba(0,0,0,0.6)]">
          <span className="scan-sr-only">{copy.captureLayout.stepAria}</span>
          <span aria-hidden="true">{copy.captureLayout.stepShort}</span>
        </span>
      </div>

      {/* What is said, once, whichever of the two places shows it. */}
      <div role="status" aria-live="polite" className="scan-sr-only">
        {line?.text ?? ""}
      </div>

      {/* The corner anchor: always mounted — the live loop writes to it —
          and faded with the brackets. Its label sits above the corner and
          stays clear of the top row and the left edge. */}
      <div
        ref={parts.anchorRef}
        aria-hidden="true"
        className="pointer-events-none absolute left-0 top-0 opacity-0"
        style={{
          transform:
            "translate(max(0.75rem, calc(var(--scan-anchor-x, 0px) - 9px)), max(7.5rem, calc(var(--scan-anchor-y, 0px) - 0.75rem)))",
        }}
      >
        {placement === "anchor" && line !== null && (
          <span className="absolute bottom-0 left-0 w-max max-w-[16rem] rounded-lg bg-warm px-3 py-1.5 text-sm font-bold leading-snug text-deep shadow-md">
            {line.text}
          </span>
        )}
      </div>

      {(placement === "top" || parts.torchOffer !== null) && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-[calc(max(env(safe-area-inset-top),12px)+3.75rem)] flex flex-wrap justify-center gap-2 px-4"
        >
          {placement === "top" && line !== null && <HintBubble text={line.text} tone={line.tone} />}
        </div>
      )}
      {parts.torchOffer !== null && (
        // The low-light offer, where the thumb already is: above the column.
        <button
          type="button"
          onClick={parts.torchOffer}
          className="pointer-events-auto absolute right-4 bottom-[calc(max(env(safe-area-inset-bottom),14px)+17rem)] inline-flex min-h-11 items-center"
        >
          <span className="inline-flex items-center gap-1.5 rounded-full bg-warm px-3 py-1.5 text-sm font-semibold text-deep shadow-sm">
            <TorchIcon size={16} on />
            {copy.capture.torchOffer}
          </span>
        </button>
      )}

      {column && (
        <div className="pointer-events-auto absolute right-[2.25rem] bottom-[calc(max(env(safe-area-inset-bottom),14px)+8.5rem)] flex flex-col gap-3 rounded-[32px] bg-night/60 p-2">
          {autoCapture.offered && (
            <button
              type="button"
              aria-label={copy.capture.autoCapture}
              aria-pressed={autoCapture.on}
              onClick={autoCapture.toggle}
              className={clsx(
                "flex h-12 w-12 items-center justify-center rounded-full text-[15px] font-bold",
                "motion-safe:transition-colors motion-safe:duration-200",
                autoCapture.on ? "bg-warm text-deep" : "text-warm",
              )}
            >
              <span aria-hidden="true">{copy.captureLayout.autoLetter}</span>
            </button>
          )}
          {torch.available && (
            <button
              ref={torch.ref}
              type="button"
              aria-label={copy.capture.torch}
              aria-pressed={torch.on}
              onClick={torch.toggle}
              className={clsx(
                "flex h-12 w-12 items-center justify-center rounded-full",
                "motion-safe:transition-colors motion-safe:duration-200",
                torch.on ? "bg-warm text-deep" : "text-warm",
              )}
            >
              <TorchIcon size={20} on={torch.on} />
            </button>
          )}
        </div>
      )}

      <LayoutShutter
        parts={parts}
        size={88}
        ringRef={parts.ringRef}
        className="!absolute right-6 bottom-[calc(max(env(safe-area-inset-bottom),14px)+0.625rem)]"
      />

      <button
        type="button"
        aria-label={copy.captureLayout.reviewAria(bits.pageCount)}
        disabled={bits.pageCount === 0}
        onClick={bits.onReview}
        className={clsx(
          "pointer-events-auto absolute left-5 bottom-[calc(max(env(safe-area-inset-bottom),14px)+2.25rem)] flex h-12 items-center gap-2.5 rounded-full pl-1.5 pr-2 text-[15px] font-bold text-warm disabled:opacity-60",
          bits.warnedCount > 0 ? "border-[1.5px] border-peach bg-night/75" : "bg-night/75",
        )}
      >
        <span
          aria-hidden="true"
          className={clsx(
            "flex h-9 w-9 items-center justify-center rounded-full text-sm",
            bits.warnedCount > 0 ? "bg-peach text-peach-ink" : "bg-paper text-deep",
          )}
        >
          {bits.pageCount}
        </span>
        {copy.captureLayout.review}
        <ChevronRightIcon size={16} strokeWidth={2.5} className="mr-1" />
      </button>
    </>
  );
}
