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
import { useScanStore, useStore } from "@/hooks/useScanStore";
import { usePhotoImport } from "@/hooks/usePhotoImport";
import { EscanearScreen } from "@/components/EscanearScreen";
import { ReviewScreen } from "@/components/ReviewScreen";
import { GerarScreen } from "@/components/GerarScreen";
import { DesktopFlow } from "@/components/desktop/DesktopFlow";

export interface FlowScreensProps {
  /** Which of the two flows is on, decided once by `ScanFlow`. */
  desktop: boolean;
  /** The host's photos (`initialImages`), copied on mount. Possibly empty. */
  initialImages: readonly File[];
  onComplete(file: File, pageCount: number): void;
  onPagesChange(count: number): void;
}

export function FlowScreens({ desktop, initialImages, onComplete, onPagesChange }: FlowScreensProps) {
  const { step } = useFlowNavigation();
  const { session, build } = useScanStore();
  const store = useStore();
  const runtime = useScanRuntime();
  const { importFiles } = usePhotoImport();

  /**
   * The phone's seed: the host's photos go into the document once, into the
   * store that is actually committed. Keyed by the store's id rather than a
   * boolean because StrictMode rehearses the mount with a store it then
   * disposes — seeding that one would spend the photos on a dead document.
   * (The desktop flow seeds its own pile the same way.)
   */
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (desktop || initialImages.length === 0) return;
    if (store.disposed || seededFor.current === store.id) return;
    seededFor.current = store.id;
    importFiles(initialImages, "initial");
  }, [desktop, importFiles, initialImages, store]);

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

  if (desktop) {
    // The desktop flow runs its own three steps internally: it is one screen
    // with an interior, not three screens sharing a router.
    return <DesktopFlow initialFiles={initialImages} />;
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
