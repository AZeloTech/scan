/**
 * Which screen is on, and the two moments the host has to hear about.
 *
 * The screens themselves know nothing about the host. They move through the
 * flow with `useFlowNavigation` and they put pages into the store; this is the
 * one place that watches the store for the two facts a host cares about:
 *
 *   - how many pages are held, so the host can ask before discarding them;
 *   - that the PDF now exists, which is where this library's job ends.
 *
 * Doing it here rather than in the build screen means completion cannot be
 * missed: a PDF that finished while the person was looking at something else
 * still leaves through the same door.
 */

import { useEffect, useRef } from "react";

import { useFlowNavigation } from "@/hooks/useFlowNavigation";
import { useScanRuntime } from "@/hooks/useScanRuntime";
import { useScanStore } from "@/hooks/useScanStore";
import { isDesktopSurface } from "@/lib/environment";
import { EscanearScreen } from "@/components/EscanearScreen";
import { ReviewScreen } from "@/components/ReviewScreen";
import { GerarScreen } from "@/components/GerarScreen";
import { DesktopFlow } from "@/components/desktop/DesktopFlow";

export interface FlowScreensProps {
  onComplete(file: File, pageCount: number): void;
  onPagesChange(count: number): void;
}

export function FlowScreens({ onComplete, onPagesChange }: FlowScreensProps) {
  const { step } = useFlowNavigation();
  const { session, build } = useScanStore();
  const runtime = useScanRuntime();

  /**
   * The surface is decided once, at mount, and never re-read.
   *
   * It answers "is there a camera worth pointing at paper", which does not
   * change while somebody is scanning — but a window that crosses a breakpoint
   * mid-flow would otherwise swap the whole interface out from under them and
   * lose the screen they were on.
   */
  const desktop = useRef<boolean | null>(null);
  if (desktop.current === null) {
    desktop.current = !runtime.intake.camera || isDesktopSurface();
  }

  const pageCount = session?.pages.length ?? 0;
  const lastReported = useRef<number | null>(null);
  useEffect(() => {
    if (lastReported.current === pageCount) return;
    lastReported.current = pageCount;
    onPagesChange(pageCount);
  }, [pageCount, onPagesChange]);

  /**
   * The PDF exists. Hand it over exactly once.
   *
   * The blob becomes a `File` here because that is the shape a host can put
   * straight into a `FormData`, an upload or a download, and because the name
   * is decided by the flow rather than by the caller.
   */
  const delivered = useRef(false);
  useEffect(() => {
    if (delivered.current) return;
    if (build.phase !== "done" || build.blob === null) return;
    delivered.current = true;
    // The store names every finished build (the host's name verbatim, or the
    // composed one); the fallbacks only keep the type honest.
    const name = build.fileName ?? runtime.fileName ?? "documento.pdf";
    const file = new File([build.blob], name, { type: "application/pdf" });
    onComplete(file, build.pageCount);
  }, [build.phase, build.blob, build.fileName, build.pageCount, runtime.fileName, onComplete]);

  if (desktop.current) {
    // The desktop flow runs its own three steps internally: it is one screen
    // with an interior, not three screens sharing a router.
    return <DesktopFlow />;
  }

  switch (step) {
    case "review":
      return <ReviewScreen />;
    case "build":
      return <GerarScreen />;
    case "capture":
    case "corners":
    default:
      // Corner confirmation is a stage inside capture, not a sibling of it:
      // the viewfinder stays mounted behind it so the camera is not torn down
      // and restarted between every page.
      return <EscanearScreen />;
  }
}
