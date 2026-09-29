"use client";

import * as React from "react";
import type { CaptureLayout } from "@/lib/capture-layout";
import type { Capture } from "@/lib/capture-intake";
import { CaptureStage, type CaptureChrome } from "@/components/CaptureStage";
import { LiveRegion } from "@/components/ui";
import { ClassicChrome, CLASSIC_FRAMING } from "@/components/capture-layouts/ClassicChrome";
import { RailChrome, RAIL_FRAMING } from "@/components/capture-layouts/RailChrome";
import { FilmstripChrome, FILMSTRIP_FRAMING } from "@/components/capture-layouts/FilmstripChrome";
import { OneHandChrome, ONEHAND_FRAMING } from "@/components/capture-layouts/OneHandChrome";
import { CollapseChrome, COLLAPSE_FRAMING } from "@/components/capture-layouts/CollapseChrome";
import { LAYOUT_STAGE_CLASS, type LayoutScreenBits } from "@/components/capture-layouts/shared";

/**
 * Step 1 under a full-bleed layout (`captureLayout`): `rail` — the default —
 * or one of the experimental ones.
 *
 * The same `CaptureStage` the `standard` screen uses — camera, detection,
 * guidance, torch, auto-capture, the capture itself — handed a chrome instead
 * of the `standard` header, thumbnail rail and control row. The screen around it
 * (`EscanearScreen`) is unchanged: the confirm-corners screen after every
 * photo, the page editor, the retake and corner sheets, the primer.
 *
 * One phone-width column, one viewport tall, on `night`: the camera is the
 * whole screen and every piece of chrome is drawn over it.
 */

type Layout = Exclude<CaptureLayout, "standard">;

const CHROME: Record<Layout, { framing: string; Component: React.ComponentType<{ parts: Parameters<CaptureChrome["render"]>[0]; bits: LayoutScreenBits }> }> = {
  classic: { framing: CLASSIC_FRAMING, Component: ClassicChrome },
  rail: { framing: RAIL_FRAMING, Component: RailChrome },
  filmstrip: { framing: FILMSTRIP_FRAMING, Component: FilmstripChrome },
  onehand: { framing: ONEHAND_FRAMING, Component: OneHandChrome },
  collapse: { framing: COLLAPSE_FRAMING, Component: CollapseChrome },
};

export interface LayoutCaptureScreenProps {
  layout: Layout;
  bits: LayoutScreenBits;
  announcement: string;
  onCapture: (capture: Capture) => void;
  captureLabel: string;
  pageNumber: number;
  paused: boolean;
  useCamera: boolean;
  disabled: boolean;
  disabledReason: string;
  autoCaptureOffered: boolean;
  autoCaptureOn: boolean;
  onAutoCaptureChange: (on: boolean) => void;
}

export function LayoutCaptureScreen({ layout, bits, announcement, ...stage }: LayoutCaptureScreenProps) {
  const { framing, Component } = CHROME[layout];
  const chrome: CaptureChrome = {
    stageClassName: LAYOUT_STAGE_CLASS,
    framingClassName: framing,
    render: (parts) => <Component parts={parts} bits={bits} />,
  };

  return (
    <div className="app-h flex min-h-0 w-full shrink-0 justify-center overflow-hidden bg-night">
      <div
        data-scan-layout={layout}
        className="relative min-h-0 w-full max-w-[30rem] overflow-hidden bg-night text-warm"
      >
        <LiveRegion message={announcement} />
        <CaptureStage {...stage} chrome={chrome} />
      </div>
    </div>
  );
}
