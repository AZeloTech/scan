"use client";

import * as React from "react";
import { useScanStore, useStore } from "@/hooks/useScanStore";
import { useFlowNavigation } from "@/hooks/useFlowNavigation";
import { useScanRuntime } from "@/hooks/useScanRuntime";
import { popIn } from "@/lib/motion";
import type { PageTile } from "@/lib/page-tiles";
import type { Capture } from "@/lib/capture-intake";
import { AppFrame, FrameStep } from "@/components/AppFrame";
import { CameraPill } from "@/components/CameraActionBar";
import { CaptureStage } from "@/components/CaptureStage";
import { ConfirmCornersScreen } from "@/components/ConfirmCornersScreen";
import { CornerAdjustSheet } from "@/components/CornerAdjustSheet";
import { PagePreview } from "@/components/PagePreview";
import { PageThumb } from "@/components/PageThumb";
import { StageDot } from "@/components/PageStatus";
import {
  cameraAccessState,
  PermissionPrimer,
  type CameraAccess,
} from "@/components/PermissionPrimer";
import { RetakeSheet } from "@/components/RetakeSheet";
import { useCopy } from "@/components/I18n";
import { LiveRegion, Meta, useCancelOnEscape } from "@/components/ui";

/**
 * Step 1, laid out as a camera app: the frame takes every pixel that is left,
 * the rail shows what you've shot, and one control row carries the gallery, the
 * shutter and the way onward. Nothing scrolls — a viewfinder that scrolls away
 * is not a viewfinder. The whole screen sits on `night`, because the document
 * should be the brightest thing on it.
 *
 * A capture goes straight into the local store: flattened, measured, normalised
 * and thumbnailed on this device, and the chip on the rail is the on-device
 * gate's own verdict. No upload, no polling, no waiting on anything but the
 * phone in the user's hand.
 *
 * Before any of that, the **permission primer** gets one beat — unless the
 * answer is already known (see `cameraAccessState`). That gate lasts as long as
 * the flow does: stepping out to the review list and back to shoot page four
 * must not re-explain a dialog nobody is going to see again.
 */

/**
 * What the user chose on the primer, remembered for the life of one mounted
 * flow — and no longer.
 *
 * This screen unmounts every time the flow steps to the review list, so the
 * answer cannot live in its own state. It is keyed by the store's instance id
 * rather than kept as a bare module variable, which is what keeps it honest as
 * a library: a second `<ScanFlow>` gets a new store and therefore a clean
 * answer, exactly like the pages themselves.
 */
let primerChoice: { readonly owner: string; readonly choice: "camera" | "gallery" } | null =
  null;

function rememberedChoice(owner: string): "camera" | "gallery" | null {
  return primerChoice !== null && primerChoice.owner === owner ? primerChoice.choice : null;
}

