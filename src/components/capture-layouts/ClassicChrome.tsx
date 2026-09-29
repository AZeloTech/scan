"use client";

import * as React from "react";
import {
  CloseButton,
  HintPill,
  LayoutShutter,
  ReviewPill,
  SAFE_TOP,
  SafeAreaOccluders,
  StepPill,
  ThumbStack,
  TorchButton,
  type LayoutChromeProps,
} from "@/components/capture-layouts/shared";

/**
 * A · "Tela cheia clássica": the camera edge to edge, the step in a pill at
 * the top between close and the torch, one hint centred above a translucent
 * bottom bar that carries the pages, the shutter and "Conferir".
 *
 * The bar is 118 px of controls over the safe-area floor (172 px on an iPhone
 * with a home indicator, as drawn). The shutter sits on a three-column grid
 * so it stays on the frame's centre line whatever the side controls measure.
 */

/** Where the framing brackets sit: clear of the top row and the bar. */
export const CLASSIC_FRAMING =
  "inset-x-6 top-[calc(max(env(safe-area-inset-top),12px)+4.5rem)] bottom-[calc(max(env(safe-area-inset-bottom),14px)+11rem)]";

export function ClassicChrome({ parts, bits }: LayoutChromeProps) {
  return (
    <>
      {parts.stage}

      <div className={`pointer-events-none absolute inset-x-0 top-0 grid grid-cols-[1fr_auto_1fr] items-center gap-2 px-4 ${SAFE_TOP}`}>
        <span className="justify-self-start">
          <CloseButton pages={bits.pageCount} onClick={bits.onClose} />
        </span>
        <StepPill className="max-w-[14rem]" />
        <span className="justify-self-end">
          <TorchButton torch={parts.torch} />
        </span>
      </div>

      <HintPill
        parts={parts}
        className="absolute inset-x-0 bottom-[calc(max(env(safe-area-inset-bottom),14px)+10.25rem)]"
      />

      <SafeAreaOccluders bottom={false} />

      {/* 80 % night: an opaque band for the live loop (`data-scan-occluder`). */}
      <div data-scan-occluder="bottom" className="absolute inset-x-0 bottom-0 bg-night/80 px-6 pb-[max(env(safe-area-inset-bottom),14px)] pt-5">
        <div className="grid h-[118px] grid-cols-[1fr_auto_1fr] items-center">
          <span className="justify-self-start">
            <ThumbStack bits={bits} />
          </span>
          <LayoutShutter parts={parts} size={80} />
          <span className="justify-self-end">
            <ReviewPill bits={bits} />
          </span>
        </div>
      </div>
    </>
  );
}
