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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";

import type {
  ScanCancelReason,
  ScanErrorCode,
  ScanEvent,
  ScanFlowProps,
  ScanStep,
} from "./types";
import { assetUrls, explainBadAssetBaseUrl } from "./lib/runtime-config";
import { ScanStoreProvider } from "./hooks/useScanStore";
import { FlowNavigationProvider } from "./hooks/useFlowNavigation";
import { ScanRuntimeProvider, type ScanRuntime } from "./hooks/useScanRuntime";
import { FlowScreens } from "./FlowScreens";
import { LangProvider } from "./components/I18n";
import { createExitGate, type ExitGate } from "./lib/exit-gate";

const DEFAULT_MAX_PAGES = 20;

export function ScanFlow(props: ScanFlowProps) {
  const {
    assetBaseUrl,
    lang = "pt-BR",
    maxPages = DEFAULT_MAX_PAGES,
    maxBytes,
    defaultFileName: fileNameProp,
    intake,
    onComplete,
    onCancel,
    onPagesChange,
    onEvent,
    className,
  } = props;

  /**
   * The callbacks live in a ref so that a host which passes inline arrows —
   * which is every host — does not re-run effects on each of its own renders.
   * The ref is updated during render rather than in an effect: an event can be
   * emitted from a layout effect deeper in the tree, before ours would have run.
   */
  const handlers = useRef({ onComplete, onCancel, onPagesChange, onEvent });
  handlers.current = { onComplete, onCancel, onPagesChange, onEvent };

  const emit = useCallback((event: ScanEvent) => {
    handlers.current.onEvent?.(event);
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

  const complete = useCallback(
    (file: File, pageCount: number) => {
      if (!exitGate.complete()) return;
      handlers.current.onComplete({ file, pageCount, bytes: file.size });
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
   * from. `camera_denied` and `no_camera` are handled inside the capture screen
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
      emit,
      reportError,
    }),
    [urls, lang, maxPages, maxBytes, fileNameProp, intake?.camera, intake?.images, intake?.pdf, emit]
  );

  const handleStep = useCallback((step: ScanStep) => emit({ name: "step", step }), [emit]);

  return (
    <div className={clsx("scan-root", className)} data-scan-lang={lang} lang={lang}>
      <LangProvider lang={lang === "en-US" ? "en" : "pt"}>
        <ScanRuntimeProvider value={runtime}>
          <ScanStoreProvider
            assets={urls}
            maxPages={maxPages}
            maxBytes={maxBytes ?? null}
            fileName={fileNameProp ?? null}
          >
            <FlowNavigationProvider
              onExit={(reason) => cancel(reason, pageCountRef.current)}
              onStep={handleStep}
              isFinished={isFinished}
            >
              <FlowScreens onComplete={complete} onPagesChange={handlePagesChange} />
            </FlowNavigationProvider>
          </ScanStoreProvider>
        </ScanRuntimeProvider>
      </LangProvider>
    </div>
  );
}