export function EscanearScreen() {
  const copy = useCopy();
  const store = useStore();
  const runtime = useScanRuntime();
  const { go, requestCancel } = useFlowNavigation();
  const { session, tiles } = useScanStore();
  const [retakeKey, setRetakeKey] = React.useState<string | null>(null);
  const [previewKey, setPreviewKey] = React.useState<string | null>(null);
  const [adjustKey, setAdjustKey] = React.useState<string | null>(null);
  const [access, setAccess] = React.useState<CameraAccess | null>(null);
  /**
   * The capture waiting to be confirmed. Every photo now passes through
   * `ConfirmCornersScreen` before it becomes a page — see that file for why
   * this reverses the earlier rule that the default path never asks.
   */
  const [pending, setPending] = React.useState<Capture | null>(null);
  const [choice, setChoice] = React.useState(() => rememberedChoice(store.id));
  const railRef = React.useRef<HTMLDivElement | null>(null);

  // Escape asks the host to close. The confirm screen, the page editor and the
  // two sheets take it first and stop there — they call `preventDefault`, which
  // is what the hook stands down for.
  useCancelOnEscape();

  /**
   * No scan yet. In a library this is simply the first frame of the flow, so
   * the session is opened here rather than escaped from.
   */
  React.useEffect(() => {
    if (session === null) store.start();
  }, [session, store]);

  React.useEffect(() => {
    let cancelled = false;
    void cameraAccessState().then((state) => {
      if (!cancelled) setAccess(state);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const pageCount = tiles.length;
  // The cap is the host's, not ours: a host that accepts six pages should
  // not offer a seventh shutter.
  const maxPages = runtime.maxPages;
  const atCapacity = pageCount >= maxPages;

  /**
   * Back out of the flow: to the list when there is something to look at, and
   * to the host when there is not. `requestCancel` is a request — the host owns
   * the "discard these pages?" dialog and may well ignore it.
   */
  const leave = React.useCallback(() => {
    if (pageCount > 0) go("review");
    else requestCancel("user");
  }, [go, pageCount, requestCancel]);

  /** A photo was taken. It is not a page yet — the user has to confirm it. */
  const handleCapture = React.useCallback((capture: Capture) => {
    setPending(capture);
  }, []);

  /** Corners confirmed: now it becomes a page. */
  const commitCapture = React.useCallback(
    (capture: Capture) => {
      store.addCapture({
        canonical: capture.canonical,
        corners: capture.corners,
        gate: capture.gate,
        path: capture.path,
      });
      setPending(null);
    },
    [store],
  );

  /**
   * A gallery pick from the primer both adds the page AND ends the primer —
   * as the *gallery* answer, so the surface that mounts behind it does not
   * immediately ask for the camera the user just declined to grant.
   */
  const handlePrimerCapture = React.useCallback(
    (capture: Capture) => {
      // Straight to confirmation, exactly like a shutter capture — a gallery
      // pick is if anything MORE likely to need its corners moved.
      setPending(capture);
      primerChoice = { owner: store.id, choice: "gallery" };
      setChoice("gallery");
    },
    [store],
  );

  // Keep the newest page in view, and let it land with a pop — the one moment
  // in the flow where the user's action produces a visible new object.
  React.useEffect(() => {
    const rail = railRef.current;
    if (rail === null || pageCount === 0) return;
    rail.scrollTo({ left: rail.scrollWidth, behavior: "smooth" });
    popIn(rail.lastElementChild);
  }, [pageCount]);

  const retakeTile = tiles.find((tile) => tile.key === retakeKey) ?? null;
  const previewTile = tiles.find((tile) => tile.key === previewKey) ?? null;
  const adjustTile = tiles.find((tile) => tile.key === adjustKey) ?? null;

  const handleTileTap = React.useCallback(
    (tile: PageTile) => {
      // A page that could not be prepared: the tap is the retry, not a preview.
      if (tile.stage === "retry") {
        store.retryPage(tile.pageId);
        return;
      }
      setPreviewKey(tile.key);
    },
    [store],
  );

  if (retakeTile !== null) {
    return <RetakeSheet tile={retakeTile} onClose={() => setRetakeKey(null)} />;
  }

  if (adjustTile !== null) {
    return (
      <CornerAdjustSheet
        tile={adjustTile}
        pageCount={pageCount}
        onClose={() => setAdjustKey(null)}
      />
    );
  }

  // The primer only works if it gets there FIRST. `CaptureStage` calls
  // `getUserMedia` the moment it mounts, so rendering it while the permission
  // state is still being read would let the OS dialog beat the screen that
  // exists to explain it — the exact failure the primer was added to prevent.
  if (access === null) {
    return (
      <AppFrame tone="night" step={1}>
        <div className="flex flex-1 items-center justify-center px-4">
          <Meta onNight>{copy.capture.preparingCamera}</Meta>
        </div>
      </AppFrame>
    );
  }

  // `impossible` skips the primer because there is no camera dialog to prime
  // for (an insecure origin); the surface's own gallery fallback is already
  // the right screen. `granted` skips it because the dialog will not appear.
  //
  // A host that switched the camera off never meets the primer either: there is
  // no permission to explain, and the file intake is the whole screen.
  const needsPrimer =
    runtime.intake.camera &&
    (access === "prompt" || access === "denied") &&
    choice === null;
  if (needsPrimer) {
    return (
      <PermissionPrimer
        access={access}
        onAllow={() => {
          primerChoice = { owner: store.id, choice: "camera" };
          setChoice("camera");
        }}
        onCapture={handlePrimerCapture}
        onBack={leave}
      />
    );
  }

  const warnedCount = tiles.filter((tile) => tile.stage === "warned").length;
  const lastTile = tiles[tiles.length - 1];
  const announcement =
    lastTile === undefined
      ? ""
      : copy.capture.announce(
          lastTile.humanNumber,
          lastTile.chipLabel,
          pageCount,
        );

  return (
    <>
      <AppFrame
        fill
        tone="night"
        step={1}
        // The viewfinder had no way back at all: the only exits were the
        // browser's own gesture and finishing the document. The pill goes
        // where the primer's does, and lands where the user came from.
        onBack={leave}
        aside={<FrameStep onNight>{copy.capture.sheetCount(pageCount)}</FrameStep>}
      >
        <div className="flex min-h-0 flex-1 flex-col px-4 pb-[max(env(safe-area-inset-bottom),14px)] pt-3">
          <LiveRegion message={announcement} />
          <CaptureStage
            onCapture={handleCapture}
            captureLabel={copy.capture.take(pageCount + 1)}
            pageNumber={pageCount + 1}
            // A sheet over the viewfinder is a covered camera: detecting on
            // it burns battery on a frame nobody is aiming, and the quad it
            // leaves behind would be stale by the time the sheet closes.
            paused={previewTile !== null || pending !== null}
            // The one case we must not open the camera: they chose the gallery.
            useCamera={runtime.intake.camera && choice !== "gallery"}
            disabled={atCapacity}
            disabledReason={copy.capture.atCapacity(maxPages)}
            rightAction={
              <CameraPill
                // Not filled while a sheet is flagged: carrying on is allowed
                // — a quality warning never blocks — but it is not what we are
                // recommending, and a filled pill would recommend it.
                tone={warnedCount > 0 ? "warning" : "primary"}
                overline={copy.capture.nextOverline}
                label={copy.capture.nextLabel}
                ariaLabel={copy.capture.nextAria(pageCount)}
                disabled={pageCount === 0}
                onClick={() => go("review")}
              />
            }
          >
            {/* The flagged-sheet line and the rail are ONE block of chrome, and
                the line holds its 16px whether it has anything to say or not.
                It used to appear with the first flagged sheet and vanish again
                when the retake cleared it, and each time it resized the
                viewfinder the user was aiming through — the one thing this
                screen may never do (`CaptureStage`'s frame invariant). Its
                height is pinned rather than reserved by a placeholder string:
                a fixed line-box cannot be wrapped into a second line by a
                longer count or a longer language, and `truncate` is the belt
                to that brace. */}
            <div className="flex shrink-0 flex-col gap-1">
              <p className="h-4 truncate font-mono text-2xs leading-4 text-peach">
                {warnedCount > 0 ? copy.capture.needAttention(warnedCount) : ""}
              </p>

              <div
                ref={railRef}
                aria-label={copy.capture.railLabel}
                className="no-scrollbar flex shrink-0 gap-2 overflow-x-auto"
              >
                {tiles.length === 0 ? (
                  <p className="flex h-[72px] items-center font-mono text-2xs text-cream/55">
                    {copy.capture.railEmpty}
                  </p>
                ) : (
                  tiles.map((tile) => (
                    <button
                      key={tile.key}
                      type="button"
                      onClick={() => handleTileTap(tile)}
                      aria-label={copy.capture.tileLabel(
                        tile.humanNumber,
                        tile.chipLabel,
                      )}
                      className="relative h-[72px] w-[54px] shrink-0 rounded-md"
                    >
                      <PageThumb
                        tile={tile}
                        onNight
                        radius="md"
                        className="h-full w-full"
                      />
                      <span className="absolute inset-x-0 bottom-1 flex justify-center">
                        <StageDot stage={tile.stage} onNight />
                      </span>
                    </button>
                  ))
                )}
              </div>
            </div>
          </CaptureStage>
        </div>
      </AppFrame>

      {pending !== null && (
        <ConfirmCornersScreen
          capture={pending}
          pageNumber={pageCount + 1}
          onConfirm={commitCapture}
          onRetake={() => setPending(null)}
        />
      )}

      {/* `tiles` as well as the tapped one: the editor keeps its own cursor
          through the document, so the page it hands back to these callbacks is
          not necessarily the page that was tapped on the rail. */}
      {previewTile !== null && (
        <PagePreview
          tile={previewTile}
          tiles={tiles}
          onRetake={(tile) => {
            setPreviewKey(null);
            setRetakeKey(tile.key);
          }}
          // The cursor is moved onto the page the editor was on and the
          // editor is deliberately NOT closed: the corner screen returns the
          // way it came (design scenario 06), so clearing `previewKey` here
          // would drop the user back on the rail the moment they tapped
          // "Voltar". The early return above unmounts the editor for the
          // duration either way.
          onAdjustCorners={(tile) => {
            setPreviewKey(tile.key);
            setAdjustKey(tile.key);
          }}
          onClose={() => setPreviewKey(null)}
        />
      )}
    </>
  );
}
