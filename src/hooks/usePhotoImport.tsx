"use client";

/**
 * The phone's "several photos at once" intake, shared by every door that can
 * hand over more than one photo: `initialImages` on mount, and a multi-pick from
 * "Já tenho a foto" or from the permission primer.
 *
 * It lives above the screens because the run outlives the screen that started
 * it: a pick made on the viewfinder lands on the review list, and the list is
 * where the "processing N photos" line has to keep counting. Runs are queued,
 * never concurrent — the library's memory budget is one full-resolution decode
 * at a time — and each one is tied to the store it started on, so a store that
 * is disposed (the flow unmounted, or StrictMode's rehearsal) abandons its run
 * instead of feeding a dead document.
 */

import * as React from "react";
import { importPhotos, plannedIntake, type PhotoImportReport } from "@/lib/photo-import";
import type { PageErrorCode } from "@/lib/scan-store";
import { useStore } from "@/hooks/useScanStore";
import { useScanRuntime } from "@/hooks/useScanRuntime";

/** Where the photos came from, which decides what "none of them opened" means. */
export type PhotoImportOrigin = "initial" | "pick";

export interface PhotoImportState {
  /** True from the moment photos are handed over until the last one settles. */
  working: boolean;
  /** Photos in the current (or last) run. */
  total: number;
  /** Of those, how many have been read — whatever became of them. */
  settled: number;
  /** How many the document had no room for, known before the run starts. */
  overflow: number;
  /** How many fit, for the "only the first N" line. */
  fits: number;
  /** The last finished run's refusals, in order. Empty while working. */
  refused: readonly PageErrorCode[];
  /** The last finished run brought in no page at all. */
  nothingAdded: boolean;
}

export interface PhotoImport {
  state: PhotoImportState;
  /** Queue the photos. The caller moves the flow to the review step. */
  importFiles: (files: readonly File[], origin: PhotoImportOrigin) => void;
  /** Forget the last run's report (the person moved on). */
  dismiss: () => void;
}

const IDLE: PhotoImportState = {
  working: false,
  total: 0,
  settled: 0,
  overflow: 0,
  fits: 0,
  refused: [],
  nothingAdded: false,
};

const PhotoImportContext = React.createContext<PhotoImport | null>(null);

export function PhotoImportProvider({ children }: { children: React.ReactNode }) {
  const store = useStore();
  const runtime = useScanRuntime();
  const [state, setState] = React.useState<PhotoImportState>(IDLE);
  const queueRef = React.useRef<Promise<void>>(Promise.resolve());
  /** Bumped by every new run: a stale run never writes to the screen. */
  const runRef = React.useRef(0);

  const importFiles = React.useCallback(
    (files: readonly File[], origin: PhotoImportOrigin) => {
      const list = Array.from(files);
      if (list.length === 0 || store.disposed) return;
      const run = (runRef.current += 1);
      const pagesNow = store.getSnapshot().session?.pages.length ?? 0;
      const plan = plannedIntake(list.length, pagesNow, runtime.maxPages);
      setState({
        working: true,
        total: list.length,
        settled: 0,
        overflow: plan.overflow,
        fits: plan.fits,
        refused: [],
        nothingAdded: false,
      });

      const current = () => runRef.current === run;
      queueRef.current = queueRef.current
        .then(async () => {
          if (store.getSnapshot().session === null) store.start();
          const report: PhotoImportReport = await importPhotos(
            list,
            {
              pageCount: () => store.getSnapshot().session?.pages.length ?? 0,
              maxPages: runtime.maxPages,
              add: (capture) => {
                const before = store.getSnapshot().session?.pages.length ?? 0;
                store.addCapture({
                  canonical: capture.canonical,
                  corners: capture.corners,
                  gate: capture.gate,
                  path: capture.path,
                });
                const pages = store.getSnapshot().session?.pages ?? [];
                // The store refuses past its cap silently, so the page has to
                // be proven to exist before it is claimed.
                if (pages.length <= before) return null;
                return pages[pages.length - 1]?.id ?? null;
              },
            },
            {
              assets: runtime.urls,
              cancelled: () => store.disposed,
              onProgress: ({ settled }) => {
                if (current()) setState((prev) => ({ ...prev, settled }));
              },
              onPage: (page) => runtime.emit({ name: "capture", page, source: "file" }),
            },
          );
          if (store.disposed) return;
          const nothingAdded = report.added === 0 && report.total > 0;
          if (current()) {
            setState((prev) => ({
              ...prev,
              working: false,
              settled: report.total,
              refused: report.refused,
              nothingAdded,
            }));
          }
          // The host's photos could not become a single page. On the phone the
          // camera is still right there, so the session stays open and the
          // review step offers it; the host is told, not asked to close.
          if (origin === "initial" && nothingAdded && report.refused.length > 0) {
            runtime.reportError("images_unreadable", runtime.intake.camera);
          }
        })
        // The queue outlives any one run: a runner that threw must not take
        // the runs behind it down with it.
        .catch(() => {
          if (current() && !store.disposed) setState((prev) => ({ ...prev, working: false }));
        });
    },
    [runtime, store],
  );

  const dismiss = React.useCallback(() => {
    setState((prev) => (prev.working ? prev : IDLE));
  }, []);

  const value = React.useMemo<PhotoImport>(
    () => ({ state, importFiles, dismiss }),
    [state, importFiles, dismiss],
  );

  return <PhotoImportContext.Provider value={value}>{children}</PhotoImportContext.Provider>;
}

export function usePhotoImport(): PhotoImport {
  const value = React.useContext(PhotoImportContext);
  if (value === null) {
    throw new Error("usePhotoImport was called outside <ScanFlow>.");
  }
  return value;
}
