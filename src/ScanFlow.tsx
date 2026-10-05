/**
 * The component. Everything a host mounts, and the only thing this package
 * renders.
 *
 * It composes four things and owns nothing else:
 *
 *   - the runtime configuration (where the assets are, which language, the
 *     limits), so no screen has to be handed a base URL by its parent;
 *   - the page store, created per instance and disposed on unmount;
 *   - navigation, which used to be a router and is now component state;
 *   - the bridge out: `onComplete` when the PDF exists, `onCancel` when the
 *     flow leaves through its own entrance, `onPagesChange` so the host can ask
 *     before discarding, and `onEvent` for everything else.
 *
 * Note what it does NOT render: no backdrop, no dialog, no focus trap, no
 * history entry, no result screen. Two hosts want those four things
 * differently, and one of them is a patient-facing page whose back button must
 * keep meaning what it meant before this component was mounted.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import clsx from "clsx";

import type {
  ScanCancelReason,
  ScanErrorCode,
  ScanEvent,
  ScanFlowProps,
  ScanPhotoImportReport,
  ScanStep,
} from "./types";
import { assetUrls, explainBadAssetBaseUrl } from "./lib/runtime-config";
import { ScanStoreProvider } from "./hooks/useScanStore";
import { FlowNavigationProvider } from "./hooks/useFlowNavigation";
import { ScanRuntimeProvider, type ScanRuntime } from "./hooks/useScanRuntime";
import { FlowScreens } from "./FlowScreens";
import { PhotoImportProvider } from "./hooks/usePhotoImport";
import { isDesktopSurface } from "./lib/environment";
import { LangProvider } from "./components/I18n";
import { createExitGate, type ExitGate } from "./lib/exit-gate";
import { SHELL_ROOT_STYLE } from "./lib/shell-theme";
import { autoCaptureOffered, pickCaptureLayout } from "./lib/capture-layout";
import { diagnosticsSinkFor, flowDiagnostic, type DiagnosticsSink } from "./lib/diagnostics-events";
import type { QualityEvent } from "./lib/scan-store";

const DEFAULT_MAX_PAGES = 20;

export function ScanFlow(props: ScanFlowProps) {
  const {
    assetBaseUrl,
    lang = "pt-BR",
    maxPages = DEFAULT_MAX_PAGES,
    maxBytes,
    defaultFileName: fileNameProp,
    intake,
    initialImages,
    onComplete,
    onCancel,
    onPagesChange,
    onEvent,
    onDiagnostics,
    onPhotoImport,
    className,
    // Left `undefined` when omitted: omitted and `false` mean different things
    // (`autoCaptureOffered`).
    experimentalAutoCapture,
    experimentalDiagnostics = false,
    captureLayout: captureLayoutProp,
    experimentalCaptureLayout,
  } = props;

  const captureLayout = pickCaptureLayout(captureLayoutProp, experimentalCaptureLayout);

  /**
   * The host's photos, copied once on mount (`initialImages` is read once:
   * a host re-rendering with a new array must not re-import, or reset, the
   * document somebody is already working on).
   */
  const [seed] = useState<readonly File[]>(() => Array.from(initialImages ?? []));

  /**
   * The surface is decided once, at mount, and never re-read.
   *
   * It answers "is there a camera worth pointing at paper", which does not
   * change while somebody is scanning — but a window that crosses a breakpoint
   * mid-flow would otherwise swap the whole interface out from under them and
   * lose the screen they were on. Decided here rather than in `FlowScreens`
   * because the phone's first step depends on it: a flow seeded with photos
   * opens on the review list, not the viewfinder.
   */
  const [desktop] = useState(() => intake?.camera === false || isDesktopSurface());

  /** The auto-capture choice, for this flow only: off in every new one. */
  const autoCaptureChosen = useRef(false);

  /**
   * The callbacks live in a ref so that a host which passes inline arrows —
   * which is every host — does not re-run effects on each of its own renders.
   * The ref is updated during render rather than in an effect: an event can be
   * emitted from a layout effect deeper in the tree, before ours would have run.
   */
  const handlers = useRef({ onComplete, onCancel, onPagesChange, onEvent, onDiagnostics, onPhotoImport });
  handlers.current = { onComplete, onCancel, onPagesChange, onEvent, onDiagnostics, onPhotoImport };

  /**
   * The diagnostics stream (`onDiagnostics`, experimental): a sink only while
   * the host passes a callback — without one every call site meets `null`
   * and builds nothing. Created once per instance and per presence of the
   * callback, never per render of the host.
   */
  const diagnosticsWanted = onDiagnostics !== undefined;
  const diagnosticsSink = useMemo<DiagnosticsSink | null>(
    () => diagnosticsSinkFor(diagnosticsWanted ? (event) => handlers.current.onDiagnostics?.(event) : undefined),
    [diagnosticsWanted]
  );
  const sinkRef = useRef(diagnosticsSink);
  sinkRef.current = diagnosticsSink;

  const emit = useCallback((event: ScanEvent) => {
    // The diagnostics copy is rebuilt from an allowlist *before* the host's
    // onEvent can touch the object: whatever a host adds to its event stays
    // its own.
    const sink = sinkRef.current;
    const flow = sink === null ? null : flowDiagnostic(event);
    handlers.current.onEvent?.(event);
    if (flow !== null) sink?.emit({ type: "flow", event: flow });
  }, []);

  /**
   * The store's per-page sizes (render, and each page embedded in the PDF)
   * onto the diagnostics stream. Stable, and a no-op without a sink.
   */
  const reportQuality = useCallback((event: QualityEvent) => {
    const sink = sinkRef.current;
    if (sink === null) return;
    if (event.kind === "render") {
      sink.emit({
        type: "render",
        page: event.page,
        warped: event.warped,
        final: event.final,
        flat: event.flat,
        dewarped: event.dewarped,
      });
      return;
    }
    sink.emit({
      type: "build",
      page: event.page,
      pages: event.pages,
      width: event.width,
      height: event.height,
      bytes: event.bytes,
      rung: event.rung,
      quality: event.quality,
      resampled: event.resampled,
    });
  }, []);

  /**
   * A misconfigured base URL produces a 404 deep inside a third-party runtime,
   * which is a miserable thing to debug. Say it plainly, once, to the console
   * the developer is already looking at. This never reaches a person scanning.
   */
  const configurationError = useMemo(
    () => explainBadAssetBaseUrl(assetBaseUrl),
    [assetBaseUrl]
  );
  useEffect(() => {
    if (configurationError !== null) {
      console.error(`[@azelotech/scan] ${configurationError}`);
    }
  }, [configurationError]);

  const urls = useMemo(() => assetUrls(assetBaseUrl), [assetBaseUrl]);

  /**
   * Whether an exit may reach the host. Completion and an unrecoverable error
   * end the flow; a user cancel is a request the host may refuse, so it never
   * latches — it only swallows the second tap of a double tap.
   */
  const gate = useRef<ExitGate | null>(null);
  if (gate.current === null) gate.current = createExitGate();
  const exitGate = gate.current;

  /** The live page count, readable by callbacks that must not depend on it. */
  const pageCountRef = useRef(0);

  /**
   * What became of the host's photos, once their run is over. Kept for
   * `onComplete` and reported to the host the first time only: a seed is read
   * once per flow, and so is its report.
   */
  const seedReport = useRef<ScanPhotoImportReport | null>(null);
  const reportPhotoImport = useCallback((report: ScanPhotoImportReport) => {
    if (seedReport.current !== null) return;
    const copy: ScanPhotoImportReport = {
      imported: [...report.imported],
      refused: [...report.refused],
      overflow: [...report.overflow],
    };
    seedReport.current = copy;
    // The host gets its own arrays: what it does to them is not our record.
    handlers.current.onPhotoImport?.({
      imported: [...copy.imported],
      refused: [...copy.refused],
      overflow: [...copy.overflow],
    });
  }, []);

  const complete = useCallback(
    (file: File, pageCount: number) => {
      if (!exitGate.complete()) return;
      const seeded = seedReport.current;
      handlers.current.onComplete({
        file,
        pageCount,
        bytes: file.size,
        ...(seeded === null
          ? {}
          : {
              initialImages: {
                imported: [...seeded.imported],
                refused: [...seeded.refused],
                overflow: [...seeded.overflow],
              },
            }),
      });
    },
    [exitGate]
  );

  const cancel = useCallback(
    (reason: ScanCancelReason, pages: number) => {
      if (!exitGate.requestCancel(reason)) return;
      emit({ name: "cancel", reason, pages });
      handlers.current.onCancel(reason);
    },
    [emit, exitGate]
  );

  const isFinished = useCallback(() => exitGate.finished, [exitGate]);

  const [pageCount, setPageCount] = useState(0);
  const handlePagesChange = useCallback(
    (count: number) => {
      setPageCount(count);
      handlers.current.onPagesChange?.(count);
    },
    []
  );

  /**
   * An error that ends the session, as opposed to one a screen can recover
   * from. `camera_denied`, `no_camera` and `camera_unavailable` are handled inside the capture screen
   * by falling back to the file intake, and only reach here when there is no
   * fallback to fall back to.
   */
  const reportError = useCallback(
    (code: ScanErrorCode, recoverable: boolean) => {
      emit({ name: "error", code, recoverable });
      if (!recoverable) cancel("error", pageCountRef.current);
    },
    [cancel, emit]
  );

  pageCountRef.current = pageCount;

  const runtime = useMemo<ScanRuntime>(
    () => ({
      urls,
      lang,
      maxPages,
      maxBytes: maxBytes ?? null,
      fileName: fileNameProp ?? null,
      intake: {
        camera: intake?.camera ?? true,
        images: intake?.images ?? true,
        pdf: intake?.pdf ?? false,
      },
      autoCapture: {
        offered: autoCaptureOffered(captureLayout, experimentalAutoCapture),
        chosen: autoCaptureChosen,
      },
      captureLayout,
      diagnostics: experimentalDiagnostics === true,
      diagnosticsSink,
      emit,
      reportError,
      reportPhotoImport,
    }),
    [urls, lang, maxPages, maxBytes, fileNameProp, intake?.camera, intake?.images, intake?.pdf, experimentalAutoCapture, experimentalDiagnostics, diagnosticsSink, captureLayout, emit, reportError, reportPhotoImport]
  );

  // The session's facts, once, and the page going out of view and back.
  useEffect(() => {
    if (diagnosticsSink === null) return;
    diagnosticsSink.emit({
      type: "session-start",
      layout: captureLayout,
      autoOffered: autoCaptureOffered(captureLayout, experimentalAutoCapture),
      lang,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      dpr: window.devicePixelRatio,
      safeArea: readSafeArea(),
      vibrate: typeof navigator.vibrate === "function",
    });
    const onVisibility = () =>
      diagnosticsSink.emit({ type: "visibility", state: document.visibilityState === "hidden" ? "hidden" : "visible" });
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
    // Once per sink: the session's opening facts, not a log of prop changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagnosticsSink]);

  const handleStep = useCallback((step: ScanStep) => emit({ name: "step", step }), [emit]);

  return (
    <div
      className={clsx("scan-root", className)}
      // The camera shell's palette (`bg-shell`, `text-shell-ink`, …) — see
      // SHELL_ROOT_STYLE. Nothing else sets these variables.
      style={SHELL_ROOT_STYLE as CSSProperties}
      data-scan-lang={lang}
      lang={lang}
    >
      <LangProvider lang={lang === "en-US" ? "en" : "pt"}>
        <ScanRuntimeProvider value={runtime}>
          <ScanStoreProvider
            onQuality={reportQuality}
            assets={urls}
            maxPages={maxPages}
            maxBytes={maxBytes ?? null}
            fileName={fileNameProp ?? null}
          >
            <FlowNavigationProvider
              onExit={(reason) => cancel(reason, pageCountRef.current)}
              onStep={handleStep}
              isFinished={isFinished}
              initialStep={!desktop && seed.length > 0 ? "review" : "capture"}
            >
              <PhotoImportProvider>
                <FlowScreens
                  desktop={desktop}
                  initialImages={seed}
                  onComplete={complete}
                  onPagesChange={handlePagesChange}
                />
              </PhotoImportProvider>
            </FlowNavigationProvider>
          </ScanStoreProvider>
        </ScanRuntimeProvider>
      </LangProvider>
    </div>
  );
}

/** The safe-area insets in CSS pixels, read once off a throwaway element. */
function readSafeArea(): { top: number; right: number; bottom: number; left: number } {
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;visibility:hidden;pointer-events:none;" +
    "padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)";
  document.body.appendChild(probe);
  const style = getComputedStyle(probe);
  const inset = {
    top: parseFloat(style.paddingTop) || 0,
    right: parseFloat(style.paddingRight) || 0,
    bottom: parseFloat(style.paddingBottom) || 0,
    left: parseFloat(style.paddingLeft) || 0,
  };
  probe.remove();
  return inset;
}
